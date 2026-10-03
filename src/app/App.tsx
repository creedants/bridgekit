import { useEffect, useRef, useState } from "react";
import { drill, runBridge, type BridgeConfig, type BridgeResult, type Level } from "../engine.ts";
import { createSyntheticSales } from "../synth.ts";
import { openBrowserDatabase, type BrowserDatabase } from "./db.ts";
import { percent, signedWhole, whole } from "./format.ts";
import { Waterfall } from "./Waterfall.tsx";

const TABLE = "data";
const VIEW = "data_with_period";
const PERIOD = "__period";
const SAMPLE_ROWS = 1_000_000;

interface Column {
  name: string;
  type: string;
}

type Grain = "value" | "year" | "quarter" | "month";

interface Mapping {
  periodColumn: string;
  grain: Grain;
  unitsColumn: string;
  salesColumn: string;
  levels: Level[];
}

const SAMPLE_MAPPING: Mapping = {
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
};

const isDate = (type: string) => /DATE|TIMESTAMP/i.test(type);
const isNumeric = (type: string) => /INT|DOUBLE|DECIMAL|FLOAT|REAL/i.test(type);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function guessMapping(columns: Column[]): Mapping {
  const find = (pattern: RegExp, among: Column[]) => among.find((c) => pattern.test(c.name))?.name ?? "";
  const numeric = columns.filter((c) => isNumeric(c.type));
  const date = columns.find((c) => isDate(c.type));
  return {
    periodColumn: date?.name ?? find(/year|period|month|quarter|date/i, columns),
    grain: date ? "year" : "value",
    unitsColumn: find(/unit|qty|quant|jobs|volume|pieces/i, numeric),
    salesColumn: find(/sales|revenue|amount|net|value/i, numeric),
    levels: [],
  };
}

function periodExpression(column: string, grain: Grain): string {
  const c = quote(column);
  switch (grain) {
    case "year":
      return `strftime(${c}, '%Y')`;
    case "quarter":
      return `strftime(${c}, '%Y') || '-Q' || quarter(${c})`;
    case "month":
      return `strftime(${c}, '%Y-%m')`;
    case "value":
      return `CAST(${c} AS VARCHAR)`;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const database = useRef<Promise<BrowserDatabase>>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const [columns, setColumns] = useState<Column[]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [periods, setPeriods] = useState<string[]>([]);
  const [prior, setPrior] = useState("");
  const [current, setCurrent] = useState("");
  const [run, setRun] = useState<{ config: BridgeConfig; result: BridgeResult; ms: number } | null>(null);
  const [drillBy, setDrillBy] = useState(0);
  const [drillRows, setDrillRows] = useState<Record<string, unknown>[]>([]);

  function db(): Promise<BrowserDatabase> {
    database.current ??= openBrowserDatabase();
    return database.current;
  }

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

  async function afterLoad(name: string, preset?: Mapping) {
    const { query } = await db();
    const described = await query(`DESCRIBE ${quote(TABLE)}`);
    const found = described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
    const [count] = await query(`SELECT count(*)::DOUBLE AS n FROM ${quote(TABLE)}`);
    setColumns(found);
    setRowCount(Number(count.n));
    setSource(name);
    setRun(null);
    setMapping(preset ?? guessMapping(found));
  }

  const loadSample = () =>
    task("Generating sample data…", async () => {
      const { query } = await db();
      await createSyntheticSales(query, SAMPLE_ROWS, TABLE);
      await afterLoad("Sample: made-up prescription lens sales", SAMPLE_MAPPING);
    });

  const loadFile = (file: File) =>
    task(`Reading ${file.name}…`, async () => {
      const { loadFile: load } = await db();
      await load(file, TABLE);
      await afterLoad(file.name);
    });

  // Rebuild the period view and its value list whenever the period mapping changes.
  const periodColumn = mapping?.periodColumn ?? "";
  const grain = mapping?.grain ?? "value";
  useEffect(() => {
    if (!periodColumn) {
      setPeriods([]);
      return;
    }
    let stale = false;
    task("Reading periods…", async () => {
      const { query } = await db();
      await query(
        `CREATE OR REPLACE VIEW ${quote(VIEW)} AS
         SELECT *, ${periodExpression(periodColumn, grain)} AS ${quote(PERIOD)} FROM ${quote(TABLE)}`,
      );
      const rows = await query(
        `SELECT DISTINCT ${quote(PERIOD)} AS p FROM ${quote(VIEW)}
         WHERE ${quote(PERIOD)} IS NOT NULL ORDER BY 1 DESC LIMIT 200`,
      );
      if (stale) return;
      const values = rows.map((row) => String(row.p)).reverse();
      setPeriods(values);
      setCurrent(values.at(-1) ?? "");
      setPrior(values.at(-2) ?? "");
    });
    return () => {
      stale = true;
    };
  }, [periodColumn, grain, source]);

  const calculate = () =>
    task("Calculating…", async () => {
      if (!mapping) return;
      const { query } = await db();
      const config: BridgeConfig = {
        table: VIEW,
        periodColumn: PERIOD,
        prior,
        current,
        unitsColumn: mapping.unitsColumn,
        salesColumn: mapping.salesColumn,
        levels: mapping.levels,
      };
      const start = performance.now();
      const result = await runBridge(query, config);
      setDrillBy(0);
      setRun({ config, result, ms: performance.now() - start });
    });

  const drillOptions = run
    ? [
        ...run.config.levels.map((level) => ({ label: level.name, columns: level.columns })),
        ...(run.config.levels.length > 1
          ? [{ label: "Full configuration", columns: run.config.levels.flatMap((l) => l.columns) }]
          : []),
      ]
    : [];
  const drillColumns = drillOptions[drillBy]?.columns ?? [];

  useEffect(() => {
    if (!run || drillColumns.length === 0) return;
    let stale = false;
    db()
      .then(({ query }) => drill(query, run.config, drillColumns, 50))
      .then((rows) => !stale && setDrillRows(rows))
      .catch((e) => setError(describeError(e)));
    return () => {
      stale = true;
    };
  }, [run, drillBy]);

  const update = (patch: Partial<Mapping>) => setMapping((m) => (m ? { ...m, ...patch } : m));
  const setLevels = (levels: Level[]) => update({ levels });

  const used = new Set([
    mapping?.periodColumn,
    mapping?.unitsColumn,
    mapping?.salesColumn,
    ...(mapping?.levels.flatMap((l) => l.columns) ?? []),
  ]);
  const free = columns.filter((c) => !used.has(c.name));
  const ready =
    mapping && mapping.unitsColumn && mapping.salesColumn && mapping.levels.length > 0 && prior && current && prior !== current;

  return (
    <main>
      <header>
        <h1>Bridgekit</h1>
        <p>Price-volume-mix bridge for one attribute or many. Your file is read in this browser tab and is not uploaded.</p>
      </header>

      <section>
        <h2>1. Data</h2>
        <div
          className="drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) loadFile(file);
          }}
        >
          <p>Drop a CSV or Parquet file here, one row per sales line.</p>
          <div className="row">
            <label className="button">
              Choose file
              <input
                type="file"
                accept=".csv,.tsv,.txt,.parquet"
                hidden
                onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
              />
            </label>
            <button onClick={loadSample}>Load sample data</button>
          </div>
        </div>
        {source && (
          <p className="muted">
            {source}: {whole(rowCount)} rows, {columns.length} columns.
          </p>
        )}
      </section>

      {busy && <p className="status">{busy}</p>}
      {error && <p className="error">{error}</p>}

      {mapping && (
        <section>
          <h2>2. Setup</h2>
          <div className="fields">
            <label>
              Period column
              <select value={mapping.periodColumn} onChange={(e) => {
                const column = columns.find((c) => c.name === e.target.value);
                update({ periodColumn: e.target.value, grain: column && isDate(column.type) ? "year" : "value" });
              }}>
                <option value="">Choose…</option>
                {columns.map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </label>
            {isDate(columns.find((c) => c.name === mapping.periodColumn)?.type ?? "") && (
              <label>
                Compare by
                <select value={mapping.grain} onChange={(e) => update({ grain: e.target.value as Grain })}>
                  <option value="year">Year</option>
                  <option value="quarter">Quarter</option>
                  <option value="month">Month</option>
                </select>
              </label>
            )}
            <label>
              Prior period
              <select value={prior} onChange={(e) => setPrior(e.target.value)}>
                {periods.map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
            <label>
              Current period
              <select value={current} onChange={(e) => setCurrent(e.target.value)}>
                {periods.map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
            <label>
              Units column
              <select value={mapping.unitsColumn} onChange={(e) => update({ unitsColumn: e.target.value })}>
                <option value="">Choose…</option>
                {columns.filter((c) => isNumeric(c.type)).map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </label>
            <label>
              Sales column
              <select value={mapping.salesColumn} onChange={(e) => update({ salesColumn: e.target.value })}>
                <option value="">Choose…</option>
                {columns.filter((c) => isNumeric(c.type)).map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </label>
          </div>

          <h3>Attributes, most important first</h3>
          <p className="muted">
            Use one attribute for a classic bridge. With several, a configuration that has no exact match in the prior
            period is compared to the nearest group above it in this order.
          </p>
          <ol className="levels">
            {mapping.levels.map((level, i) => (
              <li key={level.columns.join("|")}>
                <input
                  aria-label="Attribute name"
                  value={level.name}
                  onChange={(e) => setLevels(mapping.levels.with(i, { ...level, name: e.target.value }))}
                />
                <span className="chips">
                  {level.columns.map((column) => (
                    <span className="chip" key={column}>
                      {column}
                      {level.columns.length > 1 && (
                        <button
                          aria-label={`Remove ${column}`}
                          onClick={() =>
                            setLevels(mapping.levels.with(i, { ...level, columns: level.columns.filter((c) => c !== column) }))
                          }
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {free.length > 0 && (
                    <select
                      aria-label="Combine another column into this attribute"
                      value=""
                      onChange={(e) =>
                        setLevels(mapping.levels.with(i, { ...level, columns: [...level.columns, e.target.value] }))
                      }
                    >
                      <option value="">+ column</option>
                      {free.map((c) => <option key={c.name}>{c.name}</option>)}
                    </select>
                  )}
                </span>
                <span className="row">
                  <button aria-label="Move up" disabled={i === 0} onClick={() => {
                    const next = [...mapping.levels];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    setLevels(next);
                  }}>↑</button>
                  <button aria-label="Move down" disabled={i === mapping.levels.length - 1} onClick={() => {
                    const next = [...mapping.levels];
                    [next[i + 1], next[i]] = [next[i], next[i + 1]];
                    setLevels(next);
                  }}>↓</button>
                  <button aria-label="Remove attribute" onClick={() => setLevels(mapping.levels.toSpliced(i, 1))}>✕</button>
                </span>
              </li>
            ))}
          </ol>
          {free.length > 0 && (
            <select
              value=""
              onChange={(e) => setLevels([...mapping.levels, { name: e.target.value, columns: [e.target.value] }])}
            >
              <option value="">Add attribute…</option>
              {free.map((c) => <option key={c.name}>{c.name}</option>)}
            </select>
          )}

          <p>
            <button className="primary" disabled={!ready || !!busy} onClick={calculate}>
              Calculate bridge
            </button>
          </p>
        </section>
      )}

      {run && (
        <section>
          <h2>3. Bridge: {run.config.prior} to {run.config.current}</h2>
          <p className="muted">
            Sales changed by {signedWhole(run.result.currentSales - run.result.priorSales)} (
            {percent(run.result.currentSales / run.result.priorSales - 1)}). Calculated in {run.ms.toFixed(0)} ms.
          </p>
          <Waterfall result={run.result} priorLabel={String(run.config.prior)} currentLabel={String(run.config.current)} />

          <div className="split">
            <div>
              <h3>Bridge</h3>
              <table>
                <tbody>
                  <tr className="total"><td>Prior sales</td><td className="num">{whole(run.result.priorSales)}</td></tr>
                  {run.result.effects.map((e) => (
                    <tr key={e.key}><td>{e.label}</td><td className="num">{signedWhole(e.value)}</td></tr>
                  ))}
                  <tr className="total"><td>Current sales</td><td className="num">{whole(run.result.currentSales)}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h3>How current sales were matched</h3>
              <table>
                <thead><tr><th>Compared against</th><th className="num">Share</th><th className="num">Configurations</th></tr></thead>
                <tbody>
                  {run.result.coverage.map((c) => (
                    <tr key={c.level}>
                      <td>{c.label}</td>
                      <td className="num">{percent(c.share)}</td>
                      <td className="num">{whole(c.cells)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">Only exact matches count as price. Everything else lands in “New configurations”.</p>
            </div>
          </div>

          <h3>
            Biggest movers by{" "}
            <select value={drillBy} onChange={(e) => setDrillBy(Number(e.target.value))}>
              {drillOptions.map((option, i) => <option key={option.label} value={i}>{option.label}</option>)}
            </select>
          </h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  {drillColumns.map((c) => <th key={c}>{c}</th>)}
                  <th className="num">Prior</th>
                  <th className="num">Current</th>
                  <th className="num">Volume</th>
                  <th className="num">Mix</th>
                  <th className="num">Price</th>
                  <th className="num">New config.</th>
                </tr>
              </thead>
              <tbody>
                {drillRows.map((row) => {
                  const mix = run.config.levels.reduce((sum, _, i) => sum + Number(row[`mix_${i + 1}`] ?? 0), 0);
                  return (
                    <tr key={drillColumns.map((c) => String(row[c])).join("|")}>
                      {drillColumns.map((c) => <td key={c}>{row[c] === null ? "(blank)" : String(row[c])}</td>)}
                      <td className="num">{whole(Number(row.s0))}</td>
                      <td className="num">{whole(Number(row.s1))}</td>
                      <td className="num">{signedWhole(Number(row.volume))}</td>
                      <td className="num">{signedWhole(mix)}</td>
                      <td className="num">{signedWhole(Number(row.price))}</td>
                      <td className="num">{signedWhole(Number(row.new_config))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted">Top 50 by size of total effect. Each row’s effects add up to its own sales change.</p>
        </section>
      )}
    </main>
  );
}
