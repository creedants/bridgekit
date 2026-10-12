export type PeriodSort = "numeric" | "text";

export interface PeriodList {
  /** Oldest first. Length is at most 200. */
  readonly values: readonly string[];
  /** Decided over every distinct value, including values absent from `values`. */
  readonly sort: PeriodSort;
}

/** Whole-string plain number: optional minus, digits, and one optional decimal. */
const PLAIN_NUMBER_SOURCE = String.raw`^-?\d+(\.\d+)?$`;
/**
 * A column is numeric only when every value is a plain number of at most this
 * many digits. That keeps every DOUBLE cast finite, below 10^15. Labels with
 * unequal numbers order by value. Labels with equal numbers, such as `1`,
 * `1.0` and `01`, stay separate periods and order by their original string.
 */
const MAX_DIGITS = 15;

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
       SELECT bool_and(
                regexp_matches(p, '${PLAIN_NUMBER_SOURCE}')
                AND length(regexp_replace(p, '[^0-9]', '', 'g')) <= ${MAX_DIGITS}
              ) AS numeric
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

/**
 * The tail of the ordered list: the periods the trend bridges, oldest first.
 * The list order is the only order, so no comparator runs here.
 */
export function trendPeriods(values: readonly string[], max: number): string[] {
  return values.slice(-max);
}
