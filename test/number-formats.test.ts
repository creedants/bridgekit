import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";

const DECIMAL_COMMA = "1 column was read as numbers written with a decimal comma.";
const MIXED = "amount mixes number styles, so it was read as text.";

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlText(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

async function createText(query: Query, table: string, columns: Record<string, (string | null)[]>): Promise<void> {
  const names = Object.keys(columns);
  const height = columns[names[0]].length;
  if (names.some((name) => columns[name].length !== height)) throw new Error(`columns in ${table} have different lengths`);
  await query(`CREATE TABLE ${ident(table)} (${names.map((name) => `${ident(name)} VARCHAR`).join(", ")})`);
  if (height === 0) return;
  const tuples = Array.from({ length: height }, (_, row) => `(${names.map((name) => sqlText(columns[name][row])).join(", ")})`);
  await query(`INSERT INTO ${ident(table)} VALUES ${tuples.join(", ")}`);
}

async function columnType(query: Query, table: string, column: string): Promise<unknown> {
  const described = await query(`DESCRIBE ${ident(table)}`);
  return described.find((row) => row.column_name === column)?.column_type;
}

async function columnValues(query: Query, table: string, column: string): Promise<unknown[]> {
  const rows = await query(`SELECT ${ident(column)} AS v FROM ${ident(table)} ORDER BY rowid`);
  return rows.map((row) => row.v);
}

function expectNumbers(actual: unknown[], expected: (number | null)[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    const want = expected[index];
    if (want === null) {
      assert.equal(value, null);
      return;
    }
    const got = typeof value === "bigint" ? Number(value) : value;
    assert.equal(typeof got, "number");
    assert.ok(typeof got === "number" && Math.abs(got - want) < 1e-9, `${String(value)} is not ${want}`);
  });
}

interface FormatCase {
  name: string;
  values: (string | null)[];
  type: "DOUBLE" | "VARCHAR";
  numbers?: (number | null)[];
  note: string | null;
}

const cases: FormatCase[] = [
  {
    name: "a euro sign before the number reads as a decimal comma",
    values: ["€1.234,50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a euro sign after the number reads as a decimal comma",
    values: ["1.234,50€"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a euro code before the number reads as a decimal comma",
    values: ["EUR1.234,50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a euro code after one space reads as a decimal comma",
    values: ["1 234,50 EUR"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a swiss code with an apostrophe group reads as a north american number",
    values: ["CHF 1'234.50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: null,
  },
  {
    name: "a euro sign on a plain decimal comma reads as a decimal comma",
    values: ["€12,50"],
    type: "DOUBLE",
    numbers: [12.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a dollar value keeps its north american reading",
    values: ["$1,234.50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: null,
  },
  {
    name: "a euro sign before a north american number keeps the north american reading",
    values: ["€1,234.50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: null,
  },
  {
    name: "an ascii space groups thousands inside a symbol value",
    values: ["€1 234,50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a no-break space groups thousands",
    values: ["1\u00a0234,50 EUR"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a narrow no-break space groups thousands",
    values: ["1\u202f234,50 EUR"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "an apostrophe groups thousands without a currency",
    values: ["1'234.50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: null,
  },
  {
    name: "a right single quote groups thousands",
    values: ["1\u2019234,50 EUR"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a trailing minus on a north american number keeps the sign",
    values: ["1,234.50-"],
    type: "DOUBLE",
    numbers: [-1234.5],
    note: null,
  },
  {
    name: "a trailing minus on a decimal comma number keeps the sign",
    values: ["1.234,50-"],
    type: "DOUBLE",
    numbers: [-1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "parentheses around a symbol value read as a negative",
    values: ["(€1.234,50)"],
    type: "DOUBLE",
    numbers: [-1234.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "parentheses around a symbol value beside a plain decimal comma convert both",
    values: ["(€1.234,50)", "12,50"],
    type: "DOUBLE",
    numbers: [-1234.5, 12.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "two currency codes in one column stay text and are named",
    values: ["12,50 EUR", "13,50 GBP"],
    type: "VARCHAR",
    note: MIXED,
  },
  {
    name: "a dollar value and a euro code in one column stay text and are named",
    values: ["$1,234.50", "1.234,50 EUR"],
    type: "VARCHAR",
    note: MIXED,
  },
  {
    name: "a three letter word that is not a currency stays text",
    values: ["ABC 12"],
    type: "VARCHAR",
    note: null,
  },
  {
    name: "a symbol before an ambiguous thousands comma reads as a whole number",
    values: ["€1,234"],
    type: "DOUBLE",
    numbers: [1234],
    note: null,
  },
  {
    name: "a decorated decimal comma beside a four digit comma decimal converts both",
    values: ["€1.234,50", "12,3456"],
    type: "DOUBLE",
    numbers: [1234.5, 12.3456],
    note: DECIMAL_COMMA,
  },
  {
    name: "one currency beside an unmarked value converts both",
    values: ["€1.234,50", "12,50"],
    type: "DOUBLE",
    numbers: [1234.5, 12.5],
    note: DECIMAL_COMMA,
  },
  {
    name: "a currency code before a whole number converts it",
    values: ["EUR 1234"],
    type: "DOUBLE",
    numbers: [1234],
    note: null,
  },
  {
    name: "a symbol with a space after it stays text",
    values: ["€ 12,50"],
    type: "VARCHAR",
    note: null,
  },
  {
    name: "an ascii space with no currency stays text",
    values: ["1 234,56"],
    type: "VARCHAR",
    note: null,
  },
  {
    name: "parentheses around a plain decimal comma stay text",
    values: ["(12,50)"],
    type: "VARCHAR",
    note: null,
  },
];

for (const format of cases) {
  test(format.name, async () => {
    const query = await openDatabase();
    await createText(query, "data", { amount: format.values });
    await convertFormattedNumbers(query, "data");
    assert.equal(await columnType(query, "data", "amount"), format.type);
    if (format.type === "DOUBLE") expectNumbers(await columnValues(query, "data", "amount"), format.numbers ?? []);
    else assert.deepEqual(await columnValues(query, "data", "amount"), format.values);
    assert.equal(await decimalCommaNote(query, "data"), format.note);
  });
}

test("a semicolon file of euro prices loads as decimals", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-formats-");
  const file = path.join(directory, "euro.csv");
  await writeFile(file, "period;sku;units;net_sales\n2024;A;10,00;€1.234,50\n2024;B;4,00;€12,50\n");
  const query = await openDatabase();
  await query(`CREATE TABLE data AS SELECT * FROM read_csv(${sqlText(file)}, delim=';', header=true)`);
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "units"), "DOUBLE");
  assert.equal(await columnType(query, "data", "net_sales"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "units"), [10, 4]);
  expectNumbers(await columnValues(query, "data", "net_sales"), [1234.5, 12.5]);
  assert.equal(await decimalCommaNote(query, "data"), "2 columns were read as numbers written with a decimal comma.");
});

test("a second conversion keeps the currency values and the sentence", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["€1.234,50", "(€12,50)"] });
  await convertFormattedNumbers(query, "data");
  const values = await columnValues(query, "data", "amount");
  expectNumbers(values, [1234.5, -12.5]);
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "amount"), [1234.5, -12.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA);
});
