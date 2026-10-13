import { isDate, isNumeric, type Column } from "./setup.ts";

/**
 * A period label stands for a span of rows: one per year, four per year or
 * twelve per year. Eight years of monthly labels make 96 values, so a period
 * column above this holds something else, usually a date the file kept as text
 * where every string became its own period. `loadPeriodList` stops at 200
 * values, so this threshold sits well inside that cap.
 */
export const MAX_PERIOD_VALUES = 100;

// The same words `guessSetup` uses to pick measures, so a column named like a
// measure is one the user expects to find in the Units or Sales list.
const SALES_NAME = /sales|revenue|amount|value/i;
const UNITS_NAME = /unit|qty|quant|volume|pieces/i;

export interface FileProblemInput {
  /** Columns of the loaded table, in file order. */
  readonly columns: readonly Column[];
  /** Rows in the loaded table. */
  readonly rows: number;
  /** The period column the setup picked, empty when none is picked. */
  readonly periodColumn: string;
  /** Distinct values of that column in the current view, oldest first. */
  readonly periods: readonly string[];
  /** The column picked for units, empty when none is picked. */
  readonly unitsColumn: string;
  /** The column picked for sales, empty when none is picked. */
  readonly salesColumn: string;
}

export type FileProblem =
  /** Nothing beyond the choices the user still has to make. */
  | { readonly kind: "none" }
  /** The general hint is the wrong explanation. Show this instead of it. */
  | { readonly kind: "reason"; readonly message: string }
  /** The general hint is right. Show this beside it. */
  | { readonly kind: "note"; readonly message: string };

/**
 * A column that holds text but is named like a measure, for the measure the
 * setup has not filled yet. The Units and Sales lists hold numeric columns
 * only, so such a column is missing from the list the user is looking at and
 * nothing on the page says why.
 */
function missingTextMeasure(input: FileProblemInput): { name: string; role: "sales" | "units" } | undefined {
  for (const column of input.columns) {
    if (isNumeric(column.type) || isDate(column.type)) continue;
    if (column.name === input.periodColumn) continue;
    if (!SALES_NAME.test(column.name) && !UNITS_NAME.test(column.name)) continue;
    const role = SALES_NAME.test(column.name) ? "sales" : "units";
    if (role === "sales" ? input.salesColumn !== "" : input.unitsColumn !== "") continue;
    return { name: column.name, role };
  }
  return undefined;
}

/**
 * Why Calculate stays off for a file the tool cannot bridge. The sample file
 * and any file that loads, guesses a setup and offers two periods give
 * `none`, so the general hint under Calculate stays as it is.
 */
export function fileProblem(input: FileProblemInput): FileProblem {
  if (input.rows === 0) {
    return { kind: "reason", message: "This file has no data rows, so there is nothing to bridge." };
  }
  if (input.periodColumn !== "" && input.periods.length === 1) {
    return {
      kind: "reason",
      message: `The period column "${input.periodColumn}" has only one value, and a bridge compares two periods.`,
    };
  }
  const missing = missingTextMeasure(input);
  if (missing) {
    const measure = missing.role === "sales" ? "Sales" : "Units";
    return { kind: "reason", message: `${measure} must be a column of numbers, and "${missing.name}" holds text.` };
  }
  if (input.columns.every((column) => !isNumeric(column.type))) {
    return { kind: "reason", message: "Sales and Units must be columns of numbers, and this file has none." };
  }
  if (input.periodColumn !== "" && input.periods.length > MAX_PERIOD_VALUES) {
    return {
      kind: "note",
      message: `The period column "${input.periodColumn}" holds more than ${MAX_PERIOD_VALUES} values, and a period column should hold a few period labels such as years or months.`,
    };
  }
  return { kind: "none" };
}
