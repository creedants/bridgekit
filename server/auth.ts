import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink, organization } from "better-auth/plugins";
import type { RateLimit } from "./cloudflare.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { deleteSoleWorkspaces, freeSeats, MAX_WORKSPACES_PER_USER, SEAT_LIMIT_SENTENCE, WORKSPACE_LIMIT_SENTENCE, workspaceCount } from "./workspace.ts";

const AUTH_BASE_PATH = "/api/auth";

/** The invitation email's subject, fixed so it never carries a name of its own. */
const INVITATION_SUBJECT = "You have been invited to a PVM Bridge workspace";

/** How much of a name an invitation email carries, in code points. */
const INVITATION_NAME_LIMIT = 80;

/**
 * Cuts a name to the length an invitation email carries, on code points so a
 * cut never splits a surrogate pair, and marks a cut with "...".
 */
function cutName(name: string): string {
  const points = Array.from(name);
  return points.length > INVITATION_NAME_LIMIT ? `${points.slice(0, INVITATION_NAME_LIMIT).join("")}...` : name;
}

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
    appName: "PVM Bridge",
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
    // A database error is not an APIError, so better-call would answer it with
    // an empty 500 and the sentence a refused invitation carries would go no
    // further than the log. Throwing it instead lets the Worker translate it
    // into that sentence. Everything Better Auth refuses itself is an APIError
    // and is still answered by Better Auth, exactly as before.
    onAPIError: { throw: true },
    account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },
    user: { deleteUser: { enabled: true, beforeDelete: (user) => deleteSoleWorkspaces(env.DB, user.id) } },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: ({ email, url }) =>
          sendEmail(env, email, "Your PVM Bridge sign-in link", `Sign in to PVM Bridge:\n\n${url}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`),
      }),
      organization({
        // A workspace holds as many members as it has paid seats; one (the owner) before it subscribes.
        membershipLimit: (_user, workspace) => seatsFor(workspace.id),
        invitationExpiresIn: 7 * 24 * 60 * 60,
        // Both hooks run before the row is written, so a refusal leaves neither
        // a row nor an email behind. server/worker.ts asks the same two
        // questions before Better Auth runs, so an ordinary request is refused
        // before the plugin sees it; these hooks are the guard for every other
        // caller, and the triggers in migrations/0004_workspace_limits.sql hold
        // the invitation limit against two invitations written at the same
        // moment.
        organizationHooks: {
          beforeCreateOrganization: async ({ user }) => {
            if ((await workspaceCount(env.DB, user.id)) >= MAX_WORKSPACES_PER_USER) {
              throw new APIError("FORBIDDEN", { message: WORKSPACE_LIMIT_SENTENCE });
            }
          },
          beforeCreateInvitation: async ({ organization: workspace }) => {
            if ((await freeSeats(env.DB, workspace.id)) <= 0) {
              throw new APIError("FORBIDDEN", { message: SEAT_LIMIT_SENTENCE });
            }
          },
        },
        // The route sends this once the invitation row exists, so the only
        // thing left to check is that the row is still there. A seat check
        // here runs after a write has happened, and a refusal from it is
        // swallowed by the background helper that runs this callback, which
        // then answers 200 with an invitation nobody can act on.
        sendInvitationEmail: async ({ email, organization: workspace, inviter, id }) => {
          const row = await env.DB.prepare(`SELECT id FROM invitation WHERE id = ?`).bind(id).first();
          if (!row) throw new APIError("FORBIDDEN", { message: SEAT_LIMIT_SENTENCE });
          return sendEmail(
            env,
            email,
            INVITATION_SUBJECT,
            `You have been invited to the workspace "${cutName(workspace.name)}" by ${cutName(inviter.user.name || inviter.user.email)}.\n\nTo accept, sign in with this email address and open:\n${env.BETTER_AUTH_URL}/app/?invitation=${id}\n\nThe invitation expires in 7 days.`,
          );
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export async function limitMagicLinkSignIn(request: Request, rateLimit: RateLimit | undefined): Promise<Response | null> {
  // Better Auth mounts its endpoints under the pathname of its base URL, and
  // that URL carries AUTH_BASE_PATH only when BETTER_AUTH_URL has no path of
  // its own: better-auth's withPath returns a URL that already has a path
  // unchanged, and its router takes the mount point from
  // new URL(baseURL).pathname. The endpoint's own route, signInMagicLink.path,
  // does not move with it, so the route is matched as the end of the request
  // path. A path Better Auth would answer 404 is counted too, the same cost
  // server/worker.ts pays for its two email routes.
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith(signInMagicLink.path)) return null;
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
