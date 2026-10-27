import assert from "node:assert/strict";
import { test } from "node:test";
import type { Worksheet } from "exceljs";
import { exportExcel } from "../src/app/exportExcel.ts";
import { buildReport, moverHeader, terms, trendHeader } from "../src/app/report.ts";
import type { BridgeConfig, BridgeResult, DataCheck, Query, TieOut } from "../src/engine.ts";

const salesConfig: BridgeConfig = {
  table: "sales",
  periodColumn: "period",
  prior: "2025",
  current: "2026",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
};
const marginConfig: BridgeConfig = { ...salesConfig, costColumn: "cost" };

const salesResult: BridgeResult = {
  priorSales: 445,
  currentSales: 532,
  effects: [
    { key: "volume", label: "Volume", value: 63 },
    { key: "mix_1", label: "Mix: Product", value: 4 },
    { key: "price", label: "Price (like-for-like)", value: 28 },
    { key: "new_config", label: "New configurations", value: 0 },
    { key: "discontinued", label: "Discontinued configurations", value: 0 },
    { key: "no_units", label: "Sales with no units", value: 0 },
  ],
  coverage: [{ level: 1, label: "Exact configuration", cells: 2, sales: 532, share: 1 }],
  cellsTable: "bridge_cells",
};

const marginResult: BridgeResult = {
  priorSales: 121,
  currentSales: 155,
  effects: [
    { key: "volume", label: "Volume", value: 17 },
    { key: "mix_1", label: "Mix: Product", value: 0 },
    { key: "price_sales", label: "Price", value: 28 },
    { key: "cost_rate", label: "Unit cost", value: -11 },
    { key: "new_config", label: "New configurations", value: 0 },
    { key: "discontinued", label: "Discontinued configurations", value: 0 },
    { key: "no_units", label: "Sales with no units", value: 0 },
  ],
  coverage: [{ level: 1, label: "Exact configuration", cells: 2, sales: 155, share: 1 }],
  cellsTable: "bridge_cells",
};

const check: DataCheck = {
  rows: 4,
  priorRows: 2,
  currentRows: 2,
  otherPeriodRows: 0,
  blankPeriodRows: 0,
  blankMeasureRows: 0,
  negativeUnitRows: 0,
  negativeSalesRows: 0,
  zeroUnitSalesRows: 0,
};

const tieOut = (result: BridgeResult): TieOut => ({
  prior: { period: "2025", inFile: result.priorSales, afterFilters: result.priorSales },
  current: { period: "2026", inFile: result.currentSales, afterFilters: result.currentSales },
});

const zeroRow: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_target, key) => (typeof key === "symbol" ? undefined : key === "n" || key === "q0" ? 1 : 0),
  },
);
const query: Query = async () => [zeroRow];

async function exportedWorkbook(config: BridgeConfig, result: BridgeResult, description: string[]) {
  const { default: ExcelJS } = await import("exceljs");
  const captured: { blob?: Blob } = {};
  const realDocument = (globalThis as any).document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  (globalThis as any).document = { createElement: () => ({ href: "", download: "", click() {} }) };
  (URL as any).createObjectURL = (blob: Blob) => {
    captured.blob = blob;
    return "blob:margin-labels";
  };
  (URL as any).revokeObjectURL = () => {};
  try {
    await exportExcel(query, config, result, check, tieOut(result), description);
  } finally {
    (globalThis as any).document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
  assert.ok(captured.blob, "the export downloaded a workbook");
  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  return workbook;
}

const setupDescription = [
  "Source: sample.csv",
  "Sales column: sales",
  "Cost column: cost (bridge is on margin)",
];

/** The header row of a sheet as cell text. */
const headerRow = (sheet: Worksheet, row = 1) => {
  const cells: string[] = [];
  for (let column = 1; column <= 24; column++) {
    const value = sheet.getRow(row).getCell(column).value;
    if (value === null || value === undefined) break;
    cells.push(String(value));
  }
  return cells;
};

test("a margin workbook names margin on every sheet that shows the measure", async () => {
  const workbook = await exportedWorkbook(marginConfig, marginResult, [
    "Source: sample.csv",
    "Sales column: sales",
    "Cost column: cost (bridge is on margin)",
    "Attribute 1: Product (product)",
  ]);

  const bridge = workbook.getWorksheet("Bridge")!;
  assert.deepEqual(headerRow(bridge, 3), ["", "Amount", "% of prior margin"], "Bridge share header");

  const coverage = workbook.getWorksheet("Match coverage")!;
  assert.deepEqual(headerRow(coverage), ["Compared against", "Share", "Current margin", "Configurations"]);

  const byProduct = workbook.getWorksheet("By Product")!;
  assert.deepEqual(headerRow(byProduct).slice(1, 4), ["Prior margin", "Current margin", "Change"]);

  const bands = workbook.getWorksheet("Price bands")!;
  assert.deepEqual(headerRow(bands), [
    "Change in average price",
    "Share",
    "Current margin",
    "Price effect",
    "Configurations",
  ]);

  const detail = workbook.getWorksheet("Detail")!;
  const detailHeader = headerRow(detail);
  assert.ok(detailHeader.includes("Prior margin with units"), "Detail keeps the prior margin column");
  assert.ok(detailHeader.includes("Current margin with units"), "Detail keeps the current margin column");

  const setup = workbook.getWorksheet("Setup")!;
  let salesLine = "";
  setup.eachRow((row) => {
    if (row.getCell(1).value === "Sales column") salesLine = String(row.getCell(2).value);
  });
  assert.equal(salesLine, "sales", "the Setup sheet still names the file's sales column");
  let costLine = "";
  setup.eachRow((row) => {
    if (row.getCell(1).value === "Cost column") costLine = String(row.getCell(2).value);
  });
  assert.equal(costLine, "cost (bridge is on margin)", "the Setup sheet keeps the cost line");
});

test("a margin workbook keeps the file's sales columns in Detail", async () => {
  const workbook = await exportedWorkbook(marginConfig, marginResult, setupDescription);
  const detail = headerRow(workbook.getWorksheet("Detail")!);
  assert.ok(detail.includes("Prior sales, no units"), "sales with no units keeps its file name");
  assert.ok(detail.includes("Prior sales with units"), "the raw sales column keeps its name");
});

test("a sales workbook keeps the sales headers it shows today", async () => {
  const workbook = await exportedWorkbook(salesConfig, salesResult, ["Source: sample.csv", "Sales column: sales"]);

  assert.deepEqual(headerRow(workbook.getWorksheet("Bridge")!, 3), ["", "Amount", "% of prior sales"]);
  assert.deepEqual(headerRow(workbook.getWorksheet("Match coverage")!), [
    "Compared against",
    "Share",
    "Current sales",
    "Configurations",
  ]);
  assert.deepEqual(headerRow(workbook.getWorksheet("By Product")!).slice(1, 4), [
    "Prior sales",
    "Current sales",
    "Change",
  ]);
  assert.deepEqual(headerRow(workbook.getWorksheet("Price bands")!), [
    "Change in average price",
    "Share",
    "Current sales",
    "Price effect",
    "Configurations",
  ]);
});

const report = (config: BridgeConfig, result: BridgeResult) =>
  buildReport({
    config,
    result,
    description: ["Source: sample.csv", "Sales column: sales"],
    movers: { label: "Product", rows: [], columns: ["product"] },
    priceBands: [{ label: "No change (within 0.5%)", cells: 2, sales: 155, share: 1, priceEffect: 16 }],
  });

test("a margin report names margin in the matched table and the share header", () => {
  const html = report(marginConfig, marginResult);
  assert.equal(html.includes("<h2>How current margin was matched</h2>"), true, "the matched heading names margin");
  assert.equal(html.includes("Share of matched margin"), true, "the band share header names margin");
  assert.equal(html.includes("How current sales were matched"), false, "the matched heading still says sales");
  assert.equal(html.includes("Share of matched sales"), false, "the band share header still says sales");
  assert.equal(html.includes("% of prior margin"), true, "the bridge header lost its margin wording");
  assert.equal(html.includes("<h1>Margin bridge: 2025 to 2026</h1>"), true, "the report title lost its margin wording");
  assert.deepEqual(moverHeader(marginConfig).slice(0, 2), ["Prior margin", "Current margin"]);
  assert.equal(terms(marginConfig).priceEffect, "Price and unit cost");
});

test("a sales report keeps the sales headings it shows today", () => {
  const html = report(salesConfig, salesResult);
  assert.equal(html.includes("<h2>How current sales were matched</h2>"), true);
  assert.equal(html.includes("Share of matched sales"), true);
  assert.equal(html.includes("% of prior sales"), true);
  assert.equal(html.includes("Margin"), false, "the sales report names margin");
});

test("the Trend tab header list adds Unit cost only on a margin bridge", () => {
  assert.deepEqual(trendHeader(marginConfig).map((column) => column.label), [
    "Periods",
    "Change",
    "Volume",
    "Mix",
    "Price",
    "Unit cost",
    "Price, % of prior",
    "Price effect",
    "New and discontinued",
    "No units",
  ]);
  assert.deepEqual(trendHeader(salesConfig).map((column) => column.label), [
    "Periods",
    "Change",
    "Volume",
    "Mix",
    "Price",
    "Price, % of prior",
    "Price effect",
    "New and discontinued",
    "No units",
  ]);
});
