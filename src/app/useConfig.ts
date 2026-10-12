import { useEffect, useState, useSyncExternalStore } from "react";
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
 * Two rules keep an out-of-date answer off the screen. Every read takes a
 * ticket for the fact it reads when it starts, and its answer or its failure
 * is written only while that ticket is still the newest for the fact and the
 * session it began in is still the current one, so an earlier answer never
 * overwrites a later one. Anything that makes the person uncertain, or a
 * different person signing in, drops every workspace and plan and starts a new
 * session, so nothing already in flight can write and no later person inherits
 * an earlier person's facts.
 *
 * The record holds no clock. The decision is a pure function of the record and
 * the time it is read, and a cancelled subscription stops counting as Pro at
 * its end time under the rule hasPro uses (server/paddle.ts). The hook sets one
 * timer to judge again at that end, with no request.
 */

export type CommentaryPro = "unknown" | "signed-out" | "free" | "pro";
export type CommentaryOffer = "hidden" | "hint" | "button";

/** A fact this record remembers. One counter per fact keeps its reads in order. */
export type Fact = "config" | "session" | "workspaces" | `plan/${string}`;

/**
 * The ticket one read carries. Its answer or failure is written only while the
 * ticket is still the newest for the fact and the session it began in is still
 * the current one; anything older is dropped silently.
 */
export interface Ticket {
  fact: Fact;
  /** The number issued for that fact, so a newer read of it always wins. */
  number: number;
  /** The session the read began in, so a person change voids it. */
  session: number;
}

export interface CommentaryState {
  /** What the deployment offers. Null until the read lands. */
  config: Config | null;
  /** Null when signed out, undefined until the session is known or its read fails. */
  user: User | null | undefined;
  /** Null until the list lands or fails. Empty when the person has none. */
  workspaces: Workspace[] | null;
  /** The plan of each workspace the page has read. */
  plans: Record<string, Plan>;
}

let current: CommentaryState = { config: null, user: undefined, workspaces: null, plans: {} };
const listeners = new Set<() => void>();
/** The newest ticket issued for each fact. */
const newest: Partial<Record<Fact, number>> = {};
/** Rises whenever the signed-in person changes or becomes uncertain. */
let generation = 0;

function write(over: Partial<CommentaryState>): void {
  current = { ...current, ...over };
  for (const listener of listeners) listener();
}

/** Called by account.ts when a call starts, so its answer can be checked against what is read since. */
export function beginRead(fact: Fact): Ticket {
  const number = (newest[fact] ?? 0) + 1;
  newest[fact] = number;
  return { fact, number, session: generation };
}

/** Whether the read that carries the ticket may still write. */
function stillNewest({ fact, number, session }: Ticket): boolean {
  return session === generation && number === newest[fact];
}

/**
 * Drops every workspace and plan and starts a new session, so nothing in
 * flight can write and no later person inherits the earlier person's facts.
 */
function startOver(user: User | null | undefined): void {
  generation += 1;
  write({ user, workspaces: null, plans: {} });
}

/** Called by account.ts when a read lands, so the Workspace panel stays the single reader. */
export const noteConfig = (config: Config, ticket: Ticket) => {
  if (stillNewest(ticket)) write({ config });
};

export function noteUser(user: User | null, ticket: Ticket): void {
  if (!stillNewest(ticket)) return;
  // A different person signing in starts from nothing.
  if (current.user !== undefined && current.user?.id !== (user?.id ?? null)) startOver(user);
  else write({ user });
}

/** Called by account.ts when the session read fails: the person is no longer trusted. */
export const noteUserUnknown = (ticket: Ticket) => {
  if (stillNewest(ticket)) startOver(undefined);
};

export const noteSignedOut = () => startOver(null);

export function noteWorkspaces(workspaces: Workspace[], ticket: Ticket): void {
  if (stillNewest(ticket)) write({ workspaces });
}

/** Called by account.ts when a read fails: the answer it would have replaced is no longer trusted. */
export const noteWorkspacesUnknown = (ticket: Ticket) => {
  if (stillNewest(ticket)) write({ workspaces: null });
};

export function notePlan(id: string, plan: Plan, ticket: Ticket): void {
  if (stillNewest(ticket)) write({ plans: { ...current.plans, [id]: plan } });
}

/** Called by account.ts when a read fails: that workspace's plan is unknown again. */
export const notePlanUnknown = (id: string, ticket: Ticket) => {
  if (!stillNewest(ticket)) return;
  write({ plans: Object.fromEntries(Object.entries(current.plans).filter(([known]) => known !== id)) });
};

export const commentarySnapshot = (): CommentaryState => current;
export const subscribeCommentary = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether a plan still counts as Pro at the time given: the rule hasPro uses (server/paddle.ts). */
function planIsPro(plan: Plan, now: number): boolean {
  switch (plan.status) {
    case "active":
    case "trialing":
    case "past_due":
      return true;
    case "canceled": {
      if (!plan.currentPeriodEnd) return false;
      const end = Date.parse(plan.currentPeriodEnd);
      return Number.isFinite(end) && now < end;
    }
    case "paused":
      return false;
    default:
      return plan.pro;
  }
}

/** Pro on any workspace the page has read; anything unread stays unknown, which hides. */
export function commentaryPro(state: CommentaryState, now: number = Date.now()): CommentaryPro {
  if (state.user === undefined) return "unknown";
  if (state.user === null) return "signed-out";
  if (state.workspaces === null) return "unknown";
  // A signed-in person with no workspace has no membership, so no Pro.
  if (state.workspaces.length === 0) return "free";
  const read = state.workspaces.filter((w) => w.id in state.plans);
  // One workspace read as Pro is enough, whatever the rest have not said yet.
  if (read.some((w) => planIsPro(state.plans[w.id], now))) return "pro";
  // "free" is only said once every workspace's plan has been read.
  return read.length === state.workspaces.length ? "free" : "unknown";
}

export function commentaryPanel(enabled: boolean, config: Config | null, pro: CommentaryPro): CommentaryOffer {
  if (!enabled || !config?.commentary) return "hidden";
  if (pro === "pro") return "button";
  return pro === "free" ? "hint" : "hidden";
}

/** The earliest known end of a cancelled subscription that is still ahead. */
function nextExpiry(state: CommentaryState, now: number): number | null {
  let at: number | null = null;
  for (const plan of Object.values(state.plans)) {
    if (plan.status !== "canceled" || !plan.currentPeriodEnd) continue;
    const end = Date.parse(plan.currentPeriodEnd);
    if (!Number.isFinite(end) || end <= now) continue;
    if (at === null || end < at) at = end;
  }
  return at;
}

/** The longest delay a browser timer takes before it overflows. */
export const TIMER_MAX = 2_147_483_647;

/**
 * One timer for a known end time, re-armed until that time has passed. Each
 * fire asks for a judgement again, and no delay exceeds what a browser timer
 * can hold, so a cancelled period far in the future still gets a timer that
 * lands on its end. Only the timer and the clock are injected, so a test can
 * drive it without sleeping.
 */
export function expiryTimer(
  at: number,
  now: () => number,
  arm: (delay: number, fire: () => void) => () => void,
  again: () => void,
): () => void {
  let stop: () => void = () => {};
  const rearm = () => {
    stop = arm(Math.max(0, Math.min(at - now(), TIMER_MAX)), () => {
      again();
      if (now() < at) rearm();
    });
  };
  rearm();
  return () => stop();
}

/** One timer per known end time, so the page judges again when it passes. */
function useExpiryClock(state: CommentaryState): void {
  const at = nextExpiry(state, Date.now());
  const [armed, setArmed] = useState(0);
  useEffect(() => {
    if (at === null) return;
    return expiryTimer(at, Date.now, (delay, fire) => {
      const timer = setTimeout(fire, delay);
      return () => clearTimeout(timer);
    }, () => setArmed((count) => count + 1));
  }, [at, armed]);
}

/** The panel decision for the build, the deployment and the signed-in person. */
export function useCommentaryOffer(): CommentaryOffer {
  const state = useSyncExternalStore(subscribeCommentary, commentarySnapshot);
  useExpiryClock(state);
  if (import.meta.env.VITE_AI_COMMENTARY !== "1") return "hidden";
  return commentaryPanel(true, state.config, commentaryPro(state, Date.now()));
}
