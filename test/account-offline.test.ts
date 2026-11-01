import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import * as account from "../src/app/account.ts";

/**
 * The page asks its own server for the session, and, when the person presses the
 * button, for AI commentary. On the Cloudflare build a connection that has gone
 * makes fetch reject, and the browser's own "Failed to fetch" is not a sentence
 * to show. Both requests give one sentence instead, and a response the server
 * did send keeps the message it sent.
 */

const SENTENCE = "Could not reach the server. Check your connection and try again.";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const user = { id: "u", email: "u@example.invalid", name: "U" };

const SUMMARY: Parameters<typeof account.requestCommentary>[0] = {
  measure: "Sales",
  prior: "2025",
  current: "2026",
  priorTotal: 100,
  currentTotal: 120,
  effects: [{ label: "Volume", value: 20 }],
  attributes: ["Size"],
  exactMatchShare: 1,
  newAndDiscontinued: "difference",
};

type Reply = (path: string) => Response | Promise<Response>;

/** Answers every request for one test, records the paths asked for, and puts fetch back. */
async function withFake(reply: Reply, run: (asked: string[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    asked.push(path);
    return reply(path);
  }) as typeof fetch;
  try {
    await run(asked);
  } finally {
    globalThis.fetch = original;
  }
}

const unreachable: Reply = () => {
  throw new TypeError("Failed to fetch");
};

test("a request that never reached the server shows the sentence", async () => {
  await withFake(unreachable, async (asked) => {
    const failure = await account.getUser().catch((error: unknown) => error);
    assert.ok(failure instanceof Error, "the request resolved instead of failing");
    assert.equal(failure.message, SENTENCE);
    assert.equal(failure.message, account.UNREACHABLE_SENTENCE);
    assert.notEqual(failure.message, "Failed to fetch");
    assert.equal(account.UNREACHABLE_SENTENCE, SENTENCE);
    assert.deepEqual(asked, ["/api/auth/get-session"]);
  });
});

test("the commentary request shows the sentence, through the code the panel uses", async () => {
  await withFake(unreachable, async (asked) => {
    const failure = await account.requestCommentary(SUMMARY).catch((error: unknown) => error);
    assert.ok(failure instanceof Error, "the request resolved instead of failing");
    assert.equal(failure.message, SENTENCE);
    assert.equal(failure.message, account.UNREACHABLE_SENTENCE);
    assert.notEqual(failure.message, "Failed to fetch");
    assert.deepEqual(asked, ["/api/commentary"]);
  });
});

test("the commentary panel shows the sentence and keeps its button working", async () => {
  const panel = await mountCommentary();
  await panel.press("Send totals and write commentary");
  assert.ok(panel.shows(SENTENCE), `the panel showed ${JSON.stringify(panel.text())}`);
  assert.deepEqual(panel.buttons(), ["Send totals and write commentary"], "the panel lost its button after a failed request");
  assert.equal(panel.disabled("Send totals and write commentary"), false, "the button stayed disabled after a failed request");

  panel.reply(async () => json({ paragraphs: ["Written once.", "Written twice."] }));
  await panel.press("Send totals and write commentary");
  assert.ok(panel.shows("Written once."), `the panel showed ${JSON.stringify(panel.text())}`);
  assert.ok(!panel.shows(SENTENCE), "the sentence outlived a working request");
});

test("a response the server sent keeps its own message", async () => {
  await withFake(
    () => json({ error: "Sign-in expired. Sign in again." }, 500),
    async () => {
      await assert.rejects(account.getUser(), { message: "Sign-in expired. Sign in again." });
    },
  );
  await withFake(
    () => json({ message: "Workspaces are read-only." }, 503),
    async () => {
      await assert.rejects(account.getUser(), { message: "Workspaces are read-only." });
    },
  );
  await withFake(
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    async () => {
      await assert.rejects(account.getUser(), { message: "The server returned 502." });
    },
  );
  await withFake(
    () => json({ error: "Commentary is unavailable." }, 500),
    async () => {
      await assert.rejects(account.requestCommentary(SUMMARY), { message: "Commentary is unavailable." });
    },
  );
  await withFake(
    () => json({ message: "No commentary today." }, 500),
    async () => {
      await assert.rejects(account.requestCommentary(SUMMARY), { message: "The server returned 500." });
    },
  );
});

test("a later retry works once the connection returns", async () => {
  let reads = 0;
  await withFake(
    () => {
      reads += 1;
      return reads === 1 ? unreachable("/api/auth/get-session") : json({ user });
    },
    async () => {
      await assert.rejects(account.getUser(), { message: SENTENCE });
      assert.deepEqual(await account.getUser(), user);
    },
  );

  let writes = 0;
  await withFake(
    () => {
      writes += 1;
      return writes === 1 ? unreachable("/api/commentary") : json({ paragraphs: ["a", "b"] });
    },
    async () => {
      await assert.rejects(account.requestCommentary(SUMMARY), { message: SENTENCE });
      assert.deepEqual(await account.requestCommentary(SUMMARY), ["a", "b"]);
    },
  );
});

// The commentary panel is rendered here, not read as source text, so the check
// covers the sentence a person sees and the button they press again. The panel
// lives in a .tsx file, which this runner cannot load by itself, so a load hook
// transforms it with the esbuild copy the build already installs.

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(new URL(url), "utf8");
      const { code } = transformSync(source, {
        loader: "tsx",
        format: "esm",
        jsx: "automatic",
        define: { "import.meta.env": "{}" },
      });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

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


function collect(node: ShimNode | null, out: ShimElement[] = []): ShimElement[] {
  if (!node) return out;
  if (node instanceof ShimElement) out.push(node);
  for (const child of node.childNodes) collect(child, out);
  return out;
}

/** Mounts the real commentary panel over a fake fetch and returns what is on screen. */
async function mountCommentary() {
  const doc = installDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AiCommentary } = await import("../src/app/results/Summary.tsx");
  const globals = globalThis as unknown as Record<string, unknown>;
  const panel = {
    reply: () => Promise.reject(new TypeError("Failed to fetch")) as Promise<Response>,
  };
  globals.fetch = ((path: string) => panel.reply()) as unknown as typeof fetch;

  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as ShimNode);
  const root = createRoot(container as unknown as Element);
  const act = async (work: () => void | Promise<void>) => {
    await React.act(async () => {
      await work();
    });
  };
  await act(async () => {
    root.render(React.createElement(AiCommentary, { summary: SUMMARY, offer: "button" }));
  });
  const flush = async () => {
    await act(async () => {});
    await act(async () => {});
    await act(async () => {});
  };
  const elements = () => {
    const found: ShimElement[] = [];
    for (const child of (container as unknown as ShimElement).childNodes) collect(child, found);
    return found;
  };
  const buttons = () => elements().filter((element) => element.nodeName === "BUTTON");
  const find = (label: string) => buttons().find((element) => element.textContent === label);
  return {
    reply: (next: () => Promise<Response>) => {
      panel.reply = next;
    },
    text: () => (container as unknown as ShimElement).textContent,
    shows: (sentence: string) => (container as unknown as ShimElement).textContent.includes(sentence),
    buttons: () => buttons().map((element) => element.textContent),
    disabled: (label: string) => {
      const button = find(label) as unknown as { disabled?: boolean } | undefined;
      assert.ok(button, `the panel offers a button named ${label}`);
      return button.disabled === true || (button as unknown as ShimElement).hasAttribute("disabled");
    },
    async press(label: string) {
      const button = find(label);
      assert.ok(button, `the panel offers a button named ${label}`);
      await act(async () => {
        button.dispatchEvent({ type: "click", bubbles: true, target: button });
      });
      await flush();
    },
  };
}
