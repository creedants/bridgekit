import type { Level } from "../engine.ts";

export const TABLE = "data";
export const VIEW = "data_in_scope";
export const PERIOD = "__period";

export interface Column {
  name: string;
  type: string;
  /** Number of distinct values, once profiled. */
  distinct?: number;
}

export type Grain = "value" | "year" | "ytd" | "quarter" | "month";

export interface Filter {
  column: string;
  mode: "include" | "exclude";
  values: string[];
}

export interface Setup {
  periodColumn: string;
  grain: Grain;
  unitsColumn: string;
  salesColumn: string;
  /** Optional sales before discounts; splits the price effect into list price and discounts. */
  grossColumn?: string;
  /** Optional cost; when set the bridge is on margin. */
  costColumn?: string;
  levels: Level[];
  filters: Filter[];
  /** See BridgeConfig.newAndDiscontinued. Absent in setups saved before the option existed. */
  newAndDiscontinued?: "difference" | "full";
}

export const isDate = (type: string) => /DATE|TIMESTAMP/i.test(type);
export const isNumeric = (type: string) => /INT|DOUBLE|DECIMAL|FLOAT|REAL/i.test(type);
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function guessSetup(columns: Column[]): Setup {
  const find = (pattern: RegExp, among: Column[]) => among.find((c) => pattern.test(c.name))?.name ?? "";
  const numeric = columns.filter((c) => isNumeric(c.type));
  const date = columns.find((c) => isDate(c.type));
  const words = (name: string) =>
    name
      .split(/[^A-Za-z0-9]+/)
      .filter((part) => part !== "")
      .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .map((word) => word.toLowerCase());
  const unitWords = new Set(["unit", "units"]);
  const priceWords = new Set(["price", "cost", "rate"]);
  const noteWords = new Set(["note", "notes", "comment", "comments"]);
  const across = (left: string, right: string) =>
    (unitWords.has(left) && priceWords.has(right)) || (priceWords.has(left) && unitWords.has(right));
  const isUnitPrice = (name: string) => {
    const parts = words(name);
    for (let i = 0; i < parts.length - 1; i++) {
      if (across(parts[i], parts[i + 1])) return true;
      if (parts[i + 1] === "per" && across(parts[i], parts[i + 2] ?? "")) return true;
    }
    return false;
  };
  const isTrailingNote = (name: string) => noteWords.has(words(name).at(-1) ?? "");
  const withoutNotes = numeric.filter((column) => !isTrailingNote(column.name));
  const unitsCandidates = withoutNotes.filter((column) => !isUnitPrice(column.name));
  const salesColumn = find(/net/i, withoutNotes) || find(/sales|revenue|amount|value/i, withoutNotes);
  const grossColumn = find(/gross|list/i, withoutNotes);
  return {
    periodColumn: date?.name ?? find(/year|period|month|quarter|date/i, columns),
    grain: date ? "year" : "value",
    unitsColumn: find(/unit|qty|quant|jobs|volume|pieces/i, unitsCandidates),
    salesColumn,
    grossColumn: grossColumn && grossColumn !== salesColumn ? grossColumn : undefined,
    levels: [],
    filters: [],
  };
}

function periodExpression(column: string, grain: Grain): string {
  const c = quote(column);
  switch (grain) {
    case "year":
      return `strftime(${c}, '%Y')`;
    case "ytd":
      // Each year up to the month and day of the latest date in the data, so a part-year compares like with like.
      return `CASE WHEN strftime(${c}, '%m%d') <= (SELECT strftime(max(${c}), '%m%d') FROM ${quote(TABLE)}) THEN strftime(${c}, '%Y') || ' YTD' END`;
    case "quarter":
      return `strftime(${c}, '%Y') || '-Q' || quarter(${c})`;
    case "month":
      return `strftime(${c}, '%Y-%m')`;
    case "value":
      return `CAST(${c} AS VARCHAR)`;
  }
}

function filterCondition(filter: Filter): string {
  const column = `CAST(${quote(filter.column)} AS VARCHAR)`;
  const list = filter.values.map(text).join(", ");
  return filter.mode === "include"
    ? `${column} IN (${list})`
    : `(${quote(filter.column)} IS NULL OR ${column} NOT IN (${list}))`;
}

/** The view the bridge reads: the loaded table with filters applied and a text period column added. */
export function viewSql(setup: Setup): string {
  const conditions = setup.filters.filter((f) => f.values.length > 0).map(filterCondition);
  return `CREATE OR REPLACE VIEW ${quote(VIEW)} AS
    SELECT *, ${periodExpression(setup.periodColumn, setup.grain)} AS ${quote(PERIOD)}
    FROM ${quote(TABLE)}
    ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}`;
}

// Private by default: nothing from the data is written to the browser. The
// column mapping is remembered unless the user turns that off, keyed by the set
// of column names. Filter selections are never stored because they are values
// from the data. Turning it off deletes everything and leaves only the "off"
// preference, so the choice survives a reload.
const PREFIX = "bridgekit:";
const REMEMBER_KEY = PREFIX + "remember";
/** Identifies a file layout by its column names, so a setup is offered again for files with the same columns. */
export const columnsKey = (names: string[]) => names.toSorted().join("|");
const storageKey = (columns: Column[]) => PREFIX + "setup:" + columnsKey(columns.map((c) => c.name));

export function isRemembering(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== "off";
  } catch {
    return false;
  }
}

/** Turning this off deletes everything the tool has stored. */
export function setRemembering(on: boolean): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
    if (!on) localStorage.setItem(REMEMBER_KEY, "off");
  } catch {
    // Storage can be blocked; then nothing is stored, which is the safe outcome.
  }
}

export function isValidSetup(value: unknown, columns: Column[]): value is Setup {
  if (typeof value !== "object" || value === null) return false;
  const setup = value as Partial<Setup>;
  const names = new Set(columns.map((c) => c.name));
  const known = (name: unknown) => typeof name === "string" && (name === "" || names.has(name));
  return (
    known(setup.periodColumn) &&
    known(setup.unitsColumn) &&
    known(setup.salesColumn) &&
    (setup.grossColumn === undefined || known(setup.grossColumn)) &&
    (setup.costColumn === undefined || known(setup.costColumn)) &&
    ["value", "year", "ytd", "quarter", "month"].includes(setup.grain as string) &&
    Array.isArray(setup.levels) &&
    setup.levels.every(
      (l) => typeof l?.name === "string" && Array.isArray(l.columns) && l.columns.length > 0 && l.columns.every(known),
    ) &&
    [undefined, "difference", "full"].includes(setup.newAndDiscontinued) &&
    Array.isArray(setup.filters) &&
    setup.filters.every(
      (f) =>
        known(f?.column) &&
        (f.mode === "include" || f.mode === "exclude") &&
        Array.isArray(f.values) &&
        f.values.every((v) => typeof v === "string"),
    )
  );
}

export function loadSavedSetup(columns: Column[]): Setup | null {
  if (!isRemembering()) return null;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey(columns)) ?? "null");
    // Very early versions stored filters too; drop them rather than trust them.
    return isValidSetup(saved, columns) ? { ...saved, filters: [] } : null;
  } catch {
    return null;
  }
}

export function saveSetup(columns: Column[], setup: Setup): void {
  if (!isRemembering()) return;
  try {
    localStorage.setItem(storageKey(columns), JSON.stringify({ ...setup, filters: [] }));
  } catch {
    // Storage can be full or blocked; the setup still works for this session.
  }
}
