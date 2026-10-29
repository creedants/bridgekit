import { guessSetup, isNumeric, netSalesHeldAsText, type Column, type Filter, type Grain } from "./setup.ts";
import { shortened } from "./numbers.ts";

/** The first cell of a measure column that does not read as a number, with its spreadsheet row when the file proves one. */
export interface UnreadCell {
  readonly value: string;
  readonly row?: number;
}

/** A column as the profile hands it to the file problems list. */
export type ProfiledColumn = Column & { firstUnread?: UnreadCell };

/** The first unread cell a profile found, when there is one. */
export function firstUnreadOf(column: Column): UnreadCell | undefined {
  return (column as ProfiledColumn).firstUnread;
}


/**
 * A long period list draws a hint. Eight years of months are 96 labels, and
 * the period list stops at `MAX_PERIODS` in `periods.ts`. A longer monthly
 * history still crosses this line, so the note only says the list is long.
 */
export const MAX_PERIOD_VALUES = 100;

const periodViewBrand: unique symbol = Symbol("PeriodView");

/** Identity of one period read: the load, column, grain and filters that produced it. */
export type PeriodView = string & { readonly [periodViewBrand]: true };

export interface PeriodViewParts {
  readonly load: number;
  readonly periodColumn: string;
  readonly grain: Grain;
  readonly filters: readonly Filter[];
  /** First month of the fiscal year. Missing and 1 both mean January. */
  readonly fiscalYearStart?: number;
}

/** Same parts always return the same view. The file name is not part of it. */
export function periodView(parts: PeriodViewParts): PeriodView {
  const fiscalYearStart = parts.fiscalYearStart ?? 1;
  const key: unknown[] = [parts.load, parts.periodColumn, parts.grain, parts.filters];
  // A period list stored under the calendar setup keeps the four element key it was written with.
  if (fiscalYearStart !== 1) key.push(fiscalYearStart);
  return JSON.stringify(key) as PeriodView;
}

/** A period list stored with the view that produced it. */
export interface LoadedPeriods {
  readonly view: PeriodView;
  readonly values: readonly string[];
}

const currentPeriods: unique symbol = Symbol("CurrentPeriods");

export interface CurrentPeriods {
  readonly values: readonly string[];
  readonly [currentPeriods]: true;
}

/**
 * Periods for the settings on screen. "unknown" is not an empty list: an empty
 * list is a finished read that found nothing. Only periodsFor builds the known side.
 */
export type Periods = "unknown" | CurrentPeriods;

/** The stored list when it was produced for this view, otherwise unknown. */
export function periodsFor(view: PeriodView | null, loaded: LoadedPeriods | null): Periods {
  if (view === null || loaded === null || loaded.view !== view) return "unknown";
  return { values: loaded.values, [currentPeriods]: true };
}

export interface FileProblemInput {
  /** Columns of the loaded table, in file order. */
  readonly columns: readonly Column[];
  /** Rows in the loaded table. */
  readonly rows: number;
  /** The period column the setup picked, empty when none is picked. */
  readonly periodColumn: string;
  /** Periods for these settings, or unknown when the stored list belongs to other settings. */
  readonly periods: Periods;
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

/** DuckDB reports a character column as VARCHAR. No other recorded type is called text. */
function isText(type: string): boolean {
  return type.toUpperCase() === "VARCHAR";
}

function columnNamed(columns: readonly Column[], name: string): Column | undefined {
  return columns.find((column) => column.name === name);
}

function choiceApplies(columns: readonly Column[], name: string): boolean {
  const column = name === "" ? undefined : columnNamed(columns, name);
  return column !== undefined && isNumeric(column.type);
}

/** The period column keeps its type. Every other non-numeric column is offered to guessSetup as a number. */
function promoted(columns: readonly Column[], periodColumn: string): Column[] {
  return columns.map((column) =>
    column.name === periodColumn || isNumeric(column.type) ? column : { ...column, type: "DOUBLE" },
  );
}

type Role = "sales" | "units";

function chosenName(input: FileProblemInput, role: Role): string {
  return role === "sales" ? input.salesColumn : input.unitsColumn;
}

/**
 * A number the user can still pick for this measure. The period column, and the
 * other measure when that choice is itself a number, are not that measure.
 */
function numericAvailable(input: FileProblemInput, role: Role): boolean {
  const otherRole: Role = role === "sales" ? "units" : "sales";
  const other = choiceApplies(input.columns, chosenName(input, otherRole)) ? chosenName(input, otherRole) : "";
  return input.columns.some(
    (column) => isNumeric(column.type) && column.name !== input.periodColumn && column.name !== other,
  );
}

interface MeasureCandidate {
  column: Column;
  role: Role;
  text: boolean;
  index: number;
}

/**
 * The measure columns the file problems list could name, in file order. One
 * probe, so the message and the profile never carry a second list of measure
 * words.
 */
function measureCandidates(input: FileProblemInput): MeasureCandidate[] {
  const probed = guessSetup(promoted(input.columns, input.periodColumn));
  const held = netSalesHeldAsText(input.columns);
  const found: MeasureCandidate[] = [];
  for (const role of ["sales", "units"] as const) {
    const chosen = chosenName(input, role);
    const withheld = role === "sales" && chosen === "" && held !== "" && held !== input.periodColumn;
    if (choiceApplies(input.columns, chosen)) continue;
    if (chosen === "" && numericAvailable(input, role) && !withheld) continue;
    const name = withheld ? held : role === "sales" ? probed.salesColumn : probed.unitsColumn;
    if (name === "" || name === input.periodColumn) continue;
    const column = columnNamed(input.columns, name);
    if (!column || isNumeric(column.type)) continue;
    found.push({ column, role, text: isText(column.type), index: input.columns.indexOf(column) });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

function soundMeasure(input: FileProblemInput): MeasureCandidate | undefined {
  return measureCandidates(input)[0];
}

/** The columns a measure word names, by the setup module's own word lists. */
export function measureColumns(columns: readonly Column[]): string[] {
  return columns
    .filter((column) => {
      const probe = guessSetup([{ name: column.name, type: "DOUBLE" }]);
      return probe.salesColumn === column.name || probe.unitsColumn === column.name;
    })
    .map((column) => column.name);
}

function measureMessage(role: Role, column: Column, text: boolean): string {
  const measure = role === "sales" ? "Sales" : "Units";
  if (!text) return `"${column.name}" cannot be used for ${measure} because it is not a column of numbers.`;
  const unread = firstUnreadOf(column);
  const where = unread === undefined || unread.row === undefined ? "" : ` in row ${unread.row}`;
  const such = unread === undefined ? "" : `, such as "${shortened(unread.value)}"${where}`;
  return `${measure} must be a column of numbers, and "${column.name}" holds text${such}.`;
}

function periodCount(periods: Periods): number | undefined {
  return periods === "unknown" ? undefined : periods.values.length;
}

/** True when the list is exactly the suggestion: one column per name, in that order. */
export function sameSuggestedLevels(
  levels: readonly { readonly name: string; readonly columns: readonly string[] }[],
  suggested: readonly string[],
): boolean {
  return (
    levels.length === suggested.length &&
    levels.every((level, index) => {
      const name = suggested[index];
      return level.name === name && level.columns.length === 1 && level.columns[0] === name;
    })
  );
}

/**
 * Why Calculate stays off for a file the tool cannot bridge. The sample file
 * and any file that loads, guesses a setup and offers two periods give
 * `none`, so the general hint under Calculate stays as it is. A file with no
 * rows never reaches this list: the load refuses it first.
 */
export function fileProblem(input: FileProblemInput): FileProblem {
  const count = periodCount(input.periods);
  if (input.periodColumn !== "" && count === 1) {
    return {
      kind: "reason",
      message: `With these settings "${input.periodColumn}" gives only one period, and a bridge compares two periods.`,
    };
  }
  const missing = soundMeasure(input);
  if (missing) {
    return { kind: "reason", message: measureMessage(missing.role, missing.column, missing.text) };
  }
  if (input.columns.every((column) => !isNumeric(column.type))) {
    return { kind: "reason", message: "Sales and Units must be columns of numbers, and this file has none." };
  }
  if (input.periodColumn !== "" && count !== undefined && count > MAX_PERIOD_VALUES) {
    return {
      kind: "note",
      message: `The period column "${input.periodColumn}" has more than ${MAX_PERIOD_VALUES} periods.`,
    };
  }
  return { kind: "none" };
}
