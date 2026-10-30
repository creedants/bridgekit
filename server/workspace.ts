import { APIError } from "better-auth/api";
import { columnsKey, isValidSetup, MAX_COLUMN_NAME, MAX_COLUMNS, type Setup } from "../src/app/setup.ts";
import { parseSummary, type BridgeSummary } from "../src/summary.ts";
import type { D1Database } from "./cloudflare.ts";
import {
  cancelSubscription,
  chooseSubscription,
  hasPro,
  listWorkspaceSubscriptions,
  PaddleReadError,
  type PaddleAccount,
  type SubscriptionChange,
  type SubscriptionEvent,
  type SubscriptionStatus,
} from "./paddle.ts";

/**
 * What a workspace saves: setups (without filter values) and bridge totals.
 * Every function takes the signed-in user's id and checks membership itself,
 * so a route cannot forget to.
 */

export class WorkspaceError extends Error {
  readonly status: 400 | 402 | 403 | 404 | 409;
  constructor(status: 400 | 402 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Plan {
  pro: boolean;
  status: SubscriptionStatus | null;
  seats: number;
  currentPeriodEnd: string | null;
}

export async function plan(db: D1Database, workspaceId: string, now = new Date()): Promise<Plan> {
  const row = await db
    .prepare(`SELECT status, seats, currentPeriodEnd FROM subscription WHERE organizationId = ?`)
    .bind(workspaceId)
    .first<{ status: SubscriptionStatus; seats: number; currentPeriodEnd: string | null }>();
  if (!row) return { pro: false, status: null, seats: 1, currentPeriodEnd: null };
  const pro = hasPro(row.status, row.currentPeriodEnd, now);
  return { pro, status: row.status, seats: pro ? row.seats : 1, currentPeriodEnd: row.currentPeriodEnd };
}

/**
 * The most workspaces one account may own. This is an abuse bound, not a plan
 * feature: it stops a free account from creating workspaces without limit.
 */
export const MAX_WORKSPACES_PER_USER = 3;

/** What a refused creation and a refused invitation answer with. */
export const WORKSPACE_LIMIT_SENTENCE = `You can own up to ${MAX_WORKSPACES_PER_USER} workspaces, so delete one before creating another.`;
export const SEAT_LIMIT_SENTENCE = "This workspace has no free seat, so cancel a pending invitation or add seats.";
/**
 * What a refused account deletion answers with when Paddle cannot cancel a
 * live subscription. server/auth.ts and server/worker.ts are outside this
 * module, so the sentence lives here; better-call answers a thrown APIError
 * with its message, which carries it to the caller without a translator.
 */
export const SUBSCRIPTION_CANCEL_SENTENCE = "We could not cancel your subscription, so your account has not been deleted; try again later.";

/**
 * How many invitation emails a workspace may send in a rolling 24 hours. The
 * count lives in D1's invitation_send ledger, which migrations/0006_invite_limits.sql
 * writes from the invitation table and guards with the same number.
 */
export const INVITATIONS_PER_DAY = 20;
export const INVITATION_RATE_SENTENCE = `This workspace has sent ${INVITATIONS_PER_DAY} invitations in the last 24 hours. Try again tomorrow.`;

/**
 * Whether one more invitation email fits the rolling 24 hours. The window and
 * the clock are D1's, the same expressions the ledger's guard uses, so the
 * pre-check and the trigger cannot disagree about the boundary.
 */
export async function invitationSendAllowed(db: D1Database, workspaceId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM invitation_send WHERE organizationId = ? AND sentAt > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`,
    )
    .bind(workspaceId)
    .first<{ n: number }>();
  return (row?.n ?? 0) < INVITATIONS_PER_DAY;
}

/** The workspaces the account owns. Memberships in other people's workspaces
 * cost nothing here: joining a colleague's workspace must not use up the
 * account's own allowance. Deleting an owned workspace lowers this. */
export async function workspaceCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT organizationId) AS n FROM member WHERE userId = ? AND instr(',' || replace(role, ' ', '') || ',', ',owner,') > 0`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Paid seats still open for new invitations. Current members and live pending
 * invitations each hold a seat, so an owner cannot queue more invitations than
 * the workspace has seats. A cancelled or expired invitation holds none.
 *
 * `exceptInvitationId` is the invitation being re-sent: it already holds its
 * seat, so it is not counted against the workspace it is sent from.
 */
export async function freeSeats(
  db: D1Database,
  workspaceId: string,
  now = new Date(),
  exceptInvitationId?: string,
): Promise<number> {
  const { seats } = await plan(db, workspaceId, now);
  const members = await db.prepare(`SELECT COUNT(*) AS n FROM member WHERE organizationId = ?`).bind(workspaceId).first<{ n: number }>();
  const { results } = await db
    .prepare(`SELECT id, expiresAt FROM invitation WHERE organizationId = ? AND status = 'pending'`)
    .bind(workspaceId)
    .all<{ id: string; expiresAt: string }>();
  const pending = results.filter((invitation) => invitation.id !== exceptInvitationId && new Date(invitation.expiresAt) > now).length;
  return seats - (members?.n ?? 0) - pending;
}

/**
 * Whether an invitation Better Auth's route is about to take has a seat. A
 * re-sent invitation already holds its seat, so it is not counted twice; the
 * route looks the live pending row up by address and workspace, and only when
 * the body asks for a re-send. When it finds none it writes a new invitation,
 * which has to find a seat of its own.
 */
export async function invitationHasSeat(db: D1Database, workspaceId: string, body: { email?: unknown; resend?: unknown }): Promise<boolean> {
  if (!body.resend || typeof body.email !== "string") return (await freeSeats(db, workspaceId)) > 0;
  const row = await db
    .prepare(`SELECT id FROM invitation WHERE organizationId = ? AND email = ? AND status = 'pending' AND datetime(expiresAt) > datetime('now')`)
    .bind(workspaceId, body.email.toLowerCase())
    .first<{ id: string }>();
  return (await freeSeats(db, workspaceId, new Date(), row?.id)) > 0;
}

/** The member's role, or a 404 that does not reveal whether the workspace exists. */
export async function membership(db: D1Database, userId: string, workspaceId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT role FROM member WHERE organizationId = ? AND userId = ?`)
    .bind(workspaceId, userId)
    .first<{ role: string }>();
  if (!row) throw new WorkspaceError(404, "Workspace not found.");
  return row.role;
}

async function requirePro(db: D1Database, workspaceId: string): Promise<void> {
  if (!(await plan(db, workspaceId)).pro) {
    throw new WorkspaceError(402, "Saving to a workspace needs a Pro subscription.");
  }
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function parseColumns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COLUMNS || !value.every((c) => text(c, MAX_COLUMN_NAME))) {
    throw new WorkspaceError(400, "The column list is missing or too long.");
  }
  return value;
}

/** What a refused save setup answers with, whether it fails validation or a save-shape bound. */
const SETUP_MISMATCH_SENTENCE = "That setup does not match the columns.";

/**
 * The save-shape bounds that belong to the server alone: the browser keeps
 * setups with longer names and repeated columns. One set spans every level, so
 * a column repeated inside one level is refused too.
 */
function checkSetupShape(setup: Setup, columns: string[]): void {
  const used = new Set<string>();
  for (const level of setup.levels) {
    if (level.name.length > MAX_COLUMN_NAME) throw new WorkspaceError(400, SETUP_MISMATCH_SENTENCE);
    for (const column of level.columns) {
      if (used.has(column)) throw new WorkspaceError(400, SETUP_MISMATCH_SENTENCE);
      used.add(column);
    }
  }
  // Redundant with the set above while every level names a column of the file,
  // and kept as the save's own bound.
  if (setup.levels.length > columns.length) throw new WorkspaceError(400, SETUP_MISMATCH_SENTENCE);
}

/** A setup as stored: valid for these columns and with no filter values, which come from the data. */
function parseSetup(value: unknown, columns: string[]): Setup {
  if (!isValidSetup(value, columns.map((name) => ({ name, type: "" })))) {
    throw new WorkspaceError(400, SETUP_MISMATCH_SENTENCE);
  }
  checkSetupShape(value, columns);
  if (value.filters.length > 0) throw new WorkspaceError(400, "Filter selections are not saved to a workspace.");
  return value;
}

export interface SavedSetup {
  id: string;
  name: string;
  setup: Setup;
  createdBy: string | null;
  createdAt: string;
  columnsKey: string;
}

export const COLUMN_QUERY_SENTENCE = "This request does not take column names.";

export type SetupListQuery = "absent" | "present";

export function setupListQuery(url: string): SetupListQuery {
  return new URL(url).searchParams.has("column") ? "present" : "absent";
}

export async function listSetups(db: D1Database, userId: string, workspaceId: string, query: SetupListQuery): Promise<SavedSetup[]> {
  await membership(db, userId, workspaceId);
  if (query === "present") throw new WorkspaceError(400, COLUMN_QUERY_SENTENCE);
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.setup, s.columnsKey, COALESCE(NULLIF(u.name, ''), u.email) AS createdBy, s.createdAt FROM saved_setup s
       LEFT JOIN user u ON u.id = s.createdBy
       WHERE s.organizationId = ? ORDER BY s.createdAt DESC`,
    )
    .bind(workspaceId)
    .all<Omit<SavedSetup, "setup"> & { setup: string }>();
  return results.map((r) => ({ ...r, setup: JSON.parse(r.setup) as Setup }));
}

const SAVED_SETUP_CAP = 50;
const SAVED_SETUP_FULL = `This workspace has ${SAVED_SETUP_CAP} saved setups. Delete one to save another.`;

/** The most bridges one workspace keeps; the same atomic count-then-insert as setups. */
const SAVED_BRIDGE_CAP = 100;
const SAVED_BRIDGE_FULL = `This workspace has ${SAVED_BRIDGE_CAP} saved bridges. Delete one to save another.`;

export async function saveSetup(db: D1Database, userId: string, workspaceId: string, body: unknown, now = new Date()): Promise<{ id: string }> {
  await membership(db, userId, workspaceId);
  await requirePro(db, workspaceId);
  const input = (body ?? {}) as { name?: unknown; columns?: unknown; setup?: unknown };
  if (!text(input.name, 120)) throw new WorkspaceError(400, "Give the setup a name of up to 120 characters.");
  const columns = parseColumns(input.columns);
  const setup = parseSetup(input.setup, columns);
  const id = crypto.randomUUID();
  const { meta } = await db
    .prepare(
      `INSERT INTO saved_setup (id, organizationId, name, columnsKey, setup, createdBy, createdAt)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM saved_setup WHERE organizationId = ?) < ?`,
    )
    .bind(id, workspaceId, input.name.trim(), columnsKey(columns), JSON.stringify(setup), userId, now.toISOString(), workspaceId, SAVED_SETUP_CAP)
    .run();
  if (meta.changes !== 1) throw new WorkspaceError(409, SAVED_SETUP_FULL);
  return { id };
}

export interface SavedBridge {
  id: string;
  name: string;
  summary: BridgeSummary;
  setup: Setup;
  filterColumns: string[];
  createdBy: string | null;
  createdAt: string;
}

export async function listBridges(db: D1Database, userId: string, workspaceId: string): Promise<SavedBridge[]> {
  await membership(db, userId, workspaceId);
  const { results } = await db
    .prepare(
      `SELECT b.id, b.name, b.summary, b.setup, b.filterColumns, COALESCE(NULLIF(u.name, ''), u.email) AS createdBy, b.createdAt FROM saved_bridge b
       LEFT JOIN user u ON u.id = b.createdBy
       WHERE b.organizationId = ? ORDER BY b.createdAt DESC LIMIT 200`,
    )
    .bind(workspaceId)
    .all<{ id: string; name: string; summary: string; setup: string; filterColumns: string; createdBy: string | null; createdAt: string }>();
  return results.map((r) => ({
    ...r,
    summary: JSON.parse(r.summary) as BridgeSummary,
    setup: JSON.parse(r.setup) as Setup,
    filterColumns: JSON.parse(r.filterColumns) as string[],
  }));
}

export async function saveBridge(db: D1Database, userId: string, workspaceId: string, body: unknown, now = new Date()): Promise<{ id: string }> {
  await membership(db, userId, workspaceId);
  await requirePro(db, workspaceId);
  const input = (body ?? {}) as { name?: unknown; columns?: unknown; setup?: unknown; summary?: unknown; filterColumns?: unknown };
  if (!text(input.name, 120)) throw new WorkspaceError(400, "Give the bridge a name of up to 120 characters.");
  const columns = parseColumns(input.columns);
  const setup = parseSetup(input.setup, columns);
  const summary = parseSummary(input.summary);
  if (!summary) throw new WorkspaceError(400, "Only bridge totals can be saved.");
  const filterColumns = input.filterColumns ?? [];
  if (!Array.isArray(filterColumns) || !filterColumns.every((c) => columns.includes(c))) {
    throw new WorkspaceError(400, "Filtered columns must be columns of the file.");
  }
  const id = crypto.randomUUID();
  const { meta } = await db
    .prepare(
      `INSERT INTO saved_bridge (id, organizationId, name, summary, setup, filterColumns, createdBy, createdAt)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM saved_bridge WHERE organizationId = ?) < ?`,
    )
    .bind(
      id,
      workspaceId,
      input.name.trim(),
      JSON.stringify(summary),
      JSON.stringify(setup),
      JSON.stringify(filterColumns),
      userId,
      now.toISOString(),
      workspaceId,
      SAVED_BRIDGE_CAP,
    )
    .run();
  if (meta.changes !== 1) throw new WorkspaceError(409, SAVED_BRIDGE_FULL);
  return { id };
}

/** Deleting needs membership but not Pro, so a lapsed workspace can still clear out what it saved. */
export async function deleteSaved(db: D1Database, userId: string, workspaceId: string, kind: "setup" | "bridge", id: string): Promise<void> {
  await membership(db, userId, workspaceId);
  const table = kind === "setup" ? "saved_setup" : "saved_bridge";
  const { meta } = await db.prepare(`DELETE FROM ${table} WHERE id = ? AND organizationId = ?`).bind(id, workspaceId).run();
  if (!meta.changes) throw new WorkspaceError(404, "Not found.");
}

/** Whether the user belongs to at least one Pro workspace: the gate for AI commentary. */
export async function userHasPro(db: D1Database, userId: string, now = new Date()): Promise<boolean> {
  const { results } = await db
    .prepare(`SELECT organizationId FROM member WHERE userId = ?`)
    .bind(userId)
    .all<{ organizationId: string }>();
  for (const { organizationId } of results) {
    if ((await plan(db, organizationId, now)).pro) return true;
  }
  return false;
}

export async function assertCheckoutOpen(db: D1Database, workspaceId: string, now = new Date()): Promise<void> {
  const row = await db
    .prepare(`SELECT status, currentPeriodEnd FROM subscription WHERE organizationId = ?`)
    .bind(workspaceId)
    .first<{ status: SubscriptionStatus; currentPeriodEnd: string | null }>();
  if (!row) return;
  if (row.status !== "canceled") throw new WorkspaceError(409, "This workspace already has a subscription.");
  if (hasPro(row.status, row.currentPeriodEnd, now)) throw new WorkspaceError(409, "This workspace already has a subscription.");
}

/**
 * Writes the one subscription row for a workspace. `lastEventAt` is when the
 * read behind this row began for rows written by syncSubscription; older rows
 * hold a Paddle occurred_at and still compare correctly. Comparing as instants
 * (julianday) keeps mixed ISO precisions in order. syncSubscription is its only
 * server caller.
 */
export async function applySubscription(db: D1Database, change: SubscriptionChange): Promise<"applied" | "stale" | "unknown-workspace"> {
  const workspace = await db.prepare(`SELECT id FROM organization WHERE id = ?`).bind(change.workspaceId).first();
  if (!workspace) return "unknown-workspace";
  const { meta } = await db
    .prepare(
      `INSERT INTO subscription (organizationId, paddleSubscriptionId, paddleCustomerId, status, priceId, seats, currentPeriodEnd, lastEventAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organizationId) DO UPDATE SET
         paddleSubscriptionId = excluded.paddleSubscriptionId, paddleCustomerId = excluded.paddleCustomerId,
         status = excluded.status, priceId = excluded.priceId, seats = excluded.seats,
         currentPeriodEnd = excluded.currentPeriodEnd, lastEventAt = excluded.lastEventAt
       WHERE julianday(excluded.lastEventAt) > julianday(subscription.lastEventAt)`,
    )
    .bind(
      change.workspaceId,
      change.subscriptionId,
      change.customerId,
      change.status,
      change.priceId,
      change.seats,
      change.currentPeriodEnd,
      change.occurredAt,
    )
    .run();
  return meta.changes ? "applied" : "stale";
}

export type SubscriptionSync = "applied" | "stale" | "conflict" | "unknown-workspace";

/**
 * Reconciles a workspace's subscription with Paddle's current state. The
 * webhook body only says where to look; Paddle's list of the whole account,
 * filtered to this workspace, decides what to store, so a late or out-of-order
 * event cannot replace a paying subscription and no earlier customer is
 * forgotten. A missing subscription or an unreadable list throws
 * PaddleReadError before anything is written, and the caller asks Paddle to
 * retry.
 *
 * A write the strict lastEventAt guard rejects is acknowledged as "stale" only
 * when the stored row already holds the state that read reported. Otherwise it
 * is a "conflict" and the caller refuses with 503, so Paddle's retry
 * reconciles again with a later read start and wins the guard once Paddle's
 * state has moved.
 */
export async function syncSubscription(
  db: D1Database,
  event: SubscriptionEvent,
  paddle: PaddleAccount,
  now: Date = new Date(),
): Promise<SubscriptionSync> {
  const workspace = await db.prepare(`SELECT id FROM organization WHERE id = ?`).bind(event.workspaceId).first();
  if (!workspace) return "unknown-workspace";
  const candidates = await listWorkspaceSubscriptions(paddle, event.workspaceId);
  const containing = candidates.find((candidate) => candidate.subscriptionId === event.subscriptionId);
  if (!containing) {
    // Paddle sends the webhook after it commits, so a missing id is lag or a
    // subscription that moved to another workspace. Retrying heals the first
    // and only logs the second; never blank the row from an incomplete read.
    throw new PaddleReadError(`Paddle does not list ${event.subscriptionId} for workspace ${event.workspaceId}.`);
  }
  const elected = chooseSubscription([containing, ...candidates.filter((candidate) => candidate !== containing)], now);
  const paying = candidates.filter((candidate) => hasPro(candidate.status, candidate.currentPeriodEnd, now));
  if (paying.length > 1) {
    console.error({
      message: "More than one paid subscription for a workspace.",
      workspaceId: event.workspaceId,
      subscriptionId: elected.subscriptionId,
      otherPayingSubscriptionIds: paying
        .filter((candidate) => candidate.subscriptionId !== elected.subscriptionId)
        .map((candidate) => candidate.subscriptionId),
    });
  }
  const change: SubscriptionChange = {
    subscriptionId: elected.subscriptionId,
    customerId: elected.customerId,
    workspaceId: elected.workspaceId,
    status: elected.status,
    priceId: elected.priceId,
    seats: elected.seats,
    currentPeriodEnd: elected.currentPeriodEnd,
    eventId: event.eventId,
    occurredAt: now.toISOString(),
  };
  const applied = await applySubscription(db, change);
  if (applied !== "stale") return applied;
  return (await storesSameState(db, change)) ? "stale" : "conflict";
}

/**
 * Whether the stored row already holds the state a rejected write tried to
 * record. One SELECT over the six state columns, so no second row type has to
 * track them. A matching row makes a duplicate delivery safe to acknowledge.
 */
async function storesSameState(db: D1Database, change: SubscriptionChange): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS same FROM subscription
       WHERE organizationId = ? AND paddleSubscriptionId IS ? AND paddleCustomerId IS ? AND status IS ?
         AND priceId IS ? AND seats IS ? AND currentPeriodEnd IS ?`,
    )
    .bind(
      change.workspaceId,
      change.subscriptionId,
      change.customerId,
      change.status,
      change.priceId,
      change.seats,
      change.currentPeriodEnd,
    )
    .first();
  return row !== null;
}

const SOLE_WORKSPACE_IDS = `SELECT organizationId FROM member WHERE userId = ? AND organizationId NOT IN (SELECT organizationId FROM member WHERE userId <> ?) ORDER BY organizationId`;

/**
 * Before an account is deleted: workspaces it is the only member of go with
 * it, saved items included. A live subscription is cancelled at Paddle first,
 * because deleting the row alone would leave it billing a workspace nobody can
 * reach. A refused cancel stops the whole deletion, so nothing is half gone.
 * The row is marked canceled once Paddle accepts, so a retry of the same
 * deletion sends no second request. Workspaces come in id order, so a retry
 * walks them in the same order.
 */
export async function deleteSoleWorkspaces(db: D1Database, userId: string, paddle: PaddleAccount | null = null): Promise<void> {
  const { results } = await db.prepare(SOLE_WORKSPACE_IDS).bind(userId, userId).all<{ organizationId: string }>();
  for (const { organizationId } of results) {
    const row = await db
      .prepare(`SELECT paddleSubscriptionId, status FROM subscription WHERE organizationId = ?`)
      .bind(organizationId)
      .first<{ paddleSubscriptionId: string; status: SubscriptionStatus }>();
    if (!row || row.status === "canceled") continue;
    if (!paddle) throw new APIError("SERVICE_UNAVAILABLE", { message: SUBSCRIPTION_CANCEL_SENTENCE });
    try {
      await cancelSubscription({
        apiKey: paddle.apiKey,
        environment: paddle.environment,
        subscriptionId: row.paddleSubscriptionId,
        fetch: paddle.fetch,
      });
    } catch {
      throw new APIError("SERVICE_UNAVAILABLE", { message: SUBSCRIPTION_CANCEL_SENTENCE });
    }
    await db.prepare(`UPDATE subscription SET status = 'canceled' WHERE organizationId = ?`).bind(organizationId).run();
  }
  await db.prepare(`DELETE FROM organization WHERE id IN (${SOLE_WORKSPACE_IDS})`).bind(userId, userId).run();
}
