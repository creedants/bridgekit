import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";

// A deployment runs with its account routes closed when the Worker's ACCOUNTS
// switch is not "on": /api/config reports nothing on offer and /api/auth/*
// answers 404 {"error":"Not found."} (server/worker.ts). The Workspace panel
// must then render nothing at all, and a real failure while accounts are open
// must still show its message.

const CLOSED_CONFIG = { providers: [], email: false, commentary: false, billing: false };
const OPEN_CONFIG = { providers: ["microsoft"], email: true, commentary: false, billing: false };
const SERVER_SENTENCE = "Something went wrong on the server.";

interface Answer {
  status: number;
  body: unknown;
  contentType?: string;
}

interface FakeServer {
  requests: string[];
  fetch(path: string): Promise<Response>;
}

function server(answers: { config: Answer; session?: Answer }): FakeServer {
  const requests: string[] = [];
  return {
    requests,
    async fetch(path: string) {
      const url = String(path);
      requests.push(url);
      const answer =
        url === "/api/config"
          ? answers.config
          : url === "/api/auth/get-session"
            ? (answers.session ?? { status: 404, body: { error: "Not found." } })
            : { status: 404, body: { error: "Not found." } };
      const type = answer.contentType ?? "application/json";
      return new Response(type === "application/json" ? JSON.stringify(answer.body) : String(answer.body), {
        status: answer.status,
        headers: { "content-type": type },
      });
    },
  };
}

// The real Workspace.tsx is mounted below. This runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already depends on, and the panel then runs exactly as the app runs
// it: same effects, same requests, same markup.

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

function collect(node: ShimNode | null, out: ShimElement[] = []): ShimElement[] {
  if (!node) return out;
  if (node instanceof ShimElement) out.push(node);
  for (const child of node.childNodes) collect(child, out);
  return out;
}

/** Mounts the real panel over the fake server and returns what is on screen. */
async function mount(fake: FakeServer) {
  const doc = installDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: WorkspacePanel } = await import("../src/app/Workspace.tsx");
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.location = { href: "http://127.0.0.1:8790/app/", pathname: "/app/", search: "" };
  globals.history = { replaceState() {}, pushState() {} };
  globals.fetch = ((path: string) => fake.fetch(path)) as unknown as typeof fetch;

  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as ShimNode);
  const root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root.render(React.createElement(WorkspacePanel, { columns: [], setup: null, bridge: null, onUseSetup() {} }));
  });
  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await React.act(async () => {});
  };
  await flush();
  const elements = () => {
    const found: ShimElement[] = [];
    for (const child of (container as unknown as ShimElement).childNodes) collect(child, found);
    return found;
  };
  return {
    text: () => (container as unknown as ShimElement).textContent,
    error: () => elements().filter((element) => element.getAttribute("class") === "error").map((element) => element.textContent).join(""),
    tags: () => elements().map((element) => element.nodeName),
    settle: flush,
  };
}

test("a deployment with accounts closed shows no Workspace panel and no error", async () => {
  const fake = server({ config: { status: 200, body: CLOSED_CONFIG } });
  const panel = await mount(fake);
  assert.equal(panel.text(), "", "the panel rendered something for a closed deployment");
  assert.equal(panel.error(), "", "the panel showed an error for a closed deployment");
  assert.deepEqual(panel.tags(), [], "the panel rendered elements for a closed deployment");
  assert.ok(!fake.requests.includes("/api/auth/get-session"), `asked for a session on a closed deployment: ${fake.requests.join(", ")}`);
});

test("no panel appears while the deployment's config is still being read", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = server({ config: { status: 200, body: CLOSED_CONFIG } });
  const answer = fake.fetch;
  fake.fetch = async (path: string) => {
    if (path === "/api/config") await held;
    return answer(path);
  };
  const panel = await mount(fake);
  assert.deepEqual(panel.tags(), [], "the panel appeared before the config answered");
  release();
  await panel.settle();
  assert.deepEqual(panel.tags(), [], "the panel appeared once a closed config answered");
});

test("no panel appears while the session is being read, then the sign-in panel appears", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = server({
    config: { status: 200, body: OPEN_CONFIG },
    session: { status: 200, body: { user: null } },
  });
  const answer = fake.fetch;
  fake.fetch = async (path: string) => {
    if (path === "/api/auth/get-session") await held;
    return answer(path);
  };
  const panel = await mount(fake);
  assert.deepEqual(panel.tags(), [], "the panel appeared before the session answered");
  release();
  await panel.settle();
  assert.ok(panel.tags().includes("FIELDSET"), "the sign-in panel did not appear once the session answered signed out");
});

test("a session 404 answered as HTML while accounts are open shows the fallback sentence", async () => {
  const fake = server({
    config: { status: 200, body: OPEN_CONFIG },
    session: { status: 404, body: "<html><body>Not found</body></html>", contentType: "text/html" },
  });
  const panel = await mount(fake);
  assert.ok(panel.tags().includes("FIELDSET"), "a proxy failure left the panel with nowhere to show its message");
  assert.equal(panel.error(), "The server returned 404.");
});

test("a session 404 carrying a message while accounts are open shows that message", async () => {
  const sent = "Auth routing is unavailable.";
  const fake = server({
    config: { status: 200, body: OPEN_CONFIG },
    session: { status: 404, body: { error: sent } },
  });
  const panel = await mount(fake);
  assert.ok(panel.tags().includes("FIELDSET"), "a 404 left the panel with nowhere to show its message");
  assert.equal(panel.error(), sent);
});

test("a real failure while accounts are open still shows its message", async () => {
  const fake = server({
    config: { status: 200, body: OPEN_CONFIG },
    session: { status: 500, body: { error: SERVER_SENTENCE } },
  });
  const panel = await mount(fake);
  assert.ok(panel.tags().includes("FIELDSET"), "a real failure left the panel with nowhere to show its message");
  assert.equal(panel.error(), SERVER_SENTENCE);
});
