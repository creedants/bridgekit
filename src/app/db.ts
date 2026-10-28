import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { Query } from "../engine.ts";
import { decodeCsvBuffer, ENCODING_SENTENCE, isUtf8Prefix, looksBinary, NOT_TEXT_FILE } from "./encoding.ts";
import { ChunkUnavailable, lazyChunk, type ChunkSentences } from "./exportExcel.ts";
import {
  applyDotColumns,
  convertFormattedNumbers,
  CSV_OPTIONS,
  markMixedSeparators,
  planDotColumns,
  typesForDotColumns,
} from "./numbers.ts";
import { firstSheetAsCsv, holeRenames, NO_DATA_ROWS } from "./sheet.ts";

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
  /** Loads a CSV or Excel file into `table` without it leaving the browser. Returns the data-row formulas with no saved result (zero for a CSV). */
  loadFile(file: File, table: string): Promise<number>;
}

// A UTF-8 file is handed to the database as its own bytes, so this is the most
// that is read up front, and a prefix may stop between two bytes of one
// character. A prefix that fails the prefix check is read in full, to tell its
// encoding from its whole text.
const CSV_PREFIX_BYTES = 65536;

// Detects the file's separator for the thousands-dots decision: a semicolon
// file reads dots as thousands. A sniff failure reads as a comma file, which
// only skips the semicolon rule; a value with more than one dot still reads
// as thousands.
async function sniffDelimiter(query: Query, path: string): Promise<string> {
  try {
    const [row] = await query(`SELECT Delimiter AS d FROM sniff_csv('${path.replaceAll("'", "''")}')`);
    const delimiter = row === undefined ? "" : String(row.d);
    return delimiter === "" ? "," : delimiter;
  } catch {
    return ",";
  }
}

// Marks a DATE column whose slash dates were reinterpreted month-first.
const MONTH_FIRST_MARK = "month first";

// The only slash shape in scope. Its groups are the two parts whose order the
// reader had to decide, and the year.
const SLASH_DATE = "^\\s*(\\d{1,2})/(\\d{1,2})/(\\d{4})\\s*$";

export async function readCsvTable(query: Query, table: string, path: string): Promise<void> {
  const escaped = path.replaceAll("'", "''");
  const delimiter = await sniffDelimiter(query, path);
  // Raw text decides the dots before the database types them: an all-dotted
  // column would otherwise load as decimals (9.600 as 9.6).
  const dots = await planDotColumns(query, path, delimiter).catch(() => []);
  const types = typesForDotColumns(dots);
  await query(`CREATE OR REPLACE TABLE ${quote(table)} AS SELECT * FROM read_csv('${escaped}', ${CSV_OPTIONS}${types ?? ""})`);
  await applyDotColumns(query, table, dots);
  const { ambiguous, monthFirst } = await ambiguousDateColumns(query, table, path);
  for (const column of ambiguous) {
    const name = quote(table);
    const field = quote(column);
    if (!monthFirst) {
      await query(
        `UPDATE ${name} SET ${field} = make_date(year(${field})::INTEGER, day(${field})::INTEGER, month(${field})::INTEGER) WHERE ${field} IS NOT NULL`,
      );
    }
    await query(`COMMENT ON COLUMN ${name}.${field} IS '${MONTH_FIRST_MARK}'`);
  }
}

// Excel workbooks flatten to comma CSV before DuckDB sees them, so they load
// through the same reader: the same options, thousands dots, slash-date fix
// and number conversion as a CSV with the same columns and values.
export async function readLoadedTable(
  query: Query,
  table: string,
  path: string,
  _isExcel: boolean,
): Promise<void> {
  try {
    await readCsvTable(query, table, path);
  } catch (error) {
    throw csvEncodingFailure(error);
  }
}

/**
 * True when the header uses one of comma and semicolon and a data line uses
 * the other. Quoting is not parsed: a separator inside quotes still counts,
 * so this only fires on the plain exports the tool writes and reads.
 */
export function mentionsMixedSeparators(prefix: string): boolean {
  const lines = prefix.split(/\r\n|\r|\n/);
  if (lines.length < 2) return false;
  const header = lines[0];
  const headerComma = header.includes(",");
  const headerSemi = header.includes(";");
  if (headerComma === headerSemi) return false;
  return lines.slice(1, 51).some((line) => {
    if (line.trim() === "") return false;
    if (headerComma) return line.includes(";") && !line.includes(",");
    return line.includes(",") && !line.includes(";");
  });
}

/** Refuses an empty or header-only table: the file problems list never sees one. */
export async function requireDataRows(query: Query, table: string): Promise<void> {
  const [row] = await query(`SELECT count(*)::DOUBLE AS n FROM ${quote(table)}`);
  if (!(Number(row?.n) > 0)) {
    await query(`DROP TABLE IF EXISTS ${quote(table)}`);
    throw new Error(NO_DATA_ROWS);
  }
}

/**
 * Swaps a staged load into place: the old table stays until the staged one is
 * fully converted and checked, so a refused file leaves the loaded data alone.
 */
export async function swapLoadedTable(query: Query, staging: string, table: string): Promise<void> {
  const previous = `${table}__previous`;
  await query(`DROP TABLE IF EXISTS ${quote(previous)}`);
  let renamed = false;
  try {
    await query(`ALTER TABLE ${quote(table)} RENAME TO ${quote(previous)}`);
    renamed = true;
  } catch {
    // A first load has no table to keep.
  }
  try {
    await query(`ALTER TABLE ${quote(staging)} RENAME TO ${quote(table)}`);
  } catch (error) {
    if (renamed) await query(`ALTER TABLE ${quote(previous)} RENAME TO ${quote(table)}`).catch(() => {});
    throw error;
  }
  await query(`DROP TABLE IF EXISTS ${quote(previous)}`);
}

async function ambiguousDateColumns(
  query: Query,
  table: string,
  path: string,
): Promise<{ ambiguous: string[]; monthFirst: boolean }> {
  const described = await query(`DESCRIBE ${quote(table)}`);
  const names = described.map((row) => String(row.column_name));
  const dates = described
    .filter((row) => String(row.column_type) === "DATE")
    .map((row) => String(row.column_name));
  if (dates.length === 0) return { ambiguous: [], monthFirst: false };
  const escaped = path.replaceAll("'", "''");
  const source = `read_csv('${escaped}', all_varchar=true, ${CSV_OPTIONS})`;
  const sourceNames = (await query(`DESCRIBE SELECT * FROM ${source}`)).map((row) => String(row.column_name));
  if (sourceNames.length !== names.length || sourceNames.some((name, index) => name !== names[index])) {
    return { ambiguous: [], monthFirst: false };
  }
  const loaded = dates.map((name, index) => `${quote(name)} AS v${index}`).join(", ");
  const parts = dates
    .map((name, index) =>
      [
        `${quote(name)} AS t${index}`,
        `TRY_CAST(regexp_extract(${quote(name)}, '${SLASH_DATE}', 1) AS INTEGER) AS first${index}`,
        `TRY_CAST(regexp_extract(${quote(name)}, '${SLASH_DATE}', 2) AS INTEGER) AS second${index}`,
        `TRY_CAST(regexp_extract(${quote(name)}, '${SLASH_DATE}', 3) AS INTEGER) AS year${index}`,
      ].join(", "),
    )
    .join(", ");
  const counts = dates
    .map(
      (_, index) =>
        [
          `count(t${index})::DOUBLE AS n${index}`,
          `count(year${index})::DOUBLE AS s${index}`,
          `count(*) FILTER (WHERE first${index} > 12 OR second${index} > 12)::DOUBLE AS p${index}`,
          `count(*) FILTER (WHERE year(v${index}) = year${index} AND month(v${index}) = first${index} AND day(v${index}) = second${index})::DOUBLE AS m${index}`,
          `count(*) FILTER (WHERE year(v${index}) = year${index} AND month(v${index}) = second${index} AND day(v${index}) = first${index})::DOUBLE AS d${index}`,
        ].join(", "),
    )
    .join(", ");
  const [row] = await query(
    `SELECT ${counts} FROM (SELECT ${loaded} FROM ${quote(table)}) POSITIONAL JOIN (SELECT ${parts} FROM ${source})`,
  );
  if (!row) return { ambiguous: [], monthFirst: false };
  const count = (key: string) => Number(row[key]);
  // Only a file whose every DATE value is a four-digit slash date is in scope.
  // A three-digit year is read as a date too, so it would otherwise change the
  // order without being seen here.
  if (dates.some((_, index) => count(`s${index}`) !== count(`n${index}`))) {
    return { ambiguous: [], monthFirst: false };
  }
  // The order is read from the values the load delivered. Every value must
  // match one reading, or the file keeps the order it was read with.
  const monthFirst = dates.every((_, index) => count(`m${index}`) === count(`n${index}`));
  if (!monthFirst && !dates.every((_, index) => count(`d${index}`) === count(`n${index}`))) {
    return { ambiguous: [], monthFirst: false };
  }
  const ambiguous = dates.filter((_, index) => count(`s${index}`) > 0 && count(`p${index}`) === 0);
  return { ambiguous, monthFirst };
}

export async function dateOrderNote(query: Query, table: string): Promise<string | null> {
  const rows = await query(
    `SELECT column_name FROM duckdb_columns() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}' AND comment = '${MONTH_FIRST_MARK}' ORDER BY column_name`,
  );
  const names = rows.map((row) => String(row.column_name));
  if (names.length === 0) return null;
  if (names.length === 1) return `1 column with slash dates was read month-first: ${names[0]}.`;
  return `${names.length} columns with slash dates were read month-first: ${names.join(", ")}.`;
}

// read_csv only reads UTF-8. When a file that passed the prefix check turns out
// to hold bytes that are not UTF-8, the database's own message names exactly
// this failure, and the one sentence replaces it. Any other database error is
// shown as it is.
function csvEncodingFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Invalid unicode (byte sequence mismatch)") && message.includes("This file is not utf-8 encoded")) {
    return new Error(ENCODING_SENTENCE);
  }
  return error;
}

export const TOO_BIG_SENTENCE =
  "This file is too big to open in this browser. Try a smaller file, or save it with fewer rows or columns.";

// DuckDB-WASM begins the recorded allocation failure with this text.
// CSV parse and encoding failures do not begin with this prefix.
const OUT_OF_MEMORY_PREFIX = "Out of Memory Error";

export function isOutOfMemory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(OUT_OF_MEMORY_PREFIX);
}

export function loadFailure(error: unknown): Error {
  if (isOutOfMemory(error)) return new Error(TOO_BIG_SENTENCE);
  return error instanceof Error ? error : new Error(String(error));
}

// One open per page. A rejection clears it so the next call can try again.
// A stale attempt must not clear a newer one.
let opening: Promise<BrowserDatabase> | undefined;

/** Returns the page's database, starting it on the first call. */
export function openBrowserDatabase(): Promise<BrowserDatabase> {
  opening ??= openFresh();
  return opening;
}

const workerScriptByError = new WeakMap<Error, string>();

function noteWorkerScript(error: unknown, scriptUrl: string): void {
  if (error instanceof Error) workerScriptByError.set(error, scriptUrl);
}

function sameOriginWorkerScript(url: string | undefined): string | undefined {
  if (url == null) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin !== location.origin) return undefined;
  return parsed.href;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// True means the response finished or redirected, so this is not a download failure.
// A redirect is not followed. One request stays on this origin.
async function workerScriptLoaded(url: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", redirect: "manual" });
  } catch {
    return false;
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
    return true;
  }
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
    return false;
  }
  try {
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function startFailureForPage(error: unknown): Promise<Error> {
  if (error instanceof ChunkUnavailable) return error;
  console.error(error);
  if (error instanceof Error && (await isDownloadFailure(error))) return new Error(LIBRARY_FAILURE.network);
  return new Error("The database worker did not start");
}

async function isDownloadFailure(error: Error): Promise<boolean> {
  const message = error.message;
  if (message === "Failed to fetch") return true;
  if (
    message.includes("Failed to execute 'compile' on 'WebAssembly'") &&
    message.includes("HTTP status code is not ok")
  ) {
    return true;
  }
  if (message.includes("WebAssembly compilation aborted") && message.includes("Network error")) return true;
  // Chromium uses this importScripts text for a refused 200 and for a failed download.
  if (
    message.includes("Failed to execute 'importScripts' on 'WorkerGlobalScope'") &&
    message.includes("failed to load")
  ) {
    const scriptUrl = sameOriginWorkerScript(workerScriptByError.get(error));
    if (scriptUrl == null) return false;
    return !(await workerScriptLoaded(scriptUrl));
  }
  return false;
}

function openFresh(): Promise<BrowserDatabase> {
  const attempt = instantiateBrowserDatabase().then(
    (database) => database,
    async (error: unknown) => {
      const pageError = await startFailureForPage(error);
      if (opening === attempt) opening = undefined;
      throw pageError;
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

export const PARQUET_REFUSAL = "Parquet files are not supported. Save the file as CSV or Excel and try again.";

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
  const workerScriptUrl = pageUrl(bundle.mainWorker);
  const script = databaseWorker(bundle.mainWorker);
  try {
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), script.worker);
    const pthread = bundle.pthreadWorker == null ? null : pageUrl(bundle.pthreadWorker);
    const startFailed = new Promise<never>((_, reject) => {
      script.worker.addEventListener(
        "error",
        (event) => {
          const failure = new Error(event.message);
          noteWorkerScript(failure, workerScriptUrl);
          reject(failure);
        },
        { once: true },
      );
    });
    // If instantiate settles first, a later worker error must not reject unhandled.
    startFailed.catch(() => {});
    await Promise.race([db.instantiate(pageUrl(bundle.mainModule), pthread), startFailed]);
    const connection = await db.connect();
    // DuckDB keeps a registered name until it is dropped and refuses a file
    // handle under a name it still holds as text, so a load drops the last upload first.
    let uploadRegistered = false;
    const query: Query = async (sql) => {
      const result = await connection.query(sql);
      return result.toArray().map((row) => row.toJSON() as Record<string, unknown>);
    };
    return {
      query,
      async loadFile(file, table) {
        try {
          if (/\.parquet$/i.test(file.name)) {
            throw new Error(PARQUET_REFUSAL);
          }
          const isExcel = /\.xlsx$/i.test(file.name);
          if (!isExcel && !/\.(csv|tsv|txt)$/i.test(file.name)) {
            throw new Error("Use a CSV or Excel (.xlsx) file");
          }
          const registered = "upload.csv";
          if (uploadRegistered) {
            await db.dropFile(registered);
            uploadRegistered = false;
          }
          let excelHoles: readonly number[] = [];
          let formulaBlanks = 0;
          let mixedSeparators = false;
          if (isExcel) {
            const sheet = await firstSheetAsCsv(file);
            excelHoles = sheet.holes;
            formulaBlanks = sheet.formulaBlanks;
            await db.registerFileText(registered, sheet.csv);
          } else {
            if (file.size === 0) throw new Error(NO_DATA_ROWS);
            const prefix = new Uint8Array(await file.slice(0, CSV_PREFIX_BYTES).arrayBuffer());
            if (looksBinary(prefix)) throw new Error(NOT_TEXT_FILE);
            mixedSeparators = mentionsMixedSeparators(new TextDecoder().decode(prefix));
            const continues = prefix.byteLength < file.size;
            if (continues && isUtf8Prefix(prefix)) {
              await db.registerFileHandle(registered, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
            } else {
              const decision = decodeCsvBuffer(continues ? new Uint8Array(await file.arrayBuffer()) : prefix);
              if (decision.kind === "utf8") await db.registerFileHandle(registered, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
              else await db.registerFileText(registered, decision.text);
            }
          }
          uploadRegistered = true;
          // A refused file must leave the loaded data alone, so the new file
          // converts on a staging table and only swaps into place once it has
          // rows. The empty check, the swap and afterLoad all run after this.
          const staging = `${table}__staging`;
          await readLoadedTable(query, staging, registered, isExcel);
          if (excelHoles.length > 0) {
            const described = await query(`DESCRIBE ${quote(staging)}`);
            const names = described.map((row) => String(row.column_name));
            for (const rename of holeRenames(names, excelHoles)) {
              if (rename.from === rename.to) continue;
              await query(`ALTER TABLE ${quote(staging)} RENAME COLUMN ${quote(rename.from)} TO ${quote(rename.to)}`);
            }
          }
          await convertFormattedNumbers(query, staging);
          if (mixedSeparators) await markMixedSeparators(query, staging);
          await requireDataRows(query, staging);
          await swapLoadedTable(query, staging, table);
          return formulaBlanks;
        } catch (error) {
          throw loadFailure(error);
        }
      },
    };
  } catch (error) {
    noteWorkerScript(error, workerScriptUrl);
    script.worker.terminate();
    throw error;
  } finally {
    script.release();
  }
}

