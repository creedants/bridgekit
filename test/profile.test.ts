import assert from "node:assert/strict";
import { test } from "node:test";
import { distinctCounts, findRollups, suggestAttributes } from "../src/app/profile.ts";
import { guessSetup, quote, type Column } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";
import { createSyntheticSales } from "../src/synth.ts";

async function columnsOf(query: Query): Promise<Column[]> {
  const described = await query(`DESCRIBE "data"`);
  return described.map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
}

async function load(sql: string): Promise<{ query: Query; columns: Column[] }> {
  const query = await openDatabase();
  await query(`CREATE TABLE data AS ${sql}`);
  return { query, columns: await columnsOf(query) };
}

/** Previous pair-count query, kept so a change in either count fails this file. */
async function legacyRollups(query: Query, columns: Column[], distinct: Map<string, number>): Promise<string[][]> {
  const candidates = columns
    .filter((column) => !/INT|DOUBLE|DECIMAL|FLOAT|REAL/i.test(column.type) && !/DATE|TIMESTAMP/i.test(column.type))
    .filter((column) => {
      const n = distinct.get(column.name) ?? 0;
      return n >= 2 && n <= 5_000;
    })
    .slice(0, 14)
    .map((column) => column.name);
  if (candidates.length < 2) return [];
  const pairs: [string, string][] = [];
  for (const a of candidates) for (const b of candidates) if (a < b) pairs.push([a, b]);
  const [row] = await query(
    `SELECT ${candidates.map((column, i) => `count(DISTINCT ${quote(column)})::DOUBLE AS d${i}`).join(", ")},
       ${pairs.map(([a, b], i) => `count(DISTINCT (${quote(a)}, ${quote(b)})) FILTER (WHERE ${quote(a)} IS NOT NULL AND ${quote(b)} IS NOT NULL)::DOUBLE AS p${i}`).join(", ")}
     FROM (SELECT * FROM "data" USING SAMPLE 200000 ROWS)`,
  );
  const count = new Map(candidates.map((column, i) => [column, Number(row[`d${i}`])]));
  const parents = new Map<string, Set<string>>(candidates.map((column) => [column, new Set()]));
  pairs.forEach(([a, b], i) => {
    const together = Number(row[`p${i}`]);
    const [finer, broader] = count.get(a)! > count.get(b)! ? [a, b] : [b, a];
    if (count.get(finer)! > count.get(broader)! && together === count.get(finer)) parents.get(finer)!.add(broader);
  });
  const isParent = new Set([...parents.values()].flatMap((set) => [...set]));
  const chains: string[][] = [];
  for (const leaf of candidates) {
    if (isParent.has(leaf) || parents.get(leaf)!.size === 0) continue;
    const above = [...parents.get(leaf)!].sort((a, b) => count.get(b)! - count.get(a)!);
    const chain = [leaf];
    for (const column of above) {
      if (parents.get(chain[chain.length - 1])!.has(column)) chain.push(column);
    }
    chains.push(chain.reverse());
  }
  return chains;
}

test("a clean product, family, and category hierarchy is one chain", async () => {
  const { query, columns } = await load(`SELECT * FROM (VALUES
    ('P1', 'F1', 'C1'),
    ('P2', 'F1', 'C1'),
    ('P3', 'F2', 'C1'),
    ('P4', 'F3', 'C2')
  ) v(product, family, category)`);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("product"), 4);
  assert.equal(distinct.get("family"), 3);
  assert.equal(distinct.get("category"), 2);
  assert.deepEqual(await findRollups(query, columns, distinct), [["category", "family", "product"]]);
});

test("one row that puts a family in a second category stops that link", async () => {
  const { query, columns } = await load(`SELECT * FROM (VALUES
    ('P1', 'F1', 'C1'),
    ('P2', 'F1', 'C1'),
    ('P3', 'F2', 'C1'),
    ('P4', 'F2', 'C1'),
    ('P4', 'F2', 'C2')
  ) v(product, family, category)`);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("product"), 4);
  assert.equal(distinct.get("family"), 2);
  assert.equal(distinct.get("category"), 2);
  assert.deepEqual(await findRollups(query, columns, distinct), [["family", "product"]]);
});

test("nulls in a candidate column do not break a real roll-up", async () => {
  const { query, columns } = await load(`SELECT * FROM (VALUES
    ('P1', 'F1', 'C1'),
    ('P1', NULL, 'C1'),
    ('P2', 'F1', 'C1'),
    ('P3', 'F2', 'C1'),
    ('P4', 'F3', 'C2')
  ) v(product, family, category)`);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("product"), 4);
  assert.equal(distinct.get("family"), 3);
  assert.equal(distinct.get("category"), 2);
  assert.deepEqual(await findRollups(query, columns, distinct), [["category", "family", "product"]]);
});

test("numbers and dates are counted and then left out of roll-ups", async () => {
  const { query, columns } = await load(`SELECT * FROM (VALUES
    ('P1', 'F1', 1, DATE '2025-01-01', true),
    ('P2', 'F1', 2, DATE '2025-01-02', true),
    ('P3', 'F2', 3, DATE '2026-01-03', true),
    ('P4', 'F3', 4, DATE '2026-01-04', false)
  ) v(product, family, qty, ordered, upgrade)`);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("qty"), 4);
  assert.equal(distinct.get("ordered"), 4);
  assert.equal(distinct.get("upgrade"), 2);
  assert.equal(distinct.get("product"), 4);
  assert.equal(distinct.get("family"), 3);
  assert.deepEqual(await findRollups(query, columns, distinct), [["upgrade", "family", "product"]]);
});

test("fewer than two text columns produces no roll-up", async () => {
  const { query, columns } = await load(`SELECT * FROM (VALUES
    ('P1', 1, DATE '2025-01-01'),
    ('P2', 2, DATE '2025-01-02')
  ) v(product, qty, ordered)`);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("product"), 2);
  assert.equal(distinct.get("qty"), 2);
  assert.deepEqual(await findRollups(query, columns, distinct), []);
});

test("synthetic sales at 10k rows keep the same counts and chains", async () => {
  const query = await openDatabase();
  await createSyntheticSales(query, 10_000, "data");
  const columns = await columnsOf(query);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("year"), 2);
  assert.equal(distinct.get("cost"), 3845);
  assert.equal(distinct.get("order_date"), 672);
  assert.equal(distinct.get("customer"), 400);
  assert.equal(distinct.get("model"), 60);
  assert.equal(distinct.get("finish"), 12);
  assert.equal(distinct.get("color"), 3);
  assert.equal(distinct.get("upgrade"), 2);
  assert.equal(distinct.get("material"), 8);
  assert.equal(distinct.get("delivery"), 2);
  assert.equal(distinct.get("units"), 2);
  assert.equal(distinct.get("sales"), 7891);
  assert.equal(distinct.get("gross_sales"), 8032);
  const chains = await findRollups(query, columns, distinct);
  assert.deepEqual(chains, []);
  assert.deepEqual(chains, await legacyRollups(query, columns, distinct));
});

test("synthetic sales at 300k rows match the previous query on one frozen sample", async () => {
  const query = await openDatabase();
  await createSyntheticSales(query, 300_000, "data");
  const fullColumns = await columnsOf(query);
  const fullDistinct = await distinctCounts(query, fullColumns);
  assert.equal(fullDistinct.get("customer"), 400);
  assert.equal(fullDistinct.get("model"), 60);
  assert.equal(fullDistinct.get("finish"), 12);
  assert.equal(fullDistinct.get("color"), 3);
  assert.equal(fullDistinct.get("upgrade"), 2);
  assert.equal(fullDistinct.get("material"), 8);
  assert.equal(fullDistinct.get("delivery"), 2);
  assert.equal(fullDistinct.get("sales"), 37031);
  assert.equal(fullDistinct.get("gross_sales"), 39234);
  await query(`CREATE TABLE held AS SELECT * FROM data USING SAMPLE 200000 ROWS`);
  await query(`DROP TABLE data`);
  await query(`ALTER TABLE held RENAME TO data`);
  const [size] = await query(`SELECT count(*)::DOUBLE AS n FROM data`);
  assert.equal(size.n, 200_000);
  const columns = await columnsOf(query);
  const distinct = await distinctCounts(query, columns);
  assert.deepEqual(await findRollups(query, columns, distinct), await legacyRollups(query, columns, distinct));
});

test("a hierarchy larger than the sample still reports the full chain", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE data AS
    SELECT
      'P' || (i % 100)::VARCHAR AS product,
      'F' || ((i % 100) // 10)::VARCHAR AS family,
      'C' || ((i % 100) // 40)::VARCHAR AS category,
      i % 7 AS qty,
      DATE '2025-01-01' + (i % 30)::INTEGER AS ordered
    FROM range(250000) t(i)`);
  const columns = await columnsOf(query);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("product"), 100);
  assert.equal(distinct.get("family"), 10);
  assert.equal(distinct.get("category"), 3);
  assert.equal(distinct.get("qty"), 7);
  assert.deepEqual(await findRollups(query, columns, distinct), [["category", "family", "product"]]);
  assert.deepEqual(
    await findRollups(query, columns, distinct),
    await legacyRollups(query, columns, distinct),
  );
});

function usedOf(columns: Column[]): Set<string> {
  const setup = guessSetup(columns);
  return new Set(
    [setup.periodColumn, setup.unitsColumn, setup.salesColumn, setup.grossColumn, setup.costColumn].filter(
      (name): name is string => typeof name === "string" && name !== "",
    ),
  );
}

test("the sample file suggests six attributes, fewest values first, and not customer", async () => {
  const query = await openDatabase();
  const file = new URL("../public/sample-sales.csv", import.meta.url).pathname;
  await query(`CREATE TABLE data AS SELECT * FROM read_csv('${file.replaceAll("'", "''")}', header=true)`);
  const columns = await columnsOf(query);
  const distinct = await distinctCounts(query, columns);
  assert.equal(distinct.get("model"), 60);
  assert.equal(distinct.get("finish"), 12);
  assert.equal(distinct.get("material"), 8);
  assert.equal(distinct.get("color"), 3);
  assert.equal(distinct.get("upgrade"), 2);
  assert.equal(distinct.get("delivery"), 2);
  assert.equal(distinct.get("customer"), 399);
  const suggested = suggestAttributes(columns, distinct, usedOf(columns));
  assert.deepEqual(suggested, ["upgrade", "delivery", "color", "material", "finish", "model"]);
  assert.equal(suggested.includes("customer"), false);
});

test("columns with one or more than 5000 distinct values are left out", () => {
  const columns: Column[] = [
    { name: "single", type: "VARCHAR" },
    { name: "pair", type: "VARCHAR" },
    { name: "limit", type: "VARCHAR" },
    { name: "huge", type: "VARCHAR" },
  ];
  const distinct = new Map([
    ["single", 1],
    ["pair", 2],
    ["limit", 5000],
    ["huge", 5001],
  ]);
  assert.deepEqual(suggestAttributes(columns, distinct, new Set()), ["pair", "limit"]);
});

test("numeric and date columns are left out", () => {
  const columns: Column[] = [
    { name: "qty", type: "BIGINT" },
    { name: "amount", type: "DOUBLE" },
    { name: "ordered", type: "DATE" },
    { name: "product", type: "VARCHAR" },
  ];
  const distinct = new Map([
    ["qty", 4],
    ["amount", 4],
    ["ordered", 4],
    ["product", 4],
  ]);
  assert.deepEqual(suggestAttributes(columns, distinct, new Set()), ["product"]);
});

test("a true/false column with two values is suggested", () => {
  const columns: Column[] = [
    { name: "upgrade", type: "BOOLEAN" },
    { name: "product", type: "VARCHAR" },
  ];
  const distinct = new Map([
    ["upgrade", 2],
    ["product", 4],
  ]);
  assert.deepEqual(suggestAttributes(columns, distinct, new Set()), ["upgrade", "product"]);
});

test("customer, region, date and id names are left out", () => {
  const columns: Column[] = [
    { name: "customer", type: "VARCHAR" },
    { name: "customer_id", type: "VARCHAR" },
    { name: "region", type: "VARCHAR" },
    { name: "country", type: "VARCHAR" },
    { name: "order_date", type: "VARCHAR" },
    { name: "orderDate", type: "VARCHAR" },
    { name: "order_id", type: "VARCHAR" },
    { name: "id", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
  ];
  const distinct = new Map(columns.map((column) => [column.name, 10]));
  assert.deepEqual(suggestAttributes(columns, distinct, new Set()), ["product"]);
});

test("used period and measure columns are left out", () => {
  const columns: Column[] = [
    { name: "year", type: "VARCHAR" },
    { name: "units", type: "VARCHAR" },
    { name: "sales", type: "VARCHAR" },
    { name: "product", type: "VARCHAR" },
  ];
  const distinct = new Map([
    ["year", 4],
    ["units", 4],
    ["sales", 4],
    ["product", 4],
  ]);
  assert.deepEqual(suggestAttributes(columns, distinct, new Set(["year", "units", "sales"])), ["product"]);
});

test("ties keep file order", () => {
  const columns: Column[] = [
    { name: "beta", type: "VARCHAR" },
    { name: "alpha", type: "VARCHAR" },
    { name: "gamma", type: "VARCHAR" },
  ];
  const distinct = new Map([
    ["beta", 5],
    ["alpha", 5],
    ["gamma", 3],
  ]);
  assert.deepEqual(suggestAttributes(columns, distinct, new Set()), ["gamma", "beta", "alpha"]);
});

test("an empty profile returns an empty list", () => {
  assert.deepEqual(suggestAttributes([], new Map(), new Set()), []);
});
