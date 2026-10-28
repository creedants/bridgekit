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

async function profiledColumns(sql: string): Promise<Column[]> {
  const query = await openDatabase();
  await query(`CREATE TABLE data AS ${sql}`);
  return profileLoaded(query, "data");
}

/** Describes the loaded table, profiles it, and returns the columns the profile applied. */
async function profileLoaded(query: Awaited<ReturnType<typeof openDatabase>>, table: string): Promise<Column[]> {
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
  const { default: ExcelJS } = await import("exceljs");
  const { firstSheetAsCsv } = await import("../src/app/sheet.ts");
  const { readCsvTable, recordSourceRows } = await import("../src/app/db.ts");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["period", "Product", "units", "NET_SALES"]);
  sheet.addRow(["2025", "A-100", 10, 100]);
  sheet.addRow([]);
  sheet.addRow(["2025", "A-100", 10, 110]);
  sheet.addRow(["2026", "A-100", 10, "n/a"]);
  sheet.addRow(["2026", "A-100", 10, 130]);
  const flat = await firstSheetAsCsv(new File([await workbook.xlsx.writeBuffer()], "blank.xlsx"));
  const directory = await mkdtemp("/tmp/bridgekit-rows-");
  const flatPath = path.join(directory, "blank-flat.csv");
  await writeFile(flatPath, flat.csv);
  const query = await openDatabase();
  await readCsvTable(query, "data", flatPath);
  await recordSourceRows(query, "data", flat.dataRows);
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
