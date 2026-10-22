import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";
import { isNumeric } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import { runBridge, type Query } from "../src/engine.ts";
import { createSyntheticSales } from "../src/synth.ts";

const EURO_FILE = `period;sku;units;net_sales
2024;A;10,00;1.234,56
2024;B;4,00;12,50
2025;A;10,00;1.500,00
2025;B;4,00;15,00
`;

function productCodeFile(): string {
  const lines = ["period;product_code;units;net_sales"];
  for (let i = 0; i < 2000; i++) {
    const code = i % 4 < 2 ? "001" : "1";
    const period = i % 2 === 0 ? 2024 : 2025;
    const units = code === "001" ? (period === 2024 ? 1 : 2) : period === 2024 ? 2 : 1;
    const price = code === "001" ? (period === 2024 ? 10 : 11) : period === 2024 ? 100 : 90;
    lines.push(`${period};${code};${units};${units * price}`);
  }
  lines.push("2025;01,02;1;50");
  return `${lines.join("\n")}\n`;
}

test("a semicolon file of decimal commas loads as decimals", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "sales.csv");
  await writeFile(file, EURO_FILE);
  const query = await openDatabase();
  await query(`CREATE TABLE euro AS SELECT * FROM read_csv('${file}', delim=';', header=true)`);
  await convertFormattedNumbers(query, "euro");

  assert.equal(await columnType(query, "euro", "units"), "DOUBLE");
  assert.equal(await columnType(query, "euro", "net_sales"), "DOUBLE");
  const rows = await query(`SELECT period, sku, units, net_sales FROM euro ORDER BY rowid`);
  assert.deepEqual(
    rows.map((row) => [String(row.period), row.sku]),
    [
      ["2024", "A"],
      ["2024", "B"],
      ["2025", "A"],
      ["2025", "B"],
    ],
  );
  expectNumbers(rows.map((row) => row.units), [10, 4, 10, 4]);
  expectNumbers(rows.map((row) => row.net_sales), [1234.56, 12.5, 1500, 15]);
  assert.equal(await decimalCommaNote(query, "euro"), "2 columns were read as numbers written with a decimal comma.");
});

const ONE = "1 column was read as numbers written with a decimal comma.";

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

test("negative decimal commas keep their sign", async () => {
  const query = await openDatabase();
  await createText(query, "signed", { amount: ["-12,50", "-1.234,56"] });
  await convertFormattedNumbers(query, "signed");
  assert.equal(await columnType(query, "signed", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "signed", "amount"), [-12.5, -1234.56]);
  assert.equal(await decimalCommaNote(query, "signed"), ONE);
});

test("spaces around a decimal comma still convert, and spaces around dollar and thousands forms still use today's reading", async () => {
  const query = await openDatabase();
  await createText(query, "spaced", {
    euro: ["  12,50  "],
    money: ["  $90.00  "],
    thousands: ["  1,260  "],
  });
  await convertFormattedNumbers(query, "spaced");
  assert.equal(await columnType(query, "spaced", "euro"), "DOUBLE");
  assert.equal(await columnType(query, "spaced", "money"), "DOUBLE");
  assert.equal(await columnType(query, "spaced", "thousands"), "DOUBLE");
  expectNumbers(await columnValues(query, "spaced", "euro"), [12.5]);
  expectNumbers(await columnValues(query, "spaced", "money"), [90]);
  expectNumbers(await columnValues(query, "spaced", "thousands"), [1260]);
  assert.equal(await decimalCommaNote(query, "spaced"), ONE);
});

test("null and whitespace beside a decimal comma stay text", async () => {
  const query = await openDatabase();
  await createText(query, "blanks", { amount: [null, "   ", "\t", "12,50"] });
  await convertFormattedNumbers(query, "blanks");
  assert.equal(await columnType(query, "blanks", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "blanks", "amount"), [null, "   ", "\t", "12,50"]);
  assert.equal(await decimalCommaNote(query, "blanks"), null);
});

test("north american formatted numbers keep today's readings", async () => {
  const query = await openDatabase();
  await createText(query, "us", { amount: ["1,260", "$90.00", "(45)", "(1,260)"] });
  await convertFormattedNumbers(query, "us");
  assert.equal(await columnType(query, "us", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "us", "amount"), [1260, 90, -45, -1260]);
  assert.equal(await decimalCommaNote(query, "us"), null);
});

test("a thousands comma of three digits keeps today's reading", async () => {
  const query = await openDatabase();
  await createText(query, "alone", { amount: ["1,234"] });
  await createText(query, "grouped", { amount: ["0,125", "1,500"] });
  await convertFormattedNumbers(query, "alone");
  await convertFormattedNumbers(query, "grouped");
  assert.equal(await columnType(query, "alone", "amount"), "DOUBLE");
  assert.equal(await columnType(query, "grouped", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "alone", "amount"), [1234]);
  expectNumbers(await columnValues(query, "grouped", "amount"), [125, 1500]);
  assert.equal(await decimalCommaNote(query, "alone"), null);
  assert.equal(await decimalCommaNote(query, "grouped"), null);
});

test("a plain code stays text", async () => {
  const query = await openDatabase();
  await createText(query, "codes", { sku: ["10023"] });
  await convertFormattedNumbers(query, "codes");
  assert.equal(await columnType(query, "codes", "sku"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "codes", "sku"), ["10023"]);
  assert.equal(await decimalCommaNote(query, "codes"), null);
});

test("dot numbers with no comma stay as read_csv typed them", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "dots.csv");
  await writeFile(file, "amount\n1.234\n2.500\n");
  const query = await openDatabase();
  await query(`CREATE TABLE sniffed AS SELECT * FROM read_csv('${file}', header=true)`);
  const beforeType = await columnType(query, "sniffed", "amount");
  const beforeValues = await columnValues(query, "sniffed", "amount");
  await convertFormattedNumbers(query, "sniffed");
  assert.equal(await columnType(query, "sniffed", "amount"), beforeType);
  assert.deepEqual(await columnValues(query, "sniffed", "amount"), beforeValues);
  assert.equal(await decimalCommaNote(query, "sniffed"), null);

  await createText(query, "forced", { amount: ["1.234", "2.500"] });
  await convertFormattedNumbers(query, "forced");
  assert.equal(await columnType(query, "forced", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "forced", "amount"), ["1.234", "2.500"]);
  assert.equal(await decimalCommaNote(query, "forced"), null);
});

test("a grouped dot beside a decimal comma converts", async () => {
  const query = await openDatabase();
  await createText(query, "grouped", { amount: ["1.234", "12,50"] });
  await convertFormattedNumbers(query, "grouped");
  assert.equal(await columnType(query, "grouped", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "grouped", "amount"), [1234, 12.5]);
  assert.equal(await decimalCommaNote(query, "grouped"), ONE);
});

test("a whole number of at most three digits beside a decimal comma converts", async () => {
  const query = await openDatabase();
  await createText(query, "short", { amount: ["100", "12,50"] });
  await convertFormattedNumbers(query, "short");
  assert.equal(await columnType(query, "short", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "short", "amount"), [100, 12.5]);
  assert.equal(await decimalCommaNote(query, "short"), ONE);
});

test("a four-digit whole number beside a decimal comma stays text", async () => {
  const query = await openDatabase();
  await createText(query, "long", {
    fifteen: ["1500", "12,50"],
    thousand: ["1000", "12,50"],
  });
  await convertFormattedNumbers(query, "long");
  assert.equal(await columnType(query, "long", "fifteen"), "VARCHAR");
  assert.equal(await columnType(query, "long", "thousand"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "long", "fifteen"), ["1500", "12,50"]);
  assert.deepEqual(await columnValues(query, "long", "thousand"), ["1000", "12,50"]);
  assert.equal(await decimalCommaNote(query, "long"), "fifteen and thousand mix number styles, so they were read as text.");
});

test("review two mixed US three-decimal columns stay text and are named", async () => {
  const query = await openDatabase();
  const cases: Record<string, [string, string]> = {
    grouped: ["1.234,567", "1,260.000"],
    plain: ["1.234,567", "1260.000"],
    plus: ["1.234,567", "+1,260.00"],
    dollar: ["1.234,567", "$1,260.000"],
    parens: ["1.234,567", "(1,260.000)"],
  };
  for (const [name, values] of Object.entries(cases)) {
    const table = `three_${name}`;
    await createText(query, table, { amount: values });
    await convertFormattedNumbers(query, table);
    assert.equal(await columnType(query, table, "amount"), "VARCHAR");
    assert.deepEqual(await columnValues(query, table, "amount"), values);
    assert.equal(await decimalCommaNote(query, table), "amount mixes number styles, so it was read as text.");
  }
});

test("a plain integer beside three-decimal comma proof stays text and is named", async () => {
  const query = await openDatabase();
  await createText(query, "intproof", { amount: ["1500", "1.234,567"] });
  await convertFormattedNumbers(query, "intproof");
  assert.equal(await columnType(query, "intproof", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "intproof", "amount"), ["1500", "1.234,567"]);
  assert.equal(await decimalCommaNote(query, "intproof"), "amount mixes number styles, so it was read as text.");
});

test("a semicolon file with mixed three-decimal styles loads and names the conflict", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "mixed-three.csv");
  await writeFile(
    file,
    "period;product;units;net_sales;gross_sales\n2024;A;10;1.234,567;100\n2024;A;10;1,260.000;200\n2025;A;10;1.234,567;110\n2025;A;10;1,260.000;210\n",
  );
  const query = await openDatabase();
  await query(`CREATE TABLE mixed_three AS SELECT * FROM read_csv('${file}', delim=';', header=true, types={'gross_sales': 'DOUBLE'})`);
  await convertFormattedNumbers(query, "mixed_three");
  assert.equal(await columnType(query, "mixed_three", "net_sales"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "mixed_three", "net_sales"), ["1.234,567", "1,260.000", "1.234,567", "1,260.000"]);
  assert.equal(await columnType(query, "mixed_three", "gross_sales"), "DOUBLE");
  assert.equal(await decimalCommaNote(query, "mixed_three"), "net_sales mixes number styles, so it was read as text.");
});

test("every number-shaped column left as text is named", async () => {
  const query = await openDatabase();
  const pool = [
    "1.234,567",
    "1,260.000",
    "1260.000",
    "+1,260.00",
    "$1,260.000",
    "(1,260.000)",
    "0,000,000",
    "1.234,56",
    "1,260.00",
    "1,234",
    "12,3456",
    "12,50",
    "0,125",
    "1.234",
    "1500",
    "12,5",
    "-1.234,567",
    "$90.00",
    "(45)",
    "1,234.56",
    "1.260e3",
    "1e3",
    "$90e2",
  ];
  const named = "amount mixes number styles, so it was read as text.";
  const hasMarker = (value: string): boolean => /[,$()]/.test(value);
  let text = 0;
  let numeric = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const table = `pair_${i}_${j}`;
      await createText(query, table, { amount: [pool[i], pool[j]] });
      await convertFormattedNumbers(query, table);
      const type = await columnType(query, table, "amount");
      if (type === "DOUBLE") {
        numeric += 1;
        continue;
      }
      assert.equal(type, "VARCHAR");
      assert.deepEqual(await columnValues(query, table, "amount"), [pool[i], pool[j]]);
      if (!hasMarker(pool[i]) && !hasMarker(pool[j])) {
        assert.equal(await decimalCommaNote(query, table), null);
        continue;
      }
      assert.equal(await decimalCommaNote(query, table), named);
      text += 1;
    }
  }
  assert.ok(text > 0);
  assert.ok(numeric > 0);
});

test("a decimal comma beside a north american decimal stays text", async () => {
  const query = await openDatabase();
  await createText(query, "mixed", { amount: ["1.234,56", "1,260.00"] });
  await convertFormattedNumbers(query, "mixed");
  assert.equal(await columnType(query, "mixed", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "mixed", "amount"), ["1.234,56", "1,260.00"]);
  assert.equal(await decimalCommaNote(query, "mixed"), "amount mixes number styles, so it was read as text.");
});

test("scientific notation beside a decimal comma stays text and is named", async () => {
  const query = await openDatabase();
  await createText(query, "sci_three", { amount: ["1.234,567", "1.260e3"] });
  await convertFormattedNumbers(query, "sci_three");
  assert.equal(await columnType(query, "sci_three", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "sci_three", "amount"), ["1.234,567", "1.260e3"]);
  assert.equal(await decimalCommaNote(query, "sci_three"), "amount mixes number styles, so it was read as text.");
  await createText(query, "sci_plain", { amount: ["1.234,56", "1e3"] });
  await convertFormattedNumbers(query, "sci_plain");
  assert.equal(await columnType(query, "sci_plain", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "sci_plain", "amount"), ["1.234,56", "1e3"]);
  assert.equal(await decimalCommaNote(query, "sci_plain"), "amount mixes number styles, so it was read as text.");
});

test("a space used as a thousands mark stays text", async () => {
  const query = await openDatabase();
  await createText(query, "space", { amount: ["1 234,56"] });
  await convertFormattedNumbers(query, "space");
  assert.equal(await columnType(query, "space", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "space", "amount"), ["1 234,56"]);
  assert.equal(await decimalCommaNote(query, "space"), null);
});

test("a euro sign stays text", async () => {
  const query = await openDatabase();
  await createText(query, "currency", { amount: ["€ 12,50"] });
  await convertFormattedNumbers(query, "currency");
  assert.equal(await columnType(query, "currency", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "currency", "amount"), ["€ 12,50"]);
  assert.equal(await decimalCommaNote(query, "currency"), null);
});

test("parentheses around a decimal comma stay text, and today's parentheses still convert", async () => {
  const query = await openDatabase();
  await createText(query, "parens", {
    euro: ["(12,50)", "(1.234,56)"],
    us: ["(45)", "(1,260)"],
  });
  await convertFormattedNumbers(query, "parens");
  assert.equal(await columnType(query, "parens", "euro"), "VARCHAR");
  assert.equal(await columnType(query, "parens", "us"), "DOUBLE");
  assert.deepEqual(await columnValues(query, "parens", "euro"), ["(12,50)", "(1.234,56)"]);
  expectNumbers(await columnValues(query, "parens", "us"), [-45, -1260]);
  assert.equal(await decimalCommaNote(query, "parens"), null);
});

test("three digits after a dot group mark read as a decimal comma", async () => {
  const query = await openDatabase();
  await createText(query, "tail", { amount: ["1.234,567", "2.345,678"] });
  await convertFormattedNumbers(query, "tail");
  assert.equal(await columnType(query, "tail", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "tail", "amount"), [1234.567, 2345.678]);
  assert.equal(await decimalCommaNote(query, "tail"), ONE);
});

test("three-decimal comma values convert via whole-column decision", async () => {
  const query = await openDatabase();
  await createText(query, "three", { amount: ["1.234,567", "0,125", "12,50"] });
  await convertFormattedNumbers(query, "three");
  assert.equal(await columnType(query, "three", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "three", "amount"), [1234.567, 0.125, 12.5]);
  assert.equal(await decimalCommaNote(query, "three"), ONE);
  await createText(query, "shorttail", { amount: ["0,125", "12,5"] });
  await convertFormattedNumbers(query, "shorttail");
  assert.equal(await columnType(query, "shorttail", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "shorttail", "amount"), [0.125, 12.5]);
  assert.equal(await decimalCommaNote(query, "shorttail"), ONE);
});

test("a decimal-comma column beside an ambiguous value stays text and the note names it", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "styles.csv");
  await writeFile(
    file,
    "period;product;units;net_sales;gross_sales\n2024;A;10;1,234;100\n2024;A;10;12,3456;200\n2025;A;10;1,234;110\n2025;A;10;12,3456;210\n",
  );
  const query = await openDatabase();
  await query(`CREATE TABLE styles AS SELECT * FROM read_csv('${file}', delim=';', header=true, types={'gross_sales': 'DOUBLE'})`);
  await convertFormattedNumbers(query, "styles");
  assert.equal(await columnType(query, "styles", "net_sales"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "styles", "net_sales"), ["1,234", "12,3456", "1,234", "12,3456"]);
  assert.equal(await columnType(query, "styles", "gross_sales"), "DOUBLE");
  assert.equal(await decimalCommaNote(query, "styles"), "net_sales mixes number styles, so it was read as text.");

  await createText(query, "pair", {
    a: ["1.234,56", "1,260.00"],
    b: ["1.234,567", "1,234"],
  });
  await convertFormattedNumbers(query, "pair");
  assert.equal(await columnType(query, "pair", "a"), "VARCHAR");
  assert.equal(await columnType(query, "pair", "b"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "pair", "a"), ["1.234,56", "1,260.00"]);
  assert.deepEqual(await columnValues(query, "pair", "b"), ["1.234,567", "1,234"]);
  assert.equal(await decimalCommaNote(query, "pair"), "a and b mix number styles, so they were read as text.");
});

test("a decimal comma after 2000 blank rows stays text", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE late AS SELECT i, CASE WHEN i < 2000 THEN NULL ELSE '12,50' END AS amount FROM range(2001) t(i) ORDER BY i`);
  await convertFormattedNumbers(query, "late");
  assert.equal(await columnType(query, "late", "amount"), "VARCHAR");
  const rows = await query(`SELECT amount FROM late ORDER BY i`);
  assert.equal(rows[0].amount, null);
  assert.equal(rows[2000].amount, "12,50");
  assert.equal(await decimalCommaNote(query, "late"), null);
});

test("a formatted value after 2000 plain codes stays text", async () => {
  const query = await openDatabase();
  await query(`
    CREATE TABLE late AS
    SELECT i,
      CASE WHEN i < 2000 THEN '10023' ELSE '$90.00' END AS money,
      CASE WHEN i < 2000 THEN '10023' ELSE '1,260' END AS thousands
    FROM range(2001) t(i)
    ORDER BY i
  `);
  await convertFormattedNumbers(query, "late");
  assert.equal(await columnType(query, "late", "money"), "VARCHAR");
  assert.equal(await columnType(query, "late", "thousands"), "VARCHAR");
  const rows = await query(`SELECT money, thousands FROM late ORDER BY i`);
  assert.equal(rows[0].money, "10023");
  assert.equal(rows[0].thousands, "10023");
  assert.equal(rows[2000].money, "$90.00");
  assert.equal(rows[2000].thousands, "1,260");
  assert.equal(await decimalCommaNote(query, "late"), null);
});

test("a decimal comma after 2000 thousands values stays text", async () => {
  const query = await openDatabase();
  await query(`
    CREATE TABLE late AS
    SELECT i, CASE WHEN i < 2000 THEN '1,260' ELSE '1.234,56' END AS amount
    FROM range(2001) t(i)
    ORDER BY i
  `);
  await convertFormattedNumbers(query, "late");
  assert.equal(await columnType(query, "late", "amount"), "VARCHAR");
  const rows = await query(`SELECT amount FROM late ORDER BY i`);
  assert.equal(rows[0].amount, "1,260");
  assert.equal(rows[2000].amount, "1.234,56");
  assert.equal(await decimalCommaNote(query, "late"), "amount mixes number styles, so it was read as text.");
});

test("a late product code stays text", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "codes.csv");
  await writeFile(file, productCodeFile());
  const query = await openDatabase();
  await query(`CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv(${sqlText(file)})`);
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "product_code"), "VARCHAR");
  const grouped = await query(`SELECT product_code, count(*)::DOUBLE AS n FROM data GROUP BY product_code ORDER BY product_code`);
  assert.deepEqual(
    grouped.map((row) => [row.product_code, Number(row.n)]),
    [
      ["001", 1000],
      ["01,02", 1],
      ["1", 1000],
    ],
  );
  const result = await runBridge(query, {
    table: "data",
    periodColumn: "period",
    prior: 2024,
    current: 2025,
    unitsColumn: "units",
    salesColumn: "net_sales",
    levels: [{ name: "Product", columns: ["product_code"] }],
  });
  assert.equal(result.priorSales, 105000);
  assert.equal(result.currentSales, 56050);
  assert.equal(result.effects.find((item) => item.key === "mix_1")?.value, -45000);
  assert.equal(result.effects.find((item) => item.key === "price")?.value, -4000);
  assert.equal(result.coverage.find((row) => row.level === 1)?.cells, 2);
});

test("a second conversion keeps the values and the sentence", async () => {
  const query = await openDatabase();
  await createText(query, "twice", { amount: ["12,50", "1.234,56"] });
  await convertFormattedNumbers(query, "twice");
  const note = await decimalCommaNote(query, "twice");
  const values = await columnValues(query, "twice", "amount");
  assert.equal(note, ONE);
  expectNumbers(values, [12.5, 1234.56]);
  await convertFormattedNumbers(query, "twice");
  assert.equal(await columnType(query, "twice", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "twice", "amount"), [12.5, 1234.56]);
  assert.equal(await decimalCommaNote(query, "twice"), note);
});

test("replacing the table drops the decimal-comma sentence", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["12,50"] });
  await convertFormattedNumbers(query, "data");
  assert.equal(await decimalCommaNote(query, "data"), ONE);
  await createSyntheticSales(query, 30, "data");
  assert.equal(await decimalCommaNote(query, "data"), null);
});

async function convertFormattedNumbersOnMain(query: Query, table: string): Promise<void> {
  const columns = (await query(`DESCRIBE "${table}"`))
    .filter((row) => String(row.column_type) === "VARCHAR")
    .map((row) => `"${String(row.column_name).replaceAll('"', '""')}"`);
  if (columns.length === 0) return;
  const cleaned = (c: string) =>
    `try_cast(regexp_replace(regexp_replace(trim(${c}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;
  const check = async (candidates: string[], source: string) => {
    const [counts] = await query(
      `SELECT ${candidates
        .map(
          (c, i) =>
            `count(${c})::DOUBLE AS n${i}, count(${cleaned(c)})::DOUBLE AS ok${i}, count(*) FILTER (WHERE regexp_matches(${c}, '[,$()]'))::DOUBLE AS f${i}`,
        )
        .join(", ")} FROM ${source}`,
    );
    return candidates.filter((_, i) => {
      const n = Number(counts[`n${i}`]);
      return n > 0 && n === Number(counts[`ok${i}`]) && Number(counts[`f${i}`]) > 0;
    });
  };
  const likely = await check(columns, `(SELECT * FROM "${table}" LIMIT 2000)`);
  if (likely.length === 0) return;
  for (const c of await check(likely, `"${table}"`)) {
    await query(`ALTER TABLE "${table}" ALTER ${c} TYPE DOUBLE USING ${cleaned(c)}`);
  }
}

async function checkPair(query: Query, name: string, build: (table: string) => Promise<void>): Promise<void> {
  const next = `${name}_next`;
  const main = `${name}_main`;
  await build(next);
  await build(main);
  await convertFormattedNumbers(query, next);
  await convertFormattedNumbersOnMain(query, main);
  const nextColumns = await query(`DESCRIBE ${ident(next)}`);
  const mainColumns = await query(`DESCRIBE ${ident(main)}`);
  for (const column of nextColumns) {
    if (!isNumeric(String(column.column_type))) continue;
    const other = mainColumns.find((row) => row.column_name === column.column_name);
    assert.equal(
      isNumeric(String(other?.column_type)),
      true,
      `${name}.${String(column.column_name)} is ${String(column.column_type)} and the old cleaner left ${String(other?.column_type)}`,
    );
  }
}

test("a numeric column is numeric under the old number check", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const euroFile = path.join(directory, "euro.csv");
  const dotsFile = path.join(directory, "dots.csv");
  const codesFile = path.join(directory, "codes.csv");
  await writeFile(euroFile, EURO_FILE);
  await writeFile(dotsFile, "amount\n1.234\n2.500\n");
  await writeFile(codesFile, productCodeFile());
  const query = await openDatabase();
  const textColumns: Record<string, Record<string, (string | null)[]>> = {
    signed: { amount: ["-12,50", "-1.234,56"] },
    spaced: { euro: ["  12,50  "], money: ["  $90.00  "], thousands: ["  1,260  "] },
    blanks: { amount: [null, "   ", "\t", "12,50"] },
    us: { amount: ["1,260", "$90.00", "(45)", "(1,260)"] },
    alone: { amount: ["1,234"] },
    grouped_thousands: { amount: ["0,125", "1,500"] },
    codes: { sku: ["10023"] },
    forced: { amount: ["1.234", "2.500"] },
    grouped_dot: { amount: ["1.234", "12,50"] },
    short: { amount: ["100", "12,50"] },
    long: { fifteen: ["1500", "12,50"], thousand: ["1000", "12,50"] },
    mixed: { amount: ["1.234,56", "1,260.00"] },
    space_mark: { amount: ["1 234,56"] },
    currency: { amount: ["€ 12,50"] },
    parens: { euro: ["(12,50)", "(1.234,56)"], us: ["(45)", "(1,260)"] },
    tail: { amount: ["1.234,567"] },
    twice: { amount: ["12,50", "1.234,56"] },
    data: { amount: ["12,50"] },
    one_five: { amount: ["1,5", "1,234"] },
    dollar_comma: { amount: ["$12,50"] },
    twelve_and_dollar: { amount: ["12,34", "$90.00"] },
    one_two: { amount: ["1,2", "3,4"] },
    twelve_pair: { amount: ["12,34", "56,78"] },
    not_available: { amount: ["12,50", "NA"] },
    dash: { amount: ["12,50", "-"] },
    slash_na: { amount: ["12,50", "n/a"] },
    percent: { amount: ["12,5%"] },
    many_dots: { amount: ["1.234.567"] },
    scientific: { amount: ["1e3", "2.5e-2"] },
    scientific_formatted: { amount: ["1,234e2", "$90e2"] },
    both_marks: { amount: ["1.234,56", "1,234.56"] },
    dates: { amount: ["01.02.2025", "02.02.2025"] },
  };
  for (const [name, columns] of Object.entries(textColumns)) {
    await checkPair(query, name, (table) => createText(query, table, columns));
  }
  const lateSql: Record<string, string> = {
    late_blank: "SELECT i, CASE WHEN i < 2000 THEN NULL ELSE '12,50' END AS amount FROM range(2001) t(i) ORDER BY i",
    late_formatted:
      "SELECT i, CASE WHEN i < 2000 THEN '10023' ELSE '$90.00' END AS money, CASE WHEN i < 2000 THEN '10023' ELSE '1,260' END AS thousands FROM range(2001) t(i) ORDER BY i",
    late_thousands: "SELECT i, CASE WHEN i < 2000 THEN '1,260' ELSE '1.234,56' END AS amount FROM range(2001) t(i) ORDER BY i",
    late_hundred_50: "SELECT CASE WHEN i < 2000 THEN '100' ELSE '12,50' END AS amount FROM range(2001) t(i) ORDER BY i",
    late_hundred_34: "SELECT CASE WHEN i < 2000 THEN '100' ELSE '12,34' END AS amount FROM range(2001) t(i) ORDER BY i",
  };
  for (const [name, select] of Object.entries(lateSql)) {
    await checkPair(query, name, async (table) => {
      await query(`CREATE TABLE ${ident(table)} AS ${select}`);
    });
  }
  await checkPair(query, "euro", async (table) => {
    await query(`CREATE TABLE ${ident(table)} AS SELECT * FROM read_csv(${sqlText(euroFile)}, delim=';', header=true)`);
  });
  await checkPair(query, "sniffed", async (table) => {
    await query(`CREATE TABLE ${ident(table)} AS SELECT * FROM read_csv(${sqlText(dotsFile)}, header=true)`);
  });
  await checkPair(query, "product_codes", async (table) => {
    await query(`CREATE TABLE ${ident(table)} AS SELECT * FROM read_csv(${sqlText(codesFile)})`);
  });
  await checkPair(query, "synth", (table) => createSyntheticSales(query, 30, table));
});

interface WasmConnection {
  query: (sql: string) => { toArray: () => unknown[] };
}

interface WasmDatabase {
  instantiate: (progress: () => void) => Promise<unknown>;
  connect: () => WasmConnection;
}

interface WasmModule {
  createDuckDB: (
    bundles: {
      mvp: { mainModule: string; mainWorker: string };
      eh: { mainModule: string; mainWorker: string };
    },
    logger: object,
    runtime: object,
  ) => Promise<WasmDatabase>;
  VoidLogger: new () => object;
  NODE_RUNTIME: object;
}

function isWasmModule(value: unknown): value is WasmModule {
  if (typeof value !== "object" || value === null) return false;
  if (!("createDuckDB" in value) || typeof value.createDuckDB !== "function") return false;
  if (!("VoidLogger" in value) || typeof value.VoidLogger !== "function") return false;
  return "NODE_RUNTIME" in value && typeof value.NODE_RUNTIME === "object" && value.NODE_RUNTIME !== null;
}

function wasmRow(row: unknown): Record<string, unknown> {
  const value = row !== null && typeof row === "object" && "toJSON" in row && typeof row.toJSON === "function" ? row.toJSON() : row;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("wasm row was not an object");
  return Object.fromEntries(Object.entries(value));
}

test("wasm reads the decimal-comma file and keeps the column comment", async () => {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  if (!isWasmModule(loaded)) throw new Error("duckdb-node-blocking.cjs loaded without createDuckDB");
  const dist = path.dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"));
  const database = await loaded.createDuckDB(
    {
      mvp: {
        mainModule: path.join(dist, "duckdb-mvp.wasm"),
        mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"),
      },
      eh: {
        mainModule: path.join(dist, "duckdb-eh.wasm"),
        mainWorker: path.join(dist, "duckdb-node-eh.worker.cjs"),
      },
    },
    new loaded.VoidLogger(),
    loaded.NODE_RUNTIME,
  );
  await database.instantiate(() => {});
  const connection = database.connect();
  const query: Query = async (sql) => connection.query(sql).toArray().map(wasmRow);
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "sales.csv");
  await writeFile(file, EURO_FILE);
  await query(`CREATE TABLE euro AS SELECT * FROM read_csv('${file}', delim=';', header=true)`);
  await convertFormattedNumbers(query, "euro");
  assert.equal(await columnType(query, "euro", "units"), "DOUBLE");
  assert.equal(await columnType(query, "euro", "net_sales"), "DOUBLE");
  const rows = await query(`SELECT period, sku, units, net_sales FROM euro ORDER BY rowid`);
  expectNumbers(rows.map((row) => row.units), [10, 4, 10, 4]);
  expectNumbers(rows.map((row) => row.net_sales), [1234.56, 12.5, 1500, 15]);
  const note = "2 columns were read as numbers written with a decimal comma.";
  assert.equal(await decimalCommaNote(query, "euro"), note);
  const comments = async () => {
    const found = await query(
      `SELECT column_name FROM duckdb_columns() WHERE schema_name = current_schema() AND table_name = 'euro' AND comment = 'decimal comma' ORDER BY column_name`,
    );
    return found.map((row) => row.column_name);
  };
  assert.deepEqual(await comments(), ["net_sales", "units"]);
  await convertFormattedNumbers(query, "euro");
  expectNumbers((await query(`SELECT units FROM euro ORDER BY rowid`)).map((row) => row.units), [10, 4, 10, 4]);
  expectNumbers((await query(`SELECT net_sales FROM euro ORDER BY rowid`)).map((row) => row.net_sales), [1234.56, 12.5, 1500, 15]);
  assert.equal(await decimalCommaNote(query, "euro"), note);
  assert.deepEqual(await comments(), ["net_sales", "units"]);
});

