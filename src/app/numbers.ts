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
const FIRST_ROWS = 2000;

const northAmerican = (column: string) =>
  `try_cast(regexp_replace(regexp_replace(trim(${column}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;

const decimalComma = (column: string) =>
  `try_cast(replace(replace(trim(${column}), '.', ''), ',', '.') AS DOUBLE)`;

const stripped = (column: string) => `regexp_replace(trim(${column}), '[\\$\\s()]', '', 'g')`;

const europeanOn = (value: string) =>
  `(regexp_matches(${value}, '${GROUPED}') OR regexp_matches(${value}, '${PLAIN}') OR regexp_matches(${value}, '${GROUPED_THREE}') OR regexp_matches(${value}, '${PLAIN_THREE}') OR regexp_matches(${value}, '${GROUPED_LONG}') OR regexp_matches(${value}, '${PLAIN_LONG}'))`;

const european = (column: string) => europeanOn(`trim(${column})`);

const decorationValue = (column: string) =>
  `regexp_replace(regexp_replace(regexp_replace(trim(${column}), '[\\$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1'), '^\\+', '')`;

const shapeNumber = (group: string, decimal: string) =>
  `^[+-]?(\\d{1,3}(${group}\\d{3})+|\\d+)(${decimal}\\d+)?([eE][+-]?\\d+)?$`;
const DECIMAL_COMMA_NUMBER = shapeNumber("\\.", ",");
const NORTH_AMERICAN_NUMBER = shapeNumber(",", "\\.");

const wellFormed = (column: string) =>
  `(regexp_matches(${decorationValue(column)}, '${DECIMAL_COMMA_NUMBER}') OR regexp_matches(${decorationValue(column)}, '${NORTH_AMERICAN_NUMBER}'))`;

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
    `count(${northAmerican(column)})::DOUBLE AS ok${index}`,
    `count(*) FILTER (WHERE regexp_matches(${column}, '[,$()]'))::DOUBLE AS f${index}`,
  ].join(", ");
}

function measures(column: string, index: number): string {
  const blank = `(${column} IS NULL OR regexp_matches(${column}, '^\\s*$'))`;
  const decimalTail = `(regexp_matches(${stripped(column)}, '${DECIMAL_TAIL}') OR regexp_matches(${stripped(column)}, '${LONG_TAIL}'))`;
  return [
    `count(*) FILTER (WHERE NOT ${blank})::DOUBLE AS nb${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND ${european(column)})::DOUBLE AS eu${index}`,
    `count(*) FILTER (WHERE ${decimalTail})::DOUBLE AS p${index}`,
    `count(*) FILTER (WHERE regexp_matches(${stripped(column)}, '${US_DECIMAL}') OR regexp_matches(${stripped(column)}, '${US_THREE}'))::DOUBLE AS ud${index}`,
    `count(*) FILTER (WHERE regexp_matches(${stripped(column)}, '${US_GROUPED}'))::DOUBLE AS ug${index}`,
    `count(*) FILTER (WHERE regexp_matches(${stripped(column)}, '${AMBIGUOUS}'))::DOUBLE AS am${index}`,
    `count(*) FILTER (WHERE regexp_matches(${decorationValue(column)}, '${US_PROOF}'))::DOUBLE AS up${index}`,
    `count(*) FILTER (WHERE regexp_matches(${decorationValue(column)}, '${COMMA_PROOF}'))::DOUBLE AS cp${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND ${wellFormed(column)})::DOUBLE AS wf${index}`,
    formattingMeasures(column, index),
  ].join(", ");
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
): Promise<Pick<ColumnCounts, "present" | "parsed" | "formatted">[]> {
  const [row] = await query(`SELECT ${columns.map(formattingMeasures).join(", ")} FROM ${source}`);
  return columns.map((_, index) => formattingFrom(row, index));
}

async function scan(query: Query, columns: string[], source: string): Promise<ColumnCounts[]> {
  const [row] = await query(`SELECT ${columns.map(measures).join(", ")} FROM ${source}`);
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
    ...formattingFrom(row, index),
  }));
}

export async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
  const tableName = quotedName(table);
  const columns = varcharColumns(await query(`DESCRIBE ${tableName}`));
  if (columns.length === 0) return;
  const sampled = await countFormatting(query, columns, `(SELECT * FROM ${tableName} LIMIT ${FIRST_ROWS})`);
  const likely = columns.filter((_, index) => parsesWithFormatting(sampled[index]));
  if (likely.length === 0) return;
  const full = await scan(query, likely, tableName);
  for (const [index, column] of likely.entries()) {
    const counts = full[index];
    if (!parsesWithFormatting(counts)) continue;
    if (isDecimalComma(counts)) {
      await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${decimalComma(column)}`);
      await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'decimal comma'`);
    } else if (lacksDecimalProof(counts)) {
      await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${northAmerican(column)}`);
    } else if (counts.present > 0 && counts.wellFormed === counts.nonBlank && provesBothStyles(counts)) {
      await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'mixed number styles'`);
    }
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
