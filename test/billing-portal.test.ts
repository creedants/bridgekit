import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { hasManageBilling, pollForPro } from "../src/app/account.ts";
import { testDatabase } from "./support/d1.ts";

const ORIGIN = "http://127.0.0.1:8790";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const OWNER = "owner@example.invalid";

let clients = 0;
function clientIp(): string {
  clients += 1;
  return `203.0.113.${(clients % 254) + 1}`;
}

function record(): { lines: string[]; sent: { url: string; init: RequestInit }[]; restore(): void } {
  const lines: string[] = [];
  const sent: { url: string; init: RequestInit }[] = [];
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

function database(): Env["DB"] {
  const db = testDatabase();
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    exec: (sql) => db.exec(sql),
  };
}

function mailEnv(db: Env["DB"], fields: Partial<Env> = {}, base: string = ORIGIN): Env {
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

function authPrefix(baseURL: string): string {
  const pathname = new URL(baseURL).pathname;
  return pathname === "/" ? "/api/auth" : pathname.replace(/\/+$/, "");
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

async function session(base: string = ORIGIN): Promise<{ db: Env["DB"]; cookie: string; workspaceId: string }> {
  const db = database();
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, base);
  const origin = new URL(base).origin;
  const prefix = authPrefix(base);
  const recorded = record();
  try {
    const signInRes = await call(`${origin}${prefix}/sign-in/magic-link`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": clientIp() },
      body: JSON.stringify({ email: OWNER, callbackURL: `${ORIGIN}/app/` }),
    });
    assert.equal(signInRes.status, 200, await signInRes.text());
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
      body: JSON.stringify({ name: "Portal test", slug: "portal-test" }),
    });
    const createdBody = await created.text();
    assert.equal(created.status, 200, createdBody);
    const workspaceId = (JSON.parse(createdBody) as { id: string }).id;
    await db
      .prepare("INSERT INTO subscription VALUES (?, 'sub_portal', 'ctm_portal', 'active', 'pri_portal', 2, '2099-01-01T00:00:00Z', '2026-10-12T00:00:00Z')")
      .bind(workspaceId)
      .run();
    return { db, cookie, workspaceId };
  } finally {
    recorded.restore();
  }
}

const PORTAL_URL = "https://paddle.com/portal/session-1";

function installPortalFetch(mode: "ok" | "fail" | "no-url" = "ok"): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    calls.push(url);
    if (url.includes("/portal-sessions")) {
      if (mode === "fail") return new Response("{}", { status: 500 });
      if (mode === "no-url") return Response.json({ data: { id: "pstl_1" } });
      return Response.json({ data: { id: "pstl_1", url: PORTAL_URL } });
    }
    return original(input, init);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function postPortal(env: Env, workspaceId: string, cookie?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookie !== undefined) headers.cookie = cookie;
  const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/portal`, env, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  return { status: response.status, body: await response.json() };
}

test("an owner of a workspace with a subscription gets a portal URL", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  const portal = installPortalFetch("ok");
  try {
    const result = await postPortal(env, workspaceId, cookie);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { portalUrl: PORTAL_URL });
    assert.equal(portal.calls.filter((url) => url.includes("/portal-sessions")).length, 1);
    assert.ok(portal.calls[0].includes("/customers/ctm_portal/portal-sessions"));
  } finally {
    portal.restore();
  }
});

test("a signed-in member who is not an owner or admin is refused a portal URL", async () => {
  const { db, cookie, workspaceId } = await session();
  void cookie;
  const memberCookie = await signIn(db, "colleague@example.invalid");
  const user = await db.prepare("SELECT id FROM user WHERE email = ?").bind("colleague@example.invalid").first<{ id: string }>();
  assert.ok(user);
  await db
    .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)")
    .bind("member-colleague", workspaceId, user.id, "2026-10-12T00:00:00.000Z")
    .run();
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  const portal = installPortalFetch("ok");
  try {
    const before = portal.calls.length;
    const result = await postPortal(env, workspaceId, memberCookie);
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: "Only a workspace owner or admin can subscribe." });
    assert.equal(portal.calls.length, before);
  } finally {
    portal.restore();
  }
});

test("a workspace with no subscription is refused a portal URL", async () => {
  const { db, cookie, workspaceId } = await session();
  const removed = await db.prepare("DELETE FROM subscription WHERE organizationId = ?").bind(workspaceId).run();
  assert.equal(removed.meta.changes, 1);
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  const portal = installPortalFetch("ok");
  try {
    const before = portal.calls.length;
    const result = await postPortal(env, workspaceId, cookie);
    assert.equal(result.status, 404);
    assert.equal(portal.calls.length, before);
  } finally {
    portal.restore();
  }
});

test("a Paddle failure gives a plain error and no crash", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  for (const mode of ["fail", "no-url"] as const) {
    const portal = installPortalFetch(mode);
    try {
      const result = await postPortal(env, workspaceId, cookie);
      assert.equal(result.status, 502);
      assert.deepEqual(result.body, { error: "Could not open the billing portal. Try again." });
    } finally {
      portal.restore();
    }
  }
});

test("a second checkout for a canceled workspace with paid time left is refused", async () => {
  const { db, cookie, workspaceId } = await session();
  const updated = await db.prepare("UPDATE subscription SET status = 'canceled' WHERE organizationId = ?").bind(workspaceId).run();
  assert.equal(updated.meta.changes, 1);
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    calls.push(url);
    return Response.json({ data: { id: "txn_test", checkout: { url: "https://pay.example.com/checkout?_ptxn=txn_test" } } }, { status: 201 });
  }) as typeof fetch;
  try {
    const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key", PADDLE_PRICE_ID: "pri_portal" });
    const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/checkout`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie },
      body: JSON.stringify({ seats: 1 }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "This workspace already has a subscription." });
    assert.equal(calls.filter((url) => url.includes("paddle.com")).length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("the panel offers Manage billing for live states and Subscribe only with no row", () => {
  const live: [string, boolean][] = [
    ["active", true],
    ["trialing", true],
    ["past_due", true],
    ["paused", false],
    ["canceled", true],
  ];
  for (const [status, pro] of live) {
    if (status === "canceled" && !pro) continue;
    assert.equal(hasManageBilling(status, pro), true, `${status} pro=${pro}`);
  }
  assert.equal(hasManageBilling("paused", false), true);
  assert.equal(hasManageBilling(null, false), false);
  assert.equal(hasManageBilling("canceled", false), false);
});

test("the paused sentence shows only when paused", () => {
  const isPaused = (status: string | null) => status === "paused";
  assert.equal(isPaused("paused"), true);
  for (const status of ["active", "past_due", "canceled", null]) {
    assert.equal(isPaused(status), false, String(status));
  }
});

test("the checkout return polls every 3 s for up to 90 s and stops when Pro is on", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    let reads = 0;
    const getPlan = async () => {
      reads += 1;
      return { role: "owner", plan: { pro: reads >= 3, status: reads >= 3 ? "active" : "past_due", seats: 1, currentPeriodEnd: null } };
    };
    let done: { role: string; plan: { pro: boolean } } | null = null;
    const stop = pollForPro("w1", (found) => {
      done = found;
    }, { getPlan: getPlan as never });
    assert.equal(reads, 0);
    await mock.timers.tick(3000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 1);
    assert.equal(done, null);
    await mock.timers.tick(3000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 2);
    await mock.timers.tick(3000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 3);
    assert.notEqual(done, null);
    const after = reads;
    await mock.timers.tick(90000);
    await Promise.resolve();
    assert.equal(reads, after);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("the checkout return stops polling at the limit and on unmount", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    let reads = 0;
    const never = async () => {
      reads += 1;
      return { role: "owner", plan: { pro: false, status: "past_due", seats: 1, currentPeriodEnd: null } };
    };
    let done = false;
    const stop = pollForPro("w1", () => {
      done = true;
    }, { getPlan: never as never });
    await mock.timers.tick(90000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(reads, 30);
    assert.equal(done, false);
    stop();
    await mock.timers.tick(9000);
    assert.equal(reads, 30);

    let unmountedReads = 0;
    const slow = async () => {
      unmountedReads += 1;
      return { role: "owner", plan: { pro: false, status: "past_due", seats: 1, currentPeriodEnd: null } };
    };
    const stopEarly = pollForPro("w1", () => {}, { getPlan: slow as never });
    await mock.timers.tick(6000);
    for (let i = 0; i < 3; i++) await Promise.resolve();
    assert.equal(unmountedReads, 2);
    stopEarly();
    await mock.timers.tick(30000);
    assert.equal(unmountedReads, 2);
  } finally {
    mock.timers.reset();
  }
});
