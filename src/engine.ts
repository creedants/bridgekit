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
 * With a gross sales column, the price effect of a matched cell is split, with
 * g = gross price and d = net / gross:
 *
 *   list price = q1 * (g1 - g0) * d0
 *   discounts  = q1 * g1 * (d1 - d0)
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
  /**
   * Optional sales before discounts. When set, the price effect is split into
   * a list-price part and a discount part.
   */
  grossColumn?: string;
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
  const gross = config.grossColumn ? ident(config.grossColumn) : null;
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
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${current} AND NOT ${hasUnits}), 0)::DOUBLE AS z1${
      gross
        ? `,
    coalesce(sum(${gross}) FILTER (WHERE ${period} = ${prior} AND ${hasUnits}), 0)::DOUBLE AS g0,
    coalesce(sum(${gross}) FILTER (WHERE ${period} = ${current} AND ${hasUnits}), 0)::DOUBLE AS g1`
        : ""
    }
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
),
priced_effects AS (
SELECT ${allColumns.join(", ")}, q0, s0, q1, s1, z0, z1,${gross ? " g0, g1," : ""} match_level, surviving_level,
  ${Array.from({ length: k + 1 }, (_, j) => `ref_${j}`).join(", ")},
  CASE WHEN q0 <= 0 THEN 'new' WHEN q1 = 0 THEN 'discontinued' ELSE 'continuing' END AS status,
  ${effects},
  z1 - z0 AS no_units
FROM referenced
)
SELECT *${
    gross
      ? `,
  CASE WHEN price <> 0 AND g0 <> 0 AND q0 > 0 AND q1 <> 0 THEN (g1 - q1 * g0 / q0) * (s0 / g0) ELSE 0 END AS price_list,
  price - CASE WHEN price <> 0 AND g0 <> 0 AND q0 > 0 AND q1 <> 0 THEN (g1 - q1 * g0 / q0) * (s0 / g0) ELSE 0 END AS price_discount`
      : ""
  }
FROM priced_effects`;
}

export function effectColumns(config: BridgeConfig): { key: string; label: string }[] {
  return [
    { key: "volume", label: "Volume" },
    ...config.levels.map((level, i) => ({ key: `mix_${i + 1}`, label: `Mix: ${level.name}` })),
    ...(config.grossColumn
      ? [
          { key: "price_list", label: "List price" },
          { key: "price_discount", label: "Discounts" },
        ]
      : [{ key: "price", label: "Price (like-for-like)" }]),
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
    : effects.includes(sortBy) || sortBy === "price" ? `sum(${sortBy})`
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
    `SELECT ${keys}, sum(q0) AS q0, sum(q1) AS q1, sum(s0) AS s0, sum(s1) AS s1, sum(z0) AS z0, sum(z1) AS z1,${effects.includes("price") ? "" : " sum(price) AS price,"} ${effects
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

export interface PriceBucket {
  label: string;
  cells: number;
  sales: number;
  share: number;
  priceEffect: number;
}

const PRICE_BUCKETS: [number, string][] = [
  [-0.1, "Down more than 10%"],
  [-0.05, "Down 5% to 10%"],
  [-0.02, "Down 2% to 5%"],
  [-0.005, "Down 0.5% to 2%"],
  [0.005, "No change (within 0.5%)"],
  [0.02, "Up 0.5% to 2%"],
  [0.05, "Up 2% to 5%"],
  [0.1, "Up 5% to 10%"],
  [Infinity, "Up more than 10%"],
];

/**
 * Current sales of exactly matched configurations, grouped by how much their
 * average price moved. Answers "how much of the book actually got the increase".
 */
export async function priceDistribution(
  query: Query,
  config: BridgeConfig,
): Promise<{ buckets: PriceBucket[]; averageChange: number }> {
  const k = config.levels.length;
  const change = "(s1 / q1) / (s0 / q0) - 1";
  const bucket =
    "CASE " +
    PRICE_BUCKETS.slice(0, -1)
      .map(([limit], i) => `WHEN ${change} < ${limit} THEN ${i}`)
      .join(" ") +
    ` ELSE ${PRICE_BUCKETS.length - 1} END`;
  const matched = `FROM ${ident(config.cellsTable ?? DEFAULT_CELLS_TABLE)}
     WHERE match_level = ${k} AND q0 > 0 AND q1 > 0 AND s0 > 0`;
  const rows = await query(
    `SELECT ${bucket} AS bucket, count(*)::DOUBLE AS cells, sum(s1) AS sales, sum(price) AS price_effect
     ${matched} GROUP BY 1`,
  );
  const [totals] = await query(`SELECT sum(s1) AS sales, sum(price) AS price_effect ${matched}`);
  const totalSales = Number(totals.sales ?? 0);
  const byIndex = new Map(rows.map((row) => [Number(row.bucket), row]));
  return {
    buckets: PRICE_BUCKETS.map(([, label], i) => {
      const row = byIndex.get(i);
      const sales = Number(row?.sales ?? 0);
      return {
        label,
        cells: Number(row?.cells ?? 0),
        sales,
        share: totalSales === 0 ? 0 : sales / totalSales,
        priceEffect: Number(row?.price_effect ?? 0),
      };
    }),
    // Price effect over what current volume would have cost at prior prices.
    averageChange: totalSales === 0 ? 0 : Number(totals.price_effect) / (totalSales - Number(totals.price_effect)),
  };
}

export interface Alternative {
  label: string;
  levels: Level[];
  price: number;
  mix: number;
  newAndDiscontinued: number;
  exactShare: number;
  cells: number;
}

/**
 * The same bridge with each attribute left out in turn, to show how much the
 * price number depends on the choice of attributes.
 */
export async function sensitivity(query: Query, config: BridgeConfig): Promise<Alternative[]> {
  const candidates = [
    { label: "Your setup", levels: config.levels },
    ...(config.levels.length > 1
      ? config.levels.map((level, i) => ({
          label: `Without ${level.name}`,
          levels: config.levels.toSpliced(i, 1),
        }))
      : []),
  ];
  const alternatives: Alternative[] = [];
  for (const candidate of candidates) {
    const result = await runBridge(query, { ...config, levels: candidate.levels, cellsTable: "bridge_alternative" });
    const sum = (match: (key: string) => boolean) =>
      result.effects.filter((e) => match(e.key)).reduce((total, e) => total + e.value, 0);
    alternatives.push({
      ...candidate,
      price: sum((key) => key.startsWith("price")),
      mix: sum((key) => key.startsWith("mix_")),
      newAndDiscontinued: sum((key) => key === "new_config" || key === "discontinued"),
      exactShare: result.coverage.find((c) => c.level === candidate.levels.length)?.share ?? 0,
      cells: result.coverage.reduce((total, c) => total + c.cells, 0),
    });
  }
  return alternatives;
}

export interface TrendStep {
  prior: string;
  current: string;
  priorSales: number;
  currentSales: number;
  volume: number;
  mix: number;
  price: number;
  newAndDiscontinued: number;
  noUnits: number;
}

/** One bridge per pair of consecutive periods, oldest first. */
export async function trend(
  query: Query,
  config: BridgeConfig,
  periods: (string | number)[],
): Promise<TrendStep[]> {
  const steps: TrendStep[] = [];
  for (let i = 1; i < periods.length; i++) {
    const result = await runBridge(query, {
      ...config,
      prior: periods[i - 1],
      current: periods[i],
      cellsTable: "bridge_trend",
    });
    const sum = (match: (key: string) => boolean) =>
      result.effects.filter((e) => match(e.key)).reduce((total, e) => total + e.value, 0);
    steps.push({
      prior: String(periods[i - 1]),
      current: String(periods[i]),
      priorSales: result.priorSales,
      currentSales: result.currentSales,
      volume: sum((key) => key === "volume"),
      mix: sum((key) => key.startsWith("mix_")),
      price: sum((key) => key.startsWith("price")),
      newAndDiscontinued: sum((key) => key === "new_config" || key === "discontinued"),
      noUnits: sum((key) => key === "no_units"),
    });
  }
  return steps;
}

export interface Realization {
  keys: Record<string, unknown>;
  /** Current sales of exactly matched configurations in the group. */
  matchedSales: number;
  priceEffect: number;
  /** Price effect over what current volume would have cost at prior prices. */
  change: number;
}

/** Like-for-like price change for each group, to compare with a planned increase. */
export async function priceRealization(
  query: Query,
  config: BridgeConfig,
  columns: string[],
  limit = 200,
): Promise<Realization[]> {
  const known = levelColumns(config);
  for (const column of columns) {
    if (!known.has(column)) throw new Error(`"${column}" is not a level column`);
  }
  const keys = columns.map(ident).join(", ");
  const rows = await query(
    `SELECT ${keys}, sum(s1) AS matched_sales, sum(price) AS price_effect
     FROM ${ident(config.cellsTable ?? DEFAULT_CELLS_TABLE)}
     WHERE match_level = ${config.levels.length} AND q0 > 0 AND q1 > 0 AND s0 > 0
     GROUP BY ${keys}
     ORDER BY sum(s1) DESC
     LIMIT ${Math.floor(limit)}`,
  );
  return rows.map((row) => {
    const matchedSales = Number(row.matched_sales);
    const priceEffect = Number(row.price_effect);
    const base = matchedSales - priceEffect;
    return {
      keys: Object.fromEntries(columns.map((c) => [c, row[c]])),
      matchedSales,
      priceEffect,
      change: base === 0 ? 0 : priceEffect / base,
    };
  });
}

export interface PriceGap {
  keys: Record<string, unknown>;
  units: number;
  sales: number;
  price: number;
  peerPrice: number;
  /** Extra sales if this row were priced at its peer average. */
  opportunity: number;
}

/**
 * Compares the current price of each configuration with the average for its
 * peers: the other configurations that share every attribute but the last.
 * With customer as the last attribute this shows who pays less than others
 * for the same product.
 */
export async function priceGaps(
  query: Query,
  config: BridgeConfig,
  limit = 200,
): Promise<{ rows: PriceGap[]; totalOpportunity: number; belowPeerSales: number; comparedSales: number }> {
  const k = config.levels.length;
  if (k < 2) return { rows: [], totalOpportunity: 0, belowPeerSales: 0, comparedSales: 0 };
  const all = cumulativeColumns(config.levels, k);
  const peers = cumulativeColumns(config.levels, k - 1).map(ident).join(", ");
  const compared = `
    SELECT *, peer_sales / peer_units AS peer_price, s1 / q1 AS own_price
    FROM (
      SELECT ${all.map(ident).join(", ")}, q1, s1,
        sum(s1) OVER (PARTITION BY ${peers}) AS peer_sales,
        sum(q1) OVER (PARTITION BY ${peers}) AS peer_units,
        count(*) OVER (PARTITION BY ${peers}) AS peer_count
      FROM ${ident(config.cellsTable ?? DEFAULT_CELLS_TABLE)}
      WHERE q1 > 0 AND s1 > 0
    )
    WHERE peer_count > 1 AND peer_units > 0`;
  const below = "own_price < peer_price";
  const [totals] = await query(
    `SELECT coalesce(sum((peer_price - own_price) * q1) FILTER (WHERE ${below}), 0) AS opportunity,
       coalesce(sum(s1) FILTER (WHERE ${below}), 0) AS below_sales,
       coalesce(sum(s1), 0) AS compared_sales
     FROM (${compared})`,
  );
  const rows = await query(
    `SELECT ${all.map(ident).join(", ")}, q1, s1, own_price, peer_price, (peer_price - own_price) * q1 AS opportunity
     FROM (${compared}) WHERE ${below}
     ORDER BY opportunity DESC LIMIT ${Math.floor(limit)}`,
  );
  return {
    rows: rows.map((row) => ({
      keys: Object.fromEntries(all.map((c) => [c, row[c]])),
      units: Number(row.q1),
      sales: Number(row.s1),
      price: Number(row.own_price),
      peerPrice: Number(row.peer_price),
      opportunity: Number(row.opportunity),
    })),
    totalOpportunity: Number(totals.opportunity),
    belowPeerSales: Number(totals.below_sales),
    comparedSales: Number(totals.compared_sales),
  };
}
