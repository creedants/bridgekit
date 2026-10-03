/**
 * Price-volume-mix bridge with hierarchical fallback.
 *
 * Levels are ordered from most to least important. A "cell" is one full
 * combination of every level's columns. For each cell the reference price is
 * the prior-period average price at the finest level that had prior volume:
 *
 *   R_0 = prior average price overall
 *   R_j = prior average price of the cell's group at level j, else R_(j-1)
 *
 * Effects (they sum exactly to current sales - prior sales):
 *
 *   volume   = (q1 - q0) * R_0
 *   mix_j    = (q1 - q0) * (R_j - R_(j-1))     one per level
 *   rest     = s1 - s0 - (q1 - q0) * R_k       "price" for cells matched at the
 *                                              full key, "new" for the others
 *
 *   disc.    = (q1 - q0) * (R_k - R_m)         m = finest level whose group
 *                                              still sells in the current period
 *   no units = z1 - z0                         sales on rows with zero units
 *
 * "New" and "discontinued" mirror each other. A new cell is valued at the
 * nearest prior group that existed and the rest is "new". A discontinued cell
 * gets mix only down to the nearest group that survives (mix_j is zero below
 * level m) and the rest, its premium over that group, is "discontinued". Units
 * of both count in volume.
 *
 * With newAndDiscontinued = "full", new and discontinued cells are instead
 * shown at their full sales change and left out of volume, mix and price,
 * and reference prices are taken from continuing cells only.
 *
 * Rows with zero or blank units (rebates, credits, fees) have no price or
 * volume, so their sales z are kept out of q and s and bridged on their own
 * line. Prior and current totals include them.
 *
 * For a matched cell R_k = s0 / q0, so rest is s1 - R_k * q1. Writing it as a
 * remainder keeps every cell reconciled when prior units net to zero or less.
 *
 * Each cell's effects also sum to that cell's own sales change, so any
 * grouping of cells reconciles.
 *
 * The engine only generates SQL and takes a query function, so the same code
 * runs on DuckDB in Node and in the browser.
 */

export interface Level {
  name: string;
  /** One or more columns that together make up this attribute. */
  columns: string[];
}

export interface BridgeConfig {
  table: string;
  periodColumn: string;
  prior: string | number;
  current: string | number;
  unitsColumn: string;
  salesColumn: string;
  levels: Level[];
  /**
   * How new and discontinued configurations are shown.
   * "difference" (default): their units count in volume and mix, and the line
   * shows only their price difference from the nearest comparable group.
   * "full": the line shows their full sales, and volume, mix and price cover
   * continuing configurations only.
   */
  newAndDiscontinued?: "difference" | "full";
  /** Name of the temp table the per-cell results are written to. */
  cellsTable?: string;
}

export type Query = (sql: string) => Promise<Record<string, unknown>[]>;

export interface Effect {
  key: string;
  label: string;
  value: number;
}

export interface Coverage {
  /** 0 = matched only at the total, levels.length = matched at the full key. Shares are of current sales on rows with units. */
  level: number;
  label: string;
  cells: number;
  sales: number;
  share: number;
}

export interface BridgeResult {
  priorSales: number;
  currentSales: number;
  effects: Effect[];
  coverage: Coverage[];
  cellsTable: string;
}

const DEFAULT_CELLS_TABLE = "bridge_cells";

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function literal(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Period value must be finite");
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function validate(config: BridgeConfig): void {
  if (config.levels.length === 0) throw new Error("At least one level is required");
  const seen = new Set<string>();
  for (const level of config.levels) {
    if (level.columns.length === 0) throw new Error(`Level "${level.name}" has no columns`);
    for (const column of level.columns) {
      if (seen.has(column)) throw new Error(`Column "${column}" is used in more than one level`);
      seen.add(column);
    }
  }
}

/** Columns of levels 1..j, in order. */
export function cumulativeColumns(levels: Level[], j: number): string[] {
  return levels.slice(0, j).flatMap((level) => level.columns);
}

export function cellsSql(config: BridgeConfig): string {
  validate(config);
  const k = config.levels.length;
  const allColumns = cumulativeColumns(config.levels, k).map(ident);
  const period = ident(config.periodColumn);
  const prior = literal(config.prior);
  const current = literal(config.current);
  const units = ident(config.unitsColumn);
  const sales = ident(config.salesColumn);
  const hasUnits = `(${units} IS NOT NULL AND ${units} <> 0)`;
  const full = config.newAndDiscontinued === "full";
  // In "full" mode reference prices come from continuing configurations only.
  const continuing = "(q0 > 0 AND q1 <> 0)";
  const scope = full ? ` FILTER (WHERE ${continuing})` : "";

  const windows: string[] = [];
  const groupPrices: string[] = [];
  for (let j = 1; j <= k; j++) {
    const partition = cumulativeColumns(config.levels, j).map(ident).join(", ");
    windows.push(`sum(q0)${scope} OVER (PARTITION BY ${partition}) AS q0_l${j}`);
    windows.push(`sum(s0)${scope} OVER (PARTITION BY ${partition}) AS s0_l${j}`);
    windows.push(`sum(q1) OVER (PARTITION BY ${partition}) AS q1_l${j}`);
    groupPrices.push(`CASE WHEN q0_l${j} > 0 THEN s0_l${j} / q0_l${j} END AS p0_l${j}`);
  }

  // R_j = coalesce(p0_lj, ..., p0_l1, r0)
  const refs: string[] = ["r0 AS ref_0"];
  for (let j = 1; j <= k; j++) {
    const chain = Array.from({ length: j }, (_, i) => `p0_l${j - i}`).join(", ");
    refs.push(`coalesce(${chain}, r0) AS ref_${j}`);
  }
  const matchLevel = full
    ? `CASE WHEN q0 > 0 THEN ${k} ELSE 0 END`
    : "CASE " +
      Array.from({ length: k }, (_, i) => `WHEN p0_l${k - i} IS NOT NULL THEN ${k - i}`).join(" ") +
      " ELSE 0 END";

  // Finest level at which the cell's group still sells in the current period.
  const survivingLevel = full
    ? String(k)
    : "CASE " +
      Array.from({ length: k }, (_, i) => `WHEN q1_l${k - i} > 0 THEN ${k - i}`).join(" ") +
      " ELSE 0 END";
  const survivingRef =
    "CASE surviving_level " +
    Array.from({ length: k + 1 }, (_, j) => `WHEN ${j} THEN ref_${j}`).join(" ") +
    " END";

  const mixes = Array.from(
    { length: k },
    (_, i) =>
      `CASE WHEN ${full ? continuing : `surviving_level >= ${i + 1}`} THEN (q1 - q0) * (ref_${i + 1} - ref_${i}) ELSE 0 END AS mix_${i + 1}`,
  );
  const rest = `s1 - s0 - (q1 - q0) * ref_${k}`;
  const effects = full
    ? `CASE WHEN ${continuing} THEN ref_${k} END AS ref_price,
  CASE WHEN ${continuing} THEN (q1 - q0) * ref_0 ELSE 0 END AS volume,
  ${mixes.join(",\n  ")},
  CASE WHEN ${continuing} THEN ${rest} ELSE 0 END AS price,
  CASE WHEN q0 <= 0 THEN s1 - s0 ELSE 0 END AS new_config,
  CASE WHEN q0 > 0 AND q1 = 0 THEN s1 - s0 ELSE 0 END AS discontinued`
    : `ref_${k} AS ref_price,
  (q1 - q0) * ref_0 AS volume,
  ${mixes.join(",\n  ")},
  CASE WHEN match_level = ${k} THEN ${rest} ELSE 0 END AS price,
  CASE WHEN match_level < ${k} THEN ${rest} ELSE 0 END AS new_config,
  (q1 - q0) * (ref_${k} - ${survivingRef}) AS discontinued`;

  return `
WITH cells AS (
  SELECT ${allColumns.join(", ")},
    coalesce(sum(${units}) FILTER (WHERE ${period} = ${prior} AND ${hasUnits}), 0)::DOUBLE AS q0,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${prior} AND ${hasUnits}), 0)::DOUBLE AS s0,
    coalesce(sum(${units}) FILTER (WHERE ${period} = ${current} AND ${hasUnits}), 0)::DOUBLE AS q1,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${current} AND ${hasUnits}), 0)::DOUBLE AS s1,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${prior} AND NOT ${hasUnits}), 0)::DOUBLE AS z0,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${current} AND NOT ${hasUnits}), 0)::DOUBLE AS z1
  FROM ${ident(config.table)}
  WHERE ${period} IN (${prior}, ${current})
  GROUP BY ${allColumns.join(", ")}
),
windowed AS (
  SELECT *,
    sum(s0)${scope} OVER () / sum(q0)${scope} OVER () AS r0,
    ${windows.join(",\n    ")}
  FROM cells
),
priced AS (
  SELECT *,
    ${groupPrices.join(",\n    ")}
  FROM windowed
),
referenced AS (
  SELECT *,
    ${matchLevel} AS match_level,
    ${survivingLevel} AS surviving_level,
    ${refs.join(",\n    ")}
  FROM priced
)
SELECT ${allColumns.join(", ")}, q0, s0, q1, s1, z0, z1, match_level, surviving_level,
  ${Array.from({ length: k + 1 }, (_, j) => `ref_${j}`).join(", ")},
  CASE WHEN q0 <= 0 THEN 'new' WHEN q1 = 0 THEN 'discontinued' ELSE 'continuing' END AS status,
  ${effects},
  z1 - z0 AS no_units
FROM referenced`;
}

export function effectColumns(config: BridgeConfig): { key: string; label: string }[] {
  return [
    { key: "volume", label: "Volume" },
    ...config.levels.map((level, i) => ({ key: `mix_${i + 1}`, label: `Mix: ${level.name}` })),
    { key: "price", label: "Price (like-for-like)" },
    { key: "new_config", label: "New configurations" },
    { key: "discontinued", label: "Discontinued configurations" },
    { key: "no_units", label: "Sales with no units" },
  ];
}

export function coverageLabel(config: BridgeConfig, level: number): string {
  if (level === config.levels.length) return "Exact configuration";
  if (config.newAndDiscontinued === "full") return "New configuration (shown at full sales)";
  if (level === 0) return "No comparable group (overall average)";
  return `Fell back to ${config.levels
    .slice(0, level)
    .map((l) => l.name)
    .join(" + ")}`;
}

export async function runBridge(query: Query, config: BridgeConfig): Promise<BridgeResult> {
  const cellsTable = config.cellsTable ?? DEFAULT_CELLS_TABLE;
  const period = ident(config.periodColumn);

  const [priorTotals] = await query(
    `SELECT coalesce(sum(${ident(config.unitsColumn)}), 0)::DOUBLE AS q0
     FROM ${ident(config.table)} WHERE ${period} = ${literal(config.prior)}`,
  );
  if (!(Number(priorTotals.q0) > 0)) {
    throw new Error(`No units found for prior period ${literal(config.prior)}`);
  }

  await query(`CREATE OR REPLACE TEMP TABLE ${ident(cellsTable)} AS ${cellsSql(config)}`);

  const columns = effectColumns(config);
  const [totals] = await query(
    `SELECT sum(s0 + z0) AS s0, sum(s1 + z1) AS s1, sum(s1) AS unit_s1, ${columns
      .map((c) => `sum(${c.key}) AS ${c.key}`)
      .join(", ")}
     FROM ${ident(cellsTable)}`,
  );
  const currentSales = Number(totals.s1);
  const unitSales = Number(totals.unit_s1);

  const coverageRows = await query(
    `SELECT match_level, count(*)::DOUBLE AS cells, sum(s1) AS sales
     FROM ${ident(cellsTable)} WHERE q1 <> 0 OR s1 <> 0
     GROUP BY match_level ORDER BY match_level DESC`,
  );

  return {
    priorSales: Number(totals.s0),
    currentSales,
    effects: columns.map((c) => ({ ...c, value: Number(totals[c.key]) })),
    coverage: coverageRows.map((row) => {
      const level = Number(row.match_level);
      const sales = Number(row.sales);
      return {
        level,
        label: coverageLabel(config, level),
        cells: Number(row.cells),
        sales,
        share: unitSales === 0 ? 0 : sales / unitSales,
      };
    }),
    cellsTable,
  };
}

export interface DrillFilter {
  column: string;
  /** Compared against the column cast to text; null matches blanks. */
  value: string | null;
}

export interface DrillOptions {
  columns: string[];
  filters?: DrillFilter[];
  /** "change", "mix", or an effect key such as "price". Largest absolute value first. */
  sortBy?: string;
  limit?: number;
}

function levelColumns(config: BridgeConfig): Set<string> {
  return new Set(cumulativeColumns(config.levels, config.levels.length));
}

/** Effects summed by any subset of the level columns, largest movers first. */
export async function drill(
  query: Query,
  config: BridgeConfig,
  options: DrillOptions,
): Promise<Record<string, unknown>[]> {
  const known = levelColumns(config);
  const filters = options.filters ?? [];
  for (const column of [...options.columns, ...filters.map((f) => f.column)]) {
    if (!known.has(column)) throw new Error(`"${column}" is not a level column`);
  }
  const effects = effectColumns(config).map((c) => c.key);
  const mixes = effects.filter((e) => e.startsWith("mix_"));
  const sortBy = options.sortBy ?? "change";
  const sortExpression =
    sortBy === "change" ? "sum(s1 + z1) - sum(s0 + z0)"
    : sortBy === "mix" ? `sum(${mixes.join(" + ")})`
    : effects.includes(sortBy) ? `sum(${sortBy})`
    : null;
  if (!sortExpression) throw new Error(`Cannot sort by "${sortBy}"`);

  const keys = options.columns.map(ident).join(", ");
  const where = filters.length
    ? "WHERE " +
      filters
        .map((f) =>
          f.value === null
            ? `${ident(f.column)} IS NULL`
            : `CAST(${ident(f.column)} AS VARCHAR) = ${literal(f.value)}`,
        )
        .join(" AND ")
    : "";
  return query(
    `SELECT ${keys}, sum(q0) AS q0, sum(q1) AS q1, sum(s0) AS s0, sum(s1) AS s1, sum(z0) AS z0, sum(z1) AS z1, ${effects
      .map((e) => `sum(${e}) AS ${e}`)
      .join(", ")}
     FROM ${ident(config.cellsTable ?? DEFAULT_CELLS_TABLE)}
     ${where}
     GROUP BY ${keys}
     ORDER BY abs(${sortExpression}) DESC
     LIMIT ${Math.floor(options.limit ?? 100)}`,
  );
}

/** Current-period configurations with no exact prior match, largest first. */
export async function unmatched(
  query: Query,
  config: BridgeConfig,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const k = config.levels.length;
  const keys = cumulativeColumns(config.levels, k).map(ident).join(", ");
  return query(
    `SELECT ${keys}, q1, s1, match_level, ref_price, new_config
     FROM ${ident(config.cellsTable ?? DEFAULT_CELLS_TABLE)}
     WHERE match_level < ${k} AND (q1 <> 0 OR s1 <> 0)
     ORDER BY abs(s1) DESC
     LIMIT ${Math.floor(limit)}`,
  );
}

export interface DataCheck {
  rows: number;
  priorRows: number;
  currentRows: number;
  otherPeriodRows: number;
  blankPeriodRows: number;
  blankMeasureRows: number;
  negativeUnitRows: number;
  negativeSalesRows: number;
  zeroUnitSalesRows: number;
}

/** Row counts that explain what went into the bridge and what could distort it. */
export async function dataCheck(query: Query, config: BridgeConfig): Promise<DataCheck> {
  const period = ident(config.periodColumn);
  const units = ident(config.unitsColumn);
  const sales = ident(config.salesColumn);
  const inScope = `${period} IN (${literal(config.prior)}, ${literal(config.current)})`;
  const count = (condition: string) => `count(*) FILTER (WHERE ${condition})::DOUBLE`;
  const [row] = await query(
    `SELECT count(*)::DOUBLE AS "rows",
       ${count(`${period} = ${literal(config.prior)}`)} AS "priorRows",
       ${count(`${period} = ${literal(config.current)}`)} AS "currentRows",
       ${count(`${period} IS NOT NULL AND NOT (${inScope})`)} AS "otherPeriodRows",
       ${count(`${period} IS NULL`)} AS "blankPeriodRows",
       ${count(`${inScope} AND (${units} IS NULL OR ${sales} IS NULL)`)} AS "blankMeasureRows",
       ${count(`${inScope} AND ${units} < 0`)} AS "negativeUnitRows",
       ${count(`${inScope} AND ${sales} < 0`)} AS "negativeSalesRows",
       ${count(`${inScope} AND ${units} = 0 AND ${sales} <> 0`)} AS "zeroUnitSalesRows"
     FROM ${ident(config.table)}`,
  );
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as unknown as DataCheck;
}
