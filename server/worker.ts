import { Hono, type Context } from "hono";
import { serveCompressedWasm } from "./assets.ts";
import { createAuth, type Auth } from "./auth.ts";
import type { ExecutionContext, Fetcher } from "./cloudflare.ts";
import { handleCommentary } from "./commentary.ts";
import { countPageView, pageView } from "./counts.ts";
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
const app = new Hono<App>();

app.use("/api/*", async (c, next) => {
  c.set("auth", createAuth(c.env, async (workspaceId) => (await plan(c.env.DB, workspaceId)).seats));
  await next();
});

// Changes must come from the site itself. The session cookie is already
// SameSite=Lax, which stops most cross-site requests; this is a second check.
// (Better Auth checks the origin on its own routes.)
app.use("/api/workspaces/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("origin") !== new URL(c.env.BETTER_AUTH_URL).origin) {
    return c.json({ error: "Requests must come from this site." }, 403);
  }
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => c.get("auth").handler(c.req.raw));

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

app.onError((error, c) => {
  if (error instanceof WorkspaceError) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Something went wrong on the server." }, 500);
});

/** What this deployment offers, so the tool only shows what works. */
app.get("/api/config", (c) =>
  c.json({
    providers: [
      ...(c.env.MICROSOFT_CLIENT_ID ? ["microsoft"] : []),
      ...(c.env.GOOGLE_CLIENT_ID ? ["google"] : []),
    ],
    commentary: Boolean(c.env.ANTHROPIC_API_KEY),
    billing: Boolean(c.env.PADDLE_API_KEY && c.env.PADDLE_PRICE_ID),
  }),
);

app.get("/api/workspaces/:id", async (c) => {
  const id = c.req.param("id");
  const role = await membership(c.env.DB, await userId(c), id);
  return c.json({ role, plan: await plan(c.env.DB, id) });
});

app.get("/api/workspaces/:id/setups", async (c) =>
  c.json(await listSetups(c.env.DB, await userId(c), c.req.param("id"), c.req.queries("column") ?? [])),
);
app.post("/api/workspaces/:id/setups", async (c) =>
  c.json(await saveSetup(c.env.DB, await userId(c), c.req.param("id"), await json(c)), 201),
);
app.delete("/api/workspaces/:id/setups/:item", async (c) => {
  await deleteSaved(c.env.DB, await userId(c), c.req.param("id"), "setup", c.req.param("item"));
  return c.body(null, 204);
});

app.get("/api/workspaces/:id/bridges", async (c) => c.json(await listBridges(c.env.DB, await userId(c), c.req.param("id"))));
app.post("/api/workspaces/:id/bridges", async (c) =>
  c.json(await saveBridge(c.env.DB, await userId(c), c.req.param("id"), await json(c)), 201),
);
app.delete("/api/workspaces/:id/bridges/:item", async (c) => {
  await deleteSaved(c.env.DB, await userId(c), c.req.param("id"), "bridge", c.req.param("item"));
  return c.body(null, 204);
});

app.post("/api/workspaces/:id/checkout", async (c) => {
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

app.post("/api/paddle/webhook", async (c) => {
  const raw = await c.req.text();
  if (!c.env.PADDLE_WEBHOOK_SECRET || !(await verifyPaddleSignature(raw, c.req.header("paddle-signature") ?? null, c.env.PADDLE_WEBHOOK_SECRET))) {
    return c.json({ error: "Bad signature." }, 401);
  }
  const change = parseSubscriptionEvent(JSON.parse(raw), c.env.PADDLE_PRICE_ID ? [c.env.PADDLE_PRICE_ID] : undefined);
  // Events we do not use are acknowledged so Paddle does not retry them.
  return c.json({ result: change ? await applySubscription(c.env.DB, change) : "ignored" });
});

app.post("/api/commentary", (c) =>
  handleCommentary(c.req.raw, {
    apiKey: c.env.ANTHROPIC_API_KEY ?? "",
    authorize: async () => {
      if (!c.env.ANTHROPIC_API_KEY) return false;
      const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
      return session !== null && (await userHasPro(c.env.DB, session.user.id));
    },
  }),
);

app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

app.get("/assets/*", async (c) => serveCompressedWasm(c.req.raw, c.env.ASSETS));

/** The asset layer redirects these four names to the same file without `.html`. */
const HTML_PAGE = new Set(["/guide.html", "/method.html", "/privacy.html", "/price-volume-mix-analysis.html"]);

async function pageResponse(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  if (!HTML_PAGE.has(url.pathname)) return assets.fetch(request);
  url.pathname = url.pathname.slice(0, -".html".length);
  return assets.fetch(new Request(url, request));
}

app.get("*", async (c) => {
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
  app.all(pathname.slice(0, -".html".length), (c) => c.env.ASSETS.fetch(c.req.raw));
}

export default app;
