import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";
import { openDatabase } from "../src/duckdb.ts";
import type { Query } from "../src/engine.ts";
import * as format from "../src/app/format.ts";
import { roundBridge, shownTotal } from "../src/summary.ts";

const DECIMAL_COMMA = "1 column was read as numbers written with a decimal comma.";
const MIXED = "amount mixes number styles, so it was read as text.";

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
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "€1.234,50", "1234.5"),
  },
  {
    name: "a euro sign after the number reads as a decimal comma",
    values: ["1.234,50€"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "1.234,50€", "1234.5"),
  },
  {
    name: "a euro code before the number reads as a decimal comma",
    values: ["EUR1.234,50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "EUR1.234,50", "1234.5"),
  },
  {
    name: "a euro code after one space reads as a decimal comma",
    values: ["1 234,50 EUR"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "1 234,50 EUR", "1234.5"),
  },
  {
    name: "a swiss code with an apostrophe group reads as a north american number",
    values: ["CHF 1'234.50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: CURRENCY("amount", "CHF 1'234.50", "1234.5"),
  },
  {
    name: "a euro sign on a plain decimal comma reads as a decimal comma",
    values: ["€12,50"],
    type: "DOUBLE",
    numbers: [12.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "€12,50", "12.5"),
  },
  {
    name: "a dollar value keeps its north american reading",
    values: ["$1,234.50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: CURRENCY("amount", "$1,234.50", "1234.5"),
  },
  {
    name: "a euro sign before a north american number keeps the north american reading",
    values: ["€1,234.50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: CURRENCY("amount", "€1,234.50", "1234.5"),
  },
  {
    name: "an ascii space groups thousands inside a symbol value",
    values: ["€1 234,50"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "€1 234,50", "1234.5"),
  },
  {
    name: "a no-break space groups thousands",
    values: ["1\u00a0234,50 EUR"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "1\u00a0234,50 EUR", "1234.5"),
  },
  {
    name: "a narrow no-break space groups thousands",
    values: ["1\u202f234,50 EUR"],
    type: "DOUBLE",
    numbers: [1234.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "1\u202f234,50 EUR", "1234.5"),
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
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "1\u2019234,50 EUR", "1234.5"),
  },
  {
    name: "a trailing minus on a north american number keeps the sign",
    values: ["1,234.50-"],
    type: "DOUBLE",
    numbers: [-1234.5],
    note: GROUPED("amount", "1,234.50-", "-1234.5"),
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
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "(€1.234,50)", "-1234.5"),
  },
  {
    name: "parentheses around a symbol value beside a plain decimal comma convert both",
    values: ["(€1.234,50)", "12,50"],
    type: "DOUBLE",
    numbers: [-1234.5, 12.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "(€1.234,50)", "-1234.5"),
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
    note: CURRENCY("amount", "€1,234", "1234"),
  },
  {
    name: "a decorated decimal comma beside a four digit comma decimal converts both",
    values: ["€1.234,50", "12,3456"],
    type: "DOUBLE",
    numbers: [1234.5, 12.3456],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "€1.234,50", "1234.5"),
  },
  {
    name: "one currency beside an unmarked value converts both",
    values: ["€1.234,50", "12,50"],
    type: "DOUBLE",
    numbers: [1234.5, 12.5],
    note: DECIMAL_COMMA + " " + CURRENCY("amount", "€1.234,50", "1234.5"),
  },
  {
    name: "a currency code before a whole number converts it",
    values: ["EUR 1234"],
    type: "DOUBLE",
    numbers: [1234],
    note: CURRENCY("amount", "EUR 1234", "1234"),
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
  assert.equal(
    await decimalCommaNote(query, "data"),
    "2 columns were read as numbers written with a decimal comma. " + CURRENCY("net_sales", "€1.234,50", "1234.5"),
  );
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
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA + " " + CURRENCY("amount", "€1.234,50", "1234.5"));
});

test("a semicolon file keeps currency-like product codes as distinct text", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-formats-");
  const file = path.join(directory, "codes.csv");
  await writeFile(file, "period;sku;units;sales\n2025;USD0012;1;10\n2025;USD12;2;200\n2026;USD0012;2;22\n2026;USD12;1;90\n");
  const query = await openDatabase();
  await query(`CREATE TABLE data AS SELECT * FROM read_csv(${sqlText(file)}, delim=';', header=true)`);
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "sku"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "data", "sku"), ["USD0012", "USD12", "USD0012", "USD12"]);
  const [distinct] = await query("SELECT count(DISTINCT sku) AS n FROM data");
  assert.equal(Number(distinct.n), 2);
  assert.equal(await decimalCommaNote(query, "data"), null);
});

test("a semicolon file keeps a currency code glued to a plain integer as text", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-formats-");
  const file = path.join(directory, "codes.csv");
  await writeFile(file, "period;sku\n2025;TRY12\n2025;TRY0012\n");
  const query = await openDatabase();
  await query(`CREATE TABLE data AS SELECT * FROM read_csv(${sqlText(file)}, delim=';', header=true)`);
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "sku"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "data", "sku"), ["TRY12", "TRY0012"]);
  const [distinct] = await query("SELECT count(DISTINCT sku) AS n FROM data");
  assert.equal(Number(distinct.n), 2);
  assert.equal(await decimalCommaNote(query, "data"), null);
});

test("a euro sign and a euro code in one column convert together", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["€1.234,50", "1.250,50 EUR"] });
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "amount"), [1234.5, 1250.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA + " " + CURRENCY("amount", "€1.234,50", "1234.5"));
});

test("currencies outside the old short list convert beside a three letter word control", async () => {
  const query = await openDatabase();
  await createText(query, "data", { sar: ["SAR 1234.50"], twd: ["TWD 1234.50"], word: ["ABC 12"] });
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "sar"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "sar"), [1234.5]);
  assert.equal(await columnType(query, "data", "twd"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "twd"), [1234.5]);
  assert.equal(await columnType(query, "data", "word"), "VARCHAR");
  assert.deepEqual(await columnValues(query, "data", "word"), ["ABC 12"]);
  assert.equal(
    await decimalCommaNote(query, "data"),
    CURRENCY("sar", "SAR 1234.50", "1234.5") + " " + CURRENCY("twd", "TWD 1234.50", "1234.5"),
  );
});

test("a currency marker after row two thousand still reaches the money path", async () => {
  const query = await openDatabase();
  const amount = Array.from({ length: 2001 }, (_, row) => (row === 2000 ? "SAR 1.234,50" : "1.234,50"));
  await createText(query, "data", { amount });
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "amount"), "DOUBLE");
  expectNumbers(
    await columnValues(query, "data", "amount"),
    Array.from({ length: 2001 }, () => 1234.5),
  );
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA + " " + CURRENCY("amount", "SAR 1.234,50", "1234.5"));
});

test("a bare no-break space groups thousands without a currency", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["1\u00a0234,50"] });
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "amount"), [1234.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA);
});

test("a bare narrow no-break space groups thousands without a currency", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["1\u202f234,50"] });
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "amount"), [1234.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA);
});

test("a bare ascii apostrophe groups thousands on a decimal comma", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["1'234,50"] });
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "amount"), [1234.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA);
});

test("a bare right single quote groups thousands on a decimal comma", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["1\u2019234,50"] });
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "amount"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "amount"), [1234.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA);
});

function refusing(query: Query, refusals: [RegExp, Error][]): Query {
  return async (sql) => {
    const refusal = refusals.find(([pattern]) => pattern.test(sql));
    if (refusal) throw refusal[1];
    return query(sql);
  };
}

function tableChanges(statements: string[]): string[] {
  return statements.filter((sql) => /\b(ADD COLUMN|ALTER|UPDATE|COMMENT|DROP)\b/i.test(sql));
}

test("an index on the money column leaves it as text with no internal column", async () => {
  const query = await openDatabase();
  await query("CREATE TABLE data AS SELECT '€1.234,50' amount");
  await query("CREATE INDEX amount_index ON data(amount)");
  const indexes = "SELECT index_name, sql FROM duckdb_indexes() WHERE table_name = 'data'";
  const before = await query(indexes);
  const issued: string[] = [];
  await convertFormattedNumbers(async (sql) => {
    issued.push(sql);
    return query(sql);
  }, "data");
  assert.deepEqual((await query("DESCRIBE data")).map((row) => [row.column_name, row.column_type]), [["amount", "VARCHAR"]]);
  assert.deepEqual(await columnValues(query, "data", "amount"), ["€1.234,50"]);
  assert.equal(await decimalCommaNote(query, "data"), null);
  assert.deepEqual(await query(indexes), before);
  assert.deepEqual(tableChanges(issued), []);
});

test("an index on another column leaves every money column as text", async () => {
  const query = await openDatabase();
  await query("CREATE TABLE data (id VARCHAR, amount VARCHAR, net VARCHAR)");
  await query("CREATE INDEX id_index ON data(id)");
  await query("INSERT INTO data VALUES ('a', '€1.234,50', '1.234,50')");
  const issued: string[] = [];
  await convertFormattedNumbers(async (sql) => {
    issued.push(sql);
    return query(sql);
  }, "data");
  assert.deepEqual(
    (await query("DESCRIBE data")).map((row) => [row.column_name, row.column_type]),
    [["id", "VARCHAR"], ["amount", "VARCHAR"], ["net", "VARCHAR"]],
  );
  assert.deepEqual(await columnValues(query, "data", "amount"), ["€1.234,50"]);
  assert.deepEqual(await columnValues(query, "data", "net"), ["1.234,50"]);
  assert.equal(await decimalCommaNote(query, "data"), null);
  assert.deepEqual(tableChanges(issued), []);
});

test("a unique money column stays text beside a peer that converts", async () => {
  const query = await openDatabase();
  await query("CREATE TABLE data (amount VARCHAR UNIQUE, net VARCHAR)");
  await query("INSERT INTO data VALUES ('€1.234,50', '€1.250,50')");
  await convertFormattedNumbers(query, "data");
  assert.deepEqual(
    (await query("DESCRIBE data")).map((row) => [row.column_name, row.column_type]),
    [["amount", "VARCHAR"], ["net", "DOUBLE"]],
  );
  assert.deepEqual(await columnValues(query, "data", "amount"), ["€1.234,50"]);
  expectNumbers(await columnValues(query, "data", "net"), [1250.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA + " " + CURRENCY("net", "€1.250,50", "1250.5"));
});

test("a not null money column still converts", async () => {
  const query = await openDatabase();
  await query("CREATE TABLE data (amount VARCHAR NOT NULL)");
  await query("INSERT INTO data VALUES ('€1.234,50')");
  await convertFormattedNumbers(query, "data");
  assert.deepEqual((await query("DESCRIBE data")).map((row) => [row.column_name, row.column_type]), [["amount", "DOUBLE"]]);
  expectNumbers(await columnValues(query, "data", "amount"), [1234.5]);
  assert.equal(await decimalCommaNote(query, "data"), DECIMAL_COMMA + " " + CURRENCY("amount", "€1.234,50", "1234.5"));
});

test("a failed conversion drops the internal column and rethrows its own error", async () => {
  for (const step of [/^UPDATE /, /^ALTER TABLE \S+ ALTER /, /^COMMENT ON /]) {
    const query = await openDatabase();
    await createText(query, "data", { amount: ["€1.234,50"] });
    const refused = new Error("refused");
    await assert.rejects(convertFormattedNumbers(refusing(query, [[step, refused]]), "data"), (error) => error === refused);
    const names = (await query("DESCRIBE data")).map((row) => String(row.column_name));
    assert.deepEqual(names.filter((name) => name.startsWith("__money_")), []);
  }
});

test("a refused drop after a failed step still rethrows the step's error", async () => {
  const query = await openDatabase();
  await createText(query, "data", { amount: ["€1.234,50"] });
  const refused = new Error("refused");
  const dropRefused = new Error("drop refused");
  await assert.rejects(
    convertFormattedNumbers(refusing(query, [[/^ALTER TABLE \S+ ALTER /, refused], [/ DROP COLUMN /, dropRefused]]), "data"),
    (error) => error === refused,
  );
});

test("R7: a currency sign, brackets and a thousands comma are each named", async () => {
  const query = await openDatabase();
  await createText(query, "data", { euro: ["€600"], dollar: ["$600"], bracket: ["(520)"], grouped: ["1,000.50"] });
  await convertFormattedNumbers(query, "data");
  expectNumbers(await columnValues(query, "data", "euro"), [600]);
  expectNumbers(await columnValues(query, "data", "dollar"), [600]);
  expectNumbers(await columnValues(query, "data", "bracket"), [-520]);
  expectNumbers(await columnValues(query, "data", "grouped"), [1000.5]);
  assert.equal(
    await decimalCommaNote(query, "data"),
    CURRENCY("euro", "€600", "600") +
      " " +
      CURRENCY("dollar", "$600", "600") +
      " " +
      CURRENCY("bracket", "(520)", "-520") +
      " " +
      GROUPED("grouped", "1,000.50", "1000.5"),
  );
});

test("R7: a quoted thousands comma in a comma file reads as 1000.5", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-formats-");
  const file = path.join(directory, "quoted.csv");
  await writeFile(file, 'period,units,sales\n2025,2,"1,000.50"\n2026,3,"1,200.50"\n');
  const query = await openDatabase();
  await query(`CREATE TABLE data AS SELECT * FROM read_csv(${sqlText(file)}, header=true)`);
  await convertFormattedNumbers(query, "data");
  assert.equal(await columnType(query, "data", "sales"), "DOUBLE");
  expectNumbers(await columnValues(query, "data", "sales"), [1000.5, 1200.5]);
  assert.equal(await decimalCommaNote(query, "data"), GROUPED("sales", "1,000.50", "1000.5"));
});

test("R33: no formatter prints a huge number in exponent notation", () => {
  const { compact, percent, price, signedCompact, signedPercent, signedWhole, whole } = format;
  assert.equal(percent(2e29 / 100), ">1,000,000%");
  assert.equal(signedPercent(-2e29 / 100), "<-1,000,000%");
  assert.equal(compact(1e30), "1,000,000T+");
  assert.equal(signedCompact(-1e30), "-1,000,000T+");
  assert.equal(signedCompact(1e30), "+1,000,000T+");
  assert.equal(price(2e29), "200,000,000,000,000,000,000,000,000,000.00");
  // The ordinary cases the app formats today keep their text.
  assert.equal(price(1234.5), "1,234.50");
  assert.equal(whole(-284), "-284");
  assert.equal(signedWhole(-284), "-284");
  assert.equal(percent(0.5), "50.0%");
  assert.equal(signedPercent(0.5), "+50.0%");
  for (const text of [
    compact(1e30),
    signedCompact(-1e30),
    price(2e29),
    percent(2e29 / 100),
    signedPercent(-2e29 / 100),
    whole(1e30),
    signedWhole(-1e30),
  ]) {
    assert.equal(/[eE]/.test(text), false, text);
  }
});

test("R33: the percentage cap says greater than only past the boundary", () => {
  const { percent, signedPercent } = format;
  assert.equal(percent(10000), "1000000.0%");
  assert.equal(signedPercent(10000), "+1000000.0%");
  assert.equal(percent(-10000), "-1000000.0%");
  assert.equal(percent(10000.1), ">1,000,000%");
  assert.equal(signedPercent(-10000.1), "<-1,000,000%");
  assert.equal(percent(9999.9), "999990.0%");
});

/** Runs the rule's two invariants on every case below and returns the rounded bridge. */
function assertBridge(prior: number, current: number, exact: readonly number[], unit = 1) {
  const shown = roundBridge(prior, current, exact, unit);
  const lines = shown.values.reduce((sum, value) => sum + value, 0);
  assert.equal(shown.prior + lines, shown.current, `prior ${shown.prior} plus the lines ${lines} is not current ${shown.current}`);
  shown.values.forEach((value, index) => {
    assert.ok(
      Math.abs(value - exact[index]) <= unit,
      `line ${index} rounded to ${value}, more than one unit from the exact ${exact[index]}`,
    );
  });
  return shown;
}

test("R141: five equal small effects hand the one unit to the first line", () => {
  const shown = assertBridge(0, 1, [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.deepEqual(shown.values, [1, 0, 0, 0, 0]);
});

test("R141: a single negative effect takes the unit back to the total", () => {
  const shown = assertBridge(100.4, 99.6, [-0.8]);
  assert.equal(shown.prior, 100);
  assert.equal(shown.current, 100);
  assert.deepEqual(shown.values, [0]);
});

test("R141: mixed positive and negative effects still add up", () => {
  const shown = assertBridge(100, 100, [0.5, -0.5]);
  assert.deepEqual(shown.values, [1, -1]);
});

test("R141: a total that rounds the other way still foots", () => {
  const shown = assertBridge(100.5, 100.5, [-0.4, 0.4]);
  assert.equal(shown.prior, 101);
  assert.equal(shown.current, 101);
  assert.deepEqual(shown.values, [0, 0]);
});

test("R141: a half line takes the leftover unit and an integer line stays put", () => {
  const shown = assertBridge(0, 2, [0.5, 1, 0.5]);
  assert.deepEqual(shown.values, [1, 1, 0]);
});

test("R141: the budget sample's lines foot to its shown totals", () => {
  // The budget sample's own five effects, to four decimals.
  const exact = [610.7051, 474.9887, 413.7554, 443.5355, -557.2147];
  assert.notEqual(
    exact.reduce((sum, value) => sum + Math.round(value), 0),
    52142 - 50756,
    "the sample no longer shows the defect: rounding each line on its own misses the shown change",
  );
  const shown = assertBridge(50756.38, 52142.15, exact);
  assert.equal(shown.prior, 50756);
  assert.equal(shown.current, 52142);
  assert.deepEqual(shown.values, [611, 475, 414, 443, -557]);
});

test("shownTotal adds only the shown lines whose key starts with the prefix", () => {
  const effects = [
    { key: "volume" },
    { key: "price_list" },
    { key: "price_discount" },
    { key: "price" },
    { key: "mix_1" },
    { key: "mix_2" },
  ];
  const shown = { prior: 0, current: 0, values: [10, 2, -1, 4, 5, -3] };
  assert.equal(shownTotal(shown, effects, "price"), 5, "the price lines did not add up to their one KPI figure");
  assert.equal(shownTotal(shown, effects, "mix_"), 2, "the mix lines did not add up to their one figure");
  assert.equal(shownTotal(shown, effects, "cost"), 0, "a prefix with no lines did not add up to zero");
});
