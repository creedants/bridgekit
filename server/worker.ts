import { Hono, type Context, type ExecutionContext as HonoExecutionContext } from "hono";
import { getPath } from "hono/utils/url";
import { serveCompressedWasm } from "./assets.ts";
import { createAuth, limitMagicLinkSignIn, type Auth } from "./auth.ts";
import type { ExecutionContext, Fetcher } from "./cloudflare.ts";
import { handleCommentary } from "./commentary.ts";
import { countPageView, pageView } from "./counts.ts";
import { canSendEmail, EMAIL_NOT_SET_UP } from "./email.ts";
import type { Env } from "./env.ts";
import { createCheckout, parseSubscriptionEvent, verifyPaddleSignature, type PaddleEnvironment } from "./paddle.ts";
import {
  applySubscription,
  deleteSaved,
  listBridges,
  listSetups,
  membership,
  plan,
  saveBridge,
  saveSetup,
  userHasPro,
  WorkspaceError,
} from "./workspace.ts";

/**
 * The Cloudflare Worker. The site itself is static (dist/); this adds the
 * opt-in server features on the same address, so the browser's security
 * policy can stay limited to the site's own origin:
 *
 *   /api/auth/*        sign-in and workspaces (Better Auth)
 *   /api/workspaces/*  saved setups and bridge totals
 *   /api/commentary    AI commentary, for Pro members
 *   /api/paddle/*      subscriptions
 *   pages              served as they are, with a count per page per day
 */

type App = { Bindings: Env; Variables: { auth: Auth } };

function accountsEnabled(value: string | undefined): boolean {
  return value === "on";
}

function gatedApiPath(pathname: string): boolean {
  const recognized = pathname.replace(/%2F/gi, "/");
  const segments = recognized.split("/");
  if (segments[1]?.toLowerCase() !== "api") return false;
  const feature = segments[2]?.toLowerCase();
  return feature === "auth" || feature === "workspaces" || feature === "paddle" || feature === "commentary";
}

const CLOSED_CONFIG = { providers: [] as string[], email: false, commentary: false, billing: false };

function notFound(): Response {
  return Response.json({ error: "Not found." }, { status: 404 });
}

function closedApiResponse(method: string, pathname: string): Response | null {
  if (method === "GET" && pathname === "/api/config") return Response.json(CLOSED_CONFIG);
  if (gatedApiPath(pathname)) return notFound();
  if (pathname === "/api" || pathname.startsWith("/api/")) return notFound();
  return null;
}

const open = new Hono<App>();

open.use("/api/*", async (c, next) => {
  c.set("auth", createAuth(c.env, async (workspaceId) => (await plan(c.env.DB, workspaceId)).seats));
  await next();
});

// Changes must come from the site itself. The session cookie is already
// SameSite=Lax, which stops most cross-site requests; this is a second check.
// (Better Auth checks the origin on its own routes.)
open.use("/api/workspaces/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("origin") !== new URL(c.env.BETTER_AUTH_URL).origin) {
    return c.json({ error: "Requests must come from this site." }, 403);
  }
  await next();
});

/**
 * The Better Auth routes whose only way to answer is to put an email in front
 * of someone: the magic-link sign-in and the workspace invitation, which is
 * also how a resend is sent. Both are POST. Better Auth serves them wherever
 * its base path sits under this Worker's /api/auth handler, because a
 * BETTER_AUTH_URL that carries a path keeps it (better-auth's withPath
 * returns the URL unchanged when it already has a pathname, and its router
 * takes the basePath from new URL(baseURL).pathname). These are therefore
 * matched as the end of the request path, not at two fixed addresses: every
 * path Better Auth serves one of them at ends with one of these, and no other
 * route it serves ends with either.
 */
const EMAIL_ROUTES = ["/sign-in/magic-link", "/organization/invite-member"];

/**
 * Refuses a request that can only be answered by sending an email when this
 * deployment cannot send one, before Better Auth sees it.
 *
 * The sign-in route would answer the failure itself, because it awaits the
 * send. The invitation route does not: Better Auth runs that send in a
 * background helper, catches the thrown error and logs it, and then answers
 * 200 with a pending invitation nobody can act on. So the refusal happens here
 * and no invitation row is written. A path Better Auth would answer 404 is
 * refused as well, which is the cost of never letting a route it serves
 * through.
 */
function emailRefusal(env: Env, request: Request): Response | null {
  if (request.method !== "POST") return null;
  const pathname = new URL(request.url).pathname;
  if (!EMAIL_ROUTES.some((route) => pathname.endsWith(route))) return null;
  if (canSendEmail(env)) return null;
  return Response.json({ message: EMAIL_NOT_SET_UP }, { status: 503 });
}

open.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const unavailable = emailRefusal(c.env, c.req.raw);
  if (unavailable) return unavailable;
  const refusal = await limitMagicLinkSignIn(c.req.raw, c.env.MAGIC_LINK_RATE_LIMIT);
  if (refusal) return refusal;
  return c.get("auth").handler(c.req.raw);
});

async function userId(c: Context<App>): Promise<string> {
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new WorkspaceError(403, "Sign in first.");
  return session.user.id;
}

async function json(c: Context<App>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new WorkspaceError(400, "The request was not valid JSON.");
  }
}

open.onError((error, c) => {
  if (error instanceof WorkspaceError) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Something went wrong on the server." }, 500);
});

/** What this deployment offers, so the tool only shows what works. */
open.get("/api/config", (c) =>
  c.json({
    providers: [
      ...(c.env.MICROSOFT_CLIENT_ID ? ["microsoft"] : []),
      ...(c.env.GOOGLE_CLIENT_ID ? ["google"] : []),
    ],
    email: canSendEmail(c.env),
    commentary: Boolean(c.env.ANTHROPIC_API_KEY),
    billing: Boolean(c.env.PADDLE_API_KEY && c.env.PADDLE_PRICE_ID),
  }),
);

open.get("/api/workspaces/:id", async (c) => {
  const id = c.req.param("id");
  const role = await membership(c.env.DB, await userId(c), id);
  return c.json({ role, plan: await plan(c.env.DB, id) });
});

open.get("/api/workspaces/:id/setups", async (c) =>
  c.json(await listSetups(c.env.DB, await userId(c), c.req.param("id"), c.req.queries("column") ?? [])),
);
open.post("/api/workspaces/:id/setups", async (c) =>
  c.json(await saveSetup(c.env.DB, await userId(c), c.req.param("id"), await json(c)), 201),
);
open.delete("/api/workspaces/:id/setups/:item", async (c) => {
  await deleteSaved(c.env.DB, await userId(c), c.req.param("id"), "setup", c.req.param("item"));
  return c.body(null, 204);
});

open.get("/api/workspaces/:id/bridges", async (c) => c.json(await listBridges(c.env.DB, await userId(c), c.req.param("id"))));
open.post("/api/workspaces/:id/bridges", async (c) =>
  c.json(await saveBridge(c.env.DB, await userId(c), c.req.param("id"), await json(c)), 201),
);
open.delete("/api/workspaces/:id/bridges/:item", async (c) => {
  await deleteSaved(c.env.DB, await userId(c), c.req.param("id"), "bridge", c.req.param("item"));
  return c.body(null, 204);
});

open.post("/api/workspaces/:id/checkout", async (c) => {
  const id = c.req.param("id");
  const role = await membership(c.env.DB, await userId(c), id);
  if (role !== "owner" && role !== "admin") throw new WorkspaceError(403, "Only a workspace owner or admin can subscribe.");
  if (!c.env.PADDLE_API_KEY || !c.env.PADDLE_PRICE_ID) throw new WorkspaceError(404, "Subscriptions are not set up yet.");
  const { seats } = ((await json(c)) ?? {}) as { seats?: unknown };
  const checkout = await createCheckout({
    apiKey: c.env.PADDLE_API_KEY,
    environment: (c.env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox") as PaddleEnvironment,
    priceId: c.env.PADDLE_PRICE_ID,
    seats: typeof seats === "number" ? seats : 1,
    workspaceId: id,
  });
  return c.json({ checkoutUrl: checkout.checkoutUrl });
});

open.post("/api/paddle/webhook", async (c) => {
  const raw = await c.req.text();
  if (!c.env.PADDLE_WEBHOOK_SECRET || !(await verifyPaddleSignature(raw, c.req.header("paddle-signature") ?? null, c.env.PADDLE_WEBHOOK_SECRET))) {
    return c.json({ error: "Bad signature." }, 401);
  }
  const change = parseSubscriptionEvent(JSON.parse(raw), c.env.PADDLE_PRICE_ID ? [c.env.PADDLE_PRICE_ID] : undefined);
  // Events we do not use are acknowledged so Paddle does not retry them.
  return c.json({ result: change ? await applySubscription(c.env.DB, change) : "ignored" });
});

open.post("/api/commentary", (c) =>
  handleCommentary(c.req.raw, {
    apiKey: c.env.ANTHROPIC_API_KEY ?? "",
    authorize: async () => {
      if (!c.env.ANTHROPIC_API_KEY) return false;
      const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
      return session !== null && (await userHasPro(c.env.DB, session.user.id));
    },
  }),
);

open.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

open.get("/assets/*", async (c) => serveCompressedWasm(c.req.raw, c.env.ASSETS));

/** The asset layer redirects these names to the same file without `.html`. */
const HTML_PAGE = new Set(["/guide.html", "/method.html", "/privacy.html", "/price-volume-mix-analysis.html", "/grouping-level.html"]);

async function pageResponse(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  if (!HTML_PAGE.has(url.pathname)) return assets.fetch(request);
  url.pathname = url.pathname.slice(0, -".html".length);
  return assets.fetch(new Request(url, request));
}

open.get("*", async (c) => {
  const response = await pageResponse(c.req.raw, c.env.ASSETS);
  const view = pageView(c.req.raw, response);
  if (view) {
    (c.executionCtx as unknown as ExecutionContext).waitUntil(
      countPageView(c.env.DB, view, new Date().toISOString().slice(0, 10)).catch((e) => console.error("count failed", e)),
    );
  }
  return response;
});

for (const pathname of HTML_PAGE) {
  open.all(pathname.slice(0, -".html".length), (c) => c.env.ASSETS.fetch(c.req.raw));
}

const worker = {
  fetch(request: Request, env: Env, ctx: HonoExecutionContext): Response | Promise<Response> {
    const closed = closedApiResponse(request.method, getPath(request));
    if (closed !== null && !accountsEnabled(env.ACCOUNTS)) return closed;
    return open.fetch(request, env, ctx);
  },
};

export default worker;
