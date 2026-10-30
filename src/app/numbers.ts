import { amountsNote, DEFAULT_CELLS_TABLE, HUGE_AMOUNTS, type Query } from "../engine.ts";
import { readCsvFile } from "./encoding.ts";
import { isNumeric, PERIOD, VIEW } from "./setup.ts";
import type { CsvDialect } from "./profile.ts";

/** The most fields a header may hold before the file is refused as too wide. */
export const MAX_COLUMNS_READ = 10_000;

/** A file refused because of its width, not its size. */
export const TOO_MANY_COLUMNS_SENTENCE =
  "This file has too many columns to open in this browser. Save it with fewer columns.";

// read_csv options that keep well-formed files identical while letting short
// rows load with blanks. null_padding pads short rows, parallel=false keeps
// the single-threaded sniff the plain reader used for quoted line breaks.
export const CSV_OPTIONS = "null_padding=true, parallel=false";

const COMMA_TAIL = ",\\d{1,2}";
const COMMA_THREE = ",\\d{3}";
const COMMA_LONG = ",\\d{4,}";
const GROUPED = `^-?\\d{1,3}(\\.\\d{3})*(${COMMA_TAIL})?$`;
const PLAIN = `^-?\\d+${COMMA_TAIL}$`;
const GROUPED_THREE = `^-?\\d{1,3}(\\.\\d{3})*(${COMMA_THREE})$`;
const PLAIN_THREE = `^-?\\d+${COMMA_THREE}$`;
const GROUPED_LONG = `^-?\\d{1,3}(\\.\\d{3})*(${COMMA_LONG})$`;
const PLAIN_LONG = `^-?\\d+${COMMA_LONG}$`;
const DECIMAL_TAIL = `${COMMA_TAIL}$`;
const LONG_TAIL = `${COMMA_LONG}$`;
const SIGN = "[+-]?";
const US_PROOF = `^${SIGN}(\\d{1,3}(,\\d{3})+\\.\\d+|\\d+\\.(\\d{1,2}|\\d{4,}))$`;
const COMMA_PROOF = `^${SIGN}(\\d{1,3}(\\.\\d{3})+,\\d+|\\d+,(\\d{1,2}|\\d{4,})|\\d{4,},\\d{3})$`;
const US_DECIMAL = `^${SIGN}\\d+(,\\d{3})*(\\.\\d{1,2}|\\.\\d{4,})$`;
const US_THREE = `^${SIGN}(\\d{1,3}(,\\d{3})+|\\d{4,})\\.\\d{3}$`;
const US_GROUPED = `^${SIGN}\\d{1,3}(,\\d{3}){2,}$`;
const AMBIGUOUS = `^${SIGN}[1-9]\\d{0,2},\\d{3}$`;

const SYMBOL = "[^\\P{Sc}$]";
const CODE =
  "(?:AED|AFN|ALL|AMD|AOA|ARS|AUD|AWG|AZN|BAM|BBD|BDT|BGN|BHD|BIF|BMD|BND|BOB|BOV|BRL|BSD|BTN|BWP|BYN|BZD|CAD|CDF|CHE|CHF|CHW|CLF|CLP|CNY|COP|COU|CRC|CUP|CVE|CZK|DJF|DKK|DOP|DZD|EGP|ERN|ETB|EUR|FJD|FKP|GBP|GEL|GHS|GIP|GMD|GNF|GTQ|GYD|HKD|HNL|HTG|HUF|IDR|ILS|INR|IQD|IRR|ISK|JMD|JOD|JPY|KES|KGS|KHR|KMF|KPW|KRW|KWD|KYD|KZT|LAK|LBP|LKR|LRD|LSL|LYD|MAD|MDL|MGA|MKD|MMK|MNT|MOP|MRU|MUR|MVR|MWK|MXN|MXV|MYR|MZN|NAD|NGN|NIO|NOK|NPR|NZD|OMR|PAB|PEN|PGK|PHP|PKR|PLN|PYG|QAR|RON|RSD|RUB|RWF|SAR|SBD|SCR|SDG|SEK|SGD|SHP|SLE|SOS|SRD|SSP|STN|SVC|SYP|SZL|THB|TJS|TMT|TND|TOP|TRY|TTD|TWD|TZS|UAH|UGX|USD|USN|UYI|UYU|UYW|UZS|VED|VES|VND|VUV|WST|XAD|XAF|XAG|XAU|XBA|XBB|XBC|XBD|XCD|XCG|XDR|XOF|XPD|XPF|XPT|XSU|XTS|XUA|XXX|YER|ZAR|ZMW|ZWG)";
const MARK = "[\\x{00A0}\\x{202F}\\x27\\x{2019}]";
const MARKER_AT_START = `^(-?)((?:${SYMBOL})|(?:${CODE} ?))([+-]?\\d.*)$`;
const MARKER_AT_END = `^(.+\\d)((?:${SYMBOL})|(?: ?${CODE}))$`;
const MARKED_PARENS = `^\\(-?(?:${SYMBOL}|${CODE} ?)[+-]?\\d.*\\)$|^\\(.+\\d(?:${SYMBOL}| ?${CODE})\\)$`;
const MARK_GROUPS = `^-?\\d{1,3}(${MARK}\\d{3})+([.,]\\d+)?$`;
const SPACE_GROUPS = `^-?\\d{1,3}((?:${MARK}| )\\d{3})+([.,]\\d+)?$`;
const FIRST_ROWS = 2000;

const northAmerican = (value: string) =>
  `try_cast(regexp_replace(regexp_replace(trim(${value}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;

/** The number a cell's text reads as under the loader's own parse, or NULL. */
const parsedNumber = (value: string) => northAmerican(`(${money(value)}).text`);

/**
 * True when a cell's text is a number under the loader's own reading, so a
 * currency sign or brackets do not make it text. NaN and the infinities read
 * as DOUBLE but are not numbers, so a bridge never receives one. The parse is
 * evaluated once, in a scalar subquery, because the gate runs it per row.
 */
export const readsAsNumber = (value: string) =>
  `coalesce((SELECT isfinite(${parsedNumber(value)})), false)`;

const decimalComma = (value: string) =>
  `try_cast(replace(replace(trim(${value}), '.', ''), ',', '.') AS DOUBLE)`;

const stripped = (value: string) => `regexp_replace(trim(${value}), '[\\$\\s()]', '', 'g')`;

const europeanOn = (value: string) =>
  `(regexp_matches(${value}, '${GROUPED}') OR regexp_matches(${value}, '${PLAIN}') OR regexp_matches(${value}, '${GROUPED_THREE}') OR regexp_matches(${value}, '${PLAIN_THREE}') OR regexp_matches(${value}, '${GROUPED_LONG}') OR regexp_matches(${value}, '${PLAIN_LONG}'))`;

const european = (value: string) => europeanOn(`trim(${value})`);

const decorationValue = (value: string) =>
  `regexp_replace(regexp_replace(regexp_replace(trim(${value}), '[\\$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1'), '^\\+', '')`;

const replace = (value: string, pattern: string, replacement: string) =>
  `regexp_replace(${value}, '${pattern}', '${replacement}')`;

/**
 * One parse of a money-looking VARCHAR value. The text drops one currency marker and
 * canonicalizes group marks so the existing number shapes see ordinary digits.
 */
function money(column: string): string {
  const value = `trim(${column})`;
  const opened = `CASE WHEN regexp_matches(${value}, '${MARKED_PARENS}') THEN '-' || ${replace(value, "^\\((.*)\\)$", "\\1")} ELSE ${value} END`;
  const raw = replace(opened, "^(.*\\S)-$", "-\\1");
  const plain = `CASE WHEN regexp_matches(${raw}, '^[+-]?${CODE}[+-]?\\d+$|^[+-]?\\d+${CODE}$') THEN ${raw} ELSE ${replace(replace(raw, MARKER_AT_START, "\\1\\3"), MARKER_AT_END, "\\1")} END`;
  const dropped = `${plain} <> ${raw}`;
  const currency = `CASE WHEN ${dropped} THEN replace(nullif(regexp_extract(${raw}, '(${SYMBOL}|${CODE})', 1), ''), '€', 'EUR') WHEN contains(${raw}, '$') THEN '$' END`;
  const grouped = `regexp_matches(${plain}, CASE WHEN ${dropped} THEN '${SPACE_GROUPS}' ELSE '${MARK_GROUPS}' END)`;
  const separator = `CASE WHEN contains(${plain}, ',') THEN '.' ELSE ',' END`;
  const text = `CASE WHEN ${grouped} THEN replace(regexp_replace(${plain}, '${MARK}', ${separator}, 'g'), ' ', ${separator}) ELSE ${plain} END`;
  return `struct_pack(currency := ${currency}, text := ${text}, grouped := ${grouped})`;
}

const shapeNumber = (group: string, decimal: string) =>
  `^[+-]?(\\d{1,3}(${group}\\d{3})+|\\d+)(${decimal}\\d+)?([eE][+-]?\\d+)?$`;
const DECIMAL_COMMA_NUMBER = shapeNumber("\\.", ",");
const NORTH_AMERICAN_NUMBER = shapeNumber(",", "\\.");

const wellFormed = (value: string) =>
  `(regexp_matches(${decorationValue(value)}, '${DECIMAL_COMMA_NUMBER}') OR regexp_matches(${decorationValue(value)}, '${NORTH_AMERICAN_NUMBER}'))`;

/**
 * A value the conversion gate counts as a number: a decimal-comma shape, so
 * `1.979.849,56` reaches the whole-column decision, or the loader's own parse.
 * Both read the column's materialized money text, so nothing expands `money()`
 * a second time per row.
 */
const finiteParse = (parse: string) => `(${parse} IS NOT NULL AND isfinite(${parse}))`;
const gateText = (value: string) => `(${finiteParse(decimalComma(value))} OR ${finiteParse(northAmerican(value))})`;

interface ColumnCounts {
  nonBlank: number;
  european: number;
  decimalTail: number;
  usDecimal: number;
  usGrouped: number;
  ambiguous: number;
  wellFormed: number;
  usProof: number;
  commaProof: number;
  currencies: number;
  present: number;
  parsed: number;
  formatted: number;
}

function quotedName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function plainName(quoted: string): string {
  return quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"')
    ? quoted.slice(1, -1).replaceAll('""', '"')
    : quoted;
}

function varcharColumns(described: Record<string, unknown>[]): string[] {
  return described
    .filter((row) => String(row.column_type) === "VARCHAR")
    .map((row) => quotedName(String(row.column_name)));
}

function parsesWithFormatting(counts: Pick<ColumnCounts, "present" | "parsed" | "formatted">): boolean {
  return counts.present > 0 && counts.present === counts.parsed && counts.formatted > 0;
}

function hasDecimalProof(counts: ColumnCounts): boolean {
  return counts.decimalTail > 0 || counts.commaProof > 0;
}

function hasUSProof(counts: ColumnCounts): boolean {
  return counts.usDecimal > 0 || counts.usGrouped > 0;
}

function isDecimalComma(counts: ColumnCounts): boolean {
  return (
    counts.nonBlank > 0 &&
    counts.nonBlank === counts.european &&
    hasDecimalProof(counts) &&
    !hasUSProof(counts) &&
    counts.ambiguous === 0
  );
}

function lacksDecimalProof(counts: ColumnCounts): boolean {
  return !hasDecimalProof(counts);
}

function provesBothStyles(counts: ColumnCounts): boolean {
  return counts.usProof > 0 && counts.commaProof > 0;
}

function formattingMeasures(column: string, index: number): string {
  return [
    `count(${column})::DOUBLE AS n${index}`,
    `count(*) FILTER (WHERE ${gateText(moneyField(index, "text"))})::DOUBLE AS ok${index}`,
    `count(*) FILTER (WHERE ${formatted(column, index)})::DOUBLE AS f${index}`,
  ].join(", ");
}

function formatted(column: string, index: number): string {
  const value = moneyField(index, "text");
  return [
    `regexp_matches(${column}, '[,$()]')`,
    `${moneyField(index, "currency")} IS NOT NULL`,
    `(${value} <> trim(${column}) AND regexp_matches(${value}, '[.,]'))`,
  ].join(" OR ");
}

function measures(column: string, index: number): string {
  const value = moneyField(index, "text");
  const blank = `(${column} IS NULL OR regexp_matches(${column}, '^\\s*$'))`;
  const decimalTail = `(regexp_matches(${stripped(value)}, '${DECIMAL_TAIL}') OR regexp_matches(${stripped(value)}, '${LONG_TAIL}'))`;
  return [
    `count(*) FILTER (WHERE NOT ${blank})::DOUBLE AS nb${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND ${european(value)})::DOUBLE AS eu${index}`,
    `count(*) FILTER (WHERE ${decimalTail})::DOUBLE AS p${index}`,
    `count(*) FILTER (WHERE regexp_matches(${stripped(value)}, '${US_DECIMAL}') OR regexp_matches(${stripped(value)}, '${US_THREE}'))::DOUBLE AS ud${index}`,
    `count(*) FILTER (WHERE regexp_matches(${stripped(value)}, '${US_GROUPED}'))::DOUBLE AS ug${index}`,
    `count(*) FILTER (WHERE regexp_matches(${stripped(value)}, '${AMBIGUOUS}'))::DOUBLE AS am${index}`,
    `count(*) FILTER (WHERE regexp_matches(${decorationValue(value)}, '${US_PROOF}'))::DOUBLE AS up${index}`,
    `count(*) FILTER (WHERE regexp_matches(${decorationValue(value)}, '${COMMA_PROOF}'))::DOUBLE AS cp${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND ${wellFormed(value)})::DOUBLE AS wf${index}`,
    `count(DISTINCT ${moneyField(index, "currency")})::DOUBLE AS cu${index}`,
    formattingMeasures(column, index),
  ].join(", ");
}

function moneyField(index: number, field: "text" | "currency" | "grouped"): string {
  return `(__m${index}).${field}`;
}

function withMoney(columns: string[], source: string, extended: boolean[], materialized: string[] = []): string {
  const parsed = columns.map((column, index) => `, ${extended[index] ? (materialized[index] || money(column)) : `struct_pack(currency := CASE WHEN contains(${column}, '$') THEN '$' END, text := trim(${column}), grouped := false)`} AS __m${index}`).join("");
  return `WITH __money AS MATERIALIZED (SELECT *${parsed} FROM ${source})`;
}

function formattingFrom(row: Record<string, unknown>, index: number): Pick<ColumnCounts, "present" | "parsed" | "formatted"> {
  return {
    present: Number(row[`n${index}`]),
    parsed: Number(row[`ok${index}`]),
    formatted: Number(row[`f${index}`]),
  };
}

async function countFormatting(
  query: Query,
  columns: string[],
  source: string,
  extended: boolean[],
): Promise<Pick<ColumnCounts, "present" | "parsed" | "formatted">[]> {
  const [row] = await query(`${withMoney(columns, source, extended)} SELECT ${columns.map(formattingMeasures).join(", ")} FROM __money`);
  return columns.map((_, index) => formattingFrom(row, index));
}

async function scan(query: Query, columns: string[], source: string, extended: boolean[], parsed: string[] = []): Promise<ColumnCounts[]> {
  const [row] = await query(`${withMoney(columns, source, extended, parsed)} SELECT ${columns.map(measures).join(", ")} FROM __money`);
  return columns.map((_, index) => ({
    nonBlank: Number(row[`nb${index}`]),
    european: Number(row[`eu${index}`]),
    decimalTail: Number(row[`p${index}`]),
    usDecimal: Number(row[`ud${index}`]),
    usGrouped: Number(row[`ug${index}`]),
    ambiguous: Number(row[`am${index}`]),
    wellFormed: Number(row[`wf${index}`]),
    usProof: Number(row[`up${index}`]),
    commaProof: Number(row[`cp${index}`]),
    currencies: Number(row[`cu${index}`]),
    ...formattingFrom(row, index),
  }));
}

async function extendedColumns(query: Query, columns: string[], source: string): Promise<boolean[]> {
  const [row] = await query(`SELECT ${columns.map((column, index) => `count(*) FILTER (WHERE regexp_matches(trim(${column}), '[^\\P{Sc}$]|[A-Z]{3}|[\\x{00A0}\\x{202F}\\x27\\x{2019}]|-$')) AS x${index}`).join(", ")} FROM ${source}`);
  return columns.map((_, index) => Number(row[`x${index}`]) > 0);
}

/**
 * Filter candidates using the index and constraint catalogs. A matching index or referenced-table
 * row excludes every candidate; other constraints except NOT NULL exclude their named columns.
 */
async function alterableColumns(query: Query, table: string, columns: string[]): Promise<string[]> {
  if (columns.length === 0) return columns;
  const name = `'${table.replaceAll("'", "''")}'`;
  const rows = await query(
    `SELECT NULL AS name FROM duckdb_indexes() WHERE schema_name = current_schema() AND table_name = ${name} UNION ALL SELECT NULL FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY' AND referenced_table = ${name} UNION ALL SELECT unnest(constraint_column_names) FROM duckdb_constraints() WHERE schema_name = current_schema() AND table_name = ${name} AND constraint_type <> 'NOT NULL'`,
  );
  if (rows.some((row) => row.name === null)) return [];
  const pinned = new Set(rows.map((row) => quotedName(String(row.name)).toLowerCase()));
  return columns.filter((column) => !pinned.has(column.toLowerCase()));
}

/** Where a loaded table's rows sit in the file it came from, when the loader knew for free. */
export type FileRows =
  | { readonly kind: "sheet"; readonly rows: readonly number[] }
  | { readonly kind: "csv"; readonly file: Blob; readonly dialect?: CsvDialect };

export async function convertFormattedNumbers(query: Query, table: string, rows?: FileRows): Promise<void> {
  const tableName = quotedName(table);
  const columns = varcharColumns(await query(`DESCRIBE ${tableName}`));
  if (columns.length === 0) return;
  const sample = `(SELECT * FROM ${tableName} LIMIT ${FIRST_ROWS})`;
  const sampled = await countFormatting(query, columns, sample, await extendedColumns(query, columns, sample));
  const likely = await alterableColumns(query, table, columns.filter((_, index) => parsesWithFormatting(sampled[index])));
  if (likely.length === 0) return;
  const extended = await extendedColumns(query, likely, tableName);
  const existing = new Set((await query(`DESCRIBE ${tableName}`)).map((row) => String(row.column_name).toLowerCase()));
  const temporary: string[] = [];
  const parsed = likely.map(() => "");
  const rowOf = locateRows(query, tableName, table, rows);
  let failure: { error: unknown } | undefined;
  try {
    for (const [index, column] of likely.entries()) {
      if (!extended[index]) continue;
      let name = `__money_${index}`;
      while (existing.has(name.toLowerCase())) name += "_";
      existing.add(name.toLowerCase());
      const field = quotedName(name);
      await query(`ALTER TABLE ${tableName} ADD COLUMN ${field} STRUCT(currency VARCHAR, text VARCHAR, grouped BOOLEAN)`);
      temporary.push(field);
      parsed[index] = field;
      await query(`UPDATE ${tableName} SET ${field} = ${money(column)}`);
    }
    const full = await scan(query, likely, tableName, extended, parsed);
    for (const [index, column] of likely.entries()) {
      const counts = full[index];
      if (counts.currencies > 1) {
        if (counts.present > 0 && counts.wellFormed === counts.nonBlank) {
          await query(`COMMENT ON COLUMN ${tableName}.${column} IS ${literal(MIXED_STYLES_MARK)}`);
        }
        continue;
      }
      if (!parsesWithFormatting(counts)) continue;
      const canonical = parsed[index] ? `(${parsed[index]}).text` : column;
      if (isDecimalComma(counts)) {
        const mark = await readingMark(query, tableName, column, false, decimalComma);
        await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${decimalComma(canonical)}`);
        await query(
          `COMMENT ON COLUMN ${tableName}.${column} IS ${literal(mark === undefined ? "decimal comma" : `decimal comma; ${mark}`)}`,
        );
      } else if (lacksDecimalProof(counts)) {
        const mark = await readingMark(query, tableName, column, true, northAmerican);
        await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${northAmerican(canonical)}`);
        if (mark !== undefined) await query(`COMMENT ON COLUMN ${tableName}.${column} IS ${literal(mark)}`);
      } else if (counts.present > 0 && counts.wellFormed === counts.nonBlank && provesBothStyles(counts)) {
        const comment = await mixedStyleComment(query, tableName, column, rowOf);
        await query(`COMMENT ON COLUMN ${tableName}.${column} IS ${literal(comment)}`);
      }
    }
  } catch (error) {
    failure = { error };
  }
  for (const field of temporary) {
    try {
      await query(`ALTER TABLE ${tableName} DROP COLUMN ${field}`);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** The file row of a table row, or undefined where the file cannot prove one. */
type RowOf = (at: number, column: string, value: string) => Promise<number | undefined>;

/**
 * A row lookup that reads the CSV only when a sentence is about to name a row.
 * A sheet already knows its rows. A CSV proves one only when its logical
 * records match the table's row count and the located field holds the value.
 */
function locateRows(query: Query, tableName: string, table: string, rows: FileRows | undefined): RowOf {
  if (rows === undefined) return async () => undefined;
  if (rows.kind === "sheet") return async (at) => rows.rows[at];
  return async (at, column, value) => {
    try {
      const dialect = rows.dialect ?? DEFAULT_CSV_DIALECT;
      const [counted] = await query(`SELECT count(*)::DOUBLE AS n FROM ${tableName}`);
      const [where] = await query(
        `SELECT column_index - 1 AS i FROM duckdb_columns()
         WHERE schema_name = current_schema() AND table_name = ${literal(table)} AND column_name = ${literal(plainName(column))}`,
      );
      if (where?.i == null) return undefined;
      const scan = await scanCsvSlot(rows.file, dialect, at, Number(where.i));
      if (scan === undefined || scan.dataRecords !== Number(counted?.n) || scan.row === undefined) return undefined;
      return scan.text?.trim() === value.trim() ? scan.row : undefined;
    } catch {
      return undefined;
    }
  };
}

const DEFAULT_CSV_DIALECT: CsvDialect = {
  delimiter: ",",
  quote: '"',
  escape: '"',
  header: true,
  skipRows: 0,
  comment: "",
};

type FieldMode = "start" | "unquoted" | "quoted" | "escaped" | "quoteSeen";

interface SlotScan {
  /** Loaded records after the header, which the table's row count must equal. */
  readonly dataRecords: number;
  /** The asked record's physical line in the file, counting every line break from 1. */
  row?: number;
  /** That record's asked field, as the reader captured it. */
  text?: string;
}

/**
 * Reads a CSV the way the loader did and counts record slots, which are the
 * file's rows: a line break outside a quoted field ends one slot, a completely
 * empty slot is a row the loader skips, and a break inside quotes belongs to
 * its record. Slots skipped by the sniffer and the header are counted but not
 * loaded. The reported row is the physical line the record starts on, counting
 * breaks inside quoted fields with CRLF as one. Undefined when the text ends
 * inside a quoted field, or a closing quote is followed by something the
 * reader would refuse.
 */
async function scanCsvSlot(file: Blob, dialect: CsvDialect, ordinal: number, field: number): Promise<SlotScan | undefined> {
  const delimiter = dialect.delimiter;
  const quoteChar = dialect.quote;
  // The reader treats a doubled quote as one quote, and the sniffer reports that
  // convention as either an empty escape or the quote itself.
  const escapeChar = dialect.escape === quoteChar ? "" : dialect.escape;
  const headerOffset = dialect.header ? 1 : 0;
  const skipped = dialect.skipRows;

  let slot = 1;
  let loaded = 0;
  let empty = true;
  let column = 0;
  let mode: FieldMode = "start";
  let carryCR = false;
  let physicalLine = 1;
  let recordPhysical = 1;
  let wanted = false;
  let captured = "";
  let row: number | undefined;
  let text: string | undefined;

  const capture = (char: string) => {
    if (wanted && column === field) captured += char;
  };

  const endSlot = () => {
    if (!empty) {
      if (wanted) {
        row = recordPhysical;
        text = captured;
      }
      if (slot > skipped) loaded += 1;
    }
    empty = true;
    column = 0;
    mode = "start";
    wanted = false;
    captured = "";
    slot += 1;
  };

  const nextField = () => {
    column += 1;
    mode = "start";
  };

  // Read inside a closure, because the state changes only in `feed`.
  const insideQuotes = () => mode === "quoted" || mode === "escaped";

  const feed = (chars: string): boolean => {
    for (const char of chars) {
      if (carryCR) {
        carryCR = false;
        if (char === "\n") continue;
      }
      const isBreak = char === "\r" || char === "\n";
      if (isBreak) {
        physicalLine += 1;
        if (!insideQuotes()) {
          endSlot();
          carryCR = char === "\r";
          continue;
        }
        if (char === "\r") carryCR = true;
      }
      if (empty) {
        empty = false;
        recordPhysical = physicalLine;
        wanted = slot > skipped && loaded - headerOffset === ordinal;
        captured = "";
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
  return { dataRecords: loaded - headerOffset, row, text };
}

/**
 * The mixed-style mark for a column that proves both money styles: the first
 * value of the style the column's first value is not, with its row when the
 * file proves one. The sentence quotes both, so the value is kept as written.
 */
async function mixedStyleComment(query: Query, tableName: string, column: string, rowOf: RowOf): Promise<string> {
  const value = `trim(${column})`;
  const decoration = decorationValue(`trim(${column})`);
  const [row] = await query(
    `SELECT arg_min(regexp_matches(${decoration}, '${US_PROOF}'), rowid) AS is_us,
            arg_min(${value}, rowid) FILTER (WHERE regexp_matches(${decoration}, '${US_PROOF}')) AS us,
            arg_min(rowid, rowid) FILTER (WHERE regexp_matches(${decoration}, '${US_PROOF}'))::DOUBLE AS us_at,
            arg_min(${value}, rowid) FILTER (WHERE regexp_matches(${decoration}, '${COMMA_PROOF}')) AS eu,
            arg_min(rowid, rowid) FILTER (WHERE regexp_matches(${decoration}, '${COMMA_PROOF}'))::DOUBLE AS eu_at
     FROM ${tableName}`,
  );
  const losing = row?.is_us === true ? { value: row?.eu, at: row?.eu_at } : { value: row?.us, at: row?.us_at };
  if (losing.value == null || losing.at == null) return MIXED_STYLES_MARK;
  const example = String(losing.value);
  const located = await rowOf(Number(losing.at), column, example);
  return located === undefined ? MIXED_STYLES_MARK : `${MIXED_STYLES_MARK}:${example}|${located}`;
}

// Marks for the data-check sentences below. The dots marks carry the column's
// first dotted value after a colon, because the sentence quotes it.
const THOUSANDS_DOTS = "thousands dots";
const DECIMAL_DOTS = "decimal dots";
// A converted column whose values carried a currency sign or brackets, or a
// comma between thousands, carries the first such value and the number it was
// read as, because the sentence quotes both.
const CURRENCY_SIGN = "currency sign";
const GROUPED_COMMA = "grouped comma";
// A column that proves two money styles stays text. The mark keeps the first
// value of the style the column's first value is not, with its row when the
// file proves one, because the sentence quotes both.
const MIXED_STYLES_MARK = "mixed number styles";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

const currencyOrBracket = (column: string) =>
  `(((${money(column)}).currency) IS NOT NULL OR regexp_matches(trim(${column}), '^\\(.*\\)$'))`;
const commaThousands = (column: string) => `regexp_matches(trim(${column}), '\\d,\\d{3}')`;

/** The number a formatted value was read as, by the same parse the column converted with. */
async function readNumber(query: Query, example: string, parse: (text: string) => string): Promise<string> {
  const [row] = await query(`SELECT CAST(${parse(`(${money(literal(example))}).text`)} AS VARCHAR) AS n`);
  return String(row?.n).replace(/\.0$/, "");
}

/**
 * The reading mark a converted column carries, when its values held a currency
 * sign or brackets, or a comma between thousands. A currency sign wins over a
 * comma, because a value like `$1,000.50` was not read for its comma alone.
 */
async function readingMark(
  query: Query,
  tableName: string,
  column: string,
  grouped: boolean,
  parse: (text: string) => string,
): Promise<string | undefined> {
  const [row] = await query(
    `SELECT arg_min(trim(${column}), rowid) FILTER (WHERE ${currencyOrBracket(column)}) AS c${
      grouped ? `, arg_min(trim(${column}), rowid) FILTER (WHERE ${commaThousands(column)}) AS g` : ""
    } FROM ${tableName}`,
  );
  const currency = row?.c == null ? undefined : String(row.c);
  const commas = grouped && row?.g != null ? String(row.g) : undefined;
  const example = currency ?? commas;
  if (example === undefined) return undefined;
  const mark = currency !== undefined ? CURRENCY_SIGN : GROUPED_COMMA;
  const read = await readNumber(query, example, parse);
  return `${mark}:${example}|${read}`;
}

/** Splits a reading mark back into its quoted value and the number it was read as. */
function readingOf(comment: string, mark: string): { example: string; read: string } | undefined {
  const body = comment.slice(mark.length + 1);
  const cut = body.lastIndexOf("|");
  if (cut < 0) return undefined;
  return { example: body.slice(0, cut), read: body.slice(cut + 1) };
}

/** One column's comment as its marks, so a column can carry a decimal comma and a reading mark. */
const marksOf = (comment: string) => comment.split("; ");

// A period text may be a whole record written with another separator. The
// check reads the text in one cell, never the row's shape: a valid file with a
// sparse footer row has the same shape as a mixed file.
const WHOLE_ROW_SEPARATORS = [",", ";", "\t"];
const SHORT_TEXT = 40;

function sqlSeparator(separator: string): string {
  return separator === "\t" ? "chr(9)" : `'${separator}'`;
}

/** Cuts a quoted value the way the file problems list does: 39 characters and an ellipsis. */
export function shortened(value: string): string {
  const characters = Array.from(value);
  return characters.length <= SHORT_TEXT ? value : characters.slice(0, SHORT_TEXT - 1).join("") + "…";
}

/**
 * The period values that look like a whole record in another separator. The
 * split must give the loaded table's own width, every part must be filled, and
 * the parts in the table's numeric columns must parse as numbers, so a sparse
 * footer row such as `Total;;;` and a note such as `see;notes;here;please`
 * stay silent. A missing view or a failed query returns null, so one note
 * never hides the others.
 */
export async function wholeRowNote(query: Query, table: string): Promise<string | null> {
  try {
    const described = await query(`DESCRIBE ${quotedName(table)}`);
    const width = described.length;
    // A two-column table cannot tell a whole record from one cell holding a
    // decimal comma, so it is never judged a mixed file.
    if (width < 3) return null;
    const numeric = described.map((row) => isNumeric(String(row.column_type)));
    if (!numeric.some(Boolean)) return null;
    const period = quotedName(PERIOD);
    const arms = WHOLE_ROW_SEPARATORS.map((separator) => {
      const parts = `string_split(p, ${sqlSeparator(separator)})`;
      const checks = [
        `length(${parts}) = ${width}`,
        `NOT list_contains(${parts}, '')`,
        ...numeric.flatMap((isNumber, index) => (isNumber ? [readsAsNumber(`${parts}[${index + 1}]`)] : [])),
      ];
      return `(${checks.join(" AND ")})`;
    });
    // Only a value that holds one of the separators can be a whole row, and a
    // whole row is at least as long as the table's width. The filter keeps the
    // split and the number parse off every other row, so a large file's period
    // column costs one cheap pass instead of three splits per row.
    const carriesSeparator = WHOLE_ROW_SEPARATORS.map((separator) => `contains(p, ${sqlSeparator(separator)})`);
    const [row] = await query(
      `WITH base AS (
         SELECT CAST(${period} AS VARCHAR) AS p FROM ${quotedName(VIEW)} WHERE ${period} IS NOT NULL
       ), candidate AS (
         SELECT p FROM base WHERE (${carriesSeparator.join(" OR ")}) AND length(p) >= ${width - 1}
       ), judged AS (
         SELECT p, (${arms.join(" OR ")}) AS whole FROM candidate
       )
       SELECT count(*) FILTER (WHERE whole)::DOUBLE AS n, min(p) FILTER (WHERE whole) AS example FROM judged`,
    );
    const n = Number(row?.n);
    if (!(n > 0)) return null;
    const example = shortened(String(row?.example));
    const tail = `that looks like a whole row. The file may mix separators. Save it again with one separator.`;
    if (n === 1) return `1 row has a period such as "${example}" ${tail}`;
    return `${n.toLocaleString("en-US")} rows have a period such as "${example}" ${tail}`;
  } catch {
    return null;
  }
}

export async function decimalCommaNote(query: Query, table: string, includeWholeRow = true): Promise<string | null> {
  const rows = await query(
    `SELECT column_name, comment FROM duckdb_columns() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}' AND comment IS NOT NULL ORDER BY column_index`,
  );
  const columns = rows.map((row) => ({ name: String(row.column_name), marks: marksOf(String(row.comment ?? "")) }));
  const decimal = columns.filter((column) => column.marks.includes("decimal comma")).map((column) => column.name);
  const mixed = columns.filter((column) => column.marks.some((mark) => mixedMark(mark)));
  const named = mixed.filter((column) => column.marks.includes(MIXED_STYLES_MARK)).map((column) => column.name);
  const sentences: string[] = [];
  if (decimal.length === 1) sentences.push("1 column was read as numbers written with a decimal comma.");
  if (decimal.length > 1) sentences.push(`${decimal.length} columns were read as numbers written with a decimal comma.`);
  if (named.length === 1) sentences.push(`${named[0]} mixes number styles, so it was read as text.`);
  if (named.length > 1) {
    sentences.push(`${named.slice(0, -1).join(", ")} and ${named[named.length - 1]} mix number styles, so they were read as text.`);
  }
  for (const column of mixed) {
    const mark = column.marks.find((candidate) => candidate.startsWith(`${MIXED_STYLES_MARK}:`));
    if (mark === undefined) continue;
    const body = mark.slice(MIXED_STYLES_MARK.length + 1);
    const cut = body.lastIndexOf("|");
    if (cut < 0) continue;
    sentences.push(
      `${column.name} mixes number styles, such as ${body.slice(0, cut)} in row ${body.slice(cut + 1)}, so it was read as text.`,
    );
  }
  const sheet = await sheetNote(query, table);
  if (sheet !== null) sentences.push(sheet);
  for (const column of columns) {
    for (const mark of column.marks) {
      if (mark.startsWith(`${CURRENCY_SIGN}:`)) {
        const reading = readingOf(mark, CURRENCY_SIGN);
        if (reading) {
          sentences.push(
            `Numbers in ${column.name} such as ${reading.example} were read with the currency sign or brackets removed, as ${reading.read}.`,
          );
        }
      } else if (mark.startsWith(`${GROUPED_COMMA}:`)) {
        const reading = readingOf(mark, GROUPED_COMMA);
        if (reading) {
          sentences.push(
            `Numbers in ${column.name} such as ${reading.example} were read with the comma between thousands, as ${reading.read}.`,
          );
        }
      } else if (mark.startsWith(`${THOUSANDS_DOTS}:`)) {
        const example = mark.slice(THOUSANDS_DOTS.length + 1);
        sentences.push(
          `Numbers in ${column.name} such as ${example} were read with a dot between thousands, as ${example.replaceAll(".", "")}.`,
        );
      } else if (mark.startsWith(`${DECIMAL_DOTS}:`)) {
        const example = mark.slice(DECIMAL_DOTS.length + 1);
        sentences.push(
          `Numbers in ${column.name} such as ${example} were read as decimals, as ${dotExampleValue(example)}. If they are whole numbers with dots between thousands, save the file with plain numbers.`,
        );
      }
    }
  }
  const whole = includeWholeRow ? await wholeRowNote(query, table) : null;
  if (whole !== null) sentences.push(whole);
  const huge = await amountsNote(query, DEFAULT_CELLS_TABLE).catch(() => null);
  if (huge !== null) sentences.push(huge);
  return sentences.length === 0 ? null : sentences.join(" ");
}

/** A dotted example as the decimal number it was read as. */
function dotExampleValue(example: string): string {
  return String(Number(example));
}

/** True for the mixed-style mark, with or without the value and row it quotes. */
function mixedMark(mark: string): boolean {
  return mark === MIXED_STYLES_MARK || mark.startsWith(`${MIXED_STYLES_MARK}:`);
}

// The staging table of a workbook carries the sheet it loaded and how many
// later sheets it left out. The app shows no load-area note for it yet.
const SHEET_MARK = "sheet:";

/** The sentence naming the sheet a workbook loaded, when more than one survives. */
async function sheetNote(query: Query, table: string): Promise<string | null> {
  const [row] = await query(
    `SELECT comment FROM duckdb_tables() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}'`,
  );
  const comment = row?.comment == null ? "" : String(row.comment);
  if (!comment.startsWith(SHEET_MARK)) return null;
  const body = comment.slice(SHEET_MARK.length);
  const cut = body.lastIndexOf("|");
  if (cut < 0) return null;
  const name = body.slice(0, cut);
  const others = Number(body.slice(cut + 1));
  if (name === "" || !(others > 0)) return null;
  const rest = others === 1 ? "the other sheet was not" : `the other ${others} sheets were not`;
  return `The workbook's first sheet, "${name}", was loaded; ${rest}.`;
}

const DOTTED = "^-?\\d{1,3}(\\.\\d{3})+$";
const PLAIN_WHOLE = "^-?\\d+$";

export interface DotReading {
  column: string;
  /** The column's first dotted value in file order, for the data-check sentence. */
  example: string;
  /** True when the dots separate thousands and the column converts to whole numbers. */
  thousands: boolean;
}

/**
 * Reads one column of raw CSV text as the loader saw it, before the database
 * typed it. A column whose every non-blank value is a plain whole number or a
 * dot-grouped thousands figure, with at least one dotted, is a dot column.
 * The database would otherwise read 9.600 as 9.6.
 */
async function readDotColumn(
  query: Query,
  raw: string,
  column: string,
  semicolons: boolean,
): Promise<DotReading | null> {
  const field = quotedName(column);
  const [counts] = await query(
    `SELECT count(*)::DOUBLE AS n, count(*) FILTER (WHERE ${field} IS NULL OR regexp_matches(${field}, '^\\s*$'))::DOUBLE AS blank, count(*) FILTER (WHERE contains(${field}, ','))::DOUBLE AS comma, count(*) FILTER (WHERE regexp_matches(${field}, '${PLAIN_WHOLE}'))::DOUBLE AS plain, count(*) FILTER (WHERE regexp_matches(${field}, '${DOTTED}'))::DOUBLE AS dotted, count(*) FILTER (WHERE length(${field}) - length(replace(${field}, '.', '')) > 1)::DOUBLE AS multi FROM ${raw}`,
  );
  const total = Number(counts.n) - Number(counts.blank);
  if (total <= 0 || Number(counts.comma) > 0) return null;
  if (Number(counts.plain) + Number(counts.dotted) !== total || Number(counts.dotted) < 1) return null;
  const [first] = await query(`SELECT ${field} AS v FROM ${raw} WHERE regexp_matches(${field}, '${DOTTED}') LIMIT 1`);
  if (!first) return null;
  return { column, example: String(first.v), thousands: semicolons || Number(counts.multi) > 0 };
}

/**
 * Decides for every loaded column whether its dots separate thousands. Raw
 * text via all_varchar decides, because the database may already have typed an
 * all-dotted column as DOUBLE. A semicolon file, or any value with more than
 * one dot, reads dots as thousands. Otherwise the values stay as read, with a
 * data-check sentence saying they were read as decimals.
 */
export async function planDotColumns(
  query: Query,
  path: string,
  delimiter: string,
  skip = 0,
): Promise<DotReading[]> {
  const escaped = path.replaceAll("'", "''");
  const skipOption = skip > 0 ? `, skip=${skip}` : "";
  const raw = `(SELECT * FROM read_csv('${escaped}', all_varchar=true, ${CSV_OPTIONS}${skipOption}))`;
  const names = (await query(`DESCRIBE SELECT * FROM ${raw}`)).map((row) => String(row.column_name));
  const readings: DotReading[] = [];
  for (const column of names) {
    const reading = await readDotColumn(query, raw, column, delimiter === ";").catch(() => null);
    if (reading) readings.push(reading);
  }
  return readings;
}

/**
 * Converts thousands-dotted columns to whole numbers and marks every dot
 * column for its data-check sentence. Thousands columns convert here rather
 * than in convertFormattedNumbers because that pass only touches VARCHAR, and
 * the loader reads them as VARCHAR on purpose (see typeOverrides).
 */
export async function applyDotColumns(query: Query, table: string, readings: DotReading[]): Promise<void> {
  const name = quotedName(table);
  for (const reading of readings) {
    const column = quotedName(reading.column);
    if (reading.thousands) {
      await query(
        `ALTER TABLE ${name} ALTER ${column} TYPE DOUBLE USING CAST(nullif(trim(replace(${column}, '.', '')), '') AS DOUBLE)`,
      );
      await query(`COMMENT ON COLUMN ${name}.${column} IS '${THOUSANDS_DOTS}:${reading.example}'`);
    } else {
      await query(`COMMENT ON COLUMN ${name}.${column} IS '${DECIMAL_DOTS}:${reading.example}'`);
    }
  }
}

/** read_csv type overrides that keep named columns as text, or "" when none are named. */
export function typeOverrides(columns: readonly string[]): string {
  if (columns.length === 0) return "";
  return `, types={${columns.map((column) => `'${column.replaceAll("'", "''")}': 'VARCHAR'`).join(", ")}}`;
}

/** The one sentence shown when a file's rows do not all use the same separator. */
export const MIXED_SEPARATOR_SENTENCE = 'This file mixes ";" and "," as separators, so save it again with one separator.';

const OTHER_SEPARATOR: Record<string, string> = { ",": ";", ";": "," };
const FEWEST_MIXED_RECORDS = 3;

/** A field that reads as a plain measure: an optional sign, digits, and decimal or grouping marks. */
const MEASURE_FIELD = /^[+-]?\d+(?:[.,]\d+)*$/;

/**
 * The prefix's logical records, split with the sniffed quote and escape so a
 * quoted line break stays inside its record. Blank records are kept for the
 * caller to drop after skipped rows are removed. The last record counts only
 * when the prefix did not stop inside a quoted field.
 */
function logicalRecords(prefix: string, quote: string, escape: string): string[] {
  const records: string[] = [];
  let record = "";
  let quoted = false;
  const useQuotes = quote !== "";
  const doubled = escape === "" || escape === quote;
  for (let index = 0; index < prefix.length; index++) {
    const char = prefix[index];
    if (useQuotes && char === quote) {
      if (quoted && doubled && prefix[index + 1] === quote) {
        record += quote + quote;
        index += 1;
        continue;
      }
      quoted = !quoted;
      record += char;
      continue;
    }
    if (useQuotes && !doubled && quoted && char === escape) {
      record += char;
      if (index + 1 < prefix.length) {
        record += prefix[index + 1];
        index += 1;
      }
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      records.push(record);
      record = "";
      if (char === "\r" && prefix[index + 1] === "\n") index += 1;
      continue;
    }
    record += char;
  }
  if (!quoted && record !== "") records.push(record);
  return records;
}

/** One record's fields split by a separator outside the sniffed quotes. */
function splitOutsideQuotes(record: string, separator: string, quote: string, escape: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  const useQuotes = quote !== "";
  const doubled = escape === "" || escape === quote;
  for (let index = 0; index < record.length; index++) {
    const char = record[index];
    if (useQuotes && char === quote) {
      if (quoted && doubled && record[index + 1] === quote) {
        field += char;
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (useQuotes && !doubled && quoted && char === escape) {
      if (index + 1 < record.length) {
        field += record[index + 1];
        index += 1;
      }
      continue;
    }
    if (!quoted && char === separator) {
      fields.push(field);
      field = "";
      continue;
    }
    field += char;
  }
  fields.push(field);
  return fields;
}

/**
 * The unfinished tail after the last complete record break, with quoting
 * respected so a break inside quotes does not end a record. Empty when the
 * prefix ends on a record boundary. Used only to judge a truncated prefix
 * that holds no complete header.
 */
function trailingPartial(prefix: string, quote: string, escape: string): string {
  let quoted = false;
  const useQuotes = quote !== "";
  const doubled = escape === "" || escape === quote;
  let lastBreakEnd = 0;
  for (let index = 0; index < prefix.length; index++) {
    const char = prefix[index];
    if (useQuotes && char === quote) {
      if (quoted && doubled && prefix[index + 1] === quote) {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (useQuotes && !doubled && quoted && char === escape) {
      if (index + 1 < prefix.length) index += 1;
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && prefix[index + 1] === "\n") index += 1;
      lastBreakEnd = index + 1;
    }
  }
  return prefix.slice(lastBreakEnd);
}

/**
 * The header's field count under the given delimiter, or 0 when no kept
 * record survives. Used to keep a third-separator file that already has
 * columns under its sniffed separator from ever falling back to a comma or
 * semicolon check. A truncated prefix that holds only part of the header is
 * judged on what it holds. The sole header record is never discarded, and a
 * prefix with no complete header counts its unfinished tail with quoting
 * respected.
 */
export function headerFieldCount(prefix: string, delimiter: string, dialect?: CsvDialect, truncated = false): number {
  const quote = dialect?.quote ?? '"';
  const escape = dialect?.escape ?? '"';
  const skipRows = dialect?.skipRows ?? 0;
  const comment = dialect?.comment ?? "";
  const kept = logicalRecords(prefix, quote, escape)
    .slice(skipRows)
    .filter((record) => record.trim() !== "" && (comment === "" || !record.trimStart().startsWith(comment)));
  if (truncated) {
    if (kept.length > 1) kept.pop();
    else if (kept.length === 0) {
      const tail = trailingPartial(prefix, quote, escape);
      if (tail.trim() === "" || (comment !== "" && tail.trimStart().startsWith(comment))) return 0;
      return splitOutsideQuotes(tail, delimiter, quote, escape).length;
    }
  }
  if (kept.length === 0) return 0;
  return splitOutsideQuotes(kept[0], delimiter, quote, escape).length;
}

/**
 * True when every kept logical record holds the header's field count under the
 * given delimiter, with the sniffed quote, escape, skipped rows and comment.
 * A consistent file is never a mixed file, whatever its cells hold, including
 * a tab file whose cells hold commas and semicolons. When the prefix was cut
 * mid-file the last record may be partial and is dropped.
 */
export function hasConsistentRecords(prefix: string, delimiter: string, dialect?: CsvDialect, truncated = false): boolean {
  const quote = dialect?.quote ?? '"';
  const escape = dialect?.escape ?? '"';
  const skipRows = dialect?.skipRows ?? 0;
  const comment = dialect?.comment ?? "";
  const kept = logicalRecords(prefix, quote, escape)
    .slice(skipRows)
    .filter((record) => record.trim() !== "" && (comment === "" || !record.trimStart().startsWith(comment)));
  if (truncated && kept.length > 0) kept.pop();
  if (kept.length === 0) return true;
  const widths = kept.map((record) => splitOutsideQuotes(record, delimiter, quote, escape).length);
  const header = widths[0];
  if (header < 2) return false;
  return widths.every((width) => width === header);
}

/**
 * The sentence for a file whose logical records do not all hold the header's
 * field count under the sniffed separator while the other separator gives an
 * odd record that count with every part filled, decided from the first 64 KB
 * with the sniffed quote, escape, skipped rows and comment. A short record
 * whose other-separator split reaches the header count with every part
 * filled reads as punctuation plus omitted trailing cells rather than a
 * foreign record when its first other-separator part holds the sniffed
 * separator and no later part reads as a measure, so that record is skipped
 * and the rest are still checked. A later part that reads as a measure keeps
 * the refusal, because a foreign record would carry its values there and
 * dropping them loses sales. Punctuation inside cells is never evidence on
 * its own: a file whose every kept record holds the header count is never
 * refused, whatever its cells hold. A one-column file
 * and a file with fewer than three complete kept records stay silent. An
 * unfinished quoted record is ignored; earlier complete records are checked.
 */
export function mixedSeparatorSentence(
  prefix: string,
  delimiter: string,
  dialect?: CsvDialect,
  truncated = false,
): string | null {
  const other = OTHER_SEPARATOR[delimiter];
  if (other === undefined) return null;
  const quote = dialect?.quote ?? '"';
  const escape = dialect?.escape ?? '"';
  const skipRows = dialect?.skipRows ?? 0;
  const comment = dialect?.comment ?? "";
  const kept = logicalRecords(prefix, quote, escape)
    .slice(skipRows)
    .filter((record) => record.trim() !== "" && (comment === "" || !record.trimStart().startsWith(comment)));
  if (truncated && kept.length > 0) kept.pop();
  if (kept.length < FEWEST_MIXED_RECORDS) return null;
  const widths = kept.map((record) => splitOutsideQuotes(record, delimiter, quote, escape).length);
  const header = widths[0];
  if (header < 2) return null;
  for (let index = 1; index < kept.length; index++) {
    if (widths[index] === header) continue;
    const parts = splitOutsideQuotes(kept[index], other, quote, escape);
    if (parts.length !== header || !parts.every((field) => field.trim() !== "")) continue;
    const width = widths[index];
    // Keep the short-record exception limited to a sniffed separator in the
    // first other-separator part and no later plain-measure part. Other
    // candidate records retain the refusal.
    if (width < header && parts[0].includes(delimiter) && !parts.slice(1).some((field) => MEASURE_FIELD.test(field.trim()))) continue;
    return MIXED_SEPARATOR_SENTENCE;
  }
  return null;
}
