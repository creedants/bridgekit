import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import type { D1Database, D1PreparedStatement, Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { createAuth } from "../server/auth.ts";
import { plan, workspaceCount } from "../server/workspace.ts";
import { testDatabase } from "./support/d1.ts";

/**
 * These tests drive the real Better Auth routes over a test database and a fake
 * email, so they see what a request sees. They check the two limits a workspace
 * account carries: an account may own at most three workspaces, and a workspace
 * may seat as many people as it pays for, members and live pending invitations
 * together. Each test covers the ordinary path, the refusal that leaves nothing
 * behind, and what happens when two requests ask at the same moment.
 *
 * Each test sends its own x-forwarded-for. Better Auth's built-in limiter (five
 * magic-link requests per minute) keys on the client address and falls back to
 * one shared bucket without it, and every sign-in here would otherwise share
 * that bucket.
 */

const ORIGIN = "http://127.0.0.1:8790";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const NO_WORKSPACES = "You can own up to 3 workspaces, so delete one before creating another.";
const NO_SEAT = "This workspace has no free seat, so cancel a pending invitation or add seats.";
const LIMITS_MIGRATION = new URL("../migrations/0004_workspace_limits.sql", import.meta.url);
const INSERT_INVITATION = /insert into "invitation"/i;

// Better Auth reads pragma_table_info through D1 batch. The shared stand-in
// answers batch with run(), which drops those rows, and sign-in then answers 500.
function database(): Env["DB"] {
  const db = testDatabase();
  return wrap(db);
}

function wrap(db: D1Database): Env["DB"] {
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    exec: (sql) => db.exec(sql),
  };
}

/**
 * A database holding only the tables the limits migration is applied onto. The
 * migration itself is applied by the test that needs it, so it can show what it
 * does to rows that were already there.
 */
function legacyDatabase(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql") && name < "0004_").sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const statement = (sql: string, values: unknown[]): D1PreparedStatement => ({
    bind: (...next) => statement(sql, next),
    // node:sqlite rows have a null prototype; D1 returns plain objects.
    first: async <T>() => {
      const row = sqlite.prepare(sql).get(...(values as SQLInputValue[]));
      return (row ? { ...row } : null) as T | null;
    },
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...(values as SQLInputValue[])).map((row) => ({ ...row })) as T[],
      success: true,
      meta: {},
    }),
    run: async () => {
      const { changes } = sqlite.prepare(sql).run(...(values as SQLInputValue[]));
      return { results: [], success: true, meta: { changes: Number(changes) } };
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: (statements) => Promise.all(statements.map((entry) => entry.all())),
    exec: async (sql) => sqlite.exec(sql),
  };
}

/**
 * A database that can hold one statement on a promise while another request
 * runs, which is how two requests are forced past the checks the application
 * makes and made to meet each other at the write. No sleep, no query changed,
 * no result faked.
 */
function pausingDatabase(): { db: Env["DB"]; pause(intercept?: (sql: string, values: unknown[]) => Promise<void>): void } {
  const base = database();
  let intercept: ((sql: string, values: unknown[]) => Promise<void>) | undefined;
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    const bound = base.prepare(sql).bind(...values);
    const wait = async () => {
      if (intercept) await intercept(sql, values);
    };
    return {
      bind: (...next) => statement(sql, next),
      first: async <T>() => {
        await wait();
        return bound.first<T>();
      },
      all: async <T>() => {
        await wait();
        return bound.all<T>();
      },
      run: async () => {
        await wait();
        return bound.run();
      },
    };
  };
  const db: Env["DB"] = {
    prepare: (sql) => statement(sql),
    batch: (statements) => Promise.all(statements.map((entry) => entry.all())),
    exec: (sql) => base.exec(sql),
  };
  return { db, pause(next) { intercept = next; } };
}

function latch(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function bindings(db: Env["DB"]): Env {
  const assets: Fetcher = {
    async fetch() {
      return new Response("missing", { status: 500 });
    },
  };
  return { ASSETS: assets, DB: db, BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: AUTH_SECRET, ACCOUNTS: "on", LOCAL_EMAIL_LOG: "on" };
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

function invite(env: Env, client: string, cookie: string, organizationId: string, email: string, resend = false): Promise<Response> {
  return call(`${ORIGIN}/api/auth/organization/invite-member`, env, {
    method: "POST",
    headers: headers(client, cookie),
    body: JSON.stringify({ organizationId, email, role: "member", ...(resend ? { resend: true } : {}) }),
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

function removeMember(env: Env, client: string, cookie: string, organizationId: string, memberIdOrEmail: string): Promise<Response> {
  return call(`${ORIGIN}/api/auth/organization/remove-member`, env, {
    method: "POST",
    headers: headers(client, cookie),
    body: JSON.stringify({ organizationId, memberIdOrEmail }),
  });
}

function listWorkspaces(env: Env, client: string, cookie: string): Promise<Response> {
  return call(`${ORIGIN}/api/auth/organization/list`, env, { headers: headers(client, cookie) });
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

/** The paid seats drop, as a plan change or a subscription that stops paying does. */
async function lowerSeats(env: Env, workspaceId: string, seats = 1): Promise<void> {
  await env.DB.prepare(`UPDATE subscription SET seats = ? WHERE organizationId = ?`).bind(seats, workspaceId).run();
}

/** The subscription stops paying, so the workspace keeps one seat: the owner's. */
async function endSubscription(env: Env, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE subscription SET status = 'canceled', currentPeriodEnd = '2020-01-01T00:00:00.000Z' WHERE organizationId = ?`,
  )
    .bind(workspaceId)
    .run();
}

async function userIdFor(env: Env, email: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM user WHERE email = ?`).bind(email).first<{ id: string }>();
  assert.ok(row, `no account for ${email}`);
  return row.id;
}

const invitations = (lines: string[]): string[] => lines.filter((line) => line.includes("invited you to a Bridgekit workspace"));

/** The invitation ids the sent emails carry, from the link in each message. */
const emailedInvitations = (lines: string[]): string[] =>
  invitations(lines).map((line) => new RegExp("/app/\\?invitation=(\\S+)").exec(line)?.[1] ?? "");

async function rows(env: Env, table: string, where = ""): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Every invitation row, whole and ordered, so a refusal can be shown to change none of it. */
async function invitationRows(env: Env): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB
    .prepare(`SELECT id, organizationId, email, role, status, expiresAt, createdAt, inviterId FROM invitation ORDER BY id`)
    .all<Record<string, unknown>>();
  return results;
}

/** What the database and the log hold right now, for "a refusal leaves both alone". */
async function snapshot(env: Env, lines: string[]): Promise<{ rows: Record<string, unknown>[]; emails: number }> {
  return { rows: await invitationRows(env), emails: invitations(lines).length };
}

async function unchanged(env: Env, lines: string[], before: { rows: Record<string, unknown>[]; emails: number }): Promise<void> {
  assert.deepEqual(await snapshot(env, lines), before, "the refusal changed the invitation rows or sent an email");
}

async function expireInvitation(env: Env, invitationId: string): Promise<void> {
  await env.DB.prepare(`UPDATE invitation SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE id = ?`).bind(invitationId).run();
}

async function refusal(response: Response, sentence: string): Promise<void> {
  assert.equal(response.status, 403, await response.clone().text());
  assert.equal(((await response.json()) as { message?: string }).message, sentence);
}

test("the limits migration carries the invitation sentence as its marker", async () => {
  const migration = readFileSync(LIMITS_MIGRATION, "utf8");
  assert.ok(migration.includes(NO_SEAT), "the trigger's marker is the sentence the Worker answers with");
  assert.equal(migration.includes("DELETE FROM"), false, "no trigger deletes a row");
  assert.equal(/UPDATE invitation SET/.test(migration), false, "no trigger updates a row");
  // The refusal has to reach the request, so it may not be an undo after the fact.
  assert.match(migration, /BEFORE INSERT ON invitation[\s\S]*RAISE\(ABORT/);
  assert.match(migration, /BEFORE UPDATE ON invitation[\s\S]*RAISE\(ABORT/);
  // Nothing guards a member or an organization, so no other table can lose a row.
  assert.equal(/CREATE TRIGGER\s+\w+\s+(?!BEFORE (INSERT|UPDATE) ON invitation)/.test(migration), false, "a trigger guards another table");
});

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
    assert.equal(await rows(env, "member"), 3);
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
    const before = await snapshot(env, logs.lines);
    await refusal(await invite(env, client, cookie, workspace.id, "stranger@example.com"), NO_SEAT);
    await unchanged(env, logs.lines, before);
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
    const replacement = (await (await invite(env, client, cookie, workspace.id, "after-cancel@example.com")).json()) as { id: string };
    await refusal(await invite(env, client, cookie, workspace.id, "still-full@example.com"), NO_SEAT);

    // Letting the invitation that holds the last seat lapse frees it, so the
    // replacement lands where the old one did.
    await expireInvitation(env, replacement.id);
    assert.equal((await invite(env, client, cookie, workspace.id, "after-expiry@example.com")).status, 200);
    await refusal(await invite(env, client, cookie, workspace.id, "full-again@example.com"), NO_SEAT);
  } finally {
    logs.restore();
  }
});

test("re-sending an invitation the workspace has no seat for is refused, with no email and an unchanged row", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const client = "198.51.100.26";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    // The row is written while the two paid seats are still there, so the
    // re-send has a real pending row to leave exactly as it is.
    await subscribe(env, workspace.id, 2);
    assert.equal((await invite(env, client, cookie, workspace.id, "guest@example.com")).status, 200);
    const before = await snapshot(env, logs.lines);
    await lowerSeats(env, workspace.id);
    await refusal(await invite(env, client, cookie, workspace.id, "guest@example.com", true), NO_SEAT);
    await unchanged(env, logs.lines, before);

    // The same, after the paid seats are gone again.
    await lowerSeats(env, workspace.id, 3);
    assert.equal((await invite(env, client, cookie, workspace.id, "more@example.com")).status, 200);
    const beforeEnd = await snapshot(env, logs.lines);
    await endSubscription(env, workspace.id);
    await refusal(await invite(env, client, cookie, workspace.id, "guest@example.com", true), NO_SEAT);
    await unchanged(env, logs.lines, beforeEnd);
  } finally {
    logs.restore();
  }
});

test("re-sending an invitation that already holds a paid seat still sends one email", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const client = "198.51.100.27";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 2);
    // Two paid seats: the owner and the invited person, with none left over.
    await invite(env, client, cookie, workspace.id, "kept@example.com");
    const before = invitations(logs.lines).length;
    const resent = await invite(env, client, cookie, workspace.id, "kept@example.com", true);
    assert.equal(resent.status, 200, await resent.clone().text());
    assert.equal(invitations(logs.lines).length, before + 1);
    assert.equal(await rows(env, "invitation"), 1);
  } finally {
    logs.restore();
  }
});

test("memberships in other people's workspaces do not use up the account's own allowance", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const guestClient = "198.51.100.28";
    // Three colleagues, each inviting the same account into their own workspace.
    for (let host = 0; host < 3; host += 1) {
      const client = `198.51.100.${60 + host}`;
      const cookie = await signIn(env, logs.lines, `host-${host}@example.com`, client);
      const team = (await (await createWorkspace(env, client, cookie, `Host ${host}`)).json()) as { id: string };
      await subscribe(env, team.id, 2);
      assert.equal((await invite(env, client, cookie, team.id, "guest@example.com")).status, 200);
    }
    const guestCookie = await signIn(env, logs.lines, "guest@example.com", guestClient);
    const guestId = await userIdFor(env, "guest@example.com");
    const guestInvitations = await env.DB.prepare(`SELECT id FROM invitation WHERE email = 'guest@example.com'`).all<{ id: string }>();
    assert.equal(guestInvitations.results.length, 3);
    for (const { id } of guestInvitations.results) {
      assert.equal((await acceptInvitation(env, guestClient, guestCookie, id)).status, 200);
    }
    // Three memberships in other people's workspaces, and none of their own.
    assert.equal(await workspaceCount(env.DB, guestId), 0);
    assert.equal(await rows(env, "member", `WHERE userId = '${guestId}'`), 3);
    for (const name of ["Mine", "Mine two", "Mine three"]) {
      assert.equal((await createWorkspace(env, guestClient, guestCookie, name)).status, 200);
    }
    assert.equal(await workspaceCount(env.DB, guestId), 3);
    await refusal(await createWorkspace(env, guestClient, guestCookie, "Mine four"), NO_WORKSPACES);
  } finally {
    logs.restore();
  }
});

test("an owner of three workspaces stays at three after joining a fourth as a member", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const host = "198.51.100.29";
    const hostCookie = await signIn(env, logs.lines, "host@example.com", host);
    const hostTeam = (await (await createWorkspace(env, host, hostCookie, "Host team")).json()) as { id: string };
    await subscribe(env, hostTeam.id, 9);

    const ownerCookie = await signIn(env, logs.lines, "owner@example.com", host);
    for (const name of ["One", "Two", "Three"]) {
      assert.equal((await createWorkspace(env, host, ownerCookie, name)).status, 200);
    }
    await refusal(await createWorkspace(env, host, ownerCookie, "Four"), NO_WORKSPACES);

    assert.equal((await invite(env, host, hostCookie, hostTeam.id, "owner@example.com")).status, 200);
    const guestCookie = await signIn(env, logs.lines, "owner@example.com", host);
    const invitation = await env.DB.prepare(`SELECT id FROM invitation WHERE email = 'owner@example.com'`).first<{ id: string }>();
    assert.ok(invitation);
    assert.equal((await acceptInvitation(env, host, guestCookie, invitation.id)).status, 200);

    const ownerId = await userIdFor(env, "owner@example.com");
    // The membership counted, and the owned workspace did not.
    assert.equal(await workspaceCount(env.DB, ownerId), 3);
    await refusal(await createWorkspace(env, host, ownerCookie, "Five"), NO_WORKSPACES);
  } finally {
    logs.restore();
  }
});

test("two invitations for the last seat at the same moment send one email", async () => {
  const logs = captureConsole();
  try {
    const store = pausingDatabase();
    const env = bindings(store.db);
    const client = "198.51.100.32";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 2);

    const reached = latch();
    const release = latch();
    let writes = 0;
    // Every insert is held. The first request's row stays unwritten until the
    // second request has passed its own seat check with the seat still free,
    // so the two meet at the database instead of one being refused early. When
    // the second insert arrives, both go on: the winner writes and the loser
    // meets the trigger.
    store.pause(async (sql) => {
      if (!INSERT_INVITATION.test(sql)) return;
      writes += 1;
      if (writes === 2) reached.release();
      await release.promise;
    });
    const before = await snapshot(env, logs.lines);
    const first = invite(env, "198.51.100.101", cookie, workspace.id, "race-a@example.com");
    const second = invite(env, "198.51.100.102", cookie, workspace.id, "race-b@example.com");
    await reached.promise;
    release.release();
    const [won, lost] = await Promise.all([first, second]);
    store.pause(undefined);

    const statuses = [won.status, lost.status].sort();
    assert.deepEqual(statuses, [200, 403], `the pair answered ${won.status} and ${lost.status}`);
    assert.equal(lost.status === 403 ? lost.status : won.status, 403);
    await refusal(lost.status === 403 ? lost : won, NO_SEAT);
    const after = await snapshot(env, logs.lines);
    assert.equal(after.rows.length, before.rows.length + 1, "the losing invitation left a row behind");
    assert.equal(after.emails, before.emails + 1, "the losing invitation sent an email");
  } finally {
    logs.restore();
  }
});

test("an email is never sent for an invitation row that does not exist", async () => {
  const logs = captureConsole();
  try {
    const store = pausingDatabase();
    const env = bindings(store.db);
    const client = "198.51.100.33";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 2);

    const both = latch();
    const winner = latch();
    const loser = latch();
    const winnerEmail = "kept@example.com";
    const loserEmail = "loser@example.com";
    let writes = 0;
    let losing = false;
    let freed = false;
    store.pause(async (sql, values) => {
      if (INSERT_INVITATION.test(sql)) {
        writes += 1;
        if (writes === 2) both.release();
        if (values.includes(loserEmail)) {
          losing = true;
          await loser.promise;
        } else {
          await winner.promise;
        }
        return;
      }
      // The old design's losing request asked for the seats again after its row
      // was written, by which point its trigger had removed that row. Answering
      // that second ask with a free seat is the moment an email could name a
      // row that is not there. This test holds both requests at the write, so
      // the same point is reached either way.
      if (losing && !freed && sql.startsWith("SELECT status, seats, currentPeriodEnd FROM subscription") && (await rows(env, "invitation")) > 0) {
        freed = true;
        await env.DB.prepare(`UPDATE invitation SET status = 'canceled' WHERE organizationId = ?`).bind(workspace.id).run();
      }
    });
    const before = await snapshot(env, logs.lines);
    const first = invite(env, client, cookie, workspace.id, winnerEmail);
    const second = invite(env, client, cookie, workspace.id, loserEmail);
    await both.promise;
    // The kept invitation writes first, so it holds the last seat while the
    // other request goes on.
    winner.release();
    assert.equal((await first).status, 200, "the winning invitation succeeded");
    loser.release();
    await second;
    store.pause(undefined);

    // Whatever each request answered, every invitation an email names is a row
    // that exists.
    for (const id of emailedInvitations(logs.lines).slice(before.emails)) {
      const row = await env.DB.prepare(`SELECT id FROM invitation WHERE id = ?`).bind(id).first();
      assert.ok(row, `an email was sent for invitation ${id}, which has no row`);
    }
    const after = await snapshot(env, logs.lines);
    assert.equal(after.rows.length, before.rows.length + 1, "a refusal left a row behind or a written row sent no email");
    assert.equal(after.emails, before.emails + 1, "exactly one invitation email was sent");
  } finally {
    logs.restore();
  }
});

test("seats lowered between the check and the write leave no row without its email", async () => {
  const logs = captureConsole();
  try {
    const store = pausingDatabase();
    const env = bindings(store.db);
    const client = "198.51.100.34";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 2);

    const reached = latch();
    const release = latch();
    store.pause(async (sql) => {
      if (INSERT_INVITATION.test(sql)) {
        reached.release();
        await release.promise;
      }
    });
    const before = await snapshot(env, logs.lines);
    const inFlight = invite(env, client, cookie, workspace.id, "late@example.com");
    await reached.promise;
    // The paid seats are gone while the row is being written, so the write is
    // the last thing that still knows a seat was there.
    await lowerSeats(env, workspace.id);
    release.release();
    const response = await inFlight;
    store.pause(undefined);

    await refusal(response, NO_SEAT);
    const after = await snapshot(env, logs.lines);
    assert.equal(after.rows.length, before.rows.length, "the refused invitation left a row behind");
    assert.equal(after.emails, before.emails, "the refused invitation sent an email");
  } finally {
    logs.restore();
  }
});

test("an invitation the older Worker sends fails without email when the trigger refuses it", async () => {
  const logs = captureConsole();
  try {
    const store = pausingDatabase();
    const env = bindings(store.db);
    const client = "198.51.100.35";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 2);
    // The Worker's own check has already passed, exactly as it would for a
    // version of the Worker that has no such check.
    const auth = createAuth(env, async (id) => (await plan(env.DB, id)).seats);

    const reached = latch();
    const release = latch();
    store.pause(async (sql) => {
      if (INSERT_INVITATION.test(sql)) {
        reached.release();
        await release.promise;
      }
    });
    const before = invitations(logs.lines).length;
    const inFlight = auth.handler(
      new Request(`${ORIGIN}/api/auth/organization/invite-member`, {
        method: "POST",
        headers: headers(client, cookie),
        body: JSON.stringify({ organizationId: workspace.id, email: "old-worker@example.com", role: "member" }),
      }),
    );
    await reached.promise;
    await lowerSeats(env, workspace.id);
    release.release();
    await assert.rejects(inFlight, "the older Worker's invitation failed");
    store.pause(undefined);

    assert.equal(await rows(env, "invitation"), 0, "the refused invitation left a row behind");
    assert.equal(invitations(logs.lines).length, before, "the failed invitation sent an email");
  } finally {
    logs.restore();
  }
});

test("rows that were already there survive the limits migration and ordinary requests", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(wrap(legacyDatabase()));
    // Rows from before the limits existed: an account that already owns five
    // workspaces, a workspace over its seats with pending invitations, and an
    // old workspace with a subscription and saved setups that nobody is a
    // member of any more.
    const seed = (sql: string, values: unknown[] = []) => env.DB.prepare(sql).bind(...values).run();
    await seed(`INSERT INTO user VALUES ('old', 'Old owner', 'old@example.com', 1, NULL, '2020-01-01', '2020-01-01')`);
    await seed(`INSERT INTO user VALUES ('guest', 'Old guest', 'guest@example.com', 1, NULL, '2020-01-01', '2020-01-01')`);
    for (let index = 0; index < 5; index += 1) {
      await seed(`INSERT INTO organization VALUES (?, ?, ?, NULL, '2020-01-01', NULL)`, [`legacy-${index}`, `Legacy ${index}`, `legacy-${index}`]);
      await seed(`INSERT INTO member VALUES (?, ?, 'old', 'owner', '2020-01-01')`, [`legacy-m-${index}`, `legacy-${index}`]);
    }
    // Over its one unpaid seat: two members and two live pending invitations.
    await seed(`INSERT INTO organization VALUES ('legacy-over', 'Legacy over', 'legacy-over', NULL, '2020-01-01', NULL)`);
    await seed(`INSERT INTO member VALUES ('legacy-over-a', 'legacy-over', 'old', 'owner', '2020-01-01')`);
    await seed(`INSERT INTO member VALUES ('legacy-over-b', 'legacy-over', 'guest', 'member', '2020-01-01')`);
    for (const [index, email] of ["pending-a@example.com", "pending-b@example.com"].entries()) {
      await seed(
        `INSERT INTO invitation VALUES (?, 'legacy-over', ?, 'member', 'pending', '2099-01-01T00:00:00Z', '2020-01-01', 'old')`,
        [`legacy-over-i-${index}`, email],
      );
    }
    await seed(`INSERT INTO organization VALUES ('legacy-paid', 'Legacy paid', 'legacy-paid', NULL, '2020-01-01', NULL)`);
    await seed(`INSERT INTO subscription VALUES ('legacy-paid', 'sub_old', 'ctm_old', 'active', 'pri_old', 2, '2099-01-01T00:00:00Z', '2020-01-01')`);
    await seed(`INSERT INTO member VALUES ('legacy-paid-m', 'legacy-paid', 'old', 'owner', '2020-01-01')`);
    await seed(
      `INSERT INTO saved_setup VALUES ('legacy-saved', 'legacy-paid', 'Old setup', 'amount', '{}', 'old', '2020-01-01')`,
    );
    await seed(`INSERT INTO organization VALUES ('legacy-old', 'Legacy old', 'legacy-old', NULL, '2020-01-01', NULL)`);
    await seed(`INSERT INTO subscription VALUES ('legacy-old', 'sub_older', 'ctm_older', 'active', 'pri_older', 2, '2099-01-01T00:00:00Z', '2020-01-01')`);
    await seed(`INSERT INTO saved_setup VALUES ('legacy-old-saved', 'legacy-old', 'Older setup', 'amount', '{}', 'old', '2020-01-01')`);

    const counts = async () => ({
      organization: await rows(env, "organization"),
      member: await rows(env, "member"),
      invitation: await rows(env, "invitation"),
      subscription: await rows(env, "subscription"),
      saved_setup: await rows(env, "saved_setup"),
    });
    const before = await counts();

    // Applying the migration changes and deletes no row.
    await env.DB.exec(readFileSync(LIMITS_MIGRATION, "utf8"));
    assert.deepEqual(await counts(), before, "applying the migration changed a row");

    // An owner-role membership in a workspace nobody else is in, which is what
    // the old design read as a workspace created in the same request.
    await seed(`INSERT INTO member VALUES ('legacy-new-owner', 'legacy-old', 'old', 'owner', '2026-10-12')`);
    assert.deepEqual(await counts(), { ...before, member: before.member + 1 }, "the trigger changed a row");

    const client = "198.51.100.36";
    const ownerCookie = await signIn(env, logs.lines, "old@example.com", client);
    assert.equal((await listWorkspaces(env, client, ownerCookie)).status, 200);

    // Ordinary requests on the old rows: an invitation, its acceptance, a
    // cancellation, and the removal of a member.
    assert.equal((await invite(env, client, ownerCookie, "legacy-paid", "new@example.com")).status, 200);
    const newCookie = await signIn(env, logs.lines, "new@example.com", "198.51.100.37");
    const made = await env.DB.prepare(`SELECT id FROM invitation WHERE email = 'new@example.com'`).first<{ id: string }>();
    assert.ok(made);
    assert.equal((await acceptInvitation(env, "198.51.100.37", newCookie, made.id)).status, 200);

    const pending = await env.DB.prepare(`SELECT id FROM invitation WHERE email = 'pending-a@example.com'`).first<{ id: string }>();
    assert.ok(pending);
    assert.equal((await cancelInvitation(env, client, ownerCookie, pending.id)).status, 200);
    assert.equal(await rows(env, "invitation", `WHERE id = 'legacy-over-i-0' AND status = 'canceled'`), 1, "the cancelled invitation is gone");
    assert.equal(await rows(env, "invitation", `WHERE id = 'legacy-over-i-1' AND status = 'pending'`), 1, "the other invitation is gone");

    assert.equal((await removeMember(env, client, ownerCookie, "legacy-over", "guest@example.com")).status, 200);

    // The five it owned, plus legacy-over and legacy-paid, plus the owner row
    // just added to legacy-old: every one still counts. Its next creation is
    // refused without taking any away.
    const ownerId = await userIdFor(env, "old@example.com");
    assert.equal(await workspaceCount(env.DB, ownerId), 8);
    await refusal(await createWorkspace(env, client, ownerCookie, "Sixth"), NO_WORKSPACES);
    assert.equal(await rows(env, "organization"), before.organization, "the refused creation took a workspace away");
    assert.equal(await rows(env, "subscription"), before.subscription, "a subscription was lost");
    assert.equal(await rows(env, "saved_setup"), before.saved_setup, "a saved setup was lost");
    assert.equal(await rows(env, "organization", `WHERE id = 'legacy-old'`), 1, "the old workspace was deleted");
    assert.equal(await rows(env, "organization", `WHERE id = 'legacy-over'`), 1, "the over-capacity workspace was deleted");
    assert.equal(await rows(env, "member", `WHERE organizationId = 'legacy-paid'`), 2, "the paid workspace lost a member");
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
    const made: { id: string }[] = [];
    for (const name of ["One", "Two", "Three"]) {
      made.push((await (await createWorkspace(env, client, cookie, name)).json()) as { id: string });
    }
    await refusal(await createWorkspace(env, client, cookie, "Four"), NO_WORKSPACES);
    assert.equal((await deleteWorkspace(env, client, cookie, made[0].id)).status, 200);
    assert.equal((await createWorkspace(env, client, cookie, "Four")).status, 200);
    assert.equal(await rows(env, "organization"), 3);
  } finally {
    logs.restore();
  }
});

test("a failed session read does not stop sign-out from clearing the cookie", async () => {
  const logs = captureConsole();
  try {
    const store = pausingDatabase();
    const env = bindings(store.db);
    const client = "198.51.100.40";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    store.pause(async (sql) => {
      if (/from "session"/i.test(sql)) throw new Error("injected session read failure");
    });
    const response = await call(`${ORIGIN}/api/auth/sign-out`, env, {
      method: "POST",
      headers: headers(client, cookie),
      body: "{}",
    });
    store.pause(undefined);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      response.headers.getSetCookie().some((entry) => /Max-Age=0/i.test(entry)),
      true,
      "sign-out cleared the session cookie",
    );
  } finally {
    logs.restore();
  }
});
