import type { BridgeSummary } from "../summary.ts";
import { useEffect, useState } from "react";
import { columnsKey, type Setup } from "./setup.ts";
import {
  beginRead,
  noteConfig,
  notePlan,
  notePlanUnknown,
  noteSignedOut,
  noteUser,
  noteUserUnknown,
  noteWorkspaces,
  noteWorkspacesUnknown,
} from "./useConfig.ts";

/**
 * Calls to the site's own server for Pro workspaces (server/worker.ts). Only
 * used in builds with VITE_WORKSPACES=1, and only after the user opens the
 * Workspace panel or signs in. Everything goes to the same origin.
 */

export interface Config {
  providers: ("microsoft" | "google")[];
  commentary: boolean;
  billing: boolean;
  email?: boolean;
}
export interface User {
  id: string;
  email: string;
  name: string;
}
export interface Workspace {
  id: string;
  name: string;
}
export interface Plan {
  pro: boolean;
  status: string | null;
  seats: number;
  currentPeriodEnd: string | null;
}
export interface Member {
  id: string;
  role: string;
  user: { email: string; name: string };
}
export interface Invitation {
  id: string;
  email: string;
  status: string;
}
export interface SavedSetup {
  id: string;
  name: string;
  setup: Setup;
  createdBy: string | null;
  createdAt: string;
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

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? body?.message ?? `The server returned ${response.status}.`);
  return body as T;
}

// Anything read from the deployment or the session is written to the shared
// note book (src/app/useConfig.ts), so the Workspace panel stays the only
// reader and no second call is made. A read takes a ticket from the note book
// before it starts, so an answer that belongs to an earlier person, or to an
// earlier read of the same fact, writes nothing. A session, workspace-list or
// plan read that fails hands back what it would have replaced; a config read
// has no failure writer, so a failed config read leaves the earlier config in
// place.
export const getConfig = async (): Promise<Config> => {
  const ticket = beginRead("config");
  const found = await call<Config>("/api/config");
  noteConfig(found, ticket);
  return found;
};

export async function getUser(): Promise<User | null> {
  const ticket = beginRead("session");
  try {
    const found = await call<{ user: User } | null>("/api/auth/get-session");
    noteUser(found?.user ?? null, ticket);
    return found?.user ?? null;
  } catch (error) {
    noteUserUnknown(ticket);
    throw error;
  }
}

const back = () => location.pathname + location.search;

export const emailSignIn = (email: string) =>
  call<{ status: boolean }>("/api/auth/sign-in/magic-link", { body: { email, callbackURL: back() } });

export async function providerSignIn(provider: "microsoft" | "google"): Promise<void> {
  const { url } = await call<{ url: string }>("/api/auth/sign-in/social", { body: { provider, callbackURL: back() } });
  location.href = url;
}

export const signOut = async () => {
  await call("/api/auth/sign-out", { body: {} });
  noteSignedOut();
};
export const deleteAccount = async () => {
  await call("/api/auth/delete-user", { body: {} });
  noteSignedOut();
};

export const listWorkspaces = async (): Promise<Workspace[]> => {
  const ticket = beginRead("workspaces");
  try {
    const found = await call<Workspace[]>("/api/auth/organization/list");
    noteWorkspaces(found, ticket);
    return found;
  } catch (error) {
    noteWorkspacesUnknown(ticket);
    throw error;
  }
};

export const createWorkspace = (name: string) =>
  call<Workspace>("/api/auth/organization/create", {
    body: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}` },
  });

/**
 * The workspace to show after a workspace list arrives. A preferred one, such
 * as the workspace a checkout was for, wins when it is in the list; otherwise
 * the one already on screen stays, and a first load takes the first workspace.
 */
export function preferredWorkspace(list: Workspace[], prefer: string | null | undefined, current: string): string {
  if (prefer && list.some((w) => w.id === prefer)) return prefer;
  return list.some((w) => w.id === current) ? current : (list[0]?.id ?? "");
}

export const getPlan = async (id: string): Promise<{ role: string; plan: Plan }> => {
  const ticket = beginRead(`plan/${id}`);
  try {
    const found = await call<{ role: string; plan: Plan }>(`/api/workspaces/${id}`);
    notePlan(id, found.plan, ticket);
    return found;
  } catch (error) {
    notePlanUnknown(id, ticket);
    throw error;
  }
};

export const getMembers = (id: string) =>
  call<{ members: Member[]; invitations: Invitation[] }>(`/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(id)}`);

export const invite = (id: string, email: string) =>
  call("/api/auth/organization/invite-member", { body: { organizationId: id, email, role: "member" } });

export const removeMember = (id: string, memberId: string) =>
  call("/api/auth/organization/remove-member", { body: { organizationId: id, memberIdOrEmail: memberId } });

export const acceptInvitation = (invitationId: string) =>
  call("/api/auth/organization/accept-invitation", { body: { invitationId } });

interface SetupRow extends SavedSetup {
  columnsKey: string;
}

export function setupsForColumns<T extends { readonly columnsKey: string }>(saved: readonly T[], columns: readonly string[]): T[] {
  if (columns.length === 0) return [];
  const key = columnsKey(columns.slice());
  return saved.filter((row) => row.columnsKey === key);
}

export async function listSetups(id: string, columns: string[]): Promise<SavedSetup[]> {
  if (columns.length === 0) return [];
  const rows = await call<SetupRow[]>(`/api/workspaces/${id}/setups`);
  return setupsForColumns(rows, columns).map((row) => ({
    id: row.id,
    name: row.name,
    setup: row.setup,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));
}

export const saveSetup = (id: string, name: string, columns: string[], setup: Setup) =>
  call<{ id: string }>(`/api/workspaces/${id}/setups`, { body: { name, columns, setup } });

export const listBridges = (id: string) => call<SavedBridge[]>(`/api/workspaces/${id}/bridges`);

export const saveBridge = (id: string, body: { name: string; columns: string[]; setup: Setup; summary: BridgeSummary; filterColumns: string[] }) =>
  call<{ id: string }>(`/api/workspaces/${id}/bridges`, { body });

export const deleteSaved = (id: string, kind: "setups" | "bridges", item: string) =>
  call(`/api/workspaces/${id}/${kind}/${item}`, { method: "DELETE" });

export const checkout = (id: string, seats: number) =>
  call<{ checkoutUrl: string }>(`/api/workspaces/${id}/checkout`, { body: { seats } });

export const openPortal = (id: string) => call<{ portalUrl: string }>(`/api/workspaces/${id}/portal`, { method: "POST", body: {} });

/**
 * Whether the panel offers Manage billing instead of Subscribe. Active,
 * trialing, past due, paused and canceled-with-time-left workspaces manage
 * their existing subscription; a workspace with no row, or a canceled
 * workspace whose paid time has ended, can start a new one.
 */
export function hasManageBilling(status: string | null, pro: boolean): boolean {
  if (status === null) return false;
  if (status === "canceled" && !pro) return false;
  return true;
}

/** What the billing slot offers for one workspace. */
export interface BillingView {
  /** The Pro line, or null when the workspace has no Pro. */
  pro: string | null;
  /** The sentence a paused workspace sees, or null for every other state. */
  paused: string | null;
  /** Whether the slot offers Manage billing. */
  manage: boolean;
  /** Whether the slot offers Subscribe. */
  subscribe: boolean;
  /** Whether this role may open the portal or start a subscription. */
  canManage: boolean;
}

/**
 * The billing slot's contents, from the plan the server sent and the role of
 * the person looking. A workspace with a subscription row manages it; only a
 * workspace with no row, or one whose paid time has ended, sees Subscribe.
 */
export function billingView(plan: Plan | null, role: string | null, billing: boolean): BillingView {
  const canManage = role === "owner" || role === "admin";
  if (!plan) return { pro: null, paused: null, manage: false, subscribe: false, canManage };
  const pro = plan.pro
    ? `Pro, ${plan.seats} ${plan.seats === 1 ? "seat" : "seats"}${plan.status === "canceled" && plan.currentPeriodEnd ? `, ends ${plan.currentPeriodEnd.slice(0, 10)}` : ""}.`
    : null;
  const hasSubscription = hasManageBilling(plan.status, plan.pro);
  return {
    pro,
    paused: plan.status === "paused" ? "Your subscription is paused. Manage billing to resume it." : null,
    manage: hasSubscription && canManage && billing,
    subscribe: !hasSubscription,
    canManage,
  };
}

/** The sentence a checkout return shows while the confirmation is pending. */
export const PRO_WAITING_SENTENCE = "Thank you. Pro switches on as soon as Paddle confirms the payment, usually within a minute.";
/** The sentence a checkout return shows once the paid workspace has Pro. */
export const PRO_ON_SENTENCE = "Thank you. Pro is on.";

/** How long a checkout return waits for the confirmation. */
export const CHECKOUT_RETURN_MS = 90_000;
/** How often a checkout return asks for the plan. */
export const CHECKOUT_POLL_MS = 3000;

const CHECKOUT_WORKSPACE_KEY = "bridgekit.checkout-workspace";
let rememberedCheckoutWorkspace: string | null = null;

function session(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Remembers which workspace the browser left for Paddle. It lives in
 * sessionStorage so the return lands on the workspace that was paid for, and
 * it never leaves this tab. A browser that refuses storage still gets the
 * in-memory copy.
 */
export function rememberCheckoutWorkspace(id: string): void {
  rememberedCheckoutWorkspace = id;
  try {
    session()?.setItem(CHECKOUT_WORKSPACE_KEY, id);
  } catch {
    // Storage may be full or denied; the in-memory copy still holds it.
  }
}

export function recallCheckoutWorkspace(): string | null {
  try {
    const found = session()?.getItem(CHECKOUT_WORKSPACE_KEY);
    if (found) return found;
  } catch {
    // Fall through to the in-memory copy.
  }
  return rememberedCheckoutWorkspace;
}

export function forgetCheckoutWorkspace(): void {
  rememberedCheckoutWorkspace = null;
  try {
    session()?.removeItem(CHECKOUT_WORKSPACE_KEY);
  } catch {
    // Nothing was stored.
  }
}

/**
 * Checks the plan every 3 s for up to 90 s after a checkout return, until
 * Pro is on. Returns a stop function the panel calls when it unmounts or
 * when Pro arrives. A failed plan read never stops the wait.
 */
export function pollForPro(
  workspaceId: string,
  onPro: (found: { role: string; plan: Plan }) => void,
  opts?: {
    intervalMs?: number;
    timeoutMs?: number;
    getPlan?: (id: string) => Promise<{ role: string; plan: Plan }>;
  },
): () => void {
  const intervalMs = opts?.intervalMs ?? 3000;
  const timeoutMs = opts?.timeoutMs ?? 90000;
  const read = opts?.getPlan ?? getPlan;
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const found = await read(workspaceId);
      if (stopped) return;
      if (found.plan.pro) {
        stopped = true;
        clearInterval(timer);
        clearTimeout(limit);
        onPro(found);
      }
    } catch {
      // Keep polling through a transient plan read failure.
    }
  }, intervalMs);
  const limit = setTimeout(() => {
    stopped = true;
    clearInterval(timer);
  }, timeoutMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(limit);
  };
}

/**
 * The checkout return. Paddle sends the browser back to `?subscribed=1` for
 * every purchase, so the workspace is taken from the one the panel remembered
 * before it left for checkout. The 90 s deadline starts once, at the return,
 * and a workspace switch neither changes the workspace being watched nor
 * restarts the deadline. When that workspace's plan turns Pro, its plan is
 * handed to the panel and the sentence becomes the confirmation.
 */
export function useCheckoutReturn(options: {
  /** The workspace on screen. */
  active: string;
  /** The plan last read for the workspace on screen, if any. */
  activePlan: Plan | null;
  /** Whether an answer may be asked for yet, that is, the person is signed in. */
  enabled: boolean;
  /** Called with the plan of the paid workspace once it is Pro. */
  onPro: (found: { role: string; plan: Plan }) => void;
  /** The query string to read the return from. Defaults to the page's. */
  search?: string;
  now?: () => number;
  getPlan?: (id: string) => Promise<{ role: string; plan: Plan }>;
  pollMs?: number;
  windowMs?: number;
}): {
  /** The workspace the checkout was for, once a return is being handled. */
  returning: string | null;
  /** The sentence to show, or null when this is not a checkout return. */
  sentence: string | null;
} {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? CHECKOUT_RETURN_MS;
  const pollMs = options.pollMs ?? CHECKOUT_POLL_MS;
  const read = options.getPlan ?? getPlan;
  const search = options.search ?? (typeof location === "undefined" ? "" : location.search);
  const [state, setState] = useState<{ workspace: string; deadline: number; paid: boolean } | null>(() => {
    if (!new URLSearchParams(search).has("subscribed")) return null;
    return { workspace: recallCheckoutWorkspace() ?? "", deadline: now() + windowMs, paid: false };
  });

  function settle(workspace: string, found?: { role: string; plan: Plan }) {
    forgetCheckoutWorkspace();
    setState((current) => (current && current.workspace === workspace ? { ...current, paid: true } : current));
    if (found) options.onPro(found);
  }

  // Adopt the workspace already on screen when the return carried no
  // remembered one, for example an older checkout link opened in a new tab.
  useEffect(() => {
    if (!state || state.workspace || !options.active) return;
    setState({ ...state, workspace: options.active });
  }, [state?.workspace, options.active]);

  // A plan read the panel already made for the paid workspace settles the
  // return without another request.
  useEffect(() => {
    if (!state || state.paid || !state.workspace) return;
    if (options.active !== state.workspace || !options.activePlan?.pro) return;
    settle(state.workspace);
  }, [state?.workspace, state?.paid, options.active, options.activePlan?.pro]);

  // Poll the paid workspace, whatever is on screen, until Pro arrives or the
  // single deadline that started at the return passes.
  useEffect(() => {
    if (!state || state.paid || !options.enabled || !state.workspace) return;
    const remaining = state.deadline - now();
    if (remaining <= 0) return;
    return pollForPro(
      state.workspace,
      (found) => settle(state.workspace, found),
      { intervalMs: pollMs, timeoutMs: remaining, getPlan: read },
    );
  }, [state?.workspace, state?.paid, state?.deadline, options.enabled]);

  return {
    returning: state?.workspace || null,
    sentence: state ? (state.paid ? PRO_ON_SENTENCE : PRO_WAITING_SENTENCE) : null,
  };
}
