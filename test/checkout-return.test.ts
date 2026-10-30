import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  PRO_ON_SENTENCE,
  PRO_WAITING_SENTENCE,
  rememberCheckoutWorkspace,
  useCheckoutReturn,
  type Plan,
} from "../src/app/account.ts";

// The checkout return runs on a 90 s deadline and a 3 s poll. A reply that
// lands after the deadline must not reach the plans map, whether it carries Pro
// or a free plan, and the return must still say the payment is being confirmed.

type Reply = { role: string; plan: Plan };

const FREE: Reply = { role: "owner", plan: { pro: false, status: null, seats: 1, currentPeriodEnd: null } };
const PRO: Reply = { role: "owner", plan: { pro: true, status: "active", seats: 2, currentPeriodEnd: null } };

class ShimNode {
  nodeType: number;
  nodeName: string;
  childNodes: ShimNode[] = [];
  parentNode: ShimNode | null = null;

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

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
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
    location: { href: "http://127.0.0.1:8790/app/?subscribed=1", pathname: "/app/", search: "?subscribed=1" },
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
  globals.location = view.location;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return doc;
}

/** Holds each plan read until the test releases it, so a reply lands when the test says. */
function replyQueue() {
  const held: ((row: Reply) => void)[] = [];
  return {
    read(_id: string): Promise<Reply> {
      return new Promise<Reply>((resolve) => {
        held.push(resolve);
      });
    },
    get inFlight(): number {
      return held.length;
    },
    /** Releases the reply at `at`, oldest first at 0. */
    release(row: Reply, at = 0): void {
      const [resolve] = held.splice(at, 1);
      assert.ok(resolve, "a plan read is in flight to release");
      resolve(row);
    },
  };
}

interface Cursor {
  value: number;
}

interface Calls {
  workspace: string;
  pro: boolean;
}

/**
 * Mounts the hook through a probe that renders what a person would see, as
 * `returning|sentence|plan`.
 */
async function mountProbe(queue: ReturnType<typeof replyQueue>, clock: Cursor) {
  const doc = installDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const calls: Calls[] = [];

  function Probe() {
    const [plans, setPlans] = React.useState<Record<string, Reply>>({ w1: FREE });
    const found = useCheckoutReturn({
      active: "w1",
      plans,
      onPlan(workspace, reply) {
        calls.push({ workspace, pro: reply.plan.pro });
        setPlans((current) => ({ ...current, [workspace]: reply }));
      },
      enabled: true,
      search: "?subscribed=1",
      now: () => clock.value,
      getPlan: (id) => queue.read(id),
      pollMs: 3_000,
      windowMs: 90_000,
    });
    const plan = plans.w1 ? (plans.w1.plan.pro ? "pro" : "free") : "none";
    return React.createElement("span", null, [found.returning ?? "-", found.sentence ?? "-", plan].join("|"));
  }

  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as ShimNode);
  const root = createRoot(container as unknown as Element);
  const act = async (work: () => void | Promise<void>) => {
    await React.act(async () => {
      await work();
    });
  };
  const flush = async () => {
    await act(() => {});
    await act(() => {});
  };
  await act(() => {
    root.render(React.createElement(Probe));
  });
  await flush();

  const shown = () => (container as unknown as ShimElement).textContent.split("|");
  return {
    calls,
    act,
    flush,
    returning: () => shown()[0],
    sentence: () => shown()[1],
    plan: () => shown()[2],
    async advance(ms: number) {
      clock.value += ms;
      await act(() => {
        mock.timers.tick(ms);
      });
      await flush();
    },
    async unmount() {
      await act(() => {
        root.unmount();
      });
      doc.body.removeChild(container as unknown as ShimNode);
    },
  };
}

/** Runs the reply handler to completion inside the current act scope. */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("a Pro reply released in the deadline's turn never reaches the plans map", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    rememberCheckoutWorkspace("w1");
    const clock: Cursor = { value: 0 };
    const queue = replyQueue();
    const probe = await mountProbe(queue, clock);
    await probe.advance(3_000);
    assert.equal(queue.inFlight, 1, "one poll is in flight with its reply held");
    await probe.act(async () => {
      clock.value = 90_000;
      mock.timers.tick(87_000);
      queue.release(PRO);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [], "a Pro reply released at the deadline reached onPlan");
    assert.equal(probe.plan(), "free", "the plans map took a Pro reply after the deadline");
    assert.equal(probe.sentence(), PRO_WAITING_SENTENCE, "the return left the waiting sentence");
    assert.equal(probe.returning(), "w1");
    await probe.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a free reply released in the deadline's turn never reaches the plans map", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    rememberCheckoutWorkspace("w1");
    const clock: Cursor = { value: 0 };
    const queue = replyQueue();
    const probe = await mountProbe(queue, clock);
    await probe.advance(3_000);
    assert.equal(queue.inFlight, 1, "one poll is in flight with its reply held");
    await probe.act(async () => {
      clock.value = 90_000;
      mock.timers.tick(87_000);
      queue.release(FREE);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [], "a free reply released at the deadline reached onPlan");
    assert.equal(probe.plan(), "free");
    assert.equal(probe.sentence(), PRO_WAITING_SENTENCE);
    await probe.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a Pro reply released before the deadline settles the return", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    rememberCheckoutWorkspace("w1");
    const clock: Cursor = { value: 0 };
    const queue = replyQueue();
    const probe = await mountProbe(queue, clock);
    await probe.advance(3_000);
    await probe.act(async () => {
      clock.value = 30_000;
      mock.timers.tick(27_000);
      queue.release(PRO);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [{ workspace: "w1", pro: true }], "the Pro reply did not reach the plans map");
    assert.equal(probe.plan(), "pro");
    assert.equal(probe.sentence(), PRO_ON_SENTENCE);
    await probe.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a reply released after the return expired calls nothing", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    rememberCheckoutWorkspace("w1");
    const clock: Cursor = { value: 0 };
    const queue = replyQueue();
    const probe = await mountProbe(queue, clock);
    await probe.advance(3_000);
    await probe.advance(87_000);
    assert.equal(probe.sentence(), PRO_WAITING_SENTENCE, "the return did not reach its waiting sentence");
    await probe.act(async () => {
      queue.release(PRO);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [], "a reply landing after the expiry reached onPlan");
    assert.equal(probe.plan(), "free");
    assert.equal(probe.sentence(), PRO_WAITING_SENTENCE);
    await probe.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a reply released after the probe unmounts calls nothing", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    rememberCheckoutWorkspace("w1");
    const clock: Cursor = { value: 0 };
    const queue = replyQueue();
    const probe = await mountProbe(queue, clock);
    await probe.advance(3_000);
    const calls = probe.calls;
    await probe.unmount();
    await probe.act(async () => {
      queue.release(PRO);
      await settleMicrotasks();
    });
    assert.deepEqual(calls, [], "a reply landing after the unmount reached onPlan");
  } finally {
    mock.timers.reset();
  }
});

test("a later Pro reply settles the return after an older reply was dropped", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    rememberCheckoutWorkspace("w1");
    const clock: Cursor = { value: 0 };
    const queue = replyQueue();
    const probe = await mountProbe(queue, clock);
    await probe.advance(3_000);
    await probe.advance(3_000);
    assert.equal(queue.inFlight, 2, "two polls are in flight with their replies held");
    await probe.act(async () => {
      queue.release(FREE, 1);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [{ workspace: "w1", pro: false }]);
    assert.equal(probe.sentence(), PRO_WAITING_SENTENCE);
    await probe.act(async () => {
      queue.release(FREE, 0);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [{ workspace: "w1", pro: false }], "an older reply overwrote a newer one");
    await probe.advance(3_000);
    await probe.act(async () => {
      queue.release(PRO);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [
      { workspace: "w1", pro: false },
      { workspace: "w1", pro: true },
    ]);
    assert.equal(probe.plan(), "pro");
    assert.equal(probe.sentence(), PRO_ON_SENTENCE);
    await probe.unmount();
  } finally {
    mock.timers.reset();
  }
});

test("a free reply then a Pro reply released in one turn settle the return", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    rememberCheckoutWorkspace("w1");
    const clock: Cursor = { value: 0 };
    const queue = replyQueue();
    const probe = await mountProbe(queue, clock);
    await probe.advance(3_000);
    await probe.advance(3_000);
    assert.equal(queue.inFlight, 2, "two polls are in flight with their replies held");
    await probe.act(async () => {
      queue.release(FREE);
      await settleMicrotasks();
      queue.release(PRO);
      await settleMicrotasks();
    });
    await probe.flush();
    assert.deepEqual(probe.calls, [
      { workspace: "w1", pro: false },
      { workspace: "w1", pro: true },
    ]);
    assert.equal(probe.plan(), "pro");
    assert.equal(probe.sentence(), PRO_ON_SENTENCE);
    await probe.unmount();
  } finally {
    mock.timers.reset();
  }
});
