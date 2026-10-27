import {
  cumulativeColumns,
  drill,
  priceDistribution,
  sensitivity,
  effectColumns,
  ident,
  measureName,
  tieOutLines,
  type BridgeConfig,
  type BridgeResult,
  type DataCheck,
  type TieOut,
  type Query,
} from "../engine.ts";
import { download } from "./files.ts";
import { shareOfPrior } from "./format.ts";
import { terms } from "./report.ts";
import { firstSheetAsCsv } from "./sheet.ts";

type ChunkFailure = "network" | "gone";

export type ChunkSentences = Readonly<Record<ChunkFailure, string>>;

interface ChunkSource<T> {
  /** Written inline as one literal import(). The retry reads the chunk URL from this function's text. */
  importer: () => Promise<unknown>;
  parse: (module: unknown) => T | undefined;
  /**
   * Another module imports this chunk by its bare address, and Chromium keeps a
   * failed dynamic import failed for that address for the life of the page. With
   * this set, an attempt proves the address answers before importing it when the
   * address can be read, so an attempt made offline does not import the address
   * the sibling import still needs.
   */
  sharedAddress?: true;
}

export interface LazyChunk<T> {
  /** One shared load per chunk. Rejects only with an Error whose message is one of the two sentences. */
  load(): Promise<T>;
  readonly loaded: T | undefined;
}

type ChunkState<T> =
  | { phase: "untried" }
  | { phase: "failed" }
  | { phase: "loading"; attempt: Promise<T> }
  | { phase: "loaded"; attempt: Promise<T>; value: T };

type ChunkResult<T> = { value: T } | { failure: ChunkFailure };

export class ChunkUnavailable extends Error {}

/** A dynamic chunk that recovers from a failed load. */
export function lazyChunk<T>(options: ChunkSource<T> & { sentences: ChunkSentences }): LazyChunk<T> {
  let state: ChunkState<T> = { phase: "untried" };
  return {
    load() {
      if (state.phase === "loading" || state.phase === "loaded") return state.attempt;
      const reading = options.sharedAddress
        ? probedChunk(options)
        : state.phase === "failed"
        ? retriedChunk(options)
        : firstChunk(options);
      const attempt: Promise<T> = reading.then((result) => {
        if ("failure" in result) {
          state = { phase: "failed" };
          throw new ChunkUnavailable(options.sentences[result.failure]);
        }
        state = { phase: "loaded", attempt, value: result.value };
        return result.value;
      });
      state = { phase: "loading", attempt };
      return attempt;
    },
    get loaded() {
      return state.phase === "loaded" ? state.value : undefined;
    },
  };
}

function parsedChunk<T>(source: ChunkSource<T>, module: unknown): ChunkResult<T> {
  const value = source.parse(module);
  return value === undefined ? { failure: "gone" } : { value };
}

async function firstChunk<T>(source: ChunkSource<T>): Promise<ChunkResult<T>> {
  try {
    return parsedChunk(source, await source.importer());
  } catch {
    return { failure: "network" };
  }
}

let retryAttempts = 0;

// Chromium keeps a failed import failed for that URL for the life of the page.
async function retriedChunk<T>(source: ChunkSource<T>): Promise<ChunkResult<T>> {
  const url = chunkUrl(source.importer);
  if (url === null) return { failure: "gone" };
  retryAttempts += 1;
  const retryUrl = url + "?retry=" + Date.now() + "." + retryAttempts;
  try {
    if (!(await servedAsJavaScript(retryUrl))) return { failure: "gone" };
    const module: unknown = await import(/* @vite-ignore */ retryUrl);
    return parsedChunk(source, module);
  } catch {
    return { failure: "network" };
  }
}

// A probe leaves the bare address clean for the sibling import that shares it.
async function probedChunk<T>(source: ChunkSource<T>): Promise<ChunkResult<T>> {
  const url = chunkUrl(source.importer);
  if (url === null) return firstChunk(source);
  try {
    if (!(await servedAsJavaScript(url, "default"))) return { failure: "gone" };
  } catch {
    return { failure: "network" };
  }
  return firstChunk(source);
}

async function servedAsJavaScript(url: string, cache: RequestCache = "no-store"): Promise<boolean> {
  const response = await fetch(url, { cache, redirect: "manual" });
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok || contentType.includes("text/html") || !isJavaScriptContentType(contentType)) return false;
  return !(await bodyStartsWithMarkup(response));
}

const IMPORT_SPECIFIER = /\bimport\(\s*(["'`])([^"'`\\$]+)\1\s*\)/g;
const CHUNK_PATH = /^\/assets\/[A-Za-z0-9_.-]+\.js$/;

// The build writes the chunk's file name into the importer as a literal, and
// a leaf chunk gets no modulepreload link to read it from.
function chunkUrl(importer: () => Promise<unknown>): string | null {
  const specifiers = [...Function.prototype.toString.call(importer).matchAll(IMPORT_SPECIFIER)];
  if (specifiers.length !== 1) return null;
  let parsed: URL;
  try {
    parsed = new URL(specifiers[0][2], import.meta.url);
  } catch {
    return null;
  }
  if (!CHUNK_PATH.test(parsed.pathname) || parsed.search !== "" || parsed.hash !== "") return null;
  if (typeof location === "undefined") return null;
  if (parsed.origin !== location.origin) return null;
  return parsed.origin + parsed.pathname;
}

function isJavaScriptContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim() ?? "";
  return mediaType === "text/javascript" || mediaType === "application/javascript";
}

async function bodyStartsWithMarkup(response: Response): Promise<boolean> {
  const body = response.body;
  if (body === null) return false;
  const reader = body.getReader();
  try {
    const chunk = await reader.read();
    const bytes = chunk.value;
    if (bytes === undefined || bytes.length === 0) return false;
    return new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith("<");
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export type ExcelModule = typeof import("exceljs");

const EXCEL_TOOLS_SENTENCE = "The Excel tools could not load. Check your internet connection and try again.";

function excelModule(module: unknown): ExcelModule | undefined {
  if (typeof module !== "object" || module === null) return undefined;
  const excel = (module as { default?: { Workbook?: unknown } }).default;
  if (typeof excel !== "object" || excel === null || typeof excel.Workbook !== "function") return undefined;
  return excel as unknown as ExcelModule;
}

/** The Excel library behind the shared, probed address. Exported so a test can feed a failing importer through the real machinery. */
export function excelLoader(importer: () => Promise<unknown>): LazyChunk<ExcelModule> {
  return lazyChunk({ importer, parse: excelModule, sentences: { network: EXCEL_TOOLS_SENTENCE, gone: EXCEL_TOOLS_SENTENCE }, sharedAddress: true });
}

/** The page's one Excel loader. Its importer is the only import("exceljs") in src/app outside sheet.ts. */
export const excelTools = excelLoader(() => import("exceljs"));

export type ExcelTools = Pick<LazyChunk<ExcelModule>, "load">;

/** Above this many configurations the detail sheet is left out and the bridge is written as values. */
const MAX_DETAIL_ROWS = 150_000;

/** Above this many rows a By sheet keeps the largest movers and names the cap on the sheet. */
const MAX_BY_ROWS = 5_000;

/** Excel offers to repair a workbook whose cells hold NaN or Infinity, and a CSV cell holding either reads as text, so a number with no finite value becomes null, which both exports write as a blank cell. */
export function finiteOrBlank<T>(value: T): T | null {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

/** 1 -> A, 27 -> AA. */
function columnLetter(index: number): string {
  let letters = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

export async function exportExcel(
  query: Query,
  config: BridgeConfig,
  result: BridgeResult,
  check: DataCheck,
  tieOut: TieOut,
  description: string[],
  tools: ExcelTools = excelTools,
): Promise<void> {
  const ExcelJS = await tools.load();
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;
  const k = config.levels.length;
  const keys = cumulativeColumns(config.levels, k);
  const effects = effectColumns(config);
  const t = terms(config);
  const bold = { bold: true };
  const numberFormat = "#,##0;-#,##0";

  const [{ n }] = await query(`SELECT count(*)::DOUBLE AS n FROM ${ident(result.cellsTable)}`);
  const detailRows = Number(n);
  const withDetail = detailRows <= MAX_DETAIL_ROWS;

  // Detail columns, in sheet order.
  const detail = [
    ...keys.map((key) => ({ header: key, field: key })),
    { header: "Prior units", field: "q0" },
    { header: config.costColumn ? "Prior margin with units" : "Prior sales with units", field: "s0" },
    { header: "Current units", field: "q1" },
    { header: config.costColumn ? "Current margin with units" : "Current sales with units", field: "s1" },
    { header: "Prior sales, no units", field: "z0" },
    { header: "Current sales, no units", field: "z1" },
    ...(config.costColumn
      ? [
          { header: "Prior sales with units", field: "rs0" },
          { header: "Current sales with units", field: "rs1" },
        ]
      : config.grossColumn
      ? [
          { header: "Prior gross sales", field: "g0" },
          { header: "Current gross sales", field: "g1" },
        ]
      : []),
    { header: "Match level", field: "match_level" },
    { header: "Surviving level", field: "surviving_level" },
    { header: "Status", field: "status" },
    { header: "Ref price: overall", field: "ref_0" },
    ...config.levels.map((level, i) => ({ header: `Ref price: ${level.name}`, field: `ref_${i + 1}` })),
    ...effects.map((e) => ({ header: e.label, field: e.key })),
  ];
  const letter = (field: string) => columnLetter(detail.findIndex((d) => d.field === field) + 1);

  const bridge = workbook.addWorksheet("Bridge");
  bridge.columns = [{ width: 34 }, { width: 18 }, { width: 16 }];
  bridge.addRow([`${measureName(config)} bridge: ${config.prior} to ${config.current}`]).font = bold;
  bridge.addRow([]);
  bridge.addRow(["", "Amount", t.ofPrior]).font = bold;
  const lastDetailRow = detailRows + 1;
  const total = (field: string, value: number) =>
    withDetail ? { formula: `SUM(Detail!${letter(field)}2:${letter(field)}${lastDetailRow})`, result: value } : value;
  const sales = (a: string, b: string, value: number) =>
    withDetail
      ? { formula: `SUM(Detail!${letter(a)}2:${letter(a)}${lastDetailRow})+SUM(Detail!${letter(b)}2:${letter(b)}${lastDetailRow})`, result: value }
      : value;
  bridge.addRow([t.prior, sales("s0", "z0", result.priorSales)]).font = bold;
  for (const effect of effects) {
    const value = result.effects.find((e) => e.key === effect.key)!.value;
    const row = bridge.addRow([effect.label, total(effect.key, value)]);
    // Excel recalculates the formula on open, so a negative prior total needs ABS to keep the effect's sign. A positive or zero prior keeps the divisor B4, which writes the same formula and values as before.
    const divisor = result.priorSales < 0 ? "ABS(B4)" : "B4";
    const formula = `IF(B4=0,"",B${row.number}/${divisor})`;
    const share = finiteOrBlank(shareOfPrior(value, result.priorSales));
    row.getCell(3).value = share === null ? { formula } : { formula, result: share };
    row.getCell(3).numFmt = "0.0%";
  }
  bridge.addRow([t.current, sales("s1", "z1", result.currentSales)]).font = bold;
  const checkRow = bridge.addRow([
    "Check: prior + effects - current",
    { formula: `SUM(B4:B${4 + effects.length})-B${5 + effects.length}`, result: 0 },
  ]);
  checkRow.font = { italic: true };
  bridge.getColumn(2).numFmt = numberFormat;
  if (!withDetail) {
    bridge.addRow([]);
    bridge.addRow([
      `Detail sheet omitted: ${detailRows.toLocaleString("en-US")} configurations is over the ${MAX_DETAIL_ROWS.toLocaleString("en-US")} row limit, so the amounts above are values, not formulas.`,
    ]);
  }

  const coverage = workbook.addWorksheet("Match coverage");
  coverage.columns = [{ width: 44 }, { width: 14 }, { width: 18 }, { width: 16 }];
  coverage.addRow(["Compared against", "Share", t.current, "Configurations"]).font = bold;
  for (const c of result.coverage) coverage.addRow([c.label, c.share, c.sales, c.cells]);
  coverage.getColumn(2).numFmt = "0.0%";
  coverage.getColumn(3).numFmt = numberFormat;

  const usedNames = new Set(workbook.worksheets.map((sheet) => sheet.name.toLowerCase()));
  for (const fixed of ["Price bands", "Setup check", "Detail", "Setup"]) usedNames.add(fixed.toLowerCase());
  for (const level of config.levels) {
    const rows = await drill(query, config, { columns: level.columns, limit: MAX_BY_ROWS });
    let capped = false;
    if (rows.length === MAX_BY_ROWS) {
      const probe = await drill(query, config, { columns: level.columns, limit: MAX_BY_ROWS + 1 });
      capped = probe.length > MAX_BY_ROWS;
    }
    const visible = rows;
    // Excel compares sheet names without regard to case and caps them at 31 characters.
    const baseName = `By ${level.name}`
      .replace(/[\\/*?:[\]]/g, " ")
      .slice(0, 28)
      .replace(/^'+|'+$/g, "");
    let sheetName = baseName;
    for (let n = 2; usedNames.has(sheetName.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      sheetName = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
    }
    usedNames.add(sheetName.toLowerCase());
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow([...level.columns, t.prior, t.current, "Change", ...effects.map((e) => e.label)]).font = bold;
    for (const row of visible) {
      sheet.addRow([
        ...level.columns.map((c) => (row[c] === null ? "(blank)" : String(row[c]))),
        Number(row.s0) + Number(row.z0),
        Number(row.s1) + Number(row.z1),
        Number(row.s1) + Number(row.z1) - Number(row.s0) - Number(row.z0),
        ...effects.map((e) => Number(row[e.key])),
      ]);
    }
    if (capped) {
      sheet.addRow([
        `This sheet shows the ${MAX_BY_ROWS.toLocaleString("en-US")} rows with the largest change. The Bridge sheet totals include every row.`,
      ]);
    }
    sheet.columns.forEach((column, index) => {
      column.width = 16;
      if (index >= level.columns.length) column.numFmt = numberFormat;
    });
  }

  const bands = await priceDistribution(query, config);
  const bandSheet = workbook.addWorksheet("Price bands");
  bandSheet.columns = [{ width: 30 }, { width: 12 }, { width: 18 }, { width: 16 }, { width: 16 }];
  bandSheet.addRow(["Change in average price", "Share", t.current, "Price effect", "Configurations"]).font = bold;
  for (const b of bands.buckets) bandSheet.addRow([b.label, b.share, b.sales, b.priceEffect, b.cells]);
  bandSheet.addRow([]);
  bandSheet.addRow(["Average change, matched configurations", bands.averageChange]);
  bandSheet.getColumn(2).numFmt = "0.0%";
  bandSheet.getColumn(3).numFmt = numberFormat;
  bandSheet.getColumn(4).numFmt = numberFormat;

  const alternatives = await sensitivity(query, config);
  const checkSheet = workbook.addWorksheet("Setup check");
  checkSheet.columns = [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 16 }, { width: 16 }];
  checkSheet.addRow(["Attributes used", "Price", "Mix", "New and discontinued", "Matched exactly", "Configurations"]).font = bold;
  for (const a of alternatives) checkSheet.addRow([a.label, a.price, a.mix, a.newAndDiscontinued, a.exactShare, a.cells]);
  for (const column of [2, 3, 4]) checkSheet.getColumn(column).numFmt = numberFormat;
  checkSheet.getColumn(5).numFmt = "0.0%";

  if (withDetail) {
    const sheet = workbook.addWorksheet("Detail");
    sheet.addRow(detail.map((d) => d.header)).font = bold;
    const rows = await query(
      `SELECT * FROM ${ident(result.cellsTable)} ORDER BY abs(s1 + z1 - s0 - z0) DESC`,
    );
    const delta = `(${letter("q1")}#-${letter("q0")}#)`;
    const rest = `${letter("s1")}#-${letter("s0")}#-${delta}*${letter(`ref_${k}`)}#`;
    const change = `${letter("s1")}#-${letter("s0")}#`;
    const status = (value: string) => `${letter("status")}#="${value}"`;
    const full = config.newAndDiscontinued === "full";
    const formulas: Record<string, string> = full
      ? {
          volume: `IF(${status("continuing")},${delta}*${letter("ref_0")}#,0)`,
          price: `IF(${status("continuing")},${rest},0)`,
          new_config: `IF(${status("new")},${change},0)`,
          discontinued: `IF(${status("discontinued")},${change},0)`,
        }
      : {
          volume: `${delta}*${letter("ref_0")}#`,
          price: `IF(${letter("match_level")}#=${k},${rest},0)`,
          new_config: `IF(${letter("match_level")}#<${k},${rest},0)`,
          discontinued: `${delta}*(${letter(`ref_${k}`)}#-CHOOSE(${letter("surviving_level")}#+1,${Array.from({ length: k + 1 }, (_, j) => `${letter(`ref_${j}`)}#`).join(",")}))`,
        };
    const rated = full ? status("continuing") : `${letter("match_level")}#=${k}`;
    if (config.costColumn) {
      const [q0, q1, rs0, rs1] = ["q0", "q1", "rs0", "rs1"].map((f) => `${letter(f)}#`);
      formulas.price_sales = `IF(AND(${rated},${q0}>0),${rs1}-${q1}*${rs0}/${q0},0)`;
      formulas.cost_rate = `(${formulas.price})-${letter("price_sales")}#`;
    } else if (config.grossColumn) {
      const [q0, q1, s0, g0, g1] = ["q0", "q1", "s0", "g0", "g1"].map((f) => `${letter(f)}#`);
      formulas.price_list = `IF(AND(${rated},${g0}<>0,${q0}>0,${q1}<>0),(${g1}-${q1}*${g0}/${q0})*(${s0}/${g0}),0)`;
      formulas.price_discount = `(${formulas.price})-${letter("price_list")}#`;
    }
    formulas.no_units = `${letter("z1")}#-${letter("z0")}#`;
    for (let j = 1; j <= k; j++) {
      const mix = `${delta}*(${letter(`ref_${j}`)}#-${letter(`ref_${j - 1}`)}#)`;
      formulas[`mix_${j}`] = `IF(${full ? status("continuing") : `${letter("surviving_level")}#>=${j}`},${mix},0)`;
    }
    rows.forEach((row, index) => {
      const r = String(index + 2);
      sheet.addRow(
        detail.map((d) => {
          const value = row[d.field];
          if (formulas[d.field]) return { formula: formulas[d.field].replaceAll("#", r), result: Number(value) };
          if (keys.includes(d.field) || d.field === "status") return value === null ? "" : String(value);
          if (value === null) return "";
          return Number(value);
        }),
      );
    });
    sheet.columns.forEach((column) => (column.width = 16));
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  const setup = workbook.addWorksheet("Setup");
  setup.columns = [{ width: 34 }, { width: 60 }];
  for (const line of description) setup.addRow(line.split(": ", 2));
  setup.addRow([]);
  setup.addRow(["Money tie-out"]).font = bold;
  /** The zero section shows the sign as text, so a numeric -0 keeps the sign the app shows. */
  const moneyFormat = (value: number) => (Object.is(value, -0) ? '#,##0;-#,##0;"-0"' : "#,##0");
  for (const line of tieOutLines(config, tieOut, result)) {
    const row = setup.addRow([line.label, Number.isFinite(line.value) ? line.value : null]);
    row.getCell(2).numFmt = moneyFormat(line.value);
  }
  setup.addRow([]);
  setup.addRow(["Rows read", check.rows]);
  setup.addRow([`Rows in ${config.prior}`, check.priorRows]);
  setup.addRow([`Rows in ${config.current}`, check.currentRows]);
  setup.addRow(["Rows in other periods (ignored)", check.otherPeriodRows]);
  setup.addRow(["Rows with blank units or sales", check.blankMeasureRows]);
  setup.addRow(["Rows with negative units", check.negativeUnitRows]);

  const buffer = await workbook.xlsx.writeBuffer();
  download(
    `bridge-${config.prior}-to-${config.current}.xlsx`,
    buffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
}

/** The Excel library and the first worksheet of an .xlsx file, read before DuckDB sees any rows. */
export async function excelSheetAsCsv(file: File, tools: ExcelTools = excelTools): Promise<Awaited<ReturnType<typeof firstSheetAsCsv>>> {
  await tools.load();
  return firstSheetAsCsv(file);
}
