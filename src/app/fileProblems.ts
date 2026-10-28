import { guessSetup, isNumeric, netSalesHeldAsText, type Column, type Filter, type Grain } from "./setup.ts";

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
}

/** Same parts always return the same view. The file name is not part of it. */
export function periodView(parts: PeriodViewParts): PeriodView {
  return JSON.stringify([parts.load, parts.periodColumn, parts.grain, parts.filters]) as PeriodView;
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

export const MIXED_SEPARATORS_SENTENCE =
  "Rows in this file use different separators, so its columns may be split wrongly. Save it again with one separator.";

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
  /** True when a loaded record is split by a separator other than the reader's. */
  readonly mixedSeparators?: boolean;
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

/**
 * A non-numeric candidate for a missing measure, ordered by its file position.
 * An empty Sales choice first uses netSalesHeldAsText, which is empty when any
 * numeric column has "net" in its name, so a numeric net keeps the promoted
 * guess. Otherwise the candidate comes from guessSetup with every non-period,
 * non-numeric column promoted to a number.
 * A column is described as text only when its recorded type is VARCHAR.
 */
function soundMeasure(input: FileProblemInput): { name: string; role: Role; text: boolean } | undefined {
  const probed = guessSetup(promoted(input.columns, input.periodColumn));
  const held = netSalesHeldAsText(input.columns);
  const found: { name: string; role: Role; text: boolean; index: number }[] = [];
  for (const role of ["sales", "units"] as const) {
    const chosen = chosenName(input, role);
    const withheld = role === "sales" && chosen === "" && held !== "" && held !== input.periodColumn;
    if (choiceApplies(input.columns, chosen)) continue;
    if (chosen === "" && numericAvailable(input, role) && !withheld) continue;
    const name = withheld ? held : role === "sales" ? probed.salesColumn : probed.unitsColumn;
    if (name === "" || name === input.periodColumn) continue;
    const column = columnNamed(input.columns, name);
    if (!column || isNumeric(column.type)) continue;
    found.push({ name, role, text: isText(column.type), index: input.columns.indexOf(column) });
  }
  found.sort((a, b) => a.index - b.index);
  const first = found[0];
  return first === undefined ? undefined : { name: first.name, role: first.role, text: first.text };
}

function measureMessage(role: Role, name: string, text: boolean): string {
  const measure = role === "sales" ? "Sales" : "Units";
  if (text) return `${measure} must be a column of numbers, and "${name}" holds text.`;
  return `"${name}" cannot be used for ${measure} because it is not a column of numbers.`;
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
  if (input.mixedSeparators) {
    return { kind: "reason", message: MIXED_SEPARATORS_SENTENCE };
  }
  const count = periodCount(input.periods);
  if (input.periodColumn !== "" && count === 1) {
    return {
      kind: "reason",
      message: `With these settings "${input.periodColumn}" gives only one period, and a bridge compares two periods.`,
    };
  }
  const missing = soundMeasure(input);
  if (missing) {
    return { kind: "reason", message: measureMessage(missing.role, missing.name, missing.text) };
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
