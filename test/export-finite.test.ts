import assert from "node:assert/strict";
import { test } from "node:test";
import { exportExcel, finiteOrBlank } from "../src/app/exportExcel.ts";
import { toExportCsv } from "../src/app/files.ts";
import type { BridgeBy, BridgeConfig, BridgeResult, DataCheck, Level, Query, TieOut } from "../src/engine.ts";

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

function validSheetName(name: string): boolean {
  if (name.length === 0 || name.length > 31) return false;
  if (name.startsWith("'") || name.endsWith("'")) return false;
  if (/[\\/*?:[\]]/.test(name)) return false;
  return true;
}

test("By sheets with a cut that ends in an apostrophe export with valid names (T305)", async () => {
  const cutName = `${"A".repeat(24)}' more`;
  const workbook = await exportLevelWorkbook([
    { name: cutName, columns: ["cut_col"] },
    { name: "Ends with apostrophe'", columns: ["end_col"] },
    { name: "Customer's", columns: ["ok_col"] },
  ]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const levels = names.filter((name) => name.startsWith("By "));
  assert.equal(levels.length, 3);
  for (const name of levels) assert.ok(validSheetName(name), `${name} is not a valid sheet name`);
  assert.equal(new Set(levels.map((name) => name.toLowerCase())).size, 3);
  assert.ok(levels.includes("By Customer's"), "valid Customer's name stays exactly By Customer's");
  const cutSheet = levels.find((name) => name !== "By Customer's" && name.includes("A".repeat(10)))!;
  assert.ok(cutSheet, "the cut name kept its sheet");
  assert.equal(cutSheet.endsWith("'"), false);
});

async function exportCappedWorkbook(levels: Level[], available: Record<string, number>) {
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
    return "blob:capped";
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
    if (sql.includes("GROUP BY") && sql.includes("ORDER BY abs(")) {
      for (const level of levels) {
        for (const col of level.columns) {
          if (sql.includes(`"${col}"`)) {
            const total = available[col] ?? 1;
            const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
            const limit = limitMatch ? Number.parseInt(limitMatch[1], 10) : total;
            const count = Math.min(limit, total);
            return Array.from({ length: count }, (_, i) => {
              const row: Record<string, unknown> = {
                s0: 10,
                s1: 20 + i,
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
              for (let k = 1; k <= levels.length; k++) row[`mix_${k}`] = 0;
              row[col] = `${col}_val_${i}`;
              return row;
            });
          }
        }
      }
    }
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
            for (let k = 1; k <= levels.length; k++) row[`mix_${k}`] = 0;
            row[col] = `${col}_val`;
            return [row];
          }
        }
      }
    }
    return [markerRow];
  };
  try {
    await exportExcel(query, config, result, check, tieOut, ["Source: capped.csv"]);
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

test("a By sheet with more than 5000 drill rows names the cap on the sheet (T260)", async () => {
  const expectedNote =
    "This sheet shows the 5,000 rows with the largest change. The Bridge sheet totals include every row.";
  const workbook = await exportCappedWorkbook(
    [
      { name: "Big", columns: ["big"] },
      { name: "Exact", columns: ["exact"] },
    ],
    { big: 6000, exact: 5000 },
  );
  const big = workbook.getWorksheet("By Big")!;
  assert.equal(big.getRow(1).getCell(1).value, "big");
  assert.equal(big.rowCount, 1 + 5000 + 1);
  assert.equal(big.getRow(5001).getCell(1).value, "big_val_4999");
  assert.equal(big.getRow(5002).getCell(1).value, expectedNote);
  const exact = workbook.getWorksheet("By Exact")!;
  assert.equal(exact.getRow(1).getCell(1).value, "exact");
  assert.equal(exact.rowCount, 1 + 5000);
  assert.equal(exact.getRow(5001).getCell(1).value, "exact_val_4999");
  let foundNote = false;
  exact.eachRow((row) => {
    if (row.getCell(1).value === expectedNote) foundNote = true;
  });
  assert.equal(foundNote, false, "a sheet at the cap carries no note");
});

test("one hundred attributes sharing a 28-character base get unique width-trimmed names (T306)", async () => {
  const prefix = "A".repeat(25);
  const levels = Array.from({ length: 100 }, (_, i) => ({
    name: `${prefix} extra ${i + 1}`,
    columns: [`c${i + 1}`],
  }));
  const workbook = await exportLevelWorkbook(levels);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const sheets = names.filter((name) => name.startsWith("By "));
  assert.equal(sheets.length, 100);
  assert.equal(new Set(sheets.map((name) => name.toLowerCase())).size, 100);
  for (const name of sheets) {
    assert.ok(name.length <= 31, `${name} is over 31 characters`);
    assert.ok(validSheetName(name), `${name} is not a valid sheet name`);
  }
  const base28 = `By ${prefix}`;
  assert.equal(base28.length, 28);
  const expected100 = `${base28.slice(0, 27)} 100`;
  assert.equal(expected100.length, 31);
  assert.equal(sheets[99], expected100);
  sheets.forEach((sheetName, i) => {
    const sheet = workbook.getWorksheet(sheetName)!;
    assert.equal(sheet.getRow(1).getCell(1).value, `c${i + 1}`);
    assert.equal(sheet.getRow(2).getCell(1).value, `c${i + 1}_val`);
  });
});

test("truncation-only collision gets a numbered name within 31 characters", async () => {
  const workbook = await exportLevelWorkbook([
    { name: "Quarterly product attribute grouping variant alpha one", columns: ["t1"] },
    { name: "Quarterly product attribute grouping variant alpha two", columns: ["t2"] },
  ]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const levels = names.filter((name) => name.startsWith("By "));
  assert.equal(levels.length, 2);
  assert.equal(new Set(levels.map((name) => name.toLowerCase())).size, 2);
  for (const name of levels) {
    assert.ok(name.length <= 31, `${name} is over 31 characters`);
    assert.ok(validSheetName(name), `${name} is not a valid sheet name`);
  }
  assert.equal(levels[0], "By Quarterly product attribu");
  assert.equal(levels[1], "By Quarterly product attribu 2");
  assert.equal(workbook.getWorksheet(levels[0])!.getRow(2).getCell(1).value, "t1_val");
  assert.equal(workbook.getWorksheet(levels[1])!.getRow(2).getCell(1).value, "t2_val");
});

test("ten same-name sheets keep the two-digit suffix in range", async () => {
  const levels = Array.from({ length: 10 }, (_, i) => ({
    name: "Attribute",
    columns: [`u${i + 1}`],
  }));
  const workbook = await exportLevelWorkbook(levels);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const sheets = names.filter((name) => name.startsWith("By "));
  assert.equal(sheets.length, 10);
  assert.equal(new Set(sheets.map((name) => name.toLowerCase())).size, 10);
  for (const name of sheets) {
    assert.ok(name.length <= 31, `${name} is over 31 characters`);
    assert.ok(validSheetName(name), `${name} is not a valid sheet name`);
  }
  assert.equal(sheets[9], "By Attribute 10");
  sheets.forEach((sheetName, i) => {
    const sheet = workbook.getWorksheet(sheetName)!;
    assert.equal(sheet.getRow(1).getCell(1).value, `u${i + 1}`);
    assert.equal(sheet.getRow(2).getCell(1).value, `u${i + 1}_val`);
  });
});

test("the Setup sheet keeps a -0 money tie-out line displayed as -0 (T237)", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const captured: { blob?: Blob } = {};
  const realDocument = (globalThis as any).document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  (globalThis as any).document = { createElement: () => ({ href: "", download: "", click() {} }) };
  (URL as any).createObjectURL = (blob: Blob) => {
    captured.blob = blob;
    return "blob:zero-sign";
  };
  (URL as any).revokeObjectURL = () => {};

  const config: BridgeConfig = {
    table: "sales",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    costColumn: "cost",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  const effects = [
    { key: "volume", label: "Volume", value: 0 },
    { key: "mix_1", label: "Mix: Product", value: 0 },
    { key: "price_sales", label: "Price", value: 0 },
    { key: "cost_rate", label: "Unit cost", value: 0 },
    { key: "new_config", label: "New configurations", value: 0 },
    { key: "discontinued", label: "Discontinued configurations", value: 0 },
    { key: "no_units", label: "Sales with no units", value: 0 },
  ];
  // A prior total that rounds to -0 and a current total that rounds to +0, so both zero signs meet one column.
  const result: BridgeResult = { priorSales: -0.3, currentSales: 0.4, effects, coverage: [], cellsTable: "bridge_cells" };
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
    prior: { period: "2025", inFile: -0.3, afterFilters: -0.3 },
    current: { period: "2026", inFile: 0.4, afterFilters: 0.4 },
  };
  const query: Query = async () => [markerRow];
  try {
    await exportExcel(query, config, result, check, tieOut, ["Source: zero-sign.csv"]);
  } finally {
    (globalThis as any).document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
  assert.ok(captured.blob, "the export downloaded a workbook");  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);

  /** The digits Excel shows for a number with this format, sectioned by sign. A quoted section is literal text. */
  const shown = (value: unknown, numFmt: string): string => {
    const number = Number(value);
    const [positive, negative, zero] = numFmt.split(";");
    const section = number === 0 ? zero ?? positive : number < 0 ? negative ?? positive : positive;
    const pattern = section.replace(/"[^"]*"/g, "");
    const text = section.replaceAll('"', "");
    if (!/[#0]/.test(pattern)) return text;
    const digits = Math.abs(Math.round(number)).toLocaleString("en-US");
    return text.replace(/-?[#0][#0,]*/, (number < 0 ? "-" : "") + digits);
  };

  const cells = new Map<string, { value: unknown; shown: string }>();
  workbook.getWorksheet("Setup")!.eachRow((row) => {
    const label = String(row.getCell(1).value ?? "");
    if (label.startsWith("Margin")) {
      cells.set(label, { value: row.getCell(2).value, shown: shown(row.getCell(2).value, String(row.getCell(2).numFmt ?? "")) });
    }
  });
  const priorFile = cells.get("Margin in file, 2025");
  const priorBridge = cells.get("Margin in the bridge, 2025");
  const currentFile = cells.get("Margin in file, 2026");
  assert.ok(priorFile && priorBridge && currentFile, "the Setup sheet holds both tie-out periods");
  for (const [name, cell] of [["prior file", priorFile], ["prior bridge", priorBridge]] as const) {
    assert.equal(typeof cell.value, "number", `${name} stays numeric`);
    assert.equal(cell.shown, "-0", `${name} shows the sign the app shows`);
  }
  assert.equal(currentFile.shown, "0", "a positive zero keeps its plain zero");
  assert.equal(typeof currentFile.value, "number", "a positive zero stays numeric");
});

test("tied By groups keep the limit-5000 rows and order with a cap note only over the cap (D79-2)", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { runBridge, drill, dataCheck, periodMoney } = await import("../src/engine.ts");
  const { default: ExcelJS } = await import("exceljs");
  const expectedNote =
    "This sheet shows the 5,000 rows with the largest change. The Bridge sheet totals include every row.";
  for (const total of [4999, 5000, 6000]) {
    const query = await openDatabase();
    await query(`SET threads=1`);
    await query(
      `CREATE OR REPLACE TABLE sales AS SELECT period, 'P' || i::VARCHAR AS product, 1.0 AS units, CASE WHEN period='2025' THEN 10.0 ELSE 11.0 + (i % 2) END AS sales FROM range(${total}) r(i) CROSS JOIN (VALUES ('2025'),('2026')) p(period)`,
    );
    const config = {
      table: "sales",
      periodColumn: "period",
      prior: "2025",
      current: "2026",
      unitsColumn: "units",
      salesColumn: "sales",
      levels: [{ name: "Product", columns: ["product"] }],
    };
    const result = await runBridge(query, config);
    const canonical = await drill(query, config, { columns: ["product"], limit: 5000 });
    assert.equal(canonical.length, Math.min(total, 5000), `canonical holds ${Math.min(total, 5000)} rows at ${total}`);
    const repeat = await drill(query, config, { columns: ["product"], limit: 5000 });
    assert.deepEqual(
      repeat.map((row) => String(row.product)),
      canonical.map((row) => String(row.product)),
      `the limit-5000 order repeats at ${total}`,
    );
    const check = await dataCheck(query, config);
    const tieOut = await periodMoney(query, config, { table: "sales", periodColumn: "period" });
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
      return "blob:tied";
    };
    (URL as any).revokeObjectURL = () => {};
    try {
      await exportExcel(query, config, result, check, tieOut, ["Source: tied.csv"]);
    } finally {
      (globalThis as any).document = realDocument;
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
    assert.ok(captured.blob, `the export downloaded a workbook at ${total}`);
    const bytes = new Uint8Array(await captured.blob.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as any);
    const sheet = workbook.getWorksheet("By Product")!;
    assert.equal(sheet.getRow(1).getCell(1).value, "product");
    const effectKeys = result.effects.map((effect) => effect.key);
    if (total <= 5000) {
      assert.equal(sheet.rowCount, 1 + total, `4999 and 5000 keep every row at ${total}`);
      let foundNote = false;
      sheet.eachRow((row) => {
        if (row.getCell(1).value === expectedNote) foundNote = true;
      });
      assert.equal(foundNote, false, `no note at or below the cap at ${total}`);
      for (let i = 0; i < canonical.length; i++) {
        const row = sheet.getRow(2 + i);
        const expected = canonical[i];
        const prior = Number(expected.s0) + Number(expected.z0);
        const current = Number(expected.s1) + Number(expected.z1);
        assert.equal(row.getCell(1).value, String(expected.product), `row ${i} keeps its group at ${total}`);
        assert.equal(row.getCell(2).value, prior, `row ${i} keeps prior at ${total}`);
        assert.equal(row.getCell(3).value, current, `row ${i} keeps current at ${total}`);
        assert.equal(row.getCell(4).value, current - prior, `row ${i} keeps change at ${total}`);
        effectKeys.forEach((key, j) => {
          assert.equal(row.getCell(5 + j).value, Number(expected[key]), `row ${i} keeps ${key} at ${total}`);
        });
      }
    } else {
      assert.equal(sheet.rowCount, 1 + 5000 + 1, `over the cap keeps 5000 rows plus the note at ${total}`);
      for (let i = 0; i < 5000; i++) {
        const row = sheet.getRow(2 + i);
        const expected = canonical[i];
        const prior = Number(expected.s0) + Number(expected.z0);
        const current = Number(expected.s1) + Number(expected.z1);
        assert.equal(row.getCell(1).value, String(expected.product), `row ${i} keeps its group at ${total}`);
        assert.equal(row.getCell(2).value, prior, `row ${i} keeps prior at ${total}`);
        assert.equal(row.getCell(3).value, current, `row ${i} keeps current at ${total}`);
        assert.equal(row.getCell(4).value, current - prior, `row ${i} keeps change at ${total}`);
        effectKeys.forEach((key, j) => {
          assert.equal(row.getCell(5 + j).value, Number(expected[key]), `row ${i} keeps ${key} at ${total}`);
        });
      }
      assert.equal(sheet.getRow(5002).getCell(1).value, expectedNote, `the note follows 5000 data rows at ${total}`);
    }
  }
});

test("a workbook exported with a split holds the grid as its own last sheet", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const captured: { blob?: Blob } = {};
  const realDocument = (globalThis as any).document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  (globalThis as any).document = { createElement: () => ({ href: "", download: "", click() {} }) };
  (URL as any).createObjectURL = (blob: Blob) => {
    captured.blob = blob;
    return "blob:split";
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
  const panelBridge: BridgeResult = {
    priorSales: 1000,
    currentSales: 1200,
    effects: [{ key: "volume", label: "Volume", value: Number.NaN }],
    coverage: [],
    cellsTable: "",
  };
  const result: BridgeResult = {
    priorSales: 1000,
    currentSales: 1250,
    effects: [
      { key: "volume", label: "Volume", value: 0 },
      { key: "mix_1", label: "Mix: Product", value: 0 },
      { key: "price", label: "Price (like-for-like)", value: 250 },
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
    prior: { period: "2025", inFile: 1000, afterFilters: 1000 },
    current: { period: "2026", inFile: 1250, afterFilters: 1250 },
  };
  const split: BridgeBy = {
    column: "region",
    total: result,
    between: [{ key: "volume", label: "Volume", value: 250 }],
    panels: [
      {
        combined: false,
        value: "East",
        values: 1,
        status: "continuing",
        priorSales: 1000,
        currentSales: 1200,
        change: 200,
        result: panelBridge,
      },
      {
        combined: false,
        value: null,
        values: 1,
        status: "new",
        priorSales: 0,
        currentSales: 50,
        change: 50,
        result: null,
      },
    ],
  };
  const query: Query = async () => [markerRow];
  try {
    await exportExcel(query, config, result, check, tieOut, ["Source: split.csv"], undefined, split);
  } finally {
    (globalThis as any).document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
  assert.ok(captured.blob, "the export downloaded a workbook");
  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  assert.equal(names.at(-1), "Small bridges");
  const sheet = workbook.getWorksheet("Small bridges")!;
  assert.equal(sheet.getRow(1).getCell(1).value, "Split by: region");
  const labels = new Set<string>();
  sheet.eachRow((row) => labels.add(String(row.getCell(1).value ?? "")));
  assert.ok(labels.has("East"), "the sheet holds every value title");
  assert.ok(labels.has("(blank)"), "the sheet holds the blank value title");
  assert.ok(labels.has("New"), "the sheet holds the status word");
  assert.ok(labels.has("Volume"), "the sheet holds the step labels");
  let last = "";
  sheet.eachRow((row) => {
    const text = String(row.getCell(1).value ?? "");
    if (text) last = text;
  });
  assert.ok(last.includes("Volume"), "the between line closes the sheet");
  let blanks = 0;
  let nonFinite = 0;
  sheet.eachRow((row) => {
    const value = row.getCell(2).value;
    if (value === null || value === "") blanks += 1;
    if (typeof value === "number" && !Number.isFinite(value)) nonFinite += 1;
  });
  assert.ok(blanks > 0, "a step with no finite value stays blank");
  assert.equal(nonFinite, 0, "no cell holds NaN or Infinity");
});
