import type { Level } from "../engine.ts";
import type { FileProblem } from "./fileProblems.ts";

export const TABLE = "data";
export const VIEW = "data_in_scope";
export const PERIOD = "__period";

export interface ColumnFacts {
  /** Sum of the column's values over every row, when the column is numeric. */
  sum?: number;
  /** Earliest and latest date, when the column is a date. */
  first?: string;
  last?: string;
  /** Months with at least one row, when the column is a date. */
  months?: number;
}

export interface Column {
  name: string;
  type: string;
  /** Number of distinct values, once profiled. */
  distinct?: number;
  facts?: ColumnFacts;
  /** The earlier column this one maps to exactly or nearly, as found by the profile. */
  duplicateOf?: string;
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
  /** Optional first month of the fiscal year, 1 to 12. Missing or 1 means calendar. */
  fiscalYearStart?: number;
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
  /**
   * Set by guessSetup on a setup built from column names alone, and cleared by
   * any setup change the visitor makes in the panel. Not written to storage,
   * and dropped by restoredSetup, so only an untouched guess is refined.
   */
  fresh?: true;
  /**
   * The column the value fallback put in Sales, so the panel can say so. Cleared
   * when the visitor picks a Sales column. Not written to storage, and dropped
   * by restoredSetup.
   */
  salesFromValues?: string;
}

/** The most columns a save may carry. */
export const MAX_COLUMNS = 1000;
/** The longest column or level name a save may carry. */
export const MAX_COLUMN_NAME = 300;
/** The longest attribute name the editor takes; a restored setup is cut to it. */
export const MAX_LEVEL_NAME = 60;

export const isDate = (type: string) => /DATE|TIMESTAMP/i.test(type);
export const isNumeric = (type: string) => /INT|DOUBLE|DECIMAL|FLOAT|REAL/i.test(type);
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

const SALES_WORDS = ["sales", "revenue", "amount", "value", "turnover", "total"];
const GERMAN_SALES_STEMS = ["umsatz", "erlos", "erloes", "betrag"];
const FRENCH_SALES_WORDS = ["montant", "ventes", "vente", "recette", "recettes", "valeur", "affaires"];
const SPANISH_SALES_WORDS = ["ventas", "importe", "ingresos", "valor"];
const DUTCH_SALES_WORDS = ["omzet", "bedrag", "verkoop", "waarde"];
const salesPattern = new RegExp(
  [...SALES_WORDS, ...GERMAN_SALES_STEMS, ...FRENCH_SALES_WORDS, ...SPANISH_SALES_WORDS, ...DUTCH_SALES_WORDS]
    .toSorted((a, b) => b.length - a.length)
    .join("|"),
  "i",
);
const UNITS_PATTERN = /unit|qty|quant|jobs|volume|pieces|menge|stuck|stueck|anzahl|absatz/i;
/** Names that count what was sold, such as a bottle count, which beats a size or volume column. */
const COUNT_PATTERN = /unit|qty|quant|count|job|piece|menge|anzahl|absatz|stuck|stueck|boite|bottl/i;
/** Names that describe how much one unit holds or weighs, which is not a count of units. */
const SIZE_PATTERN = /volume|size|ml|litre|liter|kg|weight|gram|amount/i;
/** Price, cost and rate names used to suppress the value-inference hint. */
const PRICE_PATTERN = /price|cost|rate|preis|kosten/i;
/** Size-like name parts the value fallback refuses as Sales; "amount" is money and stays out. */
const SIZE_ONLY_PATTERN = /volume|size|ml|litre|liter|kg|\bweight\b|gram/i;
/** A currency word that takes a unit name out of the count-name rule, such as "currency units". */
const CURRENCY_PATTERN = /currency|usd|eur|gbp|dollar|euro|cent|pound|yen/i;
/** A name that says price, cost, rate, a unit price or one unit's size. Never Sales from its values. */
const notMoney = (name: string) => PRICE_PATTERN.test(fold(name)) || isUnitPrice(name) || SIZE_ONLY_PATTERN.test(fold(name));

/** A German unit price names a price: Stückpreis, Stueckpreis, Mengenpreis, Stückkosten. */
const PRICE_DE = /preis|kosten/i;
/** German tax marker used to exclude fallback sales candidates. */
const TAX_DE = /steuer/i;

/**
 * Lowercased and NFC-normalized, with German umlauts folded, so Stück matches
 * the stuck stem and Erlöse matches the erlos stem, and the French î folded so
 * boîtes matches the boites stem. ASCII names pass through.
 */
function fold(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u")
    .replaceAll("î", "i")
    .replaceAll("ß", "ss");
}

const words = (name: string) =>
  name
    .normalize("NFC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part !== "")
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((word) => fold(word));
const unitWords = new Set(["unit", "units", "menge", "stuck", "stueck", "anzahl", "absatz"]);
const priceWords = new Set(["price", "cost", "rate", "preis", "kosten"]);
const noteWords = new Set(["note", "notes", "comment", "comments"]);
const across = (left: string, right: string) =>
  (unitWords.has(left) && priceWords.has(right)) || (priceWords.has(left) && unitWords.has(right));
const isUnitPrice = (name: string) => {
  const parts = words(name);
  for (let i = 0; i < parts.length - 1; i++) {
    if (across(parts[i], parts[i + 1])) return true;
    if (parts[i + 1] === "per" && across(parts[i], parts[i + 2] ?? "")) return true;
  }
  // German compounds join the words: Stückpreis is one token, so the pair
  // check above never fires. A bare Stück or Menge names no price and stays pickable.
  const folded = fold(name);
  return PRICE_DE.test(folded) && UNITS_PATTERN.test(folded);
};
const isTrailingNote = (name: string) => noteWords.has(words(name).at(-1) ?? "");
/** A count name, unless a currency word takes it out; "Sales (Currency Units)" reads as money. */
const countName = (name: string) => COUNT_PATTERN.test(fold(name)) && !CURRENCY_PATTERN.test(fold(name));

/** First numeric column the guess would take as Sales by name, in file order. */
function salesByName(columns: readonly Column[], unitsColumn: string): string {
  return columns.find(
    (column) =>
      isNumeric(column.type) &&
      !isTrailingNote(column.name) &&
      column.name !== unitsColumn &&
      !TAX_DE.test(fold(column.name)) &&
      !isUnitPrice(column.name) &&
      !countName(column.name) &&
      salesPattern.test(fold(column.name)),
  )?.name ?? "";
}

/**
 * First non-numeric, non-date column with a whole "net" word and a money word,
 * excluding trailing notes, unit prices and quantity names. German, French,
 * Spanish and Dutch columns match their own money words the same way, except a
 * tax column such as Umsatzsteuer. Empty when any numeric column has "net" in
 * its name, checked before that filtering, so callers keep the base guess
 * whenever a numeric net column exists. Callers decide whether to withhold or
 * explain Sales.
 */
export function netSalesHeldAsText(columns: readonly Column[]): string {
  if (columns.some((column) => isNumeric(column.type) && /net/i.test(column.name))) return "";
  return columns.find((column) => {
    if (isNumeric(column.type) || isDate(column.type)) return false;
    const folded = fold(column.name);
    if (TAX_DE.test(folded)) return false;
    if (!words(column.name).includes("net")) return false;
    if (!salesPattern.test(folded)) return false;
    if (isTrailingNote(column.name)) return false;
    if (UNITS_PATTERN.test(folded)) return false;
    return true;
  })?.name ?? "";
}

/**
 * A count name beats a name that only describes how big one unit is. A name
 * that also reads as money is the weaker pick of two count names, because
 * "Business Unit Sales" says both what is counted and what is paid. Without a
 * count name, Units keeps the older unit-word reading, never a money or price
 * name.
 */
function unitsName(candidates: readonly Column[]): string {
  const counted = candidates.filter((column) => countName(column.name));
  if (counted.length === 0) {
    const plain = candidates.filter(
      (column) => !salesPattern.test(fold(column.name)) && !PRICE_PATTERN.test(fold(column.name)),
    );
    return plain.find((column) => UNITS_PATTERN.test(fold(column.name)))?.name ?? "";
  }
  const sized = counted.filter((column) => !SIZE_PATTERN.test(fold(column.name)));
  const pool = sized.length > 0 ? sized : counted;
  return (pool.find((column) => !salesPattern.test(fold(column.name))) ?? pool[0])?.name ?? "";
}

export function guessSetup(columns: Column[]): Setup {
  const find = (pattern: RegExp, among: readonly Column[]) =>
    among.find((c) => pattern.test(fold(c.name)))?.name ?? "";
  const numeric = columns.filter((c) => isNumeric(c.type));
  const date = columns.find((c) => isDate(c.type));
  const withoutNotes = numeric.filter((column) => !isTrailingNote(column.name));
  const periodColumn =
    date?.name ?? find(/year|annee|année|jahr|jaar|año|period|month|quarter|date|fiscal|exercice/i, columns);
  const unitsColumn = unitsName(withoutNotes.filter((column) => column.name !== periodColumn && !isUnitPrice(column.name)));
  const net = find(/net/i, withoutNotes.filter((column) => column.name !== unitsColumn && !isUnitPrice(column.name)));
  const held = net ? "" : netSalesHeldAsText(columns);
  // The sales-stem fallback shares its rule with the measure hint below.
  const byName = salesByName(columns, unitsColumn);
  const salesColumn = net || (held ? "" : byName);
  const grossColumn = find(/gross|list/i, withoutNotes);
  return {
    periodColumn,
    grain: date ? "year" : "value",
    unitsColumn,
    salesColumn: salesColumn === unitsColumn ? "" : salesColumn,
    grossColumn: held ? undefined : (grossColumn && grossColumn !== salesColumn ? grossColumn : undefined),
    levels: [],
    filters: [],
    fresh: true,
  };
}

/**
 * One short sentence about the measure guess, and which picker it sits beside.
 * Null when the guess is sure. At most one sentence, in this order: a price-like
 * Sales column, a second money column, Sales chosen from its values, Sales that
 * totals less than Units. None of them blocks Calculate.
 */
export function measureNote(
  columns: readonly Column[],
  setup: Setup,
): { role: "sales"; sentence: string } | null {
  const sales = setup.salesColumn;
  if (!sales) return null;
  if (notMoney(sales)) {
    return {
      role: "sales",
      sentence: `Sales is "${sales}", whose name suggests a price, so check that it is the total amount sold.`,
    };
  }
  // A gross or list column has the optional Gross sales picker of its own, so it
  // is not offered as the alternative Sales column.
  const other = salesByName(
    columns.filter(
      (column) =>
        column.name !== sales && column.name !== setup.grossColumn && !/gross|list/i.test(fold(column.name)),
    ),
    setup.unitsColumn,
  );
  if (other !== "") {
    return {
      role: "sales",
      sentence: `Sales is "${sales}", but "${other}" also looks like money; choose it in Sales if you meant that one.`,
    };
  }
  if (setup.salesFromValues === sales && salesByName(columns, setup.unitsColumn) === "") {
    return {
      role: "sales",
      sentence: `No column of numbers is named like sales, so Sales is "${sales}" because its values look like money.`,
    };
  }
  const unitsSum = columns.find((column) => column.name === setup.unitsColumn)?.facts?.sum;
  const salesSum = columns.find((column) => column.name === sales)?.facts?.sum;
  if (unitsSum !== undefined && salesSum !== undefined && salesSum < unitsSum) {
    return {
      role: "sales",
      sentence: `Sales totals less than Units, so "${sales}" may be a per-unit price rather than the amount sold.`,
    };
  }
  return null;
}

/**
 * The fields a value-based reading of the file would change in a name guess,
 * so dates covering multiple months inside one fiscal year can start on
 * Month, and a numeric sum can supply an unnamed Sales candidate. Returns only the fields that differ, and an
 * empty object when there is nothing to change. Only a fresh guess is refined,
 * so a restored or edited setup keeps the visitor's choices.
 */
export function refineGuess(setup: Setup, columns: readonly Column[]): Partial<Setup> {
  const patch: Partial<Setup> = {};
  if (setup.fresh !== true) return patch;
  const period = columns.find((column) => column.name === setup.periodColumn);
  const periodFacts = period?.facts;
  if (
    period !== undefined &&
    isDate(period.type) &&
    (setup.grain === "year" || setup.grain === "ytd") &&
    (periodFacts?.months ?? 0) >= 2 &&
    periodFacts?.first !== undefined &&
    periodFacts.last !== undefined &&
    fiscalYear(periodFacts.first, setup.fiscalYearStart) === fiscalYear(periodFacts.last, setup.fiscalYearStart)
  ) {
    patch.grain = "month";
  }
  if (!setup.salesColumn && netSalesHeldAsText(columns) === "") {
    const unitsSum = columns.find((column) => column.name === setup.unitsColumn)?.facts?.sum;
    if (unitsSum !== undefined) {
      let best: { name: string; sum: number } | undefined;
      for (const column of columns) {
        if (!isNumeric(column.type) || column.name === setup.periodColumn || column.name === setup.unitsColumn) continue;
        if (notMoney(column.name)) continue;
        if (TAX_DE.test(fold(column.name))) continue;
        if (countName(column.name)) continue;
        const sum = column.facts?.sum;
        if (sum === undefined || sum < unitsSum * 2) continue;
        if (best === undefined || sum > best.sum) best = { name: column.name, sum };
      }
      if (best !== undefined) {
        patch.salesColumn = best.name;
        patch.salesFromValues = best.name;
      }
    }
  }
  return patch;
}

/** A fiscal-year bucket for a "YYYY-MM-DD" string: two dates share it exactly when the year grain puts them in one period. */
function fiscalYear(date: string, fiscalYearStart: number | undefined): number {
  const start = fiscalYearStart ?? 1;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return year + (month >= start ? 1 : 0);
}

/**
 * The label expression for a period. Year to date reads the latest date in
 * `table`, which is the loaded table unless a caller names its own.
 */
export function periodExpression(column: string, grain: Grain, fiscalYearStart?: number, table: string = TABLE): string {
  const c = quote(column);
  const m =
    Number.isInteger(fiscalYearStart) && (fiscalYearStart as number) >= 2 && (fiscalYearStart as number) <= 12
      ? (fiscalYearStart as number)
      : 1;
  if (m === 1) {
    switch (grain) {
      case "year":
        return `strftime(${c}, '%Y')`;
      case "ytd":
        // Each year up to the month and day of the latest date in the data, so a part-year compares like with like.
        return `CASE WHEN strftime(${c}, '%m%d') <= (SELECT strftime(max(${c}), '%m%d') FROM ${quote(table)}) THEN strftime(${c}, '%Y') || ' YTD' END`;
      case "quarter":
        return `strftime(${c}, '%Y') || '-Q' || quarter(${c})`;
      case "month":
        return `strftime(${c}, '%Y-%m')`;
      case "value":
        return `CAST(${c} AS VARCHAR)`;
    }
  }
  const fy = `'FY' || CAST(year(${c}) + CASE WHEN month(${c}) >= ${m} THEN 1 ELSE 0 END AS VARCHAR)`;
  const fm = `((month(${c}) - ${m} + 12) % 12)`;
  switch (grain) {
    case "year":
      return fy;
    case "ytd": {
      const maxMonth = `(SELECT month(max(${c})) FROM ${quote(table)})`;
      const maxDay = `(SELECT day(max(${c})) FROM ${quote(table)})`;
      const maxFm = `((${maxMonth} - ${m} + 12) % 12)`;
      return `CASE WHEN ${fm} < ${maxFm} OR (${fm} = ${maxFm} AND day(${c}) <= ${maxDay}) THEN ${fy} || ' YTD' END`;
    }
    case "quarter":
      return `${fy} || '-Q' || CAST((${fm} // 3) + 1 AS VARCHAR)`;
    case "month":
      return `strftime(${c}, '%Y-%m')`;
    case "value":
      return `CAST(${c} AS VARCHAR)`;
  }
}

/** The WHERE condition for one filter, shared by the bridge's view and the coverage query so both read the same rows. */
export function filterCondition(filter: Filter): string {
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
    SELECT *, ${periodExpression(setup.periodColumn, setup.grain, setup.fiscalYearStart)} AS ${quote(PERIOD)}
    FROM ${quote(TABLE)}
    ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}`;
}

// Private by default: nothing is written to the browser until the visitor ticks
// Remember. Then the column mapping is stored, keyed by the set of column names.
// Filter selections are never stored because they are values from the data.
// Unticking deletes every key the tool has written, the choice included.
const PREFIX = "bridgekit:";
const SETUP_PREFIX = PREFIX + "setup:";
const REMEMBER_KEY = PREFIX + "remember";
/** Identifies a file layout by its column names, so a setup is offered again for files with the same columns. */
export const columnsKey = (names: string[]) => names.toSorted().join("|");
const storageKey = (columns: Column[]) => SETUP_PREFIX + columnsKey(columns.map((c) => c.name));

/**
 * Reads the choice from the stored value and the stored keys. Visitors from
 * before the opt-in have no value but do have saved setups; they had it on.
 */
export function rememberFrom(value: string | null, keys: readonly string[]): boolean {
  if (value === null) return keys.some((key) => key.startsWith(SETUP_PREFIX));
  return value === "on";
}

/** Whether a change to this storage key, null for a clear, can change the choice. */
export function affectsRemember(key: string | null): boolean {
  return key === null || key === REMEMBER_KEY || key.startsWith(SETUP_PREFIX);
}

export function isRemembering(): boolean {
  try {
    return rememberFrom(localStorage.getItem(REMEMBER_KEY), Object.keys(localStorage));
  } catch {
    return false;
  }
}

/** Turning this off deletes everything the tool has stored. */
export function setRemembering(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(REMEMBER_KEY, "on");
      return;
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Storage can be blocked; then nothing is stored, which is the safe outcome.
  }
}

/** The name an attribute shows and exports under: its own, or its columns joined with " + ". */
export function effectiveName(level: Level): string {
  if (level.name.trim() !== "") return level.name;
  return level.columns.filter((column) => column.trim() !== "").join(" + ");
}

/** Levels that have at least one non-empty column, with each empty name replaced by effectiveName. */
export function cleanLevels(levels: readonly Level[]): Level[] {
  return levels
    .map((level) => ({ name: effectiveName(level), columns: level.columns.filter((column) => column.trim() !== "") }))
    .filter((level) => level.columns.length > 0);
}

/** A setup from storage or a file, with attribute names cut to what the editor takes. */
export function restoredSetup(setup: Setup): Setup {
  const levels = cleanLevels(setup.levels).map((level) => ({ ...level, name: level.name.slice(0, MAX_LEVEL_NAME) }));
  const restored: Setup = { ...setup, levels, salesColumn: setup.salesColumn === setup.unitsColumn ? "" : setup.salesColumn };
  // A restored setup drops the guess markers, so it is never refined.
  delete restored.fresh;
  delete restored.salesFromValues;
  return restored;
}

interface ColumnRule {
  /** The type a chosen column must have. */
  readonly allows: (type: string) => boolean;
  /** Whether leaving this role empty is allowed. */
  readonly empty: boolean;
}

/** One row per column role: what it needs when chosen, and what an empty name means. */
const COLUMN_RULES: Record<"period" | "datePeriod" | "units" | "sales" | "gross" | "cost", ColumnRule> = {
  // A "value" grain reads any period column as text; the other grains need a date.
  period: { allows: () => true, empty: true },
  datePeriod: { allows: isDate, empty: true },
  units: { allows: isNumeric, empty: true },
  sales: { allows: isNumeric, empty: true },
  gross: { allows: isNumeric, empty: true },
  cost: { allows: isNumeric, empty: true },
};

export function isValidSetup(value: unknown, columns: Column[]): value is Setup {
  if (typeof value !== "object" || value === null) return false;
  const setup = value as Partial<Setup>;
  const names = new Set(columns.map((c) => c.name));
  const types = new Map(columns.map((c) => [c.name, c.type]));
  const known = (name: unknown) => typeof name === "string" && (name === "" || names.has(name));
  const named = (name: unknown) => typeof name === "string" && name !== "" && names.has(name);
  const fits = (name: unknown, rule: ColumnRule) => {
    if (typeof name !== "string") return false;
    if (name === "") return rule.empty;
    if (!types.has(name)) return false;
    // A caller that knows only names, like a saved workspace setup, reports no type.
    const type = types.get(name) ?? "";
    return type === "" || rule.allows(type);
  };
  return (
    known(setup.periodColumn) &&
    fits(setup.periodColumn, setup.grain === "value" ? COLUMN_RULES.period : COLUMN_RULES.datePeriod) &&
    fits(setup.unitsColumn, COLUMN_RULES.units) &&
    fits(setup.salesColumn, COLUMN_RULES.sales) &&
    (setup.grossColumn === undefined || fits(setup.grossColumn, COLUMN_RULES.gross)) &&
    (setup.costColumn === undefined || fits(setup.costColumn, COLUMN_RULES.cost)) &&
    ["value", "year", "ytd", "quarter", "month"].includes(setup.grain as string) &&
    (setup.fiscalYearStart === undefined ||
      (Number.isInteger(setup.fiscalYearStart) && setup.fiscalYearStart >= 1 && setup.fiscalYearStart <= 12)) &&
    Array.isArray(setup.levels) &&
    setup.levels.every(
      (l) => typeof l?.name === "string" && Array.isArray(l.columns) && l.columns.length > 0 && l.columns.every(named),
    ) &&
    [undefined, "difference", "full"].includes(setup.newAndDiscontinued) &&
    Array.isArray(setup.filters) &&
    setup.filters.every(
      (f) =>
        named(f?.column) &&
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
    return isValidSetup(saved, columns) ? restoredSetup({ ...saved, filters: [] }) : null;
  } catch {
    return null;
  }
}

export function saveSetup(columns: Column[], setup: Setup): void {
  if (!isRemembering()) return;
  try {
    // Neither marker is stored, so a setup restored from storage never refines.
    const { fresh: _fresh, salesFromValues: _salesFromValues, ...persisted } = setup;
    localStorage.setItem(storageKey(columns), JSON.stringify({ ...persisted, filters: [] }));
  } catch {
    // Storage can be full or blocked; the setup still works for this session.
  }
}

/** Where the calculation engine's download stands. */
export type EngineState = "idle" | "loading" | "ready" | "failed";
export type LoadSource = "file" | "sample";

/**
 * What the tool is doing with data. A load is numbered so that events from a
 * load the visitor has since replaced change nothing.
 */
export type Phase =
  | { kind: "start" }
  | { kind: "reading"; load: number; source: LoadSource; fileName?: string; label: string; back: "start" | "workspace" }
  /** A sample is loaded and its first bridge is being calculated. */
  | { kind: "autoRun"; load: number }
  | { kind: "workspace"; load: number };

export type PhaseEvent =
  /** `fileName` names the visitor's own file, so the wait can say it arrived. */
  | { type: "read"; load: number; source: LoadSource; fileName?: string; label: string }
  | { type: "loaded"; load: number }
  | { type: "failed"; load: number }
  | { type: "ran"; load: number };

export const ENGINE_LOADING_TEXT =
  "Loading the calculation engine (about 5 MB). On a slow connection this can take a minute or two. Your file is not uploaded.";
export const SAMPLE_LABEL = "Making the sample data…";
const SAMPLE_RUN_LABEL = "Calculating the sample bridge…";

export function initialPhase(search: string): Phase {
  return new URLSearchParams(search).has("sample")
    ? { kind: "reading", load: 0, source: "sample", label: SAMPLE_LABEL, back: "start" }
    : { kind: "start" };
}

export function nextPhase(phase: Phase, event: PhaseEvent): Phase {
  const load = phase.kind === "start" ? -1 : phase.load;
  if (event.type === "read") {
    if (event.load <= load) return phase;
    const back = phase.kind === "start" ? "start" : phase.kind === "reading" ? phase.back : "workspace";
    return { kind: "reading", load: event.load, source: event.source, fileName: event.fileName, label: event.label, back };
  }
  if (event.load !== load) return phase;
  switch (event.type) {
    case "loaded":
      if (phase.kind !== "reading") return phase;
      return phase.source === "sample" ? { kind: "autoRun", load } : { kind: "workspace", load };
    case "ran":
      return phase.kind === "autoRun" ? { kind: "workspace", load } : phase;
    case "failed":
      if (phase.kind === "reading" && phase.back === "start") return { kind: "start" };
      return phase.kind === "workspace" ? phase : { kind: "workspace", load };
  }
}

export type MainView = { kind: "start" } | { kind: "loading"; text: string; fileLine?: string } | { kind: "workspace" };

export function mainView(phase: Phase, engine: EngineState): MainView {
  switch (phase.kind) {
    case "start":
    case "workspace":
      return { kind: phase.kind };
    case "reading":
      if (engine === "ready") return { kind: "loading", text: phase.label };
      return phase.fileName === undefined
        ? { kind: "loading", text: ENGINE_LOADING_TEXT }
        : { kind: "loading", text: ENGINE_LOADING_TEXT, fileLine: `Got ${phase.fileName}. It opens as soon as the calculation engine has loaded.` };
    case "autoRun":
      return { kind: "loading", text: engine === "ready" ? SAMPLE_RUN_LABEL : ENGINE_LOADING_TEXT };
  }
}

/** The sample's first bridge runs once the setup is complete and the periods offered are its own. */
export function shouldAutoRun(phase: Phase, ready: boolean, periodsFresh: boolean): boolean {
  return phase.kind === "autoRun" && ready && periodsFresh;
}

export function hasData(phase: Phase): boolean {
  return phase.kind !== "start";
}

/** Leaving would lose loaded data, unless the visitor chose Clear data. */
export function shouldWarn(phase: Phase, leaving: boolean): boolean {
  return hasData(phase) && !leaving;
}

export type Missing = "periods" | "units" | "sales" | "attribute";

export type CalculateGate = { ready: true } | { ready: false; reason: string };

const MISSING_WORDS: Record<Missing, string> = {
  periods: "periods",
  units: "units",
  sales: "sales",
  attribute: "at least one attribute",
};

export function missingParts(setup: Setup | null, prior: string, current: string): Missing[] {
  const missing: Missing[] = [];
  if (!prior || !current) missing.push("periods");
  if (!setup?.unitsColumn) missing.push("units");
  if (!setup?.salesColumn) missing.push("sales");
  if (!setup || setup.levels.length === 0) missing.push("attribute");
  return missing;
}

/** "Choose units and sales." from the parts still missing, in the order the panel asks for them. */
export function missingSentence(missing: readonly Missing[]): string {
  const words = missing.map((part) => MISSING_WORDS[part]);
  const list = words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `Choose ${list}.`;
}

/** Whether Calculate may run and, when it may not, the one sentence that says why. */
export function calculateGate(input: {
  setup: Setup | null;
  prior: string;
  current: string;
  problem: FileProblem;
  /** Months with at least one row in the period column, when a profile has read the file. */
  months?: number;
}): CalculateGate {
  const { setup, prior, current, problem } = input;
  const missing = missingParts(setup, prior, current);
  if (missing.length === 0 && prior !== current) return { ready: true };
  if (problem.kind === "reason") {
    // The one-period sentence lives in src/app/fileProblems.ts, which is fenced,
    // so the words are detected here rather than exported from there.
    if (
      setup !== null &&
      input.months !== undefined &&
      input.months >= 2 &&
      problem.message.includes("gives only one period") &&
      (setup.grain === "year" || setup.grain === "ytd" || setup.grain === "quarter")
    ) {
      return {
        ready: false,
        reason: `With these settings "${setup.periodColumn}" gives only one period, so choose Month in Compare by.`,
      };
    }
    return { ready: false, reason: problem.message };
  }
  if (prior && prior === current) return { ready: false, reason: "Prior and current must be different periods." };
  return { ready: false, reason: missingSentence(missing) };
}

/**
 * Prior and current stay only when both are still offered and differ. Otherwise both reset together, to the
 * sample's suggestion when it is offered, else to the last two periods.
 */
export function carryPeriods(
  old: { prior: string; current: string },
  values: readonly string[],
  suggested: { prior: string; current: string } | null,
): { prior: string; current: string } {
  const usable = (pair: { prior: string; current: string }) =>
    values.includes(pair.prior) && values.includes(pair.current) && pair.prior !== pair.current;
  if (usable(old)) return old;
  if (suggested && usable(suggested)) return { prior: suggested.prior, current: suggested.current };
  return { prior: values.at(-2) ?? "", current: values.at(-1) ?? "" };
}

/** The columns offered as Units or Sales: numbers, but never the period column. */
export function measureColumns(columns: readonly Column[], setup: Setup): Column[] {
  return columns.filter((c) => isNumeric(c.type) && c.name !== setup.periodColumn);
}

/** The measure change for a picker: choosing the column the other measure holds swaps the two. */
export function measureChange(setup: Setup, role: "units" | "sales", value: string): Partial<Setup> {
  if (role === "units") {
    return { unitsColumn: value, ...(setup.salesColumn === value ? { salesColumn: setup.unitsColumn } : {}) };
  }
  return { salesColumn: value, ...(setup.unitsColumn === value ? { unitsColumn: setup.salesColumn } : {}) };
}

/** The address without `sample`, or null when it has none. */
export function withoutSample(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("sample")) return null;
  url.searchParams.delete("sample");
  return url.toString();
}
