import { periodExpression, type Grain } from "./setup.ts";

export type PeriodSort = "numeric" | "text";

/** How much time one period's rows cover. */
export interface PeriodCoverage {
  period: string;
  months: number;
  days: number;
  rows: number;
}

/**
 * Caps the number of period values the list keeps. A file with more keeps the
 * ones that sort last.
 */
export const MAX_PERIODS = 2000;

export interface PeriodList {
  /** Oldest first. Length is at most 2000. */
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
const MONTH_DOT_YEAR_SOURCE = String.raw`^(0[1-9]|1[0-2])\.\d{4}$`;
const MONTH_SLASH_YEAR_SOURCE = String.raw`^(0[1-9]|1[0-2])/\d{4}$`;
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
  // A dated label becomes `shape * 1000000 + year * 100 + month`. The date is
  // below 1000000, so the key compares by date inside one shape. `v` tells
  // apart the pairs whose two formats share a key: a three-letter month name
  // from a full one, and a two-digit fiscal year from a four-digit one. `MAY`
  // is both a three-letter and a full month name, so it leaves `v` at 0 and
  // fits either. `dated` below requires one shape and at most one `v`.
  const rows = await query(
    `WITH distinct_labels AS (
       SELECT DISTINCT ${column} AS p
       FROM ${view}
       WHERE ${column} IS NOT NULL
     ),
     distinct_periods AS (
       SELECT p, upper(p) AS u
       FROM distinct_labels
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
                  OR regexp_matches(u, '${MONTH_FULL_SOURCE}')
                  THEN 5000000 + CAST(substr(u, length(u) - 3, 4) AS INTEGER) * 100
                       + list_position(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], substr(u, 1, 3))
                WHEN regexp_matches(u, '${YEAR_MONTH_SOURCE}')
                  THEN 6000000 + CAST(substr(u, 1, 4) AS INTEGER) * 100 + CAST(substr(u, 6, 2) AS INTEGER)
                WHEN regexp_matches(u, '${MONTH_DOT_YEAR_SOURCE}')
                  THEN 8000000 + CAST(substr(u, 4, 4) AS INTEGER) * 100 + CAST(substr(u, 1, 2) AS INTEGER)
                WHEN regexp_matches(u, '${MONTH_SLASH_YEAR_SOURCE}')
                  THEN 9000000 + CAST(substr(u, 4, 4) AS INTEGER) * 100 + CAST(substr(u, 1, 2) AS INTEGER)
                WHEN regexp_matches(u, '${FISCAL_YEAR_SHORT_SOURCE}')
                  THEN 7000000 + (2000 + CAST(substr(u, 3, 2) AS INTEGER)) * 100
                WHEN regexp_matches(u, '${FISCAL_YEAR_LONG_SOURCE}')
                  THEN 7000000 + CAST(substr(u, 3, 4) AS INTEGER) * 100
              END AS k,
              CASE
                WHEN regexp_matches(u, '${MONTH_ABBREVIATION_SOURCE}')
                  AND NOT regexp_matches(u, '${MONTH_FULL_SOURCE}') THEN 1
                WHEN regexp_matches(u, '${MONTH_FULL_SOURCE}')
                  AND NOT regexp_matches(u, '${MONTH_ABBREVIATION_SOURCE}') THEN 2
                WHEN regexp_matches(u, '${FISCAL_YEAR_SHORT_SOURCE}') THEN 3
                WHEN regexp_matches(u, '${FISCAL_YEAR_LONG_SOURCE}') THEN 4
                ELSE 0
              END AS v
       FROM distinct_periods
     ),
     decision AS (
       SELECT bool_and(
                regexp_matches(p, '${PLAIN_NUMBER_SOURCE}')
                AND length(regexp_replace(p, '[^0-9]', '', 'g')) <= ${MAX_DIGITS}
                -- A dotted month is a plain number too, and its date order wins.
                AND NOT regexp_matches(p, '${MONTH_DOT_YEAR_SOURCE}')
              ) AS numeric,
              count(*) = count(k)
                AND count(DISTINCT k // 1000000) = 1
                AND count(DISTINCT nullif(v, 0)) <= 1 AS dated
       FROM labels
     ),
     ranked AS (
       SELECT p,
              CASE WHEN (SELECT numeric FROM decision) THEN TRY_CAST(p AS DOUBLE) END AS n,
              CASE WHEN (SELECT dated FROM decision) THEN k END AS d
       FROM labels
       ORDER BY n DESC, d DESC, p DESC
       LIMIT ${MAX_PERIODS}
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

/**
 * A statement over the named table that counts, per period, the months and days
 * its rows cover, so a bridge can say when two periods differ in length.
 */
export function coverageSql(input: {
  table: string;
  periodColumn: string;
  grain: Grain;
  fiscalYearStart?: number;
}): string {
  const column = `"${input.periodColumn.replaceAll('"', '""')}"`;
  const table = `"${input.table.replaceAll('"', '""')}"`;
  const period = periodExpression(input.periodColumn, input.grain, input.fiscalYearStart, input.table);
  return `SELECT ${period} AS period,
       count(DISTINCT strftime(${column}, '%Y-%m'))::DOUBLE AS months,
       count(DISTINCT CAST(${column} AS DATE))::DOUBLE AS days,
       count(*)::DOUBLE AS rows
     FROM ${table}
     WHERE ${column} IS NOT NULL
     GROUP BY 1
     ORDER BY 1`;
}

/** The coverage rows as read, so a caller and a test share one shape. */
export function readCoverage(rows: readonly Record<string, unknown>[]): PeriodCoverage[] {
  return rows.map((row) => ({
    period: String(row.period),
    months: Number(row.months),
    days: Number(row.days),
    rows: Number(row.rows),
  }));
}

/** Below this share of the longer period, the shorter one is said to cover less time. */
const COVERAGE_FLOOR = 0.9;

/**
 * One plain sentence when the two periods cover different amounts of time, or
 * null. A month grain compares days, which the calendar-month label tells
 * apart from the year, year-to-date and quarter labels.
 */
export function coverageNote(
  rows: readonly PeriodCoverage[],
  prior: string,
  current: string,
): string | null {
  const a = rows.find((row) => row.period === prior);
  const b = rows.find((row) => row.period === current);
  if (a === undefined || b === undefined) return null;
  const unit = /^\d{4}-\d{2}$/.test(prior) && /^\d{4}-\d{2}$/.test(current) ? "days" : "months";
  const [shorter, longer] = a[unit] <= b[unit] ? [a[unit], b[unit]] : [b[unit], a[unit]];
  if (longer === 0 || shorter >= longer * COVERAGE_FLOOR) return null;
  return `"${prior}" covers ${a[unit]} ${unit} and "${current}" covers ${b[unit]}, so part of this change is the different time covered.`;
}
