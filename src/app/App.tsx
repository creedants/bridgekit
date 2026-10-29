import { lazy, Suspense, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { amountsNote, dataCheck, periodMoney, runBridge, type BridgeConfig, type Query } from "../engine.ts";
import { summarize } from "../summary.ts";
import { resolveSample, type Sample } from "../synth.ts";
import {
  openBrowserDatabase,
  PARQUET_REFUSAL,
  scheduleSpeculative,
  type BrowserDatabase,
} from "./db.ts";
import { exportExcel, lazyChunk, type ChunkSentences } from "./exportExcel.ts";
import { isPastedTable, makeGuard, saveOnce, shorten } from "./files.ts";
import { fileProblem, periodView, periodsFor, type FileProblem, type Periods } from "./fileProblems.ts";
import { whole } from "./format.ts";
import { findTotalRows, profileFile, type TotalRow } from "./profile.ts";
import { loadPeriodList } from "./periods.ts";
import { describeSetup } from "./report.ts";
import type { Run, Results as ResultsComponent } from "./Results.tsx";
import { createLatestOnly, NO_PERIOD_VIEWS, reducePeriodViews, viewsInstalled } from "./small-bridges.ts";
import {
  affectsRemember,
  calculateGate,
  carryPeriods,
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
  withoutSample,
  type Column,
  type EngineState,
  type LoadSource,
  type Setup,
} from "./setup.ts";
import { agree, SetupPanel } from "./SetupPanel.tsx";

// Pro workspaces exist only in builds with VITE_WORKSPACES=1; elsewhere the code is left out.
const WorkspacePanel = import.meta.env.VITE_WORKSPACES === "1" ? lazy(() => import("./Workspace.tsx")) : null;

type ResultsView = typeof ResultsComponent;

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

export function sourceCaption(source: string, rows: number, columns: number): string {
  return `${source} · ${whole(rows)} ${agree(rows, "row")} · ${whole(columns)} ${agree(columns, "column")}`;
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

/**
 * One load's right to replace the loaded table. `write` runs in claim order, and a
 * claim that a newer pick replaced skips its work entirely.
 */
export interface Claim {
  readonly n: number;
  current(): boolean;
  write<T>(work: () => Promise<T>): Promise<WriteOutcome<T>>;
}

export type WriteOutcome<T> = { status: "wrote"; value: T } | { status: "superseded" };

/**
 * Owns the one loaded table. `claim()` is called in the pick handler, so claim
 * order is pick order, and each table number is the phase's load number.
 */
export function createTableOwner(): { claim(): Claim; owner(): Claim | null } {
  let count = 0;
  let newest: Claim | null = null;
  let held: Claim | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    claim() {
      const claim: Claim = {
        n: ++count,
        current: () => newest === claim,
        write<T>(work: () => Promise<T>): Promise<WriteOutcome<T>> {
          const turn = tail.then(async (): Promise<WriteOutcome<T>> => {
            if (!claim.current()) return { status: "superseded" };
            const value = await work();
            held = claim;
            return { status: "wrote", value };
          });
          tail = turn.catch(() => undefined);
          return turn;
        },
      };
      newest = claim;
      return claim;
    },
    owner: () => held,
  };
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
  const [periodViews, dispatchPeriodViews] = useReducer(reducePeriodViews, NO_PERIOD_VIEWS);
  const [periodReads] = useState(createLatestOnly);
  const [suggestedPeriods, setSuggestedPeriods] = useState<Sample["periods"] | null>(null);
  const [prior, setPrior] = useState("");
  const [current, setCurrent] = useState("");
  const periodsRef = useRef({ prior, current });
  periodsRef.current = { prior, current };
  const [remember, setRemember] = useState(isRemembering);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [rollups, setRollups] = useState<string[][]>([]);
  const [detected, setDetected] = useState<{ key: string; rows: TotalRow[] } | null>(null);
  const [run, setRun] = useState<(Run & { id: number; signature: string }) | null>(null);
  // The report's names choice outlives a calculation on purpose. Results is keyed by run.id, so
  // anything kept inside it resets on every run. Only the user unticks this.
  const [omitNames, setOmitNames] = useState(false);
  const [formulaBlanks, setFormulaBlanks] = useState(0);
  const [setupError, setSetupError] = useState("");
  // exportExcel saves its file itself, so the Excel export keeps a guard of its own.
  const [exportGuard] = useState(() => makeGuard());
  // A demonstration sample must not overwrite a setup saved for a file with the same columns.
  const writesSetup = useRef(true);
  // The loaded table's owner, so a load an earlier pick replaced never writes.
  const [tables] = useState(createTableOwner);
  // What each table number holds, so the page can name the rows that are in the table.
  const loads = useRef(new Map<number, { name: string; preset?: Sample; blanks: number }>());
  // The load the page is showing, which is the one whose name and setup are on screen.
  const displayed = useRef(0);
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

  /** Runs one load. `write` replaces the table and resolves the formulas with no saved result. */
  async function readData(
    read: { source: LoadSource; fileName?: string; label: string },
    name: string,
    preset: Sample | undefined,
    write: () => Promise<number>,
  ) {
    const claim = tables.claim();
    const meta = { name, preset, blanks: 0 };
    loads.current.set(claim.n, meta);
    dispatch({ type: "read", load: claim.n, ...read });
    setError("");
    try {
      const outcome = await claim.write(write);
      if (outcome.status === "superseded") return;
      meta.blanks = outcome.value;
      setFormulaBlanks(outcome.value);
      await afterLoad(claim.n, name, preset, () => claim.current());
      dispatch({ type: "loaded", load: claim.n });
    } catch (e) {
      if (!claim.current()) return;
      setError(describeError(e));
      try {
        // A refused load leaves the table as the last write made it, so a load that
        // landed while this one waited is the one the page has to name.
        const held = tables.owner();
        const shown =
          held && displayed.current !== 0 && held.n !== claim.n && held.n !== displayed.current
            ? loads.current.get(held.n)
            : undefined;
        if (held && shown) {
          setFormulaBlanks(shown.blanks);
          await afterLoad(held.n, shown.name, shown.preset, () => claim.current());
        }
      } finally {
        dispatch({ type: "failed", load: claim.n });
      }
    }
  }

  async function afterLoad(load: number, name: string, preset: Sample | undefined, current: () => boolean) {
    // The table has already been replaced, so a run from the file before it must
    // not survive a load that a newer load superseded.
    setRun(null);
    const q = await query();
    const described = await q(`DESCRIBE ${quote(TABLE)}`);
    const found = described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
    const [count] = await q(`SELECT count(*)::DOUBLE AS n FROM ${quote(TABLE)}`);
    if (!current()) return;
    const saved = preset ? null : loadSavedSetup(found);
    setColumns(found);
    setRowCount(Number(count.n));
    setSource(name);
    setFromSample(!!preset);
    setLoad(load);
    displayed.current = load;
    setSetup(preset?.setup ?? saved ?? guessSetup(found));
    setSuggestedPeriods(preset?.periods ?? null);
    writesSetup.current = preset?.savesSetup ?? true;
    setNotice(saved ? "Restored the setup you last used with these columns." : "");
    setSetupError("");
    const previewRows = await q(`SELECT * FROM ${quote(TABLE)} LIMIT 8`);
    if (!current()) return;
    setPreview(previewRows);
    setRollups([]);
    // Profiling is a convenience; the tool works without it.
    profileFile(q, found, current, (profile) => {
      setColumns(profile.columns);
      setRollups(profile.rollups);
    }).catch(() => {});
  }

  const loadSample = () => {
    prefetchResults();
    const { sample, rows } = resolveSample(new URLSearchParams(location.search).get("sample"));
    return readData({ source: "sample", label: SAMPLE_LABEL }, sample.label, sample, async () => {
      await sample.create(await query(), rows, TABLE);
      return 0;
    });
  };

  const loadFile = (file: File) => {
    if (/\.parquet$/i.test(file.name)) {
      setError(PARQUET_REFUSAL);
      return;
    }
    prefetchResults();
    const bare = withoutSample(location.href);
    if (bare) history.replaceState(history.state, "", bare);
    return readData(
      { source: "file", fileName: file.name, label: `Reading ${file.name}…` },
      file.name,
      undefined,
      async () => (await db()).loadFile(file, TABLE),
    );
  };

  // Rebuild the filtered view and the period list whenever they could change.
  // The load count stands in for the file name, so a second file with the same name still re-reads.
  const view = setup
    ? periodView({ load, periodColumn: setup.periodColumn, grain: setup.grain, fiscalYearStart: setup.fiscalYearStart, filters: setup.filters })
    : null;
  useEffect(() => {
    if (view === null || !setup) return;
    const ticket = periodReads.start();
    if (!setup.periodColumn) {
      dispatchPeriodViews({ type: "noPeriodColumn", view });
      return;
    }
    dispatchPeriodViews({ type: "rebuilding" });
    void task("periods", "Reading periods…", async () => {
      const read = await ticket.run(await query(), async (current) => {
        await buildViews(current, setup);
        return loadPeriodList(current, quote(PERIOD), quote(VIEW));
      });
      if (read.status === "superseded") return;
      const values = [...read.value.values];
      dispatchPeriodViews({ type: "rebuilt", view, values });
      // A sample that compares two named periods says which one is prior.
      const next = carryPeriods(periodsRef.current, values, suggestedPeriods ?? null);
      setPrior(next.prior);
      setCurrent(next.current);
    });
  }, [view]);

  const offeredPeriods = periodViews.list ? [...periodViews.list.values] : [];
  const problemPeriods = periodsFor(view, periodViews.list);
  const periodsCurrent = viewsInstalled(periodViews, view);

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
  const gate = calculateGate({ setup, prior, current, problem });
  const ready = gate.ready;
  const canCalculate = ready && !busy && periodsCurrent;

  /** `sampleLoad` names the sample load whose first bridge this is. */
  const calculate = (periods: Periods, sampleLoad?: number): Promise<boolean> =>
    periods === "unknown"
      ? Promise.resolve(false)
      : task("calc", "Calculating…", async () => {
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
            // Read now: a later calculation on another tab replaces the cells this note looks at.
            const amounts = await amountsNote(q);
            const check = await dataCheck(q, config);
            const tieOut = await periodMoney(q, config, { table: FILE_VIEW, periodColumn: PERIOD });
            setRun({
              config,
              result,
              check,
              tieOut,
              ms,
              periods: [...periods.values],
              textColumns: columns.filter((c) => !/INT|DOUBLE|DECIMAL|FLOAT|REAL|DATE|TIMESTAMP/i.test(c.type)).map((c) => c.name),
              description: describeSetup(setup, prior, current, source),
              setup,
              source,
              sample: fromSample,
              formulaBlanks,
              amounts,
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

  // Start the engine download once the first frame is painted. A link to /app/?sample
  // starts its load then too, so it opens with the sample already calculated.
  useEffect(() => {
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        void startEngine().catch(() => {});
        if (sampleLinkRead.current || phase.kind !== "reading" || phase.load !== 0) return;
        sampleLinkRead.current = true;
        loadSample();
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);
  const autoRanFor = useRef(-1);
  useEffect(() => {
    if (!shouldAutoRun(phase, ready, periodsCurrent)) return;
    if (phase.kind !== "autoRun" || autoRanFor.current === phase.load) return;
    const sampleLoad = phase.load;
    autoRanFor.current = sampleLoad;
    void calculate(problemPeriods, sampleLoad).then((ran) => {
      if (!ran) dispatch({ type: "failed", load: sampleLoad });
    });
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCalculate) calculate(problemPeriods);
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
      if (hasData(phase) && !confirm("Replace the loaded data with the pasted cells?")) return;
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
      setSetupError("");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        setSetupError("That file is not a setup file.");
        throw new Error("That file is not a setup file.");
      }
      if (!isValidSetup(parsed, columns)) {
        setSetupError("That setup file does not match the columns in this data.");
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
          <svg className="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="var(--plum)" /><rect x="6" y="17" width="5" height="9" fill="#fff" /><rect x="13.5" y="12" width="5" height="5" fill="#fff" opacity=".75" /><rect x="21" y="6" width="5" height="20" fill="#fff" /></svg>
          PVM Bridge
        </a>
        <span className="source">
          {phase.kind === "reading"
            ? ""
            : source
              ? sourceCaption(source, rowCount, columns.length)
              : "No data loaded"}
        </span>
        <span className="status" aria-live="polite">{status}</span>
        <nav>
          {filePicker}
          <button disabled={!fresh || busy} onClick={exportWorkbook} aria-label="Export Excel">Export<span className="wide-only"> Excel</span></button>
          {setup && (
            <button
              title="Remove the loaded data from this tab"
              aria-label="Clear data"
              onClick={() => {
                if (!confirm("Clear the loaded data and the bridge?")) return;
                leaving.current = true;
                location.replace(location.pathname);
              }}
            >
              Clear<span className="wide-only"> data</span>
            </button>
          )}
          <a href="/guide.html" target="_blank" rel="noreferrer">Guide</a>
          <a href="/method.html" target="_blank" rel="noreferrer">Method</a>
        </nav>
      </header>

      {error && <p className="error" role="alert" ref={errorRef} tabIndex={-1}>{error}</p>}

      {shown.kind === "loading" ? (
        <main className="empty">
          <div className="busy-bar" aria-hidden="true" />
          <div role="status">
            <p>{shown.text}</p>
            {shown.fileLine && <p>{shown.fileLine}</p>}
          </div>
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
          <p className="hint">
            The file is read inside this browser tab. <a href="/privacy.html">It is not uploaded.</a>
          </p>
          <h3>What the file should look like</h3>
          <div className="scroll">
            <table className="example">
              <thead>
                <tr><th>period</th><th className="detail">customer</th><th>model</th><th className="detail">material</th><th className="detail">finish</th><th className="num">units</th><th className="num detail">gross_sales</th><th className="num">net_sales</th></tr>
              </thead>
              <tbody>
                <tr><td>2025</td><td className="detail">C0001</td><td>MD12</td><td className="detail">MT2</td><td className="detail">FN01</td><td className="num">40</td><td className="num detail">4400</td><td className="num">3960</td></tr>
                <tr><td>2026</td><td className="detail">C0001</td><td>MD12</td><td className="detail">MT2</td><td className="detail">FN01</td><td className="num">52</td><td className="num detail">5980</td><td className="num">5262</td></tr>
                <tr><td>2026</td><td className="detail">C0002</td><td>MD12</td><td className="detail">MT5</td><td className="detail">FN00</td><td className="num">8</td><td className="num detail">1120</td><td className="num">1120</td></tr>
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
              <button className="primary" disabled={!canCalculate} onClick={() => calculate(problemPeriods)}>
                {calculating ? "Calculating…" : "Calculate bridge"}
              </button>
              {problem.kind === "note" && <p className="hint">{problem.message}</p>}
              {!gate.ready && <p className="hint">{gate.reason}</p>}
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
                  : "Off: the tool is not saving setups in this browser. Closing or reloading the tab clears its loaded data."}
              </p>
              <p className="row">
                <button
                  className="quiet"
                  onClick={() =>
                    saveOnce(SETUP_FILE, JSON.stringify(setup, null, 2), "application/json")
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
              {setupError && <p className="error">{setupError}</p>}
            </div>
            {WorkspacePanel && (
              <Suspense>
                <WorkspacePanel
                  columns={columns.map((c) => c.name)}
                  setup={setup}
                  bridge={fresh ? { summary: summarize(fresh.result, fresh.config), setup } : null}
                  onUseSetup={(saved) => {
                    if (isValidSetup(saved, columns)) setSetup(restoredSetup(saved));
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
                <Results key={run.id} run={run} query={query} fresh={fresh !== null} viewsCurrent={periodsCurrent} omitNames={omitNames} onOmitNames={setOmitNames} />
              </div>
            ) : !run ? (
              <div>
                {!calculating && (
                  <p className="hint">
                    <span className="wide-pointer">
                      First rows of the file. Set up the bridge on the left, then choose Calculate bridge (Ctrl+Enter).
                    </span>
                    <span className="narrow-pointer">First rows of the file. Set up the bridge above, then choose Calculate bridge.</span>
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
      <footer className="policy">
        <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a>
        <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a>
        <a href="mailto:support@pvmbridge.com">Contact</a>
      </footer>
    </div>
  );
}
