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
 * A text label that names a date, upper-cased before matching so case never
 * splits a column. One pattern per format. A quarter takes its first month, a
 * fiscal year month 0, and a two-digit fiscal year is 20nn.
 */
const ISO_QUARTER_SOURCE = String.raw`^\d{4}-Q[1-4]$`;
const YEAR_QUARTER_SOURCE = String.raw`^\d{4} Q[1-4]$`;
const QUARTER_YEAR_SOURCE = String.raw`^Q[1-4] \d{4}$`;
const QUARTER_DASH_YEAR_SOURCE = String.raw`^Q[1-4]-\d{4}$`;
const MONTH_ABBREVIATION_SOURCE =
  String.raw`^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) \d{4}$`;
const MONTH_FULL_SOURCE =
  String.raw`^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER) \d{4}$`;
const YEAR_MONTH_SOURCE = String.raw`^\d{4}-(0[1-9]|1[0-2])$`;
const FISCAL_YEAR_SHORT_SOURCE = String.raw`^FY(\d{2})$`;
const FISCAL_YEAR_LONG_SOURCE = String.raw`^FY(\d{4})$`;

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
  // A dated label becomes `shape * 1000000 + year * 100 + month`, one shape
  // number per format. The date is below 1000000, so the key compares by date
  // inside one shape, and the shape number is what `dated` below counts.
  const rows = await query(
    `WITH distinct_periods AS (
       SELECT DISTINCT ${column} AS p, upper(${column}) AS u
       FROM ${view}
       WHERE ${column} IS NOT NULL
     ),
     labels AS (
       SELECT p,
              CASE
                WHEN regexp_matches(u, '${ISO_QUARTER_SOURCE}')
                  THEN 1000000 + CAST(substr(u, 1, 4) AS INTEGER) * 100
                       + (CAST(substr(u, 7, 1) AS INTEGER) - 1) * 3 + 1
                WHEN regexp_matches(u, '${YEAR_QUARTER_SOURCE}')
                  THEN 2000000 + CAST(substr(u, 1, 4) AS INTEGER) * 100
                       + (CAST(substr(u, 7, 1) AS INTEGER) - 1) * 3 + 1
                WHEN regexp_matches(u, '${QUARTER_YEAR_SOURCE}')
                  THEN 3000000 + CAST(substr(u, 4, 4) AS INTEGER) * 100
                       + (CAST(substr(u, 2, 1) AS INTEGER) - 1) * 3 + 1
                WHEN regexp_matches(u, '${QUARTER_DASH_YEAR_SOURCE}')
                  THEN 4000000 + CAST(substr(u, 4, 4) AS INTEGER) * 100
                       + (CAST(substr(u, 2, 1) AS INTEGER) - 1) * 3 + 1
                WHEN regexp_matches(u, '${MONTH_ABBREVIATION_SOURCE}')
                  THEN 5000000 + CAST(substr(u, length(u) - 3, 4) AS INTEGER) * 100
                       + list_position(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], substr(u, 1, 3))
                WHEN regexp_matches(u, '${MONTH_FULL_SOURCE}')
                  THEN 6000000 + CAST(substr(u, length(u) - 3, 4) AS INTEGER) * 100
                       + list_position(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], substr(u, 1, 3))
                WHEN regexp_matches(u, '${YEAR_MONTH_SOURCE}')
                  THEN 7000000 + CAST(substr(u, 1, 4) AS INTEGER) * 100 + CAST(substr(u, 6, 2) AS INTEGER)
                WHEN regexp_matches(u, '${FISCAL_YEAR_SHORT_SOURCE}')
                  THEN 8000000 + (2000 + CAST(substr(u, 3, 2) AS INTEGER)) * 100
                WHEN regexp_matches(u, '${FISCAL_YEAR_LONG_SOURCE}')
                  THEN 9000000 + CAST(substr(u, 3, 4) AS INTEGER) * 100
              END AS k
       FROM distinct_periods
     ),
     decision AS (
       SELECT bool_and(
                regexp_matches(p, '${PLAIN_NUMBER_SOURCE}')
                AND length(regexp_replace(p, '[^0-9]', '', 'g')) <= ${MAX_DIGITS}
              ) AS numeric,
              count(*) = count(k) AND count(DISTINCT k // 1000000) = 1 AS dated
       FROM labels
     ),
     ranked AS (
       SELECT p,
              CASE WHEN (SELECT numeric FROM decision) THEN TRY_CAST(p AS DOUBLE) END AS n,
              CASE WHEN (SELECT dated FROM decision) THEN k END AS d
       FROM labels
       ORDER BY n DESC, d DESC, p DESC
       LIMIT 200
     )
     SELECT p, (SELECT numeric FROM decision) AS numeric
     FROM ranked
     ORDER BY n ASC, d ASC, p ASC`,
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
