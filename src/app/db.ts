import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { Query } from "../engine.ts";
import { CSV_PREFIX_BYTES, ENCODING_SENTENCE, isValidUtf8, readCsvFile, type CsvReading } from "./encoding.ts";
import { ChunkUnavailable, lazyChunk, type ChunkSentences } from "./exportExcel.ts";
import {
  applyDotColumns,
  convertFormattedNumbers,
  CSV_OPTIONS,
  hasConsistentRecords,
  headerFieldCount,
  mixedSeparatorSentence,
  MAX_COLUMNS_READ,
  planDotColumns,
  TOO_MANY_COLUMNS_SENTENCE,
  typeOverrides,
} from "./numbers.ts";
import { swapWithSourceRows, type CsvDialect, type SourceRows } from "./profile.ts";
import { firstSheetAsCsv, holeRenames, NO_DATA_ROWS } from "./sheet.ts";
import { createConnectionQueue, statementStartsTurn } from "./small-bridges.ts";

const IDLE_CAP_MS = 2000;

// The page's one connection gets one queue, so no two statements from this page
// run at the same time and a caller's consecutive statements stay together.
const statements = createConnectionQueue();

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

/** One character the sniffer reported, or "" for a character the file does not use. */
function sniffedChar(value: unknown): string {
  const text = String(value ?? "");
  return text.length === 1 && text !== "\0" ? text : "";
}

// A missing column keeps the reader's own default, because the wasm build may
// report fewer columns than the Node one.
function currentColumn(row: Record<string, unknown>, key: string, fallback: string): string {
  return row[key] == null ? fallback : sniffedChar(row[key]);
}

/**
 * How DuckDB's sniffer read the file, from the one query the load already ran.
 * `quote` and `escape` are one character, or "" for none. Undefined when the
 * sniff fails, and then no row is named.
 */
async function sniffDialect(query: Query, path: string): Promise<CsvDialect | undefined> {
  try {
    const [row] = await query(
      `SELECT Delimiter AS d, Quote AS q, Escape AS e, HasHeader AS h, SkipRows AS s, Comment AS c FROM sniff_csv('${path.replaceAll("'", "''")}')`,
    );
    if (row === undefined) return undefined;
    return {
      delimiter: sniffedChar(row.d),
      quote: currentColumn(row, "q", '"'),
      escape: currentColumn(row, "e", '"'),
      header: row.h == null ? true : Boolean(row.h),
      skipRows: row.s == null ? 0 : Number(row.s) || 0,
      comment: currentColumn(row, "c", ""),
    };
  } catch {
    return undefined;
  }
}

// How the loader read each column of slash dates. The first two marks are the
// ones the typed read already carried, including a four-digit column whose own
// values proved neither order and which this pass then put in the browser's
// order; the last two are the new text columns, whose sentence says why.
const MONTH_FIRST_MARK = "month first";
const DAY_FIRST_MARK = "day first";
// A VARCHAR slash column the loader read in the browser's own order, with no
// value in it proving either reading.
const SLASH_MONTH_FIRST_MARK = "slash date month first by language";
const SLASH_DAY_FIRST_MARK = "slash date day first by language";
// A wholly slash column that proves both orders, or one whose values include a
// date that does not exist, stays text and carries the values its sentence
// quotes.
const BOTH_ORDERS_MARK = "slash dates in both orders";
const MISSING_DATE_MARK = "date does not exist";
const DATE_ORDER_MARKS = [MONTH_FIRST_MARK, DAY_FIRST_MARK, SLASH_MONTH_FIRST_MARK, SLASH_DAY_FIRST_MARK];

/** The order a browser's own dates put the day and the month in. */
export type DateOrder = "month first" | "day first";

/**
 * The date order the page's language writes, so a file with no value that
 * proves an order follows the locale reported by Intl. An invalid language tag
 * falls back to month-first.
 */
export function orderForLanguage(language: string): DateOrder {
  try {
    const parts = new Intl.DateTimeFormat(language, {
      day: "numeric",
      month: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).formatToParts(new Date(Date.UTC(2026, 10, 22)));
    const day = parts.findIndex((part) => part.type === "day");
    const month = parts.findIndex((part) => part.type === "month");
    return day >= 0 && month >= 0 && day < month ? "day first" : "month first";
  } catch {
    return "month first";
  }
}

// The only slash shape in scope. Its groups are the two parts whose order the
// reader had to decide, and the year.
const SLASH_DATE = "^\\s*(\\d{1,2})/(\\d{1,2})/(\\d{4})\\s*$";

export async function readCsvTable(
  query: Query,
  table: string,
  path: string,
  skipMonthFirst = false,
  order: DateOrder = "month first",
  skip = 0,
): Promise<void> {
  const escaped = path.replaceAll("'", "''");
  const delimiter = (await sniffDialect(query, path))?.delimiter || ",";
  // Raw text decides the dots before the database types them: an all-dotted
  // column would otherwise load as decimals (9.600 as 9.6).
  const dots = await planDotColumns(query, path, delimiter, skip).catch(() => []);
  const thousands = dots.filter((reading) => reading.thousands).map((reading) => reading.column);
  const skipText = skipOption(skip);
  try {
    await query(
      `CREATE OR REPLACE TABLE ${quote(table)} AS SELECT * FROM read_csv('${escaped}', ${CSV_OPTIONS}${skipText}${typeOverrides(thousands)})`,
    );
  } catch (error) {
    if (!isConversionError(error)) throw error;
    // A value past the sniff sample can break the date type the sample chose.
    // Read every date column as text and let convertDateColumns decide from
    // every value, so no raw engine error reaches the user for a date shape.
    const text = [...thousands, ...(await dateTypedColumns(query, path, skip))];
    await query(
      `CREATE OR REPLACE TABLE ${quote(table)} AS SELECT * FROM read_csv('${escaped}', ${CSV_OPTIONS}${skipText}${typeOverrides(text)})`,
    );
  }
  await restoreNonFinite(query, table, path, skip);
  await applyDotColumns(query, table, dots);
  if (!skipMonthFirst) {
    const { ambiguous, loaded } = await ambiguousDateColumns(query, table, path, skip);
    for (const column of ambiguous) {
      const name = quote(table);
      const field = quote(column);
      if (loaded !== order) {
        await query(
          `UPDATE ${name} SET ${field} = make_date(year(${field})::INTEGER, day(${field})::INTEGER, month(${field})::INTEGER) WHERE ${field} IS NOT NULL`,
        );
      }
      await query(`COMMENT ON COLUMN ${name}.${field} IS '${order}'`);
    }
  }
  // After the slash-date pass and before the numbers, so a column of dates or
  // of months in the file's own text becomes a date instead of staying text.
  await convertDateColumns(query, table, order).catch(() => {});
}

// A month with no day, in the three shapes the tool reads as the first of that
// month. Every non-blank value must be one of them.
const MONTH_TEXT = [
  "^(0[1-9]|1[0-2])\\.(19|20)\\d{2}$",
  "^(0[1-9]|1[0-2])/(19|20)\\d{2}$",
  "^(19|20)\\d{2}-(0[1-9]|1[0-2])$",
].join("|");
const ISO_MONTH = "^(19|20)\\d{2}-";

// A slash date or an English month-name date, with an optional time of day.
// The month-name list is spelled out because try_strptime reads English only.
const MONTH_NAMES =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)";
const TIME_TEXT = "\\d{1,2}:\\d{2}(?::\\d{2})?";
const SLASH_DATE_TEXT = `^\\s*\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})(?:\\s+${TIME_TEXT})?\\s*$`;
const MONTH_NAME_TEXT = `^\\s*(?:${MONTH_NAMES}\\s+\\d{1,2},\\s*\\d{4}|\\d{1,2}\\s+${MONTH_NAMES}\\s+\\d{4})(?:\\s+${TIME_TEXT})?\\s*$`;
const SLASH_DAY_PART = "^\\s*(\\d{1,2})/";
const SLASH_MONTH_PART = "^\\s*\\d{1,2}/(\\d{1,2})/";
const SLASH_FOUR_DIGIT_YEAR = "^\\s*\\d{1,2}/\\d{1,2}/\\d{4}";
const SLASH_SECONDS = "\\d{1,2}:\\d{2}:\\d{2}";
const SLASH_TIME = "\\d{1,2}:\\d{2}";
const MONTH_NAME_FIRST = "^\\s*[A-Za-z]";
const SHORT_MONTH = "^(?:[A-Za-z]{3}\\b|\\d{1,2}\\s+[A-Za-z]{3}\\b)";

// The shapes above as a reader of the file's own text uses them, to decide
// whether a column can be one date family at all.
const SLASH_DATE_VALUE = new RegExp(SLASH_DATE_TEXT);
const MONTH_NAME_VALUE = new RegExp(MONTH_NAME_TEXT);
const MONTH_VALUE = new RegExp(MONTH_TEXT);

/** How many non-blank values decide whether a column is worth the whole-table pass. */
const SHAPE_SAMPLE = 200;

/**
 * The text columns that can still be one date family, decided from a small
 * sample. A column whose sampled values include ordinary text cannot be wholly
 * date-shaped, so it never needs the whole-table pass, and a column with no
 * non-blank value has nothing to convert. This keeps a file of ordinary text
 * from paying for a date measure over every row.
 */
async function dateShapedColumns(query: Query, table: string, columns: string[]): Promise<string[]> {
  const shaped: string[] = [];
  for (const column of columns) {
    const field = quote(column);
    const value = `trim(${field})`;
    const rows = await query(
      `SELECT ${value} AS v FROM ${quote(table)} WHERE ${field} IS NOT NULL AND ${value} <> '' LIMIT ${SHAPE_SAMPLE}`,
    );
    if (rows.length === 0) continue;
    const every = rows.every((row) => {
      const text = String(row.v);
      return SLASH_DATE_VALUE.test(text) || MONTH_NAME_VALUE.test(text) || MONTH_VALUE.test(text);
    });
    if (every) shaped.push(column);
  }
  return shaped;
}


interface DateCounts {
  present: number;
  slash: number;
  named: number;
  dayProof: number;
  monthProof: number;
  timed: number;
  seconds: number;
  wide: number;
  abbreviated: number;
  monthFirst: number;
  /** Values in one of the month-with-no-day shapes, and those that are not. */
  month: number;
  monthBad: number;
}

interface DateShape {
  format: string;
  type: "DATE" | "TIMESTAMP";
  /** The mark a language decision carries, so the Data check can name it. */
  mark?: string;
  /** True when the value is read with comma spacing normalised, so `April 13,2026` parses. */
  normalize: boolean;
}

function dateMeasures(column: string, index: number): string {
  const field = quote(column);
  const value = `trim(${field})`;
  const blank = `(${field} IS NULL OR ${value} = '')`;
  const slash = `regexp_matches(${value}, '${SLASH_DATE_TEXT}')`;
  const named = `regexp_matches(${value}, '${MONTH_NAME_TEXT}')`;
  return [
    `count(*) FILTER (WHERE NOT ${blank})::DOUBLE AS n${index}`,
    `count(*) FILTER (WHERE ${slash})::DOUBLE AS s${index}`,
    `count(*) FILTER (WHERE ${named})::DOUBLE AS m${index}`,
    `count(*) FILTER (WHERE ${slash} AND TRY_CAST(regexp_extract(${value}, '${SLASH_DAY_PART}', 1) AS INTEGER) > 12)::DOUBLE AS dp${index}`,
    `count(*) FILTER (WHERE ${slash} AND TRY_CAST(regexp_extract(${value}, '${SLASH_MONTH_PART}', 1) AS INTEGER) > 12)::DOUBLE AS mp${index}`,
    `count(*) FILTER (WHERE (${slash} OR ${named}) AND regexp_matches(${value}, '${SLASH_TIME}'))::DOUBLE AS t${index}`,
    `count(*) FILTER (WHERE (${slash} OR ${named}) AND regexp_matches(${value}, '${SLASH_SECONDS}'))::DOUBLE AS sec${index}`,
    `count(*) FILTER (WHERE ${slash} AND regexp_matches(${value}, '${SLASH_FOUR_DIGIT_YEAR}'))::DOUBLE AS w${index}`,
    `count(*) FILTER (WHERE ${named} AND regexp_matches(${value}, '${SHORT_MONTH}'))::DOUBLE AS ab${index}`,
    `count(*) FILTER (WHERE ${named} AND regexp_matches(${value}, '${MONTH_NAME_FIRST}'))::DOUBLE AS mf${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND regexp_matches(${value}, '${MONTH_TEXT}'))::DOUBLE AS mo${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND NOT regexp_matches(${value}, '${MONTH_TEXT}'))::DOUBLE AS mb${index}`,
  ].join(", ");
}

function dateCounts(row: Record<string, unknown>, index: number): DateCounts {
  return {
    present: Number(row[`n${index}`]),
    slash: Number(row[`s${index}`]),
    named: Number(row[`m${index}`]),
    dayProof: Number(row[`dp${index}`]),
    monthProof: Number(row[`mp${index}`]),
    timed: Number(row[`t${index}`]),
    seconds: Number(row[`sec${index}`]),
    wide: Number(row[`w${index}`]),
    abbreviated: Number(row[`ab${index}`]),
    monthFirst: Number(row[`mf${index}`]),
    month: Number(row[`mo${index}`]),
    monthBad: Number(row[`mb${index}`]),
  };
}

/** The time suffix every value shares, or undefined when the column mixes timed and untimed values. */
function timeSuffix(counts: DateCounts): string | undefined {
  if (counts.timed === 0) return "";
  if (counts.timed !== counts.present) return undefined;
  if (counts.seconds === 0) return " %H:%M";
  return counts.seconds === counts.timed ? " %H:%M:%S" : undefined;
}

/** The one reading a slash column proves, or the order the browser's language gives it. */
function slashShape(counts: DateCounts, order: DateOrder): DateShape | undefined {
  if (counts.slash !== counts.present) return undefined;
  if (counts.dayProof > 0 && counts.monthProof > 0) return undefined;
  const time = timeSuffix(counts);
  if (time === undefined) return undefined;
  const year = counts.wide === counts.slash ? "%Y" : counts.wide === 0 ? "%y" : undefined;
  if (year === undefined) return undefined;
  const dayFirst = counts.dayProof > 0 || (counts.monthProof === 0 && order === "day first");
  const settled = counts.dayProof > 0 || counts.monthProof > 0;
  return {
    format: `${dayFirst ? "%d/%m" : "%m/%d"}/${year}${time}`,
    type: time === "" ? "DATE" : "TIMESTAMP",
    mark: settled ? undefined : dayFirst ? SLASH_DAY_FIRST_MARK : SLASH_MONTH_FIRST_MARK,
    normalize: false,
  };
}

/** The one reading an English month-name column proves. */
function namedShape(counts: DateCounts): DateShape | undefined {
  if (counts.named !== counts.present) return undefined;
  if (counts.monthFirst !== counts.present && counts.monthFirst !== 0) return undefined;
  const month = counts.abbreviated === counts.present ? "%b" : counts.abbreviated === 0 ? "%B" : undefined;
  if (month === undefined) return undefined;
  const time = timeSuffix(counts);
  if (time === undefined) return undefined;
  const monthFirst = counts.monthFirst === counts.present;
  const date = monthFirst ? `${month} %d, %Y` : `%d ${month} %Y`;
  return { format: `${date}${time}`, type: time === "" ? "DATE" : "TIMESTAMP", normalize: monthFirst };
}

function shapeFor(counts: DateCounts, order: DateOrder): DateShape | undefined {
  return counts.slash === counts.present ? slashShape(counts, order) : namedShape(counts);
}

/**
 * Converts a VARCHAR column whose every non-blank value is one date family,
 * in the one shape every value parses with. The column becomes TIMESTAMP when
 * all non-blank values have the same time format, and DATE when none has a time. A column that mixes a date
 * shape with text, or proves both slash orders, stays as the file wrote it.
 */
async function convertDateColumns(query: Query, table: string, order: DateOrder): Promise<void> {
  const name = quote(table);
  const text = (await query(`DESCRIBE ${name}`))
    .filter((row) => String(row.column_type) === "VARCHAR")
    .map((row) => String(row.column_name));
  if (text.length === 0) return;
  const likely = await dateShapedColumns(query, table, text);
  if (likely.length === 0) return;
  const [row] = await query(`SELECT ${likely.map(dateMeasures).join(", ")} FROM ${name}`);
  if (row === undefined) return;
  for (const [index, column] of likely.entries()) {
    const counts = dateCounts(row, index);
    if (!(counts.present > 0)) continue;
    // A column whose every value is a month with no day becomes the first of
    // that month, before any slash shape is considered.
    if (counts.month === counts.present && counts.monthBad === 0) {
      const field = quote(column);
      const value = `trim(${field})`;
      const blank = `(${field} IS NULL OR ${value} = '')`;
      const year = `CASE WHEN regexp_matches(${value}, '${ISO_MONTH}') THEN CAST(substr(${value}, 1, 4) AS INTEGER) ELSE CAST(substr(${value}, length(${value}) - 3, 4) AS INTEGER) END`;
      const month = `CASE WHEN regexp_matches(${value}, '${ISO_MONTH}') THEN CAST(substr(${value}, 6, 2) AS INTEGER) ELSE CAST(substr(${value}, 1, 2) AS INTEGER) END`;
      await query(
        `ALTER TABLE ${name} ALTER ${field} TYPE DATE USING CASE WHEN ${blank} THEN NULL ELSE make_date(${year}, ${month}, 1) END`,
      );
      continue;
    }
    const shape = shapeFor(counts, order);
    if (shape === undefined) {
      if (counts.slash === counts.present && counts.dayProof > 0 && counts.monthProof > 0) {
        await resolveBothProofs(query, name, column, counts);
      }
      continue;
    }
    await convertWithShape(query, name, column, shape);
  }
}

/**
 * Converts a column under one shape, or leaves it text when a value fails.
 * Only a proved impossible calendar date gets the missing-date note.
 * A month-name value is read with comma
 * spacing normalised, so `April 13,2026` parses with no other change in what
 * reads as a date.
 */
async function convertWithShape(query: Query, name: string, column: string, shape: DateShape): Promise<void> {
  const field = quote(column);
  const value = `trim(${field})`;
  const blank = `(${field} IS NULL OR ${value} = '')`;
  const parsed = shape.normalize ? `regexp_replace(${value}, ',\\s*', ', ')` : value;
  const failed = `NOT ${blank} AND try_strptime(${parsed}, '${shape.format}') IS NULL`;
  const [checked] = await query(`SELECT count(*) FILTER (WHERE ${failed})::DOUBLE AS bad FROM ${name}`);
  if (Number(checked?.bad) > 0) {
    await markMissingDate(query, name, column, field, failed, shape);
    return;
  }
  const read = `try_strptime(${parsed}, '${shape.format}')`;
  const converted = shape.type === "DATE" ? `CAST(${read} AS DATE)` : read;
  await query(`ALTER TABLE ${name} ALTER ${field} TYPE ${shape.type} USING CASE WHEN ${blank} THEN NULL ELSE ${converted} END`);
  if (shape.mark !== undefined) await query(`COMMENT ON COLUMN ${name}.${field} IS '${shape.mark}'`);
}

const textLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Marks a wholly slash column whose candidates prove both orders. A candidate
 * proves an order only when it parses as a real date under that order's full
 * date and time format: `99/04/2026` proves neither order, while
 * `04/13/2026` proves month-first. When exactly one order proves out, the
 * column converts under it or stays text; only a proved impossible calendar
 * date gets the missing-date note. With no valid proof there is no note.
 */
async function resolveBothProofs(query: Query, name: string, column: string, counts: DateCounts): Promise<void> {
  const year = counts.wide === counts.slash ? "%Y" : counts.wide === 0 ? "%y" : undefined;
  const time = timeSuffix(counts);
  if (year === undefined || time === undefined) return;
  const dayFormat = `%d/%m/${year}${time}`;
  const monthFormat = `%m/%d/${year}${time}`;
  const field = quote(column);
  const value = `trim(${field})`;
  const slash = `regexp_matches(${value}, '${SLASH_DATE_TEXT}')`;
  const dayCandidate = `${slash} AND TRY_CAST(regexp_extract(${value}, '${SLASH_DAY_PART}', 1) AS INTEGER) > 12`;
  const monthCandidate = `${slash} AND TRY_CAST(regexp_extract(${value}, '${SLASH_MONTH_PART}', 1) AS INTEGER) > 12`;
  const [row] = await query(
    `SELECT (SELECT ${value} FROM ${name} WHERE ${dayCandidate} AND try_strptime(${value}, '${dayFormat}') IS NOT NULL ORDER BY rowid LIMIT 1) AS day, (SELECT ${value} FROM ${name} WHERE ${monthCandidate} AND try_strptime(${value}, '${monthFormat}') IS NOT NULL ORDER BY rowid LIMIT 1) AS month`,
  );
  if (row?.day != null && row?.month != null) {
    await query(
      `COMMENT ON COLUMN ${name}.${field} IS ${textLiteral(`${BOTH_ORDERS_MARK}:${String(row.day)}|${String(row.month)}`)}`,
    );
    return;
  }
  if (row?.day == null && row?.month == null) return;
  const format = row?.day != null ? dayFormat : monthFormat;
  await convertWithShape(query, name, column, { format, type: time === "" ? "DATE" : "TIMESTAMP", normalize: false });
}

/** Two-digit years read 00 to 68 as 2000 to 2068 and 69 to 99 as 1969 to 1999. */
function fullYear(year: number, wide: boolean): number {
  return wide ? year : year <= 68 ? 2000 + year : 1900 + year;
}

function daysInMonth(month: number, year: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validTime(hour: string | undefined, minute: string | undefined, second: string | undefined, timed: boolean): boolean {
  if (!timed) return hour === undefined;
  if (hour === undefined || minute === undefined) return false;
  return Number(hour) <= 23 && Number(minute) <= 59 && (second === undefined || Number(second) <= 59);
}

const MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * True when a value that failed its shape matches that shape exactly but names
 * a calendar date that cannot exist, such as February 31 or month 13 under the
 * proved order. A spelling the shape does not accept and a bad time get no
 * note. When unsure there is no note.
 */
function calendarImpossible(example: string, format: string, normalize: boolean): boolean {
  const text = normalize ? example.replace(/,\s*/, ", ") : example;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const namedFirst = /^([A-Za-z]+)\s+(\d{1,2}), (\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const namedDayFirst = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  let month = 0;
  let day = 0;
  let year = 0;
  let wide = true;
  let hour: string | undefined;
  let minute: string | undefined;
  let second: string | undefined;
  const dayFirst = format.startsWith("%d/%m");
  const monthFirst = format.startsWith("%m/%d");
  if (dayFirst || monthFirst) {
    const parts = text.match(slash);
    if (parts === null) return false;
    if ((parts[3].length === 4) !== format.includes("%Y")) return false;
    const first = Number(parts[1]);
    const secondPart = Number(parts[2]);
    month = dayFirst ? secondPart : first;
    day = dayFirst ? first : secondPart;
    year = Number(parts[3]);
    wide = parts[3].length === 4;
    [hour, minute, second] = [parts[4], parts[5], parts[6]];
    if (format.includes("%S") !== (second !== undefined)) return false;
  } else {
    const monthFirstNamed = /^%[bB] %d, %Y/.test(format);
    const parts = text.match(monthFirstNamed ? namedFirst : namedDayFirst);
    if (parts === null) return false;
    const name = (monthFirstNamed ? parts[1] : parts[2]).toLowerCase();
    const number = MONTH_NUMBERS[name];
    if (number === undefined) return false;
    month = number;
    day = Number(monthFirstNamed ? parts[2] : parts[1]);
    year = Number(parts[3]);
    [hour, minute, second] = [parts[4], parts[5], parts[6]];
    if (format.includes("%S") !== (second !== undefined)) return false;
  }
  if (!validTime(hour, minute, second, format.includes("%H"))) return false;
  if (!(month >= 1 && month <= 12)) return true;
  if (!(day >= 1)) return true;
  return day > daysInMonth(month, fullYear(year, wide));
}

/** Marks a date column whose failed value is a date that does not exist with that value. */
async function markMissingDate(
  query: Query,
  name: string,
  column: string,
  field: string,
  failed: string,
  shape: DateShape,
): Promise<void> {
  // A column can fail for more than one reason: a bad time fails but is not
  // an impossible calendar date. The note names the first impossible date by
  // row order, so every failing value is read in row order until one proves
  // impossible. Columns that already get a note keep the same note, because
  // their first failing value is already the first impossible one.
  const rows = await query(`SELECT trim(${field}) AS value FROM ${name} WHERE ${failed} ORDER BY rowid`);
  for (const row of rows) {
    if (row?.value == null) continue;
    const example = String(row.value);
    if (!calendarImpossible(example, shape.format, shape.normalize)) continue;
    await query(
      `COMMENT ON COLUMN ${name}.${field} IS ${textLiteral(`${MISSING_DATE_MARK}:${example}`)}`,
    );
    return;
  }
}

// A value read_csv typed as a number may hold NaN or an infinity, which a
// bridge cannot use. The file's own text names the value and its row.
const NON_FINITE_TYPES = ["DOUBLE", "FLOAT"];

/**
 * Returns every numeric column that holds a non-finite value to the file's own
 * text, so the file problems message names the value and its row. One count
 * decides; the file is read again only when a value is found. When the raw read
 * holds a different row count the texts cannot be lined up, so every flagged
 * column becomes text instead, which keeps NaN and the infinities out of a
 * numeric column and lets the file problems message name them.
 */
async function restoreNonFinite(query: Query, table: string, path: string, skip = 0): Promise<void> {
  const described = await query(`DESCRIBE ${quote(table)}`);
  const numeric = described
    .filter((row) => NON_FINITE_TYPES.includes(String(row.column_type)))
    .map((row) => String(row.column_name));
  if (numeric.length === 0) return;
  const flags = numeric.map((column, index) => `count(*) FILTER (WHERE NOT isfinite(${quote(column)}))::DOUBLE AS f${index}`);
  const [counted] = await query(`SELECT count(*)::DOUBLE AS n, ${flags.join(", ")} FROM ${quote(table)}`);
  const flagged = new Set(numeric.filter((_, index) => Number(counted?.[`f${index}`]) > 0));
  if (flagged.size === 0) return;
  const escaped = path.replaceAll("'", "''");
  const skipText = skipOption(skip);
  const [raw] = await query(`SELECT count(*)::DOUBLE AS n FROM read_csv('${escaped}', all_varchar=true, ${CSV_OPTIONS}${skipText})`);
  if (Number(raw?.n) !== Number(counted?.n)) {
    for (const column of flagged) {
      await query(
        `ALTER TABLE ${quote(table)} ALTER ${quote(column)} TYPE VARCHAR USING CAST(${quote(column)} AS VARCHAR)`,
      );
    }
    return;
  }
  const selected = described
    .map((row) => {
      const column = String(row.column_name);
      return flagged.has(column) ? `r.${quote(column)} AS ${quote(column)}` : `t.${quote(column)}`;
    })
    .join(", ");
  await query(
    `CREATE OR REPLACE TABLE ${quote(table)} AS SELECT ${selected} FROM ${quote(table)} AS t POSITIONAL JOIN (SELECT * FROM read_csv('${escaped}', all_varchar=true, ${CSV_OPTIONS}${skipText})) AS r`,
  );
}

function isConversionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Conversion Error");
}

/** The columns read_csv typed as a date, a timestamp or a time. */
async function dateTypedColumns(query: Query, path: string, skip = 0): Promise<string[]> {
  const escaped = path.replaceAll("'", "''");
  const described = await query(`DESCRIBE SELECT * FROM read_csv('${escaped}', ${CSV_OPTIONS}${skipOption(skip)})`);
  return described
    .filter((row) => /^(DATE|TIMESTAMP|TIME)/i.test(String(row.column_type)))
    .map((row) => String(row.column_name));
}

// Excel workbooks flatten to comma CSV before DuckDB sees them, so they load
// through the same options, thousands dots and number conversion as a CSV
// with the same columns and values. Slash dates keep the plain reader's
// order, as before, because that change is for CSV text exports only.
export async function readLoadedTable(
  query: Query,
  table: string,
  path: string,
  isExcel: boolean,
  order: DateOrder = "month first",
  skip = 0,
  bytes?: Blob,
): Promise<void> {
  try {
    await readCsvTable(query, table, path, isExcel, order, skip);
  } catch (error) {
    throw await csvEncodingFailure(error, bytes);
  }
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
 * Counts the leading blank lines in a CSV prefix: empty lines, or lines that
 * hold only whitespace, commas, semicolons or the sniffed separator. The
 * header is the first line after them. A line with letters or digits ends the
 * blank run.
 */
export function leadingBlankLines(prefix: string, delimiter = ""): number {
  const lines = prefix.split(/\r\n|\n|\r/);
  let blanks = 0;
  for (const line of lines) {
    let blank = true;
    for (const char of line) {
      if (delimiter !== "" && char === delimiter) continue;
      if (/[\s,;]/.test(char)) continue;
      blank = false;
      break;
    }
    if (blank) blanks += 1;
    else break;
  }
  return blanks;
}

/** The read_csv skip option for leading blank lines, or "" when there are none. */
function skipOption(skip: number): string {
  return skip > 0 ? `, skip=${skip}` : "";
}

/**
 * Checks the header line after leading blank lines by counting CSV fields
 * with quoting respected. Characters past the end of the prefix are not
 * inspected; a truncated prefix that holds only part of the header is judged
 * on what it holds.
 */
function headerTooWide(prefix: string, delimiter: string, dialect?: CsvDialect, truncated = false): boolean {
  if (delimiter === "") return false;
  return headerFieldCount(prefix, delimiter, dialect, truncated) > MAX_COLUMNS_READ;
}

/**
 * Refuses a CSV whose rows do not all use the sniffed separator, before it is
 * staged. Only a file that holds both marks can mix them, so the sniff that
 * names the separator runs only for those.
 */
export async function refuseMixedSeparators(query: Query, file: File, reading: CsvReading, path: string): Promise<void> {
  const prefix =
    reading.kind === "text"
      ? reading.text.slice(0, CSV_PREFIX_BYTES)
      : new TextDecoder().decode(new Uint8Array(await file.slice(0, CSV_PREFIX_BYTES).arrayBuffer()));
  if (!prefix.includes(",") || !prefix.includes(";")) return;
  // A file with no single separator sniffs as some third character, or as
  // nothing, so both marks are tried when the sniff names neither of them.
  const sniffed = await sniffDialect(query, path);
  const delimiter = sniffed?.delimiter || ",";
  const leading = leadingBlankLines(prefix, delimiter);
  const dialect: CsvDialect = {
    delimiter,
    quote: sniffed?.quote ?? '"',
    escape: sniffed?.escape ?? '"',
    header: sniffed?.header ?? true,
    skipRows: leading,
    comment: sniffed?.comment ?? "",
  };
  const tried = delimiter === ";" || delimiter === "," ? [delimiter] : [",", ";"];
  const truncated = file.size > CSV_PREFIX_BYTES;
  if (tried.length === 2) {
    if (headerFieldCount(prefix, delimiter, dialect, truncated) >= 2) return;
    if (hasConsistentRecords(prefix, delimiter, dialect, truncated)) return;
  }
  for (const candidate of tried) {
    const sentence = mixedSeparatorSentence(prefix, candidate, { ...dialect, delimiter: candidate }, truncated);
    if (sentence !== null) throw new Error(sentence);
  }
}

/**
 * Stages a CSV file's readable path and swaps it into place. The file's own
 * byte length refuses an empty file, its header width refuses a file with too
 * many columns, and the staged table's row count refuses a header-only file,
 * so a refused file leaves the loaded table alone.
 */
export async function stageCsvAndSwap(
  query: Query,
  file: File,
  table: string,
  readablePath: string,
  order: DateOrder = "month first",
  reading?: CsvReading,
): Promise<void> {
  if (file.size === 0) throw new Error(NO_DATA_ROWS);
  const prefix = new TextDecoder().decode(new Uint8Array(await file.slice(0, CSV_PREFIX_BYTES).arrayBuffer()));
  const sniffed = await sniffDialect(query, readablePath);
  const leading = leadingBlankLines(prefix, sniffed?.delimiter || ",");
  const dialectForWidth: CsvDialect = {
    delimiter: sniffed?.delimiter || ",",
    quote: sniffed?.quote ?? '"',
    escape: sniffed?.escape ?? '"',
    header: sniffed?.header ?? true,
    skipRows: leading,
    comment: sniffed?.comment ?? "",
  };
  if (headerTooWide(prefix, dialectForWidth.delimiter, dialectForWidth, file.size > CSV_PREFIX_BYTES)) {
    throw new Error(TOO_MANY_COLUMNS_SENTENCE);
  }
  const staging = `${table}__staging`;
  const source: SourceRows = { kind: "csv", file, dialect: dialectForWidth };
  // A file that readCsvFile decoded as text was never handed to the database as
  // bytes, so it keeps its own error.
  await readLoadedTable(query, staging, readablePath, false, order, leading, reading?.kind === "bytes" ? file : undefined);
  await convertFormattedNumbers(query, staging, source);
  // No mixed-separator check: a record split by another separator can match a valid sparse record byte for byte.
  await requireDataRows(query, staging);
  // The source is recorded with the swap, so a refused file keeps the last
  // load's rows beside the last load's table. Nothing is read and nothing is
  // counted here.
  await swapWithSourceRows(query, table, source, () => swapLoadedTable(query, staging, table));
}

/**
 * Stages an Excel workbook's flattened sheet and swaps it into place, as
 * `loadFile` does. `dataRows` is the spreadsheet row of each data row, which
 * the sheet reader already knows. `sheet` names the worksheet it loaded and
 * counts the ones it left out, when the workbook held more than one.
 */
export async function stageExcelAndSwap(
  query: Query,
  table: string,
  readablePath: string,
  holes: readonly number[],
  dataRows: readonly number[],
  sheet: { readonly name: string; readonly others: number } = { name: "", others: 0 },
  order: DateOrder = "month first",
): Promise<void> {
  const staging = `${table}__staging`;
  const source: SourceRows = { kind: "sheet", rows: dataRows };
  await readLoadedTable(query, staging, readablePath, true, order);
  if (holes.length > 0) {
    const described = await query(`DESCRIBE ${quote(staging)}`);
    const names = described.map((row) => String(row.column_name));
    for (const rename of holeRenames(names, holes)) {
      if (rename.from === rename.to) continue;
      await query(`ALTER TABLE ${quote(staging)} RENAME COLUMN ${quote(rename.from)} TO ${quote(rename.to)}`);
    }
  }
  await convertFormattedNumbers(query, staging, source);
  await requireDataRows(query, staging);
  if (sheet.others > 0 && sheet.name !== "") {
    await query(`COMMENT ON TABLE ${quote(staging)} IS 'sheet:${sheet.name.replaceAll("'", "''")}|${sheet.others}'`);
  }
  await swapWithSourceRows(query, table, source, () => swapLoadedTable(query, staging, table));
}

/**
 * Swaps a staged load into place: the old table stays until the staged one is
 * fully converted and checked, so a refused file leaves the loaded data alone.
 */
export async function swapLoadedTable(query: Query, staging: string, table: string): Promise<void> {
  const previous = `${table}__previous`;
  await query(`DROP TABLE IF EXISTS ${quote(previous)}`);
  // Asking first keeps a first load from running a rename that must fail, which
  // the database worker logs as a console error.
  const [existing] = await query(
    `SELECT count(*)::DOUBLE AS n FROM duckdb_tables() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}'`,
  );
  let renamed = false;
  if (Number(existing?.n) > 0) {
    try {
      await query(`ALTER TABLE ${quote(table)} RENAME TO ${quote(previous)}`);
      renamed = true;
    } catch {
      // A table the catalog names but the rename cannot move stays as it is.
    }
  }
  try {
    await query(`ALTER TABLE ${quote(staging)} RENAME TO ${quote(table)}`);
  } catch (error) {
    if (renamed) await query(`ALTER TABLE ${quote(previous)} RENAME TO ${quote(table)}`).catch(() => {});
    throw error;
  }
  await query(`DROP TABLE IF EXISTS ${quote(previous)}`);
}

/**
 * The DATE columns whose four-digit slash values prove neither order, and the
 * order the load delivered them in, so the caller can swap the ones the target
 * order reads the other way.
 */
async function ambiguousDateColumns(
  query: Query,
  table: string,
  path: string,
  skip = 0,
): Promise<{ ambiguous: string[]; loaded?: DateOrder }> {
  const described = await query(`DESCRIBE ${quote(table)}`);
  const names = described.map((row) => String(row.column_name));
  const dates = described
    .filter((row) => String(row.column_type) === "DATE")
    .map((row) => String(row.column_name));
  if (dates.length === 0) return { ambiguous: [] };
  const escaped = path.replaceAll("'", "''");
  const source = `read_csv('${escaped}', all_varchar=true, ${CSV_OPTIONS}${skipOption(skip)})`;
  const sourceNames = (await query(`DESCRIBE SELECT * FROM ${source}`)).map((row) => String(row.column_name));
  if (sourceNames.length !== names.length || sourceNames.some((name, index) => name !== names[index])) {
    return { ambiguous: [] };
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
  if (!row) return { ambiguous: [] };
  const count = (key: string) => Number(row[key]);
  // Only a file whose every DATE value is a four-digit slash date is in scope.
  // A three-digit year is read as a date too, so it would otherwise change the
  // order without being seen here.
  if (dates.some((_, index) => count(`s${index}`) !== count(`n${index}`))) {
    return { ambiguous: [] };
  }
  // The order is read from the values the load delivered. Every value must
  // match one reading, or the file keeps the order it was read with.
  const delivered: DateOrder | undefined = dates.every((_, index) => count(`m${index}`) === count(`n${index}`))
    ? "month first"
    : dates.every((_, index) => count(`d${index}`) === count(`n${index}`))
      ? "day first"
      : undefined;
  if (delivered === undefined) return { ambiguous: [] };
  const ambiguous = dates.filter((_, index) => count(`s${index}`) > 0 && count(`p${index}`) === 0);
  return { ambiguous, loaded: delivered };
}

export async function dateOrderNote(query: Query, table: string): Promise<string | null> {
  const marks = DATE_ORDER_MARKS.map((mark) => `'${mark}'`).join(", ");
  const rows = await query(
    `SELECT column_name, comment FROM duckdb_columns() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}' AND (comment IN (${marks}) OR comment LIKE '${BOTH_ORDERS_MARK}:%' OR comment LIKE '${MISSING_DATE_MARK}:%') ORDER BY column_name`,
  );
  const comments = rows.map((row) => ({ name: String(row.column_name), comment: String(row.comment ?? "") }));
  const sentences: string[] = [];
  for (const [mark, reading, byLanguage] of [
    [MONTH_FIRST_MARK, "month-first", false],
    [DAY_FIRST_MARK, "day-first", false],
    [SLASH_MONTH_FIRST_MARK, "month-first", true],
    [SLASH_DAY_FIRST_MARK, "day-first", true],
  ] as const) {
    const names = comments.filter((column) => column.comment === mark).map((column) => column.name);
    if (names.length === 0) continue;
    const count = names.length === 1 ? "1 column" : `${names.length} columns`;
    const verb = names.length === 1 ? "was" : "were";
    const why = byLanguage ? ", as this browser's language expects" : "";
    sentences.push(`${count} with slash dates ${verb} read ${reading}${why}: ${names.join(", ")}.`);
  }
  for (const { name, comment } of comments) {
    if (comment.startsWith(`${BOTH_ORDERS_MARK}:`)) {
      const body = comment.slice(BOTH_ORDERS_MARK.length + 1);
      const cut = body.indexOf("|");
      if (cut < 0) continue;
      sentences.push(
        `${name} has slash dates in both orders, such as ${body.slice(0, cut)} and ${body.slice(cut + 1)}, so it was read as text.`,
      );
    } else if (comment.startsWith(`${MISSING_DATE_MARK}:`)) {
      sentences.push(
        `${name} has a date that does not exist, such as ${comment.slice(MISSING_DATE_MARK.length + 1)}, so it was read as text.`,
      );
    }
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}

// read_csv only reads UTF-8. When a file whose prefix passed is refused by the
// database, its own bytes decide whether the encoding sentence replaces the
// error: a file that is not UTF-8 anywhere shows the sentence, and any other
// failure is shown as it is.
async function csvEncodingFailure(error: unknown, bytes?: Blob): Promise<unknown> {
  if (bytes === undefined || isOutOfMemory(error)) return error;
  return isValidUtf8(new Uint8Array(await bytes.arrayBuffer())) ? error : new Error(ENCODING_SENTENCE);
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
    // The raw runner. Only the queue below, and a load's own statements, reach it.
    const raw: Query = async (sql) => {
      const result = await connection.query(sql);
      return result.toArray().map((row) => row.toJSON() as Record<string, unknown>);
    };
    /**
     * Every statement the page issues goes through here, so the one connection
     * runs one statement at a time. A statement that replaces the loaded table
     * takes a turn of its own.
     */
    const query: Query = (sql) =>
      statementStartsTurn(sql) ? statements.turn(() => raw(sql)) : statements.schedule(() => raw(sql));
    /** Loads a file into `table` and returns its data-row formulas with no saved result (zero for a CSV). */
    const load = async (file: File, table: string): Promise<number> => {
      try {
        if (/\.parquet$/i.test(file.name)) {
          throw new Error(PARQUET_REFUSAL);
        }
        const isExcel = /\.xlsx$/i.test(file.name);
        if (!isExcel && !/\.(csv|tsv|txt)$/i.test(file.name)) {
          throw new Error("Use a CSV or Excel (.xlsx) file");
        }
        const order = orderForLanguage(navigator.language);
        const registered = "upload.csv";
        if (uploadRegistered) {
          await db.dropFile(registered);
          uploadRegistered = false;
        }
        let sheet: { name: string; others: number } = { name: "", others: 0 };
        let excelHoles: readonly number[] = [];
        let excelRows: readonly number[] = [];
        let formulaBlanks = 0;
        let reading: CsvReading | undefined;
        if (isExcel) {
          const first = await firstSheetAsCsv(file);
          excelHoles = first.holes;
          excelRows = first.dataRows;
          formulaBlanks = first.formulaBlanks;
          sheet = { name: first.sheetName, others: first.otherSheets };
          await db.registerFileText(registered, first.csv);
        } else {
          reading = await readCsvFile(file);
          if (reading.kind === "bytes") {
            await db.registerFileHandle(registered, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
          } else {
            await db.registerFileText(registered, reading.text);
          }
        }
        uploadRegistered = true;
        // A refused file must leave the loaded data alone, so the new file
        // converts on a staging table and only swaps into place once it has
        // rows. The empty check, the swap and afterLoad all run after this.
        if (isExcel) {
          await stageExcelAndSwap(raw, table, registered, excelHoles, excelRows, sheet, order);
        } else if (reading !== undefined) {
          await refuseMixedSeparators(raw, file, reading, registered);
          await stageCsvAndSwap(raw, file, table, registered, order, reading);
        }
        return formulaBlanks;
      } catch (error) {
        throw loadFailure(error);
      }
    };
    return {
      query,
      /**
       * A load is one turn, and its own statements use the raw runner, so it
       * never waits behind itself while still waiting out the statement before it.
       */
      loadFile: (file: File, table: string) => statements.turn(() => load(file, table)),
    };
  } catch (error) {
    noteWorkerScript(error, workerScriptUrl);
    script.worker.terminate();
    throw error;
  } finally {
    script.release();
  }
}

