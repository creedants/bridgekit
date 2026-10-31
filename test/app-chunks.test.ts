import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { BridgeConfig, BridgeResult, DataCheck, Query, TieOut } from "../src/engine.ts";
import {
  EXCEL_TYPE,
  excelFileName,
  workbookBytes,
  type ExcelTools,
} from "../src/app/exportExcel.ts";
import { saveOnce } from "../src/app/files.ts";
import { lazyChunk, type ChunkSentences, type LazyChunk } from "../src/app/lazyChunk.ts";
import type { Results as ResultsComponent } from "../src/app/Results.tsx";

const FAKE_DATABASE_MODULE = `
export const PARQUET_REFUSAL = "That file is a Parquet file. Save it as CSV or Excel, then choose it again.";
export function openBrowserDatabase() { return Promise.resolve(globalThis.__bridgekitDatabase); }
`;

const LAZY_CHUNK_URL = new URL("../src/app/lazyChunk.ts", import.meta.url).href;
const FAKE_LAZY_CHUNK_MODULE = `
export * from ${JSON.stringify(LAZY_CHUNK_URL)};
export function scheduleSpeculative() { return () => {}; }
`;

// App.tsx is a .tsx file this runner cannot load by itself, so the esbuild copy
// the build already installs transforms it. The page database needs a browser
// and wasm bundles, so the hook replaces it with a module this file never calls.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    if (specifier === "./db.ts" && context.parentURL?.endsWith("/src/app/App.tsx")) {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_DATABASE_MODULE)}`, shortCircuit: true };
    }
    if (specifier === "./lazyChunk.ts" && context.parentURL?.endsWith("/src/app/App.tsx")) {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_LAZY_CHUNK_MODULE)}`, shortCircuit: true };
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

type ResultsView = typeof ResultsComponent;

class HarnessNode {
  nodeType: number;
  nodeName: string;
  childNodes: HarnessNode[] = [];
  parentNode: HarnessNode | null = null;

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): HarnessNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): HarnessNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[at + 1] ?? null;
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

  addEventListener(): void {}

  removeEventListener(): void {}
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
  style: Record<string, unknown> = {};

  constructor(tagName: string) {
    super(1, String(tagName).toUpperCase());
    this.tagName = this.nodeName;
    this.localName = String(tagName).toLowerCase();
  }

  get namespaceURI(): string {
    return "http://www.w3.org/1999/xhtml";
  }

  get ownerDocument(): HarnessDocument {
    return harnessDocument;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(String(name)) ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => (child as HarnessElement).textContent ?? "").join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "" && value != null) this.appendChild(new HarnessText(value));
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
  activeElement: HarnessElement | null;
  readyState: string;
};

let harnessDocument: HarnessDocument;

function installHarnessDom(): HarnessDocument {
  if (harnessDocument) return harnessDocument;
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
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  (doc as unknown as HarnessNode).appendChild(doc.documentElement);
  // react-dom reads the active element through ownerDocument.defaultView, and
  // walks nested frames from there.
  const view: Record<string, unknown> = {
    document: doc,
    HTMLIFrameElement: class extends HarnessElement {},
    Node: HarnessNode,
    Element: HarnessElement,
    HTMLElement: HarnessElement,
    addEventListener() {},
    removeEventListener() {},
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = view;
  globals.document = doc;
  globals.Node = HarnessNode;
  globals.Element = HarnessElement;
  globals.HTMLElement = HarnessElement;
  globals.HTMLIFrameElement = view.HTMLIFrameElement;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  harnessDocument = doc;
  return doc;
}

function renderedText(node: HarnessNode): string {
  if (node instanceof HarnessText) return node.data;
  return node.childNodes.map(renderedText).join("");
}

const MARKER = "loaded results view";
const WAITING = "waiting for the results view";
const SENTENCES: ChunkSentences = {
  network: "Could not load the results view.",
  gone: "Reload the page to start again.",
};

const parsedResults = (module: unknown) => (module as { Results?: ResultsView }).Results;

function probeView(React: typeof import("react"), view: ResultsView | null) {
  return view === null ? WAITING : React.createElement(view as unknown as () => import("react").ReactElement);
}

async function appModule() {
  installHarnessDom();
  return import("../src/app/App.tsx");
}

/** Settles every pending promise and React work the mount queued. */
async function flush(): Promise<void> {
  const React = await import("react");
  for (let i = 0; i < 8; i += 1) await React.act(async () => {});
}

test("a Results component that loads after the run is set reaches the page through state alone", async () => {
  const doc = installHarnessDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useResultsView } = await appModule();

  const Loaded: ResultsView = () => React.createElement("span", null, MARKER);
  let settle: (module: unknown) => void = () => {};
  const gate = new Promise<unknown>((resolve) => (settle = resolve));
  let imports = 0;
  const chunk: LazyChunk<ResultsView> = lazyChunk({
    importer: () => {
      imports += 1;
      return gate;
    },
    parse: parsedResults,
    sentences: SENTENCES,
  });

  let seen: ResultsView | null = null;
  function Probe() {
    const view = useResultsView(chunk);
    seen = view;
    return React.createElement("div", null, probeView(React, view));
  }

  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await React.act(async () => root.render(React.createElement(Probe)));
    await flush();

    assert.equal(renderedText(container), WAITING, "the page waits while the chunk is still loading");
    assert.equal(seen, null);
    assert.equal(chunk.loaded, undefined);
    assert.equal(imports, 0, "mounting starts no load of its own; the page still decides when the chunk downloads");

    // A load the page starts, as Calculate's does.
    const loading = chunk.load();
    await React.act(async () => {
      settle({ Results: Loaded });
      await loading;
    });
    await flush();

    assert.equal(renderedText(container), MARKER, "the resolved chunk reached the page with no other state change");
    assert.equal(seen, Loaded, "the page holds the exact component the chunk parsed");
    assert.equal(chunk.loaded, Loaded);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test("the page's render takes Results from the hook, not from the chunk getter", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  assert.match(source, /const Results = useResultsView\(resultsChunk\);/, "the render holds Results in state");
  assert.doesNotMatch(source, /resultsChunk\.loaded/, "no render reads the untracked getter");
});

test("the export's guard wraps the labelled build, so a refused click never reaches the task", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("saveOnce("), "the export goes through the shared guard");
  const guard = source.indexOf("excelFileName(job.config)");
  const build = source.indexOf('task("export"');
  assert.ok(guard > 0 && build > guard, "the build starts inside the guard, not before it");
  assert.doesNotMatch(source, /makeGuard/, "the page keeps no guard of its own");
});

test("a Results chunk loaded before mount shows Results on the first render", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { useResultsView } = await appModule();

  const Loaded: ResultsView = () => React.createElement("span", null, MARKER);
  const chunk: LazyChunk<ResultsView> = lazyChunk({
    importer: () => Promise.resolve({ Results: Loaded }),
    parse: parsedResults,
    sentences: SENTENCES,
  });
  await chunk.load();

  function Probe() {
    const view = useResultsView(chunk);
    return React.createElement("div", null, probeView(React, view));
  }

  // A static render runs no effect, so only the mount seed can show Results here.
  const html = renderToStaticMarkup(React.createElement(Probe));
  assert.match(html, new RegExp(MARKER), "the first render holds the loaded Results component");
});

test("a failed load leaves it null, and a retry the page starts later still reaches the page", async () => {
  const doc = installHarnessDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useResultsView } = await appModule();

  const Loaded: ResultsView = () => React.createElement("span", null, MARKER);
  const chunk: LazyChunk<ResultsView> = lazyChunk({
    importer: () => Promise.reject(new Error("chunk offline")),
    freshCopy: async () => ({ Results: Loaded }),
    parse: parsedResults,
    sentences: SENTENCES,
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  let seen: ResultsView | null = null;
  function Probe() {
    const view = useResultsView(chunk);
    seen = view;
    return React.createElement("div", null, probeView(React, view));
  }

  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await React.act(async () => root.render(React.createElement(Probe)));
    await flush();

    const failed = chunk.load().then(
      () => null,
      (error: unknown) => error,
    );
    await React.act(async () => {
      await failed;
    });
    await flush();
    // An unhandled rejection is reported on a later turn of the loop.
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(renderedText(container), WAITING, "the failed load leaves the page waiting, as before");
    assert.equal(seen, null);
    assert.equal(chunk.loaded, undefined);
    assert.deepEqual(unhandled, [], "the failure stays silent on this path");

    // Calculate loads the chunk again on the next click, and that retry can succeed.
    const retried = chunk.load();
    await React.act(async () => {
      await retried;
    });
    await flush();

    assert.equal(renderedText(container), MARKER, "a retry the page started after the failure reaches the page");
    assert.equal(seen, Loaded);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await React.act(async () => root.unmount());
  }
});

const zeroRow: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_target, key) => (typeof key === "symbol" ? undefined : key === "n" || key === "q0" ? 1 : 0),
  },
);

const config: BridgeConfig = {
  table: "sales",
  periodColumn: "period",
  prior: "2025",
  current: "2026",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
};

const result: BridgeResult = {
  priorSales: 0,
  currentSales: 1200,
  effects: [
    { key: "volume", label: "Volume", value: 0 },
    { key: "mix_1", label: "Mix: Product", value: 0 },
    { key: "price", label: "Price (like-for-like)", value: 1200 },
    { key: "new_config", label: "New configurations", value: 0 },
    { key: "discontinued", label: "Discontinued configurations", value: 0 },
    { key: "no_units", label: "Sales with no units", value: 0 },
  ],
  coverage: [],
  cellsTable: "bridge_cells",
};

const check: DataCheck = {
  rows: 0,
  priorRows: 0,
  currentRows: 0,
  otherPeriodRows: 0,
  blankPeriodRows: 0,
  blankMeasureRows: 0,
  negativeUnitRows: 0,
  negativeSalesRows: 0,
  zeroUnitSalesRows: 0,
};

const tieOut: TieOut = {
  prior: { period: "2025", inFile: 0, afterFilters: 0 },
  current: { period: "2026", inFile: 1200, afterFilters: 1200 },
};

const zeroRowQuery: Query = async () => [zeroRow];
/** App's `query`: it resolves the database's query function before a build runs. */
const query = () => Promise.resolve(zeroRowQuery);

const periods = (prior: string, current: string): BridgeConfig => ({ ...config, prior, current });

/** App's composition: the guard owns the file name, and the build runs inside the content function. */
const exportWorkbook = (cfg: BridgeConfig, tools: ExcelTools) =>
  saveOnce(
    excelFileName(cfg),
    async () => workbookBytes(await query(), cfg, result, check, tieOut, ["Source: sample.csv"], tools),
    EXCEL_TYPE,
  );

type Captured = { blobs: Blob[]; names: string[] };

function captureDownloads(): { captured: Captured; restore: () => void } {
  const captured: Captured = { blobs: [], names: [] };
  const globals = globalThis as unknown as Record<string, unknown>;
  const realDocument = globals.document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  globals.document = {
    createElement: () => {
      const anchor = { href: "", download: "", click: () => captured.names.push(anchor.download) };
      return anchor;
    },
  };
  URL.createObjectURL = (blob: Blob) => {
    captured.blobs.push(blob);
    return "blob:app-chunks";
  };
  URL.revokeObjectURL = () => {};
  return {
    captured,
    restore: () => {
      globals.document = realDocument;
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    },
  };
}

test("a second Excel click during a build neither builds nor saves a second workbook", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const { captured, restore } = captureDownloads();
  try {
    let loadCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tools: ExcelTools = {
      load: () => {
        loadCalls += 1;
        return gate.then(() => ExcelJS);
      },
    };

    const cfg = periods("2025", "2026");
    const first = exportWorkbook(cfg, tools);
    const second = exportWorkbook(cfg, tools);
    // The build waits on the gate, so only the first click can reach the loader.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(loadCalls, 1, "the second click is refused before a second build starts");

    release();
    await Promise.all([first, second]);

    assert.equal(loadCalls, 1, "the build ran once");
    assert.equal(captured.blobs.length, 1, "one workbook is downloaded");
    assert.deepEqual(captured.names, ["bridge-2025-to-2026.xlsx"]);
  } finally {
    restore();
  }
});

test("a failed build saves nothing and frees the file name for the next click", async () => {
  const { captured, restore } = captureDownloads();
  try {
    const broken: ExcelTools = { load: () => Promise.reject(new Error("the Excel tools did not load")) };
    const cfg = periods("2027", "2028");
    await assert.rejects(exportWorkbook(cfg, broken), /the Excel tools did not load/);
    assert.equal(captured.blobs.length, 0, "a build that throws saves nothing");

    await exportWorkbook(cfg, { load: () => import("exceljs").then((module) => module.default) });
    assert.deepEqual(captured.names, [excelFileName(cfg)], "the same name saves on the next click");
  } finally {
    restore();
  }
});

test("an export that builds nothing saves nothing and frees the file name", async () => {
  const { captured, restore } = captureDownloads();
  try {
    const cfg = periods("2029", "2030");
    // App's content function returns null when its task reports a failed build.
    await saveOnce(excelFileName(cfg), async () => null, EXCEL_TYPE);
    assert.equal(captured.blobs.length, 0, "a null build saves nothing");

    await exportWorkbook(cfg, { load: () => import("exceljs").then((module) => module.default) });
    assert.deepEqual(captured.names, [excelFileName(cfg)], "the same name saves on the next click");
  } finally {
    restore();
  }
});
