import assert from "node:assert/strict";
import { test } from "node:test";
import type { D1Database, D1PreparedStatement, Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { workspaceCount } from "../server/workspace.ts";
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

function racingDatabase(): Env["DB"] {
  const db = testDatabase();
  // Better Auth reads pragma_table_info through D1 batch, like database() above.
  const statement = (sql: string): D1PreparedStatement => ({ ...db.prepare(sql) });
  return {
    prepare: (sql) => statement(sql),
    batch: (statements) => Promise.all(statements.map((entry) => entry.all())),
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

/** The subscription stops paying, so the workspace keeps one seat: the owner's. */
async function endSubscription(env: Env, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE subscription SET status = 'canceled', currentPeriodEnd = '2020-01-01T00:00:00.000Z' WHERE organizationId = ?`,
  )
    .bind(workspaceId)
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

/** What the database and the log hold right now, for "a refusal leaves both alone". */
async function snapshot(env: Env, lines: string[]): Promise<{ rows: number; emails: number }> {
  return { rows: await rows(env, "invitation"), emails: invitations(lines).length };
}

async function unchanged(env: Env, lines: string[], before: { rows: number; emails: number }): Promise<void> {
  assert.deepEqual(await snapshot(env, lines), before);
}

async function expireInvitation(env: Env, invitationId: string): Promise<void> {
  await env.DB.prepare(`UPDATE invitation SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE id = ?`).bind(invitationId).run();
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
    const workspace = (await (await createWorkspace(env, client, cookie, "Solo")).json()) as { id: string };
    const owner = await env.DB.prepare(`SELECT id FROM user WHERE email = 'owner@example.com'`).first<{ id: string }>();
    assert.ok(owner);
    // A one-seat workspace that never paid. The owner's seat is its only one.
    await seedInvitation(env, "unpaid-1", workspace.id, "unpaid@example.com", owner.id, "2099-01-01T00:00:00.000Z");
    const before = await snapshot(env, logs.lines);
    await refusal(await invite(env, client, cookie, workspace.id, "unpaid@example.com", true), NO_SEAT);
    await unchanged(env, logs.lines, before);

    // The same, after the paid seats are gone again.
    await endSubscription(env, workspace.id);
    const beforeEnd = await snapshot(env, logs.lines);
    await refusal(await invite(env, client, cookie, workspace.id, "unpaid@example.com", true), NO_SEAT);
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
    assert.equal((await invite(env, client, cookie, workspace.id, "kept@example.com", true)).status, 200);
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
    const client = "198.51.100.28";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const team = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, team.id, 4);

    const guestCookie = await signIn(env, logs.lines, "guest@example.com", client);
    const guestId = await env.DB.prepare(`SELECT id FROM user WHERE email = 'guest@example.com'`).first<{ id: string }>();
    assert.ok(guestId);
    const invitationsMade = ["guest-seat-0@example.com", "guest-seat-1@example.com", "guest-seat-2@example.com"];
    for (const email of invitationsMade) {
      assert.equal((await invite(env, client, cookie, team.id, email)).status, 200);
    }
    // The third invitation is the last one the four paid seats can take.
    assert.equal(await workspaceCount(env.DB, guestId.id), 0);
    assert.equal((await invite(env, client, cookie, team.id, "late@example.com")).status, 403);

    for (const email of invitationsMade) {
      const invitation = await env.DB.prepare(`SELECT id FROM invitation WHERE email = ?`).bind(email).first<{ id: string }>();
      assert.ok(invitation);
      const memberCookie = await signIn(env, logs.lines, email, client);
      assert.equal((await acceptInvitation(env, client, memberCookie, invitation.id)).status, 200);
    }
    assert.equal(await workspaceCount(env.DB, guestId.id), 0);
    // Three memberships elsewhere and no workspace of their own: create it.
    assert.equal((await createWorkspace(env, client, guestCookie, "Mine")).status, 200);
    assert.equal(await workspaceCount(env.DB, guestId.id), 1);
  } finally {
    logs.restore();
  }
});

test("an owner of three workspaces stays at three after joining a fourth as a member", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(database());
    const host = "198.51.100.29";
    const guestClient = "198.51.100.30";
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

    const ownerId = await env.DB.prepare(`SELECT id FROM user WHERE email = 'owner@example.com'`).first<{ id: string }>();
    assert.ok(ownerId);
    // The membership counted, and the owned workspace did not.
    assert.equal(await workspaceCount(env.DB, ownerId.id), 3);
    await refusal(await createWorkspace(env, host, ownerCookie, "Five"), NO_WORKSPACES);
  } finally {
    logs.restore();
  }
});

test("two workspace creates at the same moment leave one owned workspace behind", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(racingDatabase());
    const client = "198.51.100.31";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const seed = await createWorkspace(env, client, cookie, "One");
    const second = await createWorkspace(env, client, cookie, "Two");
    assert.equal(seed.status, 200);
    assert.equal(second.status, 200);
    const seeds = [((await seed.json()) as { id: string }).id, ((await second.json()) as { id: string }).id];
    for (let round = 0; round < 20; round += 1) {
      const clientAddress = `198.51.100.${100 + round}`;
      // Every round starts from the same account: the two workspaces it owns.
      await env.DB.prepare(`DELETE FROM organization WHERE id NOT IN (?, ?)`).bind(seeds[0], seeds[1]).run();
      const before = await rows(env, "organization");
      const [first, seconder] = await Promise.all([
        createWorkspace(env, clientAddress, cookie, `Race ${round} A`),
        createWorkspace(env, clientAddress, cookie, `Race ${round} B`),
      ]);
      const statuses = [first.status, seconder.status].sort();
      assert.deepEqual(statuses, [200, 403], `round ${round} answered ${statuses.join("/")}`);
      assert.equal(await rows(env, "organization"), before + 1, `round ${round} left ${(await rows(env, "organization")) - before} workspaces behind`);
      const ownerId = await env.DB.prepare(`SELECT id FROM user WHERE email = 'owner@example.com'`).first<{ id: string }>();
      assert.ok(ownerId);
      assert.equal(await workspaceCount(env.DB, ownerId.id), 3, `round ${round} owned too many`);
    }
  } finally {
    logs.restore();
  }
});

test("two invitations for the last seat at the same moment send one email", async () => {
  const logs = captureConsole();
  try {
    const env = bindings(racingDatabase());
    const client = "198.51.100.32";
    const cookie = await signIn(env, logs.lines, "owner@example.com", client);
    const workspace = (await (await createWorkspace(env, client, cookie, "Team")).json()) as { id: string };
    await subscribe(env, workspace.id, 2);
    for (let round = 0; round < 20; round += 1) {
      const clientAddress = `198.51.100.${200 + round}`;
      await env.DB.prepare(`DELETE FROM invitation`).run();
      const before = await snapshot(env, logs.lines);
      const [first, second] = await Promise.all([
        invite(env, clientAddress, cookie, workspace.id, `race-a-${round}@example.com`),
        invite(env, clientAddress, cookie, workspace.id, `race-b-${round}@example.com`),
      ]);
      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [200, 403], `round ${round} answered ${statuses.join("/")}`);
      assert.equal(await rows(env, "invitation"), before.rows + 1, `round ${round} left ${(await rows(env, "invitation")) - before.rows} invitations behind`);
      assert.equal(invitations(logs.lines).length, before.emails + 1, `round ${round} sent ${invitations(logs.lines).length - before.emails} emails`);
    }
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
