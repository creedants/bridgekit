import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: "data:text/javascript,export default \"stub\"", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { TOO_BIG_SENTENCE, isOutOfMemory, loadFailure } = await import("../src/app/db.ts");

const TOO_BIG = "This file is too big to open in this browser. Try a smaller file, or save it with fewer rows or columns.";
const OUT_OF_MEMORY = "Out of Memory Error: Allocation failure";

test("the too-big sentence is the approved wording", () => {
  assert.equal(TOO_BIG_SENTENCE, TOO_BIG);
});

test("DuckDB's out-of-memory exception is recognised", () => {
  assert.equal(isOutOfMemory(new Error(OUT_OF_MEMORY)), true);
});

test("ordinary load errors are not out-of-memory failures", () => {
  assert.equal(isOutOfMemory(new Error("Invalid Input Error: CSV Error on Line: 2")), false);
  assert.equal(isOutOfMemory(new Error("This file's text encoding could not be read. Save it as CSV UTF-8.")), false);
});

test("an ordinary error that quotes the text is not an out-of-memory failure", () => {
  const quoted = new Error('Conversion Error: Could not convert string "Out of Memory Error" to INT32');
  assert.equal(isOutOfMemory(quoted), false);
});

test("an out-of-memory load shows only the too-big sentence", () => {
  const failure = loadFailure(new Error(OUT_OF_MEMORY));
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, TOO_BIG);
});

test("an ordinary load error is returned unchanged", () => {
  const original = new Error("Invalid Input Error: CSV Error on Line: 2");
  assert.equal(loadFailure(original), original);
});

test("R16: a first load into an empty database raises no error and keeps the staged table", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { swapLoadedTable } = await import("../src/app/db.ts");
  const query = await openDatabase();
  const statements: string[] = [];
  const errors: string[] = [];
  const recording = async (sql: string) => {
    statements.push(sql);
    try {
      return await query(sql);
    } catch (error) {
      errors.push((error as Error).message);
      throw error;
    }
  };
  await recording(`CREATE TABLE data__staging AS SELECT * FROM (VALUES ('2025', 1), ('2026', 2)) v(period, units)`);
  await swapLoadedTable(recording, "data__staging", "data");
  assert.deepEqual(errors, []);
  assert.equal(
    statements.some((sql) => sql.includes(`RENAME TO "data__previous"`)),
    false,
  );
  const [row] = await recording(`SELECT count(*)::DOUBLE AS n FROM data`);
  assert.equal(Number(row.n), 2);

  await recording(`CREATE TABLE data__staging AS SELECT 3 AS units`);
  await swapLoadedTable(recording, "data__staging", "data");
  assert.deepEqual(errors, []);
  assert.equal(statements.filter((sql) => sql.includes(`RENAME TO "data__previous"`)).length, 1);
  const [replaced] = await recording(`SELECT count(*)::DOUBLE AS n FROM data`);
  assert.equal(Number(replaced.n), 1);
});

test("R35: a header with twelve thousand fields is refused as too many columns", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { TOO_MANY_COLUMNS_SENTENCE } = await import("../src/app/numbers.ts");
  const header = Array.from({ length: 12_000 }, () => "a").join(",");
  const row = Array.from({ length: 12_000 }, () => "1").join(",");
  const text = `${header}\n${row}\n`;
  const directory = await mkdtemp("/tmp/bridgekit-load-errors-");
  const file = path.join(directory, "wide.csv");
  await writeFile(file, text);
  const query = await openDatabase();
  await assert.rejects(
    stageCsvAndSwap(query, new File([text], "wide.csv"), "data", file),
    (error: unknown) => (error as Error).message === TOO_MANY_COLUMNS_SENTENCE,
    TOO_MANY_COLUMNS_SENTENCE,
  );
  assert.equal(
    TOO_MANY_COLUMNS_SENTENCE,
    "This file has too many columns to open in this browser. Save it with fewer columns.",
  );
});

test("R35: a seven-column file loads and an out-of-memory failure still gives the size sentence", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const text = "product,region,size,colour,year,units,sales\nA-100,North,S,red,2025,10,120\nA-100,North,S,red,2026,11,132\n";
  const directory = await mkdtemp("/tmp/bridgekit-load-errors-");
  const file = path.join(directory, "seven.csv");
  await writeFile(file, text);
  const query = await openDatabase();
  await stageCsvAndSwap(query, new File([text], "seven.csv"), "data", file);
  assert.equal((await query(`DESCRIBE data`)).length, 7);
  assert.equal(Number((await query(`SELECT count(*)::DOUBLE AS n FROM data`))[0].n), 2);
  assert.equal(loadFailure(new Error(OUT_OF_MEMORY)).message, TOO_BIG);
});

test("R35: a header longer than the read prefix with few fields is not refused as too wide", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { TOO_MANY_COLUMNS_SENTENCE } = await import("../src/app/numbers.ts");
  // 200 names of 400 characters are about 80 KB, past the 65,536-byte prefix,
  // and still far under the 10,000-field limit.
  const header = Array.from({ length: 200 }, (_, i) => `c${i}`.padEnd(400, "x")).join(",");
  const row = Array.from({ length: 200 }, () => "1").join(",");
  const text = `${header}\n${row}\n`;
  const directory = await mkdtemp("/tmp/bridgekit-load-errors-");
  const file = path.join(directory, "long-header.csv");
  await writeFile(file, text);
  const query = await openDatabase();
  await stageCsvAndSwap(query, new File([text], "long-header.csv"), "data", file);
  assert.equal((await query(`DESCRIBE data`)).length, 200);
  assert.ok(!text.includes(TOO_MANY_COLUMNS_SENTENCE));
});

test("R9: a NaN column loads as text and the rest of the table loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const text = "period,units,sales,note\n2025,2,NaN,a\n2026,3,Infinity,b\n2027,4,-Infinity,c\n2028,5,12.5,d\n";
  const directory = await mkdtemp("/tmp/bridgekit-load-errors-");
  const file = path.join(directory, "nan.csv");
  await writeFile(file, text);
  const query = await openDatabase();
  await stageCsvAndSwap(query, new File([text], "nan.csv"), "data", file);
  const described = await query("DESCRIBE data");
  assert.equal(String(described.find((row) => String(row.column_name) === "sales")?.column_type), "VARCHAR");
  assert.deepEqual(
    described.map((row) => String(row.column_name)),
    ["period", "units", "sales", "note"],
  );
  const rows = await query("SELECT period, units, sales FROM data ORDER BY period");
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => [Number(row.period), Number(row.units), String(row.sales)]),
    [
      [2025, 2, "NaN"],
      [2026, 3, "Infinity"],
      [2027, 4, "-Infinity"],
      [2028, 5, "12.5"],
    ],
  );
});

const MIXED_SEPARATORS = 'This file mixes ";" and "," as separators, so save it again with one separator.';

async function written(text: string, name: string): Promise<{ file: File; path: string }> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const directory = await mkdtemp("/tmp/bridgekit-load-errors-");
  const filePath = path.join(directory, name);
  await writeFile(filePath, text);
  return { file: new File([text], name), path: filePath };
}

test("a semicolon file of decimal-comma quantities loads four rows without a refusal", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const text = "period;units;sales\n2025;10,50;100,50\n2026;12,50;144,50\n2025;5,50;60,50\n2026;6,50;90,50\n";
  const { file, path } = await written(text, "decimal-comma.csv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const types = Object.fromEntries((await query("DESCRIBE data")).map((row) => [String(row.column_name), String(row.column_type)]));
  assert.equal(types.units, "DOUBLE");
  assert.equal(types.sales, "DOUBLE");
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(units) AS u, sum(sales) AS s FROM data");
  assert.equal(Number(sums.n), 4);
  assert.equal(Number(sums.u), 35);
  assert.equal(Number(sums.s), 396);
});

test("a comma file with a quoted multiline note loads four records without a refusal", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const lines = ["period,product,units,sales,note"];
  for (const [year, product, units, sales] of [
    [2025, "A-100", 10, 100],
    [2026, "A-100", 12, 94],
    [2025, "B-200", 5, 100],
    [2026, "B-200", 6, 100],
  ] as const) {
    lines.push(`${year},${product},${units},${sales},"North\na;b;c;d;e\nSouth"`);
  }
  const text = `${lines.join("\n")}\n`;
  const { file, path } = await written(text, "multiline-note.csv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(sales) AS s FROM data");
  assert.equal(Number(sums.n), 4);
  assert.equal(Number(sums.s), 394);
});

test("a file whose rows alternate separators is still refused with the one sentence", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const rows = Array.from({ length: 36 }, (_, index) =>
    index % 2 === 0 ? "2025;North;A-100;S;10;897" : "2025,North,A-100,S,10,897",
  );
  const text = `PERIOD;REGION;MODEL;SIZE;UNITS;NET_SALES\n${rows.join("\n")}\n`;
  const { file, path } = await written(text, "mixed.csv");
  const query = await openDatabase();
  assert.equal(MIXED_SEPARATORS, 'This file mixes ";" and "," as separators, so save it again with one separator.');
  await assert.rejects(
    refuseMixedSeparators(query, file, await readCsvFile(file), path),
    (error: unknown) => (error as Error).message === MIXED_SEPARATORS,
  );
});

test("a headered file names the mixed-style value's file row", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  const text = 'period,amount\n2025,"1,000.50"\n2026,"1.300,75"\n';
  const { file, path } = await written(text, "headered.csv");
  const query = await openDatabase();
  await stageCsvAndSwap(query, file, "data", path);
  assert.equal(
    await decimalCommaNote(query, "data"),
    "amount mixes number styles, such as 1.300,75 in row 3, so it was read as text.",
  );
});

test("a headerless file with a trailing blank line names the value's own row", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  const text = '2025,A-100,10,"1,000.50"\n2026,A-100,12,"1.300,75"\n\n';
  const { file, path } = await written(text, "headerless-blank.csv");
  const query = await openDatabase();
  await stageCsvAndSwap(query, file, "data", path);
  assert.equal(
    await decimalCommaNote(query, "data"),
    "column3 mixes number styles, such as 1.300,75 in row 2, so it was read as text.",
  );
});

test("a headered file with no final newline still names its row", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  const text = 'period,amount\n2025,"1,000.50"\n2026,"1.300,75"';
  const { file, path } = await written(text, "no-final-newline.csv");
  const query = await openDatabase();
  await stageCsvAndSwap(query, file, "data", path);
  assert.equal(
    await decimalCommaNote(query, "data"),
    "amount mixes number styles, such as 1.300,75 in row 3, so it was read as text.",
  );
});

test("two leading blank lines keep the data record's row in the file", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  const text = '\n\n2025,A-100,"1,000.50"\n2026,A-100,"1.300,75"\n';
  const { file, path } = await written(text, "leading-blanks.csv");
  const query = await openDatabase();
  await stageCsvAndSwap(query, file, "data", path);
  assert.equal(
    await decimalCommaNote(query, "data"),
    "column2 mixes number styles, such as 1.300,75 in row 4, so it was read as text.",
  );
});

test("a row the table cannot prove falls back to the sentence with no example", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { decimalCommaNote } = await import("../src/app/numbers.ts");
  const text = 'period,amount\n2025,"1,000.50"\n2026,"1.300,75"\n';
  const { file, path } = await written(text, "unproved.csv");
  const real = await openDatabase();
  const query: typeof real = async (sql) =>
    sql === 'SELECT count(*)::DOUBLE AS n FROM "data__staging"' ? [{ n: 99 }] : real(sql);
  await stageCsvAndSwap(query, file, "data", path);
  assert.equal(await decimalCommaNote(query, "data"), "amount mixes number styles, so it was read as text.");
});

test("a flagged non-finite column becomes text when the raw reread cannot line up", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const text = "period,units,sales,note\n2025,2,NaN,a\n2026,3,Infinity,b\n2027,4,-Infinity,c\n2028,5,12.5,d\n";
  const { file, path } = await written(text, "nan-mismatch.csv");
  const real = await openDatabase();
  const query: typeof real = async (sql) =>
    sql.startsWith("SELECT count(*)::DOUBLE AS n FROM read_csv(") && sql.includes("all_varchar=true")
      ? [{ n: 999 }]
      : real(sql);
  await stageCsvAndSwap(query, file, "data", path);
  const described = await query("DESCRIBE data");
  assert.equal(String(described.find((row) => String(row.column_name) === "sales")?.column_type), "VARCHAR");
  const rows = await query("SELECT sales FROM data ORDER BY period");
  assert.deepEqual(
    rows.map((row) => row.sales),
    ["nan", "inf", "-inf", "12.5"],
  );
  assert.ok(rows.every((row) => typeof row.sales === "string"));
});

test("a semicolon file with commas in product text and decimal-comma numbers loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const text =
    "period;product;units;sales\n2025;A,100;10,50;100,50\n2026;A,100;12,50;144,50\n2025;B,200;5,50;60,50\n2026;B,200;6,50;90,50\n";
  const { file, path } = await written(text, "decimal-text.csv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const types = Object.fromEntries((await query("DESCRIBE data")).map((row) => [String(row.column_name), String(row.column_type)]));
  assert.equal(types.product, "VARCHAR");
  assert.equal(types.units, "DOUBLE");
  assert.equal(types.sales, "DOUBLE");
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(units) AS u, sum(sales) AS s FROM data");
  assert.equal(Number(sums.n), 4);
  assert.equal(Number(sums.u), 35);
  assert.equal(Number(sums.s), 396);
});

test("a comma file with four semicolons inside one text cell loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const lines = ["period,product,units,sales,note"];
  for (const [year, product, units, sales] of [
    [2025, "A;B;C;D;E", 10, 100],
    [2026, "F;G;H;I;J", 12, 120],
    [2025, "K;L;M;N;O", 5, 50],
    [2026, "P;Q;R;S;T", 6, 60],
  ] as const) {
    lines.push(`${year},${product},${units},${sales},north`);
  }
  const text = `${lines.join("\n")}\n`;
  const { file, path } = await written(text, "semicolons-in-cell.csv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(sales) AS s FROM data");
  assert.equal(Number(sums.n), 4);
  assert.equal(Number(sums.s), 330);
  const rows = await query("SELECT product FROM data ORDER BY product");
  assert.deepEqual(
    rows.map((row) => String(row.product)),
    ["A;B;C;D;E", "F;G;H;I;J", "K;L;M;N;O", "P;Q;R;S;T"],
  );
});

test("a tab file holding both marks loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const lines = ["period\tprice, eur\tunits", "2025\tsmall; red\t10", "2026\tbig; blue\t12", "2025\ttiny; green\t5"];
  const text = `${lines.join("\n")}\n`;
  const { file, path } = await written(text, "tabbed-marks.tsv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(units) AS u FROM data");
  assert.equal(Number(sums.n), 3);
  assert.equal(Number(sums.u), 27);
});

test("a large tab file holding both marks loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const lines = ["period\tprice, eur\tunits"];
  for (let index = 0; index < 4000; index++) lines.push(`2025\tsmall; red\t${(index % 5) + 1}`);
  const text = `${lines.join("\n")}\n`;
  assert.ok(text.length > 65536);
  const { file, path } = await written(text, "tabbed-large.tsv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(units) AS u FROM data");
  assert.equal(Number(sums.n), 4000);
  assert.equal(Number(sums.u), 12000);
});

test("a tab file with a short row loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const text = "period\tprice, eur\tunits\n2025\tsmall; red\t10\n2026\tbig; blue\t\n2025\ttiny; green\t5\n";
  const { file, path } = await written(text, "tabbed-short.tsv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(units) AS u FROM data");
  assert.equal(Number(sums.n), 3);
  assert.equal(Number(sums.u), 15);
});

test("a one-column file holding both marks loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const text = 'note\n"a,b;c"\n"d;e,f"\nplain\n"2026,01;x"\n';
  const { file, path } = await written(text, "one-column.csv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const rows = await query("SELECT note FROM data ORDER BY rowid");
  assert.deepEqual(
    rows.map((row) => String(row.note)),
    ["a,b;c", "d;e,f", "plain", "2026,01;x"],
  );
});

test("a file with ragged trailing fields loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const text = "period,region,units,sales\n2025,North,10,100\n2026,South,11\n2027,North,12,120\n";
  const { file, path } = await written(text, "ragged.csv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(sales) AS s FROM data");
  assert.equal(Number(sums.n), 3);
  assert.equal(Number(sums.s), 220);
});

test("a file whose 64 KB prefix ends inside a quoted record loads", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap, refuseMixedSeparators } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const big = Array.from({ length: 3600 }, () => "North\na;b;c;d;e\nSouth").join("\n");
  const text = `period,product,units,sales,note\n2025,A-100,10,100,"${big}"\n2026,B-200,12,120,south\n`;
  assert.ok(text.length > 65536);
  const { file, path } = await written(text, "cut-quote.csv");
  const query = await openDatabase();
  await refuseMixedSeparators(query, file, await readCsvFile(file), path);
  await stageCsvAndSwap(query, file, "data", path);
  const [sums] = await query("SELECT count(*)::DOUBLE AS n, sum(sales) AS s FROM data");
  assert.equal(Number(sums.n), 2);
  assert.equal(Number(sums.s), 220);
});
