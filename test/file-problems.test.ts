import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import {
  fileProblem,
  MAX_PERIOD_VALUES,
  periodView,
  periodsFor,
  sameSuggestedLevels,
  type FileProblemInput,
  type Periods,
} from "../src/app/fileProblems.ts";
import type { Column } from "../src/app/setup.ts";
import { profileFile } from "../src/app/profile.ts";
import { openDatabase } from "../src/duckdb.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const text = (name: string): Column => ({ name, type: "VARCHAR" });
const number = (name: string): Column => ({ name, type: "INTEGER" });
const date = (name: string): Column => ({ name, type: "DATE" });

function known(values: readonly string[]): Periods {
  const view = periodView({ load: 1, periodColumn: "period", grain: "value", filters: [] });
  return periodsFor(view, { view, values });
}

function input(over: Partial<Omit<FileProblemInput, "periods">> & { periods?: readonly string[] } = {}): FileProblemInput {
  const { periods: values = [], ...rest } = over;
  return {
    columns: [],
    rows: 0,
    periodColumn: "",
    unitsColumn: "",
    salesColumn: "",
    ...rest,
    periods: known(values),
  };
}

const HEALTHY = input({
  columns: [number("period"), text("design"), number("units"), number("sales")],
  rows: 4,
  periodColumn: "period",
  periods: ["2024", "2025"],
  unitsColumn: "units",
  salesColumn: "sales",
});

test("the sample file and any file that bridges give no message", () => {
  const sample = input({
    columns: [number("year"), text("customer"), text("design"), number("units"), number("sales")],
    rows: 1000,
    periodColumn: "year",
    periods: ["2024", "2025", "2026"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(sample), { kind: "none" });
  assert.deepEqual(fileProblem(HEALTHY), { kind: "none" });
});

test("a real date column compared by year stays under the period label limit", () => {
  const dates = input({
    columns: [date("order_date"), text("design"), number("units"), number("sales")],
    rows: 300,
    periodColumn: "order_date",
    periods: ["2024", "2025"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(dates), { kind: "none" });
});

test("one period available says a bridge compares two periods", () => {
  const onePeriod = input({ ...HEALTHY, periods: ["2025"] });
  assert.deepEqual(fileProblem(onePeriod), {
    kind: "reason",
    message: 'With these settings "period" gives only one period, and a bridge compares two periods.',
  });

  // 160 dates in one year. The period list is the year the setup compares, not the dates.
  const oneYear = input({
    columns: [date("order_date"), text("design"), number("units"), number("sales")],
    rows: 160,
    periodColumn: "order_date",
    periods: ["2025"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(oneYear), {
    kind: "reason",
    message: 'With these settings "order_date" gives only one period, and a bridge compares two periods.',
  });

  // The column still has P2025 and P2026. The list is what a filter left.
  const filtered = input({ ...HEALTHY, periods: ["P2025"] });
  assert.deepEqual(fileProblem(filtered), {
    kind: "reason",
    message: 'With these settings "period" gives only one period, and a bridge compares two periods.',
  });
});

test("a text column named like the missing measure names that column", () => {
  const salesIsText = input({
    columns: [number("period"), text("design"), number("units"), text("net_sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(salesIsText), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "net_sales" holds text.',
  });

  const unitsIsText = input({
    columns: [number("period"), text("design"), text("qty"), number("sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(unitsIsText), {
    kind: "reason",
    message: 'Units must be a column of numbers, and "qty" holds text.',
  });
});

test("the message goes once the measure holds a numeric column", () => {
  const picked = input({
    columns: [number("period"), text("design"), number("units"), text("net_sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "units",
  });
  assert.deepEqual(fileProblem(picked), { kind: "none" });
});

test("a file with no column of numbers says the measures must be numbers", () => {
  const attributesOnly = input({
    columns: [text("period"), text("design"), text("finish"), text("material")],
    rows: 12,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(attributesOnly), {
    kind: "reason",
    message: "Sales and Units must be columns of numbers, and this file has none.",
  });
});

test("a period column with very many values is a note beside the general hint", () => {
  const periods = Array.from({ length: 200 }, (_, i) => `2023-${String(i).padStart(3, "0")}`);
  const mixedDates = input({
    columns: [text("order_date"), text("design"), number("units"), number("sales")],
    rows: 300,
    periodColumn: "order_date",
    periods,
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(mixedDates), {
    kind: "note",
    message: `The period column "order_date" has more than ${MAX_PERIOD_VALUES} periods.`,
  });
});

test("the period label limit fires one value above it and not at it", () => {
  const periods = (count: number) => Array.from({ length: count }, (_, i) => `label-${i}`);
  const atLimit = input({ ...HEALTHY, periods: periods(MAX_PERIOD_VALUES) });
  assert.deepEqual(fileProblem(atLimit), { kind: "none" });
  const overLimit = input({ ...HEALTHY, periods: periods(MAX_PERIOD_VALUES + 1) });
  assert.deepEqual(fileProblem(overLimit), {
    kind: "note",
    message: `The period column "period" has more than ${MAX_PERIOD_VALUES} periods.`,
  });
});

test("unknown periods add no period sentence", () => {
  assert.deepEqual(fileProblem({ ...HEALTHY, periods: "unknown" }), { kind: "none" });
  // A file whose only column is text names the missing measures instead.
  assert.deepEqual(
    fileProblem({
      ...input({ columns: [text("column0")], rows: 2, periodColumn: "period" }),
      periods: "unknown",
    }),
    {
      kind: "reason",
      message: "Sales and Units must be columns of numbers, and this file has none.",
    },
  );
  assert.deepEqual(
    fileProblem({
      ...input({
        columns: [number("period"), text("design"), number("units"), text("sales")],
        rows: 2,
        periodColumn: "period",
        unitsColumn: "units",
        salesColumn: "sales",
      }),
      periods: "unknown",
    }),
    {
      kind: "reason",
      message: 'Sales must be a column of numbers, and "sales" holds text.',
    },
  );
  assert.deepEqual(fileProblem(input({ ...HEALTHY, periods: [] })), { kind: "none" });
});

test("a period list from other settings is not the current list", () => {
  const current = periodView({ load: 2, periodColumn: "period", grain: "month", filters: [] });
  const previous = periodView({ load: 1, periodColumn: "period", grain: "year", filters: [] });
  const mismatched = periodsFor(current, { view: previous, values: ["2025"] });
  assert.equal(mismatched, "unknown");
  assert.deepEqual(fileProblem({ ...HEALTHY, periods: mismatched }), { kind: "none" });
  const matched = periodsFor(current, { view: current, values: ["2025"] });
  assert.deepEqual(fileProblem({ ...HEALTHY, periods: matched }), {
    kind: "reason",
    message: 'With these settings "period" gives only one period, and a bridge compares two periods.',
  });
});

test("no message without a period column picked", () => {
  const unpicked = input({ ...HEALTHY, periodColumn: "", periods: [] });
  assert.deepEqual(fileProblem(unpicked), { kind: "none" });
});

const boolean = (name: string): Column => ({ name, type: "BOOLEAN" });
const time = (name: string): Column => ({ name, type: "TIME" });
const blob = (name: string): Column => ({ name, type: "BLOB" });

test("a Boolean, time or blob measure is not described as text", () => {
  const salesBoolean = input({
    columns: [number("period"), text("design"), number("units"), boolean("sales")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(salesBoolean), {
    kind: "reason",
    message: '"sales" cannot be used for Sales because it is not a column of numbers.',
  });

  const salesTime = input({
    columns: [number("period"), text("design"), number("units"), time("sales")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(salesTime), {
    kind: "reason",
    message: '"sales" cannot be used for Sales because it is not a column of numbers.',
  });

  const unitsBlob = input({
    columns: [number("period"), text("design"), blob("qty"), number("sales")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(unitsBlob), {
    kind: "reason",
    message: '"qty" cannot be used for Units because it is not a column of numbers.',
  });
});

test("a note or unit price is not named while a numeric column can be chosen", () => {
  const notes = input({
    columns: [number("period"), text("design"), number("units"), text("sales_note"), number("turnover")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(notes), { kind: "none" });

  const unitPrice = input({
    columns: [number("period"), text("design"), text("unit_price"), number("sales"), number("count")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(unitPrice), { kind: "none" });
});

test("an unpicked numeric measure is left to the general line", () => {
  const amountWaiting = input({
    columns: [number("period"), text("design"), number("units"), text("sales"), number("amount")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(amountWaiting), { kind: "none" });
});

test("a gross text column is not named when sales is already a number", () => {
  const gross = input({
    columns: [number("period"), text("design"), number("units"), text("gross_sales"), number("net_sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "net_sales",
  });
  assert.deepEqual(fileProblem(gross), { kind: "none" });
});

test("three years of dates and 36 month labels say nothing about the period list", () => {
  const threeYears = input({
    columns: [date("order_date"), text("design"), number("units"), number("sales")],
    rows: 800,
    periodColumn: "order_date",
    periods: ["2024", "2025", "2026"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(threeYears), { kind: "none" });

  const months = input({
    ...HEALTHY,
    periods: Array.from({ length: 36 }, (_, i) => `2024-${String((i % 12) + 1).padStart(2, "0")}`),
  });
  assert.deepEqual(fileProblem(months), { kind: "none" });
});

test("108 month labels are a note that the period list is long", () => {
  const months = Array.from({ length: 108 }, (_, i) => {
    const year = 2017 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, "0");
    return `${year}-${month}`;
  });
  const longHistory = input({ ...HEALTHY, periodColumn: "month", periods: months });
  assert.deepEqual(fileProblem(longHistory), {
    kind: "note",
    message: 'The period column "month" has more than 100 periods.',
  });
});

test("a unit price with no numeric units column is not named", () => {
  const onlyPrice = input({
    columns: [number("period"), text("design"), text("unit_price"), number("sales")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(onlyPrice), { kind: "none" });
});

test("a note is not named when the file has no column of numbers", () => {
  const notesOnly = input({
    columns: [text("period"), text("design"), text("sales_notes")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
  });
  assert.deepEqual(fileProblem(notesOnly), {
    kind: "reason",
    message: "Sales and Units must be columns of numbers, and this file has none.",
  });
});

test("a chosen Boolean sales column is described without calling it text", () => {
  const chosen = input({
    columns: [number("period"), text("design"), number("units"), boolean("sales")],
    rows: 2,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(chosen), {
    kind: "reason",
    message: '"sales" cannot be used for Sales because it is not a column of numbers.',
  });
});

test("Suggest attributes matches names, columns and order", () => {
  const suggested = ["upgrade", "delivery", "design"];
  assert.equal(
    sameSuggestedLevels(
      [
        { name: "upgrade", columns: ["upgrade"] },
        { name: "delivery", columns: ["delivery"] },
        { name: "design", columns: ["design"] },
      ],
      suggested,
    ),
    true,
  );
  assert.equal(
    sameSuggestedLevels(
      [
        { name: "upgrade", columns: ["upgrade", "customer"] },
        { name: "delivery", columns: ["delivery"] },
        { name: "design", columns: ["design"] },
      ],
      suggested,
    ),
    false,
  );
  assert.equal(
    sameSuggestedLevels(
      [
        { name: "design", columns: ["design"] },
        { name: "upgrade", columns: ["upgrade"] },
        { name: "delivery", columns: ["delivery"] },
      ],
      suggested,
    ),
    false,
  );
  assert.equal(sameSuggestedLevels([], []), true);
  assert.equal(sameSuggestedLevels([{ name: "upgrade", columns: ["upgrade"] }], []), false);
});

test("a text column named like a value in a non-measure role is left alone", () => {
  // "price_note" is text and the tool already guards against it, but a column
  // named like the period column must never be offered as its own fix.
  const periodNamedLikeValue = input({
    columns: [text("period_value"), text("design"), number("units"), number("sales")],
    rows: 4,
    periodColumn: "period_value",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(periodNamedLikeValue), { kind: "none" });
});

test("a withheld text net_sales wins over a spare number", () => {
  const withheld = input({
    columns: [text("period"), text("product"), number("units"), text("net_sales"), number("gross_sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(withheld), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "net_sales" holds text.',
  });
});

test("a withheld net_sales is named rather than the network column the promoted guess picks", () => {
  const ordered = input({
    columns: [
      text("network"),
      number("period"),
      text("product"),
      number("units"),
      text("net_sales"),
    ],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(ordered), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "net_sales" holds text.',
  });
});

test("an empty Sales beside a numeric net_revenue gets no text net_sales message", () => {
  const numericNet = input({
    columns: [text("period"), text("product"), number("units"), text("net_sales"), number("net_revenue")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(numericNet), { kind: "none" });
});

type ProfileQuery = Awaited<ReturnType<typeof openDatabase>>;

async function profiledColumns(sql: string): Promise<Column[]> {
  const query = await openDatabase();
  await query(`CREATE TABLE data AS ${sql}`);
  return profileLoaded(query, "data");
}

/** Describes the loaded table, profiles it, and returns the columns the profile applied. */
async function profileLoaded(query: ProfileQuery, table: string): Promise<Column[]> {
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

/** Stages a CSV at a path the database can read, then profiles the table it loaded. */
async function stagedCsv(
  query: ProfileQuery,
  name: string,
  content: string,
  file: File = new File([content], name),
): Promise<Column[]> {
  const directory = await mkdtemp("/tmp/bridgekit-rows-");
  const source = path.join(directory, name);
  await writeFile(source, content);
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  await stageCsvAndSwap(query, file, "data", source);
  return profileLoaded(query, "data");
}

/** Writes a workbook's flattened sheet where the database can read it, stages it, then profiles. */
async function stagedWorkbook(
  query: ProfileQuery,
  name: string,
  rows: (string | number)[][],
): Promise<Column[]> {
  const { default: ExcelJS } = await import("exceljs");
  const { firstSheetAsCsv } = await import("../src/app/sheet.ts");
  const { stageExcelAndSwap } = await import("../src/app/db.ts");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  for (const row of rows) sheet.addRow(row);
  const flat = await firstSheetAsCsv(new File([await workbook.xlsx.writeBuffer()], name));
  const directory = await mkdtemp("/tmp/bridgekit-rows-");
  const flatPath = path.join(directory, `${name}.csv`);
  await writeFile(flatPath, flat.csv);
  await stageExcelAndSwap(query, "data", flatPath, flat.holes, flat.dataRows);
  return profileLoaded(query, "data");
}

/** A product cell with a line break of its own, and a text amount two records later. */
const MULTILINE =
  "period,Product,units,NET_SALES\n" +
  '2025,"A\nB",10,100\n' +
  "2025,A-100,10,110\n" +
  "2026,A-100,10,n/a\n" +
  "2026,A-100,10,130\n";

const MULTILINE_CELLS: (string | number)[][] = [
  ["period", "Product", "units", "NET_SALES"],
  ["2025", "A\nB", 10, 100],
  ["2025", "A-100", 10, 110],
  ["2026", "A-100", 10, "n/a"],
  ["2026", "A-100", 10, 130],
];

const BLANK_RECORD =
  "period,Product,units,NET_SALES\n" +
  "2025,A-100,10,100\n" +
  "\n" +
  "2025,A-100,10,110\n" +
  "2026,A-100,10,n/a\n" +
  "2026,A-100,10,130\n";

const ROW_4 = 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 4.';
const ROW_5 = 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 5.';
const NO_ROW = 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a".';

/** The setup the multiline file gets: four rows, no sales column picked. */
function multilineProblem(columns: Column[]): FileProblemInput {
  return input({
    columns,
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
}

function utf16leWithMark(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  return bytes;
}

test("R7: a mostly numeric sales column names its first text cell and its row", async () => {
  const columns = await profiledColumns(`SELECT * FROM (VALUES
    ('2025', 'A', 1, '100'),
    ('2025', 'B', 2, '110'),
    ('2026', 'A', 3, '120'),
    ('2026', 'B', 4, 'n/a'),
    ('2026', 'C', 5, '130')
  ) v(period, product, units, net_sales)`);
  assert.deepEqual(
    fileProblem(
      input({
        columns,
        rows: 5,
        periodColumn: "period",
        periods: ["2025", "2026"],
        unitsColumn: "units",
        salesColumn: "",
      }),
    ),
    {
      kind: "reason",
      message: 'Sales must be a column of numbers, and "net_sales" holds text, such as "n/a" in row 5.',
    },
  );
});

test("R7: a mostly numeric units column names its first text cell and its row", async () => {
  const columns = await profiledColumns(`SELECT * FROM (VALUES
    ('2025', 'A', '10', 100),
    ('2025', 'B', '11', 110),
    ('2025', 'C', '12', 120),
    ('2026', 'A', '13', 130),
    ('2026', 'B', '14', 140),
    ('2026', 'C', '15', 150),
    ('2026', 'D', '16', 160),
    ('2026', 'E', 'n/a', 170)
  ) v(period, product, qty, sales)`);
  assert.deepEqual(
    fileProblem(
      input({
        columns,
        rows: 8,
        periodColumn: "period",
        periods: ["2025", "2026"],
        unitsColumn: "",
        salesColumn: "sales",
      }),
    ),
    {
      kind: "reason",
      message: 'Units must be a column of numbers, and "qty" holds text, such as "n/a" in row 9.',
    },
  );
});

test("R7: a mostly text column keeps the message without a cell", async () => {
  const columns = await profiledColumns(`SELECT * FROM (VALUES
    ('2025', 'A', 1, '100'),
    ('2025', 'B', 2, 'n/a'),
    ('2026', 'A', 3, 'n/a'),
    ('2026', 'B', 4, 'n/a')
  ) v(period, product, units, net_sales)`);
  assert.deepEqual(
    fileProblem(
      input({
        columns,
        rows: 4,
        periodColumn: "period",
        periods: ["2025", "2026"],
        unitsColumn: "units",
        salesColumn: "",
      }),
    ),
    { kind: "reason", message: 'Sales must be a column of numbers, and "net_sales" holds text.' },
  );
});

test("R7: a blank CSV line keeps the cell locator on the file's own row", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const query = await openDatabase();
  const directory = await mkdtemp("/tmp/bridgekit-rows-");
  const content =
    "period,Product,units,NET_SALES\n2025,A-100,10,100\n\n2025,A-100,10,110\n2026,A-100,10,n/a\n2026,A-100,10,130\n";
  const source = path.join(directory, "blank.csv");
  await writeFile(source, content);
  await stageCsvAndSwap(query, new File([content], "blank.csv"), "data", source);
  const columns = await profileLoaded(query, "data");
  assert.deepEqual(
    fileProblem(
      input({
        columns,
        rows: 4,
        periodColumn: "period",
        periods: ["2025", "2026"],
        unitsColumn: "units",
        salesColumn: "",
      }),
    ),
    {
      kind: "reason",
      message: 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 5.',
    },
  );
});

test("R7: a blank Excel row keeps the cell locator on the file's own row", async () => {
  const query = await openDatabase();
  const columns = await stagedWorkbook(query, "blank.xlsx", [
    ["period", "Product", "units", "NET_SALES"],
    ["2025", "A-100", 10, 100],
    [],
    ["2025", "A-100", 10, 110],
    ["2026", "A-100", 10, "n/a"],
    ["2026", "A-100", 10, 130],
  ]);
  assert.deepEqual(fileProblem(multilineProblem(columns)), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 5.',
  });
});

test("R7: a currency sign is not a text cell", async () => {
  const columns = await profiledColumns(`SELECT * FROM (VALUES
    ('2025', 'A', 1, '€600'),
    ('2025', 'B', 2, '€700'),
    ('2026', 'A', 3, '€800'),
    ('2026', 'B', 4, '€900')
  ) v(period, product, units, sales)`);
  assert.deepEqual(
    fileProblem(
      input({
        columns,
        rows: 4,
        periodColumn: "period",
        periods: ["2025", "2026"],
        unitsColumn: "units",
        salesColumn: "",
      }),
    ),
    { kind: "reason", message: 'Sales must be a column of numbers, and "sales" holds text.' },
  );
});

test("R7: a quoted cell's own line break does not move the CSV row", async () => {
  const query = await openDatabase();
  const columns = await stagedCsv(query, "quoted.csv", MULTILINE);
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: ROW_4 });
});

test("R7: the same cells in a workbook name the same row", async () => {
  const query = await openDatabase();
  const columns = await stagedWorkbook(query, "quoted.xlsx", MULTILINE_CELLS);
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: ROW_4 });
});

test("R7: a blank record before the bad cell counts as a row", async () => {
  const query = await openDatabase();
  const content = MULTILINE.replace("2025,A-100,10,110\n", "2025,A-100,10,110\n\n");
  const columns = await stagedCsv(query, "blank-record.csv", content);
  assert.deepEqual(fileProblem(multilineProblem(columns)), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "NET_SALES" holds text, such as "n/a" in row 5.',
  });
});

test("R7: a blank-record CSV names row 5 through a forwarding query wrapper", async () => {
  const query = await openDatabase();
  await stagedCsv(query, "blank-record.csv", BLANK_RECORD);
  const forwarded = async (sql: string) => query(sql);
  const columns = await profileLoaded(forwarded, "data");
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: ROW_5 });
});

test("R7: the same blank-record cells in a workbook name row 5 through a wrapper", async () => {
  const query = await openDatabase();
  await stagedWorkbook(query, "blank-record.xlsx", [
    ["period", "Product", "units", "NET_SALES"],
    ["2025", "A-100", 10, 100],
    [],
    ["2025", "A-100", 10, 110],
    ["2026", "A-100", 10, "n/a"],
    ["2026", "A-100", 10, 130],
  ]);
  const forwarded = async (sql: string) => query(sql);
  const columns = await profileLoaded(forwarded, "data");
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: ROW_5 });
});

test("R7: an upload whose source the registry no longer holds names no row", async () => {
  const first = await openDatabase();
  const second = await openDatabase();
  await stagedCsv(first, "first.csv", BLANK_RECORD);
  // A second database's upload takes the table's one source slot.
  await stagedCsv(second, "second.csv", MULTILINE);
  const columns = await profileLoaded(first, "data");
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: NO_ROW });
});

test("R7: CRLF line endings do not move the row", async () => {
  const query = await openDatabase();
  const columns = await stagedCsv(query, "crlf.csv", MULTILINE.replaceAll("\n", "\r\n"));
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: ROW_4 });
});

test("R7: a space before an opening quote still proves the row", async () => {
  const query = await openDatabase();
  const content = MULTILINE.replace('2025,"A', '2025, "A');
  const columns = await stagedCsv(query, "spaced.csv", content);
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: ROW_4 });
});

test("R7: a UTF-16 file with a byte-order mark proves the row", async () => {
  const query = await openDatabase();
  const columns = await stagedCsv(
    query,
    "utf16.csv",
    MULTILINE,
    new File([utf16leWithMark(MULTILINE)], "utf16.csv"),
  );
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: ROW_4 });
});

test("R7: a file with one more record than the table loaded names no row", async () => {
  const query = await openDatabase();
  const columns = await stagedCsv(
    query,
    "extra-record.csv",
    MULTILINE,
    new File([`${MULTILINE}2026,A-100,10,140\n`], "extra-record.csv"),
  );
  assert.deepEqual(fileProblem(multilineProblem(columns)), { kind: "reason", message: NO_ROW });
});

test("R7: a table replaced without a load names no row", async () => {
  const query = await openDatabase();
  await stagedCsv(query, "stale.csv", MULTILINE);
  await query(`CREATE OR REPLACE TABLE data AS SELECT * FROM (VALUES
    ('2025', 'A', 1, '100'),
    ('2025', 'B', 2, '110'),
    ('2026', 'A', 3, 'missing'),
    ('2026', 'B', 4, '130')
  ) v(period, product, units, net_sales)`);
  const columns = await profileLoaded(query, "data");
  assert.deepEqual(
    fileProblem(
      input({
        columns,
        rows: 4,
        periodColumn: "period",
        periods: ["2025", "2026"],
        unitsColumn: "units",
        salesColumn: "",
      }),
    ),
    { kind: "reason", message: 'Sales must be a column of numbers, and "net_sales" holds text, such as "missing".' },
  );
});

test("R7: a clean numeric file does no source-row read or query", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const query = await openDatabase();
  const statements: string[] = [];
  const recording = async (sql: string) => {
    statements.push(sql);
    return query(sql);
  };
  const content = "period,Product,units,NET_SALES\n2025,A-100,10,100\n2026,A-100,11,110\n";
  const directory = await mkdtemp("/tmp/bridgekit-rows-");
  const source = path.join(directory, "clean.csv");
  await writeFile(source, content);
  let streams = 0;
  let buffers = 0;
  const file = new File([content], "clean.csv");
  const readStream = file.stream.bind(file);
  const readBuffer = file.arrayBuffer.bind(file);
  file.stream = () => {
    streams += 1;
    return readStream();
  };
  file.arrayBuffer = () => {
    buffers += 1;
    return readBuffer();
  };
  await stageCsvAndSwap(recording, file, "data", source);
  assert.equal(statements.some((sql) => sql.includes("__source")), false);
  assert.equal(statements.filter((sql) => sql.includes("duckdb_tables()")).length, 1);
  assert.equal(streams, 0);
  assert.equal(buffers, 0);
  const staged = statements.length;
  const columns = await profileLoaded(recording, "data");
  assert.equal(columns.length, 4);
  assert.deepEqual(
    fileProblem(
      input({
        columns,
        rows: 2,
        periodColumn: "period",
        periods: ["2025", "2026"],
        unitsColumn: "units",
        salesColumn: "NET_SALES",
      }),
    ),
    { kind: "none" },
  );
  assert.equal(streams, 0);
  assert.equal(buffers, 0);
  const profiled = statements.slice(staged);
  assert.equal(profiled.some((sql) => sql.includes("__source") || sql.includes("duckdb_tables()")), false);
});
