import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { excelLoader, exportExcel } from "../src/app/exportExcel.ts";
import { firstSheetAsCsv } from "../src/app/sheet.ts";
import type { BridgeConfig, BridgeResult, DataCheck, Query, TieOut } from "../src/engine.ts";

const SENTENCE = "The Excel tools could not load. Check your internet connection and try again.";
const RAW_FAILURE = "Failed to fetch dynamically imported module: http://127.0.0.1:4179/assets/exceljs.min-abc123.js";

// Chromium keeps a failed import failed for the bare chunk address for the life
// of the page, so the loader has to read a fresh copy under a new address.
function droppedConnection() {
  let bareAttempts = 0;
  const stamps: string[] = [];
  const tools = excelLoader(
    () => {
      bareAttempts += 1;
      return Promise.reject(new TypeError(RAW_FAILURE));
    },
    async (stamp) => {
      stamps.push(stamp);
      return import("exceljs");
    },
  );
  return { tools, stamps, bareAttempts: () => bareAttempts };
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

test("Export Excel says the Excel tools sentence when the chunk fails, then exports from a fresh copy", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const { tools, stamps, bareAttempts } = droppedConnection();
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
    assert.equal(downloads.length, 0, "no workbook is downloaded when the chunk fails");

    await exportExcel(query, config, result, check, tieOut, ["Source: offline.csv"], tools);
    await exportExcel(query, config, result, check, tieOut, ["Source: offline.csv"], tools);
  } finally {
    (globalThis as any).document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }

  assert.equal(downloads.length, 2, "each export after the failure downloads a workbook");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await downloads[1].arrayBuffer()) as any);
  assert.ok(workbook.getWorksheet("Bridge"), "the workbook opens with its Bridge worksheet");
  assert.equal(bareAttempts(), 1, "the loader never imports the address the browser cached as failed");
  assert.equal(stamps.length, 1, "one fresh copy serves every later action");
  assert.match(stamps[0], /^\d+\.\d+$/, "the fresh copy is read under a timestamped address");
});

test("An .xlsx load says the Excel tools sentence when the chunk fails, then reads the sheet from a fresh copy", async () => {
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
  const { tools, stamps, bareAttempts } = droppedConnection();

  await assert.rejects(firstSheetAsCsv(file, tools), assertSentence);
  assert.equal(reads, 0, "the file is not read when the chunk fails");

  const loaded = await firstSheetAsCsv(file, tools);
  assert.deepEqual(loaded.csv.split("\n"), [
    "period,product,units,sales",
    "2025,P-100,10,100",
    "2026,P-200,12,150",
  ]);
  assert.equal(bareAttempts(), 1, "the loader never imports the address the browser cached as failed");
  assert.equal(stamps.length, 1, "one fresh copy serves every later action");
});

test("Only the shared loader in exportExcel.ts imports exceljs, so every other file takes it from excelTools", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
  assert.ok(files.length > 0, "the walk found source files");
  const mentions: { file: string; line: string }[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(srcDir, file), "utf8").split("\n")) {
      const trimmed = line.trim();
      // A comment never runs and a type-only statement is erased before a build.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (/^(?:import|export)\s+type\b/.test(trimmed)) continue;
      const code = line.replace(/typeof\s+import\(\s*(["'])exceljs\1\s*\)/g, "");
      if (/(?<![\w$])exceljs(?![\w$])/.test(code)) mentions.push({ file, line });
    }
  }
  assert.equal(mentions.length, 1, "exceljs is named on exactly one line of source that runs");
  assert.equal(mentions[0].file, "app/exportExcel.ts", "the shared loader is the one file that names exceljs");
  assert.match(
    mentions[0].line,
    /\bimport\(\s*["']exceljs["']\s*\)/,
    "the loader imports exceljs dynamically so the chunk stays out of the main bundle",
  );
});
