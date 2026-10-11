import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { Query } from "../engine.ts";
import { toCsv } from "./files.ts";

type ChunkFailure = "network" | "gone";

export type ChunkSentences = Readonly<Record<ChunkFailure, string>>;

interface ChunkSource<T> {
  /** Written inline as one literal import(). The retry reads the chunk URL from this function's text. */
  importer: () => Promise<unknown>;
  parse: (module: unknown) => T | undefined;
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

class ChunkUnavailable extends Error {}

/** A dynamic chunk that recovers from a failed load. */
export function lazyChunk<T>(options: ChunkSource<T> & { sentences: ChunkSentences }): LazyChunk<T> {
  let state: ChunkState<T> = { phase: "untried" };
  return {
    load() {
      if (state.phase === "loading" || state.phase === "loaded") return state.attempt;
      const reading = state.phase === "failed" ? retriedChunk(options) : firstChunk(options);
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

async function servedAsJavaScript(url: string): Promise<boolean> {
  const response = await fetch(url, { cache: "no-store", redirect: "manual" });
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
  if (parsed.origin !== location.origin) return null;
  if (!CHUNK_PATH.test(parsed.pathname) || parsed.search !== "" || parsed.hash !== "") return null;
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

const IDLE_CAP_MS = 2000;

/**
 * Runs work nobody has asked for yet: after the load event, on an idle
 * callback, then `settleMs` later. Save-Data schedules nothing.
 * Returns a cancel.
 */
export function scheduleSpeculative(work: () => void, settleMs = 0): () => void {
  if (networkSaveData()) return () => {};
  let cancelled = false;
  let idleId: number | undefined;
  let timerId: number | undefined;
  const settle = () => {
    if (cancelled) return;
    if (settleMs === 0) work();
    else timerId = window.setTimeout(work, settleMs);
  };
  const whenIdle = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(settle, { timeout: IDLE_CAP_MS });
      return;
    }
    timerId = window.setTimeout(settle, IDLE_CAP_MS);
  };
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", whenIdle);
    if (idleId !== undefined) window.cancelIdleCallback(idleId);
    if (timerId !== undefined) window.clearTimeout(timerId);
  };
}

// The DOM lib in this toolchain does not declare Network Information.
function networkSaveData(): boolean {
  const host: unknown = navigator;
  if (typeof host !== "object" || host === null || !("connection" in host)) return false;
  const connection = host.connection;
  if (typeof connection !== "object" || connection === null || !("saveData" in connection)) return false;
  return connection.saveData === true;
}

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

/**
 * Opens the shared database after the load event, on an idle callback.
 * Save-Data leaves it closed until a file is chosen.
 * A failure is ignored. The next openBrowserDatabase call tries again.
 */
export function warmBrowserDatabase(): void {
  scheduleSpeculative(() => {
    void openBrowserDatabase().catch(() => {});
  });
}

// The wasm and worker files are bundled with the app so nothing is fetched
// from a third-party host.
// A wasm fetch can reject inside the worker and never answer the page, so the
// bootstrap posts the ERROR that instantiate already rejects on. It records
// only the INSTANTIATE id and removes itself once that request is answered.
// A worker script that fails to load throws on the worker. DuckDB's error
// handler drops the pending request without rejecting it, so the page also
// races instantiate against the worker error event.
// The blob has no page URL, so the worker script and wasm address are absolute.
function pageUrl(url: string): string {
  return new URL(url, location.href).href;
}

function databaseWorker(scriptUrl: string): { worker: Worker; release: () => void } {
  const absolute = pageUrl(scriptUrl);
  const source = `const duckdbPost = self.postMessage.bind(self);
let instantiateId;
let startup = true;
function stopStartup() {
  if (!startup) return;
  startup = false;
  self.postMessage = duckdbPost;
  self.removeEventListener("message", onPageMessage);
  self.removeEventListener("unhandledrejection", onUnhandledRejection);
}
function onPageMessage(event) {
  const data = event.data;
  if (!startup || !data || data.type !== "INSTANTIATE" || typeof data.messageId !== "number") return;
  instantiateId = data.messageId;
}
function onUnhandledRejection(event) {
  if (!startup) return;
  event.preventDefault();
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  const name = reason instanceof Error ? reason.name : "Error";
  const stack = reason instanceof Error ? reason.stack : undefined;
  duckdbPost({
    messageId: 0,
    requestId: instantiateId,
    type: "ERROR",
    data: { name, message, stack },
  });
  stopStartup();
}
self.addEventListener("message", onPageMessage);
self.addEventListener("unhandledrejection", onUnhandledRejection);
self.postMessage = function (message, transfer) {
  if (
    startup &&
    message &&
    typeof instantiateId === "number" &&
    message.requestId === instantiateId &&
    (message.type === "OK" || message.type === "ERROR")
  ) {
    stopStartup();
  }
  return duckdbPost(message, transfer);
};
importScripts(${JSON.stringify(absolute)});
`;
  const objectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return { worker: new Worker(objectUrl), release: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

type DuckDBLibrary = Pick<
  typeof import("@duckdb/duckdb-wasm"),
  "selectBundle" | "AsyncDuckDB" | "VoidLogger" | "DuckDBDataProtocol"
>;

function isDuckDBLibrary(module: unknown): module is DuckDBLibrary {
  if (typeof module !== "object" || module === null) return false;
  if (!("selectBundle" in module && "AsyncDuckDB" in module && "VoidLogger" in module && "DuckDBDataProtocol" in module)) {
    return false;
  }
  const protocol = module.DuckDBDataProtocol;
  return (
    typeof module.selectBundle === "function" &&
    typeof module.AsyncDuckDB === "function" &&
    typeof module.VoidLogger === "function" &&
    typeof protocol === "object" &&
    protocol !== null &&
    "BROWSER_FILEREADER" in protocol &&
    typeof protocol.BROWSER_FILEREADER === "number"
  );
}

const LIBRARY_FAILURE: ChunkSentences = {
  network: "Could not load the database. Check your connection, then choose your file or the sample data again.",
  gone: "Reload the page to start again.",
};

const duckdbChunk = lazyChunk({
  importer: () => import("@duckdb/duckdb-wasm"),
  parse: (module) => (isDuckDBLibrary(module) ? module : undefined),
  sentences: LIBRARY_FAILURE,
});

async function instantiateBrowserDatabase(): Promise<BrowserDatabase> {
  const duckdb = await duckdbChunk.load();
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  if (bundle.mainWorker == null) throw new Error("DuckDB bundle is missing its worker");
  const script = databaseWorker(bundle.mainWorker);
  try {
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), script.worker);
    const pthread = bundle.pthreadWorker == null ? null : pageUrl(bundle.pthreadWorker);
    const startFailed = new Promise<never>((_, reject) => {
      script.worker.addEventListener(
        "error",
        (event) => {
          // The browser message names the worker script URL. The page shows one sentence.
          console.error(event.message);
          reject(new Error("The database worker did not start"));
        },
        { once: true },
      );
    });
    // If instantiate settles first, a later worker error must not reject unhandled.
    startFailed.catch(() => {});
    await Promise.race([db.instantiate(pageUrl(bundle.mainModule), pthread), startFailed]);
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
