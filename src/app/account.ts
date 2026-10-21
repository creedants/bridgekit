import type { BridgeSummary } from "../summary.ts";
import { useEffect, useRef, useState } from "react";
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

/** A checkout this tab started: which workspace, and which checkout owns it. */
export interface CheckoutMarker {
  workspace: string;
  token: string;
}

let storedMarker: CheckoutMarker | null = null;

function session(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readStored(): CheckoutMarker | null {
  try {
    const raw = session()?.getItem(CHECKOUT_WORKSPACE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const { workspace, token } = parsed as { workspace?: unknown; token?: unknown };
      if (typeof workspace === "string" && typeof token === "string") return { workspace, token };
    }
  } catch {
    // A malformed record is treated as no record.
  }
  return null;
}

/**
 * Records the workspace this tab is about to pay for, and returns the token
 * that owns the record. It lives in sessionStorage, so the return lands on the
 * workspace that was paid for and it never leaves this tab. A browser that
 * refuses storage still gets the in-memory copy. Call it only after the
 * checkout request has succeeded, immediately before navigation.
 */
export function rememberCheckoutWorkspace(workspace: string): string {
  const token = crypto.randomUUID();
  storedMarker = { workspace, token };
  try {
    session()?.setItem(CHECKOUT_WORKSPACE_KEY, JSON.stringify(storedMarker));
  } catch {
    // Storage may be full or denied; the in-memory copy still holds it.
  }
  return token;
}

export function recallCheckoutWorkspace(): CheckoutMarker | null {
  return readStored() ?? storedMarker;
}

/**
 * Clears the record, but only the one this token owns. A slower checkout that
 * finishes, times out or unmounts after a newer one started cannot remove the
 * newer checkout's record.
 */
export function forgetCheckoutWorkspace(token: string): void {
  if (recallCheckoutWorkspace()?.token !== token) return;
  storedMarker = null;
  try {
    session()?.removeItem(CHECKOUT_WORKSPACE_KEY);
  } catch {
    // Nothing was stored.
  }
}

/** The phase of a checkout return. */
type ReturnPhase = "pending" | "paid" | "expired";

interface ReturnState {
  workspace: string;
  /** The token that owns the marker, or null for a return with no marker. */
  token: string | null;
  deadline: number;
  phase: ReturnPhase;
}

/**
 * The checkout return. Paddle sends the browser back to `?subscribed=1` for
 * every purchase, so the workspace comes from the record the panel wrote
 * before it left for checkout. Plans are keyed by workspace, so this hook
 * looks only at the checkout workspace's own plan, never the plan of whatever
 * is on screen, and it settles only on that plan turning Pro.
 *
 * One deadline starts at the return. It neither moves when another workspace
 * is selected nor restarts, and at the deadline the poll stops and the record
 * is cleared. The record is also cleared when the workspace has Pro, and when
 * the panel unmounts. Every clear is by token, so an older return cannot
 * remove a newer checkout's record.
 */
export function useCheckoutReturn(options: {
  /** The workspace on screen, used only when a return carried no record. */
  active: string;
  /** Plans read so far, keyed by workspace. */
  plans: Record<string, { role: string; plan: Plan }>;
  /** Applies a plan read to the workspace it was read for. */
  onPlan: (workspaceId: string, found: { role: string; plan: Plan }) => void;
  /** Whether an answer may be asked for yet, that is, the person is signed in. */
  enabled: boolean;
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
  const pollMs = options.pollMs ?? CHECKOUT_POLL_MS;
  const windowMs = options.windowMs ?? CHECKOUT_RETURN_MS;
  const read = options.getPlan ?? getPlan;
  const search = options.search ?? (typeof location === "undefined" ? "" : location.search);
  const mounted = useRef(false);
  const [state, setState] = useState<ReturnState | null>(() => {
    if (!new URLSearchParams(search).has("subscribed")) return null;
    const marker = recallCheckoutWorkspace();
    if (!marker) return { workspace: "", token: null, deadline: now() + windowMs, phase: "pending" };
    return { workspace: marker.workspace, token: marker.token, deadline: now() + windowMs, phase: "pending" };
  });

  // Adopt the workspace already on screen when the return carried no record,
  // for example an older checkout link opened in a new tab.
  useEffect(() => {
    if (!state || state.workspace || !options.active) return;
    setState({ ...state, workspace: options.active });
  }, [state?.workspace, options.active]);

  // Settle only on the checkout workspace's own plan.
  const checkoutPro = state?.workspace ? options.plans[state.workspace]?.plan.pro === true : false;
  useEffect(() => {
    if (!state || state.phase !== "pending" || !state.workspace || !checkoutPro) return;
    if (state.token) forgetCheckoutWorkspace(state.token);
    setState({ ...state, phase: "paid" });
  }, [state?.workspace, state?.phase, checkoutPro]);

  // Poll the checkout workspace until its plan is Pro or the deadline passes.
  useEffect(() => {
    if (!state || state.phase !== "pending" || !options.enabled || !state.workspace) return;
    const target = state.workspace;
    const poll = setInterval(() => {
      void read(target).then(
        (found) => {
          options.onPlan(target, found);
          if (found.plan.pro) {
            if (state.token) forgetCheckoutWorkspace(state.token);
            setState((current) => (current && current.phase === "pending" ? { ...current, phase: "paid" } : current));
          }
        },
        () => {
          // A failed read keeps the wait going until the deadline.
        },
      );
    }, pollMs);
    return () => clearInterval(poll);
  }, [state?.workspace, state?.phase, state?.deadline, options.enabled]);

  // One deadline for the whole return, started when it first ran.
  useEffect(() => {
    if (!state || state.phase !== "pending") return;
    const remaining = state.deadline - now();
    if (remaining <= 0) {
      if (state.token) forgetCheckoutWorkspace(state.token);
      setState({ ...state, phase: "expired" });
      return;
    }
    const timer = setTimeout(() => {
      if (state.token) forgetCheckoutWorkspace(state.token);
      setState((current) => (current && current.phase === "pending" ? { ...current, phase: "expired" } : current));
    }, remaining);
    return () => clearTimeout(timer);
  }, [state?.phase, state?.deadline]);

  // A real unmount clears the record. The cleanup runs only on unmount, never
  // on a phase change, and it clears the record in a microtask so StrictMode's
  // immediate remount, which runs a cleanup and an effect back to back, does
  // not clear a record the second mount still needs.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = state?.token ?? null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const token = tokenRef.current;
      queueMicrotask(() => {
        if (!mounted.current && token) forgetCheckoutWorkspace(token);
      });
    };
  }, []);

  return {
    returning: state?.workspace || null,
    sentence: !state ? null : state.phase === "paid" ? PRO_ON_SENTENCE : PRO_WAITING_SENTENCE,
  };
}
