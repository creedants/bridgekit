import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { dataCheck, runBridge, type BridgeConfig } from "../engine.ts";
import { summarize } from "../summary.ts";
import { createSyntheticSales } from "../synth.ts";
import {
  lazyChunk,
  openBrowserDatabase,
  scheduleSpeculative,
  type BrowserDatabase,
  type ChunkSentences,
} from "./db.ts";
import { exportExcel } from "./exportExcel.ts";
import { download } from "./files.ts";
import { whole } from "./format.ts";
import { distinctCounts, findRollups } from "./profile.ts";
import { loadPeriodList, type PeriodSort } from "./periods.ts";
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

const RESULTS_FAILURE: ChunkSentences = {
  network: "Could not load the results view. Check your connection, then choose Calculate bridge again.",
  gone: "Reload the page to start again.",
};

function resultsView(module: unknown): ResultsView | undefined {
  if (typeof module !== "object" || module === null || !("Results" in module)) return undefined;
  const component = module.Results;
  return typeof component === "function" ? (component as ResultsView) : undefined;
}

const resultsChunk = lazyChunk({
  importer: () => import("./Results.tsx"),
  parse: resultsView,
  sentences: RESULTS_FAILURE,
});

function prefetchResults(): void {
  void resultsChunk.load().catch(() => {});
}

const RESULTS_PREFETCH_SETTLE_MS = 150;

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
  const [periodSort, setPeriodSort] = useState<PeriodSort>("text");
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
      setPeriodSort("text");
      return;
    }
    let stale = false;
    task("Reading periods…", async () => {
      const q = await query();
      await q(viewSql(setup));
      const list = await loadPeriodList(q, quote(PERIOD), quote(VIEW));
      if (stale) return;
      const values = [...list.values];
      setPeriods(values);
      setPeriodSort(list.sort);
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
      const [q] = await Promise.all([query(), resultsChunk.load()]);
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
        periodSort,
        textColumns: columns.filter((c) => !/INT|DOUBLE|DECIMAL|FLOAT|REAL|DATE|TIMESTAMP/i.test(c.type)).map((c) => c.name),
        description: describeSetup(setup, prior, current, source),
        id: Date.now(),
        signature,
      });
      saveSetup(columns, setup);
      setNotice("");
    });

  useEffect(() => scheduleSpeculative(prefetchResults, RESULTS_PREFETCH_SETTLE_MS), []);

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

  const Results = resultsChunk.loaded;

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
            {run && Results ? (
              <Results key={run.id} run={run} query={query} />
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
