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
const THOUSANDS = `^-?[1-9]\\d{0,2}(,\\d{3})+$`;
const FIRST_ROWS = 2000;

const northAmerican = (column: string) =>
  `try_cast(regexp_replace(regexp_replace(trim(${column}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;

const decimalComma = (column: string) =>
  `try_cast(replace(replace(trim(${column}), '.', ''), ',', '.') AS DOUBLE)`;

interface ColumnCounts {
  nonBlank: number;
  european: number;
  decimalTail: number;
  thousands: number;
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

function isDecimalComma(counts: ColumnCounts): boolean {
  return counts.nonBlank > 0 && counts.nonBlank === counts.european && counts.decimalTail > 0 && counts.thousands === 0;
}

function lacksDecimalTail(counts: ColumnCounts): boolean {
  return counts.decimalTail === 0;
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
  const european = `(regexp_matches(trim(${column}), '${GROUPED}') OR regexp_matches(trim(${column}), '${PLAIN}') OR regexp_matches(trim(${column}), '${GROUPED_THREE}') OR regexp_matches(trim(${column}), '${PLAIN_THREE}') OR regexp_matches(trim(${column}), '${GROUPED_LONG}') OR regexp_matches(trim(${column}), '${PLAIN_LONG}'))`;
  const decimalTail = `(regexp_matches(regexp_replace(trim(${column}), '[\\$\\s()]', '', 'g'), '${DECIMAL_TAIL}') OR regexp_matches(regexp_replace(trim(${column}), '[\\$\\s()]', '', 'g'), '${LONG_TAIL}'))`;
  const thousands = `regexp_matches(trim(${column}), '${THOUSANDS}')`;
  return [
    `count(*) FILTER (WHERE NOT ${blank})::DOUBLE AS nb${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND ${european})::DOUBLE AS eu${index}`,
    `count(*) FILTER (WHERE ${decimalTail})::DOUBLE AS p${index}`,
    `count(*) FILTER (WHERE ${thousands})::DOUBLE AS t${index}`,
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
    thousands: Number(row[`t${index}`]),
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
    } else if (lacksDecimalTail(counts)) {
      await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${northAmerican(column)}`);
    }
  }
}

export async function decimalCommaNote(query: Query, table: string): Promise<string | null> {
  const [row] = await query(
    `SELECT count(*)::DOUBLE AS n FROM duckdb_columns() WHERE schema_name = current_schema() AND table_name = '${table.replaceAll("'", "''")}' AND comment = 'decimal comma'`,
  );
  const count = Number(row?.n);
  if (!Number.isFinite(count) || count === 0) return null;
  if (count === 1) return "1 column was read as numbers written with a decimal comma.";
  return `${count} columns were read as numbers written with a decimal comma.`;
}
