import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink, organization } from "better-auth/plugins";
import type { RateLimit } from "./cloudflare.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { deleteSoleWorkspaces, freeSeats, MAX_WORKSPACES_PER_USER, workspaceCount } from "./workspace.ts";

const AUTH_BASE_PATH = "/api/auth";
const INVITE_MEMBER = "/organization/invite-member";

const signInMagicLink = magicLink({
  sendMagicLink() {
    throw new Error("schema lookup");
  },
}).endpoints.signInMagicLink;

// The plugin's own resend branch reuses a live invitation: it updates the row's
// expiry and sends the email without calling beforeCreateInvitation. This runs
// before the route, so a refusal leaves the row and its expiry exactly as they
// were.
const limitInvitations = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== INVITE_MEMBER) return;
  const body = ctx.body as { resend?: unknown; organizationId?: unknown; email?: unknown } | undefined;
  if (!body?.resend || typeof body.organizationId !== "string" || typeof body.email !== "string") return;
  const database = ctx.context.options.database as unknown as Parameters<typeof freeSeats>[0];
  // A re-sent invitation already holds its seat, so it does not take another.
  const row = await database
    .prepare(`SELECT id FROM invitation WHERE organizationId = ? AND email = ? AND status = 'pending' AND datetime(expiresAt) > datetime('now')`)
    .bind(body.organizationId, body.email.toLowerCase())
    .first<{ id: string }>();
  if (!row) return;
  if ((await freeSeats(database, body.organizationId, new Date(), row.id)) > 0) return;
  throw new APIError("FORBIDDEN", { message: "This workspace has no free seat, so cancel a pending invitation or add seats." });
});

function tooManyRequests(): Response {
  return Response.json({ message: "Too many requests. Please try again later." }, { status: 429 });
}

/**
 * Accounts and team workspaces (Better Auth). A workspace is Better Auth's
 * "organization": members, roles and invitations come from its plugin.
 * Sign-in is by emailed link, plus Microsoft and Google when their keys are set.
 * The only cookie is the session cookie, set when someone signs in.
 */
export function authOptions(env: Env, seatsFor: (workspaceId: string) => Promise<number>) {
  return {
    appName: "Bridgekit",
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    // Better Auth can report anonymous usage to its authors; keep it off.
    telemetry: { enabled: false },
    socialProviders: {
      ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
        ? { microsoft: { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenantId: "common" } }
        : {}),
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
    },
    // Sessions would otherwise keep each visitor's IP address and browser.
    databaseHooks: {
      session: { create: { before: async (session) => ({ data: { ...session, ipAddress: "", userAgent: "" } }) } },
    },
    rateLimit: {
      enabled: true,
      customRules: {
        [signInMagicLink.path]: () => false,
      },
    },
    hooks: {
      // Scope the seat check to the invitation route, where the plugin's hooks
      // do not reach every path that sends email.
      before: limitInvitations,
    },
    account: { accountLinking: { enabled: true, trustedProviders: ["microsoft", "google"] } },
    user: { deleteUser: { enabled: true, beforeDelete: (user) => deleteSoleWorkspaces(env.DB, user.id) } },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: ({ email, url }) =>
          sendEmail(env, email, "Your Bridgekit sign-in link", `Sign in to Bridgekit:\n\n${url}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`),
      }),
      organization({
        // A workspace holds as many members as it has paid seats; one (the owner) before it subscribes.
        membershipLimit: (_user, workspace) => seatsFor(workspace.id),
        invitationExpiresIn: 7 * 24 * 60 * 60,
        // The hooks below run before the row is written and before the
        // invitation email, so a refusal leaves neither behind. The triggers in
        // migrations/0004 hold the same limits against two writes that arrive
        // at the same moment, and afterCreateOrganization and
        // sendInvitationEmail turn their undo into the same sentences.
        organizationHooks: {
          beforeCreateOrganization: async ({ user }) => {
            if ((await workspaceCount(env.DB, user.id)) >= MAX_WORKSPACES_PER_USER) {
              throw new APIError("FORBIDDEN", {
                message: `You can own up to ${MAX_WORKSPACES_PER_USER} workspaces, so delete one before creating another.`,
              });
            }
          },
          // Two creates at the same moment both pass the check above and both
          // write. The trigger in migrations/0004 undoes the second one, so the
          // workspace it wrote a row for is gone by the time this hook runs and
          // the request answers with the ordinary refusal.
          afterCreateOrganization: async ({ organization }) => {
            if (!(await env.DB.prepare(`SELECT id FROM organization WHERE id = ?`).bind(organization.id).first())) {
              throw new APIError("FORBIDDEN", {
                message: `You can own up to ${MAX_WORKSPACES_PER_USER} workspaces, so delete one before creating another.`,
              });
            }
          },
          beforeCreateInvitation: async ({ organization: workspace }) => {
            if ((await freeSeats(env.DB, workspace.id)) <= 0) {
              throw new APIError("FORBIDDEN", { message: "This workspace has no free seat, so cancel a pending invitation or add seats." });
            }
          },
        },
        sendInvitationEmail: async ({ email, organization: workspace, inviter, id }) => {
          // The resend path sends without asking beforeCreateInvitation, and two
          // invitations at the same moment both pass it. The triggers in
          // migrations/0004 undo those writes, so the seat the invitation was
          // given is either held by someone else or already gone, and sending
          // now would mail an address with nowhere to land.
          if ((await freeSeats(env.DB, workspace.id, new Date(), id)) <= 0) {
            throw new APIError("FORBIDDEN", { message: "This workspace has no free seat, so cancel a pending invitation or add seats." });
          }
          return sendEmail(
            env,
            email,
            `${inviter.user.name || inviter.user.email} invited you to a Bridgekit workspace`,
            `You have been invited to the workspace "${workspace.name}".\n\nTo accept, sign in with this email address and open:\n${env.BETTER_AUTH_URL}/app/?invitation=${id}\n\nThe invitation expires in 7 days.`,
          );
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export async function limitMagicLinkSignIn(request: Request, rateLimit: RateLimit | undefined): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== AUTH_BASE_PATH + signInMagicLink.path) return null;
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return Response.json({ message: "Content-Type must be application/json." }, { status: 415 });
  let parsed: unknown;
  try {
    parsed = await request.clone().json();
  } catch {
    return null;
  }
  const result = await signInMagicLink.options.body["~standard"].validate(parsed);
  if (result.issues) return null;
  if (rateLimit === undefined) return null;
  const key = request.headers.get("cf-connecting-ip");
  if (key === null || key.trim() === "") return tooManyRequests();
  try {
    const { success } = await rateLimit.limit({ key });
    if (!success) return tooManyRequests();
  } catch {
    return tooManyRequests();
  }
  return null;
}

export function createAuth(env: Env, seatsFor: (workspaceId: string) => Promise<number>) {
  return betterAuth({ ...authOptions(env, seatsFor), database: env.DB as never });
}

export type Auth = ReturnType<typeof createAuth>;
