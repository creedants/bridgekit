import * as duckdb from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { Query } from "../engine.ts";
import { toCsv } from "./files.ts";

export interface BrowserDatabase {
  query: Query;
  /** Loads a CSV, Excel or Parquet file into `table` without it leaving the browser. */
  loadFile(file: File, table: string): Promise<void>;
}

// One open per page. A rejection clears it so the next call can try again.
// A stale attempt must not clear a newer one.
let opening: Promise<BrowserDatabase> | undefined;

/** Returns the page's database, starting it on the first call. */
export function openBrowserDatabase(): Promise<BrowserDatabase> {
  opening ??= openFresh();
  return opening;
}

function openFresh(): Promise<BrowserDatabase> {
  const attempt = instantiateBrowserDatabase().then(
    (database) => database,
    (error: unknown) => {
      if (opening === attempt) opening = undefined;
      throw error;
    },
  );
  return attempt;
}

const IDLE_CAP_MS = 2000;
const READY_WAIT_MS = 10_000;

/**
 * Opens the shared database after the load event, once the empty tool is on
 * screen, on an idle callback. Save-Data leaves it closed until a file is chosen.
 * A failure is ignored. The next openBrowserDatabase call tries again.
 */
export function warmBrowserDatabase(): void {
  if (networkSaveData()) return;
  const kick = () => {
    void openBrowserDatabase().catch(() => {});
  };
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(kick, { timeout: IDLE_CAP_MS });
      return;
    }
    window.setTimeout(kick, IDLE_CAP_MS);
  };
  const whenReady = () => {
    const deadline = performance.now() + READY_WAIT_MS;
    const tick = () => {
      if (!emptyToolIsReady()) {
        if (performance.now() < deadline) window.setTimeout(tick, 16);
        return;
      }
      whenIdle();
    };
    tick();
  };
  if (document.readyState === "complete") whenReady();
  else window.addEventListener("load", whenReady, { once: true });
}

function emptyToolIsReady(): boolean {
  const input = document.querySelector('input[type="file"][accept*="csv"]');
  const heading = document.querySelector("h1");
  return (
    input instanceof HTMLInputElement &&
    !input.disabled &&
    heading !== null &&
    heading.textContent.trim() === "Load a sales file"
  );
}

function networkSaveData(): boolean {
  const value = readNavigator("connection");
  if (typeof value !== "object" || value === null || !("saveData" in value)) return false;
  return value.saveData === true;
}

function readNavigator(key: string): unknown {
  const own = Object.getOwnPropertyDescriptor(navigator, key);
  const inherited = Object.getOwnPropertyDescriptor(Navigator.prototype, key);
  const descriptor = own ?? inherited;
  if (!descriptor) return undefined;
  if (descriptor.get) return descriptor.get.call(navigator);
  return descriptor.value;
}

// The wasm and worker files are bundled with the app so nothing is fetched
// from a third-party host.
// DuckDB's wasm fetch can reject inside the worker without answering the page,
// which leaves the open promise pending. This posts the error DuckDB already
// maps to a rejected instantiate, so the next open can start again.
// The blob has no page URL, so the worker script and wasm address are absolute.
function pageUrl(url: string): string {
  return new URL(url, location.href).href;
}

function databaseWorker(scriptUrl: string): { worker: Worker; release: () => void } {
  const absolute = pageUrl(scriptUrl);
  const source = `self.addEventListener("message", (event) => {
  const id = event.data && event.data.messageId;
  if (typeof id === "number") self.__duckdbRequestId = id;
});
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  const name = reason instanceof Error ? reason.name : "Error";
  const stack = reason instanceof Error ? reason.stack : undefined;
  self.postMessage({
    messageId: 0,
    requestId: self.__duckdbRequestId,
    type: "ERROR",
    data: { name, message, stack },
  });
});
importScripts(${JSON.stringify(absolute)});
`;
  const objectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return { worker: new Worker(objectUrl), release: () => URL.revokeObjectURL(objectUrl) };
}

async function instantiateBrowserDatabase(): Promise<BrowserDatabase> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  if (bundle.mainWorker == null) throw new Error("DuckDB bundle is missing its worker");
  const script = databaseWorker(bundle.mainWorker);
  try {
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), script.worker);
    const pthread = bundle.pthreadWorker == null ? null : pageUrl(bundle.pthreadWorker);
    await db.instantiate(pageUrl(bundle.mainModule), pthread);
    const connection = await db.connect();
    const query: Query = async (sql) => {
      const result = await connection.query(sql);
      return result.toArray().map((row) => row.toJSON() as Record<string, unknown>);
    };
    return {
      query,
      async loadFile(file, table) {
        const isParquet = /\.parquet$/i.test(file.name);
        const isExcel = /\.xlsx$/i.test(file.name);
        if (!isParquet && !isExcel && !/\.(csv|tsv|txt)$/i.test(file.name)) {
          throw new Error("Use a CSV, Excel (.xlsx) or Parquet file");
        }
        const registered = isParquet ? "upload.parquet" : "upload.csv";
        if (isExcel) {
          await db.registerFileText(registered, await firstSheetAsCsv(file));
        } else {
          await db.registerFileHandle(registered, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
        }
        const reader = isParquet ? `read_parquet('${registered}')` : `read_csv('${registered}')`;
        await query(`CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM ${reader}`);
        await convertFormattedNumbers(query, table);
      },
    };
  } catch (error) {
    script.worker.terminate();
    throw error;
  } finally {
    script.release();
  }
}

/** Reads the first worksheet of an .xlsx file, taking formula results and formatting dates as ISO. */
async function firstSheetAsCsv(file: File): Promise<string> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new Error("The first sheet of that workbook has no data rows.");
  const plain = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "object" && value !== null) {
      const cell = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
      if (cell.richText) return cell.richText.map((part) => part.text).join("");
      if ("result" in cell) return plain(cell.result);
      if ("text" in cell) return cell.text;
      return "";
    }
    return value;
  };
  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    const values = (row.values as unknown[]).slice(1);
    rows.push(Array.from({ length: sheet.columnCount }, (_, i) => plain(values[i])));
  });
  return toCsv(rows[0].map(String), rows.slice(1));
}

/**
 * Spreadsheets often export numbers as text: "1,260", "$90.00", "(45)".
 * A text column is converted when every value parses as a number once that
 * formatting is removed and at least one value carries such formatting, so
 * plain codes such as "10023" are left alone.
 */
async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
  const columns = (await query(`DESCRIBE "${table}"`))
    .filter((row) => String(row.column_type) === "VARCHAR")
    .map((row) => `"${String(row.column_name).replaceAll('"', '""')}"`);
  if (columns.length === 0) return;
  const cleaned = (c: string) =>
    `try_cast(regexp_replace(regexp_replace(trim(${c}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;
  const check = async (candidates: string[], source: string) => {
    const [counts] = await query(
      `SELECT ${candidates
        .map(
          (c, i) =>
            `count(${c})::DOUBLE AS n${i}, count(${cleaned(c)})::DOUBLE AS ok${i}, count(*) FILTER (WHERE regexp_matches(${c}, '[,$()]'))::DOUBLE AS f${i}`,
        )
        .join(", ")} FROM ${source}`,
    );
    return candidates.filter((_, i) => {
      const n = Number(counts[`n${i}`]);
      return n > 0 && n === Number(counts[`ok${i}`]) && Number(counts[`f${i}`]) > 0;
    });
  };
  // A small sample rules out almost every column cheaply; only survivors get the full scan.
  const likely = await check(columns, `(SELECT * FROM "${table}" LIMIT 2000)`);
  if (likely.length === 0) return;
  for (const c of await check(likely, `"${table}"`)) {
    await query(`ALTER TABLE "${table}" ALTER ${c} TYPE DOUBLE USING ${cleaned(c)}`);
  }
}
