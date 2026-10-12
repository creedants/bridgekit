import { useSyncExternalStore } from "react";
import type { Config, Plan, User, Workspace } from "./account.ts";

/**
 * Whether this build, this deployment and this person may use AI commentary.
 *
 * The Workspace panel already learns the deployment's config, the session and
 * the open workspace's plan (see account.ts); this reads what those calls
 * learned instead of asking again, so deciding the panel adds no request.
 */

export type CommentaryPro = "unknown" | "signed-out" | "free" | "pro";
export type CommentaryOffer = "hidden" | "hint" | "button";

export interface CommentaryState {
  /** What the deployment offers. Null until the read lands or fails. */
  config: Config | null;
  /** Null when signed out, undefined until the session is known. */
  user: User | null | undefined;
  /** Null until the list lands or fails. Empty when the person has none. */
  workspaces: Workspace[] | null;
  /** The plan of each workspace the page has read. */
  plans: Record<string, Plan>;
}

let current: CommentaryState = { config: null, user: undefined, workspaces: null, plans: {} };
const listeners = new Set<() => void>();

function write(over: Partial<CommentaryState>): void {
  current = { ...current, ...over };
  for (const listener of listeners) listener();
}

/** Called by account.ts when a call lands, so the Workspace panel stays the single reader. */
export const noteConfig = (config: Config) => write({ config });
export const noteUser = (user: User | null) => write({ user });
export const noteWorkspaces = (workspaces: Workspace[]) => write({ workspaces });
export const notePlan = (id: string, plan: Plan) => write({ plans: { ...current.plans, [id]: plan } });
export const noteSignedOut = () => write({ user: null, workspaces: [], plans: {} });

export const commentarySnapshot = (): CommentaryState => current;
export const subscribeCommentary = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Pro on any workspace the page has read; anything unread stays unknown, which hides. */
export function commentaryPro(state: CommentaryState): CommentaryPro {
  if (state.user === undefined) return "unknown";
  if (state.user === null) return "signed-out";
  if (state.workspaces === null) return "unknown";
  // A signed-in person with no workspace has no membership, so no Pro.
  if (state.workspaces.length === 0) return "free";
  // Every workspace's plan has to be read before "free" is said out loud.
  if (state.workspaces.some((w) => !(w.id in state.plans))) return "unknown";
  return state.workspaces.some((w) => state.plans[w.id].pro) ? "pro" : "free";
}

export function commentaryPanel(enabled: boolean, config: Config | null, pro: CommentaryPro): CommentaryOffer {
  if (!enabled || !config?.commentary) return "hidden";
  if (pro === "pro") return "button";
  return pro === "free" ? "hint" : "hidden";
}

/** The panel decision for the build, the deployment and the signed-in person. */
export function useCommentaryOffer(): CommentaryOffer {
  const state = useSyncExternalStore(subscribeCommentary, commentarySnapshot);
  if (import.meta.env.VITE_AI_COMMENTARY !== "1") return "hidden";
  return commentaryPanel(true, state.config, commentaryPro(state));
}
