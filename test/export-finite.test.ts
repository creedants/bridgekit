import assert from "node:assert/strict";
import { test } from "node:test";
import { exportExcel, finiteOrBlank } from "../src/app/exportExcel.ts";
import { toExportCsv } from "../src/app/files.ts";
import type { BridgeConfig, BridgeResult, DataCheck, Level, Query, TieOut } from "../src/engine.ts";

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

const markerRow: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_target, key) => (typeof key === "symbol" ? undefined : key === "n" || key === "q0" ? 1 : 0),
  },
);

async function exportLevelWorkbook(levels: Level[]) {
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
    return "blob:sheets";
  };
  (URL as any).revokeObjectURL = () => {};
  const config: BridgeConfig = {
    table: "sales",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels,
  };
  const result: BridgeResult = {
    priorSales: 0,
    currentSales: 0,
    effects: [
      { key: "volume", label: "Volume", value: 0 },
      ...levels.map((level, i) => ({ key: `mix_${i + 1}`, label: `Mix: ${level.name}`, value: 0 })),
      { key: "price", label: "Price (like-for-like)", value: 0 },
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
    current: { period: "2026", inFile: 0, afterFilters: 0 },
  };
  const query: Query = async (sql: string) => {
    if (sql.startsWith("SELECT count(*)::DOUBLE AS n")) return [{ n: 0 }];
    if (sql.includes("GROUP BY")) {
      for (const level of levels) {
        for (const col of level.columns) {
          if (sql.includes(`"${col}"`)) {
            const row: Record<string, unknown> = {
              s0: 10,
              s1: 20,
              z0: 1,
              z1: 2,
              q0: 1,
              q1: 1,
              volume: 0,
              price: 0,
              new_config: 0,
              discontinued: 0,
              no_units: 0,
            };
            for (let i = 1; i <= levels.length; i++) row[`mix_${i}`] = 0;
            row[col] = `${col}_val`;
            return [row];
          }
        }
      }
    }
    return [markerRow];
  };
  try {
    await exportExcel(query, config, result, check, tieOut, ["Source: sheets.csv"]);
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

test("level sheets whose names differ only in case get unique names", async () => {
  const workbook = await exportLevelWorkbook([
    { name: "Product", columns: ["product"] },
    { name: "PRODUCT", columns: ["region"] },
  ]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const levels = names.filter((name) => name.startsWith("By "));
  assert.equal(levels.length, 2);
  assert.equal(new Set(levels.map((name) => name.toLowerCase())).size, 2);
  for (const name of levels) assert.ok(name.length <= 31, `${name} is over 31 characters`);
  assert.equal(levels[0], "By Product");
  assert.equal(levels[1], "By PRODUCT 2");
  const first = workbook.getWorksheet("By Product")!;
  assert.equal(first.getRow(1).getCell(1).value, "product");
  assert.equal(first.getRow(2).getCell(1).value, "product_val");
  const second = workbook.getWorksheet("By PRODUCT 2")!;
  assert.equal(second.getRow(1).getCell(1).value, "region");
  assert.equal(second.getRow(2).getCell(1).value, "region_val");
});

test("level sheets with long names that collide after the cut get unique names within 31 characters", async () => {
  const workbook = await exportLevelWorkbook([
    { name: "Quarterly product attribute grouping variant alpha one", columns: ["a1"] },
    { name: "QUARTERLY PRODUCT ATTRIBUTE GROUPING VARIANT ALPHA TWO", columns: ["a2"] },
  ]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const levels = names.filter((name) => name.startsWith("By "));
  assert.equal(levels.length, 2);
  assert.equal(new Set(levels.map((name) => name.toLowerCase())).size, 2);
  for (const name of levels) assert.ok(name.length <= 31, `${name} is over 31 characters`);
  assert.equal(levels[0], "By Quarterly product attribu");
  assert.equal(levels[1], "By QUARTERLY PRODUCT ATTRIBU 2");
  const first = workbook.getWorksheet("By Quarterly product attribu")!;
  assert.equal(first.getRow(1).getCell(1).value, "a1");
  assert.equal(first.getRow(2).getCell(1).value, "a1_val");
  const second = workbook.getWorksheet("By QUARTERLY PRODUCT ATTRIBU 2")!;
  assert.equal(second.getRow(1).getCell(1).value, "a2");
  assert.equal(second.getRow(2).getCell(1).value, "a2_val");
});

test("the tenth colliding level sheet carries a two-digit suffix within 31 characters", async () => {
  const levels = Array.from({ length: 10 }, (_, i) => ({
    name: i % 2 === 0 ? "Attribute" : "ATTRIBUTE",
    columns: [`c${i + 1}`],
  }));
  const workbook = await exportLevelWorkbook(levels);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const sheets = names.filter((name) => name.startsWith("By "));
  assert.equal(sheets.length, 10);
  assert.equal(new Set(sheets.map((name) => name.toLowerCase())).size, 10);
  for (const name of sheets) assert.ok(name.length <= 31, `${name} is over 31 characters`);
  assert.equal(sheets[9], "By ATTRIBUTE 10");
  sheets.forEach((sheetName, i) => {
    const sheet = workbook.getWorksheet(sheetName)!;
    assert.equal(sheet.getRow(1).getCell(1).value, `c${i + 1}`);
    assert.equal(sheet.getRow(2).getCell(1).value, `c${i + 1}_val`);
  });
});

test("level sheets with ordinary names keep their names", async () => {
  const workbook = await exportLevelWorkbook([
    { name: "Product", columns: ["product"] },
    { name: "Region", columns: ["region"] },
  ]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const levels = names.filter((name) => name.startsWith("By "));
  assert.deepEqual(levels, ["By Product", "By Region"]);
  const first = workbook.getWorksheet("By Product")!;
  assert.equal(first.getRow(1).getCell(1).value, "product");
  assert.equal(first.getRow(2).getCell(1).value, "product_val");
  const second = workbook.getWorksheet("By Region")!;
  assert.equal(second.getRow(1).getCell(1).value, "region");
  assert.equal(second.getRow(2).getCell(1).value, "region_val");
});
