import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { testDatabase } from "./support/d1.ts";

/**
 * A signed-in account with no subscription can create workspaces and invite
 * people without limit. These tests drive the real Better Auth routes over a
 * test database and a fake email, so they see what a request sees.
 *
 * Each test sends its own x-forwarded-for. Better Auth's built-in limiter (five
 * magic-link requests per minute) keys on the client address and falls back to
 * one shared bucket without it, and every sign-in here would otherwise share
 * that bucket.
 */

const ORIGIN = "http://127.0.0.1:8790";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const NO_WORKSPACES = "You can have up to 3 workspaces, so delete one before creating another.";
const NO_SEAT = "This workspace has no free seat, so cancel a pending invitation or add seats.";

// Better Auth reads pragma_table_info through D1 batch. The shared stand-in
// answers batch with run(), which drops those rows, and sign-in then answers 500.
function database(): Env["DB"] {
  const db = testDatabase();
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    exec: (sql) => db.exec(sql),
  };
}

function bindings(db: Env["DB"]): Env {
  const assets: Fetcher = {
    async fetch() {
      return new Response("missing", { status: 500 });
    },
  };
  return { ASSETS: assets, DB: db, BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: AUTH_SECRET, ACCOUNTS: "on" };
}

function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const previous = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const methods = ["debug", "info", "log", "warn", "error"] as const;
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      const text = args.map((arg) => String(arg)).join(" ");
      lines.push(text);
      if (!text.includes("[email]")) previous[method](...args);
    };
  }
  return {
    lines,
    restore() {
      console.debug = previous.debug;
      console.info = previous.info;
      console.log = previous.log;
      console.warn = previous.warn;
      console.error = previous.error;
    },
  };
}

async function dispatch(env: Env, request: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(request, env, {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  });
  await Promise.all(pending);
  return response;
}

function call(url: string, env: Env, init: RequestInit = {}): Promise<Response> {
  return dispatch(env, new Request(url, init));
}

function headers(client: string, cookie?: string): Record<string, string> {
  return { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": client, ...(cookie ? { cookie } : {}) };
}

/** Signs in through the emailed link and returns the session cookie. */
async function signIn(env: Env, lines: string[], email: string, client: string): Promise<string> {
  const start = lines.length;
  const sent = await call(`${ORIGIN}/api/auth/sign-in/magic-link`, env, {
    method: "POST",
    headers: headers(client),
    body: JSON.stringify({ email, callbackURL: `${ORIGIN}/app/` }),
  });
  assert.equal(sent.status, 200);
  const link = lines.slice(start).join("\n").match(/https?:\/\/\S*\/api\/auth\/magic-link\/verify\?\S+/);
  assert.ok(link, "the sign-in link was written to the log");
  const verified = await call(link[0], env, { headers: headers(client) });
  assert.equal(verified.status, 302, await verified.clone().text());
  const cookies = verified.headers.getSetCookie();
  assert.ok(cookies.length > 0, "sign-in set a session cookie");
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

let created = 0;
async function createWorkspace(env: Env, client: string, cookie: string, name: string): Promise<Response> {
  created += 1;
  return call(`${ORIGIN}/api/auth/organization/create`, env, {
    method: "POST",
    headers: headers(client, cookie),
    body: JSON.stringify({ name, slug: `workspace-${created}` }),
  });
}

function invite(env: Env, client: string, cookie: string, organizationId: string, email: string): Promise<Response> {
  return call(`${ORIGIN}/api/auth/organization/invite-member`, env, {
    method: "POST",
    headers: headers(client, cookie),
    body: JSON.stringify({ organizationId, email, role: "member" }),
  });
}

function acceptInvitation(env: Env, client: string, cookie: string, invitationId: string): Promise<Response> {
  return call(`${ORIGIN}/api/auth/organization/accept-invitation`, env, {
    method: "POST",
    headers: headers(client, cookie),
    body: JSON.stringify({ invitationId }),
  });
}

function cancelInvitation(env: Env, client: string, cookie: string, invitationId: string): Promise<Response> {
  return call(`${ORIGIN}/api/auth/organization/cancel-invitation`, env, {
    method: "POST",
    headers: headers(client, cookie),
    body: JSON.stringify({ invitationId }),
  });
}

function deleteWorkspace(env: Env, client: string, cookie: string, organizationId: string): Promise<Response> {
  return call(`${ORIGIN}/api/auth/organization/delete`, env, {
    method: "POST",
    headers: headers(client, cookie),
    body: JSON.stringify({ organizationId }),
  });
}

async function subscribe(env: Env, workspaceId: string, seats: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscription (organizationId, paddleSubscriptionId, paddleCustomerId, status, priceId, seats, currentPeriodEnd, lastEventAt)
     VALUES (?, 'sub_test', 'ctm_test', 'active', 'pri_test', ?, '2099-01-01T00:00:00.000Z', '2026-10-04T00:00:00.000000Z')`,
  )
    .bind(workspaceId, seats)
    .run();
}

async function seedInvitation(env: Env, id: string, organizationId: string, email: string, inviterId: string, expiresAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES (?, ?, ?, 'member', 'pending', ?, '2026-10-04T00:00:00.000Z', ?)`,
  )
    .bind(id, organizationId, email, expiresAt, inviterId)
    .run();
}

const invitations = (lines: string[]): string[] => lines.filter((line) => line.includes("invited you to a Bridgekit workspace"));

async function rows(env: Env, table: string, where = ""): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function refusal(response: Response, sentence: string): Promise<void> {
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { message?: string }).message, sentence);
}

test("a fourth workspace is refused and the first three succeed", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const client = "198.51.100.21";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const statuses = [];
    for (let index = 1; index <= 3; index += 1) {
      const response = await createWorkspace(env, client, cookie, `Workspace ${index}`);
      assert.equal(response.status, 200, await response.clone().text());
      statuses.push(response.status);
    }
    const fourth = await createWorkspace(env, client, cookie, "Workspace 4");
    await refusal(fourth, NO_WORKSPACES);
    assert.deepEqual([...statuses, fourth.status], [200, 200, 200, 403]);
    assert.equal(await rows(env, "organization"), 3);
  } finally {
    logs.restore();
  }
});

test("an invitation to a workspace with no free seat is refused, with no row and no email", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const client = "198.51.100.22";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Solo")).json()) as { id: string };
    const before = invitations(logs.lines).length;
    await refusal(await invite(env, client, cookie, workspace.id, "stranger@example.com"), NO_SEAT);
    assert.equal(invitations(logs.lines).length, before);
    assert.equal(await rows(env, "invitation"), 0);
  } finally {
    logs.restore();
  }
});

test("paid seats cover invitations, the next is refused, and an accepted invitation still uses one seat", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const client = "198.51.100.23";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 3);
    const [first, second] = await Promise.all([
      invite(env, client, cookie, workspace.id, "first@example.com"),
      invite(env, client, cookie, workspace.id, "second@example.com"),
    ]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    await refusal(await invite(env, client, cookie, workspace.id, "third@example.com"), NO_SEAT);
    assert.equal(await rows(env, "invitation", "WHERE status = 'pending'"), 2);

    const { id } = (await second.json()) as { id: string };
    const guest = await signIn(env, logs.lines, "second@example.com", client);
    assert.equal((await acceptInvitation(env, client, guest, id)).status, 200);
    assert.equal(await rows(env, "member", `WHERE organizationId = '${workspace.id}'`), 2);
    await refusal(await invite(env, client, cookie, workspace.id, "later@example.com"), NO_SEAT);
    assert.equal(await rows(env, "invitation", "WHERE status = 'pending'"), 1);
  } finally {
    logs.restore();
  }
});

test("a cancelled or expired invitation frees its seat", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const client = "198.51.100.24";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 2);
    const kept = (await (await invite(env, client, cookie, workspace.id, "kept@example.com")).json()) as { id: string };
    await refusal(await invite(env, client, cookie, workspace.id, "full@example.com"), NO_SEAT);

    assert.equal((await cancelInvitation(env, client, cookie, kept.id)).status, 200);
    assert.equal((await invite(env, client, cookie, workspace.id, "after-cancel@example.com")).status, 200);

    const owner = await env.DB.prepare(`SELECT id FROM user WHERE email = 'owner@example.com'`).first<{ id: string }>();
    assert.ok(owner);
    await seedInvitation(env, "expired-1", workspace.id, "stale@example.com", owner.id, "2020-01-01T00:00:00.000Z");
    assert.equal(await rows(env, "invitation", "WHERE status = 'pending'"), 2);
    await refusal(await invite(env, client, cookie, workspace.id, "also-full@example.com"), NO_SEAT);
  } finally {
    logs.restore();
  }
});

test("deleting a workspace frees the owner's count", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const client = "198.51.100.25";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const created: { id: string }[] = [];
    for (const name of ["One", "Two", "Three"]) {
      created.push((await (await createWorkspace(env, client, cookie, name)).json()) as { id: string });
    }
    await refusal(await createWorkspace(env, client, cookie, "Four"), NO_WORKSPACES);
    assert.equal((await deleteWorkspace(env, client, cookie, created[0].id)).status, 200);
    assert.equal((await createWorkspace(env, client, cookie, "Four")).status, 200);
    assert.equal(await rows(env, "organization"), 3);
  } finally {
    logs.restore();
  }
});
