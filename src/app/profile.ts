import type { Query } from "../engine.ts";
import { isDate, isNumeric, quote, TABLE, type Column, type Filter, type Setup } from "./setup.ts";
import { measureColumns, type UnreadCell } from "./fileProblems.ts";
import { readsAsNumber } from "./numbers.ts";
import { readCsvFile } from "./encoding.ts";

const SAMPLE_ROWS = 200_000;
const MAX_CANDIDATES = 14;
const MAX_DISTINCT = 5_000;

/**
 * Same numbers as count(DISTINCT col) and as count(DISTINCT (a, b)) filtered
 * to rows where both are non-null. Grouping the sample once is cheaper than
 * a distinct aggregate for every pair.
 */
function sampleCountSql(candidates: string[], pairs: [string, string][]): string {
  const sets = [
    ...candidates.map((column) => `(${quote(column)})`),
    ...pairs.map(([a, b]) => `(${quote(a)}, ${quote(b)})`),
  ];
  const grouped = (want: ReadonlySet<string>) =>
    candidates.map((column) => `grouping(${quote(column)}) = ${want.has(column) ? 0 : 1}`).join(" AND ");
  const arms = [
    ...candidates.map((column, i) => ({
      key: `d${i}`,
      when: grouped(new Set([column])),
      keep: `${quote(column)} IS NOT NULL`,
    })),
    ...pairs.map(([a, b], i) => ({
      key: `p${i}`,
      when: grouped(new Set([a, b])),
      keep: `${quote(a)} IS NOT NULL AND ${quote(b)} IS NOT NULL`,
    })),
  ];
  const listed = candidates.map(quote).join(", ");
  const choice = arms.map((arm) => `WHEN ${arm.when} THEN '${arm.key}'`).join(" ");
  const keep = arms.map((arm) => `WHEN ${arm.when} THEN ${arm.keep}`).join(" ");
  return `WITH s AS MATERIALIZED (
      SELECT ${listed} FROM ${quote(TABLE)} USING SAMPLE ${SAMPLE_ROWS} ROWS
    )
    SELECT key, count(*)::DOUBLE AS n
    FROM (
      SELECT CASE ${choice} END AS key
      FROM s
      GROUP BY GROUPING SETS (${sets.join(", ")})
      HAVING CASE ${keep} ELSE FALSE END
    )
    GROUP BY key`;
}

/** Exact distinct count per column, used to label the attribute pickers. */
export async function distinctCounts(query: Query, columns: Column[]): Promise<Map<string, number>> {
  const [row] = await query(
    `SELECT ${columns.map((c, i) => `count(DISTINCT ${quote(c.name)})::DOUBLE AS c${i}`).join(", ")} FROM ${quote(TABLE)}`,
  );
  return new Map(columns.map((c, i) => [c.name, Number(row[`c${i}`])]));
}

export interface FileProfile {
  /** The file's columns with their distinct counts. */
  columns: Column[];
  /** Roll-up chains, broadest first. */
  rollups: string[][];
}

/**
 * How DuckDB's sniffer read a CSV, which read_csv then used. `quote` and
 * `escape` are one character, or "" for none.
 */
export interface CsvDialect {
  readonly delimiter: string;
  /** "" means the file uses no quotes. */
  readonly quote: string;
  /** "" means a doubled quote stands for one quote. */
  readonly escape: string;
  readonly header: boolean;
  readonly skipRows: number;
  readonly comment: string;
}

/**
 * Where each loaded record sits in the file it came from, as the load knew it
 * for free. A sheet already knows its rows. A CSV keeps the file and the
 * dialect the reader used, and is read again only when a sentence is about to
 * name a row.
 */
export type SourceRows =
  | { readonly kind: "sheet"; readonly rows: readonly number[] }
  | { readonly kind: "csv"; readonly file: Blob; readonly dialect: CsvDialect | undefined };

// One entry per database and table. The loader is the only writer, and it
// writes after its swap succeeds, so a refused file leaves the last load's
// entry beside the last load's table. A table built in SQL has no entry.
const sourceRowsByDatabase = new WeakMap<Query, Map<string, SourceRows>>();

/** Records where `table`'s rows came from. Reads nothing and costs no query. */
export function rememberSourceRows(query: Query, table: string, rows: SourceRows): void {
  let tables = sourceRowsByDatabase.get(query);
  if (tables === undefined) {
    tables = new Map();
    sourceRowsByDatabase.set(query, tables);
  }
  tables.set(table, rows);
}

/** A first unread cell before the file's own row is known. */
interface UnreadCandidate {
  readonly column: string;
  readonly value: string;
  /** 0-based position among the loaded records, as rowid counts. */
  readonly ordinal: number;
  /** 0-based position of the column, which is its field in the file. */
  readonly field: number;
  /** Loaded records in the table: the count the locator's proof must match. */
  readonly records: number;
}

interface FieldAsk {
  readonly ordinal: number;
  readonly field: number;
}

interface FoundField {
  readonly row: number;
  readonly text: string;
}

interface RecordScan {
  /** Loaded records after the header. */
  readonly dataRecords: number;
  /** Per ask, in order: the spreadsheet row of that record and that field's text. */
  readonly found: readonly (FoundField | undefined)[];
}

/**
 * The first cell of a measure column that does not read as a number, when more
 * than half of the column's filled cells do. The locator uses the loader's
 * source positions when present. Otherwise, it counts loaded records with
 * the header as row 1.
 */
async function firstUnreadIn(query: Query, column: string): Promise<UnreadCandidate | undefined> {
  const field = quote(column);
  const text = `CAST(${field} AS VARCHAR)`;
  const blank = `(${field} IS NULL OR trim(${text}) = '')`;
  const unread = `NOT ${blank} AND NOT ${readsAsNumber(field)}`;
  // The column's field position rides along in the same statement, so naming a
  // row never costs a second pass over the table.
  const position = `(SELECT column_index - 1 FROM duckdb_columns()
    WHERE schema_name = current_schema() AND table_name = '${TABLE.replaceAll("'", "''")}'
      AND column_name = '${column.replaceAll("'", "''")}')::DOUBLE`;
  const [row] = await query(
    `SELECT count(*) FILTER (WHERE NOT ${blank})::DOUBLE AS present,
            count(*) FILTER (WHERE NOT ${blank} AND ${readsAsNumber(field)})::DOUBLE AS parsed,
            count(*)::DOUBLE AS records,
            arg_min(${text}, rowid) FILTER (WHERE ${unread}) AS value,
            min(rowid) FILTER (WHERE ${unread}) AS at,
            ${position} AS field
     FROM ${quote(TABLE)}`,
  );
  const present = Number(row?.present);
  const parsed = Number(row?.parsed);
  if (!(present > 0) || parsed * 2 <= present) return undefined;
  if (row?.value == null || row?.at == null || row?.field == null) return undefined;
  const ordinal = Number(row.at);
  const at = Number(row.field);
  if (!Number.isFinite(ordinal) || !Number.isFinite(at)) return undefined;
  return { column, value: String(row.value), ordinal, field: at, records: Number(row.records) };
}

type FieldMode = "start" | "unquoted" | "quoted" | "escaped" | "quoteSeen";

/**
 * Reads a CSV the way the loader did and counts record slots, which are the
 * spreadsheet's rows: a line break outside a quoted field ends one slot, a
 * completely empty slot is a row the loader skips, and a break inside quotes
 * belongs to its record. Undefined when the text ends inside a quoted field,
 * or when a closing quote is followed by something the reader would refuse.
 */
async function scanCsvRecords(
  file: Blob,
  dialect: CsvDialect,
  asks: readonly FieldAsk[],
): Promise<RecordScan | undefined> {
  const asked = new Map<number, Map<number, number>>();
  asks.forEach((ask, index) => {
    const fields = asked.get(ask.ordinal) ?? new Map<number, number>();
    fields.set(ask.field, index);
    asked.set(ask.ordinal, fields);
  });
  const found: (FoundField | undefined)[] = asks.map(() => undefined);
  const delimiter = dialect.delimiter;
  const quoteChar = dialect.quote;
  // The reader treats a doubled quote as one quote, and the sniffer reports that
  // convention as either an empty escape or the quote itself.
  const escapeChar = dialect.escape === quoteChar ? "" : dialect.escape;
  const headerOffset = dialect.header ? 1 : 0;

  let slot = 1;
  let loaded = 0;
  let empty = true;
  let field = 0;
  let mode: FieldMode = "start";
  let carryCR = false;
  let recordRow = 1;
  let wanted: Map<number, number> | undefined;
  let captured: string[] = [];

  const capture = (char: string) => {
    if (wanted === undefined || !wanted.has(field)) return;
    captured[field] = (captured[field] ?? "") + char;
  };

  const endSlot = () => {
    if (!empty) {
      if (wanted !== undefined) {
        for (const [fieldIndex, ask] of wanted) {
          found[ask] = { row: recordRow, text: captured[fieldIndex] ?? "" };
        }
      }
      loaded += 1;
    }
    empty = true;
    field = 0;
    mode = "start";
    wanted = undefined;
    slot += 1;
  };

  const nextField = () => {
    field += 1;
    mode = "start";
  };

  // Read inside a closure, because the state changes only in `feed`.
  const insideQuotes = () => mode === "quoted" || mode === "escaped";

  const feed = (text: string): boolean => {
    for (const char of text) {
      if (carryCR) {
        carryCR = false;
        if (char === "\n") continue;
      }
      if (!insideQuotes() && (char === "\r" || char === "\n")) {
        endSlot();
        carryCR = char === "\r";
        continue;
      }
      if (empty) {
        empty = false;
        recordRow = slot;
        wanted = asked.get(loaded - headerOffset);
        captured = [];
      }
      switch (mode) {
        case "start":
          if (char === delimiter) nextField();
          // A space before an opening quote keeps the quote eligible, and a
          // tab does too unless the file separates fields with it.
          else if (char === " " || (char === "\t" && delimiter !== "\t")) break;
          else if (quoteChar !== "" && char === quoteChar) mode = "quoted";
          else {
            mode = "unquoted";
            capture(char);
          }
          break;
        case "unquoted":
          if (char === delimiter) nextField();
          else capture(char);
          break;
        case "quoted":
          if (escapeChar !== "" && char === escapeChar) mode = "escaped";
          else if (char === quoteChar) mode = "quoteSeen";
          else capture(char);
          break;
        case "escaped":
          capture(char);
          mode = "quoted";
          break;
        case "quoteSeen":
          if (char === quoteChar) {
            capture(char);
            mode = "quoted";
          } else if (char === delimiter) nextField();
          else if (char !== " " && char !== "\t") return false;
          break;
      }
    }
    return true;
  };

  const reading = await readCsvFile(file);
  if (reading.kind === "text") {
    if (!feed(reading.text)) return undefined;
  } else {
    const decoder = new TextDecoder("utf-8");
    const reader = file.stream().getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!feed(decoder.decode(chunk.value, { stream: true }))) return undefined;
      }
    } finally {
      reader.releaseLock();
    }
    if (!feed(decoder.decode())) return undefined;
  }
  if (insideQuotes()) return undefined;
  if (!empty) endSlot();
  return { dataRecords: loaded - headerOffset, found };
}

/**
 * The spreadsheet row of each candidate, or undefined where the file cannot
 * prove one. A sheet already knows its rows. A CSV is read once, and only a
 * record count that matches the table, with the named row holding the named
 * text, proves a row.
 */
async function locateRows(
  source: SourceRows | undefined,
  cells: readonly UnreadCandidate[],
): Promise<readonly (number | undefined)[]> {
  if (source === undefined) return cells.map((cell) => cell.ordinal + 2);
  if (source.kind === "sheet") {
    return cells.map((cell) =>
      source.rows.length === cell.records && cell.ordinal < source.rows.length ? source.rows[cell.ordinal] : undefined,
    );
  }
  const dialect = source.dialect;
  if (dialect === undefined || dialect.delimiter.length !== 1 || dialect.skipRows !== 0 || dialect.comment !== "") {
    return cells.map(() => undefined);
  }
  const scan = await scanCsvRecords(source.file, dialect, cells);
  if (scan === undefined) return cells.map(() => undefined);
  return cells.map((cell, index) => {
    const found = scan.found[index];
    if (scan.dataRecords !== cell.records || found === undefined) return undefined;
    return found.text.trim() === cell.value.trim() ? found.row : undefined;
  });
}

/**
 * Profiles the loaded file: distinct counts for every column, then the roll-up
 * chains. `apply` runs only while `isCurrent()` still holds, so a profile that
 * finishes after a later file has loaded is dropped instead of overwriting it.
 */
export async function profileFile(
  query: Query,
  columns: Column[],
  isCurrent: () => boolean,
  apply: (profile: FileProfile) => void,
): Promise<void> {
  const source = sourceRowsByDatabase.get(query)?.get(TABLE);
  const distinct = await distinctCounts(query, columns);
  const measures = new Set(measureColumns(columns));
  const candidates: UnreadCandidate[] = [];
  for (const column of columns) {
    if (!measures.has(column.name) || isNumeric(column.type) || isDate(column.type)) continue;
    const cell = await firstUnreadIn(query, column.name).catch(() => undefined);
    if (cell !== undefined) candidates.push(cell);
  }
  if (!isCurrent()) return;
  const located =
    candidates.length === 0
      ? []
      : await locateRows(source, candidates).catch(() => candidates.map(() => undefined));
  const unread = new Map<string, UnreadCell>();
  candidates.forEach((cell, index) => {
    const row = located[index];
    unread.set(cell.column, row === undefined ? { value: cell.value } : { value: cell.value, row });
  });
  const rollups = await findRollups(query, columns, distinct);
  if (!isCurrent()) return;
  apply({
    columns: columns.map((column) => ({
      ...column,
      distinct: distinct.get(column.name),
      ...(unread.has(column.name) ? { firstUnread: unread.get(column.name) } : {}),
    })),
    rollups,
  });
}


// A column name looks like a customer, region, date or id column when any
// word in it is one of these, where a word is a part split on
// non-alphanumerics and camelCase boundaries, lowercased.
const NON_ATTRIBUTE_WORDS = new Set([
  "customer",
  "customers",
  "client",
  "clients",
  "kunde",
  "kunden",
  "kundennummer",
  "kundennr",
  "account",
  "accounts",
  "region",
  "regions",
  "country",
  "countries",
  "state",
  "states",
  "province",
  "provinces",
  "city",
  "cities",
  "town",
  "towns",
  "zip",
  "postal",
  "territory",
  "territories",
  "district",
  "districts",
  "county",
  "counties",
  "store",
  "stores",
  "branch",
  "branches",
  "location",
  "locations",
  "date",
  "dates",
  "time",
  "times",
  "year",
  "years",
  "month",
  "months",
  "quarter",
  "quarters",
  "period",
  "periods",
  "day",
  "days",
  "week",
  "weeks",
  "id",
  "ids",
  "key",
  "keys",
  "code",
  "codes",
  "uuid",
  "guid",
  "number",
  "numbers",
]);

function nameWords(name: string): string[] {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "")
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((word) => word.toLowerCase());
}

/**
 * Returns the columns that look like product attributes, fewest distinct
 * values first with ties in file order. Keeps columns that are neither
 * numeric nor dates, which includes text and true/false columns, with 2 to
 * 5000 distinct values, drops the used period and measure columns and names
 * with a customer, region, date or id word.
 */
export function suggestAttributes(
  columns: Column[],
  distinct: Map<string, number>,
  used: ReadonlySet<string>,
): string[] {
  const scored: { name: string; n: number; index: number }[] = [];
  columns.forEach((column, index) => {
    if (used.has(column.name)) return;
    if (isNumeric(column.type) || isDate(column.type)) return;
    const n = distinct.get(column.name) ?? 0;
    if (n < 2 || n > MAX_DISTINCT) return;
    if (nameWords(column.name).some((word) => NON_ATTRIBUTE_WORDS.has(word))) return;
    scored.push({ name: column.name, n, index });
  });
  scored.sort((a, b) => (a.n === b.n ? a.index - b.index : a.n - b.n));
  return scored.map((entry) => entry.name);
}

/**
 * Finds columns that roll up into one another, such as product > family >
 * category, by checking that each value of the finer column sits under one
 * value of the broader one. Checked on a sample, so it is a suggestion.
 * Returns chains ordered from broadest to finest.
 */
export async function findRollups(
  query: Query,
  columns: Column[],
  distinct: Map<string, number>,
): Promise<string[][]> {
  const candidates = columns
    .filter((c) => !isNumeric(c.type) && !isDate(c.type))
    .filter((c) => {
      const n = distinct.get(c.name) ?? 0;
      return n >= 2 && n <= MAX_DISTINCT;
    })
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.name);
  if (candidates.length < 2) return [];

  const pairs: [string, string][] = [];
  for (const a of candidates) for (const b of candidates) if (a < b) pairs.push([a, b]);
  const rows = await query(sampleCountSql(candidates, pairs));
  const byKey = new Map(rows.map((row) => [String(row.key), Number(row.n)]));
  const count = new Map(candidates.map((c, i) => [c, byKey.get(`d${i}`) ?? 0]));
  // finer -> the broader columns it sits under
  const parents = new Map<string, Set<string>>(candidates.map((c) => [c, new Set()]));
  pairs.forEach(([a, b], i) => {
    const together = byKey.get(`p${i}`) ?? 0;
    const [finer, broader] = count.get(a)! > count.get(b)! ? [a, b] : [b, a];
    if (count.get(finer)! > count.get(broader)! && together === count.get(finer)) parents.get(finer)!.add(broader);
  });

  const isParent = new Set([...parents.values()].flatMap((set) => [...set]));
  const chains: string[][] = [];
  for (const leaf of candidates) {
    if (isParent.has(leaf) || parents.get(leaf)!.size === 0) continue;
    // Walk up through parents that also nest in one another.
    const above = [...parents.get(leaf)!].sort((a, b) => count.get(b)! - count.get(a)!);
    const chain = [leaf];
    for (const column of above) {
      if (parents.get(chain[chain.length - 1])!.has(column)) chain.push(column);
    }
    chains.push(chain.reverse());
  }
  return chains;
}

const TOTAL_ROW_VALUES = ["total", "totals", "grand total", "subtotal", "sub-total", "sub total"];

const stringLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface TotalRow {
  column: string;
  /** The value exactly as CAST(column AS VARCHAR) returns it, so an exclude filter matches it. */
  value: string;
  rows: number;
}

/**
 * Finds values in the period column or a level column that name a total, such
 * as "Grand Total". A spreadsheet export's total row would otherwise count the
 * same amounts twice. One query covers every candidate column.
 */
export async function findTotalRows(query: Query, table: string, setup: Setup): Promise<TotalRow[]> {
  const columns = [...new Set([setup.periodColumn, ...setup.levels.flatMap((level) => level.columns)])].filter(
    (column) => column !== "",
  );
  if (columns.length === 0) return [];
  const wanted = TOTAL_ROW_VALUES.map(stringLiteral).join(", ");
  const arms = columns.map((column) => {
    const cast = `CAST(${quote(column)} AS VARCHAR)`;
    return `SELECT ${stringLiteral(column)} AS col, ${cast} AS v
      FROM ${quote(table)}
      WHERE trim(regexp_replace(lower(trim(${cast})), ':$', '')) IN (${wanted})`;
  });
  let rows: Record<string, unknown>[];
  try {
    rows = await query(
      `SELECT col, v, count(*)::DOUBLE AS n
       FROM (${arms.join(" UNION ALL ")}) t
       GROUP BY col, v`,
    );
  } catch {
    return [];
  }
  const order = new Map(columns.map((column, i) => [column, i]));
  return rows
    .map((row) => ({ column: String(row.col), value: String(row.v), rows: Number(row.n) }))
    .sort(
      (a, b) =>
        order.get(a.column)! - order.get(b.column)! ||
        b.rows - a.rows ||
        (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
}

export interface TotalRowOffer {
  key: string;
  sentence: string;
  button: string;
  /** The whole filter list the button sets. */
  filters: Filter[];
}

/** Offers to exclude a detected total row, unless its column is already filtered against it. */
export function totalRowOffers(found: readonly TotalRow[], filters: readonly Filter[]): TotalRowOffer[] {
  const includes = new Set(filters.filter((filter) => filter.mode === "include").map((filter) => filter.column));
  const offers: TotalRowOffer[] = [];
  for (const row of found) {
    if (includes.has(row.column)) continue;
    const excludes = filters.find((filter) => filter.column === row.column && filter.mode === "exclude");
    if (excludes?.values.includes(row.value)) continue;
    const plural = row.rows > 1;
    offers.push({
      key: `${row.column}|${row.value}`,
      sentence: plural
        ? `${row.rows.toLocaleString("en-US")} rows have "${row.value}" in ${row.column}. They look like total rows, which would count the same amounts twice.`
        : `1 row has "${row.value}" in ${row.column}. It looks like a total row, which would count the same amounts twice.`,
      button: plural ? "Leave these rows out" : "Leave this row out",
      filters: excludes
        ? filters.map((filter) => (filter === excludes ? { ...filter, values: [...filter.values, row.value] } : filter))
        : [...filters, { column: row.column, mode: "exclude", values: [row.value] }],
    });
  }
  return offers;
}
