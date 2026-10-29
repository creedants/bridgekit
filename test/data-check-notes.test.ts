import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";
import { PERIOD, VIEW } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";

// The Data check helper lives in Results.tsx, and this runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already installs. The database module is kept off the wasm bundles the
// browser build imports by URL, the way test/date-order.test.ts does it. The
// small-bridges grid is replaced by a stub because it opens the page database
// as it loads, and this runner has none of the browser it needs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    if (specifier.endsWith("SmallBridges.tsx")) {
      return {
        url: "data:text/javascript,export const SmallBridges = () => null",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(new URL(url), "utf8");
      const { code } = transformSync(source, { loader: "tsx", format: "esm", jsx: "automatic" });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// Ambiguous slash dates, so the file is one the load reads month-first, beside
// a column whose numbers use a decimal comma.
const BOTH_FILE = `period;date;net_sales
2025;03/04/2025;1.234,56
2025;05/06/2025;12,50
`;

const DATE_FILE = `period;date;units
2025;03/04/2025;3
2025;05/06/2025;4
`;

// An ISO date and plain integers, so neither sentence applies.
const NEITHER_FILE = `period;date;units
2025;2025-03-04;3
2025;2025-05-06;4
`;

const DECIMAL = "1 column was read as numbers written with a decimal comma.";

/** Loads a fixture through the loader and number conversion the app uses. */
async function loaded(name: string, text: string): Promise<Query> {
  const directory = await mkdtemp("/tmp/bridgekit-notes-");
  const file = path.join(directory, `${name}.csv`);
  await writeFile(file, text);
  const { readCsvTable } = await import("../src/app/db.ts");
  const query = await openDatabase();
  try {
    await readCsvTable(query, name, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await convertFormattedNumbers(query, name);
  return query;
}

async function notes(query: Query, table: string, formulaBlanks?: number): Promise<string[]> {
  const { dataCheckNotes } = await import("../src/app/Results.tsx");
  return dataCheckNotes(query, table, formulaBlanks);
}

test("the Data check shows the decimal comma and the month-first sentences in order", async () => {
  const query = await loaded("both", BOTH_FILE);
  assert.deepEqual(await notes(query, "both"), [
    DECIMAL,
    "1 column with slash dates was read month-first: date.",
  ]);
});

test("the Data check shows the month-first sentence without the decimal comma one", async () => {
  const query = await loaded("dates", DATE_FILE);
  assert.deepEqual(await notes(query, "dates"), ["1 column with slash dates was read month-first: date."]);
});

test("the Data check shows no sentence for a file read as typed", async () => {
  const query = await loaded("neither", NEITHER_FILE);
  assert.deepEqual(await notes(query, "neither"), []);
});

test("a failing date order query still shows the decimal comma sentence", async () => {
  const query = await loaded("onefailed", BOTH_FILE);
  const picky: Query = (sql) =>
    sql.includes("duckdb_columns()") && sql.includes("'month first'")
      ? Promise.reject(new Error("the date order query failed"))
      : query(sql);
  assert.deepEqual(await notes(picky, "onefailed"), [DECIMAL]);
});

test("the Data check shows the singular formula sentence for one blank cell", async () => {
  const query = await loaded("single", NEITHER_FILE);
  assert.deepEqual(await notes(query, "single", 1), [
    "1 cell in the Excel file holds a formula with no saved result, so it was read as blank. Open and save the file in Excel, then load it again.",
  ]);
});

test("the Data check shows the plural formula sentence after the other read notes", async () => {
  const query = await loaded("plural", BOTH_FILE);
  assert.deepEqual(await notes(query, "plural", 2), [
    DECIMAL,
    "1 column with slash dates was read month-first: date.",
    "2 cells in the Excel file hold a formula with no saved result, so they were read as blank. Open and save the file in Excel, then load it again.",
  ]);
});

test("the Data check formats a large formula count with a thousands separator", async () => {
  const query = await loaded("large", NEITHER_FILE);
  assert.deepEqual(await notes(query, "large", 1000), [
    "1,000 cells in the Excel file hold a formula with no saved result, so they were read as blank. Open and save the file in Excel, then load it again.",
  ]);
});

test("the Data check shows no formula sentence at zero", async () => {
  const query = await loaded("zero", NEITHER_FILE);
  assert.deepEqual(await notes(query, "zero", 0), []);
  assert.deepEqual(await notes(query, "zero"), []);
});

/** A file with decimal commas and one period that holds a whole semicolon row. */
async function mixedLoaded(): Promise<{ query: Query; table: string }> {
  const query = await openDatabase();
  const table = "mixed";
  await query(`CREATE TABLE ${table} (period VARCHAR, units DOUBLE, amount VARCHAR)`);
  await query(
    `INSERT INTO ${table} VALUES ('2024', 3, '1.234,56'), ('2025', 4, '12,50'), ('2024;7;99', 5, '7,25')`,
  );
  await convertFormattedNumbers(query, table);
  await query(`CREATE VIEW ${VIEW} AS SELECT CAST(period AS VARCHAR) AS ${PERIOD} FROM ${table}`);
  return { query, table };
}

test("the whole-row note loads as a warning, not a decimal comma note", async () => {
  const { query, table } = await mixedLoaded();
  const whole = `1 row has a period such as "2024;7;99" that looks like a whole row. The file may mix separators. Save it again with one separator.`;
  assert.equal(await decimalCommaNote(query, table), `${DECIMAL} ${whole}`);
  assert.equal(await decimalCommaNote(query, table, false), DECIMAL);
  assert.deepEqual(await notes(query, table), [DECIMAL]);
});
