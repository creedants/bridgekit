import { amountsNote, DEFAULT_CELLS_TABLE, HUGE_AMOUNTS, type Query } from "../engine.ts";
import { isNumeric, PERIOD, VIEW } from "./setup.ts";

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

/** True when a cell's text is a number under the loader's own reading, so a currency sign or brackets do not make it text. */
export const readsAsNumber = (value: string) => `(${northAmerican(`(${money(value)}).text`)} IS NOT NULL)`;

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
    `count(*) FILTER (WHERE ${readsAsNumber(column)})::DOUBLE AS ok${index}`,
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

export async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
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
          await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'mixed number styles'`);
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
        await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'mixed number styles'`);
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

// Marks for the data-check sentences below. The dots marks carry the column's
// first dotted value after a colon, because the sentence quotes it.
const THOUSANDS_DOTS = "thousands dots";
const DECIMAL_DOTS = "decimal dots";
// A converted column whose values carried a currency sign or brackets, or a
// comma between thousands, carries the first such value and the number it was
// read as, because the sentence quotes both.
const CURRENCY_SIGN = "currency sign";
const GROUPED_COMMA = "grouped comma";

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
    if (width < 2) return null;
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

export async function decimalCommaNote(query: Query, table: string): Promise<string | null> {
  const rows = await query(
    `SELECT column_name, comment FROM duckdb_columns() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}' AND comment IS NOT NULL ORDER BY column_index`,
  );
  const columns = rows.map((row) => ({ name: String(row.column_name), marks: marksOf(String(row.comment ?? "")) }));
  const decimal = columns.filter((column) => column.marks.includes("decimal comma")).map((column) => column.name);
  const mixed = columns.filter((column) => column.marks.includes("mixed number styles")).map((column) => column.name);
  const sentences: string[] = [];
  if (decimal.length === 1) sentences.push("1 column was read as numbers written with a decimal comma.");
  if (decimal.length > 1) sentences.push(`${decimal.length} columns were read as numbers written with a decimal comma.`);
  if (mixed.length === 1) sentences.push(`${mixed[0]} mixes number styles, so it was read as text.`);
  if (mixed.length > 1) {
    sentences.push(`${mixed.slice(0, -1).join(", ")} and ${mixed[mixed.length - 1]} mix number styles, so they were read as text.`);
  }
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
  const whole = await wholeRowNote(query, table);
  if (whole !== null) sentences.push(whole);
  const huge = await amountsNote(query, DEFAULT_CELLS_TABLE).catch(() => null);
  if (huge !== null) sentences.push(huge);
  return sentences.length === 0 ? null : sentences.join(" ");
}

/** A dotted example as the decimal number it was read as. */
function dotExampleValue(example: string): string {
  return String(Number(example));
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
export async function planDotColumns(query: Query, path: string, delimiter: string): Promise<DotReading[]> {
  const escaped = path.replaceAll("'", "''");
  const raw = `(SELECT * FROM read_csv('${escaped}', all_varchar=true, ${CSV_OPTIONS}))`;
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
 * the loader reads them as VARCHAR on purpose (see typesForDotColumns).
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

/** read_csv type overrides that keep thousands-dotted columns as text, so applyDotColumns can convert them from the raw figures. */
export function typesForDotColumns(readings: DotReading[]): string | null {
  const thousands = readings.filter((reading) => reading.thousands);
  if (thousands.length === 0) return null;
  return `, types={${thousands.map((reading) => `'${reading.column.replaceAll("'", "''")}': 'VARCHAR'`).join(", ")}}`;
}
