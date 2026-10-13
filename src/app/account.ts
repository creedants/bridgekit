import type { BridgeSummary } from "../summary.ts";
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
