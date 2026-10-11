import type { Query } from "../engine.ts";

/**
 * Spreadsheets often export numbers as text: "1,260", "$90.00", "(45)".
 * A text column is converted when every value parses as a number once that
 * formatting is removed and at least one value carries such formatting, so
 * plain codes such as "10023" are left alone.
 * A whole column of decimal commas, such as "12,50" or "1.234,56", is read
 * as numbers. Mixed with another format, that column stays text, because
 * stripping every comma would turn "12,50" into 1250.
 */

const COMMA_TAIL = ",\\d{1,2}";
const GROUPED = `^-?\\d{1,3}(\\.\\d{3})*(${COMMA_TAIL})?$`;
const PLAIN = `^-?\\d+${COMMA_TAIL}$`;
const PROOF = `${COMMA_TAIL}$`;

const cleaned = (c: string) =>
  `try_cast(regexp_replace(regexp_replace(trim(${c}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;

const decimalComma = (column: string) =>
  `try_cast(replace(replace(trim(${column}), '.', ''), ',', '.') AS DOUBLE)`;

interface ColumnCounts {
  nonBlank: number;
  european: number;
  proof: number;
  n: number;
  ok: number;
  f: number;
}

function quotedName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function varcharColumns(described: Record<string, unknown>[]): string[] {
  return described
    .filter((row) => String(row.column_type) === "VARCHAR")
    .map((row) => quotedName(String(row.column_name)));
}

function todayPasses(counts: ColumnCounts): boolean {
  return counts.n > 0 && counts.n === counts.ok && counts.f > 0;
}

function isDecimalComma(counts: ColumnCounts): boolean {
  return counts.nonBlank > 0 && counts.nonBlank === counts.european && counts.proof > 0;
}

function measures(column: string, index: number): string {
  const blank = `(${column} IS NULL OR regexp_matches(${column}, '^\\s*$'))`;
  const european = `(regexp_matches(trim(${column}), '${GROUPED}') OR regexp_matches(trim(${column}), '${PLAIN}'))`;
  const proof = `regexp_matches(regexp_replace(trim(${column}), '[\\$\\s()]', '', 'g'), '${PROOF}')`;
  return [
    `count(*) FILTER (WHERE NOT ${blank})::DOUBLE AS nb${index}`,
    `count(*) FILTER (WHERE NOT ${blank} AND ${european})::DOUBLE AS eu${index}`,
    `count(*) FILTER (WHERE ${proof})::DOUBLE AS p${index}`,
    `count(${column})::DOUBLE AS n${index}`,
    `count(${cleaned(column)})::DOUBLE AS ok${index}`,
    `count(*) FILTER (WHERE regexp_matches(${column}, '[,$()]'))::DOUBLE AS f${index}`,
  ].join(", ");
}

async function scan(query: Query, columns: string[], source: string): Promise<ColumnCounts[]> {
  const [row] = await query(`SELECT ${columns.map(measures).join(", ")} FROM ${source}`);
  return columns.map((_, index) => ({
    nonBlank: Number(row[`nb${index}`]),
    european: Number(row[`eu${index}`]),
    proof: Number(row[`p${index}`]),
    n: Number(row[`n${index}`]),
    ok: Number(row[`ok${index}`]),
    f: Number(row[`f${index}`]),
  }));
}

export async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
  const tableName = quotedName(table);
  const columns = varcharColumns(await query(`DESCRIBE ${tableName}`));
  if (columns.length === 0) return;
  const full = await scan(query, columns, tableName);
  const todayCandidates = columns.filter((_, index) => full[index].proof === 0 && todayPasses(full[index]));
  const samplePasses = new Set<string>();
  if (todayCandidates.length > 0) {
    // Today's cleaner still looks at the first 2000 rows, so one formatted cell after plain codes stays text.
    const sample = await scan(query, todayCandidates, `(SELECT * FROM ${tableName} LIMIT 2000)`);
    todayCandidates.forEach((column, index) => {
      if (todayPasses(sample[index])) samplePasses.add(column);
    });
  }
  for (const [index, column] of columns.entries()) {
    const counts = full[index];
    if (isDecimalComma(counts)) {
      await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${decimalComma(column)}`);
      await query(`COMMENT ON COLUMN ${tableName}.${column} IS 'decimal comma'`);
    } else if (counts.proof === 0 && todayPasses(counts) && samplePasses.has(column)) {
      await query(`ALTER TABLE ${tableName} ALTER ${column} TYPE DOUBLE USING ${cleaned(column)}`);
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
