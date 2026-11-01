import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";

// The Workspace panel's first config or session read can fail while the page
// itself is still cached, for example when a person goes offline and then
// opens their first data. The panel then shows one sentence and a Try again
// button, and the button runs the reads again over the same mount, so the
// analysis on screen is untouched. These cases drive the real panel over a
// fake fetch, with no server and no browser.

const SENTENCE = "Could not reach the server. Check your connection and try again.";
const OPEN_CONFIG = { providers: [], email: true, commentary: false, billing: false };
const USER = { id: "u", email: "u@example.invalid", name: "U" };

interface FakeServer {
  /** True while the browser cannot reach the server at all. */
  down: boolean;
  /** While set, the config read waits for it, so a run can be held open. */
  held: Promise<void> | null;
  /** While set, the workspace-list read waits for it, so startup can be held. */
  heldList: Promise<void> | null;
  /** While true, the workspace-list read fails the way an offline request does. */
  listFails: boolean;
  requests: string[];
  fetch(path: string): Promise<Response>;
}

function server(): FakeServer {
  const requests: string[] = [];
  const fake: FakeServer = {
    down: true,
    held: null,
    heldList: null,
    listFails: false,
    requests,
    async fetch(path: string) {
      const url = String(path);
      requests.push(url);
      if (fake.down) throw new TypeError("Failed to fetch");
      if (url === "/api/config" && fake.held) await fake.held;
      if (url === "/api/auth/organization/list") {
        if (fake.heldList) await fake.heldList;
        if (fake.listFails) throw new TypeError("Failed to fetch");
      }
      const body = url === "/api/config" ? OPEN_CONFIG : url === "/api/auth/get-session" ? { user: USER } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return fake;
}

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

  // A browser reports "text" for an input with no type attribute, and React's
  // change detection checks it before accepting a typed value.
  ownType = "";

  get type(): string {
    return this.attributes.get("type") ?? (this.ownType || (this.nodeName === "INPUT" ? "text" : ""));
  }

  set type(next: string) {
    this.ownType = String(next);
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
  // React takes its native input-event path only when the document advertises
  // the event, as a real one does, so a typed value reaches onChange.
  (doc as unknown as { oninput: null }).oninput = null;
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
async function mount(fake: FakeServer, strict = false) {
  const doc = installDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: WorkspacePanel } = await import("../src/app/Workspace.tsx");
  const globals = globalThis as unknown as Record<string, unknown>;
  let reloads = 0;
  const location = {
    href: "http://127.0.0.1:8790/app/",
    pathname: "/app/",
    search: "",
    reload() {
      reloads += 1;
    },
  };
  globals.location = location;
  globals.history = { replaceState() {}, pushState() {} };
  globals.fetch = ((path: string) => fake.fetch(path)) as unknown as typeof fetch;

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
    root.render(strict ? React.createElement(React.StrictMode, null, panel) : panel);
  });
  const flush = async () => {
    await act(async () => {});
    await act(async () => {});
    await act(async () => {});
  };
  await flush();
  const elements = () => {
    const found: ShimElement[] = [];
    for (const child of (container as unknown as ShimElement).childNodes) collect(child, found);
    return found;
  };
  const text = () => (container as unknown as ShimElement).textContent;
  return {
    text,
    shows: (sentence: string) => text().includes(sentence),
    buttons: () => elements().filter((element) => element.nodeName === "BUTTON").map((element) => element.textContent),
    reloads: () => reloads,
    /** True when the button with this label is on screen and not disabled. */
    enabled(label: string) {
      const button = elements().find((element) => element.nodeName === "BUTTON" && element.textContent === label);
      assert.ok(button, `the panel offers a button named ${label}`);
      return !button.hasAttribute("disabled");
    },
    /** Types into the one field on screen, the way a person would. */
    async type(value: string) {
      const input = elements().find((element) => element.nodeName === "INPUT");
      assert.ok(input, `the panel offers a field to type in: ${JSON.stringify(text())}`);
      (input as unknown as { value: string }).value = value;
      await act(async () => {
        input.dispatchEvent({ type: "input", bubbles: true, target: input });
        input.dispatchEvent({ type: "change", bubbles: true, target: input });
      });
      await flush();
    },
    /** Presses the button with this label, then lets the reply land. */
    async press(label: string, settle = true) {
      const button = elements().find((element) => element.nodeName === "BUTTON" && element.textContent === label);
      assert.ok(button, `the panel offers a button named ${label}`);
      await act(async () => {
        button.dispatchEvent({ type: "click", bubbles: true, target: button });
      });
      if (settle) await flush();
    },
    settle: flush,
  };
}

const TRY_AGAIN = "Try again";

test("a first read that fails offline shows the sentence and one Try again button", async () => {
  const fake = server();
  const panel = await mount(fake);
  assert.equal(panel.text(), `Workspace${SENTENCE}${TRY_AGAIN}`, `the panel showed ${JSON.stringify(panel.text())}`);
  assert.deepEqual(panel.buttons(), [TRY_AGAIN], `the panel offers ${panel.buttons().join(", ")}`);
  assert.deepEqual(fake.requests, ["/api/config"]);
});

test("a press while the connection is still down keeps the sentence and the button", async () => {
  const fake = server();
  const panel = await mount(fake);
  await panel.press(TRY_AGAIN);
  assert.equal(panel.text(), `Workspace${SENTENCE}${TRY_AGAIN}`, `the panel showed ${JSON.stringify(panel.text())}`);
  assert.deepEqual(panel.buttons(), [TRY_AGAIN], "the button stopped working after a failed retry");
  assert.deepEqual(fake.requests, ["/api/config", "/api/config"], "the press did not run the reads again");
});

test("a press after the connection returns shows the normal controls with no reload", async () => {
  const fake = server();
  const panel = await mount(fake);
  fake.down = false;
  await panel.press(TRY_AGAIN);
  assert.ok(!panel.shows(SENTENCE), `the sentence outlived the recovered reads: ${JSON.stringify(panel.text())}`);
  assert.ok(panel.shows("Signed in as u@example.invalid."), `the panel showed ${JSON.stringify(panel.text())}`);
  assert.ok(panel.buttons().includes("Create workspace"), `the panel offers ${panel.buttons().join(", ")}`);
  assert.equal(panel.reloads(), 0, "the panel reloaded the page instead of reading again");
  assert.deepEqual(
    fake.requests,
    ["/api/config", "/api/config", "/api/auth/get-session", "/api/auth/organization/list"],
    "the same mount did not run the startup reads again",
  );
});

test("a second press while the first retry runs starts no second run", async () => {
  const fake = server();
  const panel = await mount(fake);
  let release: () => void = () => {};
  fake.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.down = false;
  await panel.press(TRY_AGAIN, false);
  await panel.press(TRY_AGAIN, false);
  release();
  await panel.settle();
  assert.equal(fake.requests.filter((path) => path === "/api/config").length, 2, `the reads ran ${fake.requests.join(", ")}`);
  assert.ok(panel.shows("Signed in as u@example.invalid."), `the panel showed ${JSON.stringify(panel.text())}`);
});

test("a typed Create workspace form waits for the startup list to answer", async () => {
  const fake = server();
  fake.down = false;
  let release: () => void = () => {};
  fake.heldList = new Promise<void>((resolve) => {
    release = resolve;
  });
  const panel = await mount(fake);
  await panel.type("New team");
  assert.equal(
    panel.enabled("Create workspace"),
    false,
    `Create workspace was enabled while the first list was on its way: ${JSON.stringify(panel.text())}`,
  );
  assert.equal(
    panel.enabled("Delete my account"),
    false,
    `account deletion was enabled while the first list was on its way: ${JSON.stringify(panel.text())}`,
  );
  release();
  await panel.settle();
  assert.equal(panel.enabled("Create workspace"), true, `Create workspace stayed disabled after the list answered: ${JSON.stringify(panel.text())}`);
  assert.equal(panel.enabled("Delete my account"), true, `account deletion stayed disabled after the list answered: ${JSON.stringify(panel.text())}`);
  assert.deepEqual(fake.requests, ["/api/config", "/api/auth/get-session", "/api/auth/organization/list"]);
});

test("a startup list that fails after the session read frees the controls and shows its sentence", async () => {
  const fake = server();
  fake.down = false;
  fake.listFails = true;
  const panel = await mount(fake);
  await panel.type("New team");
  assert.equal(
    panel.enabled("Create workspace"),
    true,
    `Create workspace stayed disabled after the startup list failed: ${JSON.stringify(panel.text())}`,
  );
  assert.equal(panel.enabled("Delete my account"), true, `account deletion stayed disabled after the startup list failed: ${JSON.stringify(panel.text())}`);
  assert.ok(panel.shows(SENTENCE), `the failed startup list showed ${JSON.stringify(panel.text())}`);
  assert.deepEqual(fake.requests, ["/api/config", "/api/auth/get-session", "/api/auth/organization/list"]);
});
