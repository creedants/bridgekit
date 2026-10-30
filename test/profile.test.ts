import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { distinctCounts, feeNote, feeRows, findRelationships, findRollups, profileFile, suggestAttributes } from "../src/app/profile.ts";
import { fileProblem, periodView, periodsFor, type Periods } from "../src/app/fileProblems.ts";
import { guessSetup, quote, refineGuess, type Column } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";
import { createSyntheticSales } from "../src/synth.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

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

// R26: the measure word lists in src/app/setup.ts cover German files, so the
// German measures are used and the other attributes are suggested.
test("R26: German measure names pick Menge and Umsatz", () => {
  const columns: Column[] = [
    { name: "Jahr", type: "VARCHAR" },
    { name: "A-100", type: "VARCHAR" },
    { name: "North", type: "VARCHAR" },
    { name: "Size", type: "VARCHAR" },
    { name: "Colour", type: "VARCHAR" },
    { name: "Menge", type: "INTEGER" },
    { name: "Umsatz", type: "DOUBLE" },
  ];
  const setup = guessSetup(columns);
  assert.equal(setup.unitsColumn, "Menge");
  assert.equal(setup.salesColumn, "Umsatz");
  const distinct = new Map([
    ["A-100", 3],
    ["North", 3],
    ["Size", 3],
    ["Colour", 3],
  ]);
  assert.deepEqual(suggestAttributes(columns, distinct, usedOf(columns)), ["A-100", "North", "Size", "Colour"]);
});

test("R8: German customer names are left out and the other attributes are suggested", () => {
  const columns: Column[] = [
    { name: "Datum", type: "DATE" },
    { name: "Produkt", type: "VARCHAR" },
    { name: "Größe", type: "VARCHAR" },
    { name: "Farbe", type: "VARCHAR" },
    { name: "Kunde", type: "VARCHAR" },
    { name: "Kundennummer", type: "VARCHAR" },
    { name: "Kundennr", type: "VARCHAR" },
    { name: "Menge", type: "INTEGER" },
    { name: "Umsatz", type: "DOUBLE" },
  ];
  const distinct = new Map([
    ["Produkt", 3],
    ["Größe", 2],
    ["Farbe", 2],
    ["Kunde", 5],
    ["Kundennummer", 5],
    ["Kundennr", 5],
  ]);
  assert.deepEqual(suggestAttributes(columns, distinct, new Set(["Datum", "Menge", "Umsatz"])), [
    "Größe",
    "Farbe",
    "Produkt",
  ]);
});

// D143. A class name and its code are the same thing, so a suggestion keeps
// only one of them, and fee-like rows are named rather than dropped.

test("D143: a name column and its code are found one to one, and only the name is suggested", async () => {
  const { query, columns } = await load(
    `SELECT * FROM (VALUES ('Spirits', 'S01'), ('Wine', 'W01'), ('Beer', 'B01')) t(class_name, class_code)`,
  );
  const distinct = await distinctCounts(query, columns);
  const { chains, duplicates } = await findRelationships(query, columns, distinct);
  assert.deepEqual(chains, []);
  assert.deepEqual(duplicates, [["class_name", "class_code"]]);
  const marked = columns.map((column) =>
    duplicates.some(([, later]) => later === column.name) ? { ...column, duplicateOf: duplicates.find(([, l]) => l === column.name)![0] } : column,
  );
  assert.deepEqual(suggestAttributes(marked, distinct, new Set()), ["class_name"]);
});

test("D143: a real hierarchy is still a chain and is not called one to one", async () => {
  const { query, columns } = await load(`SELECT * FROM (VALUES
    ('Spirits', 'A-100'), ('Spirits', 'A-101'), ('Wine', 'B-200'), ('Beer', 'C-300')) t(category_name, model)`,
  );
  const distinct = await distinctCounts(query, columns);
  const { chains, duplicates } = await findRelationships(query, columns, distinct);
  assert.deepEqual(chains, [["category_name", "model"]]);
  assert.deepEqual(duplicates, []);
});

test("D143: a fee row with no units is named in one sentence and kept", async () => {
  const { query, columns } = await load(`SELECT * FROM (VALUES
    ('2025', 'A-100', 10, 120.0), ('2026', 'A-100', 11, 132.0),
    ('2025', 'Postage', 0, 24.0), ('2026', 'Postage', 0, 25.0),
    ('2025', 'Adjustment', 0, -9.0), ('2026', 'Adjustment', 0, -10.0)) t(period, product, units, sales)`);
  const found = await feeRows(query, "data", { periodColumn: "period", unitsColumn: "units", salesColumn: "sales", levels: [{ name: "product", columns: ["product"] }] });
  assert.equal(found.withoutUnits, 4);
  assert.deepEqual(found.named, ["Adjustment", "Postage"]);
  assert.equal(found.namedRows, 4);
  assert.equal(
    feeNote(found),
    "4 rows have no units but some sales, and 4 of them are named like fees or adjustments; they are counted like products.",
  );
});

test("D143: before an attribute is chosen, the fee note reads the first text column", async () => {
  const { query } = await load(`SELECT * FROM (VALUES
    ('2025', 'A-100', 10, 120.0), ('2026', 'A-100', 11, 132.0),
    ('2025', 'Postage', 0, 24.0), ('2026', 'Postage', 0, 25.0),
    ('2025', 'Adjustment', 0, -9.0), ('2026', 'Adjustment', 0, -10.0)) t(period, product, units, sales)`);
  const found = await feeRows(query, "data", { periodColumn: "period", unitsColumn: "units", salesColumn: "sales", levels: [] });
  assert.equal(found.withoutUnits, 4);
  assert.deepEqual(found.named, ["Adjustment", "Postage"]);
  assert.equal(found.namedRows, 4);
  assert.equal(
    feeNote(found),
    "4 rows have no units but some sales, and 4 of them are named like fees or adjustments; they are counted like products.",
  );
});

test("D143: a class name whose code splits one class in two is still one thing", async () => {
  const values = Array.from({ length: 100 }, (_, i) => `Class ${i}`)
    .flatMap((name, i) => (i < 3 ? [[name, `C${i}a`], [name, `C${i}b`]] : [[name, `C${i}`]]))
    .map(([name, code]) => `('${name}', '${code}')`)
    .join(", ");
  const { query, columns } = await load(`SELECT * FROM (VALUES ${values}) t(class_name, class_code)`);
  const distinct = await distinctCounts(query, columns);
  const { chains, duplicates } = await findRelationships(query, columns, distinct);
  assert.deepEqual(chains, []);
  assert.deepEqual(duplicates, [["class_name", "class_code"]]);
  const marked = columns.map((column) =>
    duplicates.some(([, later]) => later === column.name) ? { ...column, duplicateOf: column.duplicateOf ?? "class_name" } : column,
  );
  assert.deepEqual(suggestAttributes(marked, distinct, new Set()), ["class_name"]);
});

test("D143: a code column before its name still suggests one attribute", async () => {
  const { query, columns } = await load(
    `SELECT * FROM (VALUES ('G01', 'North'), ('G02', 'South'), ('G03', 'Size')) t(group_code, group_label)`,
  );
  const distinct = await distinctCounts(query, columns);
  const { duplicates } = await findRelationships(query, columns, distinct);
  assert.deepEqual(duplicates, [["group_code", "group_label"]]);
  const marked = columns.map((column) =>
    duplicates.some(([, later]) => later === column.name)
      ? { ...column, duplicateOf: duplicates.find(([, later]) => later === column.name)![0] }
      : column,
  );
  assert.deepEqual(suggestAttributes(marked, distinct, new Set()), ["group_label"]);
});

test("D143: an alias pair with no id word suggests only the earlier column", async () => {
  const { query, columns } = await load(
    `SELECT * FROM (VALUES ('North', 'N1'), ('South', 'S1'), ('Size', 'Z1')) t(tier, tier_name)`,
  );
  const distinct = await distinctCounts(query, columns);
  const { duplicates } = await findRelationships(query, columns, distinct);
  assert.deepEqual(duplicates, [["tier", "tier_name"]]);
  const marked = columns.map((column) =>
    duplicates.some(([, later]) => later === column.name)
      ? { ...column, duplicateOf: duplicates.find(([, later]) => later === column.name)![0] }
      : column,
  );
  assert.deepEqual(suggestAttributes(marked, distinct, new Set()), ["tier"]);
});

test("D143: the applied profile carries the date facts that refine the grain", async () => {
  const query = await openDatabase();
  await query("CREATE TABLE data (sold_on DATE, product VARCHAR, units BIGINT, sales DOUBLE)");
  await query(
    `INSERT INTO data VALUES
      ('2026-01-05', 'A-100', 10, 120.0), ('2026-02-10', 'B-200', 12, 156.0), ('2026-03-20', 'A-100', 8, 64.0)`,
  );
  const columns = await columnsOf(query);
  let applied: Column[] = columns;
  await profileFile(query, columns, () => true, (profile) => {
    applied = profile.columns;
  });
  assert.deepEqual(applied.find((column) => column.name === "sold_on")?.facts, {
    first: "2026-01-05",
    last: "2026-03-20",
    months: 3,
  });
  const setup = guessSetup(applied);
  assert.equal(setup.grain, "year");
  assert.deepEqual(refineGuess(setup, applied), { grain: "month" });
});

// T418: when Calculate is blocked because Sales holds mixed number styles,
// the hint beside Calculate names the same example value and file row the
// Data check names, so the two never disagree. T384: a sheet row is proved
// by the sheet now loaded, so replacing the table names no row.

type ProfileQuery = Awaited<ReturnType<typeof openDatabase>>;

/** Describes the loaded table, profiles it, and returns the profiled columns. */
async function profileLoaded(query: ProfileQuery, table = "data"): Promise<Column[]> {
  const columns = (await query(`DESCRIBE ${table}`)).map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));
  let profiled = columns;
  await profileFile(query, columns, () => true, (profile) => {
    profiled = profile.columns;
  });
  return profiled;
}

function knownPeriods(values: readonly string[]): Periods {
  const view = periodView({ load: 1, periodColumn: "period", grain: "value", filters: [] });
  return periodsFor(view, { view, values });
}

function salesProblem(columns: Column[]) {
  return fileProblem({
    columns,
    rows: 2,
    periodColumn: "period",
    periods: knownPeriods(["2025", "2026"]),
    unitsColumn: "",
    salesColumn: "",
  });
}

/** Stages a CSV at a path the database can read, then returns the profiled columns. */
async function stagedCsv(query: ProfileQuery, name: string, content: string): Promise<Column[]> {
  const file = new File([content], name);
  const directory = await mkdtemp("/tmp/bridgekit-mixed-");
  const source = path.join(directory, name);
  await writeFile(source, content);
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  await stageCsvAndSwap(query, file, "data", source);
  return profileLoaded(query, "data");
}

/** Stages a workbook's flattened sheet, then returns the profiled columns. */
async function stagedWorkbook(query: ProfileQuery, name: string, rows: (string | number)[][]): Promise<Column[]> {
  const { default: ExcelJS } = await import("exceljs");
  const { firstSheetAsCsv } = await import("../src/app/sheet.ts");
  const { stageExcelAndSwap } = await import("../src/app/db.ts");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  for (const row of rows) sheet.addRow(row);
  const flat = await firstSheetAsCsv(new File([await workbook.xlsx.writeBuffer()], name));
  const directory = await mkdtemp("/tmp/bridgekit-mixed-");
  const flatPath = path.join(directory, `${name}.csv`);
  await writeFile(flatPath, flat.csv);
  await stageExcelAndSwap(query, "data", flatPath, flat.holes, flat.dataRows);
  return profileLoaded(query, "data");
}

test("T418: a CSV whose first amount is US names the comma value and row in both places", async () => {
  const query = await openDatabase();
  const columns = await stagedCsv(query, "us-first.csv", 'period,amount\n2025,"1,000.50"\n2026,"1.300,75"\n');
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  assert.equal(
    await decimalCommaNote(query, "data"),
    "amount mixes number styles, such as 1.300,75 in row 3, so it was read as text.",
  );
  assert.deepEqual(salesProblem(columns), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "amount" holds text, such as "1.300,75" in row 3.',
  });
});

test("T418: a CSV whose first amount is decimal comma names the US value and row in both places", async () => {
  const query = await openDatabase();
  const columns = await stagedCsv(query, "comma-first.csv", 'period,amount\n2025,"1.300,75"\n2026,"1,000.50"\n');
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  assert.equal(
    await decimalCommaNote(query, "data"),
    "amount mixes number styles, such as 1,000.50 in row 3, so it was read as text.",
  );
  assert.deepEqual(salesProblem(columns), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "amount" holds text, such as "1,000.50" in row 3.',
  });
});

test("T418: a workbook whose first amount is US names the comma value and row in both places", async () => {
  const query = await openDatabase();
  const columns = await stagedWorkbook(query, "us-first.xlsx", [
    ["period", "amount"],
    ["2025", "1,000.50"],
    ["2026", "1.300,75"],
  ]);
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  assert.equal(
    await decimalCommaNote(query, "data"),
    "amount mixes number styles, such as 1.300,75 in row 3, so it was read as text.",
  );
  assert.deepEqual(salesProblem(columns), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "amount" holds text, such as "1.300,75" in row 3.',
  });
});

test("T418: a workbook whose first amount is decimal comma names the US value and row in both places", async () => {
  const query = await openDatabase();
  const columns = await stagedWorkbook(query, "comma-first.xlsx", [
    ["period", "amount"],
    ["2025", "1.300,75"],
    ["2026", "1,000.50"],
  ]);
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  assert.equal(
    await decimalCommaNote(query, "data"),
    "amount mixes number styles, such as 1,000.50 in row 3, so it was read as text.",
  );
  assert.deepEqual(salesProblem(columns), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "amount" holds text, such as "1,000.50" in row 3.',
  });
});

test("T418: a bare mixed-styles mark names no example, as the Data check does", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE data AS SELECT * FROM (VALUES
    ('2025', 'A-100', '100'),
    ('2025', 'B-200', '110'),
    ('2026', 'A-100', 'n/a'),
    ('2026', 'B-200', '130')
  ) v(period, product, net_sales)`);
  await query(`COMMENT ON COLUMN data.net_sales IS 'mixed number styles'`);
  const columns = await profileLoaded(query, "data");
  assert.deepEqual(salesProblem(columns), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "net_sales" holds text.',
  });
});

test("T384: replacing a workbook table with the same count names no row", async () => {
  const query = await openDatabase();
  const columns = await stagedWorkbook(query, "blank.xlsx", [
    ["period", "Product", "units", "NET_SALES"],
    ["2025", "A-100", 10, 100],
    [],
    ["2025", "A-100", 10, 110],
    ["2026", "A-100", 10, "n/a"],
    ["2026", "A-100", 10, 130],
  ]);
  assert.deepEqual(
    fileProblem({
      columns,
      rows: 4,
      periodColumn: "period",
      periods: knownPeriods(["2025", "2026"]),
      unitsColumn: "units",
      salesColumn: "",
    }),
    {
      kind: "reason",
      message: 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 5.',
    },
  );
  await query(`CREATE OR REPLACE TABLE data AS SELECT * FROM (VALUES
    ('2025', 'A-100', 1, '100'),
    ('2025', 'B-200', 2, '110'),
    ('2026', 'A-100', 3, 'missing'),
    ('2026', 'B-200', 4, '130')
  ) v(period, product, units, net_sales)`);
  const replaced = await profileLoaded(query, "data");
  assert.deepEqual(
    fileProblem({
      columns: replaced,
      rows: 4,
      periodColumn: "period",
      periods: knownPeriods(["2025", "2026"]),
      unitsColumn: "units",
      salesColumn: "",
    }),
    {
      kind: "reason",
      message: 'Sales must be a column of numbers, and "net_sales" holds text, such as "missing".',
    },
  );
});

test("T384: a second workbook with the same count names its own new row", async () => {
  const query = await openDatabase();
  const first = await stagedWorkbook(query, "first.xlsx", [
    ["period", "Product", "units", "NET_SALES"],
    ["2025", "A-100", 10, 100],
    ["2025", "A-100", 10, 110],
    ["2026", "A-100", 10, "n/a"],
    ["2026", "A-100", 10, 130],
  ]);
  const problem = {
    rows: 4,
    periodColumn: "period",
    periods: knownPeriods(["2025", "2026"]),
    unitsColumn: "units",
    salesColumn: "",
  };
  assert.deepEqual(fileProblem({ columns: first, ...problem }), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 4.',
  });
  const second = await stagedWorkbook(query, "second.xlsx", [
    ["period", "Product", "units", "NET_SALES"],
    [],
    ["2025", "A-100", 10, 100],
    ["2025", "A-100", 10, 110],
    ["2026", "A-100", 10, "n/a"],
    ["2026", "A-100", 10, 130],
  ]);
  assert.deepEqual(fileProblem({ columns: second, ...problem }), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 5.',
  });
});
