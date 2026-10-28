import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { dataCheck, periodMoney, runBridge, type BridgeConfig, type Query } from "../engine.ts";
import { summarize } from "../summary.ts";
import { resolveSample, type Sample } from "../synth.ts";
import {
  openBrowserDatabase,
  PARQUET_REFUSAL,
  scheduleSpeculative,
  type BrowserDatabase,
} from "./db.ts";
import { exportExcel, lazyChunk, type ChunkSentences } from "./exportExcel.ts";
import { download } from "./files.ts";
import { fileProblem, periodView, periodsFor, type FileProblem, type LoadedPeriods } from "./fileProblems.ts";
import { whole } from "./format.ts";
import { findTotalRows, profileFile, type TotalRow } from "./profile.ts";
import { loadPeriodList } from "./periods.ts";
import { describeSetup } from "./report.ts";
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewCell(type: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  const normalized = type.trim().toUpperCase();
  if (normalized === "DATE") {
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
    if (typeof value === "bigint") {
      const date = new Date(Number(value));
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }
  }
  if (normalized.includes("TIMESTAMP")) {
    let ms: number | null = null;
    if (typeof value === "number" && Number.isFinite(value)) ms = value;
    else if (typeof value === "bigint") ms = Number(value);
    else if (value instanceof Date) ms = value.getTime();
    if (ms !== null) {
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date.toISOString().replace("T", " ").slice(0, 19);
    }
  }
  return String(value);
}

/** The loaded file's rows with the same period column as VIEW, before the filters. */
const FILE_VIEW = "data_all";

// The two relations the Data check compares. viewSql is the only place a period
// is derived, so the file's copy is made from it with the filters removed and
// renamed, which keeps its period column identical to the bridge's.
async function buildViews(q: Query, setup: Setup): Promise<void> {
  await q(`DROP VIEW IF EXISTS ${quote(FILE_VIEW)}`);
  await q(viewSql({ ...setup, filters: [] }));
  await q(`ALTER VIEW ${quote(VIEW)} RENAME TO ${quote(FILE_VIEW)}`);
  await q(viewSql(setup));
}

export function App() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const [columns, setColumns] = useState<Column[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [load, setLoad] = useState(0);
  const [loadedPeriods, setLoadedPeriods] = useState<LoadedPeriods | null>(null);
  const [suggestedPeriods, setSuggestedPeriods] = useState<Sample["periods"] | null>(null);
  const [prior, setPrior] = useState("");
  const [current, setCurrent] = useState("");
  const [remember, setRemember] = useState(isRemembering);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [rollups, setRollups] = useState<string[][]>([]);
  const [detected, setDetected] = useState<{ key: string; rows: TotalRow[] } | null>(null);
  const [run, setRun] = useState<(Run & { id: number; signature: string }) | null>(null);
  const [formulaBlanks, setFormulaBlanks] = useState(0);
  // A demonstration sample must not overwrite a setup saved for a file with the same columns.
  const writesSetup = useRef(true);
  // Labels the newest load, so work started for an earlier file can tell it is stale.
  const loadRef = useRef(0);

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

  async function afterLoad(name: string, preset?: Sample) {
    const thisLoad = ++loadRef.current;
    const q = await query();
    const described = await q(`DESCRIBE ${quote(TABLE)}`);
    const found = described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
    const [count] = await q(`SELECT count(*)::DOUBLE AS n FROM ${quote(TABLE)}`);
    if (loadRef.current !== thisLoad) return;
    const saved = preset ? null : loadSavedSetup(found);
    setColumns(found);
    setRowCount(Number(count.n));
    setSource(name);
    setRun(null);
    setLoad(thisLoad);
    setSetup(preset?.setup ?? saved ?? guessSetup(found));
    setSuggestedPeriods(preset?.periods ?? null);
    writesSetup.current = preset?.savesSetup ?? true;
    setNotice(saved ? "Restored the setup you last used with these columns." : "");
    const previewRows = await q(`SELECT * FROM ${quote(TABLE)} LIMIT 8`);
    if (loadRef.current !== thisLoad) return;
    setPreview(previewRows);
    setRollups([]);
    // Profiling is a convenience; the tool works without it.
    profileFile(q, found, () => loadRef.current === thisLoad, (profile) => {
      setColumns(profile.columns);
      setRollups(profile.rollups);
    }).catch(() => {});
  }

  const loadSample = () => {
    prefetchResults();
    const { sample, rows } = resolveSample(new URLSearchParams(location.search).get("sample"));
    return task("Generating sample data…", async () => {
      await sample.create(await query(), rows, TABLE);
      setFormulaBlanks(0);
      await afterLoad(sample.label, sample);
    });
  };

  const loadFile = (file: File) => {
    if (/\.parquet$/i.test(file.name)) {
      return task(`Reading ${file.name}…`, async () => {
        throw new Error(PARQUET_REFUSAL);
      });
    }
    prefetchResults();
    return task(`Reading ${file.name}…`, async () => {
      setFormulaBlanks(await (await db()).loadFile(file, TABLE));
      await afterLoad(file.name);
    });
  };

  // Rebuild the filtered view and the period list whenever they could change.
  // The load count stands in for the file name, so a second file with the same name still re-reads.
  const view = setup
    ? periodView({ load, periodColumn: setup.periodColumn, grain: setup.grain, filters: setup.filters })
    : null;
  useEffect(() => {
    if (view === null || !setup) return;
    if (!setup.periodColumn) {
      setLoadedPeriods({ view, values: [] });
      return;
    }
    let stale = false;
    const requested = view;
    task("Reading periods…", async () => {
      const q = await query();
      await buildViews(q, setup);
      const list = await loadPeriodList(q, quote(PERIOD), quote(VIEW));
      if (stale) return;
      const values = [...list.values];
      setLoadedPeriods({ view: requested, values });
      // A sample that compares two named periods says which one is prior.
      const pick = (kept: string, suggested: string | undefined, fallback: string) =>
        values.includes(kept) ? kept : suggested !== undefined && values.includes(suggested) ? suggested : fallback;
      setCurrent((value) => pick(value, suggestedPeriods?.current, values.at(-1) ?? ""));
      setPrior((value) => pick(value, suggestedPeriods?.prior, values.at(-2) ?? ""));
    });
    return () => {
      stale = true;
    };
  }, [view]);

  const offeredPeriods = loadedPeriods ? [...loadedPeriods.values] : [];
  const problemPeriods = periodsFor(view, loadedPeriods);

  // A total row from a spreadsheet export would count the same amounts twice.
  const totalKey = setup ? JSON.stringify([load, setup.periodColumn, setup.levels.map((level) => level.columns)]) : "";
  useEffect(() => {
    if (!setup) return;
    const key = totalKey;
    let stale = false;
    query()
      .then((q) => findTotalRows(q, TABLE, setup))
      .then((rows) => {
        if (!stale) setDetected({ key, rows });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [totalKey]);
  // A setup that has moved on must not show the previous columns' offers.
  const totalRows = detected && detected.key === totalKey ? detected.rows : [];

  const signature = JSON.stringify([setup, prior, current, source]);
  const fresh = run && run.signature === signature ? run : null;
  const ready =
    setup && setup.unitsColumn && setup.salesColumn && setup.levels.length > 0 && prior && current && prior !== current;
  const problem: FileProblem = setup
    ? fileProblem({
        columns,
        rows: rowCount,
        periodColumn: setup.periodColumn,
        periods: problemPeriods,
        unitsColumn: setup.unitsColumn,
        salesColumn: setup.salesColumn,
      })
    : { kind: "none" };

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
      const tieOut = await periodMoney(q, config, { table: FILE_VIEW, periodColumn: PERIOD });
      setRun({
        config,
        result,
        check,
        tieOut,
        ms,
        periods: offeredPeriods,
        textColumns: columns.filter((c) => !/INT|DOUBLE|DECIMAL|FLOAT|REAL|DATE|TIMESTAMP/i.test(c.type)).map((c) => c.name),
        description: describeSetup(setup, prior, current, source),
        setup,
        source,
        formulaBlanks,
        id: Date.now(),
        signature,
      });
      if (writesSetup.current) saveSetup(columns, setup);
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
      if (!fresh) return;
      await exportExcel(await query(), fresh.config, fresh.result, fresh.check, fresh.tieOut, fresh.description);
    });

  const importSetup = (file: File) =>
    task("Reading setup…", async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("That file is not a setup file.");
      }
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
        accept=".csv,.tsv,.txt,.xlsx"
        className="file-input"
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
          PVM Bridge
        </a>
        <span className="source">
          {source ? `${source} · ${whole(rowCount)} rows · ${columns.length} columns` : "No data loaded"}
        </span>
        <span className="status" aria-live="polite">{busy}</span>
        <nav>
          {filePicker}
          <button disabled={!fresh || !!busy} onClick={exportWorkbook}>Export Excel</button>
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
            Drop a CSV or Excel file anywhere on this page, or paste cells copied from a spreadsheet (Ctrl+V), one row per sales line. It needs a period or date
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
              <tr><th>period</th><th>customer</th><th>model</th><th>material</th><th>finish</th><th className="num">units</th><th className="num">gross_sales</th><th className="num">net_sales</th></tr>
            </thead>
            <tbody>
              <tr><td>2025</td><td>C0001</td><td>MD12</td><td>MT2</td><td>FN01</td><td className="num">40</td><td className="num">4,400</td><td className="num">3,960</td></tr>
              <tr><td>2026</td><td>C0001</td><td>MD12</td><td>MT2</td><td>FN01</td><td className="num">52</td><td className="num">5,980</td><td className="num">5,262</td></tr>
              <tr><td>2026</td><td>C0002</td><td>MD12</td><td>MT5</td><td>FN00</td><td className="num">8</td><td className="num">1,120</td><td className="num">1,120</td></tr>
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
              periods={offeredPeriods}
              prior={prior}
              current={current}
              query={query}
              rollups={rollups}
              totalRows={totalRows}
              onChange={(patch) => setSetup((s) => (s ? { ...s, ...patch } : s))}
              onPrior={setPrior}
              onCurrent={setCurrent}
            />
            <div className="run">
              <button className="primary" disabled={!ready || !!busy} onClick={calculate}>
                Calculate bridge
              </button>
              {problem.kind === "note" && <p className="hint">{problem.message}</p>}
              {!ready && (
                <p className="hint">
                  {problem.kind === "reason"
                    ? problem.message
                    : prior && prior === current
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
                    if (e.target.checked && setup && writesSetup.current) saveSetup(columns, setup);
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
                    className="file-input"
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
                  bridge={fresh ? { summary: summarize(fresh.result, fresh.config), setup } : null}
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
            {run && !fresh && (
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
                              {previewCell(c.type, row[c.name])}
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
