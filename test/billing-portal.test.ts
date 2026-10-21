import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import {
  billingView,
  forgetCheckoutWorkspace,
  hasManageBilling,
  preferredWorkspace,
  rememberCheckoutWorkspace,
  useCheckoutReturn,
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

// A panel over the same state the Workspace panel renders, so the effects,
// the polling deadline and the sentences are exercised as a mounted tree. The
// panel's own file is .tsx, which this runner cannot import, so its shell is
// a thin call into the hook and view model below and a source check keeps it
// that way.

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

type PlanRow = { role: string; plan: import("../src/app/account.ts").Plan };

interface PanelOptions {
  workspaces: { id: string; name: string }[];
  /** The plan each workspace answers with, or a function of the read count. */
  plans: Record<string, PlanRow | ((reads: number, clock: number) => PlanRow)>;
  search: string;
  clock: { t: number };
  initialActive?: string;
}

/** Mounts the panel over the workspace state and returns what it shows. */
async function mountPanel(options: PanelOptions) {
  installDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const h = React.createElement;
  const reads: Record<string, number> = {};
  const getPlan = async (id: string) => {
    reads[id] = (reads[id] ?? 0) + 1;
    const row = options.plans[id];
    if (!row) return { role: "owner", plan: { pro: false, status: null, seats: 1, currentPeriodEnd: null } };
    return typeof row === "function" ? row(reads[id], options.clock.t) : row;
  };
  const switchTo: { current: ((id: string) => void) | null } = { current: null };

  function Panel() {
    const [active, setActive] = React.useState(options.initialActive ?? options.workspaces[0]?.id ?? "");
    const [plan, setPlan] = React.useState<PlanRow | null>(null);
    switchTo.current = setActive;
    const checkoutReturn = useCheckoutReturn({
      active,
      activePlan: plan?.plan ?? null,
      enabled: true,
      onPro: (found) => setPlan(found),
      search: options.search,
      now: () => options.clock.t,
      getPlan,
    });
    React.useEffect(() => {
      setActive((current) => preferredWorkspace(options.workspaces, checkoutReturn.returning, current));
    }, [checkoutReturn.returning]);
    React.useEffect(() => {
      let live = true;
      void getPlan(active).then((found) => {
        if (live) setPlan(found);
      });
      return () => {
        live = false;
      };
    }, [active]);
    const view = billingView(plan?.plan ?? null, plan?.role ?? null, true);
    return h(
      "div",
      null,
      view.pro ? h("p", { className: "hint" }, view.pro) : null,
      view.paused ? h("p", { className: "hint" }, view.paused) : null,
      view.manage ? h("button", null, "Manage billing") : null,
      view.subscribe ? h("div", null, h("button", null, "Subscribe")) : null,
      checkoutReturn.sentence ? h("p", { role: "status" }, checkoutReturn.sentence) : null,
    );
  }

  const doc = installDom();
  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as ShimNode);
  const root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root.render(h(Panel));
  });
  const act = async (work: () => void | Promise<void>) => {
    await React.act(async () => {
      await work();
    });
  };
  const text = () => (container as unknown as ShimElement).textContent;
  return {
    shows: (sentence: string) => text().includes(sentence),
    text,
    reads,
    act,
    async switchTo(id: string) {
      await act(() => switchTo.current?.(id));
    },
    /** Advances the fake timers and the return clock together. */
    async advance(ms: number) {
      options.clock.t += ms;
      await act(() => {
        mock.timers.tick(ms);
      });
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

const proRow = (seats = 2): PlanRow => ({ role: "owner", plan: { pro: true, status: "active", seats, currentPeriodEnd: null } });
const freeRow: PlanRow = { role: "owner", plan: { pro: false, status: null, seats: 1, currentPeriodEnd: null } };

test("the checkout return selects the workspace that was paid for", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  forgetCheckoutWorkspace();
  rememberCheckoutWorkspace("w2");
  try {
    const panel = await mountPanel({
      workspaces: [{ id: "w1", name: "First" }, { id: "w2", name: "Second" }],
      plans: { w1: freeRow, w2: proRow(2) },
      search: "?subscribed=1",
      clock: { t: 0 },
    });
    await panel.act(async () => {});
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows("Pro, 2 seats."), true, panel.text());
    assert.equal(panel.shows("Manage billing"), true, panel.text());
    assert.equal(panel.shows("Subscribe"), false, panel.text());
    await panel.unmount();
  } finally {
    forgetCheckoutWorkspace();
    mock.timers.reset();
  }
});

test("a return keeps the confirmation when Pro is already on", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  forgetCheckoutWorkspace();
  rememberCheckoutWorkspace("w2");
  try {
    const panel = await mountPanel({
      workspaces: [{ id: "w1", name: "First" }, { id: "w2", name: "Second" }],
      plans: { w1: freeRow, w2: proRow(2) },
      search: "?subscribed=1",
      clock: { t: 0 },
    });
    await panel.act(async () => {});
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows(WAITING_SENTENCE), false, panel.text());
    await panel.advance(30_000);
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    await panel.unmount();
  } finally {
    forgetCheckoutWorkspace();
    mock.timers.reset();
  }
});

test("a return replaces the waiting sentence when Pro arrives during polling", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  forgetCheckoutWorkspace();
  rememberCheckoutWorkspace("w2");
  try {
    const panel = await mountPanel({
      workspaces: [{ id: "w1", name: "First" }, { id: "w2", name: "Second" }],
      plans: { w1: freeRow, w2: (_reads, clock) => (clock >= 6000 ? proRow(2) : freeRow) },
      search: "?subscribed=1",
      clock: { t: 0 },
    });
    await panel.act(async () => {});
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    assert.equal(panel.shows(PRO_SENTENCE), false, panel.text());
    await panel.advance(3000);
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    await panel.advance(3000);
    assert.equal(panel.shows(PRO_SENTENCE), true, panel.text());
    assert.equal(panel.shows(WAITING_SENTENCE), false, panel.text());
    await panel.unmount();
  } finally {
    forgetCheckoutWorkspace();
    mock.timers.reset();
  }
});

test("the return keeps one 90 s deadline across a workspace switch and stops there", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  forgetCheckoutWorkspace();
  rememberCheckoutWorkspace("w2");
  try {
    const panel = await mountPanel({
      workspaces: [{ id: "w1", name: "First" }, { id: "w2", name: "Second" }],
      plans: { w1: freeRow, w2: freeRow },
      search: "?subscribed=1",
      clock: { t: 0 },
    });
    await panel.act(async () => {});
    await panel.advance(30_000);
    assert.ok((panel.reads.w2 ?? 0) >= 10, `reads ${JSON.stringify(panel.reads)}`);
    await panel.switchTo("w1");
    const afterSwitch = panel.reads.w2 ?? 0;
    await panel.advance(60_000);
    const atLimit = panel.reads.w2 ?? 0;
    assert.equal(atLimit - afterSwitch, 20, `the remaining 60 s is 20 polls: ${JSON.stringify(panel.reads)}`);
    assert.ok((panel.reads.w1 ?? 0) <= 2, `switching must not start a poll for w1: ${JSON.stringify(panel.reads)}`);
    assert.equal(panel.shows(WAITING_SENTENCE), true, panel.text());
    await panel.advance(60_000);
    assert.equal(panel.reads.w2 ?? 0, atLimit, "polling continued past the deadline");
    await panel.unmount();
  } finally {
    forgetCheckoutWorkspace();
    mock.timers.reset();
  }
});

test("a paused workspace renders the paused sentence and Manage billing only", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  forgetCheckoutWorkspace();
  try {
    const paused: PlanRow = { role: "owner", plan: { pro: false, status: "paused", seats: 2, currentPeriodEnd: null } };
    const panel = await mountPanel({
      workspaces: [{ id: "w1", name: "First" }],
      plans: { w1: paused },
      search: "",
      clock: { t: 0 },
    });
    await panel.act(async () => {});
    assert.equal(panel.shows(PAUSED_SENTENCE), true, panel.text());
    assert.equal(panel.shows("Manage billing"), true, panel.text());
    assert.equal(panel.shows("Subscribe"), false, panel.text());
    await panel.unmount();
  } finally {
    forgetCheckoutWorkspace();
    mock.timers.reset();
  }
});

test("the panel wires the return hook and the billing view into its markup", () => {
  const source = readFileSync(new URL("../src/app/Workspace.tsx", import.meta.url), "utf8");
  for (const wiring of ["api.useCheckoutReturn(", "checkoutReturn.sentence", "api.billingView(", "api.preferredWorkspace("]) {
    assert.equal(source.includes(wiring), true, `Workspace.tsx no longer uses ${wiring}`);
  }
  assert.equal(source.includes("localStorage"), false);
});
