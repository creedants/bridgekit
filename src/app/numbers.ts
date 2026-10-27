import type { Query } from "../engine.ts";

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
    `count(${northAmerican(moneyField(index, "text"))})::DOUBLE AS ok${index}`,
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

export async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
  const tableName = quotedName(table);
  const columns = varcharColumns(await query(`DESCRIBE ${tableName}`));
  if (columns.length === 0) return;
  const sample = `(SELECT * FROM ${tableName} LIMIT ${FIRST_ROWS})`;
  const sampled = await countFormatting(query, columns, sample, await extendedColumns(query, columns, sample));
  const likely = columns.filter((_, index) => parsesWithFormatting(sampled[index]));
  if (likely.length === 0) return;
  const extended = await extendedColumns(query, likely, tableName);
  const existing = new Set((await query(`DESCRIBE ${tableName}`)).map((row) => String(row.column_name).toLowerCase()));
  const temporary: string[] = [];
  const parsed = likely.map(() => "");
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
        await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${decimalComma(canonical)}`);
        await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'decimal comma'`);
      } else if (lacksDecimalProof(counts)) {
        await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${northAmerican(canonical)}`);
      } else if (counts.present > 0 && counts.wellFormed === counts.nonBlank && provesBothStyles(counts)) {
        await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'mixed number styles'`);
      }
    }
  } finally {
    for (const field of temporary) await query(`ALTER TABLE ${tableName} DROP COLUMN ${field}`);
  }
}

export async function decimalCommaNote(query: Query, table: string): Promise<string | null> {
  const rows = await query(
    `SELECT column_name, comment FROM duckdb_columns() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}' AND comment IN ('decimal comma', 'mixed number styles') ORDER BY column_index`,
  );
  const decimal = rows.filter((row) => row.comment === "decimal comma").map((row) => String(row.column_name));
  const mixed = rows.filter((row) => row.comment === "mixed number styles").map((row) => String(row.column_name));
  const sentences: string[] = [];
  if (decimal.length === 1) sentences.push("1 column was read as numbers written with a decimal comma.");
  if (decimal.length > 1) sentences.push(`${decimal.length} columns were read as numbers written with a decimal comma.`);
  if (mixed.length === 1) sentences.push(`${mixed[0]} mixes number styles, so it was read as text.`);
  if (mixed.length > 1) {
    sentences.push(`${mixed.slice(0, -1).join(", ")} and ${mixed[mixed.length - 1]} mix number styles, so they were read as text.`);
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}
