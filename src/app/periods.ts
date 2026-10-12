export type PeriodSort = "numeric" | "text";

export interface PeriodList {
  /** Oldest first. Length is at most 200. */
  readonly values: readonly string[];
  /** Decided over every distinct value, including values absent from `values`. */
  readonly sort: PeriodSort;
}

/** Whole-string plain number: optional minus, digits, and one optional decimal. */
const PLAIN_NUMBER_SOURCE = String.raw`^-?\d+(\.\d+)?$`;
const PLAIN_NUMBER = new RegExp(PLAIN_NUMBER_SOURCE);

/**
 * Numeric when every string is a plain number, otherwise text.
 * `distinct` is every distinct period string, not the capped window.
 */
export function distinctPeriodSort(distinct: readonly string[]): PeriodSort {
  return distinct.every((value) => PLAIN_NUMBER.test(value)) ? "numeric" : "text";
}

/** Comparison for a decision already made. It does not look at sibling values. */
export function comparePeriods(sort: PeriodSort): (a: string, b: string) => number {
  if (sort === "text") return byText;
  if (sort === "numeric") {
    return (a, b) => {
      const delta = Number(a) - Number(b);
      if (Number.isFinite(delta) && delta !== 0) return delta;
      return byText(a, b);
    };
  }
  const unreachable: never = sort;
  return unreachable;
}

/**
 * `column` and `view` are already quoted identifiers.
 * Zero rows return `{ values: [], sort: "text" }`.
 * A missing or mixed decision flag throws.
 */
export async function loadPeriodList(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
  column: string,
  view: string,
): Promise<PeriodList> {
  const rows = await query(
    `WITH distinct_periods AS (
       SELECT DISTINCT ${column} AS p
       FROM ${view}
       WHERE ${column} IS NOT NULL
     ),
     decision AS (
       SELECT bool_and(regexp_matches(p, '${PLAIN_NUMBER_SOURCE}')) AS numeric
       FROM distinct_periods
     ),
     ranked AS (
       SELECT p,
              CASE WHEN (SELECT numeric FROM decision) THEN TRY_CAST(p AS DOUBLE) END AS n
       FROM distinct_periods
       ORDER BY n DESC, p DESC
       LIMIT 200
     )
     SELECT p, (SELECT numeric FROM decision) AS numeric
     FROM ranked
     ORDER BY n ASC, p ASC`,
  );
  if (rows.length === 0) return { values: [], sort: "text" };
  const flags = rows.map((row) => row.numeric);
  const decision = flags[0];
  if (typeof decision !== "boolean" || flags.some((flag) => flag !== decision)) {
    throw new Error("The period list could not be ordered.");
  }
  return {
    values: rows.map((row) => String(row.p)),
    sort: decision ? "numeric" : "text",
  };
}

function byText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
