import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import { runBridge, drill, ident, type BridgeConfig, type BridgeResult, type Level, type Query } from "../src/engine.ts";
import { random } from "./support/random.ts";

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const TOLERANCE = 1e-6;
const MIN_PRIOR_UNITS = 20;
const MIN_DATASETS_PER_FEATURE = 5;

const PERIODS = ["p0", "p1"] as const;
const [PRIOR, CURRENT] = PERIODS;
type Period = (typeof PERIODS)[number];

const MEASURES = {
  "sales only": {},
  "gross": { grossColumn: "gross" },
  "cost": { costColumn: "cost" },
  "gross and cost": { grossColumn: "gross", costColumn: "cost" },
} satisfies Record<string, Pick<BridgeConfig, "grossColumn" | "costColumn">>;
type Measure = keyof typeof MEASURES;
const MEASURE_NAMES = Object.keys(MEASURES) as Measure[];

const MODES = ["difference", "full"] as const;
type Mode = (typeof MODES)[number];
const ORDERS = ["given", "permuted"] as const;
type Order = (typeof ORDERS)[number];

interface Row {
  period: Period;
  keys: Record<string, string | null>;
  units: number | null;
  sales: number;
  gross: number;
  cost: number;
}

interface Dataset {
  seed: number;
  levels: Level[];
  permuted: Level[];
  measure: Measure;
  rows: Row[];
}

const quarter = (value: number): number => Math.round(value * 4) / 4;

function dataset(seed: number): Dataset {
  const r = random(seed);
  const levels: Level[] = Array.from({ length: r.int(2, 4) }, (_, i) => {
    const letter = "abcd"[i];
    return { name: letter.toUpperCase(), columns: r.chance(0.3) ? [`${letter}1`, `${letter}2`] : [`${letter}1`] };
  });
  const columns = levels.flatMap((level) => level.columns);
  const shuffled = r.shuffle(levels);
  const permuted = shuffled.every((level, i) => level === levels[i]) ? [...levels.slice(1), levels[0]] : shuffled;
  const measure = r.pick(MEASURE_NAMES);
  const nullRate = r.chance(0.5) ? 0.15 : 0;
  const negativeRate = r.chance(0.5) ? 0.1 : 0;
  const noUnitsRate = r.chance(0.5) ? 0.1 : 0;
  const onePeriodRate = r.chance(0.6) ? 0.4 : 0;

  const drawnRows = r.int(20, 500);
  const rowCount = seed === 1 ? 20 : seed === 2 ? 500 : drawnRows;
  const cells = Array.from({ length: r.int(3, Math.max(3, Math.floor(rowCount / 4))) }, () => ({
    keys: Object.fromEntries(columns.map((c) => [c, r.chance(nullRate) ? null : `${c}-${r.int(1, 3)}`])),
    periods: r.chance(onePeriodRate) ? [r.pick(PERIODS)] : PERIODS,
    price: r.int(5, 60),
    drift: r.int(90, 120) / 100,
    discount: r.int(0, 4) * 0.05,
    unitCost: r.int(2, 30),
  }));
  const rows = Array.from({ length: rowCount }, (): Row => {
    const cell = r.pick(cells);
    const period = r.pick(cell.periods);
    if (r.chance(noUnitsRate)) {
      const amount = r.int(-80, 80);
      return { period, keys: cell.keys, units: r.chance(0.5) ? 0 : null, sales: amount, gross: amount, cost: r.chance(0.3) ? r.int(1, 20) : 0 };
    }
    const units = r.chance(negativeRate) ? -r.int(1, 3) : r.int(1, 12);
    const price = cell.price * (period === CURRENT ? cell.drift : 1) * (r.int(90, 110) / 100);
    const sales = quarter(units * price) * (r.chance(negativeRate / 4) ? -1 : 1);
    const discount = cell.discount + (period === CURRENT ? 0.05 : 0);
    return { period, keys: cell.keys, units, sales, gross: quarter(sales / (1 - discount)), cost: quarter(units * cell.unitCost) };
  });

  const priorUnits = rows.reduce((sum, row) => sum + (row.period === PRIOR ? row.units ?? 0 : 0), 0);
  assert.ok(priorUnits >= MIN_PRIOR_UNITS, `seed ${seed}: the generator made ${priorUnits} prior units, fewer than ${MIN_PRIOR_UNITS}`);
  return { seed, levels, permuted, measure, rows };
}

const FEATURES: Record<string, (data: Dataset) => boolean> = {
  "2 levels": (data) => data.levels.length === 2,
  "3 levels": (data) => data.levels.length === 3,
  "4 levels": (data) => data.levels.length === 4,
  ...Object.fromEntries(MEASURE_NAMES.map((name) => [name, (data: Dataset) => data.measure === name])),
  "two-column level": (data) => data.levels.some((level) => level.columns.length > 1),
  "null keys": (data) => data.rows.some((row) => Object.values(row.keys).includes(null)),
  "negatives": (data) => data.rows.some((row) => (row.units ?? 0) < 0 || ((row.units ?? 0) !== 0 && row.sales < 0)),
  "a negative unit": (data) => data.rows.some((row) => row.units !== null && row.units < 0),
  "a negative sale on a row that has units": (data) => data.rows.some((row) => row.units !== null && row.units !== 0 && row.sales < 0),
  "rows with no units": (data) => data.rows.some((row) => (row.units ?? 0) === 0),
  "a zero-unit row whose sales are not zero": (data) => data.rows.some((row) => row.units === 0 && row.sales !== 0),
  "a row whose units are null": (data) => data.rows.some((row) => row.units === null),
  "one-period cells": (data) => {
    const periods = new Map<string, Set<Period>>();
    for (const row of data.rows) {
      const cell = JSON.stringify(row.keys);
      periods.set(cell, (periods.get(cell) ?? new Set()).add(row.period));
    }
    return [...periods.values()].some((seen) => seen.size === 1);
  },
  "under 100 rows": (data) => data.rows.length < 100,
  "over 300 rows": (data) => data.rows.length > 300,
  "20 rows": (data) => data.rows.length === 20,
  "500 rows": (data) => data.rows.length === 500,
};

const FEATURE_MIN: Record<string, number> = {
  "20 rows": 1,
  "500 rows": 1,
};

function title(data: Dataset): string {
  const features = Object.entries(FEATURES).filter(([, has]) => has(data)).map(([name]) => name);
  return `seed ${data.seed}: ${data.rows.length} rows, ${features.join(", ")}`;
}

function tableSql(data: Dataset): string {
  const columns = data.levels.flatMap((level) => level.columns);
  const values = data.rows.map((row) => {
    const keys = columns.map((c) => (row.keys[c] === null ? "NULL" : `'${row.keys[c]}'`));
    return `('${row.period}', ${keys.join(", ")}, ${row.units ?? "NULL"}, ${row.sales}, ${row.gross}, ${row.cost})`;
  });
  return `CREATE TABLE t AS
    SELECT period, ${columns.map((c) => `${c}::VARCHAR AS ${c}`).join(", ")},
      units::DOUBLE AS units, sales::DOUBLE AS sales, gross::DOUBLE AS gross, cost::DOUBLE AS cost
    FROM (VALUES ${values.join(",\n")}) v(period, ${columns.join(", ")}, units, sales, gross, cost)`;
}

function rowTotal(data: Dataset, period: Period): number {
  const margin = "costColumn" in MEASURES[data.measure];
  return data.rows.reduce((sum, row) => sum + (row.period === period ? row.sales - (margin ? row.cost : 0) : 0), 0);
}

interface Run {
  label: string;
  config: BridgeConfig;
  result: BridgeResult;
}

type Runs = Record<Mode, Record<Order, Run>>;

async function load(data: Dataset): Promise<Query> {
  const query = await openDatabase();
  // Each openDatabase starts one DuckDB thread per core unless this is set.
  await query("SET threads = 1");
  await query(tableSql(data));
  return query;
}

async function run(query: Query, data: Dataset, mode: Mode, order: Order): Promise<Run> {
  const levels = order === "given" ? data.levels : data.permuted;
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: PRIOR, current: CURRENT,
    unitsColumn: "units", salesColumn: "sales",
    ...MEASURES[data.measure],
    levels,
    newAndDiscontinued: mode,
    cellsTable: `cells_${mode}_${order}`,
  };
  const label = `seed ${data.seed}, ${data.measure}, ${mode}, levels ${levels.map((level) => level.name).join(">")}`;
  return { label, config, result: await runBridge(query, config) };
}

async function runAll(query: Query, data: Dataset): Promise<Runs> {
  return {
    difference: { given: await run(query, data, "difference", "given"), permuted: await run(query, data, "difference", "permuted") },
    full: { given: await run(query, data, "full", "given"), permuted: await run(query, data, "full", "permuted") },
  };
}

function close(actual: number, expected: number, what: string): void {
  if (Math.abs(actual - expected) <= TOLERANCE) return;
  throw new assert.AssertionError({ message: `${what}: expected ${expected}, got ${actual}`, actual, expected, operator: "close" });
}

function numeric(value: unknown): number {
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : NaN;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const change = (run: Run): number => run.result.currentSales - run.result.priorSales;
const effectTotal = (run: Run): number => sum(run.result.effects.map((e) => e.value));
const levelOrder = (run: Run): string => run.config.levels.map((level) => level.name).join(">");

function likeForLikeKeys(run: Run): string[] {
  return run.result.effects.map((effect) => effect.key).filter((key) => key.startsWith("price") || key === "cost_rate");
}

function valueOf(run: Run, key: string): number {
  const found = run.result.effects.filter((effect) => effect.key === key);
  assert.equal(found.length, 1, `${run.label}: ${key} appears ${found.length} times`);
  return found[0].value;
}

function priceKeys(config: BridgeConfig): { present: readonly string[]; absent: readonly string[] } {
  if (config.costColumn) {
    return { present: ["price_sales", "cost_rate"], absent: ["price", "price_list", "price_discount"] };
  }
  if (config.grossColumn) {
    return { present: ["price_list", "price_discount"], absent: ["price", "price_sales", "cost_rate"] };
  }
  return { present: ["price"], absent: ["price_list", "price_discount", "price_sales", "cost_rate"] };
}

function keysContract(run: Run): void {
  const returned = new Set(run.result.effects.map((effect) => effect.key));
  assert.ok(returned.has("volume"), `${run.label}: volume is absent`);
  const { present, absent } = priceKeys(run.config);
  for (const key of present) assert.ok(returned.has(key), `${run.label}: ${key} is absent`);
  for (const key of absent) assert.ok(!returned.has(key), `${run.label}: ${key} is present`);
  assert.ok(likeForLikeKeys(run).length > 0, `${run.label}: the like-for-like set is empty`);
}

async function cellsReconcile(query: Query, run: Run): Promise<void> {
  const cells = await query(`SELECT * FROM ${ident(run.result.cellsTable)}`);
  assert.ok(cells.length > 0, `${run.label}: the cells table is empty`);
  const keys = run.config.levels.flatMap((level) => level.columns);
  const checked = cells.map((cell) => {
    const actual = sum(run.result.effects.map((e) => numeric(cell[e.key])));
    const expected = numeric(cell.s1) + numeric(cell.z1) - numeric(cell.s0) - numeric(cell.z0);
    const gap = Math.abs(actual - expected);
    return { cell: JSON.stringify(Object.fromEntries(keys.map((key) => [key, cell[key]]))), actual, expected, gap: Number.isNaN(gap) ? Infinity : gap };
  });
  const worst = checked.reduce((a, b) => (b.gap > a.gap ? b : a));
  close(worst.actual, worst.expected, `${run.label}: effects of cell ${worst.cell} against its change`);
}

function totalsReconcile(run: Run, data: Dataset): void {
  close(run.result.priorSales, rowTotal(data, PRIOR), `${run.label}: prior total against the generated rows`);
  close(run.result.currentSales, rowTotal(data, CURRENT), `${run.label}: current total against the generated rows`);
  close(effectTotal(run), change(run), `${run.label}: sum of effects against the total change`);
}

function orderInvariant(given: Run, permuted: Run): void {
  close(valueOf(permuted, "volume"), valueOf(given, "volume"), `${permuted.label}: volume against levels ${levelOrder(given)}`);
  const keys = likeForLikeKeys(given);
  assert.ok(keys.length > 0, `${given.label}: the like-for-like set is empty`);
  const permutedKeys = likeForLikeKeys(permuted);
  assert.deepEqual(permutedKeys, keys, `${permuted.label}: like-for-like keys ${JSON.stringify(permutedKeys)} against ${JSON.stringify(keys)}`);
  close(
    sum(keys.map((key) => valueOf(permuted, key))),
    sum(keys.map((key) => valueOf(given, key))),
    `${permuted.label}: like-for-like price against levels ${levelOrder(given)}`,
  );
}

function modesAgree(difference: Run, full: Run): void {
  close(change(full), change(difference), `${full.label}: total change against difference mode`);
  close(effectTotal(full), effectTotal(difference), `${full.label}: sum of effects against difference mode`);
}

async function drillSumsBack(query: Query, run: Run, data: Dataset): Promise<void> {
  for (const level of run.config.levels) {
    const groups = await drill(query, run.config, { columns: level.columns, limit: data.rows.length });
    for (const effect of run.result.effects) {
      close(sum(groups.map((group) => numeric(group[effect.key]))), effect.value, `${run.label}: ${effect.key} drilled by ${level.name} against its total`);
    }
  }
}

const DATASETS = SEEDS.map(dataset);

suite("bridge properties on seeded datasets", { concurrency: true }, () => {
  for (const data of DATASETS) {
    test(title(data), async () => {
      const query = await load(data);
      const runs = await runAll(query, data);

      for (const mode of MODES) {
        for (const order of ORDERS) {
          await cellsReconcile(query, runs[mode][order]);
          totalsReconcile(runs[mode][order], data);
          keysContract(runs[mode][order]);
        }
        orderInvariant(runs[mode].given, runs[mode].permuted);
      }
      for (const order of ORDERS) modesAgree(runs.difference[order], runs.full[order]);
      await drillSumsBack(query, runs.difference.given, data);
    });
  }
});

test("the datasets cover the dataset space", () => {
  assert.equal(DATASETS.length, 50);
  for (const [name, has] of Object.entries(FEATURES)) {
    const count = DATASETS.filter(has).length;
    const min = FEATURE_MIN[name] ?? MIN_DATASETS_PER_FEATURE;
    assert.ok(count >= min, `${count} of ${DATASETS.length} datasets have ${name}, expected at least ${min}`);
  }
});
