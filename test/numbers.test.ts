import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { convertFormattedNumbers, decimalCommaNote, readsAsNumber } from "../src/app/numbers.ts";
import { isNumeric } from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import { runBridge, type Query } from "../src/engine.ts";
import { createSyntheticSales } from "../src/synth.ts";

// The browser build imports its worker URLs with `?url`, which node cannot
// resolve, so the load guard's module graph needs a stub for those specifiers.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

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
const CURRENCY = (column: string, example: string, read: string) =>
  `Numbers in ${column} such as ${example} were read with the currency sign or brackets removed, as ${read}.`;
const GROUPED = (column: string, example: string, read: string) =>
  `Numbers in ${column} such as ${example} were read with the comma between thousands, as ${read}.`;

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

function expectNumbers(actual: unknown[], expected: (number | null)[], label = ""): void {
  const where = label === "" ? "" : ` (${label})`;
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    const want = expected[index];
    if (want === null) {
      assert.equal(value, null, `null${where}`);
      return;
    }
    const got = typeof value === "bigint" ? Number(value) : value;
    assert.equal(typeof got, "number", `number${where}`);
    assert.ok(typeof got === "number" && Math.abs(got - want) < 1e-9, `${String(value)} is not ${want}${where}`);
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
  assert.equal(
    await decimalCommaNote(query, "spaced"),
    ONE + " " + CURRENCY("money", "$90.00", "90") + " " + GROUPED("thousands", "1,260", "1260"),
  );
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
  assert.equal(await decimalCommaNote(query, "us"), CURRENCY("amount", "$90.00", "90"));
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
  assert.equal(await decimalCommaNote(query, "alone"), GROUPED("amount", "1,234", "1234"));
  assert.equal(await decimalCommaNote(query, "grouped"), GROUPED("amount", "0,125", "125"));
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

test("a four-digit whole number beside a decimal comma stays text and is not named", async () => {
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
  assert.equal(await decimalCommaNote(query, "long"), null);
});

test("review two mixed US three-decimal columns stay text and are named", async () => {
  const query = await openDatabase();
  const cases: Record<string, [string, string]> = {
    grouped: ["1.234,567", "1,260.000"],
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

test("a plain three-decimal value beside three-decimal comma proof stays text and is not named", async () => {
  const query = await openDatabase();
  await createText(query, "plain_three", { amount: ["1.234,567", "1260.000"] });
  await convertFormattedNumbers(query, "plain_three");
  assert.equal(await columnType(query, "plain_three", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "plain_three", "amount"), ["1.234,567", "1260.000"]);
  assert.equal(await decimalCommaNote(query, "plain_three"), null);
});

test("a plain integer beside three-decimal comma proof stays text and is not named", async () => {
  const query = await openDatabase();
  await createText(query, "intproof", { amount: ["1500", "1.234,567"] });
  await convertFormattedNumbers(query, "intproof");
  assert.equal(await columnType(query, "intproof", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "intproof", "amount"), ["1500", "1.234,567"]);
  assert.equal(await decimalCommaNote(query, "intproof"), null);
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

type PairOutcome =
  | { type: "VARCHAR"; strings: [string, string]; note: string | null }
  | { type: "DOUBLE"; values: [number, number]; note: string | null };

const MIXED_STYLES = "amount mixes number styles, so it was read as text.";

function textPair(left: string, right: string, note: string | null): [string, string, PairOutcome] {
  return [left, right, { type: "VARCHAR", strings: [left, right], note }];
}

function numberPair(left: string, right: string, values: [number, number], note: string | null): [string, string, PairOutcome] {
  return [left, right, { type: "DOUBLE", values, note }];
}

test("mixed number-shape pairs are named only when both sides prove a style", async () => {
  const query = await openDatabase();
  const pairs: [left: string, right: string, expected: PairOutcome][] = [
    textPair("12.5", "1 234,567", MIXED_STYLES),
    textPair("12.5", "+1.234,567", MIXED_STYLES),
    textPair("12.5", "-1 234,567", MIXED_STYLES),
    textPair("12.5", "$1 234,567", MIXED_STYLES),
    textPair("12.5", "(1 234,567)", MIXED_STYLES),
    textPair("12.5", "-1.234,567", MIXED_STYLES),
    textPair("12.5", "$1.234,567", MIXED_STYLES),
    textPair("12.5", "(1.234,567)", MIXED_STYLES),
    textPair("1 500", "1 234,567", null),
    textPair("1,234", "1 234,567", null),
    textPair("1,260.00", "1 234,567", MIXED_STYLES),
    textPair("12.3456", "1.234,567", MIXED_STYLES),
    textPair("1,260.000", "1.234,567", MIXED_STYLES),
    textPair("1,260.00", "1.234,56", MIXED_STYLES),
    textPair("12.5", "1.234,56", MIXED_STYLES),
    textPair("$90.00", "12,50", MIXED_STYLES),
    textPair("12.5", "12,3456", MIXED_STYLES),
    textPair("1,260.000", "1.234,56", MIXED_STYLES),
    textPair("1,234.56", "1.234,567", MIXED_STYLES),
    textPair("1,260.00", "12,50", MIXED_STYLES),
    numberPair("1.234,567", "12,50", [1234.567, 12.5], ONE),
    numberPair("1.234,56", "12,50", [1234.56, 12.5], ONE),
    numberPair("12,3456", "12,50", [12.3456, 12.5], ONE),
    numberPair("0,125", "12,50", [0.125, 12.5], ONE),
    numberPair("1.234,567", "-1.234,567", [1234.567, -1234.567], ONE),
    numberPair("1.234,567", "1.234,56", [1234.567, 1234.56], ONE),
    numberPair("1.234,567", "0,125", [1234.567, 0.125], ONE),
    numberPair("12,5", "12,50", [12.5, 12.5], ONE),
    numberPair("1.234,567", "1.234,567", [1234.567, 1234.567], ONE),
    numberPair("12.5", "1,260.00", [12.5, 1260], GROUPED("amount", "1,260.00", "1260")),
    numberPair("1,234,567", "1,260.00", [1234567, 1260], GROUPED("amount", "1,234,567", "1234567")),
    numberPair("$90.00", "(1,260)", [90, -1260], CURRENCY("amount", "$90.00", "90")),
    numberPair("1 500", "1,260", [1500, 1260], GROUPED("amount", "1,260", "1260")),
    numberPair("12.3456", "$90.00", [12.3456, 90], CURRENCY("amount", "$90.00", "90")),
    numberPair("1,234", "1,260", [1234, 1260], GROUPED("amount", "1,234", "1234")),
    numberPair("1.234", "1,260", [1.234, 1260], GROUPED("amount", "1,260", "1260")),
    numberPair("1500", "$1,260", [1500, 1260], CURRENCY("amount", "$1,260", "1260")),
    numberPair("1 500", "$1,260", [1500, 1260], CURRENCY("amount", "$1,260", "1260")),
    numberPair("1,234", "1,260.00", [1234, 1260], GROUPED("amount", "1,234", "1234")),
    textPair("1,234", "12,50", null),
    textPair("1,234", "1.234,567", null),
    textPair("1 234,567", "-1 234,567", null),
    textPair("1 234,567", "+1.234,567", null),
    textPair("12,5", "1 234,567", null),
    textPair("(12,50)", "1.234,567", null),
    textPair("$12,50", "1 234,567", null),
    textPair("1.260e3", "1.234,567", null),
    textPair("1e3", "12,50", null),
    textPair("$90e2", "1.234,567", null),
    textPair("1.234", "2.500", null),
    textPair("1500", "1000", null),
    numberPair("1,234,567", "12.5", [1234567, 12.5], GROUPED("amount", "1,234,567", "1234567")),
    textPair("1.234,567", "(1 234,567)", null),
    textPair("1.234,56", "1 234,567", null),
  ];
  const failures: string[] = [];
  for (const [index, [left, right, expected]] of pairs.entries()) {
    const table = `proof_${index}`;
    const label = `${left} with ${right}`;
    try {
      await createText(query, table, { amount: [left, right] });
      await convertFormattedNumbers(query, table);
      assert.equal(await columnType(query, table, "amount"), expected.type, `${label} type`);
      if (expected.type === "VARCHAR") {
        assert.deepEqual(await columnValues(query, table, "amount"), expected.strings, `${label} strings`);
      } else {
        expectNumbers(await columnValues(query, table, "amount"), expected.values, label);
      }
      assert.equal(await decimalCommaNote(query, table), expected.note, `${label} note`);
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(pairs.some(([, , expected]) => expected.type === "VARCHAR" && expected.note === MIXED_STYLES));
  assert.ok(pairs.some(([, , expected]) => expected.type === "VARCHAR" && expected.note === null));
  assert.ok(pairs.some(([, , expected]) => expected.type === "DOUBLE" && expected.note === ONE));
  // Every converted pair here has a decimal-comma sentence or an example
  // naming its currency sign, brackets or thousands comma.
  assert.ok(pairs.every(([, , expected]) => expected.type !== "DOUBLE" || expected.note !== null));
});

test("text values, a malformed number and single decorated styles stay text and are not named", async () => {
  const query = await openDatabase();
  const controls = ["NA", "-", "n/a", "12,5%", "€ 12,50", "01.02.2025", "sku-12", "1,2,3"];
  for (const [index, control] of controls.entries()) {
    const table = `control_${index}`;
    await createText(query, table, { amount: [control, "1.234,56"] });
    await convertFormattedNumbers(query, table);
    assert.equal(await columnType(query, table, "amount"), "VARCHAR");
    assert.deepEqual(await columnValues(query, table, "amount"), [control, "1.234,56"]);
    assert.equal(await decimalCommaNote(query, table), null);
  }
  const decorated: Record<string, string[]> = {
    parens: ["(12,50)", "(1.234,56)"],
    space: ["1 234,56", "1 234,57"],
    dollar: ["$12,50", "$13,50"],
    plus: ["+12,50", "+13,50"],
    accounting_integer: ["(45)", "12,50"],
  };
  for (const [name, values] of Object.entries(decorated)) {
    const table = `decorated_${name}`;
    await createText(query, table, { amount: values });
    await convertFormattedNumbers(query, table);
    assert.equal(await columnType(query, table, "amount"), "VARCHAR");
    assert.deepEqual(await columnValues(query, table, "amount"), values);
    assert.equal(await decimalCommaNote(query, table), null);
  }
});

test("review three decorated decimal commas beside a US value stay text and are named", async () => {
  const query = await openDatabase();
  const partners = ["+12,50", "1 234,56", "$12,50", "(12,50)"];
  for (const [index, partner] of partners.entries()) {
    const table = `review_three_${index}`;
    await createText(query, table, { amount: ["1,260.00", partner] });
    await convertFormattedNumbers(query, table);
    assert.equal(await columnType(query, table, "amount"), "VARCHAR");
    assert.deepEqual(await columnValues(query, table, "amount"), ["1,260.00", partner]);
    assert.equal(await decimalCommaNote(query, table), "amount mixes number styles, so it was read as text.");
  }
});

test("lone 1 234,567 and +1.234,567 stay text; lone 1234,567 converts to 1234.567 and is named", async () => {
  const query = await openDatabase();
  await createText(query, "t292_alone_space", { amount: ["1 234,567"] });
  await convertFormattedNumbers(query, "t292_alone_space");
  assert.equal(await columnType(query, "t292_alone_space", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "t292_alone_space", "amount"), ["1 234,567"]);
  assert.equal(await decimalCommaNote(query, "t292_alone_space"), null);
  await createText(query, "t292_alone_plus", { amount: ["+1.234,567"] });
  await convertFormattedNumbers(query, "t292_alone_plus");
  assert.equal(await columnType(query, "t292_alone_plus", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "t292_alone_plus", "amount"), ["+1.234,567"]);
  assert.equal(await decimalCommaNote(query, "t292_alone_plus"), null);
  await createText(query, "t292_alone_plain", { amount: ["1234,567"] });
  await convertFormattedNumbers(query, "t292_alone_plain");
  assert.equal(await columnType(query, "t292_alone_plain", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "t292_alone_plain", "amount"), [1234.567]);
  assert.equal(await decimalCommaNote(query, "t292_alone_plain"), ONE);
});

test("review four consistent european columns stay text and are not named", async () => {
  const query = await openDatabase();
  const cases: Record<string, [string, string]> = {
    space_whole: ["1 500", "1 234,56"],
    dollar_whole: ["$1500", "$12,50"],
    parens_whole: ["(1500)", "(12,50)"],
    plus_whole: ["+1500", "+12,50"],
    plain_whole: ["1500", "1 234,56"],
    signed_whole: ["1500", "+12,50"],
  };
  for (const [name, values] of Object.entries(cases)) {
    const table = `review_four_${name}`;
    await createText(query, table, { amount: values });
    await convertFormattedNumbers(query, table);
    assert.equal(await columnType(query, table, "amount"), "VARCHAR");
    assert.deepEqual(await columnValues(query, table, "amount"), values);
    assert.equal(await decimalCommaNote(query, table), null);
  }
});

test("a semicolon file of one european style loads as text and is not named", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "european-whole.csv");
  await writeFile(
    file,
    "period;product;units;net_sales;gross_sales\n2024;A;10;1 500;100\n2024;A;10;1 234,56;200\n2025;A;10;1 500;110\n2025;A;10;1 234,56;210\n",
  );
  const query = await openDatabase();
  await query(`CREATE TABLE european_whole AS SELECT * FROM read_csv('${file}', delim=';', header=true, types={'gross_sales': 'DOUBLE'})`);
  await convertFormattedNumbers(query, "european_whole");
  assert.equal(await columnType(query, "european_whole", "net_sales"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "european_whole", "net_sales"), ["1 500", "1 234,56", "1 500", "1 234,56"]);
  assert.equal(await columnType(query, "european_whole", "gross_sales"), "DOUBLE");
  assert.equal(await decimalCommaNote(query, "european_whole"), null);
});

test("a semicolon file with a signed decimal comma beside a US value loads and names the conflict", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "signed-mixed.csv");
  await writeFile(
    file,
    "period;product;units;net_sales;gross_sales\n2024;A;10;1,260.00;100\n2024;A;10;+12,50;200\n2025;A;10;1,260.00;110\n2025;A;10;+12,50;210\n",
  );
  const query = await openDatabase();
  await query(`CREATE TABLE signed_mixed AS SELECT * FROM read_csv('${file}', delim=';', header=true, types={'gross_sales': 'DOUBLE'})`);
  await convertFormattedNumbers(query, "signed_mixed");
  assert.equal(await columnType(query, "signed_mixed", "net_sales"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "signed_mixed", "net_sales"), ["1,260.00", "+12,50", "1,260.00", "+12,50"]);
  assert.equal(await columnType(query, "signed_mixed", "gross_sales"), "DOUBLE");
  assert.equal(await decimalCommaNote(query, "signed_mixed"), "net_sales mixes number styles, so it was read as text.");
});

test("a decimal comma beside a north american decimal stays text", async () => {
  const query = await openDatabase();
  await createText(query, "mixed", { amount: ["1.234,56", "1,260.00"] });
  await convertFormattedNumbers(query, "mixed");
  assert.equal(await columnType(query, "mixed", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "mixed", "amount"), ["1.234,56", "1,260.00"]);
  assert.equal(await decimalCommaNote(query, "mixed"), "amount mixes number styles, so it was read as text.");
});

test("scientific notation beside a decimal comma stays text and is not named", async () => {
  const query = await openDatabase();
  await createText(query, "sci_three", { amount: ["1.234,567", "1.260e3"] });
  await convertFormattedNumbers(query, "sci_three");
  assert.equal(await columnType(query, "sci_three", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "sci_three", "amount"), ["1.234,567", "1.260e3"]);
  assert.equal(await decimalCommaNote(query, "sci_three"), null);
  await createText(query, "sci_plain", { amount: ["1.234,56", "1e3"] });
  await convertFormattedNumbers(query, "sci_plain");
  assert.equal(await columnType(query, "sci_plain", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "sci_plain", "amount"), ["1.234,56", "1e3"]);
  assert.equal(await decimalCommaNote(query, "sci_plain"), null);
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
  assert.equal(await decimalCommaNote(query, "parens"), CURRENCY("us", "(45)", "-45"));
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

test("a decimal-comma column beside an ambiguous value stays text, and only a proven mix is named", async () => {
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
  assert.equal(await decimalCommaNote(query, "styles"), null);

  await createText(query, "pair", {
    a: ["1.234,56", "1,260.00"],
    b: ["1.234,567", "1,234"],
  });
  await convertFormattedNumbers(query, "pair");
  assert.equal(await columnType(query, "pair", "a"), "VARCHAR");
  assert.equal(await columnType(query, "pair", "b"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "pair", "a"), ["1.234,56", "1,260.00"]);
  assert.deepEqual(await columnValues(query, "pair", "b"), ["1.234,567", "1,234"]);
  assert.equal(await decimalCommaNote(query, "pair"), "a mixes number styles, so it was read as text.");
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
  assert.equal(await decimalCommaNote(query, "late"), null);
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


test("money written with many dot groups and a decimal comma reads as numbers", async () => {
  const query = await openDatabase();
  await createText(query, "euro_groups", {
    euro: ["1.979.849,56", "12.345.678"],
    grouped: ["1,000.50", "1,234,567"],
    decorated: ["€600", "(520)"],
  });
  await convertFormattedNumbers(query, "euro_groups");
  assert.equal(await columnType(query, "euro_groups", "euro"), "DOUBLE");
  expectNumbers(await columnValues(query, "euro_groups", "euro"), [1979849.56, 12345678]);
  assert.equal(await columnType(query, "euro_groups", "grouped"), "DOUBLE");
  expectNumbers(await columnValues(query, "euro_groups", "grouped"), [1000.5, 1234567]);
  assert.equal(await columnType(query, "euro_groups", "decorated"), "DOUBLE");
  expectNumbers(await columnValues(query, "euro_groups", "decorated"), [600, -520]);
  assert.equal(
    await decimalCommaNote(query, "euro_groups"),
    ONE + " " + GROUPED("grouped", "1,000.50", "1000.5") + " " + CURRENCY("decorated", "€600", "600"),
  );
});

test("a column that mixes two money styles names the value and its row", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "styles.csv");
  const text = 'period,amount\n2025,"1,000.50"\n2026,"1.300,75"\n';
  await writeFile(file, text);
  const query = await openDatabase();
  await query(`CREATE TABLE styles AS SELECT * FROM read_csv(${sqlText(file)})`);
  await convertFormattedNumbers(query, "styles", { kind: "csv", file: new File([text], "styles.csv") });
  assert.equal(await columnType(query, "styles", "amount"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "styles", "amount"), ["1,000.50", "1.300,75"]);
  assert.equal(
    await decimalCommaNote(query, "styles"),
    "amount mixes number styles, such as 1.300,75 in row 3, so it was read as text.",
  );
});

test("NaN and Infinity cells do not read as numbers", async () => {
  const query = await openDatabase();
  await createText(query, "not_finite", { v: ["NaN", "Infinity", "-Infinity", "12.5", null] });
  const rows = await query(`SELECT v, ${readsAsNumber("v")} AS ok FROM not_finite ORDER BY rowid`);
  assert.deepEqual(
    rows.map((row) => row.ok),
    [false, false, false, true, false],
  );
});

const MIXED_SEPARATOR_SENTENCE = 'This file mixes ";" and "," as separators, so save it again with one separator.';

test("a file whose rows use two separators is named", async () => {
  const { mixedSeparatorSentence } = await import("../src/app/numbers.ts");
  const qaRows = Array.from({ length: 36 }, (_, index) =>
    index % 2 === 0 ? "2025;North;A-100;S;10;897" : "2025,North,A-100,S,10,897",
  );
  const qa = `PERIOD;REGION;MODEL;SIZE;UNITS;NET_SALES\n${qaRows.join("\n")}\n`;
  assert.equal(mixedSeparatorSentence(qa, ";"), MIXED_SEPARATOR_SENTENCE);
  const alternating = "period,product,units,sales\n2025,A-100,10,100\n2025;A-100;10;100\n2026,B-200,20,200\n2026;B-200;20;200\n";
  assert.equal(mixedSeparatorSentence(alternating, ","), MIXED_SEPARATOR_SENTENCE);
});

test("a file with one separator stays silent, including quoted marks and short rows", async () => {
  const { mixedSeparatorSentence } = await import("../src/app/numbers.ts");
  const decimalCommas = "period;product;units;sales\n2025;A-100;10;881,84\n2026;A-100;11;900,10\n";
  assert.equal(mixedSeparatorSentence(decimalCommas, ";"), null);
  const decimalQuantities = "period;units;sales\n2025;10,50;100,50\n2026;12,50;144,50\n2025;5,50;60,50\n2026;6,50;90,50\n";
  assert.equal(mixedSeparatorSentence(decimalQuantities, ";"), null);
  const decimalText = "period;product;units;sales\n2025;A,100;10,50;100,50\n2026;A,100;12,50;144,50\n2025;B,200;5,50;60,50\n2026;B,200;6,50;90,50\n";
  assert.equal(mixedSeparatorSentence(decimalText, ";"), null);
  const semicolonsInCell = "period,product,units,sales,note\n2025,A;B;C;D;E,10,100,north\n2026,F;G;H;I;J,12,120,south\n";
  assert.equal(mixedSeparatorSentence(semicolonsInCell, ","), null);
  const bothMarksInCells = "period,product;region;units,sales\n2025,A-100;North;10,1000\n2026,B-200;South;20,2000\n";
  assert.equal(mixedSeparatorSentence(bothMarksInCells, ","), null);
  const oneColumn = "note\na,b\nc;d\ne,f\ng;h\ni\n";
  assert.equal(mixedSeparatorSentence(oneColumn, ","), null);
  assert.equal(mixedSeparatorSentence(oneColumn, ";"), null);
  const lines = ["period,product,units,sales,note"];
  for (let index = 0; index < 4; index++) lines.push(`2025,A-100,${10 + index},${100 + index},"North\na;b;c;d;e\nSouth"`);
  assert.equal(mixedSeparatorSentence(`${lines.join("\n")}\n`, ","), null);
  const quoted = 'period,region,units\n2025,"North, East",10\n2026,"South, West",20\n';
  assert.equal(mixedSeparatorSentence(quoted, ","), null);
  const oneMark = 'period,note,units\n2025,"a;b",10\n2026,"c;d",20\n';
  assert.equal(mixedSeparatorSentence(oneMark, ","), null);
  const ragged = "period,region,units,sales\n2025,North,10,100\n2026,South,11\n2027,North,12,120\n";
  assert.equal(mixedSeparatorSentence(ragged, ","), null);
  const omittedTrailing = "period,product,units,sales\n2025,A-100,10,100\n2026,A-100,12,144\n2025,A;B;C;D\n2026,B-200,6,90\n";
  assert.equal(mixedSeparatorSentence(omittedTrailing, ","), null);
  const tabbed = "period\tregion\tunits\n2025\tNorth\t10\n2026\tSouth\t12\n";
  assert.equal(mixedSeparatorSentence(tabbed, "\t"), null);
  const tabbedMarks = "period\tproduct\tunits\n2025\tA,100; X\t10\n2026\tB,200; Y\t12\n";
  assert.equal(mixedSeparatorSentence(tabbedMarks, "\t"), null);
});

test("a punctuation short row loads while a foreign record stays refused", async () => {
  const { mixedSeparatorSentence } = await import("../src/app/numbers.ts");
  const header = "period,product,units,sales";
  const good = Array.from({ length: 100 }, (_, index) =>
    index % 2 === 0 ? "2025,A-100,10,100" : "2026,A-100,10,100",
  ).join("\n");
  const t435 = `${header}\n2025,A-100,10,100\n2026,A-100,12,144\n2025,A;B;C;D\n2026,B-200,6,90\n`;
  assert.equal(mixedSeparatorSentence(t435, ","), null);

  const foreign = "2026;A-100, large;100;10000";
  assert.equal(mixedSeparatorSentence(`${header}\n${foreign}\n${good}\n`, ","), MIXED_SEPARATOR_SENTENCE);
  assert.equal(
    mixedSeparatorSentence(`${header}\n${good}\n${foreign}\n2025,A-100,10,100\n2026,A-100,10,100\n`, ","),
    MIXED_SEPARATOR_SENTENCE,
  );

  const replaced = `${header}\n2025,A-100,10,100\n2026,A-100,12,144\n2025,X;Y;10;100\n2026,B-200,6,90\n`;
  assert.equal(mixedSeparatorSentence(replaced, ","), MIXED_SEPARATOR_SENTENCE);

  const twoShort = `${header}\n2025,A-100,10,100\n2026,A-100,12,144\n2025,A;B;C;D\n2026,A;B;C;D\n2026;N-300, large;20;200\n2026,B-200,6,90\n`;
  assert.equal(mixedSeparatorSentence(twoShort, ","), MIXED_SEPARATOR_SENTENCE);

  const quoted = '2026;"A-100, large";100;10000';
  assert.equal(mixedSeparatorSentence(`${header}\n${quoted}\n${good}\n`, ","), MIXED_SEPARATOR_SENTENCE);
  assert.equal(
    mixedSeparatorSentence(`${header}\n${good}\n${quoted}\n2025,A-100,10,100\n2026,A-100,10,100\n`, ","),
    MIXED_SEPARATOR_SENTENCE,
  );
  // The decider refuses the quoted record at every position. The real load
  // reads the strictly last one only because the sniff names the other
  // separator, so the guard test below pins that load.
  assert.equal(mixedSeparatorSentence(`${header}\n${good}\n${quoted}\n`, ","), MIXED_SEPARATOR_SENTENCE);
});

async function guardMixed(query: Query, text: string, name: string): Promise<{ file: File; filePath: string }> {
  const { refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const directory = await mkdtemp("/tmp/bridgekit-mixed-");
  const filePath = path.join(directory, name);
  await writeFile(filePath, text);
  const file = new File([text], name);
  await refuseMixedSeparators(query, file, await readCsvFile(file), filePath);
  return { file, filePath };
}

test("the real load keeps the punctuation short row and refuses a foreign record", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const query = await openDatabase();
  const header = "period,product,units,sales";
  const good = Array.from({ length: 100 }, (_, index) =>
    index % 2 === 0 ? "2025,A-100,10,100" : "2026,A-100,10,100",
  ).join("\n");
  const t435 = `${header}\n2025,A-100,10,100\n2026,A-100,12,144\n2025,A;B;C;D\n2026,B-200,6,90\n`;
  const loaded = await guardMixed(query, t435, "t435.csv");
  await stageCsvAndSwap(query, loaded.file, "data", loaded.filePath);
  const columns = (await query("DESCRIBE data")).map((row) => String(row.column_name));
  assert.deepEqual(columns, ["period", "product", "units", "sales"]);
  const rows = await query("SELECT * FROM data ORDER BY rowid");
  assert.equal(rows.length, 4);
  const [sums] = await query("SELECT sum(sales) AS s FROM data");
  assert.equal(Number(sums.s), 334);

  const refused = (error: unknown) => (error as Error).message === MIXED_SEPARATOR_SENTENCE;
  const foreign = "2026;A-100, large;100;10000";
  await assert.rejects(guardMixed(query, `${header}\n${foreign}\n${good}\n`, "foreign-top.csv"), refused);
  await assert.rejects(
    guardMixed(query, `${header}\n${good}\n${foreign}\n2025,A-100,10,100\n2026,A-100,10,100\n`, "foreign-after.csv"),
    refused,
  );
  const replaced = `${header}\n2025,A-100,10,100\n2026,A-100,12,144\n2025,X;Y;10;100\n2026,B-200,6,90\n`;
  await assert.rejects(guardMixed(query, replaced, "replaced.csv"), refused);
  const twoShort = `${header}\n2025,A-100,10,100\n2026,A-100,12,144\n2025,A;B;C;D\n2026,A;B;C;D\n2026;N-300, large;20;200\n2026,B-200,6,90\n`;
  await assert.rejects(guardMixed(query, twoShort, "two-short.csv"), refused);

  const quoted = '2026;"A-100, large";100;10000';
  await assert.rejects(guardMixed(query, `${header}\n${quoted}\n${good}\n`, "quoted-top.csv"), refused);
  await assert.rejects(
    guardMixed(query, `${header}\n${good}\n${quoted}\n2025,A-100,10,100\n2026,A-100,10,100\n`, "quoted-middle.csv"),
    refused,
  );
  const last = await guardMixed(query, `${header}\n${good}\n${quoted}\n`, "quoted-last.csv");
  await stageCsvAndSwap(query, last.file, "data", last.filePath);
  const [count] = await query("SELECT count(*)::DOUBLE AS n FROM data");
  assert.equal(Number(count.n), 102);
});

test("T439: leading blank lines keep the mixed-style row physical", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const text = '\n\nperiod,amount\n2025,"1,000.50"\n2026,"1.300,75"\n';
  const directory = await mkdtemp("/tmp/bridgekit-t439-");
  const filePath = path.join(directory, "blanks-mixed.csv");
  await writeFile(filePath, text);
  const query = await openDatabase();
  await stageCsvAndSwap(query, new File([text], "blanks-mixed.csv"), "data", filePath);
  assert.equal(
    await decimalCommaNote(query, "data"),
    "amount mixes number styles, such as 1.300,75 in row 5, so it was read as text.",
  );
});

test("T400: a quoted header name holding commas counts as one field", async () => {
  const { headerFieldCount } = await import("../src/app/numbers.ts");
  const name = `"${Array.from({ length: 10002 }, () => "a").join(",")}"`;
  const prefix = `${name},b,c,d\n1,2,3,4\n`;
  assert.equal(
    headerFieldCount(prefix, ",", { delimiter: ",", quote: '"', escape: '"', header: true, skipRows: 0, comment: "" }, false),
    4,
  );
});

test("T400: a correctly quoted wide header loads instead of refusing as too wide", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const name = `"${Array.from({ length: 10002 }, () => "a").join(",")}"`;
  const text = `${name},b,c,d\n1,2,3,4\n`;
  const directory = await mkdtemp("/tmp/bridgekit-t400-");
  const filePath = path.join(directory, "quoted-wide.csv");
  await writeFile(filePath, text);
  const query = await openDatabase();
  await stageCsvAndSwap(query, new File([text], "quoted-wide.csv"), "data", filePath);
  assert.equal((await query("DESCRIBE data")).length, 4);
  assert.equal(Number((await query("SELECT count(*)::DOUBLE AS n FROM data"))[0].n), 1);
});
