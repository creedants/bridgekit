import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";
import { PERIOD, VIEW } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";

// The Data check helper lives in Results.tsx, and this runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already installs. The database module is kept off the wasm bundles the
// browser build imports by URL, the way test/date-order.test.ts does it. The
// small-bridges grid is replaced by a stub because it opens the page database
// as it loads, and this runner has none of the browser it needs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    if (specifier.endsWith("SmallBridges.tsx")) {
      return {
        url: "data:text/javascript,export const SmallBridges = () => null",
        shortCircuit: true,
      };
    }
    if (specifier.endsWith("Waterfall.tsx")) {
      return {
        url: "data:text/javascript,export const Waterfall = () => null",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(new URL(url), "utf8");
      const { code } = transformSync(source, { loader: "tsx", format: "esm", jsx: "automatic" });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// Ambiguous slash dates, so the file is one the load reads month-first, beside
// a column whose numbers use a decimal comma.
const BOTH_FILE = `period;date;net_sales
2025;03/04/2025;1.234,56
2025;05/06/2025;12,50
`;

const DATE_FILE = `period;date;units
2025;03/04/2025;3
2025;05/06/2025;4
`;

// An ISO date and plain integers, so neither sentence applies.
const NEITHER_FILE = `period;date;units
2025;2025-03-04;3
2025;2025-05-06;4
`;

const DECIMAL = "1 column was read as numbers written with a decimal comma.";

/** Loads a fixture through the loader and number conversion the app uses. */
async function loaded(name: string, text: string): Promise<Query> {
  const directory = await mkdtemp("/tmp/bridgekit-notes-");
  const file = path.join(directory, `${name}.csv`);
  await writeFile(file, text);
  const { readCsvTable } = await import("../src/app/db.ts");
  const query = await openDatabase();
  try {
    await readCsvTable(query, name, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await convertFormattedNumbers(query, name);
  return query;
}

async function notes(query: Query, table: string, formulaBlanks?: number): Promise<string[]> {
  const { dataCheckNotes } = await import("../src/app/Results.tsx");
  return dataCheckNotes(query, table, formulaBlanks);
}

test("the Data check shows the decimal comma and the month-first sentences in order", async () => {
  const query = await loaded("both", BOTH_FILE);
  assert.deepEqual(await notes(query, "both"), [
    DECIMAL,
    "1 column with slash dates was read month-first: date.",
  ]);
});

test("the Data check shows the month-first sentence without the decimal comma one", async () => {
  const query = await loaded("dates", DATE_FILE);
  assert.deepEqual(await notes(query, "dates"), ["1 column with slash dates was read month-first: date."]);
});

test("the Data check shows no sentence for a file read as typed", async () => {
  const query = await loaded("neither", NEITHER_FILE);
  assert.deepEqual(await notes(query, "neither"), []);
});

test("a failing date order query still shows the decimal comma sentence", async () => {
  const query = await loaded("onefailed", BOTH_FILE);
  const picky: Query = (sql) =>
    sql.includes("duckdb_columns()") && sql.includes("'month first'")
      ? Promise.reject(new Error("the date order query failed"))
      : query(sql);
  assert.deepEqual(await notes(picky, "onefailed"), [DECIMAL]);
});

test("the Data check shows the singular formula sentence for one blank cell", async () => {
  const query = await loaded("single", NEITHER_FILE);
  assert.deepEqual(await notes(query, "single", 1), [
    "1 cell in the Excel file holds a formula with no saved result, so it was read as blank. Open and save the file in Excel, then load it again.",
  ]);
});

test("the Data check shows the plural formula sentence after the other read notes", async () => {
  const query = await loaded("plural", BOTH_FILE);
  assert.deepEqual(await notes(query, "plural", 2), [
    DECIMAL,
    "1 column with slash dates was read month-first: date.",
    "2 cells in the Excel file hold a formula with no saved result, so they were read as blank. Open and save the file in Excel, then load it again.",
  ]);
});

test("the Data check formats a large formula count with a thousands separator", async () => {
  const query = await loaded("large", NEITHER_FILE);
  assert.deepEqual(await notes(query, "large", 1000), [
    "1,000 cells in the Excel file hold a formula with no saved result, so they were read as blank. Open and save the file in Excel, then load it again.",
  ]);
});

test("the Data check shows no formula sentence at zero", async () => {
  const query = await loaded("zero", NEITHER_FILE);
  assert.deepEqual(await notes(query, "zero", 0), []);
  assert.deepEqual(await notes(query, "zero"), []);
});

/** A file with decimal commas and one period that holds a whole semicolon row. */
async function mixedLoaded(): Promise<{ query: Query; table: string }> {
  const query = await openDatabase();
  const table = "mixed";
  await query(`CREATE TABLE ${table} (period VARCHAR, units DOUBLE, amount VARCHAR)`);
  await query(
    `INSERT INTO ${table} VALUES ('2024', 3, '1.234,56'), ('2025', 4, '12,50'), ('2024;7;99', 5, '7,25')`,
  );
  await convertFormattedNumbers(query, table);
  await query(`CREATE VIEW ${VIEW} AS SELECT CAST(period AS VARCHAR) AS ${PERIOD} FROM ${table}`);
  return { query, table };
}

test("the whole-row note loads as a warning, not a decimal comma note", async () => {
  const { query, table } = await mixedLoaded();
  const whole = `1 row has a period such as "2024;7;99" that looks like a whole row. The file may mix separators. Save it again with one separator.`;
  assert.equal(await decimalCommaNote(query, table), `${DECIMAL} ${whole}`);
  assert.equal(await decimalCommaNote(query, table, false), DECIMAL);
  assert.deepEqual(await notes(query, table), [DECIMAL]);
});

// The tab count regression below mounts the real Results component. It uses a
// controlled query so wholeRowNote resolves through the real hook, without a
// database file. A helper-only count would not catch the JSX wiring the
// review mutation breaks.

class CheckShimNode {
  nodeType: number;
  nodeName: string;
  childNodes: CheckShimNode[] = [];
  parentNode: CheckShimNode | null = null;
  private listeners = new Map<string, Set<(event: { type: string; target?: unknown; bubbles?: boolean }) => void>>();

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): CheckShimNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): CheckShimNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): CheckShimNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[at + 1] ?? null;
  }

  get previousSibling(): CheckShimNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return at > 0 ? this.parentNode.childNodes[at - 1] : null;
  }

  appendChild(child: CheckShimNode): CheckShimNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: CheckShimNode, before: CheckShimNode | null): CheckShimNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before === null ? -1 : this.childNodes.indexOf(before);
    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: CheckShimNode): CheckShimNode {
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

class CheckShimText extends CheckShimNode {
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

class CheckShimElement extends CheckShimNode {
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

  get ownerDocument(): CheckShimElement {
    return document as unknown as CheckShimElement;
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
    return this.childNodes.map((child) => (child as CheckShimElement).textContent ?? "").join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "" && value != null) this.appendChild(new CheckShimText(value));
  }
}

type CheckShimDocument = CheckShimElement & {
  createElement(tag: string): CheckShimElement;
  createElementNS(namespace: string, tag: string): CheckShimElement;
  createTextNode(text: string): CheckShimText;
  createComment(text: string): CheckShimText;
  documentElement: CheckShimElement;
  body: CheckShimElement;
  head: CheckShimElement;
  HTMLIFrameElement: unknown;
};

function installCheckDom(): CheckShimDocument {
  const existing = (globalThis as unknown as { document?: CheckShimDocument }).document;
  if (existing && (existing as unknown as { body?: unknown }).body) return existing;
  const doc = new CheckShimElement("#document") as unknown as CheckShimDocument;
  (doc as unknown as { nodeType: number }).nodeType = 9;
  doc.createElement = (tag: string) => new CheckShimElement(tag);
  doc.createElementNS = (_namespace: string, tag: string) => new CheckShimElement(tag);
  doc.createTextNode = (text: string) => new CheckShimText(text);
  doc.createComment = (text: string) => new CheckShimText(text);
  doc.documentElement = new CheckShimElement("html");
  doc.head = new CheckShimElement("head");
  doc.body = new CheckShimElement("body");
  doc.HTMLIFrameElement = class extends CheckShimElement {};
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  (doc as unknown as CheckShimNode).appendChild(doc.documentElement);
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
    Node: CheckShimNode,
    Element: CheckShimElement,
    HTMLElement: CheckShimElement,
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
  globals.Node = CheckShimNode;
  globals.Element = CheckShimElement;
  globals.HTMLElement = CheckShimElement;
  globals.HTMLIFrameElement = doc.HTMLIFrameElement;
  globals.Event = view.Event;
  globals.MutationObserver = view.MutationObserver;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return doc;
}

const WHOLE_ROW_WARNING = `1 row has a period such as "2025;A-100;10;100" that looks like a whole row. The file may mix separators. Save it again with one separator.`;
const NO_ISSUES = "No issues found in the rows used.";

function controlledQuery(kind: "whole" | "clean"): Query {
  return async (sql: string) => {
    if (sql.includes("DESCRIBE")) {
      return [
        { column_name: "period", column_type: "VARCHAR" },
        { column_name: "units", column_type: "DOUBLE" },
        { column_name: "sales", column_type: "DOUBLE" },
      ];
    }
    if (sql.includes("judged")) {
      if (kind === "whole") return [{ n: 1, example: "2025;A-100;10;100" }];
      return [{ n: 0, example: null }];
    }
    return [];
  };
}

function checkRun(): unknown {
  const check = {
    rows: 2,
    priorRows: 1,
    currentRows: 1,
    otherPeriodRows: 0,
    blankPeriodRows: 0,
    blankMeasureRows: 0,
    negativeUnitRows: 0,
    negativeSalesRows: 0,
    zeroUnitSalesRows: 0,
  };
  const config = {
    table: "data",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Size", columns: ["size"] }],
  };
  const result = {
    priorSales: 100,
    currentSales: 120,
    effects: [],
    coverage: [{ level: 1, share: 1, label: "Exact", cells: 10, sales: 120 }],
  };
  const tieOut = {
    prior: { period: "2025", inFile: 100, afterFilters: 100 },
    current: { period: "2026", inFile: 120, afterFilters: 120 },
  };
  const setup = {
    periodColumn: "period",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Size", columns: ["size"] }],
    filters: [],
  };
  return {
    check,
    config,
    result,
    tieOut,
    ms: 1,
    textColumns: ["size"],
    periods: ["2025", "2026"],
    description: [],
    setup,
    source: "A-100.csv",
    sample: false,
    formulaBlanks: 0,
    amounts: null,
  };
}

function collectNodes(node: CheckShimNode | null, name: string, out: CheckShimElement[] = []): CheckShimElement[] {
  if (!node) return out;
  if (node instanceof CheckShimElement && node.nodeName === name) out.push(node);
  for (const child of node.childNodes) collectNodes(child, name, out);
  return out;
}

async function mountDataCheck(kind: "whole" | "clean"): Promise<{ doc: CheckShimDocument; container: CheckShimElement; unmount: () => Promise<void> }> {
  const doc = installCheckDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Results } = await import("../src/app/Results.tsx");
  const run = checkRun();
  const stub = controlledQuery(kind);
  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as CheckShimNode);
  const root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root.render(React.createElement(Results, { run: run as never, query: (() => Promise.resolve(stub)) as never }));
  });
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await React.act(async () => {});
  };
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
  return {
    doc,
    container,
    unmount: async () => {
      await React.act(async () => {
        root.unmount();
      });
      doc.body.removeChild(container as unknown as CheckShimNode);
    },
  };
}

async function openDataCheck(container: CheckShimElement): Promise<void> {
  const React = await import("react");
  const buttons = collectNodes(container as unknown as CheckShimNode, "BUTTON");
  const target = buttons.find((button) => button.textContent.startsWith("Data check"));
  assert.ok(target, `the Data check tab is on screen among: ${buttons.map((b) => b.textContent).join(" | ")}`);
  await React.act(async () => {
    target.dispatchEvent({ type: "click", bubbles: true, target });
  });
  for (let i = 0; i < 4; i += 1) await React.act(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i += 1) await React.act(async () => {});
}

test("the Data check tab counts a whole-row-only warning and hides the success line", async () => {
  const mounted = await mountDataCheck("whole");
  try {
    const buttons = collectNodes(mounted.container as unknown as CheckShimNode, "BUTTON");
    const tab = buttons.find((button) => button.textContent.startsWith("Data check"));
    assert.equal(tab?.textContent, "Data check (1)");
    await openDataCheck(mounted.container);
    const text = (mounted.container as CheckShimElement).textContent;
    assert.ok(text.includes(WHOLE_ROW_WARNING), `the whole-row warning is not in the warning list: ${text.slice(0, 800)}`);
    assert.ok(!text.includes(NO_ISSUES), `the success line shows beside the whole-row warning: ${text.slice(0, 800)}`);
    const lists = collectNodes(mounted.container as unknown as CheckShimNode, "UL");
    assert.ok(lists.length > 0, "the warning list is not on screen for a whole-row-only file");
    assert.ok(lists.some((list) => list.textContent.includes(WHOLE_ROW_WARNING)), "the whole-row warning is not inside a warning list");
  } finally {
    await mounted.unmount();
  }
});

test("a clean Data check shows the bare tab and the success line", async () => {
  const mounted = await mountDataCheck("clean");
  try {
    const buttons = collectNodes(mounted.container as unknown as CheckShimNode, "BUTTON");
    const tab = buttons.find((button) => button.textContent.startsWith("Data check"));
    assert.equal(tab?.textContent, "Data check");
    await openDataCheck(mounted.container);
    const text = (mounted.container as CheckShimElement).textContent;
    assert.ok(text.includes(NO_ISSUES), `the success line is missing for a clean run: ${text.slice(0, 800)}`);
    assert.ok(!text.includes("looks like a whole row"), `a warning shows on a clean run: ${text.slice(0, 800)}`);
    const lists = collectNodes(mounted.container as unknown as CheckShimNode, "UL");
    const warningLists = lists.filter((list) => list.textContent.includes("looks like a whole row") || list.textContent.includes("blank units"));
    assert.equal(warningLists.length, 0, "a warning list shows on a clean run");
  } finally {
    await mounted.unmount();
  }
});
