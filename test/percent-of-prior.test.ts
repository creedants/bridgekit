import assert from "node:assert/strict";
import { test } from "node:test";
import { exportExcel } from "../src/app/exportExcel.ts";
import { buildReport } from "../src/app/report.ts";
import type { BridgeConfig, BridgeResult, DataCheck, Query, TieOut } from "../src/engine.ts";

const config: BridgeConfig = {
  table: "sales",
  periodColumn: "period",
  prior: "2025",
  current: "2026",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
};

const bridge = (priorSales: number, currentSales: number, price: number): BridgeResult => ({
  priorSales,
  currentSales,
  effects: [
    { key: "volume", label: "Volume", value: 0 },
    { key: "mix_1", label: "Mix: Product", value: 0 },
    { key: "price", label: "Price (like-for-like)", value: price },
    { key: "new_config", label: "New configurations", value: 0 },
    { key: "discontinued", label: "Discontinued configurations", value: 0 },
    { key: "no_units", label: "Sales with no units", value: 0 },
  ],
  coverage: [],
  cellsTable: "bridge_cells",
});

const check: DataCheck = {
  rows: 0,
  priorRows: 0,
  currentRows: 0,
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

const report = (result: BridgeResult) =>
  buildReport({
    config,
    result,
    description: ["Source: sample.csv", "Periods: 2025 to 2026 (period, by month)"],
    movers: { label: "Product", rows: [], columns: ["product"] },
    priceBands: [],
  });

/** The Bridge section's first table as ordered cell text. */
const bridgeRows = (html: string): string[][] => {
  const section = html.match(/<h2>Bridge<\/h2>([\s\S]*?)(?=<h2>|$)/)?.[1] ?? "";
  const start = section.indexOf("<table");
  const end = section.indexOf("</table>", start);
  assert.ok(start !== -1 && end > start, "the report holds a Bridge table");
  return [...section.slice(start, end).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, text]) => text.trim()),
  );
};

const PRICE_LABEL = "Price (like-for-like)";

const priceRowOf = (html: string) => {
  const row = bridgeRows(html).find(([label]) => label === PRICE_LABEL);
  assert.ok(row, `the report holds the ${PRICE_LABEL} effect row`);
  return row;
};

async function exportBridge(result: BridgeResult) {
  const { default: ExcelJS } = await import("exceljs");
  const captured: { blob?: Blob } = {};
  const fakeDocument = {
    createElement: () => ({ href: "", download: "", click() {} }),
  };
  const realDocument = (globalThis as any).document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  (globalThis as any).document = fakeDocument;
  (URL as any).createObjectURL = (blob: Blob) => {
    captured.blob = blob;
    return "blob:percent-of-prior";
  };
  (URL as any).revokeObjectURL = () => {};
  try {
    await exportExcel(query, config, result, check, tieOut(result), ["Source: sample.csv"]);
  } finally {
    (globalThis as any).document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
  assert.ok(captured.blob, "the export downloaded a workbook");
  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  const sheet = workbook.getWorksheet("Bridge")!;
  let shareRow = 0;
  sheet.eachRow((row) => {
    if (row.getCell(1).value === PRICE_LABEL) shareRow = row.number;
  });
  assert.notEqual(shareRow, 0, "the workbook holds the price effect row");
  const cell = sheet.getRow(shareRow).getCell(3).value as { formula?: string; result?: unknown };
  return { shareRow, cell };
}

test("shareOfPrior divides by the absolute prior and keeps the value's sign", async () => {
  const format = await import("../src/app/format.ts");
  assert.equal(typeof format.shareOfPrior, "function", "shareOfPrior is exported");
  assert.equal(format.shareOfPrior(100, 1000), 0.1, "a positive prior divides as before");
  assert.equal(format.shareOfPrior(100, -1000), 0.1, "a negative prior keeps a positive effect positive");
  assert.equal(format.shareOfPrior(-100, -1000), -0.1, "a negative prior keeps a negative effect negative");
  const zero = format.shareOfPrior(100, 0);
  assert.equal(Number.isFinite(zero), false, "a zero prior gives a non-finite result");
  assert.equal(format.signedPercent(zero), "", "a zero prior prints blank as signed percent");
  assert.equal(format.percent(zero), "", "a zero prior prints blank as percent");
});

test("a report with a negative prior total shows the price effect as a positive percentage", () => {
  const price = priceRowOf(report(bridge(-1000, -900, 100)));
  assert.deepEqual(price, [PRICE_LABEL, "+100", "+10.0%"], "the price effect lost its sign in the report");
});

test("a workbook with a negative prior total divides the share by the absolute prior", async () => {
  const { shareRow, cell } = await exportBridge(bridge(-1000, -900, 100));
  assert.equal(cell.formula, `IF(B4=0,"",B${shareRow}/ABS(B4))`, "the formula divides by the raw prior total");
  assert.equal(cell.result, 0.1, "the cached share lost its sign");
});

test("a positive prior total keeps the report text, formula and cached share it shows today", async () => {
  const result = bridge(1000, 1100, 100);
  const price = priceRowOf(report(result));
  assert.deepEqual(price, [PRICE_LABEL, "+100", "+10.0%"], "the report changed for a positive prior total");
  const { shareRow, cell } = await exportBridge(result);
  assert.equal(cell.formula, `IF(B4=0,"",B${shareRow}/B4)`, "the positive formula changed");
  assert.equal(cell.result, 0.1, "the positive cached share changed");
});
