import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { Query } from "../src/engine.ts";
import { createConnectionQueue, statementStartsTurn } from "../src/app/small-bridges.ts";
import { openDatabase } from "../src/duckdb.ts";

// The page database needs a browser and wasm bundles, and the results view draws
// its charts on a canvas. Both are replaced here so the real App can mount in Node.
const FAKE_DATABASE_MODULE = `
export const PARQUET_REFUSAL = "That file is a Parquet file. Save it as CSV or Excel, then choose it again.";
export function openBrowserDatabase() { return Promise.resolve(globalThis.__bridgekitDatabase); }
export async function dateOrderNote() { return null; }
`;

const LAZY_CHUNK_URL = new URL("../src/app/lazyChunk.ts", import.meta.url).href;
const FAKE_LAZY_CHUNK_MODULE = `
export * from ${JSON.stringify(LAZY_CHUNK_URL)};
export function scheduleSpeculative() { return () => {}; }
`;

const FAKE_WATERFALL_MODULE = `
export function Waterfall() { return null; }
export function Legend() { return null; }
`;

const FAKE_SMALL_BRIDGES_MODULE = `
export function SmallBridges() { return null; }
export function splitPicture() { return null; }
`;

const FAKE_USE_CONFIG_MODULE = `
export function useCommentaryOffer() { return "hidden"; }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    if (specifier === "./db.ts" && context.parentURL?.includes("/src/app/")) {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_DATABASE_MODULE)}`, shortCircuit: true };
    }
    if (specifier === "./lazyChunk.ts" && context.parentURL?.endsWith("/src/app/App.tsx")) {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_LAZY_CHUNK_MODULE)}`, shortCircuit: true };
    }
    if (specifier === "./Waterfall.tsx") {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_WATERFALL_MODULE)}`, shortCircuit: true };
    }
    if (specifier === "./SmallBridges.tsx") {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_SMALL_BRIDGES_MODULE)}`, shortCircuit: true };
    }
    if (specifier === "../useConfig.ts" && context.parentURL?.endsWith("/src/app/results/Summary.tsx")) {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_USE_CONFIG_MODULE)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
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

type HarnessListener = (event: Record<string, unknown>) => void;

class HarnessNode {
  nodeType: number;
  nodeName: string;
  childNodes: HarnessNode[] = [];
  parentNode: HarnessNode | null = null;
  private listeners = new Map<string, Set<HarnessListener>>();

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): HarnessNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): HarnessNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): HarnessNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[at + 1] ?? null;
  }

  get previousSibling(): HarnessNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return at > 0 ? this.parentNode.childNodes[at - 1] : null;
  }

  appendChild(child: HarnessNode): HarnessNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: HarnessNode, before: HarnessNode | null): HarnessNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before === null ? -1 : this.childNodes.indexOf(before);
    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: HarnessNode): HarnessNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) {
      this.childNodes.splice(at, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, listener: HarnessListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: HarnessListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Record<string, unknown>): boolean {
    event.target = event.target ?? this;
    for (const listener of this.listeners.get(String(event.type)) ?? []) listener.call(this, event);
    if (event.bubbles && this.parentNode) return this.parentNode.dispatchEvent(event);
    return true;
  }
}

class HarnessText extends HarnessNode {
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

class HarnessElement extends HarnessNode {
  tagName: string;
  localName: string;
  attributes = new Map<string, string>();
  style: Record<string, unknown> = {
    setProperty() {},
    removeProperty() {},
  };
  ownValue = "";
  ownSelected = false;
  checked = false;
  disabled = false;
  type = "";
  tabIndex = -1;

  constructor(tagName: string) {
    super(1, String(tagName).toUpperCase());
    this.tagName = this.nodeName;
    this.localName = String(tagName).toLowerCase();
  }

  get namespaceURI(): string {
    return "http://www.w3.org/1999/xhtml";
  }

  get classList() {
    const names = (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => names.includes(name),
      add: () => {},
      remove: () => {},
    };
  }

  get value(): string {
    if (this.localName === "select") {
      const chosen = harnessNodes(this, "OPTION").find((option) => option.ownSelected);
      return chosen ? chosen.value : this.ownValue;
    }
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    return this.ownValue;
  }

  set value(next: string) {
    this.ownValue = String(next);
    if (this.localName === "select") {
      for (const option of harnessNodes(this, "OPTION")) option.selected = option.value === this.ownValue;
    }
  }

  get selected(): boolean {
    return this.ownSelected;
  }

  set selected(next: boolean) {
    this.ownSelected = Boolean(next);
    if (!this.ownSelected || !this.parentNode) return;
    for (const sibling of this.parentNode.childNodes) {
      if (sibling !== this && sibling instanceof HarnessElement) sibling.ownSelected = false;
    }
  }

  get options(): HarnessElement[] {
    return harnessNodes(this, "OPTION");
  }

  get ownerDocument(): HarnessDocument {
    return harnessDocument;
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
    return this.childNodes.map((child) => (child as HarnessElement).textContent ?? "").join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "" && value != null) this.appendChild(new HarnessText(value));
  }

  closest(): null {
    return null;
  }

  focus(_options?: unknown): void {
    harnessDocument.activeElement = this;
  }

  blur(): void {
    if (harnessDocument.activeElement === this) harnessDocument.activeElement = harnessDocument.body;
  }

  scrollIntoView(): void {}

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }

  querySelector(selector: string): HarnessElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): HarnessElement[] {
    return walk(this, []).filter((node) => node !== this && matchesSelector(node, selector));
  }
}

type HarnessDocument = HarnessElement & {
  createElement(tag: string): HarnessElement;
  createElementNS(namespace: string, tag: string): HarnessElement;
  createTextNode(text: string): HarnessText;
  createComment(text: string): HarnessText;
  documentElement: HarnessElement;
  body: HarnessElement;
  head: HarnessElement;
  activeElement: HarnessElement;
  HTMLIFrameElement: unknown;
  readyState: string;
};

let harnessDocument: HarnessDocument;

interface FrameHolder {
  frames: Map<number, (time: number) => void>;
  next: number;
}

let heldFrames: FrameHolder | null = null;

function requestFrame(work: (time: number) => void): number {
  if (heldFrames) {
    const id = heldFrames.next++;
    heldFrames.frames.set(id, work);
    return id;
  }
  return globalThis.setTimeout(() => work(0), 0) as unknown as number;
}

function cancelFrame(id: number): void {
  if (heldFrames) {
    heldFrames.frames.delete(id);
    return;
  }
  globalThis.clearTimeout(id);
}

function holdFrames(): FrameHolder {
  heldFrames = { frames: new Map(), next: 1 };
  return heldFrames;
}

function releaseFrames(): void {
  const holder = heldFrames;
  heldFrames = null;
  for (const work of holder?.frames.values() ?? []) globalThis.setTimeout(() => work(0), 0);
}

function installHarnessDom(): HarnessDocument {
  const existing = (globalThis as unknown as { document?: HarnessDocument }).document;
  if (existing && (existing as unknown as { body?: unknown }).body) return existing;
  const doc = new HarnessElement("#document") as unknown as HarnessDocument;
  (doc as unknown as { nodeType: number }).nodeType = 9;
  doc.readyState = "complete";
  doc.createElement = (tag: string) => new HarnessElement(tag);
  doc.createElementNS = (_namespace: string, tag: string) => new HarnessElement(tag);
  doc.createTextNode = (text: string) => new HarnessText(text);
  doc.createComment = (text: string) => new HarnessText(text);
  doc.documentElement = new HarnessElement("html");
  doc.head = new HarnessElement("head");
  doc.body = new HarnessElement("body");
  doc.activeElement = doc.body;
  doc.HTMLIFrameElement = class extends HarnessElement {};
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  (doc as unknown as HarnessNode).appendChild(doc.documentElement);
  const windowListeners = new Map<string, Set<HarnessListener>>();
  const view: Record<string, unknown> = {
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
    Node: HarnessNode,
    Element: HarnessElement,
    HTMLElement: HarnessElement,
    HTMLIFrameElement: doc.HTMLIFrameElement,
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    addEventListener(type: string, listener: HarnessListener) {
      const set = windowListeners.get(type) ?? new Set();
      set.add(listener);
      windowListeners.set(type, set);
    },
    removeEventListener(type: string, listener: HarnessListener) {
      windowListeners.get(type)?.delete(listener);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    confirm: () => true,
    performance: globalThis.performance,
  };
  const dispatch = (type: string, event: Record<string, unknown>) => {
    event.target = event.target ?? doc.body;
    for (const listener of windowListeners.get(type) ?? []) listener.call(view, event);
  };
  view.dispatch = dispatch;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = view;
  globals.document = doc;
  globals.location = view.location;
  globals.history = {
    state: null,
    replaceState(_state: unknown, _title: string, url: string) {
      const next = new URL(String(url), "http://127.0.0.1:8790");
      const location = view.location as { href: string; pathname: string; search: string };
      location.href = next.href;
      location.pathname = next.pathname;
      location.search = next.search;
    },
  };
  globals.Node = HarnessNode;
  globals.Element = HarnessElement;
  globals.HTMLElement = HarnessElement;
  globals.HTMLIFrameElement = doc.HTMLIFrameElement;
  globals.Event = view.Event;
  globals.MutationObserver = view.MutationObserver;
  globals.requestAnimationFrame = requestFrame;
  globals.cancelAnimationFrame = cancelFrame;
  globals.matchMedia = view.matchMedia;
  globals.confirm = view.confirm;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.__harnessDispatch = dispatch;
  harnessDocument = doc;
  return doc;
}

function walk(node: HarnessNode, found: HarnessElement[] = []): HarnessElement[] {
  if (node instanceof HarnessElement) found.push(node);
  for (const child of node.childNodes) walk(child, found);
  return found;
}

function harnessNodes(node: HarnessNode, name: string): HarnessElement[] {
  return walk(node).filter((element) => element.nodeName === name);
}

function harnessByClass(node: HarnessNode, name: string): HarnessElement[] {
  return walk(node).filter((element) => element.classList.contains(name));
}

function matchesSelector(element: HarnessElement, selector: string): boolean {
  const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attribute) {
    const value = element.getAttribute(attribute[1]);
    return attribute[2] === undefined ? value !== null : value === attribute[2];
  }
  const id = /^#(.+)$/.exec(selector);
  if (id) return element.getAttribute("id") === id[1];
  const combined = /^([a-z0-9-]+)\.([\w-]+)$/i.exec(selector);
  if (combined) {
    return element.localName === combined[1].toLowerCase() && element.classList.contains(combined[2]);
  }
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  return element.localName === selector.toLowerCase();
}

/** One async DuckDB per test, with statements queued the way the page queues them. */
function queued(raw: Query): Query {
  const statements = createConnectionQueue();
  return (sql) => (statementStartsTurn(sql) ? statements.turn(() => raw(sql)) : statements.schedule(() => raw(sql)));
}

interface HarnessDatabase {
  query: Query;
  loadFile(file: unknown, table: string): Promise<number>;
}

function sqlText(cell: string): string {
  return cell === "" ? "NULL" : `'${cell.replaceAll("'", "''")}'`;
}

/** Stands in for db.ts's file reader: the pasted cells become the loaded table. */
function harnessDatabase(query: Query): HarnessDatabase {
  return {
    query,
    async loadFile(file: unknown, table: string) {
      const text = await (file as { text(): Promise<string> }).text();
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
      const [header, ...rows] = lines;
      assert.ok(header, "the pasted text has a header row");
      const cut = header.includes("\t") ? "\t" : ",";
      const names = header.split(cut).map((name) => `"${name.replaceAll('"', '""')}"`);
      const values = rows.map((row) => `(${row.split(cut).map(sqlText).join(", ")})`);
      await query(
        `CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM (VALUES ${values.join(", ")}) AS t(${names.join(", ")})`,
      );
      return 0;
    },
  };
}

interface Mounted {
  React: typeof import("react");
  container: HarnessElement;
  flush: () => Promise<void>;
  until: (check: () => boolean, what: string) => Promise<void>;
  dispatchPaste: (text: string) => Promise<void>;
  unmount: () => Promise<void>;
}

async function mountApp(search: string, query: Query): Promise<Mounted> {
  const doc = installHarnessDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const location = (globalThis as unknown as { location: { href: string; pathname: string; search: string } }).location;
  location.search = search;
  location.href = `http://127.0.0.1:8790/app/${search}`;
  location.pathname = "/app/";
  (globalThis as unknown as { __bridgekitDatabase: HarnessDatabase }).__bridgekitDatabase = harnessDatabase(query);
  const { App } = await import("../src/app/App.tsx");
  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as HarnessNode);
  const root = createRoot(container as unknown as Element);
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await React.act(async () => {});
  };
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 1500; i += 1) {
      if (check()) return;
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    throw new Error(`timed out waiting for ${what}: ${walk(container).map((node) => node.textContent).join(" ").slice(0, 400)}`);
  };
  await React.act(async () => {
    root.render(React.createElement(App));
  });
  await flush();
  return {
    React,
    container,
    flush,
    until,
    dispatchPaste: async (text: string) => {
      await React.act(async () => {
        const dispatch = (globalThis as unknown as { __harnessDispatch: (type: string, event: Record<string, unknown>) => void }).__harnessDispatch;
        dispatch("paste", {
          clipboardData: { getData: () => text },
          preventDefault() {},
          target: doc.body,
        });
      });
      await flush();
    },
    unmount: async () => {
      await React.act(async () => {
        root.unmount();
      });
      doc.body.removeChild(container as unknown as HarnessNode);
    },
  };
}

function resultsHeading(container: HarnessElement): HarnessElement | undefined {
  return harnessNodes(container, "H1").find((node) => node.textContent === "Price-volume-mix bridge");
}

function politeRegion(container: HarnessElement): HarnessElement | undefined {
  return harnessNodes(container, "SPAN").find((node) => node.getAttribute("aria-live") === "polite");
}

function tabButtons(container: HarnessElement): HarnessElement[] {
  return harnessNodes(container, "BUTTON").filter((node) => node.getAttribute("role") === "tab");
}

function selectedTab(container: HarnessElement): HarnessElement | undefined {
  return tabButtons(container).find((node) => node.getAttribute("aria-selected") === "true");
}

/** The tab stop the strip gives a tab: React writes tabIndex as the tabindex attribute. */
function tabStop(node: HarnessElement): number {
  return Number(node.getAttribute("tabindex") ?? node.tabIndex);
}

function tabIndexZero(container: HarnessElement): HarnessElement[] {
  return tabButtons(container).filter((node) => tabStop(node) === 0);
}

async function pressKey(mounted: Mounted, element: HarnessElement, key: string): Promise<Record<string, unknown>> {
  const event: Record<string, unknown> = {
    type: "keydown",
    key,
    bubbles: true,
    target: element,
    defaultPrevented: false,
    preventDefault() {
      (event as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    stopPropagation() {},
  };
  await mounted.React.act(async () => {
    element.dispatchEvent(event);
  });
  await mounted.flush();
  return event;
}

async function waitForSampleRun(mounted: Mounted): Promise<void> {
  await mounted.until(() => resultsHeading(mounted.container) !== undefined && tabButtons(mounted.container).length > 0, "the results tabs");
}

test("Calculate puts focus on the results heading and announces the bridge", async () => {
  const raw = await openDatabase();
  const mounted = await mountApp("?sample=1000", queued(raw));
  try {
    await mounted.until(() => politeRegion(mounted.container)?.textContent === "Bridge calculated.", "the announcement");
    const heading = resultsHeading(mounted.container);
    assert.ok(heading, "the results heading is rendered");
    assert.equal(
      harnessDocument.activeElement,
      heading,
      "focus is on the heading whose text is Price-volume-mix bridge",
    );
  } finally {
    await mounted.unmount();
  }
});

test("the results tabs move and select with the arrow, Home and End keys", async () => {
  const raw = await openDatabase();
  const mounted = await mountApp("?sample=1000", queued(raw));
  try {
    await waitForSampleRun(mounted);
    const bridge = tabButtons(mounted.container).find((node) => node.textContent === "Bridge");
    assert.ok(bridge, "the Bridge tab is rendered");
    assert.equal(tabStop(bridge), 0, "the selected tab is the one tab stop");
    bridge.focus();

    const moved = (label: (text: string) => boolean) => {
      const selected = selectedTab(mounted.container);
      assert.ok(selected, "one tab is selected");
      assert.ok(label(selected.textContent), `the selected tab is ${selected.textContent}`);
      assert.equal(harnessDocument.activeElement, selected, "focus moves with the selection");
      const stops = tabIndexZero(mounted.container);
      assert.equal(stops.length, 1, "exactly one tab has tabIndex 0");
      assert.equal(stops[0], selected, "the tabIndex 0 tab is the selected one");
      return selected;
    };

    let event = await pressKey(mounted, bridge, "ArrowRight");
    assert.equal(event.defaultPrevented, true, "the arrow key does not scroll the page");
    moved((text) => text === "Movers");

    await pressKey(mounted, harnessDocument.activeElement, "End");
    moved((text) => text.startsWith("Data check"));

    await pressKey(mounted, harnessDocument.activeElement, "ArrowRight");
    moved((text) => text === "Bridge");

    await pressKey(mounted, harnessDocument.activeElement, "ArrowLeft");
    moved((text) => text.startsWith("Data check"));

    await pressKey(mounted, harnessDocument.activeElement, "Home");
    moved((text) => text === "Bridge");

    event = await pressKey(mounted, harnessDocument.activeElement, "Tab");
    assert.equal(event.defaultPrevented, false, "a key the strip ignores is left alone");
  } finally {
    await mounted.unmount();
  }
});

test("every results tab names the one panel, and the panel names the selected tab", async () => {
  const raw = await openDatabase();
  const mounted = await mountApp("?sample=1000", queued(raw));
  try {
    await waitForSampleRun(mounted);
    const check = () => {
      const panels = walk(mounted.container).filter((node) => node.getAttribute("role") === "tabpanel");
      assert.equal(panels.length, 1, "the results have one tab panel");
      const [panel] = panels;
      const selected = selectedTab(mounted.container);
      assert.ok(selected, "one tab is selected");
      assert.equal(panel.getAttribute("aria-labelledby"), selected.getAttribute("id"), "the panel names the selected tab");
      for (const tab of tabButtons(mounted.container)) {
        const controls = tab.getAttribute("aria-controls");
        assert.ok(controls, `${tab.textContent} names its panel`);
        assert.equal(controls, panel.getAttribute("id"), `${tab.textContent} points at the one panel`);
      }
      return selected;
    };

    check();
    await pressKey(mounted, harnessDocument.activeElement, "ArrowRight");
    check();
    await pressKey(mounted, harnessDocument.activeElement, "End");
    check();
    await pressKey(mounted, harnessDocument.activeElement, "Home");
    check();
  } finally {
    await mounted.unmount();
  }
});

test("the filter search box has a name of its own", async () => {
  const doc = installHarnessDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SetupPanel } = await import("../src/app/SetupPanel.tsx");
  const values = Array.from({ length: 10 }, (_, i) => ({ v: `P${i}` }));
  const query = async () => async (sql: string) =>
    sql.includes("GROUP BY 1") && sql.includes(" AS v ") ? values : [];
  const setup = {
    periodColumn: "year",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [],
    filters: [{ column: "product", mode: "include", values: [] }],
  } as const;
  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as HarnessNode);
  const root = createRoot(container as unknown as Element);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(SetupPanel, {
          columns: [
            { name: "year", type: "INTEGER" },
            { name: "product", type: "VARCHAR" },
            { name: "units", type: "DOUBLE" },
            { name: "sales", type: "DOUBLE" },
          ],
          setup,
          periods: ["2025", "2026"],
          prior: "2025",
          current: "2026",
          query,
          rollups: [],
          totalRows: [],
          onChange: () => {},
          onRefine: () => {},
          onPrior: () => {},
          onCurrent: () => {},
        } as unknown as Parameters<typeof SetupPanel>[0]),
      );
    });
    const box = () => harnessNodes(container, "INPUT").find((node) => node.getAttribute("placeholder") === "Search values");
    for (let i = 0; i < 100 && box() === undefined; i += 1) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const input = box();
    assert.ok(input, "the filter search box is on screen");
    assert.equal(input.getAttribute("aria-label"), "Search values");
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    doc.body.removeChild(container as unknown as HarnessNode);
  }
});

const PASTED = "period\tcustomer\tunits\n2025\tC0001\t10\n2026\tC0001\t12\n2026\tC0002\t7\n";

test("a paste made while a sample link waits to load is the data the visitor sees", async () => {
  holdFrames();
  const raw = await openDatabase();
  const mounted = await mountApp("?sample=1000", queued(raw));
  try {
    await mounted.dispatchPaste(PASTED);
    await mounted.until(
      () => harnessByClass(mounted.container, "source").some((node) => node.textContent.includes("Pasted cells.tsv")),
      "the pasted cells to load",
    );
    releaseFrames();
    // Give the deferred sample load its chance; after this the paste must still be what is shown.
    for (let i = 0; i < 80; i += 1) {
      await mounted.React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      if (!harnessByClass(mounted.container, "source").some((node) => node.textContent.includes("Pasted cells.tsv"))) break;
    }
    const caption = harnessByClass(mounted.container, "source").map((node) => node.textContent).join(" ");
    assert.ok(caption.includes("Pasted cells.tsv"), `the caption names the paste, but held ${caption}`);
    assert.ok(caption.includes("3 rows"), `the caption counts the paste's rows, but held ${caption}`);
    const dense = harnessByClass(mounted.container, "dense")[0];
    assert.ok(dense, "the preview table is on screen");
    const firstRow = harnessNodes(dense, "TR")[1];
    assert.ok(firstRow, "the preview has a first row");
    assert.deepEqual(
      harnessNodes(firstRow, "TD").map((cell) => cell.textContent),
      ["2025", "C0001", "10"],
      "the first preview row is the paste's first row",
    );
  } finally {
    releaseFrames();
    await mounted.unmount();
  }
});
