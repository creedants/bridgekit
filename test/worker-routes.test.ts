import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { testDatabase } from "./support/d1.ts";

const GUIDE = "<!doctype html><title>Guide</title>";
const METHOD = "<!doctype html><title>Method</title>";
const PRIVACY = "<!doctype html><title>Privacy</title>";
const ARTICLE = "<!doctype html><title>Price volume mix</title>";

function redirect(location: string): Response {
  return new Response("redirect", { status: 307, headers: { location, "content-type": "text/html; charset=utf-8" } });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

type AssetCall = { method: string; pathname: string; search: string; ifNoneMatch: string | null; body: string };
type AssetPage = Response | ((request: Request) => Response);

function bindings(pages: Record<string, AssetPage>, db = testDatabase()): { env: Env; db: Env["DB"]; calls: AssetCall[] } {
  const calls: AssetCall[] = [];
  const assets: Fetcher = {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        ifNoneMatch: request.headers.get("if-none-match"),
        body: await request.clone().text(),
      });
      const page = pages[url.pathname];
      if (!page) return new Response("missing", { status: 500 });
      return typeof page === "function" ? page(request) : page.clone();
    },
  };
  return {
    db,
    calls,
    env: {
      ASSETS: assets,
      DB: db,
      BETTER_AUTH_URL: "http://127.0.0.1:8790",
      BETTER_AUTH_SECRET: "test-secret",
    },
  };
}

async function call(url: string, env: Env, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(new Request(url, init), env, {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  });
  await Promise.all(pending);
  return response;
}

async function open(path: string, env: Env, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", "Mozilla/5.0");
  if (!headers.has("sec-fetch-dest")) headers.set("sec-fetch-dest", "document");
  return call(`http://127.0.0.1:8790${path}`, env, { ...init, headers });
}

async function views(db: Env["DB"]): Promise<{ path: string; referrer: string; views: number }[]> {
  const rows = await db.prepare("SELECT path, referrer, views FROM page_views ORDER BY path").all<{ path: string; referrer: string; views: number }>();
  return rows.results;
}

test("an html address returns that page and counts the request once", async () => {
  const { env, db, calls } = bindings({
    "/guide.html": redirect("/guide"),
    "/guide": html(GUIDE),
    "/method.html": redirect("/method"),
    "/method": html(METHOD),
    "/privacy.html": redirect("/privacy"),
    "/privacy": html(PRIVACY),
    "/price-volume-mix-analysis.html": redirect("/price-volume-mix-analysis"),
    "/price-volume-mix-analysis": html(ARTICLE),
  });
  const guide = await open("/guide.html", env);
  assert.equal(guide.status, 200);
  assert.equal(guide.headers.get("location"), null);
  assert.equal(await guide.text(), GUIDE);
  const method = await open("/method.html", env);
  const privacy = await open("/privacy.html", env);
  const article = await open("/price-volume-mix-analysis.html", env);
  assert.equal(method.status, 200);
  assert.equal(await method.text(), METHOD);
  assert.equal(privacy.status, 200);
  assert.equal(await privacy.text(), PRIVACY);
  assert.equal(article.status, 200);
  assert.equal(await article.text(), ARTICLE);
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ["/guide", "/method", "/privacy", "/price-volume-mix-analysis"],
  );
  assert.deepEqual(await views(db), [
    { path: "/guide.html", referrer: "", views: 1 },
    { path: "/method.html", referrer: "", views: 1 },
    { path: "/price-volume-mix-analysis.html", referrer: "", views: 1 },
    { path: "/privacy.html", referrer: "", views: 1 },
  ]);
});

test("the extensionless address counts its own path and not the html address", async () => {
  const { env, db } = bindings({
    "/guide.html": redirect("/guide"),
    "/guide": html(GUIDE),
  });
  const response = await open("/guide", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), GUIDE);
  assert.deepEqual(await views(db), [{ path: "/guide", referrer: "", views: 1 }]);
});

test("two requests for the same html address count two views of that address", async () => {
  const { env, db } = bindings({
    "/method.html": redirect("/method"),
    "/method": html(METHOD),
  });
  assert.equal((await open("/method.html", env)).status, 200);
  assert.equal((await open("/method.html", env)).status, 200);
  assert.deepEqual(await views(db), [{ path: "/method.html", referrer: "", views: 2 }]);
});

test("an html address is read from the extensionless file even when the html name itself is a page", async () => {
  const { env, db, calls } = bindings({
    "/privacy.html": html("<!doctype html><title>Wrong</title>"),
    "/privacy": html(PRIVACY),
  });
  const response = await open("/privacy.html", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PRIVACY);
  assert.deepEqual(calls.map((call) => call.pathname), ["/privacy"]);
  assert.deepEqual(await views(db), [{ path: "/privacy.html", referrer: "", views: 1 }]);
});

test("index.html redirects stay redirects", async () => {
  const { env, db, calls } = bindings({
    "/index.html": redirect("/"),
    "/": html(GUIDE),
    "/app/index.html": redirect("/app/"),
    "/app/": html(METHOD),
    "/pay/index.html": redirect("/pay/"),
    "/pay/": html(ARTICLE),
  });
  const home = await open("/index.html", env);
  const appPage = await open("/app/index.html", env);
  const pay = await open("/pay/index.html", env);
  assert.equal(home.status, 307);
  assert.equal(home.headers.get("location"), "/");
  assert.equal(appPage.status, 307);
  assert.equal(appPage.headers.get("location"), "/app/");
  assert.equal(pay.status, 307);
  assert.equal(pay.headers.get("location"), "/pay/");
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ["/index.html", "/app/index.html", "/pay/index.html"],
  );
  assert.deepEqual(await views(db), []);
});

test("HEAD does not count", async () => {
  const { env, db, calls } = bindings({
    "/guide.html": redirect("/guide"),
    "/guide": html(GUIDE),
  });
  const response = await open("/guide.html", env, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls, [{ method: "HEAD", pathname: "/guide", search: "", ifNoneMatch: null, body: "" }]);
  assert.deepEqual(await views(db), []);
});

test("a conditional 304 does not count", async () => {
  const { env, db, calls } = bindings({
    "/method.html": redirect("/method"),
    "/method": (request) => {
      assert.equal(request.headers.get("if-none-match"), '"page"');
      return new Response(null, { status: 304, headers: { etag: '"page"' } });
    },
  });
  const response = await open("/method.html", env, { headers: { "if-none-match": '"page"' } });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"page"');
  assert.deepEqual(calls.map((call) => ({ method: call.method, pathname: call.pathname, ifNoneMatch: call.ifNoneMatch })), [
    { method: "GET", pathname: "/method", ifNoneMatch: '"page"' },
  ]);
  assert.deepEqual(await views(db), []);
});

test("a query string is kept on the asset request and the count uses the html address", async () => {
  const { env, db, calls } = bindings({
    "/privacy.html": redirect("/privacy"),
    "/privacy": html(PRIVACY),
  });
  const response = await open("/privacy.html?a=1&a=2&encoded=%2F", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PRIVACY);
  assert.deepEqual(calls, [
    { method: "GET", pathname: "/privacy", search: "?a=1&a=2&encoded=%2F", ifNoneMatch: null, body: "" },
  ]);
  assert.deepEqual(await views(db), [{ path: "/privacy.html", referrer: "", views: 1 }]);
});

test("POST and PUT to an extensionless page are passed through unchanged", async () => {
  const denied = new Response(null, {
    status: 405,
    headers: {
      allow: "GET, HEAD",
      "content-security-policy": "default-src 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "camera=()",
    },
  });
  const { env, db, calls } = bindings({
    "/guide": (request) => {
      assert.equal(request.headers.get("x-probe"), "1");
      return denied.clone();
    },
  });
  for (const method of ["POST", "PUT"]) {
    const response = await open("/guide?x=1", env, { method, body: "payload", headers: { "x-probe": "1" } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("permissions-policy"), "camera=()");
  }
  assert.deepEqual(calls, [
    { method: "POST", pathname: "/guide", search: "?x=1", ifNoneMatch: null, body: "payload" },
    { method: "PUT", pathname: "/guide", search: "?x=1", ifNoneMatch: null, body: "payload" },
  ]);
  assert.deepEqual(await views(db), []);
});

test("a redirect for a path that is not an html page is returned and not counted", async () => {
  const { env, db } = bindings({
    "/old": redirect("/new"),
    "/new": html(GUIDE),
  });
  const response = await open("/old", env);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/new");
  assert.deepEqual(await views(db), []);
});

const HOME = "<!doctype html><title>Home</title>";
const ORIGIN = "http://127.0.0.1:8790";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const SIGN_IN = JSON.stringify({ email: "review@example.invalid", callbackURL: `${ORIGIN}/app/` });
const ACCOUNT_TABLES = ["verification", "user", "session", "account", "organization", "invitation", "page_views"] as const;

// Better Auth reads pragma_table_info through D1 batch. This stand-in's batch
// uses run(), which drops rows, and sign-in then answers 500.
function database(): Env["DB"] {
  const db = testDatabase();
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    exec: (sql) => db.exec(sql),
  };
}

async function counts(db: Env["DB"]): Promise<Record<(typeof ACCOUNT_TABLES)[number], number>> {
  const out = { verification: 0, user: 0, session: 0, account: 0, organization: 0, invitation: 0, page_views: 0 };
  for (const table of ACCOUNT_TABLES) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>();
    out[table] = row?.n ?? 0;
  }
  return out;
}

async function assertNotFound(response: Response, label: string): Promise<string> {
  const body = await response.text();
  assert.equal(response.status, 404, label);
  assert.deepEqual(JSON.parse(body), { error: "Not found." });
  return body;
}

test("accounts stay closed for omitted, empty, ON, and true", async () => {
  const { env, db } = bindings({ "/": html(HOME) }, database());
  const base = { ...env, BETTER_AUTH_SECRET: AUTH_SECRET };
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  const paths = [
    "/api/workspaces/perf-local",
    "/api/auth/sign-in/magic-link",
    "/api/workspaces/perf-local/checkout",
    "/api/paddle/webhook",
    "/api/commentary",
  ];
  const variants = [
    { method: "POST", path: "/api/auth/sign-in/magic-link/" },
    { method: "POST", path: "/api/auth" },
    { method: "POST", path: "/api/auth/sign-in/%6Dagic-link" },
    { method: "POST", path: "/%61pi/auth/sign-in/magic-link" },
    { method: "POST", path: "/api/auth/sign-in/Magic-Link" },
    { method: "POST", path: "/api/Auth/sign-in/magic-link" },
    { method: "GET", path: "/API/auth/sign-in/magic-link" },
    { method: "POST", path: "/API/auth/sign-in/magic-link" },
    { method: "POST", path: "/api/auth%2Fsign-in/magic-link" },
    { method: "POST", path: "/api%2Fauth/sign-in/magic-link" },
    { method: "GET", path: "/api%2Fauth/sign-in/magic-link" },
    { method: "POST", path: "/api/commentary/" },
    { method: "GET", path: "/api/workspaces/perf-local/" },
    { method: "POST", path: "/api/paddle/webhook/" },
    { method: "POST", path: "/api/auth//sign-in" },
    { method: "POST", path: "/api//auth/sign-in/magic-link" },
  ];
  for (const accounts of [undefined, "", "ON", "true"] as const) {
    const current = accounts === undefined ? base : { ...base, ACCOUNTS: accounts };
    const before = await counts(db);
    let head: { status: number; body: string } | undefined;
    for (const method of methods) {
      for (const path of paths) {
        const response = await call(`${ORIGIN}${path}`, current, { method });
        const label = `${method} ${path} with ACCOUNTS ${accounts === undefined ? "omitted" : JSON.stringify(accounts)}`;
        const body = await assertNotFound(response, label);
        if (method === "HEAD") {
          if (!head) {
            const reference = await call(`${ORIGIN}/api/does-not-exist`, current, { method: "HEAD" });
            head = { status: reference.status, body: await reference.text() };
          }
          assert.equal(response.status, head.status, label);
          assert.equal(body, head.body, label);
        }
      }
    }
    for (const variant of variants) {
      const response = await call(`${ORIGIN}${variant.path}`, current, { method: variant.method });
      await assertNotFound(response, `${variant.method} ${variant.path}`);
    }
    const hosted = await call(`${ORIGIN}/api/auth/sign-in/magic-link`, current, {
      method: "POST",
      headers: { host: "other.example", origin: ORIGIN, "content-type": "application/json" },
      body: SIGN_IN,
    });
    await assertNotFound(hosted, "POST magic-link with Host other.example");
    const otherHost = await call("http://other.example/api/auth/sign-in/magic-link", current, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: SIGN_IN,
    });
    await assertNotFound(otherHost, "POST magic-link on other.example");
    assert.deepEqual(await counts(db), before);
    const configured = {
      ...current,
      MICROSOFT_CLIENT_ID: "microsoft",
      GOOGLE_CLIENT_ID: "google",
      ANTHROPIC_API_KEY: "anthropic",
      PADDLE_API_KEY: "paddle",
      PADDLE_PRICE_ID: "price",
    };
    for (const path of ["/api/config", "/api/%63onfig"]) {
      const response = await call(`${ORIGIN}${path}`, configured);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), { providers: [], commentary: false, billing: false });
    }
  }
  const page = await open("/", base);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), HOME);
  assert.deepEqual(await views(db), [{ path: "/", referrer: "", views: 1 }]);

  const turnedOn = bindings({ "/": html(HOME) }, database());
  const on = { ...turnedOn.env, BETTER_AUTH_SECRET: AUTH_SECRET, ACCOUNTS: "on" };
  const openPage = await open("/", on);
  assert.equal(openPage.status, 200);
  assert.equal(await openPage.text(), HOME);
  assert.deepEqual(await views(turnedOn.db), [{ path: "/", referrer: "", views: 1 }]);

  const workspace = await call(`${ORIGIN}/api/workspaces/perf-local`, on);
  assert.equal(workspace.status, 403);
  assert.deepEqual(await workspace.json(), { error: "Sign in first." });

  const webhook = await call(`${ORIGIN}/api/paddle/webhook`, on, { method: "POST", body: "{}" });
  assert.equal(webhook.status, 401);
  assert.deepEqual(await webhook.json(), { error: "Bad signature." });

  const signIn = await call(`${ORIGIN}/api/auth/sign-in/magic-link`, on, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: SIGN_IN,
  });
  assert.equal(signIn.status, 200);
  assert.deepEqual(await signIn.json(), { status: true });
  const afterSignIn = await counts(turnedOn.db);
  assert.equal(afterSignIn.verification, 1);
  assert.equal(afterSignIn.user, 0);
  assert.equal(afterSignIn.session, 0);

  const beforeUpper = await views(turnedOn.db);
  const upper = await call(`${ORIGIN}/API/auth/sign-in/magic-link`, on);
  assert.equal(upper.status, 500);
  assert.equal(await upper.text(), "missing");
  assert.deepEqual(await views(turnedOn.db), beforeUpper);
});
