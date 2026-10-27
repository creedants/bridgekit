import assert from "node:assert/strict";
import { test } from "node:test";
import { guessSetup, isNumeric, type Column } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";
import {
  MAX_SAMPLE_ROWS,
  SAMPLE_ROWS,
  createBudgetSales,
  createSkuSales,
  resolveSample,
  type Sample,
} from "../src/synth.ts";

async function columnsOf(query: Query, table: string): Promise<Column[]> {
  const described = await query(`DESCRIBE "${table}"`);
  return described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
}

async function rowsOf(query: Query, table: string): Promise<unknown[]> {
  return query(`SELECT * FROM "${table}" ORDER BY ALL`);
}

async function periodValues(query: Query, sample: Sample): Promise<string[]> {
  const rows = await query(`SELECT DISTINCT CAST("${sample.setup.periodColumn}" AS VARCHAR) AS p FROM "data" ORDER BY 1`);
  return rows.map((row) => String(row.p));
}

/**
 * The preset and the setup guess must name columns the table really has, with
 * numeric units and sales, so a renamed or dropped column fails here.
 */
async function checkShape(query: Query, sample: Sample): Promise<Column[]> {
  const columns = await columnsOf(query, "data");
  const types = new Map(columns.map((column) => [column.name, column.type]));
  const named = [sample.setup.periodColumn, sample.setup.unitsColumn, sample.setup.salesColumn];
  for (const column of sample.setup.levels) named.push(...column.columns);
  for (const name of named) assert.ok(types.has(name), `${sample.name} sample is missing column ${name}`);
  assert.ok(isNumeric(types.get(sample.setup.unitsColumn)!), `${sample.name} units column is not numeric`);
  assert.ok(isNumeric(types.get(sample.setup.salesColumn)!), `${sample.name} sales column is not numeric`);

  const guessed = guessSetup(columns);
  assert.equal(guessed.periodColumn, sample.setup.periodColumn, `${sample.name} period guess`);
  assert.equal(guessed.unitsColumn, sample.setup.unitsColumn, `${sample.name} units guess`);
  assert.equal(guessed.salesColumn, sample.setup.salesColumn, `${sample.name} sales guess`);
  return columns;
}

test("the SKU sample gives the same rows on a second run, so a generator that draws at random fails here", async () => {
  const query = await openDatabase();
  await createSkuSales(query, 5_000, "first");
  await createSkuSales(query, 5_000, "second");
  const first = await rowsOf(query, "first");
  assert.ok(first.length > 0, "the SKU sample generated no rows");
  assert.deepEqual(await rowsOf(query, "second"), first);
});

test("the budget sample gives the same rows on a second run, so a generator that draws at random fails here", async () => {
  const query = await openDatabase();
  await createBudgetSales(query, 24, "first");
  await createBudgetSales(query, 24, "second");
  const first = await rowsOf(query, "first");
  assert.ok(first.length > 0, "the budget sample generated no rows");
  assert.deepEqual(await rowsOf(query, "second"), first);
});

test("the SKU sample has the one attribute, periods, units and sales its preset and the setup guess need", async () => {
  const query = await openDatabase();
  await createSkuSales(query, 5_000, "data");
  const { sample } = resolveSample("sku");
  const columns = await checkShape(query, sample);
  assert.equal(sample.setup.levels.length, 1, "the SKU sample should be a one-attribute bridge");
  assert.deepEqual(sample.setup.levels[0].columns, ["sku"]);
  const sku = columns.find((column) => column.name === "sku");
  assert.ok(sku && !isNumeric(sku.type), "the SKU attribute should be a text column");
  assert.deepEqual(await periodValues(query, sample), ["2025", "2026"]);
});

test("the budget sample's period column holds Budget and Actual, with Budget as prior", async () => {
  const query = await openDatabase();
  await createBudgetSales(query, 24, "data");
  const { sample } = resolveSample("budget");
  await checkShape(query, sample);
  assert.deepEqual(await periodValues(query, sample), ["Actual", "Budget"]);
  assert.deepEqual(sample.periods, { prior: "Budget", current: "Actual" });
  const [totals] = await query(
    `SELECT round(sum(sales), 2) AS sales, sum(units)::DOUBLE AS units FROM "data" WHERE period = 'Budget'`,
  );
  assert.ok(Number(totals.sales) > 0 && Number(totals.units) > 0, "the budget rows carry no sales");
});

test("an unknown or empty sample value still gives the configuration sample at its default row count", () => {
  for (const value of [null, "", "nope", "SKU", "constructor", "__proto__", "999"]) {
    const { sample, rows } = resolveSample(value);
    assert.equal(sample.name, "config", `sample ${JSON.stringify(value)}`);
    assert.equal(rows, SAMPLE_ROWS, `rows for ${JSON.stringify(value)}`);
  }
});

test("a sample number of 1000 or more stays the configuration row count, capped at five million", () => {
  for (const [value, rows] of [
    ["1000", 1_000],
    ["2500.7", 2_500],
    ["3000000", 3_000_000],
    ["1e6", 1_000_000],
    ["Infinity", MAX_SAMPLE_ROWS],
    ["9000000", MAX_SAMPLE_ROWS],
  ] as const) {
    const got = resolveSample(value);
    assert.equal(got.sample.name, "config", `sample for ${value}`);
    assert.equal(got.rows, rows, `rows for ${value}`);
  }
});

test("a named sample ignores the row count and loads at its own size", () => {
  const sku = resolveSample("sku");
  assert.equal(sku.sample.name, "sku");
  assert.equal(sku.rows, sku.sample.rows);
  const budget = resolveSample("budget");
  assert.equal(budget.sample.name, "budget");
  assert.equal(budget.rows, budget.sample.rows);
  assert.equal(resolveSample("config").rows, SAMPLE_ROWS);
});
