/**
 * Period order.
 *
 * The list is oldest first and at most 200 values. `PeriodSort` is decided
 * over every distinct value, including values the 200-row window dropped.
 * Trend uses `comparePeriods` with that stored decision. It does not call
 * `distinctPeriodSort` on the window.
 */

export type PeriodSort = "numeric" | "text";

export interface PeriodList {
  /** Oldest first. Length is at most 200. */
  readonly values: readonly string[];
  /** Decided over every distinct value, including values absent from `values`. */
  readonly sort: PeriodSort;
}

/**
 * Numeric when every string is a plain number, otherwise text.
 * `distinct` is every distinct period string, not the capped window.
 */
export function distinctPeriodSort(distinct: readonly string[]): PeriodSort {
  void distinct;
  return "text";
}

/** Comparison for a decision already made. It does not look at sibling values. */
export function comparePeriods(sort: PeriodSort): (a: string, b: string) => number {
  void sort;
  return byText;
}

/**
 * `column` and `view` are already quoted identifiers.
 * Zero rows return `{ values: [], sort: "text" }`.
 */
export async function loadPeriodList(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
  column: string,
  view: string,
): Promise<PeriodList> {
  const rows = await query(
    `SELECT DISTINCT ${column} AS p FROM ${view}
     WHERE ${column} IS NOT NULL
     ORDER BY 1 DESC LIMIT 200`,
  );
  return { values: rows.map((row) => String(row.p)).reverse(), sort: "text" };
}

function byText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
