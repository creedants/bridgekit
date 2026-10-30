import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: "data:text/javascript,export default \"stub\"", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { readCsvTable, readLoadedTable, dateOrderNote } = await import("../src/app/db.ts");
const { firstSheetAsCsv } = await import("../src/app/sheet.ts");

async function csvPath(content: string): Promise<string> {
  const directory = await mkdtemp("/tmp/bridgekit-date-");
  const file = path.join(directory, "input.csv");
  await writeFile(file, content);
  return file;
}

function esc(value: string): string {
  return value.replaceAll("'", "''");
}

test("a ragged short row loads with blanks", async () => {
  const file = await csvPath("a,b,c\n1,2,3\n4,5\n7,8,9\n");
  const query = await openDatabase();
  await readCsvTable(query, "ragged", file);
  const described = await query("DESCRIBE ragged");
  assert.deepEqual(
    described.map((row) => String(row.column_name)),
    ["a", "b", "c"],
  );
  const rows = await query("SELECT a, b, c FROM ragged ORDER BY a");
  assert.equal(rows.length, 3);
  assert.equal(Number(rows[1].b), 5);
  assert.equal(rows[1].c, null);
});

test("a well-formed file with a quoted line break matches plain read_csv", async () => {
  const file = await csvPath('a,b\n"x\ny",2\np,3\n');
  const query = await openDatabase();
  await readCsvTable(query, "well", file);
  await query(`CREATE TABLE plain AS SELECT * FROM read_csv('${esc(file)}', header=true)`);
  const well = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM well ORDER BY b");
  const plain = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM plain ORDER BY b");
  assert.deepEqual(well, plain);
  assert.ok(String(well[0].a).includes("\n"));
});

test("a fully ambiguous slash date becomes March 4 and the note names the column", async () => {
  const file = await csvPath("d,v\n03/04/2025,10\n05/06/2025,20\n");
  const query = await openDatabase();
  await readCsvTable(query, "amb", file);
  const rows = await query("SELECT CAST(d AS VARCHAR) AS d FROM amb ORDER BY v");
  assert.deepEqual(
    rows.map((row) => String(row.d)),
    ["2025-03-04", "2025-05-06"],
  );
  assert.equal(await dateOrderNote(query, "amb"), "1 column with slash dates was read month-first: d.");
});

test("proven columns keep their order and the note is null", async () => {
  const dayFile = await csvPath("d,v\n13/04/2025,10\n03/04/2025,20\n");
  const monthFile = await csvPath("d,v\n04/13/2025,10\n03/04/2025,20\n");
  const query = await openDatabase();
  await readCsvTable(query, "dayproof", dayFile);
  await readCsvTable(query, "monthproof", monthFile);
  const day = await query("SELECT CAST(d AS VARCHAR) AS d FROM dayproof ORDER BY v");
  assert.deepEqual(
    day.map((row) => String(row.d)),
    ["2025-04-13", "2025-04-03"],
  );
  assert.equal(await dateOrderNote(query, "dayproof"), null);
  const month = await query("SELECT CAST(d AS VARCHAR) AS d FROM monthproof ORDER BY v");
  assert.deepEqual(
    month.map((row) => String(row.d)),
    ["2025-04-13", "2025-03-04"],
  );
  assert.equal(await dateOrderNote(query, "monthproof"), null);
});

test("a day-first proof plus an ambiguous second column swaps only the second", async () => {
  const file = await csvPath("id,a,b\n1,13/04/2025,03/04/2025\n2,03/04/2025,05/06/2025\n");
  const query = await openDatabase();
  await readCsvTable(query, "mixedday", file);
  const rows = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM mixedday ORDER BY id");
  assert.deepEqual(
    rows.map((row) => String(row.a)),
    ["2025-04-13", "2025-04-03"],
  );
  assert.deepEqual(
    rows.map((row) => String(row.b)),
    ["2025-03-04", "2025-05-06"],
  );
  assert.equal(await dateOrderNote(query, "mixedday"), "1 column with slash dates was read month-first: b.");
});

test("a month-first proof leaves its values and the note names the ambiguous column", async () => {
  const file = await csvPath("id,a,b\n1,04/13/2025,03/04/2025\n2,03/04/2025,05/06/2025\n");
  const query = await openDatabase();
  await readCsvTable(query, "mixedmonth", file);
  const rows = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM mixedmonth ORDER BY id");
  assert.deepEqual(
    rows.map((row) => String(row.a)),
    ["2025-04-13", "2025-03-04"],
  );
  assert.deepEqual(
    rows.map((row) => String(row.b)),
    ["2025-03-04", "2025-05-06"],
  );
  assert.equal(await dateOrderNote(query, "mixedmonth"), "1 column with slash dates was read month-first: b.");
});

test("an Excel workbook with text date cells keeps the plain reader's order", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["d", "v"]);
  sheet.addRow(["03/04/2025", 10]);
  sheet.addRow(["05/06/2025", 20]);
  const book = new File([await workbook.xlsx.writeBuffer()], "book.xlsx");
  const { csv } = await firstSheetAsCsv(book);
  const file = await csvPath(csv);
  const query = await openDatabase();
  await readLoadedTable(query, "excel", file, true);
  await query(`CREATE TABLE plain AS SELECT * FROM read_csv('${esc(file)}')`);
  const excel = await query("SELECT CAST(d AS VARCHAR) AS d FROM excel ORDER BY v");
  const plain = await query("SELECT CAST(d AS VARCHAR) AS d FROM plain ORDER BY v");
  assert.deepEqual(excel, plain);
  assert.deepEqual(
    excel.map((row) => String(row.d)),
    ["2025-04-03", "2025-06-05"],
  );
  const types = async (table: string) =>
    (await query(`DESCRIBE ${table}`)).map((row) => [String(row.column_name), String(row.column_type)]);
  assert.deepEqual(await types("excel"), await types("plain"));
  assert.equal(await dateOrderNote(query, "excel"), null);
  await readLoadedTable(query, "samecsv", file, false);
  const same = await query("SELECT CAST(d AS VARCHAR) AS d FROM samecsv ORDER BY v");
  assert.deepEqual(
    same.map((row) => String(row.d)),
    ["2025-03-04", "2025-05-06"],
  );
  assert.equal(await dateOrderNote(query, "samecsv"), "1 column with slash dates was read month-first: d.");
});

test("a column mixing a two-digit year with a four-digit year loads as the plain reader does", async () => {
  const file = await csvPath("d,v\n13/04/25,10\n05/06/2025,20\n");
  const query = await openDatabase();
  await readCsvTable(query, "mixedwidth", file);
  await query(`CREATE TABLE plain AS SELECT * FROM read_csv('${esc(file)}')`);
  const mixed = await query("SELECT CAST(d AS VARCHAR) AS d FROM mixedwidth ORDER BY v");
  const plain = await query("SELECT CAST(d AS VARCHAR) AS d FROM plain ORDER BY v");
  assert.deepEqual(mixed, plain);
  assert.deepEqual(
    mixed.map((row) => String(row.d)),
    ["0025-04-13", "2025-06-05"],
  );
  assert.equal(await dateOrderNote(query, "mixedwidth"), null);
});

test("an ambiguous two-digit date beside a four-digit date keeps the plain reader's values", async () => {
  const file = await csvPath("d,v\n03/04/25,10\n05/06/2025,20\n");
  const query = await openDatabase();
  await readCsvTable(query, "ambiguouswidth", file);
  await query(`CREATE TABLE plain AS SELECT * FROM read_csv('${esc(file)}')`);
  const mixed = await query("SELECT CAST(d AS VARCHAR) AS d FROM ambiguouswidth ORDER BY v");
  const plain = await query("SELECT CAST(d AS VARCHAR) AS d FROM plain ORDER BY v");
  assert.deepEqual(mixed, plain);
  assert.deepEqual(
    mixed.map((row) => String(row.d)),
    ["0025-04-03", "2025-06-05"],
  );
  assert.equal(await dateOrderNote(query, "ambiguouswidth"), null);
});

test("a two-digit-year date leaves every column as the plain reader read it", async () => {
  const file = await csvPath("id,a,b\n1,04/13/25,03/04/2025\n2,05/06/2025,05/06/2025\n");
  const query = await openDatabase();
  await readCsvTable(query, "mixedyears", file);
  await query(`CREATE TABLE plain AS SELECT * FROM read_csv('${esc(file)}')`);
  const loaded = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM mixedyears ORDER BY id");
  const plain = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM plain ORDER BY id");
  assert.deepEqual(loaded, plain);
  assert.deepEqual(
    loaded.map((row) => String(row.a)),
    ["0025-04-13", "2025-05-06"],
  );
  assert.deepEqual(
    loaded.map((row) => String(row.b)),
    ["2025-03-04", "2025-05-06"],
  );
  const types = Object.fromEntries(
    (await query("DESCRIBE mixedyears")).map((row) => [String(row.column_name), String(row.column_type)]),
  );
  assert.equal(types.a, "DATE");
  assert.equal(types.b, "DATE");
  assert.equal(await dateOrderNote(query, "mixedyears"), null);
});

test("a day-first two-digit-year date leaves every column as the plain reader read it", async () => {
  const file = await csvPath("id,a,b\n1,13/04/25,03/04/2025\n2,05/06/2025,05/06/2025\n");
  const query = await openDatabase();
  await readCsvTable(query, "mixedyearsday", file);
  await query(`CREATE TABLE plain AS SELECT * FROM read_csv('${esc(file)}')`);
  const loaded = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM mixedyearsday ORDER BY id");
  const plain = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM plain ORDER BY id");
  assert.deepEqual(loaded, plain);
  assert.deepEqual(
    loaded.map((row) => String(row.a)),
    ["0025-04-13", "2025-06-05"],
  );
  assert.deepEqual(
    loaded.map((row) => String(row.b)),
    ["2025-04-03", "2025-06-05"],
  );
  assert.equal(await dateOrderNote(query, "mixedyearsday"), null);
});

test("a three-digit year is left as read, a rowid column is swapped, and a short row keeps its values", async () => {
  const threeDigitFile = await csvPath("id,a,b\n1,13/04/025,03/04/2025\n2,05/06/2025,05/06/2025\n");
  const shortFile = await csvPath("id,a,b\n1,04/13/25,03/04/2025\n2,05/06/2025,05/06/2025\n3,07/08/2025\n");
  const rowidFile = await csvPath("rowid,v\n03/04/2025,10\n05/06/2025,20\n");
  const query = await openDatabase();

  await readCsvTable(query, "threedigit", threeDigitFile);
  await query(`CREATE TABLE plainthree AS SELECT * FROM read_csv('${esc(threeDigitFile)}')`);
  const threeDigit = await query(
    "SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM threedigit ORDER BY id",
  );
  const plainThree = await query(
    "SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM plainthree ORDER BY id",
  );
  assert.deepEqual(threeDigit, plainThree);
  assert.deepEqual(
    threeDigit.map((row) => String(row.a)),
    ["0025-04-13", "2025-06-05"],
  );
  assert.deepEqual(
    threeDigit.map((row) => String(row.b)),
    ["2025-04-03", "2025-06-05"],
  );
  assert.equal(await dateOrderNote(query, "threedigit"), null);

  await readCsvTable(query, "shortrow", shortFile);
  const short = await query("SELECT CAST(a AS VARCHAR) AS a, CAST(b AS VARCHAR) AS b FROM shortrow ORDER BY id");
  assert.deepEqual(
    short.map((row) => (row.b === null ? null : String(row.b))),
    ["2025-03-04", "2025-05-06", null],
  );
  assert.equal(await dateOrderNote(query, "shortrow"), null);

  await readCsvTable(query, "rowidcol", rowidFile);
  const described = await query("DESCRIBE rowidcol");
  assert.equal(String(described.find((row) => String(row.column_name) === "rowid")?.column_type), "DATE");
  const rowid = await query("SELECT CAST(rowid AS VARCHAR) AS rowid FROM rowidcol ORDER BY v");
  assert.deepEqual(
    rowid.map((row) => String(row.rowid)),
    ["2025-03-04", "2025-05-06"],
  );
  assert.equal(await dateOrderNote(query, "rowidcol"), "1 column with slash dates was read month-first: rowid.");
});

test("ISO dates stay unchanged and the note is null", async () => {
  const file = await csvPath("d,v\n2025-03-04,10\n2025-04-05,20\n");
  const query = await openDatabase();
  await readCsvTable(query, "iso", file);
  const rows = await query("SELECT CAST(d AS VARCHAR) AS d FROM iso ORDER BY v");
  assert.deepEqual(
    rows.map((row) => String(row.d)),
    ["2025-03-04", "2025-04-05"],
  );
  assert.equal(await dateOrderNote(query, "iso"), null);
});

test("Excel-style slash timestamps become timestamps with year, quarter and month periods", async () => {
  const file = await csvPath("period,day\n2025,12/13/09 9:58\n2026,12/1/09 7:45\n");
  const query = await openDatabase();
  await readCsvTable(query, "excelstyle", file);
  const described = await query("DESCRIBE excelstyle");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "TIMESTAMP");
  const rows = await query(
    "SELECT CAST(day AS VARCHAR) AS day, year(day) AS y, quarter(day) AS q, month(day) AS m FROM excelstyle ORDER BY y, m, day",
  );
  assert.deepEqual(
    rows.map((row) => [String(row.day), Number(row.y), Number(row.q), Number(row.m)]),
    [
      ["2009-12-01 07:45:00", 2009, 4, 12],
      ["2009-12-13 09:58:00", 2009, 4, 12],
    ],
  );
});

test("a day past twelve that appears after the sniff sample loads without a conversion error", async () => {
  const lines = ["period,units,day"];
  for (let index = 0; index < 20_600; index++) {
    const day = index < 20_480 ? `12/${(index % 12) + 1}/09 7:45` : "12/13/09 9:58";
    lines.push(`2025,${(index % 5) + 1},${day}`);
  }
  const file = await csvPath(`${lines.join("\n")}\n`);
  const query = await openDatabase();
  await readCsvTable(query, "late_day", file);
  const [counts] = await query("SELECT count(*)::DOUBLE AS n FROM late_day");
  assert.equal(Number(counts.n), 20_600);
  const described = await query("DESCRIBE late_day");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "TIMESTAMP");
  const late = await query("SELECT CAST(day AS VARCHAR) AS day FROM late_day WHERE rowid = 20599");
  assert.equal(String(late[0].day), "2009-12-13 09:58:00");
});

test("a four-digit slash timestamp with no proof follows the browser's order and says so", async () => {
  const file = await csvPath("period,day\n2025,12/1/2009 7:45\n2026,1/2/2009 6:30\n");
  const query = await openDatabase();
  await readCsvTable(query, "four_digit", file);
  const described = await query("DESCRIBE four_digit");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "TIMESTAMP");
  const rows = await query("SELECT CAST(day AS VARCHAR) AS day FROM four_digit ORDER BY day");
  assert.deepEqual(
    rows.map((row) => String(row.day)),
    ["2009-01-02 06:30:00", "2009-12-01 07:45:00"],
  );
  assert.equal(
    await dateOrderNote(query, "four_digit"),
    "1 column with slash dates was read month-first, as this browser's language expects: day.",
  );
});

test("a day-first text date becomes a date and a monthly slash date stays day-first", async () => {
  const dayFirst = await csvPath("period,day\n2025,31/03/2026\n2026,01/04/2026\n");
  const withTime = await csvPath("period,day\n2025,31/03/2026 8:00\n2026,01/04/2026 9:30\n");
  const query = await openDatabase();
  await readCsvTable(query, "day_first", dayFirst);
  await readCsvTable(query, "day_first_time", withTime);
  const types = async (table: string) =>
    (await query(`DESCRIBE ${table}`)).map((row) => [String(row.column_name), String(row.column_type)]);
  assert.deepEqual(await types("day_first"), [
    ["period", "BIGINT"],
    ["day", "DATE"],
  ]);
  const plain = await query("SELECT CAST(day AS VARCHAR) AS day FROM day_first ORDER BY day");
  assert.deepEqual(
    plain.map((row) => String(row.day)),
    ["2026-03-31", "2026-04-01"],
  );
  assert.deepEqual(await types("day_first_time"), [
    ["period", "BIGINT"],
    ["day", "TIMESTAMP"],
  ]);
  const timed = await query("SELECT CAST(day AS VARCHAR) AS day FROM day_first_time ORDER BY day");
  assert.deepEqual(
    timed.map((row) => String(row.day)),
    ["2026-03-31 08:00:00", "2026-04-01 09:30:00"],
  );
});

test("an English month-name date becomes a date", async () => {
  const monthFirst = await csvPath('period,day\n2025,"Mar 31, 2026"\n2026,"Apr 1, 2026"\n');
  const dayFirst = await csvPath("period,day\n2025,31 Mar 2026\n2026,1 Apr 2026\n");
  const query = await openDatabase();
  await readCsvTable(query, "month_name", monthFirst);
  await readCsvTable(query, "day_name", dayFirst);
  for (const table of ["month_name", "day_name"]) {
    const described = await query(`DESCRIBE ${table}`);
    assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "DATE", table);
    const rows = await query(`SELECT CAST(day AS VARCHAR) AS day FROM ${table} ORDER BY day`);
    assert.deepEqual(
      rows.map((row) => String(row.day)),
      ["2026-03-31", "2026-04-01"],
      table,
    );
  }
});

test("an unsettled slash column follows the passed order and says the language decided", async () => {
  const file = await csvPath("period,day\n2025,03/04/2026 8:00\n2026,05/06/2026 9:30\n");
  const query = await openDatabase();
  await readCsvTable(query, "unsettled_day", file, false, "day first");
  await readCsvTable(query, "unsettled_month", file);
  const values = async (table: string) =>
    (await query(`SELECT CAST(day AS VARCHAR) AS day FROM ${table} ORDER BY day`)).map((row) => String(row.day));
  assert.deepEqual(await values("unsettled_day"), ["2026-04-03 08:00:00", "2026-06-05 09:30:00"]);
  assert.equal(
    await dateOrderNote(query, "unsettled_day"),
    "1 column with slash dates was read day-first, as this browser's language expects: day.",
  );
  assert.deepEqual(await values("unsettled_month"), ["2026-03-04 08:00:00", "2026-05-06 09:30:00"]);
  assert.equal(
    await dateOrderNote(query, "unsettled_month"),
    "1 column with slash dates was read month-first, as this browser's language expects: day.",
  );
});

test("a column with a first part and a second part both above twelve stays text", async () => {
  const file = await csvPath("period,day\n2025,13/04/2026\n2026,04/13/2026\n");
  const query = await openDatabase();
  await readCsvTable(query, "both_proofs", file);
  const described = await query("DESCRIBE both_proofs");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "VARCHAR");
  const rows = await query("SELECT day FROM both_proofs ORDER BY rowid");
  assert.deepEqual(
    rows.map((row) => String(row.day)),
    ["13/04/2026", "04/13/2026"],
  );
  assert.equal(
    await dateOrderNote(query, "both_proofs"),
    "day has slash dates in both orders, such as 13/04/2026 and 04/13/2026, so it was read as text.",
  );
});

test("an ordinary text column with one date-like value gets no date note", async () => {
  const file = await csvPath("period,note\n2025,written 03/04/2025\n2026,plain\n");
  const query = await openDatabase();
  await readCsvTable(query, "few_dates", file);
  const described = await query("DESCRIBE few_dates");
  assert.equal(String(described.find((row) => String(row.column_name) === "note")?.column_type), "VARCHAR");
  assert.equal(await dateOrderNote(query, "few_dates"), null);
});

test("a slash date column with a date that does not exist stays text and says so", async () => {
  const file = await csvPath("period,day\n2025,31/02/2026\n2026,28/02/2026\n");
  const query = await openDatabase();
  await readCsvTable(query, "missing_date", file);
  const described = await query("DESCRIBE missing_date");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "VARCHAR");
  assert.equal(
    await dateOrderNote(query, "missing_date"),
    "day has a date that does not exist, such as 31/02/2026, so it was read as text.",
  );
});

test("a two-digit-year timestamp reads its own year and month", async () => {
  const file = await csvPath("period,day\n2025,12/13/09 9:58\n");
  const query = await openDatabase();
  await readCsvTable(query, "short_year", file);
  const described = await query("DESCRIBE short_year");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "TIMESTAMP");
  const [row] = await query("SELECT CAST(day AS VARCHAR) AS day, year(day) AS y, month(day) AS m FROM short_year");
  assert.equal(String(row.day), "2009-12-13 09:58:00");
  assert.equal(Number(row.y), 2009);
  assert.equal(Number(row.m), 12);
});

test("a day-13 timestamp past the sniff sample is converted by the retry", async () => {
  const lines = ["period,units,day"];
  for (let index = 0; index < 20_600; index++) {
    lines.push(`2025,${(index % 5) + 1},${index < 20_480 ? "01/02/09 7:45" : "12/13/09 9:58"}`);
  }
  const file = await csvPath(`${lines.join("\n")}\n`);
  const query = await openDatabase();
  await readCsvTable(query, "late_retry", file);
  const described = await query("DESCRIBE late_retry");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "TIMESTAMP");
  const late = await query("SELECT CAST(day AS VARCHAR) AS day FROM late_retry WHERE rowid = 20599");
  assert.equal(String(late[0].day), "2009-12-13 09:58:00");
});

test("an ambiguous four-digit timestamp follows the browser and names the language", async () => {
  const file = await csvPath("period,day\n2025,03/04/2026 8:00\n2026,05/06/2026 9:30\n");
  const query = await openDatabase();
  await readCsvTable(query, "ambiguous_stamp", file);
  const described = await query("DESCRIBE ambiguous_stamp");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "TIMESTAMP");
  const rows = await query("SELECT CAST(day AS VARCHAR) AS day FROM ambiguous_stamp ORDER BY day");
  assert.deepEqual(
    rows.map((row) => String(row.day)),
    ["2026-03-04 08:00:00", "2026-05-06 09:30:00"],
  );
  assert.equal(
    await dateOrderNote(query, "ambiguous_stamp"),
    "1 column with slash dates was read month-first, as this browser's language expects: day.",
  );
});

test("an untimed day-first column becomes a DATE, not a timestamp", async () => {
  const lines = ["period,units,stamp,day"];
  for (let index = 0; index < 20_600; index++) {
    const stamp = index === 20_480 ? "12/13/09 9:58" : `12/${(index % 12) + 1}/09 7:45`;
    const day = index < 20_480 ? "03/04/2026" : index === 20_480 ? "31/03/2026" : "01/04/2026";
    lines.push(`2025,${(index % 5) + 1},${stamp},${day}`);
  }
  const file = await csvPath(`${lines.join("\n")}\n`);
  const query = await openDatabase();
  await readCsvTable(query, "untimed_day_first", file);
  const described = await query("DESCRIBE untimed_day_first");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "DATE");
  const rows = await query("SELECT CAST(day AS VARCHAR) AS day FROM untimed_day_first WHERE rowid IN (0, 20480, 20599) ORDER BY rowid");
  assert.deepEqual(
    rows.map((row) => String(row.day)),
    ["2026-04-03", "2026-03-31", "2026-04-01"],
  );
});

test("an impossible slash value beside a valid month-first date gets no both-orders note", async () => {
  const file = await csvPath("period,day\n2025,99/04/2026\n2026,04/13/2026\n");
  const query = await openDatabase();
  await readCsvTable(query, "bad_proof", file);
  const described = await query("DESCRIBE bad_proof");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "VARCHAR");
  assert.equal(
    await dateOrderNote(query, "bad_proof"),
    "day has a date that does not exist, such as 99/04/2026, so it was read as text.",
  );
});

test("a month name without a space after the comma reads as a date", async () => {
  const file = await csvPath('period,day\n2025,"April 13,2026"\n2026,"April 13,2026"\n');
  const query = await openDatabase();
  await readCsvTable(query, "tight_comma", file);
  const described = await query("DESCRIBE tight_comma");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "DATE");
  const rows = await query("SELECT CAST(day AS VARCHAR) AS day FROM tight_comma ORDER BY rowid");
  assert.deepEqual(
    rows.map((row) => String(row.day)),
    ["2026-04-13", "2026-04-13"],
  );
  assert.equal(await dateOrderNote(query, "tight_comma"), null);
});

test("a bad time stays text with no date note", async () => {
  const file = await csvPath("period,day\n2025,04/13/2026 25:00\n2026,04/14/2026 12:00\n");
  const query = await openDatabase();
  await readCsvTable(query, "bad_time", file);
  const described = await query("DESCRIBE bad_time");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "VARCHAR");
  assert.equal(await dateOrderNote(query, "bad_time"), null);
});

test("T439: a CSV with two blank lines before its header loads with the header and rows", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const text = "\n\nperiod,product,units,sales\n2025,A-100,10,100\n2026,A-100,12,120\n";
  const directory = await mkdtemp("/tmp/bridgekit-t439-");
  const filePath = path.join(directory, "blanks.csv");
  await writeFile(filePath, text);
  const query = await openDatabase();
  await stageCsvAndSwap(query, new File([text], "blanks.csv"), "data", filePath);
  const described = await query("DESCRIBE data");
  assert.deepEqual(
    described.map((row) => String(row.column_name)),
    ["period", "product", "units", "sales"],
  );
  const rows = await query("SELECT period, product, units, sales FROM data ORDER BY rowid");
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].period), 2025);
  assert.equal(Number(rows[1].period), 2026);
});

test("T439: a header-only file after blank lines is still refused with no data rows", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { NO_DATA_ROWS } = await import("../src/app/sheet.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const text = "\n\nperiod,product,units,sales\n";
  const directory = await mkdtemp("/tmp/bridgekit-t439-");
  const filePath = path.join(directory, "header-only.csv");
  await writeFile(filePath, text);
  const query = await openDatabase();
  await assert.rejects(
    stageCsvAndSwap(query, new File([text], "header-only.csv"), "data", filePath),
    (error: unknown) => (error as Error).message === NO_DATA_ROWS,
  );
});

test("T434: a date column whose first failure is a bad time names the later impossible date", async () => {
  const file = await csvPath("period,day\n2025,13/04/2026 25:00\n2026,31/02/2026 12:00\n2027,15/03/2026 12:00\n");
  const query = await openDatabase();
  await readCsvTable(query, "mixed_fail", file);
  const described = await query("DESCRIBE mixed_fail");
  assert.equal(String(described.find((row) => String(row.column_name) === "day")?.column_type), "VARCHAR");
  assert.equal(
    await dateOrderNote(query, "mixed_fail"),
    "day has a date that does not exist, such as 31/02/2026 12:00, so it was read as text.",
  );
});
