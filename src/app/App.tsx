import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { dataCheck, runBridge, type BridgeConfig } from "../engine.ts";
import { summarize } from "../summary.ts";
import { createSyntheticSales } from "../synth.ts";
import { openBrowserDatabase, type BrowserDatabase } from "./db.ts";
import { exportExcel } from "./exportExcel.ts";
import { download } from "./files.ts";
import { whole } from "./format.ts";
import { distinctCounts, findRollups } from "./profile.ts";
import type { Run } from "./Results.tsx";
import {
  guessSetup,
  isRemembering,
  isValidSetup,
  loadSavedSetup,
  PERIOD,
  quote,
  saveSetup,
  setRemembering,
  TABLE,
  VIEW,
  viewSql,
  type Column,
  type Setup,
} from "./setup.ts";
import { SetupPanel } from "./SetupPanel.tsx";

// Pro workspaces exist only in builds with VITE_WORKSPACES=1; elsewhere the code is left out.
const WorkspacePanel = import.meta.env.VITE_WORKSPACES === "1" ? lazy(() => import("./Workspace.tsx")) : null;

type ResultsView = (props: {
  run: Run;
  query: () => Promise<BrowserDatabase["query"]>;
}) => ReactNode;

let resultsLoad: Promise<void> | null = null;
let LoadedResults: ResultsView | null = null;
// A failed import("./Results.tsx") stays failed for that URL. Later attempts use another URL.
let staticImportFailed = false;

const RESULTS_FAILURE = {
  network: "Could not load the results view. Check your connection, then choose Calculate bridge again.",
  gone: "Reload the page to start again.",
};

class ResultsUnavailable extends Error {
  constructor(kind: keyof typeof RESULTS_FAILURE) {
    super(RESULTS_FAILURE[kind]);
  }
}

function loadResults(): Promise<void> {
  if (resultsLoad) return resultsLoad;
  const reading = staticImportFailed ? importRetriedResults() : importStaticResults();
  const attempt = reading.then(
    () => undefined,
    (error: unknown) => {
      staticImportFailed = true;
      if (resultsLoad === attempt) resultsLoad = null;
      if (error instanceof ResultsUnavailable) throw error;
      throw new ResultsUnavailable("network");
    },
  );
  resultsLoad = attempt;
  return attempt;
}

async function importStaticResults(): Promise<void> {
  const mod = await import("./Results.tsx");
  const component: unknown = mod.Results;
  if (!isResultsView(component)) throw new ResultsUnavailable("gone");
  LoadedResults = mod.Results;
}

async function importRetriedResults(): Promise<void> {
  const chunkUrl = resultsChunkUrl();
  if (chunkUrl === null) throw new ResultsUnavailable("gone");
  const retryUrl = chunkUrl + "?retry=" + Date.now();
  let response: Response;
  try {
    response = await fetch(retryUrl, { cache: "no-store" });
  } catch {
    throw new ResultsUnavailable("network");
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok || contentType.includes("text/html") || !isJavaScriptContentType(contentType)) {
    throw new ResultsUnavailable("gone");
  }
  if (await bodyStartsWithMarkup(response)) throw new ResultsUnavailable("gone");
  const mod: unknown = await import(/* @vite-ignore */ retryUrl);
  const component = resultsExport(mod);
  if (!isResultsView(component)) throw new ResultsUnavailable("gone");
  LoadedResults = component;
}

const RESULTS_CHUNK_PATH = /^\/assets\/Results-[A-Za-z0-9_-]+\.js$/;

function resultsChunkUrl(): string | null {
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    if (!(link instanceof HTMLLinkElement)) continue;
    let parsed: URL;
    try {
      parsed = new URL(link.href);
    } catch {
      continue;
    }
    if (parsed.origin !== location.origin) continue;
    if (!RESULTS_CHUNK_PATH.test(parsed.pathname)) continue;
    return parsed.origin + parsed.pathname;
  }
  return null;
}

function isJavaScriptContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim() ?? "";
  return mediaType === "text/javascript" || mediaType === "application/javascript";
}

async function bodyStartsWithMarkup(response: Response): Promise<boolean> {
  const body = response.body;
  if (body === null) return false;
  const reader = body.getReader();
  try {
    const chunk = await reader.read();
    const bytes = chunk.value;
    if (bytes === undefined || bytes.length === 0) return false;
    return new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith("<");
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function resultsExport(mod: unknown): unknown {
  if (typeof mod !== "object" || mod === null) return undefined;
  if (!("Results" in mod)) return undefined;
  return mod.Results;
}

function isResultsView(value: unknown): value is ResultsView {
  return typeof value === "function";
}

function prefetchResults(): void {
  void loadResults().catch(() => {});
}

// The DOM lib in this toolchain does not declare Network Information.
// Read the live property and accept only a boolean true.
function networkSaveData(): boolean {
  const host: unknown = navigator;
  if (typeof host !== "object" || host === null || !("connection" in host)) return false;
  const connection = host.connection;
  if (typeof connection !== "object" || connection === null || !("saveData" in connection)) return false;
  return connection.saveData === true;
}

function prefetchResultsWhenIdle(): () => void {
  if (networkSaveData()) return () => {};
  let cancelled = false;
  let idleId: number | undefined;
  let timerId: number | undefined;
  const queuePrefetch = () => {
    if (cancelled) return;
    timerId = window.setTimeout(prefetchResults, 150);
  };
  const whenIdle = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(queuePrefetch, { timeout: 2000 });
      return;
    }
    timerId = window.setTimeout(queuePrefetch, 2000);
  };
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", whenIdle);
    if (idleId !== undefined) window.cancelIdleCallback(idleId);
    if (timerId !== undefined) window.clearTimeout(timerId);
  };
}

const SAMPLE_ROWS = 1_000_000;
const MAX_SAMPLE_ROWS = 5_000_000;

/** `?sample` uses the default size; `?sample=3000000` asks for a specific row count. */
function sampleRows(): number {
  const requested = Number(new URLSearchParams(location.search).get("sample"));
  return requested >= 1000 ? Math.min(Math.floor(requested), MAX_SAMPLE_ROWS) : SAMPLE_ROWS;
}

const SAMPLE_SETUP: Setup = {
  periodColumn: "year",
  grain: "value",
  unitsColumn: "jobs",
  salesColumn: "sales",
  levels: [
    { name: "Design", columns: ["design"] },
    { name: "Coating", columns: ["coating"] },
    { name: "Color", columns: ["photochromic", "polar"] },
    { name: "Material", columns: ["material"] },
  ],
  filters: [],
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeSetup(setup: Setup, prior: string, current: string, source: string): string[] {
  return [
    `Source: ${source}`,
    `Periods: ${prior} to ${current} (${setup.periodColumn}${setup.grain === "value" ? "" : ", by " + setup.grain})`,
    `Units column: ${setup.unitsColumn}`,
    `Sales column: ${setup.salesColumn}`,
    ...(setup.grossColumn ? [`Gross sales column: ${setup.grossColumn}`] : []),
    ...(setup.costColumn ? [`Cost column: ${setup.costColumn} (bridge is on margin)`] : []),
    ...setup.levels.map((level, i) => `Attribute ${i + 1}: ${level.name} (${level.columns.join(" + ")})`),
    `New and discontinued: ${setup.newAndDiscontinued === "full" ? "full sales, outside volume and mix" : "price difference only, units in volume"}`,
    ...setup.filters
      .filter((f) => f.values.length > 0)
      .map((f) => `Filter: ${f.column} ${f.mode === "include" ? "is one of" : "is not"} ${f.values.join(", ")}`),
  ];
}

export function App() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const [columns, setColumns] = useState<Column[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [periods, setPeriods] = useState<string[]>([]);
  const [prior, setPrior] = useState("");
  const [current, setCurrent] = useState("");
  const [remember, setRemember] = useState(isRemembering);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [rollups, setRollups] = useState<string[][]>([]);
  const [run, setRun] = useState<(Run & { id: number; signature: string }) | null>(null);

  function db(): Promise<BrowserDatabase> {
    return openBrowserDatabase();
  }
  const query = () => db().then((d) => d.query);

  async function task(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy("");
    }
  }

  async function afterLoad(name: string, preset?: Setup) {
    const q = await query();
    const described = await q(`DESCRIBE ${quote(TABLE)}`);
    const found = described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
    const [count] = await q(`SELECT count(*)::DOUBLE AS n FROM ${quote(TABLE)}`);
    const saved = preset ? null : loadSavedSetup(found);
    setColumns(found);
    setRowCount(Number(count.n));
    setSource(name);
    setRun(null);
    setSetup(preset ?? saved ?? guessSetup(found));
    setNotice(saved ? "Restored the setup you last used with these columns." : "");
    setPreview(await q(`SELECT * FROM ${quote(TABLE)} LIMIT 8`));
    setRollups([]);
    // Profiling is a convenience; the tool works without it.
    distinctCounts(q, found)
      .then((distinct) => {
        setColumns(found.map((c) => ({ ...c, distinct: distinct.get(c.name) })));
        return findRollups(q, found, distinct);
      })
      .then(setRollups)
      .catch(() => {});
  }

  const loadSample = () => {
    prefetchResults();
    return task("Generating sample data…", async () => {
      await createSyntheticSales(await query(), sampleRows(), TABLE);
      await afterLoad("Sample data (made-up lens sales)", SAMPLE_SETUP);
    });
  };

  const loadFile = (file: File) => {
    prefetchResults();
    return task(`Reading ${file.name}…`, async () => {
      await (await db()).loadFile(file, TABLE);
      await afterLoad(file.name);
    });
  };

  // Rebuild the filtered view and the period list whenever they could change.
  const viewKey = setup ? JSON.stringify([setup.periodColumn, setup.grain, setup.filters, source]) : "";
  useEffect(() => {
    if (!setup?.periodColumn) {
      setPeriods([]);
      return;
    }
    let stale = false;
    task("Reading periods…", async () => {
      const q = await query();
      await q(viewSql(setup));
      const rows = await q(
        `SELECT DISTINCT ${quote(PERIOD)} AS p FROM ${quote(VIEW)}
         WHERE ${quote(PERIOD)} IS NOT NULL ORDER BY 1 DESC LIMIT 200`,
      );
      if (stale) return;
      const values = rows.map((row) => String(row.p)).reverse();
      setPeriods(values);
      setCurrent((value) => (values.includes(value) ? value : (values.at(-1) ?? "")));
      setPrior((value) => (values.includes(value) ? value : (values.at(-2) ?? "")));
    });
    return () => {
      stale = true;
    };
  }, [viewKey]);

  const signature = JSON.stringify([setup, prior, current, source]);
  const ready =
    setup && setup.unitsColumn && setup.salesColumn && setup.levels.length > 0 && prior && current && prior !== current;

  const calculate = () =>
    task("Calculating…", async () => {
      if (!setup) return;
      const [q] = await Promise.all([query(), loadResults()]);
      const config: BridgeConfig = {
        table: VIEW,
        periodColumn: PERIOD,
        prior,
        current,
        unitsColumn: setup.unitsColumn,
        salesColumn: setup.salesColumn,
        grossColumn: setup.grossColumn || undefined,
        costColumn: setup.costColumn || undefined,
        levels: setup.levels,
        newAndDiscontinued: setup.newAndDiscontinued ?? "difference",
      };
      const start = performance.now();
      const result = await runBridge(q, config);
      const ms = performance.now() - start;
      const check = await dataCheck(q, config);
      setRun({
        config,
        result,
        check,
        ms,
        periods,
        textColumns: columns.filter((c) => !/INT|DOUBLE|DECIMAL|FLOAT|REAL|DATE|TIMESTAMP/i.test(c.type)).map((c) => c.name),
        description: describeSetup(setup, prior, current, source),
        id: Date.now(),
        signature,
      });
      saveSetup(columns, setup);
      setNotice("");
    });

  // main.tsx calls warmBrowserDatabase before this effect, so the database listener is first.
  useEffect(() => prefetchResultsWhenIdle(), []);

  // A link to /app/?sample opens the tool with the sample already calculated.
  const autoRun = useRef(new URLSearchParams(location.search).has("sample"));
  useEffect(() => {
    if (autoRun.current && !setup && !busy) loadSample();
  }, []);
  useEffect(() => {
    if (autoRun.current && ready && !busy) {
      autoRun.current = false;
      calculate();
    }
  }, [ready, busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && ready && !busy) calculate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Cells copied from a spreadsheet arrive as tab-separated text; load them like a file.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.split("\n").length < 2 || !text.includes("\t")) return;
      e.preventDefault();
      loadFile(new File([text], "Pasted cells.tsv", { type: "text/tab-separated-values" }));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const exportWorkbook = () =>
    task("Building Excel file…", async () => {
      if (!run || !setup) return;
      await exportExcel(await query(), run.config, run.result, run.check, describeSetup(setup, prior, current, source));
    });

  const importSetup = (file: File) =>
    task("Reading setup…", async () => {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isValidSetup(parsed, columns)) {
        throw new Error("That setup file does not match the columns in this data.");
      }
      setSetup(parsed);
    });

  const filePicker = (
    <label className="button">
      Choose file
      <input
        type="file"
        accept=".csv,.tsv,.txt,.parquet,.xlsx"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) loadFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <div
      className="shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) loadFile(file);
      }}
    >
      <header className="topbar">
        <a className="wordmark" href="/">
          <svg className="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="var(--accent)" /><rect x="6" y="17" width="5" height="9" fill="#fff" /><rect x="13.5" y="12" width="5" height="5" fill="#fff" opacity=".75" /><rect x="21" y="6" width="5" height="20" fill="#fff" /></svg>
          Bridgekit
        </a>
        <span className="source">
          {source ? `${source} · ${whole(rowCount)} rows · ${columns.length} columns` : "No data loaded"}
        </span>
        <span className="status" aria-live="polite">{busy}</span>
        <nav>
          {filePicker}
          <button disabled={!run || !!busy} onClick={exportWorkbook}>Export Excel</button>
          {setup && (
            <button
              title="Remove the loaded data from this tab"
              onClick={() => location.replace(location.pathname)}
            >
              Clear data
            </button>
          )}
          <a href="/guide.html" target="_blank" rel="noreferrer">Guide</a>
          <a href="/method.html" target="_blank" rel="noreferrer">Method</a>
        </nav>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      {!setup ? (
        <main className="empty">
          <h1>Load a sales file</h1>
          <p>
            Drop a CSV, Excel or Parquet file anywhere on this page, or paste cells copied from a spreadsheet (Ctrl+V), one row per sales line. It needs a period or date
            column, units, sales, and the product attributes you want in the bridge.
          </p>
          <p className="row">
            {filePicker}
            <button onClick={loadSample} disabled={!!busy}>Use sample data</button>
          </p>
          <p className="hint">The file is read inside this browser tab. It is not uploaded.</p>
          <h3>What the file should look like</h3>
          <table className="example">
            <thead>
              <tr><th>period</th><th>customer</th><th>design</th><th>material</th><th>coating</th><th className="num">units</th><th className="num">gross_sales</th><th className="num">net_sales</th></tr>
            </thead>
            <tbody>
              <tr><td>2025</td><td>Acme</td><td>D12</td><td>Poly</td><td>AR</td><td className="num">40</td><td className="num">4,400</td><td className="num">3,960</td></tr>
              <tr><td>2026</td><td>Acme</td><td>D12</td><td>Poly</td><td>AR</td><td className="num">52</td><td className="num">5,980</td><td className="num">5,262</td></tr>
              <tr><td>2026</td><td>Borel</td><td>D12</td><td>Hi-index</td><td>None</td><td className="num">8</td><td className="num">1,120</td><td className="num">1,120</td></tr>
            </tbody>
          </table>
          <p className="hint">
            Column names do not matter; you map them in the next step. A date column works in place of a period, and
            gross sales and cost are optional. See the <a href="/guide.html">guide</a>, or{" "}
            <a href="/sample-sales.csv" download>download a small sample file</a>.
          </p>
          {WorkspacePanel && (
            <Suspense>
              <WorkspacePanel columns={[]} setup={null} bridge={null} onUseSetup={() => {}} />
            </Suspense>
          )}
        </main>
      ) : (
        <div className="workspace">
          <aside>
            <SetupPanel
              columns={columns}
              setup={setup}
              periods={periods}
              prior={prior}
              current={current}
              query={query}
              rollups={rollups}
              onChange={(patch) => setSetup((s) => (s ? { ...s, ...patch } : s))}
              onPrior={setPrior}
              onCurrent={setCurrent}
            />
            <div className="run">
              <button className="primary" disabled={!ready || !!busy} onClick={calculate}>
                Calculate bridge
              </button>
              {!ready && (
                <p className="hint">
                  {prior && prior === current
                    ? "Prior and current must be different periods."
                    : "Choose periods, units, sales and at least one attribute."}
                </p>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => {
                    setRemembering(e.target.checked);
                    setRemember(e.target.checked);
                    if (e.target.checked && setup) saveSetup(columns, setup);
                  }}
                />
                Remember this setup in this browser
              </label>
              <p className="hint">
                {remember
                  ? "Column choices, attribute order and options are stored in this browser. Filter selections and your data are not. Untick to delete what is stored."
                  : "Off: nothing is stored except this choice. Closing or reloading the tab removes everything."}
              </p>
              <p className="row">
                <button
                  className="quiet"
                  onClick={() => download("bridgekit-setup.json", JSON.stringify(setup, null, 2), "application/json")}
                >
                  Save setup to file
                </button>
                <label className="button quiet">
                  Load setup
                  <input
                    type="file"
                    accept=".json"
                    hidden
                    onChange={(e) => {
                      if (e.target.files?.[0]) importSetup(e.target.files[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              </p>
            </div>
            {WorkspacePanel && (
              <Suspense>
                <WorkspacePanel
                  columns={columns.map((c) => c.name)}
                  setup={setup}
                  bridge={run && run.signature === signature ? { summary: summarize(run.result, run.config), setup } : null}
                  onUseSetup={(saved) => {
                    if (isValidSetup(saved, columns)) setSetup(saved);
                    else setError("That saved setup does not match the columns in this data.");
                  }}
                />
              </Suspense>
            )}
          </aside>
          <main>
            {notice && <p className="notice">{notice}</p>}
            {run && run.signature !== signature && (
              <p className="notice">The setup changed since this bridge was calculated. Calculate again to update it.</p>
            )}
            {run && LoadedResults ? (
              // LoadedResults is a module binding. React does not track it, so loadResults assigns it before setRun.
              <LoadedResults key={run.id} run={run} query={query} />
            ) : !run ? (
              <div>
                <p className="hint">
                  First rows of the file. Set up the bridge on the left, then choose Calculate bridge (Ctrl+Enter).
                </p>
                <div className="scroll">
                  <table className="dense">
                    <thead>
                      <tr>{columns.map((c) => <th key={c.name}>{c.name}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i}>
                          {columns.map((c) => (
                            <td key={c.name} className={/INT|DOUBLE|DECIMAL|FLOAT|REAL/i.test(c.type) ? "num" : ""}>
                              {row[c.name] === null ? "" : String(row[c.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </main>
        </div>
      )}
    </div>
  );
}
