import type { Query } from "../engine.ts";

const COMMA_TAIL = ",\\d{1,2}";
const GROUPED = `^-?\\d{1,3}(\\.\\d{3})*(${COMMA_TAIL})?$`;
const PLAIN = `^-?\\d+${COMMA_TAIL}$`;
const DECIMAL_TAIL = `${COMMA_TAIL}$`;
const FIRST_ROWS = 2000;

const northAmerican = (column: string) =>
  `try_cast(regexp_replace(regexp_replace(trim(${column}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;

const decimalComma = (column: string) =>
  `try_cast(replace(replace(trim(${column}), '.', ''), ',', '.') AS DOUBLE)`;

interface ColumnCounts {
  nonBlank: number;
  european: number;
  decimalTail: number;
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

function parsesWithFormatting(counts: ColumnCounts): boolean {
  return counts.present > 0 && counts.present === counts.parsed && counts.formatted > 0;
}

function isDecimalComma(counts: ColumnCounts): boolean {
  return counts.nonBlank > 0 && counts.nonBlank === counts.european && counts.decimalTail > 0;
}

function lacksDecimalTail(counts: ColumnCounts): boolean {
  return counts.decimalTail === 0;
}

function measures(column: string, index: number): string {
  const blank = `(${column} IS NULL OR regexp_matches(${column}, '^\\s*$'))`;
  const european = `(regexp_matches(trim(${column}), '${GROUPED}') OR regexp_matches(trim(${column}), '${PLAIN}'))`;
  const decimalTail = `regexp_matches(regexp_replace(trim(${column}), '[\\$\\s()]', '', 'g'), '${DECIMAL_TAIL}')`;
  return [
    `count(*) FILTER (WHERE NOT ${blank})::DOUBLE AS nb${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND ${european})::DOUBLE AS eu${index}`,
    `count(*) FILTER (WHERE ${decimalTail})::DOUBLE AS p${index}`,
    `count(${column})::DOUBLE AS n${index}`,
    `count(${northAmerican(column)})::DOUBLE AS ok${index}`,
    `count(*) FILTER (WHERE regexp_matches(${column}, '[,$()]'))::DOUBLE AS f${index}`,
  ].join(", ");
}

async function scan(query: Query, columns: string[], source: string): Promise<ColumnCounts[]> {
  const [row] = await query(`SELECT ${columns.map(measures).join(", ")} FROM ${source}`);
  return columns.map((_, index) => ({
    nonBlank: Number(row[`nb${index}`]),
    european: Number(row[`eu${index}`]),
    decimalTail: Number(row[`p${index}`]),
    present: Number(row[`n${index}`]),
    parsed: Number(row[`ok${index}`]),
    formatted: Number(row[`f${index}`]),
  }));
}

export async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
  const tableName = quotedName(table);
  const columns = varcharColumns(await query(`DESCRIBE ${tableName}`));
  if (columns.length === 0) return;
  const full = await scan(query, columns, tableName);
  const formattedCandidates = columns.filter(
    (_, index) => lacksDecimalTail(full[index]) && parsesWithFormatting(full[index]),
  );
  const agreesOnFirstRows = new Set<string>();
  if (formattedCandidates.length > 0) {
    const sample = await scan(query, formattedCandidates, `(SELECT * FROM ${tableName} LIMIT ${FIRST_ROWS})`);
    formattedCandidates.forEach((column, index) => {
      if (parsesWithFormatting(sample[index])) agreesOnFirstRows.add(column);
    });
  }
  for (const [index, column] of columns.entries()) {
    const counts = full[index];
    if (isDecimalComma(counts)) {
      await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${decimalComma(column)}`);
      await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'decimal comma'`);
    } else if (lacksDecimalTail(counts) && parsesWithFormatting(counts) && agreesOnFirstRows.has(column)) {
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
