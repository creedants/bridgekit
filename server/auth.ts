import { betterAuth, type BetterAuthOptions } from "better-auth";
import { magicLink, organization } from "better-auth/plugins";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { deleteSoleWorkspaces } from "./workspace.ts";

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
    basePath: "/api/auth",
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
    // The IP is still read, in memory only, to slow repeated sign-in attempts.
    databaseHooks: {
      session: { create: { before: async (session) => ({ data: { ...session, ipAddress: "", userAgent: "" } }) } },
    },
    rateLimit: { enabled: true, customRules: { "/sign-in/magic-link": { window: 60, max: 3 } } },
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

export function createAuth(env: Env, seatsFor: (workspaceId: string) => Promise<number>) {
  return betterAuth({ ...authOptions(env, seatsFor), database: env.DB as never });
}

export type Auth = ReturnType<typeof createAuth>;
