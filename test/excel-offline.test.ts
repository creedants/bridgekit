import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { excelLoader, excelSheetAsCsv, exportExcel } from "../src/app/exportExcel.ts";
import type { BridgeConfig, BridgeResult, DataCheck, Query, TieOut } from "../src/engine.ts";

const SENTENCE = "The Excel tools could not load. Check your internet connection and try again.";
const RAW_FAILURE = "Failed to fetch dynamically imported module: http://127.0.0.1:4179/assets/exceljs.min-abc123.js";

// One importer for both actions, failing the way Chromium fails a chunk import while offline.
function offlineThenOnline() {
  let online = false;
  const tools = excelLoader(() => (online ? import("exceljs") : Promise.reject(new TypeError(RAW_FAILURE))));
  return {
    tools,
    reconnect() {
      online = true;
    },
  };
}

function assertSentence(error: unknown): true {
  assert.equal(error instanceof Error ? error.message : String(error), SENTENCE, "the action shows the Excel tools sentence");
  return true;
}

const zeroRow: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_target, key) => (typeof key === "symbol" ? undefined : key === "n" || key === "q0" ? 1 : 0),
  },
);

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

const query: Query = async () => [zeroRow];

test("Export Excel says the Excel tools sentence offline, then downloads a workbook after reconnecting", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const { tools, reconnect } = offlineThenOnline();
  const downloads: Blob[] = [];
  const realDocument = (globalThis as any).document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  (globalThis as any).document = { createElement: () => ({ href: "", download: "", click() {} }) };
  (URL as any).createObjectURL = (blob: Blob) => {
    downloads.push(blob);
    return "blob:offline";
  };
  (URL as any).revokeObjectURL = () => {};

  try {
    await assert.rejects(
      exportExcel(query, config, result, check, tieOut, ["Source: offline.csv"], tools),
      assertSentence,
    );
    assert.equal(downloads.length, 0, "no workbook is downloaded while offline");

    reconnect();
    await exportExcel(query, config, result, check, tieOut, ["Source: offline.csv"], tools);
  } finally {
    (globalThis as any).document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }

  assert.equal(downloads.length, 1, "the export downloads a workbook after reconnecting");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await downloads[0].arrayBuffer()) as any);
  assert.ok(workbook.getWorksheet("Bridge"), "the workbook opens with its Bridge worksheet");
});

test("An .xlsx load says the Excel tools sentence offline, then reads the sheet after reconnecting", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sales");
  sheet.addRow(["period", "product", "units", "sales"]);
  sheet.addRow(["2025", "P-100", 10, 100]);
  sheet.addRow(["2026", "P-200", 12, 150]);
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  const file = new File([bytes], "sales.xlsx");
  let reads = 0;
  const original = file.arrayBuffer.bind(file);
  (file as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => {
    reads += 1;
    return original();
  };
  const { tools, reconnect } = offlineThenOnline();

  await assert.rejects(excelSheetAsCsv(file, tools), assertSentence);
  assert.equal(reads, 0, "the file is not read while offline");

  reconnect();
  const loaded = await excelSheetAsCsv(file, tools);
  assert.deepEqual(loaded.csv.split("\n"), [
    "period,product,units,sales",
    "2025,P-100,10,100",
    "2026,P-200,12,150",
  ]);
});

test("Only exportExcel.ts and sheet.ts import exceljs directly, so a new import uses excelTools or joins the loader", () => {
  const appDir = fileURLToPath(new URL("../src/app/", import.meta.url));
  const sources = readdirSync(appDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
  // A type query is erased before a build and a comment never runs, so only a direct import counts.
  const directImport = /(?<!typeof )import\("exceljs"\)/g;
  const counts = sources.map((name) => ({
    name,
    count: readFileSync(join(appDir, name), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n")
      .match(directImport)?.length ?? 0,
  }));
  const importing = counts.filter((entry) => entry.count > 0).map((entry) => entry.name);
  assert.deepEqual(importing.sort(), ["exportExcel.ts", "sheet.ts"]);
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(total, 2, "exceljs is imported directly twice");
});
