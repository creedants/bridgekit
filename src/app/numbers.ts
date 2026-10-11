import type { Query } from "../engine.ts";

/**
 * Spreadsheets often export numbers as text: "1,260", "$90.00", "(45)".
 * A text column is converted when every value parses as a number once that
 * formatting is removed and at least one value carries such formatting, so
 * plain codes such as "10023" are left alone.
 */
export async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
  const columns = (await query(`DESCRIBE "${table}"`))
    .filter((row) => String(row.column_type) === "VARCHAR")
    .map((row) => `"${String(row.column_name).replaceAll('"', '""')}"`);
  if (columns.length === 0) return;
  const cleaned = (c: string) =>
    `try_cast(regexp_replace(regexp_replace(trim(${c}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;
  const check = async (candidates: string[], source: string) => {
    const [counts] = await query(
      `SELECT ${candidates
        .map(
          (c, i) =>
            `count(${c})::DOUBLE AS n${i}, count(${cleaned(c)})::DOUBLE AS ok${i}, count(*) FILTER (WHERE regexp_matches(${c}, '[,$()]'))::DOUBLE AS f${i}`,
        )
        .join(", ")} FROM ${source}`,
    );
    return candidates.filter((_, i) => {
      const n = Number(counts[`n${i}`]);
      return n > 0 && n === Number(counts[`ok${i}`]) && Number(counts[`f${i}`]) > 0;
    });
  };
  // A small sample rules out almost every column cheaply; only survivors get the full scan.
  const likely = await check(columns, `(SELECT * FROM "${table}" LIMIT 2000)`);
  if (likely.length === 0) return;
  for (const c of await check(likely, `"${table}"`)) {
    await query(`ALTER TABLE "${table}" ALTER ${c} TYPE DOUBLE USING ${cleaned(c)}`);
  }
}

export async function decimalCommaNote(_query: Query, _table: string): Promise<string | null> {
  return null;
}
