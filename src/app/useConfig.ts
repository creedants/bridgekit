import { useEffect, useSyncExternalStore } from "react";
import type { Config, Plan, User, Workspace } from "./account.ts";

/**
 * Whether this build, this deployment and this person may use AI commentary.
 *
 * The Workspace panel already learns the deployment's config, the session and
 * the open workspace's plan (see account.ts); this reads what those calls
 * learned instead of asking again, so deciding the panel adds no request to
 * any /api/ path. Only the Cloudflare build loads this module, and it loads it
 * as one extra script file of its own from this site; the free static build
 * contains it too and makes no /api/ request.
 *
 * The facts belong to one person. A read that failed leaves what it would have
 * replaced unknown; a different person signing in drops the workspaces and
 * plans of the previous one; an answer that began before a sign-out or a change
 * of person writes nothing. A cancelled subscription stops counting as Pro at
 * its end time, judged with the rule hasPro uses (server/paddle.ts), and the
 * hook sets one timer to judge again then, with no request.
 */

export type CommentaryPro = "unknown" | "signed-out" | "free" | "pro";
export type CommentaryOffer = "hidden" | "hint" | "button";

export interface CommentaryState {
  /** What the deployment offers. Null until the read lands or fails. */
  config: Config | null;
  /** Null when signed out, undefined until the session is known or its read fails. */
  user: User | null | undefined;
  /** Null until the list lands or fails. Empty when the person has none. */
  workspaces: Workspace[] | null;
  /** The plan of each workspace the page has read. */
  plans: Record<string, Plan>;
  /** The time the decision is judged against. Each write stamps it; the timer moves it on. */
  clock: number;
}

let current: CommentaryState = { config: null, user: undefined, workspaces: null, plans: {}, clock: Date.now() };
const listeners = new Set<() => void>();
/** Rises whenever the signed-in person changes, so an answer from an earlier session writes nothing. */
let generation = 0;

function write(over: Partial<CommentaryState>): void {
  current = { ...current, ...over, clock: Date.now() };
  for (const listener of listeners) listener();
}

/** Called by account.ts when a call starts, so its answer can be checked against the session it belongs to. */
export const beginRead = (): number => generation;

/** Called by account.ts when a call lands, so the Workspace panel stays the single reader. */
export const noteConfig = (config: Config) => write({ config });

export function noteUser(user: User | null, session: number): void {
  if (session !== generation) return;
  // A different person signing in, or a person signing out, starts from nothing.
  if (current.user !== undefined && current.user?.id !== (user?.id ?? null)) {
    generation += 1;
    write({ user, workspaces: null, plans: {} });
    return;
  }
  write({ user });
}

/** Called by account.ts when a read fails: the answer it would have replaced is no longer trusted. */
export const noteUserUnknown = (session: number) => {
  if (session === generation) write({ user: undefined });
};

export const noteSignedOut = () => {
  generation += 1;
  write({ user: null, workspaces: [], plans: {} });
};

export function noteWorkspaces(workspaces: Workspace[], session: number): void {
  if (session === generation) write({ workspaces });
}

/** Called by account.ts when a read fails: the answer it would have replaced is no longer trusted. */
export const noteWorkspacesUnknown = (session: number) => {
  if (session === generation) write({ workspaces: null });
};

export function notePlan(id: string, plan: Plan, session: number): void {
  if (session === generation) write({ plans: { ...current.plans, [id]: plan } });
}

/** Called by account.ts when a read fails: that workspace's plan is unknown again. */
export const notePlanUnknown = (id: string, session: number) => {
  if (session !== generation) return;
  write({ plans: Object.fromEntries(Object.entries(current.plans).filter(([known]) => known !== id)) });
};

/** Called by the hook's timer when a known end time passes, so the decision is judged again with no request. */
export const noteClockAdvanced = () => write({ clock: Date.now() });

export const commentarySnapshot = (): CommentaryState => current;
export const subscribeCommentary = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether a plan still counts as Pro at the clock: the rule hasPro uses (server/paddle.ts). */
function planIsPro(plan: Plan, clock: number): boolean {
  switch (plan.status) {
    case "active":
    case "trialing":
    case "past_due":
      return true;
    case "canceled": {
      if (!plan.currentPeriodEnd) return false;
      const end = Date.parse(plan.currentPeriodEnd);
      return Number.isFinite(end) && clock < end;
    }
    case "paused":
      return false;
    default:
      return plan.pro;
  }
}

/** Pro on any workspace the page has read; anything unread stays unknown, which hides. */
export function commentaryPro(state: CommentaryState): CommentaryPro {
  if (state.user === undefined) return "unknown";
  if (state.user === null) return "signed-out";
  if (state.workspaces === null) return "unknown";
  // A signed-in person with no workspace has no membership, so no Pro.
  if (state.workspaces.length === 0) return "free";
  const read = state.workspaces.filter((w) => w.id in state.plans);
  // One workspace read as Pro is enough, whatever the rest have not said yet.
  if (read.some((w) => planIsPro(state.plans[w.id], state.clock))) return "pro";
  // "free" is only said once every workspace's plan has been read.
  return read.length === state.workspaces.length ? "free" : "unknown";
}

export function commentaryPanel(enabled: boolean, config: Config | null, pro: CommentaryPro): CommentaryOffer {
  if (!enabled || !config?.commentary) return "hidden";
  if (pro === "pro") return "button";
  return pro === "free" ? "hint" : "hidden";
}

/** When a known cancelled subscription ends, so the decision is judged again then. */
function nextExpiry(state: CommentaryState): number | null {
  let at: number | null = null;
  for (const plan of Object.values(state.plans)) {
    if (plan.status !== "canceled" || !plan.currentPeriodEnd) continue;
    const end = Date.parse(plan.currentPeriodEnd);
    if (!Number.isFinite(end) || end <= state.clock) continue;
    if (at === null || end < at) at = end;
  }
  return at;
}

/** One timer per known end time: it moves the clock on and asks for nothing. */
function useExpiryClock(state: CommentaryState): void {
  const at = nextExpiry(state);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(noteClockAdvanced, at - Date.now());
    return () => clearTimeout(timer);
  }, [at]);
}

/** The panel decision for the build, the deployment and the signed-in person. */
export function useCommentaryOffer(): CommentaryOffer {
  const state = useSyncExternalStore(subscribeCommentary, commentarySnapshot);
  useExpiryClock(state);
  if (import.meta.env.VITE_AI_COMMENTARY !== "1") return "hidden";
  return commentaryPanel(true, state.config, commentaryPro(state));
}
