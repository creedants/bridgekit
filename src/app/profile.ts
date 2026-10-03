import type { Query } from "../engine.ts";
import { isDate, isNumeric, quote, TABLE, type Column } from "./setup.ts";

const SAMPLE_ROWS = 200_000;
const MAX_CANDIDATES = 14;
const MAX_DISTINCT = 5_000;

/** Exact distinct count per column, used to label the attribute pickers. */
export async function distinctCounts(query: Query, columns: Column[]): Promise<Map<string, number>> {
  const [row] = await query(
    `SELECT ${columns.map((c, i) => `count(DISTINCT ${quote(c.name)})::DOUBLE AS c${i}`).join(", ")} FROM ${quote(TABLE)}`,
  );
  return new Map(columns.map((c, i) => [c.name, Number(row[`c${i}`])]));
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
  const [row] = await query(
    `SELECT ${candidates.map((c, i) => `count(DISTINCT ${quote(c)})::DOUBLE AS d${i}`).join(", ")},
       ${pairs.map(([a, b], i) => `count(DISTINCT (${quote(a)}, ${quote(b)})) FILTER (WHERE ${quote(a)} IS NOT NULL AND ${quote(b)} IS NOT NULL)::DOUBLE AS p${i}`).join(", ")}
     FROM (SELECT * FROM ${quote(TABLE)} USING SAMPLE ${SAMPLE_ROWS} ROWS)`,
  );
  const count = new Map(candidates.map((c, i) => [c, Number(row[`d${i}`])]));
  // finer -> the broader columns it sits under
  const parents = new Map<string, Set<string>>(candidates.map((c) => [c, new Set()]));
  pairs.forEach(([a, b], i) => {
    const together = Number(row[`p${i}`]);
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
