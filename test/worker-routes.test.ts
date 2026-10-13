import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import { EMAIL_NOT_SET_UP } from "../server/email.ts";
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

async function applicationTables(db: Env["DB"]): Promise<string[]> {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  return rows.results.map((row) => row.name).filter((name) => !name.startsWith("sqlite_"));
}

async function counts(db: Env["DB"], tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>();
    assert.ok(row, table);
    out[table] = row.n;
  }
  return out;
}

function closedEnv(accounts: string | undefined): Env {
  const source: { ACCOUNTS?: string } = {};
  if (accounts !== undefined) source.ACCOUNTS = accounts;
  return new Proxy(source, {
    get(target, key) {
      if (key === "ACCOUNTS") return target.ACCOUNTS;
      if (typeof key === "string") throw new Error(`closed environment read ${key}`);
      return undefined;
    },
  }) as unknown as Env;
}

async function assertNotFound(response: Response, label: string): Promise<string> {
  const body = await response.text();
  assert.equal(response.status, 404, label);
  assert.deepEqual(JSON.parse(body), { error: "Not found." });
  return body;
}

test("accounts stay closed unless ACCOUNTS is on", async () => {
  const counted = testDatabase();
  const tables = await applicationTables(counted);
  for (const name of ["member", "subscription", "saved_setup", "saved_bridge", "verification", "page_views"]) {
    assert.equal(tables.includes(name), true, name);
  }
  const untouched = Object.fromEntries(tables.map((table) => [table, 0]));
  assert.deepEqual(await counts(counted, tables), untouched);

  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
  const paths = [
    "/api/auth/sign-in/magic-link",
    "/api/workspaces/perf-local",
    "/api/workspaces/perf-local/checkout",
    "/api/paddle/webhook",
    "/api/commentary",
  ];
  const forms = [
    "/api/./auth/sign-in/magic-link",
    "/api//auth/sign-in/magic-link",
    "/api/auth/sign-in/magic-link/",
    "/api/auth/sign-in/magic-link?q=1",
    "/api/%61uth/sign-in/magic-link",
    "/api/auth%2Fsign-in/magic-link",
    "/API/auth/sign-in/magic-link",
    "/api%2Fauth/sign-in/magic-link",
    "/%61pi/auth/sign-in/magic-link",
  ];
  for (const accounts of [undefined, "", "ON", "On", " on", "true", "1", "off"] as const) {
    const env = closedEnv(accounts);
    const accountsLabel = accounts === undefined ? "missing" : JSON.stringify(accounts);
    const before = await counts(counted, tables);
    const reference = await call(`${ORIGIN}/api/does-not-exist`, env, { method: "HEAD" });
    const head = { status: reference.status, body: await reference.text() };
    for (const method of methods) {
      for (const path of paths) {
        const init: RequestInit = { method };
        if (method === "POST" && path === "/api/auth/sign-in/magic-link") {
          init.body = SIGN_IN;
          init.headers = { "content-type": "application/json" };
        }
        const response = await call(`${ORIGIN}${path}`, env, init);
        const label = `${method} ${path} with ACCOUNTS ${accountsLabel}`;
        const body = await assertNotFound(response, label);
        if (method === "HEAD") {
          assert.equal(response.status, head.status, label);
          assert.equal(body, head.body, label);
        }
      }
    }
    for (const method of ["GET", "POST"] as const) {
      for (const path of forms) {
        const response = await call(`${ORIGIN}${path}`, env, { method });
        await assertNotFound(response, `${method} ${path} with ACCOUNTS ${accountsLabel}`);
      }
    }
    const noOrigin = await call(`${ORIGIN}/api/auth/sign-in/magic-link`, env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: SIGN_IN,
    });
    await assertNotFound(noOrigin, `POST magic-link with no Origin and ACCOUNTS ${accountsLabel}`);
    const hosted = await call(`${ORIGIN}/api/auth/sign-in/magic-link`, env, {
      method: "POST",
      headers: { host: "other.example", origin: ORIGIN, "content-type": "application/json" },
      body: SIGN_IN,
    });
    await assertNotFound(hosted, `POST magic-link with Host other.example and ACCOUNTS ${accountsLabel}`);
    const otherHost = await call("http://other.example/api/auth/sign-in/magic-link", env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: SIGN_IN,
    });
    await assertNotFound(otherHost, `POST magic-link on other.example and ACCOUNTS ${accountsLabel}`);
    const configPost = await call(`${ORIGIN}/api/config`, env, { method: "POST" });
    await assertNotFound(configPost, `POST /api/config with ACCOUNTS ${accountsLabel}`);
    for (const path of ["/api/config", "/api/%63onfig"]) {
      const response = await call(`${ORIGIN}${path}`, env);
      assert.equal(response.status, 200, `${path} with ACCOUNTS ${accountsLabel}`);
      assert.deepEqual(await response.json(), { providers: [], email: false, commentary: false, billing: false });
    }
    assert.deepEqual(await counts(counted, tables), before);
  }

  const { env } = bindings({ "/": html(HOME) }, counted);
  const page = await open("/", env);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), HOME);
  assert.deepEqual(await views(counted), [{ path: "/", referrer: "", views: 1 }]);
  assert.deepEqual(
    await counts(counted, tables),
    Object.fromEntries(tables.map((table) => [table, table === "page_views" ? 1 : 0])),
  );

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
  // No mail key and no LOCAL_EMAIL_LOG, so the request is refused before
  // Better Auth runs. No verification row is written and the allowance is not
  // charged.
  assert.equal(signIn.status, 503);
  assert.deepEqual(await signIn.json(), { message: EMAIL_NOT_SET_UP });
  const afterSignIn = await counts(turnedOn.db, await applicationTables(turnedOn.db));
  assert.equal(afterSignIn.verification, 0);
  assert.equal(afterSignIn.user, 0);
  assert.equal(afterSignIn.session, 0);

  const beforeUpper = await views(turnedOn.db);
  const upper = await call(`${ORIGIN}/API/auth/sign-in/magic-link`, on);
  assert.equal(upper.status, 500);
  assert.equal(await upper.text(), "missing");
  assert.deepEqual(await views(turnedOn.db), beforeUpper);
});

test("the config reports whether an email can be sent", async () => {
  const { env } = bindings({ "/": html(HOME) });
  const turnedOn = { ...env, ACCOUNTS: "on" };
  const config = async (fields: Partial<Env>): Promise<unknown> => (await call(`${ORIGIN}/api/config`, { ...turnedOn, ...fields })).json();
  const without = { providers: [], email: false, commentary: false, billing: false };
  assert.deepEqual(await config({}), without);
  assert.deepEqual(await config({ LOCAL_EMAIL_LOG: "on" }), { ...without, email: true });
  assert.deepEqual(await config({ LOCAL_EMAIL_LOG: "true" }), without);
  assert.deepEqual(await config({ LOCAL_EMAIL_LOG: " on" }), without);
  assert.deepEqual(await config({ RESEND_API_KEY: "re_test_key" }), without);
  assert.deepEqual(await config({ EMAIL_FROM: "no-reply@example.invalid" }), without);
  assert.deepEqual(await config({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "no-reply@example.invalid" }), { ...without, email: true });
  assert.deepEqual(await config({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "no-reply@example.invalid", LOCAL_EMAIL_LOG: "on" }), {
    ...without,
    email: true,
  });
});

const OWNER = "owner@example.invalid";
const INVITED = "invited@example.invalid";

type Sent = { url: string; init: RequestInit };

let clients = 0;

/**
 * A distinct documentation-range client address per request. Better Auth
 * cannot read a client IP from these requests and then shares one bucket per
 * path, so without this the cases in this file fill each other's buckets.
 */
function clientIp(): string {
  clients += 1;
  return `203.0.113.${(clients % 254) + 1}`;
}

/** Records every console line and every fetch, without printing or sending. */
function record(): { lines: string[]; sent: Sent[]; restore(): void } {
  const lines: string[] = [];
  const sent: Sent[] = [];
  const previous = { debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  for (const method of ["debug", "info", "log", "warn", "error"] as const) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    sent.push({ url, init: init ?? {} });
    if (url !== "https://api.resend.com/emails") return original(input, init);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    lines,
    sent,
    restore() {
      Object.assign(console, previous);
      globalThis.fetch = original;
    },
  };
}

/** An environment over one database, varying only the mail fields and the base URL. */
function mailEnv(db: Env["DB"], fields: Partial<Env>, base: string = ORIGIN): Env {
  return {
    ASSETS: {
      async fetch() {
        return new Response("missing", { status: 500 });
      },
    },
    DB: db,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: AUTH_SECRET,
    ACCOUNTS: "on",
    ...fields,
  };
}

/**
 * The path Better Auth serves its routes under for a configured base URL: its
 * basePath when the URL is only an origin, and the URL's own pathname when it
 * carries one. The installed router reads the pathname of the resolved base
 * URL (better-auth's withPath keeps a pathname already present in the URL,
 * and api/index.mjs takes the router's basePath from new URL(baseURL).pathname).
 */
function authPrefix(baseURL: string): string {
  const pathname = new URL(baseURL).pathname;
  return pathname === "/" ? "/api/auth" : pathname.replace(/\/+$/, "");
}

/** Signs an owner in through the real magic-link flow and opens a workspace. */
async function session(base: string = ORIGIN): Promise<{ db: Env["DB"]; cookie: string; workspaceId: string }> {
  const db = database();
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, base);
  const origin = new URL(base).origin;
  const prefix = authPrefix(base);
  const recorded = record();
  try {
    const signIn = await call(`${origin}${prefix}/sign-in/magic-link`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": clientIp() },
      body: JSON.stringify({ email: OWNER, callbackURL: `${ORIGIN}/app/` }),
    });
    assert.equal(signIn.status, 200, await signIn.text());
    const link = recorded.lines
      .join("\n")
      .match(new RegExp(`http://127\\.0\\.0\\.1:8790${prefix.replaceAll("/", "\\/")}/magic-link/verify\\?\\S+`))?.[0];
    assert.ok(link, "the sign-in link was not written to the log");
    const verified = await call(link, env, { headers: { origin: ORIGIN, "x-forwarded-for": clientIp() } });
    assert.equal(verified.status, 302, await verified.text());
    const cookie = verified.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.notEqual(cookie, "", "the verification set no session cookie");
    const created = await call(`${origin}${prefix}/organization/create`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie, "x-forwarded-for": clientIp() },
      body: JSON.stringify({ name: "Mail test", slug: "mail-test" }),
    });
    const createdBody = await created.text();
    assert.equal(created.status, 200, createdBody);
    const workspaceId = (JSON.parse(createdBody) as { id: string }).id;
    await db
      .prepare("INSERT INTO subscription VALUES (?, 'sub_review', 'ctm_review', 'active', 'pri_review', 2, '2099-01-01T00:00:00Z', '2026-10-12T00:00:00Z')")
      .bind(workspaceId)
      .run();
    return { db, cookie, workspaceId };
  } finally {
    recorded.restore();
  }
}

async function invite(env: Env, cookie: string, workspaceId: string, body: Record<string, unknown>): Promise<Response> {
  const prefix = authPrefix(env.BETTER_AUTH_URL);
  return call(`${new URL(env.BETTER_AUTH_URL).origin}${prefix}/organization/invite-member`, env, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie, "x-forwarded-for": clientIp() },
    body: JSON.stringify({ email: INVITED, role: "member", organizationId: workspaceId, ...body }),
  });
}

async function invitationRow(db: Env["DB"]): Promise<{ count: number; expiresAt: string | Date } | null> {
  const row = await db.prepare("SELECT COUNT(*) AS count, MAX(expiresAt) AS expiresAt FROM invitation").first<{ count: number; expiresAt: string | Date }>();
  assert.ok(row);
  return row.count === 0 ? null : row;
}

async function verificationRows(db: Env["DB"]): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM verification").first<{ count: number }>();
  assert.ok(row);
  return row.count;
}

function assertNoAddressOrLink(lines: string[]): void {
  for (const line of lines) {
    assert.equal(line.includes(INVITED), false, `the log held the invited address: ${line}`);
    assert.equal(line.includes(OWNER), false, `the log held the inviter address: ${line}`);
    assert.equal(line.includes("invitation="), false, `the log held the invitation link: ${line}`);
  }
}

test("an invitation is refused when no email can be sent", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const recorded = record();
  let response: Response;
  try {
    response = await invite(env, cookie, workspaceId, {});
  } finally {
    recorded.restore();
  }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: EMAIL_NOT_SET_UP });
  assert.equal(await invitationRow(db), null, "the refused invitation wrote a row");
  assertNoAddressOrLink(recorded.lines);
  assert.deepEqual(
    recorded.sent.filter((entry) => entry.url === "https://api.resend.com/emails"),
    [],
  );
});

test("a resent invitation is refused and leaves the invitation row alone", async () => {
  const { db, cookie, workspaceId } = await session();
  const logged = mailEnv(db, { LOCAL_EMAIL_LOG: "on" });
  const first = await invite(logged, cookie, workspaceId, {});
  assert.equal(first.status, 200, await first.text());
  const before = await invitationRow(db);
  assert.ok(before);

  const env = mailEnv(db, {});
  const recorded = record();
  let response: Response;
  try {
    response = await invite(env, cookie, workspaceId, { resend: true });
  } finally {
    recorded.restore();
  }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: EMAIL_NOT_SET_UP });
  assert.deepEqual(await invitationRow(db), before, "the refused resend changed the invitation row");
  assertNoAddressOrLink(recorded.lines);
});

test("an invitation is logged when the local email log is exactly on", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" });
  const recorded = record();
  let sent: Response;
  try {
    sent = await invite(env, cookie, workspaceId, {});
  } finally {
    recorded.restore();
  }
  const body = await sent.text();
  assert.equal(sent.status, 200, body);
  assert.equal((JSON.parse(body) as { status: string }).status, "pending");
  assert.ok(await invitationRow(db), "the accepted invitation wrote no row");
  const mail = recorded.lines.filter((line) => line.includes("[email]"));
  assert.equal(mail.length, 1);
  assert.equal(mail[0].includes(`to ${INVITED}`), true, mail[0]);
  assert.equal(mail[0].includes("/app/?invitation="), true, mail[0]);
  assert.deepEqual(recorded.sent, []);
});

test("an invitation goes to the provider when a key and a sender are set", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "no-reply@example.invalid" });
  const recorded = record();
  let sent: Response;
  try {
    sent = await invite(env, cookie, workspaceId, {});
  } finally {
    recorded.restore();
  }
  const body = await sent.text();
  assert.equal(sent.status, 200, body);
  assert.equal(recorded.lines.length, 0, recorded.lines.join("\n"));
  assert.deepEqual(recorded.sent.map((entry) => entry.url), ["https://api.resend.com/emails"]);
  assert.deepEqual(recorded.sent[0].init.headers, { authorization: "Bearer re_test_key", "content-type": "application/json" });
  const mail = JSON.parse(String(recorded.sent[0].init.body)) as { from: string; to: string; text: string };
  assert.equal(mail.from, "no-reply@example.invalid");
  assert.equal(mail.to, INVITED);
  assert.equal(mail.text.includes("/app/?invitation="), true, mail.text);
  assert.ok(await invitationRow(db), "the accepted invitation wrote no row");
});

// Better Auth takes its base path from the pathname of BETTER_AUTH_URL when
// that value carries one, so the same two routes are served under it.
const ALTERNATE = "http://127.0.0.1:8790/api/auth/alternate";

test("an invitation is refused when the configured base path carries a path", async () => {
  const { db, cookie, workspaceId } = await session(ALTERNATE);
  const env = mailEnv(db, {}, ALTERNATE);
  const recorded = record();
  let response: Response;
  try {
    response = await invite(env, cookie, workspaceId, {});
  } finally {
    recorded.restore();
  }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: EMAIL_NOT_SET_UP });
  assert.equal(await invitationRow(db), null, "the refused invitation wrote a row");
  assert.deepEqual(recorded.lines, [], recorded.lines.join("\n"));
  assert.deepEqual(recorded.sent, []);
});

test("a resent invitation is refused under the moved route and leaves the row alone", async () => {
  const { db, cookie, workspaceId } = await session(ALTERNATE);
  const logged = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, ALTERNATE);
  const first = await invite(logged, cookie, workspaceId, {});
  assert.equal(first.status, 200, await first.text());
  const before = await invitationRow(db);
  assert.ok(before);

  const env = mailEnv(db, {}, ALTERNATE);
  const recorded = record();
  let response: Response;
  try {
    response = await invite(env, cookie, workspaceId, { resend: true });
  } finally {
    recorded.restore();
  }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: EMAIL_NOT_SET_UP });
  assert.deepEqual(await invitationRow(db), before, "the refused resend changed the invitation row");
  assert.deepEqual(recorded.lines, [], recorded.lines.join("\n"));
  assert.deepEqual(recorded.sent, []);
});

test("a sign-in on the moved route is refused and writes no verification row", async () => {
  const { db } = await session(ALTERNATE);
  const env = mailEnv(db, {}, ALTERNATE);
  const recorded = record();
  let response: Response;
  try {
    response = await call(`${ALTERNATE}/sign-in/magic-link`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": clientIp() },
      body: JSON.stringify({ email: OWNER, callbackURL: `${ORIGIN}/app/` }),
    });
  } finally {
    recorded.restore();
  }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: EMAIL_NOT_SET_UP });
  assert.equal(await verificationRows(db), 0, "the refused sign-in wrote a verification row");
  assert.deepEqual(recorded.lines, [], recorded.lines.join("\n"));
});

test("an invitation still succeeds under the moved route when the local email log is on", async () => {
  const { db, cookie, workspaceId } = await session(ALTERNATE);
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, ALTERNATE);
  const recorded = record();
  let sent: Response;
  try {
    sent = await invite(env, cookie, workspaceId, {});
  } finally {
    recorded.restore();
  }
  const body = await sent.text();
  assert.equal(sent.status, 200, body);
  assert.equal((JSON.parse(body) as { status: string }).status, "pending");
  assert.ok(await invitationRow(db), "the accepted invitation wrote no row");
  const mail = recorded.lines.filter((line) => line.includes("[email]"));
  assert.equal(mail.length, 1);
  assert.equal(mail[0].includes(`to ${INVITED}`), true, mail[0]);
  assert.equal(mail[0].includes("/app/?invitation="), true, mail[0]);
  assert.deepEqual(recorded.sent, []);
});
