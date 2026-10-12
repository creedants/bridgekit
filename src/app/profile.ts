import type { Query } from "../engine.ts";
import { isDate, isNumeric, quote, TABLE, type Column } from "./setup.ts";

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

// A column name looks like a customer, region, date or id column when any
// word in it is one of these, where a word is a part split on
// non-alphanumerics and camelCase boundaries, lowercased.
const NON_ATTRIBUTE_WORDS = new Set([
  "customer",
  "customers",
  "client",
  "clients",
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
 * Returns the text columns that look like product attributes, fewest distinct
 * values first with ties in file order. Keeps columns with 2 to 5000 distinct
 * values, drops the used period and measure columns and names with a
 * customer, region, date or id word.
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
