import type { BridgeSummary } from "../summary.ts";
import type { Setup } from "./setup.ts";
import { noteConfig, notePlan, noteSignedOut, noteUser, noteWorkspaces } from "./useConfig.ts";

/**
 * Calls to the site's own server for Pro workspaces (server/worker.ts). Only
 * used in builds with VITE_WORKSPACES=1, and only after the user opens the
 * Workspace panel or signs in. Everything goes to the same origin.
 */

export interface Config {
  providers: ("microsoft" | "google")[];
  commentary: boolean;
  billing: boolean;
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
// reader and no second call is made.
export const getConfig = async (): Promise<Config> => {
  const found = await call<Config>("/api/config");
  noteConfig(found);
  return found;
};

export async function getUser(): Promise<User | null> {
  const found = await call<{ user: User } | null>("/api/auth/get-session");
  noteUser(found?.user ?? null);
  return found?.user ?? null;
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
export const deleteAccount = () => call("/api/auth/delete-user", { body: {} });

export const listWorkspaces = async (): Promise<Workspace[]> => {
  const found = await call<Workspace[]>("/api/auth/organization/list");
  noteWorkspaces(found);
  return found;
};

export const createWorkspace = (name: string) =>
  call<Workspace>("/api/auth/organization/create", {
    body: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}` },
  });

export const getPlan = async (id: string): Promise<{ role: string; plan: Plan }> => {
  const found = await call<{ role: string; plan: Plan }>(`/api/workspaces/${id}`);
  notePlan(id, found.plan);
  return found;
};

export const getMembers = (id: string) =>
  call<{ members: Member[]; invitations: Invitation[] }>(`/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(id)}`);

export const invite = (id: string, email: string) =>
  call("/api/auth/organization/invite-member", { body: { organizationId: id, email, role: "member" } });

export const removeMember = (id: string, memberId: string) =>
  call("/api/auth/organization/remove-member", { body: { organizationId: id, memberIdOrEmail: memberId } });

export const acceptInvitation = (invitationId: string) =>
  call("/api/auth/organization/accept-invitation", { body: { invitationId } });

export const listSetups = (id: string, columns: string[]) =>
  call<SavedSetup[]>(`/api/workspaces/${id}/setups?${columns.map((c) => "column=" + encodeURIComponent(c)).join("&")}`);

export const saveSetup = (id: string, name: string, columns: string[], setup: Setup) =>
  call<{ id: string }>(`/api/workspaces/${id}/setups`, { body: { name, columns, setup } });

export const listBridges = (id: string) => call<SavedBridge[]>(`/api/workspaces/${id}/bridges`);

export const saveBridge = (id: string, body: { name: string; columns: string[]; setup: Setup; summary: BridgeSummary; filterColumns: string[] }) =>
  call<{ id: string }>(`/api/workspaces/${id}/bridges`, { body });

export const deleteSaved = (id: string, kind: "setups" | "bridges", item: string) =>
  call(`/api/workspaces/${id}/${kind}/${item}`, { method: "DELETE" });

export const checkout = (id: string, seats: number) =>
  call<{ checkoutUrl: string }>(`/api/workspaces/${id}/checkout`, { body: { seats } });
