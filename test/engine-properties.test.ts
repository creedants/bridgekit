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
  for (const key of keys) {
    close(valueOf(permuted, key), valueOf(given, key), `${permuted.label}: ${key} against levels ${levelOrder(given)}`);
  }
}

function modesAgree(difference: Run, full: Run): void {
  close(change(full), change(difference), `${full.label}: total change against difference mode`);
  close(effectTotal(full), effectTotal(difference), `${full.label}: sum of effects against difference mode`);
}

interface CellFacts {
  key: Record<string, string | null>;
  q0: number;
  q1: number;
  s0: number;
  s1: number;
  z0: number;
  z1: number;
  g0: number;
  g1: number;
  rs0: number;
  rs1: number;
}

interface JoinedCell {
  id: string;
  cell: Record<string, unknown>;
  fact: CellFacts;
}

function hasUnits(row: Row): row is Row & { units: number } {
  return row.units !== null && row.units !== 0;
}

function measureFlags(config: BridgeConfig): { cost: boolean; gross: boolean } {
  const cost = config.costColumn !== undefined;
  return { cost, gross: !cost && config.grossColumn !== undefined };
}

function continuing(fact: CellFacts): boolean {
  return fact.q0 > 0 && fact.q1 !== 0;
}

function rated(fact: CellFacts, full: boolean): boolean {
  return full ? continuing(fact) : fact.q0 > 0;
}

function keyId(columns: readonly string[], valueAt: (column: string) => string | null): string {
  return JSON.stringify(columns.map(valueAt));
}

function textKey(value: unknown, label: string, column: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new assert.AssertionError({
    message: `${label}: ${column} expected text, got ${JSON.stringify(value)}`,
    actual: value,
    expected: "text",
  });
}

function cellFacts(data: Dataset, columns: readonly string[], config: BridgeConfig): CellFacts[] {
  const { cost, gross } = measureFlags(config);
  const grouped = new Map<string, CellFacts>();
  for (const row of data.rows) {
    const key: Record<string, string | null> = {};
    for (const column of columns) key[column] = row.keys[column];
    const id = keyId(columns, (column) => key[column]);
    let facts = grouped.get(id);
    if (!facts) {
      facts = { key, q0: 0, q1: 0, s0: 0, s1: 0, z0: 0, z1: 0, g0: 0, g1: 0, rs0: 0, rs1: 0 };
      grouped.set(id, facts);
    }
    const amount = cost ? row.sales - row.cost : row.sales;
    const prior = row.period === PRIOR;
    if (hasUnits(row)) {
      if (prior) {
        facts.q0 += row.units;
        facts.s0 += amount;
        if (gross) facts.g0 += row.gross;
        if (cost) facts.rs0 += row.sales;
      } else {
        facts.q1 += row.units;
        facts.s1 += amount;
        if (gross) facts.g1 += row.gross;
        if (cost) facts.rs1 += row.sales;
      }
    } else if (prior) {
      facts.z0 += amount;
    } else {
      facts.z1 += amount;
    }
  }
  for (const facts of grouped.values()) {
    facts.q0 = Math.round(facts.q0 * 1e6) / 1e6;
    facts.q1 = Math.round(facts.q1 * 1e6) / 1e6;
  }
  return [...grouped.values()];
}

function readNumber(row: Record<string, unknown>, column: string, label: string): number {
  assert.ok(Object.hasOwn(row, column), `${label}: expected column ${column}`);
  const value = numeric(row[column]);
  assert.ok(Number.isFinite(value), `${label}: ${column} expected a finite number, got ${String(row[column])}`);
  return value;
}

function readNullable(row: Record<string, unknown>, column: string, label: string): number | null {
  assert.ok(Object.hasOwn(row, column), `${label}: expected column ${column}`);
  if (row[column] === null) return null;
  return readNumber(row, column, label);
}

function gap(actual: number, expected: number): number {
  const distance = Math.abs(actual - expected);
  return Number.isNaN(distance) ? Infinity : distance;
}

function closeColumn(label: string, column: string, rows: { cell: string; actual: number; expected: number }[]): void {
  assert.ok(rows.length > 0, `${label}: ${column} expected at least one cell`);
  const worst = rows.reduce((left, right) => (gap(right.actual, right.expected) > gap(left.actual, left.expected) ? right : left));
  close(worst.actual, worst.expected, `${label}: ${column} of cell ${worst.cell}`);
}

function nullableGap(actual: number | null, expected: number | null): number {
  if (actual === null && expected === null) return 0;
  if (actual === null || expected === null) return Infinity;
  return gap(actual, expected);
}

function closeNullable(actual: number | null, expected: number | null, what: string): void {
  if (actual === null || expected === null) {
    if (actual === expected) return;
    throw new assert.AssertionError({ message: `${what}: expected ${expected}, got ${actual}`, actual, expected });
  }
  close(actual, expected, what);
}

function closeNullableColumn(label: string, column: string, rows: { cell: string; actual: number | null; expected: number | null }[]): void {
  assert.ok(rows.length > 0, `${label}: ${column} expected at least one cell`);
  const worst = rows.reduce((left, right) => (nullableGap(right.actual, right.expected) > nullableGap(left.actual, left.expected) ? right : left));
  closeNullable(worst.actual, worst.expected, `${label}: ${column} of cell ${worst.cell}`);
}

function joinCells(run: Run, cells: Record<string, unknown>[], facts: CellFacts[]): JoinedCell[] {
  const columns = run.config.levels.flatMap((level) => level.columns);
  const indexed = new Map<string, Record<string, unknown>>();
  for (const cell of cells) {
    const id = keyId(columns, (column) => textKey(cell[column], run.label, column));
    assert.ok(!indexed.has(id), `${run.label}: expected one row for cell ${id}`);
    indexed.set(id, cell);
  }
  const ids = facts.map((fact) => keyId(columns, (column) => fact.key[column]));
  assert.equal(new Set(ids).size, ids.length, `${run.label}: expected ${ids.length} unique generated cells, got ${new Set(ids).size}`);
  assert.equal(indexed.size, facts.length, `${run.label}: expected ${facts.length} cells, got ${indexed.size}`);
  return facts.map((fact) => {
    const id = keyId(columns, (column) => fact.key[column]);
    const cell = indexed.get(id);
    assert.ok(cell, `${run.label}: expected cell ${id}`);
    return { id, cell, fact };
  });
}

function pairs(label: string, joined: JoinedCell[], column: string, expected: (fact: CellFacts) => number): { cell: string; actual: number; expected: number }[] {
  return joined.map((row) => ({ cell: row.id, actual: readNumber(row.cell, column, label), expected: expected(row.fact) }));
}

const FACT_COLUMNS = {
  q0: (fact: CellFacts) => fact.q0,
  q1: (fact: CellFacts) => fact.q1,
  s0: (fact: CellFacts) => fact.s0,
  s1: (fact: CellFacts) => fact.s1,
  z0: (fact: CellFacts) => fact.z0,
  z1: (fact: CellFacts) => fact.z1,
  g0: (fact: CellFacts) => fact.g0,
  g1: (fact: CellFacts) => fact.g1,
  rs0: (fact: CellFacts) => fact.rs0,
  rs1: (fact: CellFacts) => fact.rs1,
} satisfies Record<string, (fact: CellFacts) => number>;

function checkCells(run: Run, joined: JoinedCell[]): void {
  const { cost, gross } = measureFlags(run.config);
  const columns: (keyof typeof FACT_COLUMNS)[] = ["q0", "q1", "s0", "s1", "z0", "z1"];
  if (gross) columns.push("g0", "g1");
  if (cost) columns.push("rs0", "rs1");
  for (const column of columns) {
    closeColumn(run.label, column, pairs(run.label, joined, column, FACT_COLUMNS[column]));
  }
}

function checkNoUnits(run: Run, joined: JoinedCell[], facts: CellFacts[]): void {
  closeColumn(run.label, "no_units", pairs(run.label, joined, "no_units", (fact) => fact.z1 - fact.z0));
  close(valueOf(run, "no_units"), sum(facts.map((fact) => fact.z1 - fact.z0)), `${run.label}: no_units against the generated rows`);
}

function priorRate(facts: CellFacts[], full: boolean): { quantity: number; rate: number | null } {
  let quantity = 0;
  let sales = 0;
  for (const fact of facts) {
    if (full && !continuing(fact)) continue;
    quantity += fact.q0;
    sales += fact.s0;
  }
  return { quantity, rate: quantity > 0 ? sales / quantity : null };
}

function volumeAmount(fact: CellFacts, full: boolean, rate: number | null): number {
  if (rate === null) return 0;
  if (full && !continuing(fact)) return 0;
  return (fact.q1 - fact.q0) * rate;
}

function checkVolume(run: Run, joined: JoinedCell[], facts: CellFacts[]): number | null {
  const full = run.config.newAndDiscontinued === "full";
  const prior = priorRate(facts, full);
  if (!full) {
    assert.ok(prior.quantity > 0, `${run.label}: difference mode scope quantity expected to be positive, got ${prior.quantity}`);
  }
  closeColumn(run.label, "volume", pairs(run.label, joined, "volume", (fact) => volumeAmount(fact, full, prior.rate)));
  return prior.rate;
}

function likeForLikePrice(fact: CellFacts, full: boolean): number {
  if (!rated(fact, full)) return 0;
  return fact.s1 - (fact.q1 * fact.s0) / fact.q0;
}

function listPrice(fact: CellFacts, full: boolean): number {
  if (!(rated(fact, full) && fact.g0 !== 0 && fact.q0 > 0 && fact.q1 !== 0)) return 0;
  return (fact.g1 - (fact.q1 * fact.g0) / fact.q0) * (fact.s0 / fact.g0);
}

function discountAmount(fact: CellFacts, full: boolean): number {
  const price = likeForLikePrice(fact, full);
  const list = listPrice(fact, full);
  const splits = rated(fact, full) && fact.g0 !== 0 && fact.q0 > 0 && fact.q1 !== 0;
  if (!splits) return price - list;
  if (fact.g1 === 0) {
    // Current gross is zero, so the discount formula divides by it. The two lines add up to price.
    return price - list;
  }
  return fact.q1 * (fact.g1 / fact.q1) * (fact.s1 / fact.g1 - fact.s0 / fact.g0);
}

function sellingPrice(fact: CellFacts, full: boolean): number {
  if (!rated(fact, full)) return 0;
  return fact.rs1 - (fact.q1 * fact.rs0) / fact.q0;
}

function checkPrices(run: Run, joined: JoinedCell[]): void {
  const full = run.config.newAndDiscontinued === "full";
  const { cost, gross } = measureFlags(run.config);
  closeColumn(run.label, "price", pairs(run.label, joined, "price", (fact) => likeForLikePrice(fact, full)));
  if (gross) {
    closeColumn(run.label, "price_list", pairs(run.label, joined, "price_list", (fact) => listPrice(fact, full)));
    closeColumn(run.label, "price_discount", pairs(run.label, joined, "price_discount", (fact) => discountAmount(fact, full)));
  }
  if (cost) {
    closeColumn(run.label, "price_sales", pairs(run.label, joined, "price_sales", (fact) => sellingPrice(fact, full)));
    closeColumn(run.label, "cost_rate", pairs(run.label, joined, "cost_rate", (fact) => likeForLikePrice(fact, full) - sellingPrice(fact, full)));
  }
}

function groupPrices(facts: CellFacts[], levels: Level[], full: boolean): Map<string, number | null>[] {
  return levels.map((_, index) => {
    const columns = levels.slice(0, index + 1).flatMap((level) => level.columns);
    const totals = new Map<string, { quantity: number; sales: number }>();
    for (const fact of facts) {
      const id = keyId(columns, (column) => fact.key[column]);
      const bucket = totals.get(id) ?? { quantity: 0, sales: 0 };
      if (!full || continuing(fact)) {
        bucket.quantity += fact.q0;
        bucket.sales += fact.s0;
      }
      totals.set(id, bucket);
    }
    const prices = new Map<string, number | null>();
    for (const [id, bucket] of totals) prices.set(id, bucket.quantity > 0 ? bucket.sales / bucket.quantity : null);
    return prices;
  });
}

function referenceAt(label: string, fact: CellFacts, levels: Level[], prices: Map<string, number | null>[], rate: number | null, depth: number): number | null {
  for (let level = depth; level >= 1; level--) {
    const columns = levels.slice(0, level).flatMap((item) => item.columns);
    const price = prices[level - 1].get(keyId(columns, (column) => fact.key[column]));
    if (price === undefined) {
      throw new assert.AssertionError({
        message: `${label}: expected a group price at level ${level} for cell ${JSON.stringify(fact.key)}`,
        actual: undefined,
        expected: "group price",
      });
    }
    if (price !== null) return price;
  }
  return rate;
}

function checkRefs(run: Run, joined: JoinedCell[], facts: CellFacts[], rate: number | null): void {
  const full = run.config.newAndDiscontinued === "full";
  const levels = run.config.levels;
  const prices = groupPrices(facts, levels, full);
  for (let depth = 0; depth <= levels.length; depth++) {
    const column = `ref_${depth}`;
    closeNullableColumn(
      run.label,
      column,
      joined.map((row) => ({
        cell: row.id,
        actual: readNullable(row.cell, column, run.label),
        expected: depth === 0 ? rate : referenceAt(run.label, row.fact, levels, prices, rate, depth),
      })),
    );
  }
}

async function drillGroups(query: Query, run: Run, data: Dataset, cells: Record<string, unknown>[]): Promise<void> {
  const columnsToSum = ["q0", "q1", "s0", "s1", "z0", "z1", ...run.result.effects.map((effect) => effect.key)];
  for (const level of run.config.levels) {
    const columns = level.columns;
    const returned = await drill(query, run.config, { columns, limit: data.rows.length });
    for (const row of returned) {
      for (const column of columns) {
        assert.ok(Object.hasOwn(row, column), `${run.label}: drill by ${level.name} expected column ${column}`);
      }
    }
    const groups = new Map<string, Record<string, number>>();
    for (const cell of cells) {
      const id = keyId(columns, (column) => textKey(cell[column], run.label, column));
      let group = groups.get(id);
      if (!group) {
        group = Object.fromEntries(columnsToSum.map((column) => [column, 0]));
        groups.set(id, group);
      }
      for (const column of columnsToSum) group[column] += readNumber(cell, column, run.label);
    }
    const returnedIds = returned.map((row) => keyId(columns, (column) => textKey(row[column], run.label, column)));
    assert.equal(returned.length, groups.size, `${run.label}: drill by ${level.name} expected ${groups.size} groups, got ${returned.length}`);
    assert.equal(new Set(returnedIds).size, returnedIds.length, `${run.label}: drill by ${level.name} expected ${returnedIds.length} unique groups, got ${new Set(returnedIds).size}`);
    for (const id of groups.keys()) {
      assert.ok(returnedIds.includes(id), `${run.label}: drill by ${level.name} expected group ${id}`);
    }
    for (const column of columnsToSum) {
      closeColumn(
        run.label,
        `${column} drilled by ${level.name}`,
        returned.map((row) => {
          const id = keyId(columns, (key) => textKey(row[key], run.label, key));
          return { cell: id, actual: readNumber(row, column, run.label), expected: groups.get(id)?.[column] ?? Number.NaN };
        }),
      );
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
          const run = runs[mode][order];
          await cellsReconcile(query, run);
          totalsReconcile(run, data);
          keysContract(run);
          const cells = await query(`SELECT * FROM ${ident(run.result.cellsTable)}`);
          const columns = run.config.levels.flatMap((level) => level.columns);
          const facts = cellFacts(data, columns, run.config);
          const joined = joinCells(run, cells, facts);
          checkCells(run, joined);
          checkNoUnits(run, joined, facts);
          const rate = checkVolume(run, joined, facts);
          checkPrices(run, joined);
          await drillGroups(query, run, data, cells);
          checkRefs(run, joined, facts, rate);
        }
        orderInvariant(runs[mode].given, runs[mode].permuted);
      }
      for (const order of ORDERS) modesAgree(runs.difference[order], runs.full[order]);
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
