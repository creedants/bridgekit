import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import { transformSync } from "esbuild";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import {
  hasManageBilling,
  recallCheckoutWorkspace,
  rememberCheckoutWorkspace,
} from "../src/app/account.ts";
import { testDatabase } from "./support/d1.ts";

const ORIGIN = "http://127.0.0.1:8790";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const OWNER = "owner@example.invalid";

let clients = 0;
function clientIp(): string {
  clients += 1;
  return `203.0.113.${(clients % 254) + 1}`;
}

function record(): { lines: string[]; sent: { url: string; init: RequestInit }[]; restore(): void } {
  const lines: string[] = [];
  const sent: { url: string; init: RequestInit }[] = [];
  const previous = { debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  for (const method of ["debug", "info", "log", "warn", "error"] as const) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    sent.push({ url, init: init ?? {} });
    if (url !== "https://api.resend.com/emails") return original(input, init);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    lines,
    sent,
    restore() {
      Object.assign(console, previous);
      globalThis.fetch = original;
    },
  };
}

function database(): Env["DB"] {
  const db = testDatabase();
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    exec: (sql) => db.exec(sql),
  };
}

function mailEnv(db: Env["DB"], fields: Partial<Env> = {}, base: string = ORIGIN): Env {
  return {
    ASSETS: {
      async fetch() {
        return new Response("missing", { status: 500 });
      },
    },
    DB: db,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: AUTH_SECRET,
    ACCOUNTS: "on",
    ...fields,
  };
}

function authPrefix(baseURL: string): string {
  const pathname = new URL(baseURL).pathname;
  return pathname === "/" ? "/api/auth" : pathname.replace(/\/+$/, "");
}

async function call(url: string, env: Env, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(new Request(url, init), env, {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  });
  await Promise.all(pending);
  return response;
}

async function signIn(db: Env["DB"], email: string, base: string = ORIGIN): Promise<string> {
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, base);
  const origin = new URL(base).origin;
  const prefix = authPrefix(base);
  const recorded = record();
  try {
    const started = await call(`${origin}${prefix}/sign-in/magic-link`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": clientIp() },
      body: JSON.stringify({ email, callbackURL: `${ORIGIN}/app/` }),
    });
    assert.equal(started.status, 200, await started.text());
    const link = recorded.lines
      .join("\n")
      .match(new RegExp(`http://127\\.0\\.0\\.1:8790${prefix.replaceAll("/", "\\/")}/magic-link/verify\\?\\S+`))?.[0];
    assert.ok(link, "the sign-in link was not written to the log");
    const verified = await call(link, env, { headers: { origin: ORIGIN, "x-forwarded-for": clientIp() } });
    assert.equal(verified.status, 302, await verified.text());
    const cookie = verified.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.notEqual(cookie, "", "the verification set no session cookie");
    return cookie;
  } finally {
    recorded.restore();
  }
}

async function session(base: string = ORIGIN): Promise<{ db: Env["DB"]; cookie: string; workspaceId: string }> {
  const db = database();
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, base);
  const origin = new URL(base).origin;
  const prefix = authPrefix(base);
  const recorded = record();
  try {
    const signInRes = await call(`${origin}${prefix}/sign-in/magic-link`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": clientIp() },
      body: JSON.stringify({ email: OWNER, callbackURL: `${ORIGIN}/app/` }),
    });
    assert.equal(signInRes.status, 200, await signInRes.text());
    const link = recorded.lines
      .join("\n")
      .match(new RegExp(`http://127\\.0\\.0\\.1:8790${prefix.replaceAll("/", "\\/")}/magic-link/verify\\?\\S+`))?.[0];
    assert.ok(link, "the sign-in link was not written to the log");
    const verified = await call(link, env, { headers: { origin: ORIGIN, "x-forwarded-for": clientIp() } });
    assert.equal(verified.status, 302, await verified.text());
    const cookie = verified.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.notEqual(cookie, "", "the verification set no session cookie");
    const created = await call(`${origin}${prefix}/organization/create`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie, "x-forwarded-for": clientIp() },
      body: JSON.stringify({ name: "Portal test", slug: "portal-test" }),
    });
    const createdBody = await created.text();
    assert.equal(created.status, 200, createdBody);
    const workspaceId = (JSON.parse(createdBody) as { id: string }).id;
    await db
      .prepare("INSERT INTO subscription VALUES (?, 'sub_portal', 'ctm_portal', 'active', 'pri_portal', 2, '2099-01-01T00:00:00Z', '2026-10-12T00:00:00Z')")
      .bind(workspaceId)
      .run();
    return { db, cookie, workspaceId };
  } finally {
    recorded.restore();
  }
}

const PORTAL_URL = "https://paddle.com/portal/session-1";

function installPortalFetch(mode: "ok" | "fail" | "no-url" = "ok"): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    calls.push(url);
    if (url.includes("/portal-sessions")) {
      if (mode === "fail") return new Response("{}", { status: 500 });
      if (mode === "no-url") return Response.json({ data: { id: "pstl_1" } });
      return Response.json({ data: { id: "pstl_1", urls: { general: { overview: PORTAL_URL } } } });
    }
    return original(input, init);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function postPortal(env: Env, workspaceId: string, cookie?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookie !== undefined) headers.cookie = cookie;
  const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/portal`, env, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  return { status: response.status, body: await response.json() };
}

test("an owner of a workspace with a subscription gets a portal URL", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  const portal = installPortalFetch("ok");
  try {
    const result = await postPortal(env, workspaceId, cookie);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { portalUrl: PORTAL_URL });
    assert.equal(portal.calls.filter((url) => url.includes("/portal-sessions")).length, 1);
    assert.ok(portal.calls[0].includes("/customers/ctm_portal/portal-sessions"));
  } finally {
    portal.restore();
  }
});

test("a signed-in member who is not an owner or admin is refused a portal URL", async () => {
  const { db, cookie, workspaceId } = await session();
  void cookie;
  const memberCookie = await signIn(db, "colleague@example.invalid");
  const user = await db.prepare("SELECT id FROM user WHERE email = ?").bind("colleague@example.invalid").first<{ id: string }>();
  assert.ok(user);
  await db
    .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)")
    .bind("member-colleague", workspaceId, user.id, "2026-10-12T00:00:00.000Z")
    .run();
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  const portal = installPortalFetch("ok");
  try {
    const before = portal.calls.length;
    const result = await postPortal(env, workspaceId, memberCookie);
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: "Only a workspace owner or admin can subscribe." });
    assert.equal(portal.calls.length, before);
  } finally {
    portal.restore();
  }
});

test("a workspace with no subscription is refused a portal URL", async () => {
  const { db, cookie, workspaceId } = await session();
  const removed = await db.prepare("DELETE FROM subscription WHERE organizationId = ?").bind(workspaceId).run();
  assert.equal(removed.meta.changes, 1);
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  const portal = installPortalFetch("ok");
  try {
    const before = portal.calls.length;
    const result = await postPortal(env, workspaceId, cookie);
    assert.equal(result.status, 404);
    assert.equal(portal.calls.length, before);
  } finally {
    portal.restore();
  }
});

test("a Paddle failure gives a plain error and no crash", async () => {
  const { db, cookie, workspaceId } = await session();
  const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key" });
  for (const mode of ["fail", "no-url"] as const) {
    const portal = installPortalFetch(mode);
    try {
      const result = await postPortal(env, workspaceId, cookie);
      assert.equal(result.status, 502);
      assert.deepEqual(result.body, { error: "Could not open the billing portal. Try again." });
    } finally {
      portal.restore();
    }
  }
});

test("a second checkout for a canceled workspace with paid time left is refused", async () => {
  const { db, cookie, workspaceId } = await session();
  const updated = await db.prepare("UPDATE subscription SET status = 'canceled' WHERE organizationId = ?").bind(workspaceId).run();
  assert.equal(updated.meta.changes, 1);
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    calls.push(url);
    return Response.json({ data: { id: "txn_test", checkout: { url: "https://pay.example.com/checkout?_ptxn=txn_test" } } }, { status: 201 });
  }) as typeof fetch;
  try {
    const env = mailEnv(db, { PADDLE_API_KEY: "pdl_test_key", PADDLE_PRICE_ID: "pri_portal" });
    const response = await call(`${ORIGIN}/api/workspaces/${workspaceId}/checkout`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie },
      body: JSON.stringify({ seats: 1 }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "This workspace already has a subscription." });
    assert.equal(calls.filter((url) => url.includes("paddle.com")).length, 0);
  } finally {
    globalThis.fetch = original;
  }
});


test("hasManageBilling covers existing subscriptions, no row, and expired cancellation", () => {
  const live: [string, boolean][] = [
    ["active", true],
    ["trialing", true],
    ["past_due", true],
    ["paused", true],
    ["canceled", true],
  ];
  for (const [status, pro] of live) {
    if (status === "canceled" && !pro) continue;
    assert.equal(hasManageBilling(status, pro), true, `${status} pro=${pro}`);
  }
  assert.equal(hasManageBilling(null, false), false);
  assert.equal(hasManageBilling("canceled", false), false);
});

// The real WorkspacePanel.tsx is mounted below. This runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already depends on, and the panel then runs exactly as the app runs
// it: same effects, same polling, same markup.

class ShimNode {
  nodeType: number;
  nodeName: string;
  childNodes: ShimNode[] = [];
  parentNode: ShimNode | null = null;
  private listeners = new Map<string, Set<(event: { type: string; target?: unknown; bubbles?: boolean }) => void>>();

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): ShimNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): ShimNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): ShimNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[at + 1] ?? null;
  }

  get previousSibling(): ShimNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return at > 0 ? this.parentNode.childNodes[at - 1] : null;
  }

  appendChild(child: ShimNode): ShimNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: ShimNode, before: ShimNode | null): ShimNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before === null ? -1 : this.childNodes.indexOf(before);
    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: ShimNode): ShimNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) {
      this.childNodes.splice(at, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, listener: (event: { type: string; target?: unknown; bubbles?: boolean }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: { type: string; target?: unknown; bubbles?: boolean }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string; target?: unknown; bubbles?: boolean }): boolean {
    event.target = event.target ?? this;
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return true;
  }
}

class ShimText extends ShimNode {
  data: string;

  constructor(data: string) {
    super(3, "#text");
    this.data = String(data);
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(value: string) {
    this.data = String(value);
  }

  get textContent(): string {
    return this.data;
  }
}

class ShimElement extends ShimNode {
  tagName: string;
  localName: string;
  attributes = new Map<string, string>();
  style: Record<string, unknown> = { setProperty() {} };

  constructor(tagName: string) {
    super(1, String(tagName).toUpperCase());
    this.tagName = this.nodeName;
    this.localName = String(tagName).toLowerCase();
  }

  get namespaceURI(): string {
    return "http://www.w3.org/1999/xhtml";
  }

  get ownerDocument(): ShimElement {
    return document as unknown as ShimElement;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(String(name), String(value));
  }

  setAttributeNS(_namespace: string, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(String(name)) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(String(name));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(String(name));
  }

  get options(): ShimElement[] {
    return this.childNodes.filter((child) => child.nodeName === "OPTION") as ShimElement[];
  }

  get selectedOptions(): ShimElement[] {
    return this.options.filter((option) => (option as unknown as { selected?: boolean }).selected);
  }

  get textContent(): string {
    return this.childNodes.map((child) => (child as ShimElement).textContent ?? "").join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "" && value != null) this.appendChild(new ShimText(value));
  }
}

type ShimDocument = ShimElement & {
  createElement(tag: string): ShimElement;
  createElementNS(namespace: string, tag: string): ShimElement;
  createTextNode(text: string): ShimText;
  createComment(text: string): ShimText;
  documentElement: ShimElement;
  body: ShimElement;
  head: ShimElement;
  HTMLIFrameElement: unknown;
};

/** Installs the fake document once, before React DOM is imported. */
function installDom(): ShimDocument {
  const existing = (globalThis as unknown as { document?: ShimDocument }).document;
  if (existing) return existing;
  const doc = new ShimElement("#document") as unknown as ShimDocument;
  (doc as unknown as { nodeType: number }).nodeType = 9;
  doc.createElement = (tag: string) => new ShimElement(tag);
  doc.createElementNS = (_namespace: string, tag: string) => new ShimElement(tag);
  doc.createTextNode = (text: string) => new ShimText(text);
  doc.createComment = (text: string) => new ShimText(text);
  doc.documentElement = new ShimElement("html");
  doc.head = new ShimElement("head");
  doc.body = new ShimElement("body");
  doc.HTMLIFrameElement = class extends ShimElement {};
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  (doc as unknown as ShimNode).appendChild(doc.documentElement);
  const view = {
    document: doc,
    location: { href: "http://127.0.0.1:8790/app/", pathname: "/app/", search: "" },
    navigator: { userAgent: "node" },
    Event: class {
      type: string;
      constructor(type: string, init: Record<string, unknown> = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    Node: ShimNode,
    Element: ShimElement,
    HTMLElement: ShimElement,
    HTMLIFrameElement: doc.HTMLIFrameElement,
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = view;
  globals.document = doc;
  globals.Node = ShimNode;
  globals.Element = ShimElement;
  globals.HTMLElement = ShimElement;
  globals.HTMLIFrameElement = doc.HTMLIFrameElement;
  globals.Event = view.Event;
  globals.MutationObserver = view.MutationObserver;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return doc;
}


// The panel is loaded through esbuild, which the build already installs, so a
// .tsx file reaches this runner as the same module the app ships.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(new URL(url), "utf8");
      const { code } = transformSync(source, { loader: "tsx", format: "esm", jsx: "automatic" });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

type PlanRow = { role: string; plan: import("../src/app/account.ts").Plan };

interface FakeServer {
  workspaces: { id: string; name: string }[];
  plans: Record<string, PlanRow>;
  planReads: string[];
  checkout: "ok" | "fail" | "defer";
  checkoutReads: string[];
  fetch(path: string, init?: RequestInit): Promise<Response>;
  setPlan(id: string, row: PlanRow): void;
  /** Holds the next plan reply for id, computed now, until releaseHeld lets it land. */
  holdPlan(id: string, snapshot: PlanRow): void;
  /** Lets held plan replies for id land, oldest first. */
  releaseHeld(id: string): void;
  releaseCheckout(): void;
}

const free = (): PlanRow => ({ role: "owner", plan: { pro: false, status: null, seats: 1, currentPeriodEnd: null } });
const pro = (seats = 2): PlanRow => ({ role: "owner", plan: { pro: true, status: "active", seats, currentPeriodEnd: null } });

/** The panel's own API, answered in memory, with reads and replies the test controls. */
function fakeServer(options: {
  workspaces: { id: string; name: string }[];
  plans: Record<string, PlanRow>;
  checkout?: "ok" | "fail" | "defer";
}): FakeServer {
  const server: FakeServer = {
    workspaces: options.workspaces,
    plans: { ...options.plans },
    planReads: [],
    checkout: options.checkout ?? "ok",
    checkoutReads: [],
    setPlan(id, row) {
      server.plans[id] = row;
    },
    holdPlan(id, snapshot) {
      const queue = heldBlueprints.get(id) ?? [];
      queue.push(structuredClone(snapshot));
      heldBlueprints.set(id, queue);
    },
    releaseHeld(id) {
      const waiting = inFlight.filter((entry) => entry.id === id);
      for (const entry of waiting) {
        const at = inFlight.indexOf(entry);
        if (at >= 0) inFlight.splice(at, 1);
      }
      for (const entry of waiting) entry.release();
    },
    releaseCheckout() {
      const waiting = pendingCheckout.splice(0);
      for (const release of waiting) release();
    },
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      const url = String(path);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/config") return json({ providers: [], email: true, commentary: false, billing: true });
      if (url === "/api/auth/get-session") return json({ user: { id: "u1", email: "a@b.c", name: "A" } });
      if (url === "/api/auth/organization/list") return json(server.workspaces);
      const plan = url.match(/^\/api\/workspaces\/([^/]+)$/);
      if (plan) {
        const id = plan[1];
        server.planReads.push(id);
        // A held reply was computed when the test held it, so releasing it
        // later lands that snapshot, never the server's newer state.
        const blueprints = heldBlueprints.get(id);
        if (blueprints && blueprints.length > 0) {
          const snapshot = blueprints.shift()!;
          if (blueprints.length === 0) heldBlueprints.delete(id);
          let release!: () => void;
          const waiter = new Promise<void>((resolve) => {
            release = resolve;
          });
          inFlight.push({ id, release, waiter });
          await waiter;
          const at = inFlight.findIndex((entry) => entry.release === release);
          if (at >= 0) inFlight.splice(at, 1);
          return json(snapshot);
        }
        return json(server.plans[id]);
      }
      const bridges = url.match(/^\/api\/workspaces\/([^/]+)\/bridges$/);
      if (bridges) return json([]);
      const checkout = url.match(/^\/api\/workspaces\/([^/]+)\/checkout$/);
      if (checkout) {
        server.checkoutReads.push(checkout[1]);
        if (server.checkout === "defer") {
          await new Promise<void>((resolve) => pendingCheckout.push(resolve));
          return json({ checkoutUrl: "https://pay.example.com/checkout?_ptxn=txn_test" });
        }
        if (server.checkout === "fail") return json({ error: "The server returned 502." }, 502);
        return json({ checkoutUrl: "https://pay.example.com/checkout?_ptxn=txn_test" });
      }
      if (init?.method === "POST" && url.endsWith("/portal")) return json({ portalUrl: "https://paddle.com/portal/session" });
      return json({ error: `unexpected ${url}` }, 500);
    },
  };
  const heldBlueprints = new Map<string, PlanRow[]>();
  const inFlight: { id: string; release: () => void; waiter: Promise<void> }[] = [];
  const pendingCheckout: (() => void)[] = [];
  return server;
}

/** Mounts the real WorkspacePanel over the fake server and returns handles on it. */
async function mountPanel(options: { server: FakeServer; search: string; strict?: boolean }) {
  const doc = installDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: WorkspacePanel } = await import("../src/app/Workspace.tsx");
  const globals = globalThis as unknown as Record<string, unknown>;
  const clock = { t: 0 };
  const location = { href: `http://127.0.0.1:8790/app/${options.search}`, pathname: "/app/", search: options.search };
  globals.location = location;
  globals.history = { replaceState() {}, pushState() {} };
  globals.fetch = options.server.fetch as unknown as typeof fetch;
  void clock;

  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as ShimNode);
  const root = createRoot(container as unknown as Element);
  const act = async (work: () => void | Promise<void>) => {
    await React.act(async () => {
      await work();
    });
  };
  const panel = React.createElement(WorkspacePanel, { columns: [], setup: null, bridge: null, onUseSetup() {} });
  await act(async () => {
    root.render(options.strict ? React.createElement(React.StrictMode, null, panel) : panel);
  });
  const flush = async () => {
    await act(async () => {});
    await act(async () => {});
  };
  const text = () => (container as unknown as ShimElement).textContent;
  const find = (node: ShimNode | null, name: string): ShimNode | null => {
    if (!node) return null;
    if (node.nodeName === name) return node;
    for (const child of node.childNodes) {
      const found = find(child, name);
      if (found) return found;
    }
    return null;
  };
  const collect = (node: ShimNode | null, name: string, out: ShimNode[] = []): ShimNode[] => {
    if (!node) return out;
    if (node.nodeName === name) out.push(node);
    for (const child of node.childNodes) collect(child, name, out);
    return out;
  };
  return {
    text,
    shows: (sentence: string) => text().includes(sentence),
    chose: async (id: string) => {
      const select = find(container, "SELECT") as unknown as ShimElement & { value: string };
      assert.ok(select, "the workspace selector is on screen");
      // Replace React's value tracker with a plain property, so the change is
      // seen the way a person's selection would be.
      Object.defineProperty(select, "value", { value: id, writable: true, configurable: true });
      await act(async () => {
        select.dispatchEvent({ type: "change", bubbles: true, target: select });
      });
      await flush();
    },
    press: async (label: string) => {
      const button = collect(container, "BUTTON").find((candidate) => (candidate as ShimElement).textContent === label);
      assert.ok(button, `the panel offers a button named ${label}`);
      await act(async () => {
        button.dispatchEvent({ type: "click", bubbles: true, target: button });
      });
      await flush();
    },
    async advance(ms: number) {
      await act(async () => {
        mock.timers.tick(ms);
      });
      await flush();
    },
    async unmount() {
      await React.act(async () => {
        root.unmount();
      });
      doc.body.removeChild(container as unknown as ShimNode);
    },
  };
}

const PRO_SENTENCE = "Thank you. Pro is on.";
const WAITING_SENTENCE = "Thank you. Pro switches on as soon as Paddle confirms the payment, usually within a minute.";
const PAUSED_SENTENCE = "Your subscription is paused. Manage billing to resume it.";

/** The stored checkout marker, read the same way before and after it gains an owner token. */
function storedMarker(): string | null {
  const found = recallCheckoutWorkspace() as unknown as { workspace?: string; id?: string } | string | null;
  if (!found) return null;
  if (typeof found === "string") return found;
  return found.workspace ?? found.id ?? null;
}

function markerFor(id: string): void {
  rememberCheckoutWorkspace(id);
}

const TWO = [
  { id: "w1", name: "First" },
  { id: "w2", name: "Second" },
];

test("the checkout return selects the workspace that was paid for", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: pro(2) } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows("Pro, 2 seats."), true, panel.text());
    assert.equal(panel.shows("Manage billing"), true, panel.text());
    assert.equal(panel.shows("Subscribe"), false, panel.text());
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a poll for the checkout workspace never changes the plan on screen", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    await panel.chose("w1");
    assert.equal(panel.shows("Subscribe"), true, panel.text());
    server.setPlan("w2", pro(9));
    await panel.advance(3000);
    assert.equal(panel.shows("Pro, 9 seats."), false, panel.text());
    assert.equal(panel.shows("Subscribe"), true, panel.text());
    await panel.chose("w2");
    assert.equal(panel.shows("Pro, 9 seats."), true, panel.text());
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a previous workspace's plan cannot confirm or stop the return", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: pro(2), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    await panel.chose("w1");
    assert.equal(panel.shows("Pro, 2 seats."), true, panel.text());
    assert.equal(panel.shows(PRO_SENTENCE), false, panel.text());
    server.holdPlan("w2", free());
    await panel.chose("w2");
    assert.equal(panel.shows(PRO_SENTENCE), false, panel.text());
    assert.equal(panel.shows("Pro, 2 seats."), false, panel.text());
    server.releaseHeld("w2");
    await panel.advance(3000);
    assert.equal(panel.shows(PRO_SENTENCE), false, panel.text());
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    const readAfterReturn = server.planReads.filter((id) => id === "w2").length;
    await panel.advance(3000);
    assert.ok(server.planReads.filter((id) => id === "w2").length > readAfterReturn, "polling must continue for a free checkout workspace");
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("the checkout marker is cleared at the deadline", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    assert.equal(storedMarker(), "w2");
    await panel.advance(93_000);
    assert.equal(storedMarker(), null);
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("an early unmount stops the return and clears its marker", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    await panel.advance(3000);
    const readsAtUnmount = server.planReads.length;
    await panel.unmount();
    assert.equal(storedMarker(), null);
    await panel.advance(120_000);
    assert.equal(server.planReads.length, readsAtUnmount, "a request followed the unmount");
  } finally {
    mock.timers.reset();
  }
});

test("a checkout that fails records no marker", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("sentinel");
    const server = fakeServer({ workspaces: [{ id: "w1", name: "First" }], plans: { w1: free() }, checkout: "fail" });
    const panel = await mountPanel({ server, search: "" });
    await panel.press("Subscribe");
    assert.equal(server.checkoutReads.join(","), "w1");
    assert.equal(storedMarker(), "sentinel");
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("an older return cannot clear a newer checkout's marker", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    await panel.chose("w1");
    await panel.press("Subscribe");
    assert.equal(storedMarker(), "w1");
    server.setPlan("w2", pro(3));
    await panel.advance(3000);
    assert.equal(storedMarker(), "w1", "the older return cleared a newer checkout's marker");
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a return keeps the confirmation when Pro is already on", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: pro(2) } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows(WAITING_SENTENCE), false, panel.text());
    await panel.advance(30_000);
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a return replaces the waiting sentence when Pro arrives during polling", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    await panel.advance(3000);
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    server.setPlan("w2", pro(2));
    await panel.advance(3000);
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows(WAITING_SENTENCE), false, panel.text());
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a delayed free reply released after Pro never overwrites it", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    // The first poll's reply is already computed as free when Pro lands.
    server.holdPlan("w2", free());
    await panel.advance(3000);
    server.setPlan("w2", pro(2));
    await panel.advance(3000);
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows("Pro, 2 seats."), true, panel.text());
    assert.equal(panel.shows("Subscribe"), false, panel.text());
    assert.equal(storedMarker(), null);
    // The older free reply lands after the newer Pro reply settled the return.
    server.releaseHeld("w2");
    await panel.advance(0);
    assert.equal(panel.shows("Pro, 2 seats."), true, panel.text());
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows("Subscribe"), false, panel.text());
    assert.equal(panel.shows("Manage billing"), true, panel.text());
    // No timer remains to repair it: polling stopped with the confirmation.
    const reads = server.planReads.length;
    await panel.advance(60_000);
    assert.equal(server.planReads.length, reads, "polling continued after Pro was confirmed");
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a free reply released in the same turn as Pro never overwrites it", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    // The first poll is already computed as Pro and the second as free, from
    // before the server changed, and both land in the same turn.
    server.holdPlan("w2", pro(2));
    await panel.advance(3000);
    server.holdPlan("w2", free());
    await panel.advance(3000);
    server.releaseHeld("w2");
    await panel.advance(0);
    assert.equal(panel.shows("Pro, 2 seats."), true, panel.text());
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows("Subscribe"), false, panel.text());
    assert.equal(panel.shows("Manage billing"), true, panel.text());
    assert.equal(storedMarker(), null);
    const reads = server.planReads.length;
    await panel.advance(60_000);
    assert.equal(server.planReads.length, reads, "polling continued after Pro was confirmed");
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("the return keeps one 90 s deadline across a workspace switch", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1" });
    await panel.advance(30_000);
    await panel.chose("w1");
    const readsAtSwitch = server.planReads.filter((id) => id === "w2").length;
    await panel.advance(60_000);
    const atLimit = server.planReads.filter((id) => id === "w2").length;
    assert.equal(atLimit - readsAtSwitch, 20, `the remaining 60 s is 20 polls: ${server.planReads.join(",")}`);
    await panel.advance(60_000);
    assert.equal(server.planReads.filter((id) => id === "w2").length, atLimit, "polling continued past the deadline");
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a paused workspace renders the paused sentence and Manage billing only", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const paused: PlanRow = { role: "owner", plan: { pro: false, status: "paused", seats: 2, currentPeriodEnd: null } };
    const server = fakeServer({ workspaces: [{ id: "w1", name: "First" }], plans: { w1: paused } });
    const panel = await mountPanel({ server, search: "" });
    assert.equal(panel.shows(PAUSED_SENTENCE), true, panel.text());
    assert.equal(panel.shows("Manage billing"), true, panel.text());
    assert.equal(panel.shows("Subscribe"), false, panel.text());
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("StrictMode's double mount keeps the return working and clears its record once", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    markerFor("w2");
    const server = fakeServer({ workspaces: TWO, plans: { w1: free(), w2: free() } });
    const panel = await mountPanel({ server, search: "?subscribed=1", strict: true });
    assert.equal(storedMarker(), "w2", "the second mount still has the record");
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    server.setPlan("w2", pro(2));
    await panel.advance(3000);
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(storedMarker(), null);
    await panel.unmount();
  } finally {
    mock.timers.reset();
  }
});
