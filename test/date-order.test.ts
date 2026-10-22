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
