import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import { EMAIL_NOT_SET_UP } from "../server/email.ts";
import type { Env } from "../server/env.ts";
import { SIGNATURE_TOLERANCE_SECONDS } from "../server/paddle.ts";
import { plan } from "../server/workspace.ts";
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
    { path: "/guide", referrer: "", views: 1 },
    { path: "/method", referrer: "", views: 1 },
    { path: "/price-volume-mix-analysis", referrer: "", views: 1 },
    { path: "/privacy", referrer: "", views: 1 },
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
  assert.deepEqual(await views(db), [{ path: "/method", referrer: "", views: 2 }]);
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
  assert.deepEqual(await views(db), [{ path: "/privacy", referrer: "", views: 1 }]);
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

test("a query string is kept on the asset request and the count stores /privacy", async () => {
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
  assert.deepEqual(await views(db), [{ path: "/privacy", referrer: "", views: 1 }]);
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

test("a signed-out setups list does not take column names", async () => {
  const { env } = bindings({ "/": html(HOME) }, database());
  const on = { ...env, BETTER_AUTH_SECRET: AUTH_SECRET, ACCOUNTS: "on" };
  const response = await call(`${ORIGIN}/api/workspaces/perf-local/setups?column=zephyr-column&column=quartz-column`, on);
  const body = await response.text();
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(body), { error: "Sign in first." });
  assert.equal(body.includes("zephyr-column"), false);
});

const SENTINEL = "zephyr-column";
const OLDER_KEY = "design|sales|units|year";
const NO_COLUMNS = { error: "This request does not take column names." };
const SIGN_IN_FIRST = { error: "Sign in first." };
const NOT_FOUND = { error: "Workspace not found." };
const SETUP_FULL = { error: "This workspace has 50 saved setups. Delete one to save another." };

const NEWER_SETUP = {
  periodColumn: "year",
  grain: "value",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Region", columns: ["region"] }],
  filters: [],
};
const OLDER_SETUP = {
  periodColumn: "year",
  grain: "value",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Design", columns: ["design"] }],
  filters: [],
};

const stored = [
  {
    id: "setup-newer",
    name: "Newer",
    setup: NEWER_SETUP,
    createdAt: "2026-10-04T01:00:00.000Z",
    columnsKey: "region|sales|units|year",
  },
  {
    id: "setup-older",
    name: "Older",
    setup: OLDER_SETUP,
    createdAt: "2026-10-04T00:00:00.000Z",
    columnsKey: OLDER_KEY,
  },
];
const listed = stored.map((row) => ({ ...row, createdBy: "Owner" }));

type ListedResponse = { status: number; body: unknown; echoed: boolean };

async function storeSetups(db: Env["DB"], workspaceId: string): Promise<string> {
  const owner = await db.prepare("SELECT id FROM user WHERE email = ?").bind(OWNER).first<{ id: string }>();
  assert.ok(owner);
  const renamed = await db.prepare("UPDATE user SET name = ? WHERE id = ?").bind("Owner", owner.id).run();
  assert.equal(renamed.meta.changes, 1);
  for (const row of stored) {
    await db
      .prepare(
        `INSERT INTO saved_setup (id, organizationId, name, columnsKey, setup, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, workspaceId, row.name, row.columnsKey, JSON.stringify(row.setup), owner.id, row.createdAt)
      .run();
  }
  return owner.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function savedId(body: unknown): string {
  assert.ok(isRecord(body));
  assert.deepEqual(Object.keys(body), ["id"]);
  const id = body.id;
  assert.equal(typeof id, "string");
  if (typeof id !== "string") throw new Error("saved setup id");
  return id;
}

function listedSetups(body: unknown): { id: string; name: string }[] {
  assert.ok(Array.isArray(body));
  return body.map((row) => {
    assert.ok(isRecord(row));
    const id = row.id;
    const name = row.name;
    assert.equal(typeof id, "string");
    assert.equal(typeof name, "string");
    if (typeof id !== "string" || typeof name !== "string") throw new Error("saved setup row");
    return { id, name };
  });
}

async function plantSetups(db: Env["DB"], workspaceId: string, count: number, start = 0): Promise<string[]> {
  const owner = await db.prepare("SELECT id FROM user WHERE email = ?").bind(OWNER).first<{ id: string }>();
  assert.ok(owner);
  const ids: string[] = [];
  for (let index = start; index < start + count; index++) {
    const id = `planted-${workspaceId}-${index}`;
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    await db
      .prepare(
        `INSERT INTO saved_setup (id, organizationId, name, columnsKey, setup, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, workspaceId, `Planted ${index}`, OLDER_KEY, JSON.stringify(OLDER_SETUP), owner.id, createdAt)
      .run();
    ids.push(id);
  }
  return ids;
}

async function secondWorkspace(db: Env["DB"]): Promise<string> {
  const owner = await db.prepare("SELECT id FROM user WHERE email = ?").bind(OWNER).first<{ id: string }>();
  assert.ok(owner);
  const id = "capped-workspace";
  const createdAt = "2026-10-04T03:00:00.000Z";
  await db
    .prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)")
    .bind(id, "Capped", "capped-workspace", createdAt)
    .run();
  await db
    .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)")
    .bind(`member-${id}`, id, owner.id, createdAt)
    .run();
  await db
    .prepare("INSERT INTO subscription VALUES (?, 'sub_review', 'ctm_review', 'active', 'pri_review', 2, '2099-01-01T00:00:00Z', '2026-10-12T00:00:00Z')")
    .bind(id)
    .run();
  return id;
}

function postSetup(env: Env, workspaceId: string, cookie: string, name: string): Promise<Response> {
  return call(`${ORIGIN}/api/workspaces/${workspaceId}/setups`, env, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      name,
      columns: ["year", "units", "sales", "design"],
      setup: OLDER_SETUP,
    }),
  });
}

function deleteSetup(env: Env, workspaceId: string, cookie: string, id: string): Promise<Response> {
  return call(`${ORIGIN}/api/workspaces/${workspaceId}/setups/${id}`, env, {
    method: "DELETE",
    headers: { cookie, origin: ORIGIN },
  });
}

async function readSetups(env: Env, workspaceId: string, cookie: string): Promise<{ id: string; name: string }[]> {
  const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/setups`, env, {
    headers: { cookie, origin: ORIGIN },
  });
  assert.equal(response.status, 200);
  return listedSetups(await response.json());
}

type OtherWorkspace = {
  id: string;
  slug: string;
  setupId: string;
  name: string;
  createdAt: string;
  member: boolean;
};

async function storeOtherWorkspace(db: Env["DB"], ownerId: string, row: OtherWorkspace): Promise<void> {
  await db
    .prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)")
    .bind(row.id, row.name, row.slug, row.createdAt)
    .run();
  if (row.member) {
    await db
      .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)")
      .bind(`member-${row.id}`, row.id, ownerId, row.createdAt)
      .run();
  }
  const membership = await db
    .prepare("SELECT COUNT(*) AS n FROM member WHERE organizationId = ? AND userId = ?")
    .bind(row.id, ownerId)
    .first<{ n: number }>();
  assert.equal(membership?.n, row.member ? 1 : 0);
  await db
    .prepare(
      `INSERT INTO saved_setup (id, organizationId, name, columnsKey, setup, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.setupId, row.id, row.name, OLDER_KEY, JSON.stringify(OLDER_SETUP), ownerId, row.createdAt)
    .run();
}

async function memberPair(env: Env, workspaceId: string, cookie: string): Promise<ListedResponse[]> {
  const pair: ListedResponse[] = [];
  for (const search of ["", `?column=${SENTINEL}`] as const) {
    const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/setups${search}`, env, {
      headers: { cookie, origin: ORIGIN },
    });
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    pair.push({ status: response.status, body, echoed: text.includes(SENTINEL) });
  }
  return pair;
}

test("a member receives every setup of the workspace, newest first, with each stored columns key", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const ownerId = await storeSetups(db, workspaceId);
  await storeOtherWorkspace(db, ownerId, {
    id: "foreign-workspace",
    slug: "foreign-workspace",
    setupId: "foreign-setup",
    name: "Foreign",
    createdAt: "2026-10-04T02:00:00.000Z",
    member: false,
  });
  await storeOtherWorkspace(db, ownerId, {
    id: "second-workspace",
    slug: "second-workspace",
    setupId: "second-setup",
    name: "Second",
    createdAt: "2026-10-04T03:00:00.000Z",
    member: true,
  });
  const headers = { cookie, origin: ORIGIN };
  const plain = await call(`${ORIGIN}/api/workspaces/${workspaceId}/setups`, env, { headers });
  const other = await call(`${ORIGIN}/api/workspaces/${workspaceId}/setups?columns=${SENTINEL}`, env, { headers });
  const otherText = await other.text();
  const otherBody: unknown = JSON.parse(otherText);
  assert.deepEqual(
    [
      { status: plain.status, body: await plain.json() },
      { status: other.status, body: otherBody, echoed: otherText.includes(SENTINEL) },
    ],
    [
      { status: 200, body: listed },
      { status: 200, body: listed, echoed: false },
    ],
  );
});

test("a member who sends column names is refused and the body does not echo them", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  await storeSetups(db, workspaceId);
  const columnQueries: {
    [K in "stored-set" | "unknown-name" | "bare"]: { search: string; echo: string | null };
  } = {
    "stored-set": { search: "?column=year&column=units&column=sales&column=design", echo: OLDER_KEY },
    "unknown-name": { search: `?column=${SENTINEL}`, echo: SENTINEL },
    bare: { search: "?column", echo: null },
  };
  const seen: ListedResponse[] = [];
  for (const query of Object.values(columnQueries)) {
    const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/setups${query.search}`, env, {
      headers: { cookie, origin: ORIGIN },
    });
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    seen.push({ status: response.status, body, echoed: query.echo !== null && text.includes(query.echo) });
  }
  assert.deepEqual(seen, [
    { status: 400, body: NO_COLUMNS, echoed: false },
    { status: 400, body: NO_COLUMNS, echoed: false },
    { status: 400, body: NO_COLUMNS, echoed: false },
  ]);
});

test("a signed-out caller is refused before column names are read", async () => {
  const { db, workspaceId } = await session();
  const env = mailEnv(db, {});
  await storeSetups(db, workspaceId);
  const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/setups?column=${SENTINEL}`, env);
  const text = await response.text();
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(text), SIGN_IN_FIRST);
  assert.equal(text.includes(SENTINEL), false);
});

test("a signed-in non-member is refused with and without a column query", async () => {
  const { db, workspaceId } = await session();
  const env = mailEnv(db, {});
  await storeSetups(db, workspaceId);
  const cookie = await signIn(db, "colleague@example.invalid");
  assert.deepEqual(await memberPair(env, workspaceId, cookie), [
    { status: 404, body: NOT_FOUND, echoed: false },
    { status: 404, body: NOT_FOUND, echoed: false },
  ]);
});

test("a member whose member row is then deleted is refused with and without a column query", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const ownerId = await storeSetups(db, workspaceId);
  const removed = await db.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").bind(workspaceId, ownerId).run();
  assert.equal(removed.meta.changes, 1);
  assert.deepEqual(await memberPair(env, workspaceId, cookie), [
    { status: 404, body: NOT_FOUND, echoed: false },
    { status: 404, body: NOT_FOUND, echoed: false },
  ]);
});

test("a workspace with 49 saved setups accepts one more and refuses the next", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  await plantSetups(db, workspaceId, 49);
  const first = await postSetup(env, workspaceId, cookie, "Fiftieth");
  assert.equal(first.status, 201);
  const firstId = savedId(await first.json());
  const second = await postSetup(env, workspaceId, cookie, "Fifty-first");
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), SETUP_FULL);
  const filled = await readSetups(env, workspaceId, cookie);
  assert.equal(filled.length, 50);
  assert.ok(filled.some((row) => row.id === firstId));
  const deleted = await deleteSetup(env, workspaceId, cookie, firstId);
  assert.equal(deleted.status, 204);
  const third = await postSetup(env, workspaceId, cookie, "Replacement");
  assert.equal(third.status, 201);
  const thirdId = savedId(await third.json());
  const after = await readSetups(env, workspaceId, cookie);
  assert.equal(after.length, 50);
  assert.equal(after.some((row) => row.id === firstId), false);
  assert.ok(after.some((row) => row.id === thirdId));
});

test("a save into 50 stored setups is refused, and rows already past 50 stay listed", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const planted = await plantSetups(db, workspaceId, 50);
  const atCap = await postSetup(env, workspaceId, cookie, "At the cap");
  assert.equal(atCap.status, 409);
  assert.deepEqual(await atCap.json(), SETUP_FULL);
  const extra = await plantSetups(db, workspaceId, 1, 50);
  const stored = [...planted, ...extra];
  const before = await readSetups(env, workspaceId, cookie);
  assert.equal(before.length, 51);
  assert.deepEqual(before.map((row) => row.id).toSorted(), stored.toSorted());
  const refused = await postSetup(env, workspaceId, cookie, "One more");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), SETUP_FULL);
  const after = await readSetups(env, workspaceId, cookie);
  assert.equal(after.length, 51);
  assert.deepEqual(after.map((row) => row.id).toSorted(), stored.toSorted());
});

test("deleting one of 51 saved setups still leaves the next save refused", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const planted = await plantSetups(db, workspaceId, 51);
  const deleted = await deleteSetup(env, workspaceId, cookie, planted[0]);
  assert.equal(deleted.status, 204);
  const refused = await postSetup(env, workspaceId, cookie, "After delete");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), SETUP_FULL);
  const rows = await readSetups(env, workspaceId, cookie);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map((row) => row.id).toSorted(), planted.slice(1).toSorted());
});

test("fifty saved setups block only the workspace that holds them", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const second = await secondWorkspace(db);
  const planted = await plantSetups(db, second, 50);
  const saved = await postSetup(env, workspaceId, cookie, "In the first");
  assert.equal(saved.status, 201);
  const savedRow = savedId(await saved.json());
  const open = await readSetups(env, workspaceId, cookie);
  assert.deepEqual(open.map((row) => row.id), [savedRow]);
  const refused = await postSetup(env, second, cookie, "In the second");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), SETUP_FULL);
  const rows = await readSetups(env, second, cookie);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map((row) => row.id).toSorted(), planted.toSorted());
});

test("two saves sent together when 49 setups are stored keep one", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  await plantSetups(db, workspaceId, 49);
  const [north, south] = await Promise.all([
    postSetup(env, workspaceId, cookie, "Posted north"),
    postSetup(env, workspaceId, cookie, "Posted south"),
  ]);
  const outcomes = [
    { status: north.status, body: await north.json() },
    { status: south.status, body: await south.json() },
  ].toSorted((left, right) => left.status - right.status);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    [201, 409],
  );
  assert.deepEqual(outcomes[1]?.body, SETUP_FULL);
  savedId(outcomes[0]?.body);
  const rows = await readSetups(env, workspaceId, cookie);
  assert.equal(rows.length, 50);
  const posted = rows.filter((row) => row.name === "Posted north" || row.name === "Posted south");
  assert.equal(posted.length, 1);
});

test("a full workspace without a subscription answers 402, and 409 once Pro returns", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const planted = await plantSetups(db, workspaceId, 50);
  const removed = await db.prepare("DELETE FROM subscription WHERE organizationId = ?").bind(workspaceId).run();
  assert.equal(removed.meta.changes, 1);
  const needsPro = await postSetup(env, workspaceId, cookie, "Needs Pro");
  assert.equal(needsPro.status, 402);
  assert.deepEqual(await needsPro.json(), { error: "Saving to a workspace needs a Pro subscription." });
  await db
    .prepare("INSERT INTO subscription VALUES (?, 'sub_review', 'ctm_review', 'active', 'pri_review', 2, '2099-01-01T00:00:00Z', '2026-10-12T00:00:00Z')")
    .bind(workspaceId)
    .run();
  const refused = await postSetup(env, workspaceId, cookie, "After Pro");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), SETUP_FULL);
  const rows = await readSetups(env, workspaceId, cookie);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map((row) => row.id).toSorted(), planted.toSorted());
});

test("a full workspace refuses an empty name, then refuses a named save", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, {});
  const planted = await plantSetups(db, workspaceId, 50);
  const empty = await postSetup(env, workspaceId, cookie, "");
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "Give the setup a name of up to 120 characters." });
  const refused = await postSetup(env, workspaceId, cookie, "Named");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), SETUP_FULL);
  const rows = await readSetups(env, workspaceId, cookie);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map((row) => row.id).toSorted(), planted.toSorted());
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

const WEBHOOK_SECRET = "paddle-test-secret";

function paddleSignature(body: string, secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)): string {
  const hex = createHmac("sha256", secret).update(`${at}:${body}`).digest("hex");
  return `ts=${at};h1=${hex}`;
}

test("a signed webhook body that is not JSON is refused as invalid JSON", async () => {
  const { env } = bindings({ "/": html(HOME) }, database());
  const on = { ...env, BETTER_AUTH_SECRET: AUTH_SECRET, ACCOUNTS: "on", PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const body = "not-json";
  const signed = await call(`${ORIGIN}/api/paddle/webhook`, on, {
    method: "POST",
    headers: { "paddle-signature": paddleSignature(body) },
    body,
  });
  assert.equal(signed.status, 400);
  assert.deepEqual(await signed.json(), { error: "The request was not valid JSON." });

  const unsigned = await call(`${ORIGIN}/api/paddle/webhook`, on, { method: "POST", body });
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "Bad signature." });

  const wrong = await call(`${ORIGIN}/api/paddle/webhook`, on, {
    method: "POST",
    headers: { "paddle-signature": paddleSignature(body, "other-secret") },
    body,
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "Bad signature." });

  const ignored = await call(`${ORIGIN}/api/paddle/webhook`, on, {
    method: "POST",
    headers: { "paddle-signature": paddleSignature("{}") },
    body: "{}",
  });
  assert.equal(ignored.status, 200);
  assert.deepEqual(await ignored.json(), { result: "ignored" });
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

const CHECKOUT_URL = "https://pay.example.com/checkout?_ptxn=txn_test";

function installPaddleFetch(): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Request | string | URL) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    calls.push(url);
    const host = new URL(url).hostname;
    if (host === "sandbox-api.paddle.com" || host === "api.paddle.com") {
      return Response.json({ data: { id: "txn_test", checkout: { url: CHECKOUT_URL } } }, { status: 201 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function paddleCallCount(calls: readonly string[]): number {
  return calls.filter((url) => {
    const host = new URL(url).hostname;
    return host === "sandbox-api.paddle.com" || host === "api.paddle.com";
  }).length;
}

function checkoutEnv(db: Env["DB"], fields: Partial<Env> = { PADDLE_API_KEY: "pdl_test_key", PADDLE_PRICE_ID: "pri_review" }): Env {
  return mailEnv(db, fields);
}

async function subscriptionRow(db: Env["DB"], workspaceId: string) {
  return db
    .prepare("SELECT paddleSubscriptionId, status, currentPeriodEnd FROM subscription WHERE organizationId = ?")
    .bind(workspaceId)
    .first<{ paddleSubscriptionId: string; status: string; currentPeriodEnd: string | null }>();
}

async function postCheckout(env: Env, workspaceId: string, cookie?: string): Promise<{ status: number; body: unknown; paddleCalls: number }> {
  const recorded = installPaddleFetch();
  try {
    const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
    if (cookie !== undefined) headers.cookie = cookie;
    const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/checkout`, env, {
      method: "POST",
      headers,
      body: JSON.stringify({ seats: 1 }),
    });
    return { status: response.status, body: await response.json(), paddleCalls: paddleCallCount(recorded.calls) };
  } finally {
    recorded.restore();
  }
}

async function signIn(db: Env["DB"], email: string, base: string = ORIGIN): Promise<string> {
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, base);
  const origin = new URL(base).origin;
  const prefix = authPrefix(base);
  const recorded = record();
  try {
    const started = await call(`${origin}${prefix}/sign-in/magic-link`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": clientIp() },
      body: JSON.stringify({ email, callbackURL: `${ORIGIN}/app/` }),
    });
    assert.equal(started.status, 200, await started.text());
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
    return cookie;
  } finally {
    recorded.restore();
  }
}

const PADDLE_CUSTOMER = "ctm_review";
const SEAT_PRICE = "pri_review";

type PaddleEntity = {
  id: string;
  status: string;
  customer_id: string;
  items: { price: { id: string }; quantity: number }[];
  custom_data: { workspace_id: string };
  current_billing_period: { starts_at: string; ends_at: string | null } | null;
  created_at: string;
};

function paddleEntity(workspaceId: string, fields: Partial<PaddleEntity> & { id: string }): PaddleEntity {
  return {
    status: "active",
    customer_id: PADDLE_CUSTOMER,
    items: [{ price: { id: SEAT_PRICE }, quantity: 2 }],
    custom_data: { workspace_id: workspaceId },
    current_billing_period: { starts_at: "2026-10-12T00:00:00Z", ends_at: "2099-01-01T00:00:00Z" },
    created_at: "2026-10-12T00:00:00Z",
    ...fields,
  };
}

type PaddleFake = {
  subscriptions: PaddleEntity[];
  down: boolean;
  reads: string[];
  restore(): void;
};

/** Answers Paddle's subscription list from `subscriptions`, and nothing else. */
function installPaddleSubscriptions(subscriptions: PaddleEntity[]): PaddleFake {
  const original = globalThis.fetch;
  const fake: PaddleFake = {
    subscriptions,
    down: false,
    reads: [],
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://sandbox-api.paddle.com/subscriptions", url);
    assert.equal(input instanceof Request ? input.method : (init?.method ?? "GET"), "GET", url);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer pdl_test_key", url);
    assert.equal(headers.get("paddle-version"), "1", url);
    fake.reads.push(url);
    if (fake.down) return new Response("{}", { status: 500 });
    const customerIds = (parsed.searchParams.get("customer_id") ?? "").split(",").filter(Boolean);
    const data = fake.subscriptions.filter((subscription) => customerIds.includes(subscription.customer_id));
    return Response.json({ data, meta: { pagination: { has_more: false } } });
  };
  return fake;
}

function webhookBody(
  workspaceId: string,
  fields: {
    id: string;
    status: string;
    occurredAt: string;
    eventId: string;
    eventType?: string;
    periodEnd?: string | null;
  },
): string {
  const periodEnd = fields.periodEnd === undefined ? "2099-01-01T00:00:00Z" : fields.periodEnd;
  return JSON.stringify({
    event_id: fields.eventId,
    event_type: fields.eventType ?? "subscription.updated",
    occurred_at: fields.occurredAt,
    notification_id: "ntf_route",
    data: {
      id: fields.id,
      status: fields.status,
      customer_id: PADDLE_CUSTOMER,
      items: [{ price: { id: SEAT_PRICE }, quantity: 2 }],
      custom_data: { workspace_id: workspaceId },
      current_billing_period: periodEnd === null ? null : { starts_at: "2026-10-12T00:00:00Z", ends_at: periodEnd },
      scheduled_change: null,
    },
  });
}

async function postWebhook(
  db: Env["DB"],
  body: string,
  options: { fields?: Partial<Env>; signedAt?: number } = {},
): Promise<Response> {
  const env = mailEnv(db, {
    PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PADDLE_PRICE_ID: SEAT_PRICE,
    PADDLE_API_KEY: "pdl_test_key",
    ...options.fields,
  });
  return call(`${ORIGIN}/api/paddle/webhook`, env, {
    method: "POST",
    headers: { "paddle-signature": paddleSignature(body, WEBHOOK_SECRET, options.signedAt) },
    body,
  });
}

async function subscriptionColumns(db: Env["DB"], workspaceId: string) {
  return db
    .prepare(
      `SELECT paddleSubscriptionId, paddleCustomerId, status, priceId, seats, currentPeriodEnd, lastEventAt
       FROM subscription WHERE organizationId = ?`,
    )
    .bind(workspaceId)
    .first<{
      paddleSubscriptionId: string;
      paddleCustomerId: string;
      status: string;
      priceId: string;
      seats: number;
      currentPeriodEnd: string | null;
      lastEventAt: string;
    }>();
}

test("a webhook for a different subscription id replaces the stored row when Paddle reports that subscription", async () => {
  const { db, workspaceId } = await session();
  const paddle = installPaddleSubscriptions([paddleEntity(workspaceId, { id: "sub_other" })]);
  try {
    const body = webhookBody(workspaceId, {
      id: "sub_other",
      status: "active",
      occurredAt: "2026-10-13T00:00:00.000000Z",
      eventId: "evt_other",
    });
    const response = await postWebhook(db, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: "applied" });
    const row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_other");
    assert.equal(row?.status, "active");
    assert.equal((await plan(db, workspaceId)).pro, true);
  } finally {
    paddle.restore();
  }
});

test("a webhook for the same subscription id can mark it past_due", async () => {
  const { db, workspaceId } = await session();
  const paddle = installPaddleSubscriptions([paddleEntity(workspaceId, { id: "sub_review", status: "past_due" })]);
  try {
    const body = webhookBody(workspaceId, {
      id: "sub_review",
      status: "past_due",
      occurredAt: "2026-10-13T00:00:00.000000Z",
      eventId: "evt_due",
    });
    const response = await postWebhook(db, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: "applied" });
    const row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_review");
    assert.equal(row?.status, "past_due");
    assert.equal((await plan(db, workspaceId)).pro, true);
  } finally {
    paddle.restore();
  }
});

test("a late event for an old subscription does not replace the paying row", async () => {
  const { db, workspaceId } = await session();
  const paddle = installPaddleSubscriptions([
    paddleEntity(workspaceId, { id: "sub_review" }),
    paddleEntity(workspaceId, { id: "sub_old", status: "canceled", current_billing_period: null, created_at: "2026-01-01T00:00:00Z" }),
  ]);
  try {
    const body = webhookBody(workspaceId, {
      id: "sub_old",
      status: "canceled",
      eventType: "subscription.canceled",
      periodEnd: null,
      occurredAt: "2026-10-20T00:00:09.000000Z",
      eventId: "evt_old_cancel",
    });
    const response = await postWebhook(db, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: "applied" });
    const row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_review");
    assert.equal(row?.status, "active");
    assert.equal((await plan(db, workspaceId)).pro, true);
  } finally {
    paddle.restore();
  }
});

test("the newest paid subscription wins whichever event arrives last, and the older one takes over on cancel", async () => {
  const { db, workspaceId } = await session();
  const older = paddleEntity(workspaceId, { id: "sub_review", created_at: "2026-10-12T00:00:00Z" });
  const newer = paddleEntity(workspaceId, {
    id: "sub_b",
    items: [{ price: { id: SEAT_PRICE }, quantity: 5 }],
    created_at: "2026-10-13T00:00:00Z",
  });
  const paddle = installPaddleSubscriptions([older, newer]);
  try {
    const created = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_b",
        status: "active",
        eventType: "subscription.created",
        occurredAt: "2026-10-19T00:00:03.000000Z",
        eventId: "evt_b_created",
      }),
    );
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { result: "applied" });

    const renewal = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_review",
        status: "active",
        occurredAt: "2026-10-19T00:00:04.000000Z",
        eventId: "evt_review_update",
      }),
    );
    assert.equal(renewal.status, 200);
    let row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_b");
    assert.equal(row?.seats, 5);
    assert.equal((await plan(db, workspaceId)).pro, true);

    newer.status = "canceled";
    newer.current_billing_period = null;
    const canceled = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_b",
        status: "canceled",
        eventType: "subscription.canceled",
        periodEnd: null,
        occurredAt: "2026-10-19T00:00:05.000000Z",
        eventId: "evt_b_cancel",
      }),
    );
    assert.equal(canceled.status, 200);
    row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_review");
    assert.equal(row?.status, "active");
    assert.equal((await plan(db, workspaceId)).pro, true);
  } finally {
    paddle.restore();
  }
});

test("out-of-order events end at Paddle's state", async () => {
  const { db, workspaceId } = await session();
  const paddle = installPaddleSubscriptions([
    paddleEntity(workspaceId, {
      id: "sub_review",
      status: "canceled",
      current_billing_period: null,
      created_at: "2026-01-01T00:00:00Z",
    }),
    paddleEntity(workspaceId, { id: "sub_new", created_at: "2026-10-18T00:00:00Z" }),
  ]);
  try {
    const cancel = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_review",
        status: "canceled",
        eventType: "subscription.canceled",
        periodEnd: null,
        occurredAt: "2026-10-20T00:00:01.000000Z",
        eventId: "evt_old_cancel",
      }),
    );
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { result: "applied" });
    let row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_new");
    assert.equal(row?.status, "active");
    assert.equal((await plan(db, workspaceId)).pro, true);

    const created = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_new",
        status: "active",
        eventType: "subscription.created",
        occurredAt: "2026-10-20T00:00:02.000000Z",
        eventId: "evt_new_created",
      }),
    );
    assert.equal(created.status, 200);
    row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_new");
    assert.equal(row?.status, "active");
    assert.equal((await plan(db, workspaceId)).pro, true);
  } finally {
    paddle.restore();
  }
});

test("the D47 review 1 sequence keeps the new paid row", async () => {
  const { db, workspaceId } = await session();
  await db.prepare("DELETE FROM subscription WHERE organizationId = ?").bind(workspaceId).run();
  const paddle = installPaddleSubscriptions([
    paddleEntity(workspaceId, {
      id: "sub_old",
      status: "canceled",
      current_billing_period: null,
      created_at: "2026-10-01T00:00:00Z",
    }),
    paddleEntity(workspaceId, { id: "sub_new", created_at: "2026-10-01T00:00:03Z" }),
  ]);
  try {
    // Already passing at 187568f; kept to pin the D47 head regression.
    const deliveries = [
      webhookBody(workspaceId, { id: "sub_old", status: "active", occurredAt: "2026-10-01T00:00:01.000000Z", eventId: "evt_old_active" }),
      webhookBody(workspaceId, {
        id: "sub_new",
        status: "active",
        eventType: "subscription.created",
        occurredAt: "2026-10-01T00:00:03.000000Z",
        eventId: "evt_new_created",
      }),
      webhookBody(workspaceId, {
        id: "sub_new",
        status: "active",
        eventType: "subscription.activated",
        occurredAt: "2026-10-01T00:00:04.000000Z",
        eventId: "evt_new_activated",
      }),
      webhookBody(workspaceId, {
        id: "sub_old",
        status: "canceled",
        eventType: "subscription.canceled",
        periodEnd: null,
        occurredAt: "2026-10-01T00:00:02.000000Z",
        eventId: "evt_old_canceled",
      }),
    ];
    for (const body of deliveries) {
      const response = await postWebhook(db, body);
      assert.equal(response.status, 200);
    }
    const row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_new");
    assert.equal(row?.status, "active");
    assert.equal((await plan(db, workspaceId)).pro, true);
  } finally {
    paddle.restore();
  }
});

test("a Paddle read failure answers 502 with the row untouched, and a retry applies", async () => {
  const { db, workspaceId } = await session();
  const before = await subscriptionColumns(db, workspaceId);
  const paddle = installPaddleSubscriptions([
    paddleEntity(workspaceId, { id: "sub_review", status: "past_due", items: [{ price: { id: SEAT_PRICE }, quantity: 3 }] }),
  ]);
  try {
    paddle.down = true;
    const body = webhookBody(workspaceId, {
      id: "sub_review",
      status: "past_due",
      occurredAt: "2026-10-20T00:00:00.000000Z",
      eventId: "evt_down",
    });
    const failed = await postWebhook(db, body);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "Could not read the subscription from Paddle." });
    assert.equal(paddle.reads.length, 1);
    assert.deepEqual(await subscriptionColumns(db, workspaceId), before);

    paddle.down = false;
    const retried = await postWebhook(db, body);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { result: "applied" });
    const row = await subscriptionColumns(db, workspaceId);
    assert.equal(row?.paddleSubscriptionId, "sub_review");
    assert.equal(row?.status, "past_due");
    assert.equal(row?.seats, 3);
  } finally {
    paddle.restore();
  }
});

test("an event for a subscription Paddle does not list answers 502 and leaves the row unchanged", async () => {
  const { db, workspaceId } = await session();
  const before = await subscriptionColumns(db, workspaceId);
  const paddle = installPaddleSubscriptions([paddleEntity(workspaceId, { id: "sub_review" })]);
  try {
    const response = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_ghost",
        status: "active",
        occurredAt: "2026-10-20T00:00:00.000000Z",
        eventId: "evt_ghost",
      }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Could not read the subscription from Paddle." });
    assert.equal(paddle.reads.length, 1);
    assert.deepEqual(await subscriptionColumns(db, workspaceId), before);
  } finally {
    paddle.restore();
  }
});

test("a repeated delivery applies both times and leaves the state columns identical", async () => {
  const { db, workspaceId } = await session();
  const paddle = installPaddleSubscriptions([
    paddleEntity(workspaceId, { id: "sub_review", items: [{ price: { id: SEAT_PRICE }, quantity: 4 }] }),
  ]);
  try {
    const body = webhookBody(workspaceId, {
      id: "sub_review",
      status: "active",
      occurredAt: "2026-10-20T00:00:00.000000Z",
      eventId: "evt_repeat",
    });
    const first = await postWebhook(db, body);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { result: "applied" });
    const before = await subscriptionColumns(db, workspaceId);
    assert.ok(before);
    // The row only moves forward on a strictly newer write instant, so keep
    // the two deliveries in different milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await postWebhook(db, body);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { result: "applied" });
    const after = await subscriptionColumns(db, workspaceId);
    assert.ok(after);
    const state = ({ paddleSubscriptionId, paddleCustomerId, status, priceId, seats, currentPeriodEnd }: typeof before) => ({
      paddleSubscriptionId,
      paddleCustomerId,
      status,
      priceId,
      seats,
      currentPeriodEnd,
    });
    assert.deepEqual(state(after), state(before));
    assert.equal(paddle.reads.length, 2);
  } finally {
    paddle.restore();
  }
});

test("a subscription webhook without a Paddle key answers 503 and reads nothing", async () => {
  const { db, workspaceId } = await session();
  const before = await subscriptionColumns(db, workspaceId);
  const paddle = installPaddleSubscriptions([paddleEntity(workspaceId, { id: "sub_review", status: "past_due" })]);
  try {
    const response = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_review",
        status: "past_due",
        occurredAt: "2026-10-20T00:00:00.000000Z",
        eventId: "evt_no_key",
      }),
      { fields: { PADDLE_API_KEY: undefined } },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Subscriptions are not set up yet." });
    assert.deepEqual(paddle.reads, []);
    assert.deepEqual(await subscriptionColumns(db, workspaceId), before);
  } finally {
    paddle.restore();
  }
});

test("a retry signed two hours ago applies, and a replay older than the window is refused", async () => {
  const { db, workspaceId } = await session();
  const paddle = installPaddleSubscriptions([
    paddleEntity(workspaceId, { id: "sub_review", items: [{ price: { id: SEAT_PRICE }, quantity: 4 }] }),
  ]);
  try {
    const now = Math.floor(Date.now() / 1000);
    const retry = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_review",
        status: "active",
        occurredAt: "2026-10-20T00:00:00.000000Z",
        eventId: "evt_retry",
      }),
      { signedAt: now - 7200 },
    );
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { result: "applied" });
    assert.equal(paddle.reads.length, 1);

    const before = await subscriptionColumns(db, workspaceId);
    const replay = await postWebhook(
      db,
      webhookBody(workspaceId, {
        id: "sub_review",
        status: "past_due",
        occurredAt: "2026-10-20T00:00:01.000000Z",
        eventId: "evt_replay",
      }),
      { signedAt: now - SIGNATURE_TOLERANCE_SECONDS - 1 },
    );
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { error: "Bad signature." });
    assert.equal(paddle.reads.length, 1);
    assert.deepEqual(await subscriptionColumns(db, workspaceId), before);
  } finally {
    paddle.restore();
  }
});

for (const status of ["active", "trialing", "past_due", "paused"] as const) {
  test(`an owner cannot open a second checkout while the subscription is ${status}`, async () => {
    const { db, cookie, workspaceId } = await session();
    const updated = await db.prepare("UPDATE subscription SET status = ? WHERE organizationId = ?").bind(status, workspaceId).run();
    assert.equal(updated.meta.changes, 1);
    const before = await subscriptionRow(db, workspaceId);
    const result = await postCheckout(checkoutEnv(db), workspaceId, cookie);
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { error: "This workspace already has a subscription." });
    assert.equal(result.paddleCalls, 0);
    assert.deepEqual(await subscriptionRow(db, workspaceId), before);
  });
}

test("an owner with no subscription row can open a checkout", async () => {
  const { db, cookie, workspaceId } = await session();
  const removed = await db.prepare("DELETE FROM subscription WHERE organizationId = ?").bind(workspaceId).run();
  assert.equal(removed.meta.changes, 1);
  assert.equal(await subscriptionRow(db, workspaceId), null);
  const result = await postCheckout(checkoutEnv(db), workspaceId, cookie);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { checkoutUrl: CHECKOUT_URL });
  assert.equal(result.paddleCalls, 1);
  assert.equal(await subscriptionRow(db, workspaceId), null);
});

test("an owner cannot open a second checkout when the subscription is canceled and the period has not ended", async () => {
  const { db, cookie, workspaceId } = await session();
  const updated = await db.prepare("UPDATE subscription SET status = 'canceled' WHERE organizationId = ?").bind(workspaceId).run();
  assert.equal(updated.meta.changes, 1);
  const before = await subscriptionRow(db, workspaceId);
  assert.equal(before?.status, "canceled");
  assert.equal(before?.currentPeriodEnd, "2099-01-01T00:00:00Z");
  const result = await postCheckout(checkoutEnv(db), workspaceId, cookie);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "This workspace already has a subscription." });
  assert.equal(result.paddleCalls, 0);
  assert.deepEqual(await subscriptionRow(db, workspaceId), before);
});

test("a checkout without a session cookie is refused before Paddle", async () => {
  const { db, workspaceId } = await session();
  const before = await subscriptionRow(db, workspaceId);
  const result = await postCheckout(checkoutEnv(db), workspaceId);
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: "Sign in first." });
  assert.equal(result.paddleCalls, 0);
  assert.deepEqual(await subscriptionRow(db, workspaceId), before);
});

test("a signed-in member who is not an owner or admin cannot subscribe", async () => {
  const { db, workspaceId } = await session();
  const cookie = await signIn(db, "colleague@example.invalid");
  const user = await db.prepare("SELECT id FROM user WHERE email = ?").bind("colleague@example.invalid").first<{ id: string }>();
  assert.ok(user);
  await db
    .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)")
    .bind("member-colleague", workspaceId, user.id, "2026-10-12T00:00:00.000Z")
    .run();
  const before = await subscriptionRow(db, workspaceId);
  const result = await postCheckout(checkoutEnv(db), workspaceId, cookie);
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: "Only a workspace owner or admin can subscribe." });
  assert.equal(result.paddleCalls, 0);
  assert.deepEqual(await subscriptionRow(db, workspaceId), before);
});

test("an owner with a live subscription and no Paddle key is told subscriptions are not set up", async () => {
  const { db, cookie, workspaceId } = await session();
  const before = await subscriptionRow(db, workspaceId);
  assert.equal(before?.status, "active");
  const result = await postCheckout(checkoutEnv(db, { PADDLE_PRICE_ID: "pri_review" }), workspaceId, cookie);
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "Subscriptions are not set up yet." });
  assert.equal(result.paddleCalls, 0);
  assert.deepEqual(await subscriptionRow(db, workspaceId), before);
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
