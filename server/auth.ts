import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink, organization } from "better-auth/plugins";
import type { RateLimit } from "./cloudflare.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { deleteSoleWorkspaces, freeSeats, MAX_WORKSPACES_PER_USER, workspaceCount } from "./workspace.ts";

const AUTH_BASE_PATH = "/api/auth";

const signInMagicLink = magicLink({
  sendMagicLink() {
    throw new Error("schema lookup");
  },
}).endpoints.signInMagicLink;

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
        // The plugin's own hooks run before the row is written and before the
        // invitation email, so a refusal leaves neither behind.
        organizationHooks: {
          beforeCreateOrganization: async ({ user }) => {
            if ((await workspaceCount(env.DB, user.id)) >= MAX_WORKSPACES_PER_USER) {
              throw new APIError("FORBIDDEN", {
                message: `You can have up to ${MAX_WORKSPACES_PER_USER} workspaces, so delete one before creating another.`,
              });
            }
          },
          beforeCreateInvitation: async ({ organization: workspace }) => {
            if ((await freeSeats(env.DB, workspace.id)) <= 0) {
              throw new APIError("FORBIDDEN", { message: "This workspace has no free seat, so cancel a pending invitation or add seats." });
            }
          },
        },
        sendInvitationEmail: ({ email, organization: workspace, inviter, id }) =>
          sendEmail(
            env,
            email,
            `${inviter.user.name || inviter.user.email} invited you to a Bridgekit workspace`,
            `You have been invited to the workspace "${workspace.name}".\n\nTo accept, sign in with this email address and open:\n${env.BETTER_AUTH_URL}/app/?invitation=${id}\n\nThe invitation expires in 7 days.`,
          ),
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
