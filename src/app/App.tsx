import { useEffect, useRef, useState } from "react";
import { dataCheck, runBridge, type BridgeConfig } from "../engine.ts";
import { createSyntheticSales } from "../synth.ts";
import { openBrowserDatabase, type BrowserDatabase } from "./db.ts";
import { exportExcel } from "./exportExcel.ts";
import { download } from "./files.ts";
import { whole } from "./format.ts";
import { distinctCounts, findRollups } from "./profile.ts";
import { Results, type Run } from "./Results.tsx";
import {
  guessSetup,
  isValidSetup,
  loadSavedSetup,
  PERIOD,
  quote,
  saveSetup,
  TABLE,
  VIEW,
  viewSql,
  type Column,
  type Setup,
} from "./setup.ts";
import { SetupPanel } from "./SetupPanel.tsx";

const SAMPLE_ROWS = 1_000_000;

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
    ...setup.levels.map((level, i) => `Attribute ${i + 1}: ${level.name} (${level.columns.join(" + ")})`),
    `New and discontinued: ${setup.newAndDiscontinued === "full" ? "full sales, outside volume and mix" : "price difference only, units in volume"}`,
    ...setup.filters
      .filter((f) => f.values.length > 0)
      .map((f) => `Filter: ${f.column} ${f.mode === "include" ? "is one of" : "is not"} ${f.values.join(", ")}`),
  ];
}

export function App() {
  const database = useRef<Promise<BrowserDatabase>>(null);
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
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [rollups, setRollups] = useState<string[][]>([]);
  const [run, setRun] = useState<(Run & { id: number; signature: string }) | null>(null);

  function db(): Promise<BrowserDatabase> {
    database.current ??= openBrowserDatabase();
    return database.current;
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

  const loadSample = () =>
    task("Generating sample data…", async () => {
      await createSyntheticSales(await query(), SAMPLE_ROWS, TABLE);
      await afterLoad("Sample data (made-up lens sales)", SAMPLE_SETUP);
    });

  const loadFile = (file: File) =>
    task(`Reading ${file.name}…`, async () => {
      await (await db()).loadFile(file, TABLE);
      await afterLoad(file.name);
    });

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
      const q = await query();
      const config: BridgeConfig = {
        table: VIEW,
        periodColumn: PERIOD,
        prior,
        current,
        unitsColumn: setup.unitsColumn,
        salesColumn: setup.salesColumn,
        grossColumn: setup.grossColumn || undefined,
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
        description: describeSetup(setup, prior, current, source),
        id: Date.now(),
        signature,
      });
      saveSetup(columns, setup);
      setNotice("");
    });

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
          <a href="/guide.html" target="_blank" rel="noreferrer">Guide</a>
          <a href="/method.html" target="_blank" rel="noreferrer">Method</a>
        </nav>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      {!setup ? (
        <main className="empty">
          <h1>Load a sales file</h1>
          <p>
            Drop a CSV, Excel or Parquet file anywhere on this page, one row per sales line. It needs a period or date
            column, units, sales, and the product attributes you want in the bridge.
          </p>
          <p className="row">
            {filePicker}
            <button onClick={loadSample} disabled={!!busy}>Use sample data</button>
          </p>
          <p className="hint">The file is read inside this browser tab. It is not uploaded.</p>
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
          </aside>
          <main>
            {notice && <p className="notice">{notice}</p>}
            {run && run.signature !== signature && (
              <p className="notice">The setup changed since this bridge was calculated. Calculate again to update it.</p>
            )}
            {run ? (
              <Results key={run.id} run={run} query={query} />
            ) : (
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
            )}
          </main>
        </div>
      )}
    </div>
  );
}
