import assert from "node:assert/strict";
import { test } from "node:test";
import { exportExcel, finiteOrBlank } from "../src/app/exportExcel.ts";
import { toExportCsv } from "../src/app/files.ts";
import type { BridgeConfig, BridgeResult, DataCheck, Query, TieOut } from "../src/engine.ts";

test("finiteOrBlank keeps everything except a number that is not finite", () => {
  assert.equal(finiteOrBlank(12.5), 12.5);
  assert.equal(finiteOrBlank(0), 0);
  assert.equal(finiteOrBlank("12.5"), "12.5");
  assert.equal(finiteOrBlank(null), null);
  assert.equal(finiteOrBlank(undefined), undefined);
  assert.equal(finiteOrBlank(Number.NaN), null);
  assert.equal(finiteOrBlank(Number.POSITIVE_INFINITY), null);
  assert.equal(finiteOrBlank(Number.NEGATIVE_INFINITY), null);
});

test("a CSV exported through finiteOrBlank leaves an empty field where the row held a non-finite number", () => {
  const rows = [
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    ["ok", 2.5],
  ];
  const csv = toExportCsv(["a", "b"], rows.map((row) => row.map(finiteOrBlank)));
  assert.equal(csv, ["a,b", "1,", ",", "ok,2.5"].join("\n"));
  assert.equal(csv.includes("NaN"), false);
  assert.equal(csv.includes("Infinity"), false);
});

test("a workbook exported with zero prior sales carries no NaN or Infinity and no cached share", async () => {
  const { default: JSZip } = await import("jszip");
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
    return "blob:repro";
  };
  (URL as any).revokeObjectURL = () => {};

  const config: BridgeConfig = {
    table: "sales",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  const result: BridgeResult = {
    priorSales: 0,
    currentSales: 1200,
    effects: [
      { key: "volume", label: "Volume", value: 0 },
      { key: "mix_1", label: "Mix: Product", value: 0 },
      { key: "price", label: "Price (like-for-like)", value: 1200 },
      { key: "new_config", label: "New configurations", value: 0 },
      { key: "discontinued", label: "Discontinued configurations", value: 0 },
      { key: "no_units", label: "Sales with no units", value: 0 },
    ],
    coverage: [],
    cellsTable: "bridge_cells",
  };
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
  const tieOut: TieOut = {
    prior: { period: "2025", inFile: 0, afterFilters: 0 },
    current: { period: "2026", inFile: 1200, afterFilters: 1200 },
  };
  const zeroRow: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, key) => (typeof key === "symbol" ? undefined : key === "n" || key === "q0" ? 1 : 0),
    },
  );
  const query: Query = async () => [zeroRow];

  try {
    await exportExcel(query, config, result, check, tieOut, ["Source: repro.csv"]);
  } finally {
    (globalThis as any).document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }

  assert.ok(captured.blob, "the export downloaded a workbook");
  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  const zip = await JSZip.loadAsync(bytes);
  const sheets = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/.+\.xml$/.test(name));
  assert.ok(sheets.length > 0, "the workbook holds worksheets");
  for (const name of sheets) {
    const xml = await zip.file(name)!.async("string");
    assert.equal(xml.includes("NaN"), false, `${name} holds NaN`);
    assert.equal(xml.includes("Infinity"), false, `${name} holds Infinity`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  const bridge = workbook.getWorksheet("Bridge")!;
  let shareRow = 0;
  bridge.eachRow((row) => {
    if (row.getCell(1).value === "Price (like-for-like)") shareRow = row.number;
  });
  assert.notEqual(shareRow, 0, "the workbook holds the price effect row");
  const share = bridge.getRow(shareRow).getCell(3).value as { formula?: string; result?: unknown };
  assert.equal(share.formula, `IF(B4=0,"",B${shareRow}/B4)`);
  assert.equal("result" in share, false, "the share cell carries no cached result");
});
