import { lazy, Suspense, useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { download, isPastedTable, makeGuard, shorten } from "./files.ts";
import { fileProblem, periodView, periodsFor, type FileProblem, type LoadedPeriods } from "./fileProblems.ts";
import { whole } from "./format.ts";
import { findTotalRows, profileFile, type TotalRow } from "./profile.ts";
import { loadPeriodList } from "./periods.ts";
import { describeSetup } from "./report.ts";
import type { Run } from "./Results.tsx";
import {
  affectsRemember,
  guessSetup,
  hasData,
  initialPhase,
  isRemembering,
  isValidSetup,
  loadSavedSetup,
  mainView,
  nextPhase,
  PERIOD,
  quote,
  restoredSetup,
  SAMPLE_LABEL,
  saveSetup,
  setRemembering,
  shouldAutoRun,
  shouldWarn,
  TABLE,
  VIEW,
  viewSql,
  type Column,
  type EngineState,
  type LoadSource,
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

// The engine's download state, kept outside React so the first query of any
// load, and the start after first paint, report to the same place.
let engine: EngineState = "idle";
const engineWatchers = new Set<() => void>();

function setEngine(next: EngineState): void {
  if (engine === next) return;
  engine = next;
  for (const watcher of engineWatchers) watcher();
}

/** Opens the page's database. db.ts caches the open and forgets a failed one, so a later call retries. */
function startEngine(): Promise<BrowserDatabase> {
  const opening = openBrowserDatabase();
  if (engine !== "ready") setEngine("loading");
  opening.then(() => setEngine("ready"), () => setEngine("failed"));
  return opening;
}

function watchEngine(watcher: () => void): () => void {
  engineWatchers.add(watcher);
  return () => void engineWatchers.delete(watcher);
}

function useEngine(): EngineState {
  return useSyncExternalStore(watchEngine, () => engine);
}

type TaskKind = "periods" | "calc" | "export" | "import";

const SETUP_FILE = "pvm-bridge-setup.json";
const NOT_A_TABLE = "The pasted text is not a table. Copy cells from a spreadsheet, with a header row.";

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
  const [phase, dispatch] = useReducer(nextPhase, location.search, initialPhase);
  const engineState = useEngine();
  const [tasks, setTasks] = useState<ReadonlyMap<TaskKind, { label: string; id: number }>>(new Map());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState("");
  const [fromSample, setFromSample] = useState(false);
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
  const [saveGuard] = useState(() => makeGuard());
  const [exportGuard] = useState(() => makeGuard());
  // A demonstration sample must not overwrite a setup saved for a file with the same columns.
  const writesSetup = useRef(true);
  // Labels the newest load, so work started for an earlier file can tell it is stale.
  const loadRef = useRef(0);
  const taskRef = useRef(0);
  const scrollAfterRun = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Clear data reloads on purpose, so it must not ask whether to leave.
  const leaving = useRef(false);
  const sampleLinkRead = useRef(false);

  function db(): Promise<BrowserDatabase> {
    return startEngine();
  }
  const query = () => db().then((d) => d.query);

  // Each kind of task keeps its own label, so one finishing cannot clear another's.
  async function task(kind: TaskKind, label: string, work: () => Promise<void>): Promise<boolean> {
    const id = ++taskRef.current;
    setTasks((running) => new Map([...running].filter(([key]) => key !== kind)).set(kind, { label, id }));
    setError("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setTasks((running) => {
        if (running.get(kind)?.id !== id) return running;
        const next = new Map(running);
        next.delete(kind);
        return next;
      });
    }
  }

  async function readData(source: LoadSource, label: string, work: (thisLoad: number) => Promise<void>) {
    const thisLoad = ++loadRef.current;
    dispatch({ type: "read", load: thisLoad, source, label });
    setError("");
    try {
      await work(thisLoad);
      dispatch({ type: "loaded", load: thisLoad });
    } catch (e) {
      if (loadRef.current !== thisLoad) return;
      setError(describeError(e));
      dispatch({ type: "failed", load: thisLoad });
    }
  }

  async function afterLoad(thisLoad: number, name: string, preset?: Sample) {
    const q = await query();
    const described = await q(`DESCRIBE ${quote(TABLE)}`);
    const found = described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
    const [count] = await q(`SELECT count(*)::DOUBLE AS n FROM ${quote(TABLE)}`);
    if (loadRef.current !== thisLoad) return;
    const saved = preset ? null : loadSavedSetup(found);
    setColumns(found);
    setRowCount(Number(count.n));
    setSource(name);
    setFromSample(!!preset);
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
    return readData("sample", SAMPLE_LABEL, async (thisLoad) => {
      await sample.create(await query(), rows, TABLE);
      setFormulaBlanks(0);
      await afterLoad(thisLoad, sample.label, sample);
    });
  };

  const loadFile = (file: File) => {
    if (/\.parquet$/i.test(file.name)) {
      setError(PARQUET_REFUSAL);
      return;
    }
    prefetchResults();
    return readData("file", `Reading ${file.name}…`, async (thisLoad) => {
      setFormulaBlanks(await (await db()).loadFile(file, TABLE));
      await afterLoad(thisLoad, file.name);
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
    task("periods", "Reading periods…", async () => {
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
    !!setup && !!setup.unitsColumn && !!setup.salesColumn && setup.levels.length > 0 && !!prior && !!current && prior !== current;
  const calculating = tasks.has("calc");
  const busy = tasks.size > 0 || phase.kind === "reading" || phase.kind === "autoRun";
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

  /** `sampleLoad` names the sample load whose first bridge this is. */
  const calculate = (sampleLoad?: number) =>
    task("calc", "Calculating…", async () => {
      if (!setup) return;
      try {
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
          sample: fromSample,
          formulaBlanks,
          id: Date.now(),
          signature,
        });
        if (sampleLoad !== undefined) dispatch({ type: "ran", load: sampleLoad });
      } finally {
        scrollAfterRun.current = true;
      }
      if (writesSetup.current) saveSetup(columns, setup);
      setNotice("");
    });

  // After a calculation, bring its result or its error into view and hand it focus.
  useEffect(() => {
    if (!scrollAfterRun.current) return;
    const target = error ? errorRef.current : resultsRef.current?.querySelector<HTMLElement>(".results-title");
    if (!target) return;
    scrollAfterRun.current = false;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
  }, [run?.id, error, phase]);

  useEffect(() => scheduleSpeculative(prefetchResults, RESULTS_PREFETCH_SETTLE_MS), []);

  // Start the engine download once the first frame is painted.
  useEffect(() => {
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => void startEngine().catch(() => {}), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);

  // A link to /app/?sample opens the tool with the sample already calculated.
  useEffect(() => {
    if (sampleLinkRead.current || phase.kind !== "reading" || phase.load !== 0) return;
    sampleLinkRead.current = true;
    loadSample();
  }, []);
  const autoRanFor = useRef(-1);
  useEffect(() => {
    if (!shouldAutoRun(phase, ready, view !== null && loadedPeriods?.view === view)) return;
    if (phase.kind !== "autoRun" || autoRanFor.current === phase.load) return;
    const sampleLoad = phase.load;
    autoRanFor.current = sampleLoad;
    void calculate(sampleLoad).then((ran) => {
      if (!ran) dispatch({ type: "failed", load: sampleLoad });
    });
  });

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
      if (text === "") return;
      e.preventDefault();
      if (!isPastedTable(text)) {
        setError(NOT_A_TABLE);
        return;
      }
      loadFile(new File([text], "Pasted cells.tsv", { type: "text/tab-separated-values" }));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // Another tab can tick or untick Remember; this tab's box follows.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (affectsRemember(e.key)) setRemember(isRemembering());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!hasData(phase)) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!shouldWarn(phase, leaving.current)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [phase]);

  const exportWorkbook = () =>
    exportGuard.run(() =>
      task("export", "Building Excel file…", async () => {
        if (!fresh) return;
        await exportExcel(await query(), fresh.config, fresh.result, fresh.check, fresh.tieOut, fresh.description);
      }),
    );

  const importSetup = (file: File) =>
    task("import", "Reading setup…", async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("That file is not a setup file.");
      }
      if (!isValidSetup(parsed, columns)) {
        throw new Error("That setup file does not match the columns in this data.");
      }
      setSetup(restoredSetup(parsed));
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
  const shown = mainView(phase, engineState);
  const status = phase.kind === "reading" ? phase.label : ([...tasks.values()].at(-1)?.label ?? "");

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
          {phase.kind === "reading"
            ? ""
            : source
              ? `${source} · ${whole(rowCount)} rows · ${columns.length} columns`
              : "No data loaded"}
        </span>
        <span className="status" aria-live="polite">{status}</span>
        <nav>
          {filePicker}
          <button disabled={!fresh || busy} onClick={exportWorkbook}>Export Excel</button>
          {setup && (
            <button
              title="Remove the loaded data from this tab"
              onClick={() => {
                leaving.current = true;
                location.replace(location.pathname);
              }}
            >
              Clear data
            </button>
          )}
          <a href="/guide.html" target="_blank" rel="noreferrer">Guide</a>
          <a href="/method.html" target="_blank" rel="noreferrer">Method</a>
        </nav>
      </header>

      {error && <p className="error" role="alert" ref={errorRef} tabIndex={-1}>{error}</p>}

      {shown.kind === "loading" ? (
        <main className="empty">
          <p role="status">{shown.text}</p>
        </main>
      ) : shown.kind === "start" || !setup ? (
        <main className="empty">
          <h1>Load a sales file</h1>
          <p>
            <span className="fine-pointer">Drop a CSV or Excel file anywhere on this page, or paste cells copied from a spreadsheet (Ctrl+V), one row per sales line. It needs a period or date column, units, sales, and the product attributes you want in the bridge.</span>
            <span className="coarse-pointer">Choose a CSV or Excel file with one row per sales line. It needs a period or date column, units, sales, and the product attributes you want in the bridge.</span>
          </p>
          <p className="row">
            {filePicker}
            <button onClick={loadSample} disabled={busy}>Use sample data</button>
          </p>
          <p className="hint">The file is read inside this browser tab. It is not uploaded.</p>
          <h3>What the file should look like</h3>
          <div className="scroll">
            <table className="example">
              <thead>
                <tr><th>period</th><th>customer</th><th>model</th><th>material</th><th>finish</th><th className="num">units</th><th className="num">gross_sales</th><th className="num">net_sales</th></tr>
              </thead>
              <tbody>
                <tr><td>2025</td><td>C0001</td><td>MD12</td><td>MT2</td><td>FN01</td><td className="num">40</td><td className="num">4400</td><td className="num">3960</td></tr>
                <tr><td>2026</td><td>C0001</td><td>MD12</td><td>MT2</td><td>FN01</td><td className="num">52</td><td className="num">5980</td><td className="num">5262</td></tr>
                <tr><td>2026</td><td>C0002</td><td>MD12</td><td>MT5</td><td>FN00</td><td className="num">8</td><td className="num">1120</td><td className="num">1120</td></tr>
              </tbody>
            </table>
          </div>
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
              <button className="primary" disabled={!ready || busy} onClick={() => calculate()}>
                {calculating ? "Calculating…" : "Calculate bridge"}
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
            </div>
            <div className="keep">
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
                  : "Off: nothing is stored in this browser. Closing or reloading the tab removes everything."}
              </p>
              <p className="row">
                <button
                  className="quiet"
                  onClick={() =>
                    saveGuard.run(() => download(SETUP_FILE, JSON.stringify(setup, null, 2), "application/json"))
                  }
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
              <div className="results-anchor" ref={resultsRef}>
                <Results key={run.id} run={run} query={query} />
              </div>
            ) : !run ? (
              <div>
                {!calculating && (
                  <p className="hint">
                    First rows of the file. Set up the bridge on the left, then choose Calculate bridge (Ctrl+Enter).
                  </p>
                )}
                <div className="scroll">
                  <table className="dense">
                    <thead>
                      <tr>{columns.map((c) => <th key={c.name}>{c.name}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i}>
                          {columns.map((c) => {
                            const text = previewCell(c.type, row[c.name]);
                            const short = shorten(text);
                            return (
                              <td
                                key={c.name}
                                className={/INT|DOUBLE|DECIMAL|FLOAT|REAL/i.test(c.type) ? "num" : ""}
                                title={short === text ? undefined : text}
                              >
                                {short}
                              </td>
                            );
                          })}
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
