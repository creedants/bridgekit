import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { readCsvTable } = await import("../src/app/db.ts");

const FIXTURE = new URL("./fixtures/monatsumsatz.csv", import.meta.url).pathname;

async function yearly(query: Awaited<ReturnType<typeof openDatabase>>, table: string): Promise<Map<string, number>> {
  const rows = await query(`SELECT year(Monat) AS year, sum(Umsatz) AS total FROM "${table}" GROUP BY 1`);
  return new Map(rows.map((row) => [String(row.year), Number(row.total)]));
}

test("Q8: a semicolon file with thousands dots loads whole amounts", async () => {
  const query = await openDatabase();
  await readCsvTable(query, "sales", FIXTURE);
  await convertFormattedNumbers(query, "sales");
  const years = await yearly(query, "sales");
  assert.equal(years.get("2025"), 2358790);
  assert.equal(years.get("2026"), 2392983);
  assert.equal(
    await decimalCommaNote(query, "sales"),
    "Numbers in Umsatz such as 9.600 were read with a dot between thousands, as 9600.",
  );
});

test("Q8: a comma file with thousands dots reads decimals and says so", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-qa-");
  const file = path.join(directory, "comma-dots.csv");
  await writeFile(file, "period,units,amount\n2025,2,9.600\n2026,3,10.800\n");
  const query = await openDatabase();
  await readCsvTable(query, "dots", file);
  await convertFormattedNumbers(query, "dots");
  const rows = await query(`SELECT amount FROM dots ORDER BY period`);
  assert.deepEqual(rows.map((row) => Number(row.amount)), [9.6, 10.8]);
  assert.equal(
    await decimalCommaNote(query, "dots"),
    "Numbers in amount such as 9.600 were read as decimals, as 9.6. If they are whole numbers with dots between thousands, save the file with plain numbers.",
  );
});

test("Q18: an xlsx twin of a CSV loads the same types and auto setup", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const { firstSheetAsCsv } = await import("../src/app/sheet.ts");
  const { guessSetup } = await import("../src/app/setup.ts");
  const header = ["period", "product", "units", "sales"];
  const rows: (string | number)[][] = [
    ["2025", "A-100", 10, 120],
    ["2025", "B-100", 4, 60],
    ["2026", "A-100", 11, 132],
    ["2026", "B-100", 5, 75],
  ];
  const directory = await mkdtemp("/tmp/bridgekit-qa-");
  const csvFile = path.join(directory, "twin.csv");
  await writeFile(csvFile, `${header.join(",")}\n${rows.map((row) => row.join(",")).join("\n")}\n`);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(header);
  for (const row of rows) sheet.addRow(row);
  const flat = await firstSheetAsCsv(new File([await workbook.xlsx.writeBuffer()], "twin.xlsx"));
  const xlsxFile = path.join(directory, "twin-flat.csv");
  await writeFile(xlsxFile, flat.csv);
  const query = await openDatabase();
  await readCsvTable(query, "csvdata", csvFile);
  await readCsvTable(query, "xlsxdata", xlsxFile);
  await convertFormattedNumbers(query, "csvdata");
  await convertFormattedNumbers(query, "xlsxdata");
  const types = async (table: string) =>
    (await query(`DESCRIBE "${table}"`)).map((row) => [String(row.column_name), String(row.column_type)]);
  assert.deepEqual(await types("xlsxdata"), await types("csvdata"));
  const columnsOf = async (table: string) =>
    (await query(`DESCRIBE "${table}"`)).map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
  assert.deepEqual(guessSetup(await columnsOf("xlsxdata")), guessSetup(await columnsOf("csvdata")));
  const sum = async (table: string) => Number((await query(`SELECT sum(sales) AS s FROM "${table}"`))[0].s);
  assert.equal(await sum("xlsxdata"), await sum("csvdata"));
});

test("Q25: a PNG renamed to xlsx is refused without a library message", async () => {
  const { firstSheetAsCsv, INVALID_WORKBOOK } = await import("../src/app/sheet.ts");
  const png = new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    "image.xlsx",
  );
  await assert.rejects(firstSheetAsCsv(png), (error) => (error as Error).message === INVALID_WORKBOOK);
  const text = new File(["a,b\n1,2\n"], "text.xlsx");
  await assert.rejects(firstSheetAsCsv(text), (error) => (error as Error).message === INVALID_WORKBOOK);
});

test("Q25: a binary prefix is not text, a CSV prefix is", async () => {
  const { looksBinary, NOT_TEXT_FILE } = await import("../src/app/encoding.ts");
  assert.equal(NOT_TEXT_FILE, "This file is not a text file. Save it as CSV UTF-8 or Excel (.xlsx).");
  assert.equal(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(looksBinary(new TextEncoder().encode("period,units\n2025,10\n")), false);
  assert.equal(looksBinary(new Uint8Array([])), false);
  assert.equal(looksBinary(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), false);
});

test("Q28: an empty table is refused and the loaded data stays loaded", async () => {
  const { requireDataRows, swapLoadedTable } = await import("../src/app/db.ts");
  const { NO_DATA_ROWS } = await import("../src/app/sheet.ts");
  assert.equal(NO_DATA_ROWS, "This file has no data rows.");
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT 1 AS a`);
  const directory = await mkdtemp("/tmp/bridgekit-qa-");
  const headerOnly = path.join(directory, "header-only.csv");
  await writeFile(headerOnly, "a,b\n");
  await readCsvTable(query, "staging", headerOnly);
  await assert.rejects(requireDataRows(query, "staging"), /This file has no data rows\./);
  assert.deepEqual(await query(`SELECT * FROM t`), [{ a: 1 }]);
  await query(`CREATE TABLE staging2 AS SELECT 2 AS a`);
  await requireDataRows(query, "staging2");
  await swapLoadedTable(query, "staging2", "t");
  assert.deepEqual(await query(`SELECT * FROM t`), [{ a: 2 }]);
});

test("Q30: mixed separators warn where the file notes show", async () => {
  const { mentionsMixedSeparators, hasMixedSeparators } = await import("../src/app/db.ts");
  const { markMixedSeparators } = await import("../src/app/numbers.ts");
  assert.equal(mentionsMixedSeparators("a,b,c\n1;2;3\n4;5;6\n"), true);
  assert.equal(mentionsMixedSeparators("a;b;c\n1;2;3\n"), false);
  assert.equal(mentionsMixedSeparators("a,b,c\n1,2,3\n"), false);
  assert.equal(mentionsMixedSeparators("period,units,sales\n2025,10,100\n2026\t20\t200\n"), true);
  assert.equal(mentionsMixedSeparators("period\tunits\tsales\n2025\t10\t100\n2026;20;200\n"), true);
  const quoted = "period,Product,units,sales\n2025,\"A-\n100;X\nend\",10,100\n2026,\"A-\n100;X\nend\",10,120\n";
  assert.equal(mentionsMixedSeparators(quoted), false);
  const directory = await mkdtemp("/tmp/bridgekit-qa-");
  const file = path.join(directory, "mixed.csv");
  await writeFile(file, "a,b,c\n1;2;3\n4;5;6\n");
  const query = await openDatabase();
  await readCsvTable(query, "mixed", file);
  await convertFormattedNumbers(query, "mixed");
  await markMixedSeparators(query, "mixed");
  assert.equal(await hasMixedSeparators(query, "mixed"), true);
  assert.equal(
    await decimalCommaNote(query, "mixed"),
    "Rows in this file use different separators, so its columns may be split wrongly. Save it again with one separator.",
  );
});

test("Q31: huge amounts warn that the steps may not sum to the change", async () => {
  const { runBridge, amountsNote, sensitivity } = await import("../src/engine.ts");
  const query = await openDatabase();
  await query(
    `CREATE TABLE huge AS SELECT * FROM (VALUES ('p0', 'A', 1, 20000000000000000.0), ('p1', 'A', 1, 10000000000000000.0)) v(period, product, units, sales)`,
  );
  const hugeConfig = {
    table: "huge", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  await runBridge(query, { ...hugeConfig });
  assert.equal(
    await amountsNote(query),
    "Some amounts are too large to add up exactly, so the steps may not sum to the change.",
  );
  assert.equal(
    await decimalCommaNote(query, "huge"),
    "Some amounts are too large to add up exactly, so the steps may not sum to the change.",
  );
  await sensitivity(query, { ...hugeConfig });
  await query(
    `CREATE TABLE ordinary AS SELECT * FROM (VALUES ('p0', 'A', 1, 100.0), ('p1', 'A', 1, 120.0)) v(period, product, units, sales)`,
  );
  await runBridge(query, { ...hugeConfig, table: "ordinary" });
  assert.equal(await amountsNote(query), null);
  assert.equal(await decimalCommaNote(query, "ordinary"), null);
});

test("Q35: prior units that cancel read truthfully in both branches", async () => {
  const { runBridge, NoPriorUnits } = await import("../src/engine.ts");
  const query = await openDatabase();
  await query(
    `CREATE TABLE cancel AS SELECT * FROM (VALUES ('2025', 'A-100', 10, 100.0), ('2025', 'A-100', -10, -100.0), ('2026', 'A-100', 10, 120.0)) v(period, product, units, sales)`,
  );
  const base = {
    periodColumn: "period", prior: "2025", current: "2026",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  await assert.rejects(runBridge(query, { ...base, table: "cancel" }), (error: unknown) => {
    assert.ok(error instanceof NoPriorUnits);
    assert.equal((error as Error).message, "Units for prior period '2025' add up to zero or less.");
    return true;
  });
  await query(
    `CREATE TABLE nopos AS SELECT * FROM (VALUES ('2025', 'A-100', 0, 100.0), ('2025', 'A-100', -5, 50.0), ('2026', 'A-100', 10, 120.0)) v(period, product, units, sales)`,
  );
  await assert.rejects(runBridge(query, { ...base, table: "nopos" }), (error: unknown) => {
    assert.ok(error instanceof NoPriorUnits);
    assert.equal((error as Error).message, "Units for prior period '2025' are all zero or negative.");
    return true;
  });
});

test("Q28: a 0-byte file through the loader keeps the loaded data", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const query = await openDatabase();
  await query(`CREATE TABLE kept AS SELECT 1 AS a`);
  const directory = await mkdtemp("/tmp/bridgekit-qa-");
  const valid = path.join(directory, "valid.csv");
  await writeFile(valid, "a\n2\n");
  const empty = new File([], "empty.csv", { type: "text/csv" });
  await assert.rejects(stageCsvAndSwap(query, empty, "kept", valid, false), /This file has no data rows\./);
  assert.deepEqual(await query(`SELECT * FROM kept`), [{ a: 1 }]);
});

test("Q28: a header-only file through the loader keeps the loaded data", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const query = await openDatabase();
  await query(`CREATE TABLE kept2 AS SELECT 1 AS a`);
  const directory = await mkdtemp("/tmp/bridgekit-qa-");
  const headerOnly = path.join(directory, "header-only.csv");
  await writeFile(headerOnly, "a,b\n");
  const headerFile = new File(["a,b\n"], "header-only.csv", { type: "text/csv" });
  await assert.rejects(stageCsvAndSwap(query, headerFile, "kept2", headerOnly, false), /This file has no data rows\./);
  assert.deepEqual(await query(`SELECT * FROM kept2`), [{ a: 1 }]);
});

test("counts and pairs read correctly for 0, 1 and many", async () => {
  const { counted, distinctPair, signedShare } = await import("../src/app/format.ts");
  assert.equal(counted(1, "line"), "1 line");
  assert.equal(counted(2, "line"), "2 lines");
  assert.equal(counted(0, "row"), "0 rows");
  assert.equal(counted(1, "product value"), "1 product value");
  assert.deepEqual(distinctPair(2400, 2440), ["2.4K", "2.44K"]);
  assert.deepEqual(distinctPair(1_000_000, 1_100_000), ["1M", "1.1M"]);
  assert.deepEqual(distinctPair(2400.1, 2400.2), ["2,400.1", "2,400.2"]);
  assert.deepEqual(distinctPair(2400, 2400), ["2,400", "2,400"]);
  assert.equal(signedShare(-72, 1000), "-7.2%");
  assert.equal(signedShare(100, 1000), "+10.0%");
});
