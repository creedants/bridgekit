import { columnsKey, isValidSetup, type Setup } from "../src/app/setup.ts";
import { parseSummary, type BridgeSummary } from "../src/summary.ts";
import type { D1Database } from "./cloudflare.ts";
import { hasPro, type SubscriptionChange, type SubscriptionStatus } from "./paddle.ts";

/**
 * What a workspace saves: setups (without filter values) and bridge totals.
 * Every function takes the signed-in user's id and checks membership itself,
 * so a route cannot forget to.
 */

export class WorkspaceError extends Error {
  readonly status: 400 | 402 | 403 | 404;
  constructor(status: 400 | 402 | 403 | 404, message: string) {
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
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000 || !value.every((c) => text(c, 300))) {
    throw new WorkspaceError(400, "The column list is missing or too long.");
  }
  return value;
}

/** A setup as stored: valid for these columns and with no filter values, which come from the data. */
function parseSetup(value: unknown, columns: string[]): Setup {
  if (!isValidSetup(value, columns.map((name) => ({ name, type: "" })))) {
    throw new WorkspaceError(400, "That setup does not match the columns.");
  }
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

export async function saveSetup(db: D1Database, userId: string, workspaceId: string, body: unknown, now = new Date()): Promise<{ id: string }> {
  await membership(db, userId, workspaceId);
  await requirePro(db, workspaceId);
  const input = (body ?? {}) as { name?: unknown; columns?: unknown; setup?: unknown };
  if (!text(input.name, 120)) throw new WorkspaceError(400, "Give the setup a name of up to 120 characters.");
  const columns = parseColumns(input.columns);
  const setup = parseSetup(input.setup, columns);
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO saved_setup (id, organizationId, name, columnsKey, setup, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, workspaceId, input.name.trim(), columnsKey(columns), JSON.stringify(setup), userId, now.toISOString())
    .run();
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
  await db
    .prepare(
      `INSERT INTO saved_bridge (id, organizationId, name, summary, setup, filterColumns, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, workspaceId, input.name.trim(), JSON.stringify(summary), JSON.stringify(setup), JSON.stringify(filterColumns), userId, now.toISOString())
    .run();
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

/**
 * Applies a Paddle subscription event. Paddle may deliver events out of
 * order, so an event older than the last one applied is ignored.
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
       WHERE excluded.lastEventAt > subscription.lastEventAt`,
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

/** Before an account is deleted: workspaces it is the only member of go with it, saved items included. */
export async function deleteSoleWorkspaces(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM organization WHERE id IN (
         SELECT organizationId FROM member WHERE userId = ?
         AND organizationId NOT IN (SELECT organizationId FROM member WHERE userId <> ?))`,
    )
    .bind(userId, userId)
    .run();
}
