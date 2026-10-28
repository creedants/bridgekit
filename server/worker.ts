import { Hono, type Context, type ExecutionContext as HonoExecutionContext, type Next } from "hono";
import { getPath } from "hono/utils/url";
import { serveCompressedWasm } from "./assets.ts";
import { createAuth, limitMagicLinkSignIn, type Auth } from "./auth.ts";
import type { ExecutionContext, ForwardableEmailMessage, Fetcher, ScheduledController } from "./cloudflare.ts";
import { handleCommentary, type CommentarySpender } from "./commentary.ts";
import { countPageView, pageView } from "./counts.ts";
import { canSendEmail, EMAIL_NOT_SET_UP } from "./email.ts";
import type { Env } from "./env.ts";
import { createCheckout, createPortalSession, parseSubscriptionEvent, PaddleReadError, verifyPaddleSignature, type PaddleAccount, type PaddleEnvironment } from "./paddle.ts";
import { purgeSupportMail, receiveSupportMail } from "./support.ts";
import {
  assertCheckoutOpen,
  deleteSaved,
  invitationHasSeat,
  invitationSendAllowed,
  INVITATION_RATE_SENTENCE,
  listBridges,
  listSetups,
  membership,
  setupListQuery,
  plan,
  saveBridge,
  saveSetup,
  SEAT_LIMIT_SENTENCE,
  syncSubscription,
  userHasPro,
  WORKSPACE_LIMIT_SENTENCE,
  WorkspaceError,
  MAX_WORKSPACES_PER_USER,
  workspaceCount,
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
 *   mail to support@   forwarded, and kept for 90 days
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
async function requireSiteOrigin(c: Context<App>, next: Next): Promise<Response | void> {
  if (c.req.method !== "GET" && c.req.header("origin") !== new URL(c.env.BETTER_AUTH_URL).origin) {
    return c.json({ error: "Requests must come from this site." }, 403);
  }
  await next();
}

open.use("/api/workspaces/*", requireSiteOrigin);
open.use("/api/commentary", requireSiteOrigin);

/**
 * The Better Auth routes whose only way to answer is to put an email in front
 * of someone: the magic-link sign-in and the workspace invitation, which is
 * also how a resend is sent. Both are POST. Better Auth serves them wherever
 * its base path sits under this Worker's /api/auth handler, because a
 * BETTER_AUTH_URL that carries a path keeps it (better-auth's withPath
 * returns the URL unchanged when it already has a pathname, and its router
 * takes the basePath from new URL(baseURL).pathname). These are therefore
 * matched as the end of the request path, not at two fixed addresses: a
 * request Better Auth answers on either route arrives here with a path that
 * ends with one of them, and no other route it serves ends with either.
 */
const EMAIL_ROUTES = ["/sign-in/magic-link", "/organization/invite-member"];

/** The two Better Auth routes that write a workspace or an invitation. */
const CREATE_WORKSPACE = "/organization/create";
const INVITE_MEMBER = "/organization/invite-member";

function endsWith(request: Request, route: string): boolean {
  return new URL(request.url).pathname.endsWith(route);
}

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

function refused(sentence: string, status = 403): Response {
  return Response.json({ message: sentence }, { status });
}

/**
 * Reads the request body without consuming it, so Better Auth still receives
 * the request it came in on.
 */
async function body(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuses a workspace creation or an invitation before Better Auth runs, with
 * the sentence that request would otherwise owe its caller.
 *
 * The Worker asks, because the invitation email callback runs inside a
 * background helper that catches a refusal and then answers 200: a refusal
 * raised there cannot produce the plain 403 the request owes its caller.
 * The plugin's before-hooks run before the row is written and answer 403
 * themselves; the route's re-send branch never reaches beforeCreateInvitation,
 * so a re-send with no seat left is refused by the update trigger instead.
 * server/auth.ts still holds the same two seat checks for callers that reach
 * the plugin directly, and the triggers in migrations/0004_workspace_limits.sql
 * refuse a losing seat write that both checks have already let through.
 *
 * An invitation also has to fit the workspace's rolling 24-hour send window,
 * counted in D1 by migrations/0006_invite_limits.sql; that window is checked
 * after the seat for a new invitation and for a re-send alike, and the same
 * migration refuses a losing send that reaches the database.
 *
 * The invitation route resolves the workspace from the body's organizationId
 * and, without one, from the session's active workspace. This mirrors that,
 * and a re-send is counted the way the route counts it: it reuses the live
 * pending invitation, which already holds its seat.
 */
async function limitsRefusal(auth: Auth, env: Env, request: Request): Promise<Response | null> {
  if (request.method !== "POST") return null;
  if (!endsWith(request, CREATE_WORKSPACE) && !endsWith(request, INVITE_MEMBER)) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  if (endsWith(request, CREATE_WORKSPACE)) {
    if ((await workspaceCount(env.DB, session.user.id)) >= MAX_WORKSPACES_PER_USER) return refused(WORKSPACE_LIMIT_SENTENCE);
    return null;
  }
  if (!endsWith(request, INVITE_MEMBER)) return null;
  const parsed = await body(request);
  if (!isRecord(parsed)) return null;
  const organizationId = typeof parsed.organizationId === "string" && parsed.organizationId ? parsed.organizationId : session.session.activeOrganizationId;
  if (!organizationId) return null;
  if (!(await invitationHasSeat(env.DB, organizationId, parsed))) return refused(SEAT_LIMIT_SENTENCE);
  // The seat check runs first, so a workspace short of both keeps the seat
  // sentence. A re-send counts against the window as well as a new invitation.
  if (!(await invitationSendAllowed(env.DB, organizationId))) return refused(INVITATION_RATE_SENTENCE, 429);
  return null;
}

/**
 * Translates the refusal a database trigger raises into the sentence the
 * request owes its caller, with the status that sentence carries. Two
 * invitations for the last seat both pass limitsRefusal, and the database
 * refuses the one that would take a seat already taken. Two invitations for
 * the last send of the rolling 24 hours both pass it as well, and the ledger's
 * guard in migrations/0006_invite_limits.sql refuses the one that would write
 * the 21st. Better Auth surfaces either error rather than answering it,
 * because a database error is not one of its own, and the request has written
 * no row and sent no email.
 */
const TRIGGER_REFUSALS: readonly (readonly [sentence: string, status: number])[] = [
  [SEAT_LIMIT_SENTENCE, 403],
  [INVITATION_RATE_SENTENCE, 429],
];

function translation(error: unknown): Response | null {
  if (!(error instanceof Error)) return null;
  for (const [sentence, status] of TRIGGER_REFUSALS) {
    if (error.message.includes(sentence)) return refused(sentence, status);
  }
  return null;
}

open.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const unavailable = emailRefusal(c.env, c.req.raw);
  if (unavailable) return unavailable;
  const refusal = await limitMagicLinkSignIn(c.req.raw, c.env.MAGIC_LINK_RATE_LIMIT);
  if (refusal) return refusal;
  const limited = await limitsRefusal(c.get("auth"), c.env, c.req.raw);
  if (limited) return limited;
  return c.get("auth").handler(c.req.raw);
});

async function userId(c: Context<App>): Promise<string> {
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new WorkspaceError(403, "Sign in first.");
  return session.user.id;
}

/** The message used when reading or parsing JSON fails. */
const NOT_JSON = "The request was not valid JSON.";

async function json(c: Context<App>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new WorkspaceError(400, NOT_JSON);
  }
}

/** The most a setup or bridge save body may be, in bytes. */
const SAVE_BODY_LIMIT = 8 * 1024 * 1024;
const TOO_LARGE = "This is too large to save.";

class BodyTooLarge extends Error {}

/**
 * Reads a save body and refuses it before parsing when it is over `limit`.
 * `Content-Length` only short-circuits: a request may omit it or understate
 * it, so the bytes read are what decide.
 */
async function boundedJson(c: Context<App>, limit: number): Promise<unknown> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > limit) throw new BodyTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = c.req.raw.body?.getReader();
  } catch {
    throw new WorkspaceError(400, NOT_JSON);
  }
  if (reader) {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new WorkspaceError(400, NOT_JSON);
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        try {
          await reader.cancel();
        } catch {
          // A source can reject cancel; the over-limit refusal is already decided.
        }
        throw new BodyTooLarge();
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WorkspaceError(400, NOT_JSON);
  }
}

function parseWebhookBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkspaceError(400, NOT_JSON);
  }
}

open.onError((error, c) => {
  if (error instanceof BodyTooLarge) return c.json({ error: TOO_LARGE }, 413);
  const refused = translation(error);
  if (refused) return refused;
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

open.get("/api/workspaces/:id/setups", async (c) => {
  const user = await userId(c);
  const query = setupListQuery(c.req.url);
  return c.json(await listSetups(c.env.DB, user, c.req.param("id"), query));
});
open.post("/api/workspaces/:id/setups", async (c) => {
  const user = await userId(c);
  return c.json(await saveSetup(c.env.DB, user, c.req.param("id"), await boundedJson(c, SAVE_BODY_LIMIT)), 201);
});
open.delete("/api/workspaces/:id/setups/:item", async (c) => {
  await deleteSaved(c.env.DB, await userId(c), c.req.param("id"), "setup", c.req.param("item"));
  return c.body(null, 204);
});

open.get("/api/workspaces/:id/bridges", async (c) => c.json(await listBridges(c.env.DB, await userId(c), c.req.param("id"))));
open.post("/api/workspaces/:id/bridges", async (c) => {
  const user = await userId(c);
  return c.json(await saveBridge(c.env.DB, user, c.req.param("id"), await boundedJson(c, SAVE_BODY_LIMIT)), 201);
});
open.delete("/api/workspaces/:id/bridges/:item", async (c) => {
  await deleteSaved(c.env.DB, await userId(c), c.req.param("id"), "bridge", c.req.param("item"));
  return c.body(null, 204);
});

function seatPrices(env: Env): readonly string[] | undefined {
  return env.PADDLE_PRICE_ID ? [env.PADDLE_PRICE_ID] : undefined;
}

function paddleAccount(env: Env): PaddleAccount | null {
  if (!env.PADDLE_API_KEY) return null;
  return { apiKey: env.PADDLE_API_KEY, environment: env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox", seatPriceIds: seatPrices(env) };
}

open.post("/api/workspaces/:id/checkout", async (c) => {
  const id = c.req.param("id");
  const role = await membership(c.env.DB, await userId(c), id);
  if (role !== "owner" && role !== "admin") throw new WorkspaceError(403, "Only a workspace owner or admin can subscribe.");
  const prices = seatPrices(c.env);
  if (!c.env.PADDLE_API_KEY || !prices) throw new WorkspaceError(404, "Subscriptions are not set up yet.");
  const { seats } = ((await json(c)) ?? {}) as { seats?: unknown };
  await assertCheckoutOpen(c.env.DB, id);
  const checkout = await createCheckout({
    apiKey: c.env.PADDLE_API_KEY,
    environment: c.env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox",
    priceId: prices[0],
    seats: typeof seats === "number" ? seats : 1,
    workspaceId: id,
  });
  return c.json({ checkoutUrl: checkout.checkoutUrl });
});

open.post("/api/workspaces/:id/portal", async (c) => {
  const id = c.req.param("id");
  const role = await membership(c.env.DB, await userId(c), id);
  if (role !== "owner" && role !== "admin") throw new WorkspaceError(403, "Only a workspace owner or admin can subscribe.");
  if (!c.env.PADDLE_API_KEY) throw new WorkspaceError(404, "Subscriptions are not set up yet.");
  const row = await c.env.DB.prepare(`SELECT paddleCustomerId FROM subscription WHERE organizationId = ?`)
    .bind(id)
    .first<{ paddleCustomerId: string | null }>();
  if (!row?.paddleCustomerId) return c.json({ error: "Not found." }, 404);
  try {
    const portal = await createPortalSession({
      apiKey: c.env.PADDLE_API_KEY,
      environment: (c.env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox") as PaddleEnvironment,
      customerId: row.paddleCustomerId,
    });
    return c.json({ portalUrl: portal.portalUrl });
  } catch {
    return c.json({ error: "Could not open the billing portal. Try again." }, 502);
  }
});

open.post("/api/paddle/webhook", async (c) => {
  const raw = await c.req.text();
  if (!c.env.PADDLE_WEBHOOK_SECRET || !(await verifyPaddleSignature(raw, c.req.header("paddle-signature") ?? null, c.env.PADDLE_WEBHOOK_SECRET))) {
    return c.json({ error: "Bad signature." }, 401);
  }
  const event = parseSubscriptionEvent(parseWebhookBody(raw), seatPrices(c.env));
  // Events we do not use are acknowledged so Paddle does not retry them.
  if (!event) return c.json({ result: "ignored" });
  const paddle = paddleAccount(c.env);
  // Without a key this deployment cannot check out or reconcile, so asking
  // Paddle to retry is the honest answer; the payload is never stored as state.
  if (!paddle) return c.json({ error: "Subscriptions are not set up yet." }, 503);
  try {
    const result = await syncSubscription(c.env.DB, event, paddle);
    switch (result) {
      case "applied":
      case "stale":
      case "unknown-workspace":
        return c.json({ result });
      case "conflict":
        console.error({
          message: "A concurrent read stored a different subscription state.",
          workspaceId: event.workspaceId,
          subscriptionId: event.subscriptionId,
        });
        return c.json({ error: "The subscription changed while reconciling." }, 503);
      default:
        throw new Error(`Unhandled subscription sync result: ${result satisfies never}`);
    }
  } catch (error) {
    if (!(error instanceof PaddleReadError)) throw error;
    console.error(error);
    return c.json({ error: "Could not read the subscription from Paddle." }, 502);
  }
});

async function commentarySpender(c: Context<App>): Promise<CommentarySpender | null> {
  if (!c.env.ANTHROPIC_API_KEY) return null;
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
  if (!session || session.user.id === "" || !(await userHasPro(c.env.DB, session.user.id))) return null;
  return session.user.id as CommentarySpender;
}

open.post("/api/commentary", (c) =>
  handleCommentary(c.req.raw, {
    apiKey: c.env.ANTHROPIC_API_KEY ?? "",
    spender: () => commentarySpender(c),
    rateLimit: c.env.COMMENTARY_RATE_LIMIT,
    ledger: c.env.DB,
  }),
);

open.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

open.get("/assets/*", async (c) => serveCompressedWasm(c.req.raw, c.env.ASSETS));

/** The asset layer redirects these names to the same file without `.html`. */
export const HTML_PAGE = new Set(["/guide.html", "/method.html", "/privacy.html", "/terms.html", "/price-volume-mix-analysis.html", "/grouping-level.html"]);

/** The hosts a local run answers on, where plain http is the normal address. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The address a request should be sent to instead, or null when it already is
 * the canonical one. Plain http on a public host moves to https, and a GET or
 * HEAD for one of the page names that also answers without `.html` moves to
 * the `.html` address. Both moves happen together, so
 * `http://pvmbridge.com/guide?x=1` lands on `https://pvmbridge.com/guide.html?x=1`
 * in one hop.
 */
export function canonicalAddress(request: Request): URL | null {
  const url = new URL(request.url);
  const https = url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname);
  const page = (request.method === "GET" || request.method === "HEAD") && HTML_PAGE.has(`${url.pathname}.html`);
  if (!https && !page) return null;
  if (https) url.protocol = "https:";
  if (page) url.pathname = `${url.pathname}.html`;
  return url;
}

async function pageResponse(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  if (!HTML_PAGE.has(url.pathname)) return assets.fetch(request);
  url.pathname = url.pathname.slice(0, -".html".length);
  return assets.fetch(new Request(url, request));
}

/**
 * The not-found page, served at a status that says the address does not exist.
 * The asset layer answers /404 with the 404.html body and a 200, and moves
 * /404.html to /404 with a 307, so both names read /404 here and keep the
 * body, ETag and headers a missing path gets. The read drops the caller's
 * validators because a matching one makes the asset layer answer 304, which
 * would leave this 404 with no page body.
 */
async function notFoundPage(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/404";
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  const response = await assets.fetch(new Request(url, { method: request.method, headers }));
  return new Response(response.body, { status: 404, headers: response.headers });
}

open.get("/404", (c) => notFoundPage(c.req.raw, c.env.ASSETS));
open.get("/404.html", (c) => notFoundPage(c.req.raw, c.env.ASSETS));

open.get("*", async (c) => {
  const response = await pageResponse(c.req.raw, c.env.ASSETS);
  const view = pageView(c.req.raw, response, HTML_PAGE);
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
    const canonical = canonicalAddress(request);
    if (canonical !== null) {
      // A move that only changes the path stays relative to the address the
      // request came in on; only the move to https names the host, because the
      // scheme changes with it.
      const location = canonical.protocol === new URL(request.url).protocol ? `${canonical.pathname}${canonical.search}` : canonical.href;
      return new Response(null, { status: 301, headers: { location } });
    }
    const closed = closedApiResponse(request.method, getPath(request));
    if (closed !== null && !accountsEnabled(env.ACCOUNTS)) return closed;
    return open.fetch(request, env, ctx);
  },
  /** Mail to the support address (Email Routing): forwarded, and kept 90 days when a person sent it. */
  email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    return receiveSupportMail(message, env);
  },
  /** The daily cron in wrangler.jsonc: deletes support mail past its 90 days. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await purgeSupportMail(env.DB, new Date(controller.scheduledTime));
  },
};

export default worker;
