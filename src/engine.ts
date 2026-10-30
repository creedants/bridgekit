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
 * With a cost column the bridged measure is margin, so "price" above is the
 * change in unit margin on matched cells. It is split into the part from the
 * selling price, q1 * (p1 - p0), and the rest, which is unit cost.
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
  /**
   * Optional cost. When set, the bridge is on margin (sales minus cost) and the
   * rate effect is split into price and unit cost. Takes precedence over grossColumn.
   */
  costColumn?: string;
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

export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function literal(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Period value must be finite");
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function structKey(alias: string | null, columns: string[]): string {
  const fields = columns.map((column) => {
    const value = alias ? `${alias}.${ident(column)}` : ident(column);
    return `${ident(column)}: ${value}`;
  });
  return `{${fields.join(", ")}}`;
}

function validate(config: BridgeConfig): void {
  if (config.levels.length === 0) throw new Error("At least one level is required");
  const reserved = /^(q0|s0|q1|s1|z0|z1|g0|g1|rs0|rs1|r0|match_level|surviving_level|status|ref_price|volume|price|new_config|discontinued|no_units|price_list|price_discount|price_sales|cost_rate|(ref|mix)_\d+|[qsp][01]_l\d+)$/i;
  const seen = new Set<string>();
  for (const level of config.levels) {
    if (level.columns.length === 0) throw new Error(`Level "${level.name}" has no columns`);
    for (const column of level.columns) {
      if (seen.has(column)) throw new Error(`Column "${column}" is used in more than one level`);
      if (reserved.test(column)) {
        throw new Error(`Column "${column}" has a name the calculation uses internally. Rename it in your file and load it again.`);
      }
      seen.add(column);
    }
  }
}

/** Columns of levels 1..j, in order. */
export function cumulativeColumns(levels: Level[], j: number): string[] {
  return levels.slice(0, j).flatMap((level) => level.columns);
}

/** What one row adds to the bridge: sales, or sales minus cost when the bridge is on margin. */
export function measureSql(config: BridgeConfig): string {
  const sales = ident(config.salesColumn);
  return config.costColumn
    ? `(coalesce(${sales}, 0) - coalesce(${ident(config.costColumn)}, 0))`
    : sales;
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
  const cost = config.costColumn ? ident(config.costColumn) : null;
  const gross = !cost && config.grossColumn ? ident(config.grossColumn) : null;
  const measure = measureSql(config);
  const full = config.newAndDiscontinued === "full";
  // In "full" mode reference prices come from continuing configurations only.
  const continuing = "(q0 > 0 AND q1 <> 0)";
  const scope = full ? ` FILTER (WHERE ${continuing})` : "";

  const groupPrices: string[] = [];
  for (let j = 1; j <= k; j++) {
    groupPrices.push(`CASE WHEN q0_l${j} > 0 THEN s0_l${j} / q0_l${j} END AS p0_l${j}`);
  }

  // Joining every level in one FROM makes DuckDB cross-join those aggregates first
  // (184 million rows at 3 million sales rows).
  const levelCtes: string[] = [
    `totals AS (
  SELECT sum(s0)${scope} AS tot_s0, sum(q0)${scope} AS tot_q0
  FROM cells
)`,
  ];
  for (let j = 1; j < k; j++) {
    const columns = cumulativeColumns(config.levels, j);
    const group = columns.map(ident).join(", ");
    levelCtes.push(`lvl${j} AS (
  SELECT ${structKey(null, columns)} AS k, sum(q0)${scope} AS q0_l${j}, sum(s0)${scope} AS s0_l${j}, sum(q1) AS q1_l${j}
  FROM cells
  GROUP BY ${group}
)`);
  }
  const finest = (alias: string) => {
    const onCell = `(${alias}.q0 > 0 AND ${alias}.q1 <> 0)`;
    return `${full ? `CASE WHEN ${onCell} THEN ${alias}.q0 END` : `${alias}.q0`} AS q0_l${k},
    ${full ? `CASE WHEN ${onCell} THEN ${alias}.s0 END` : `${alias}.s0`} AS s0_l${k},
    ${alias}.q1 AS q1_l${k}`;
  };
  const joinCtes: string[] = [];
  if (k === 1) {
    joinCtes.push(`windowed AS (
  SELECT c.*,
    t.tot_s0 / t.tot_q0 AS r0,
    ${finest("c")}
  FROM cells c
  CROSS JOIN totals t
)`);
  } else {
    let source = "cells c\n  CROSS JOIN totals t";
    let alias = "c";
    for (let j = 1; j < k; j++) {
      const columns = cumulativeColumns(config.levels, j);
      const last = j === k - 1;
      const name = last ? "windowed" : `joined_${j}`;
      const extras = [
        ...(j === 1 ? ["t.tot_s0 / t.tot_q0 AS r0"] : []),
        `a${j}.q0_l${j}`,
        `a${j}.s0_l${j}`,
        `a${j}.q1_l${j}`,
      ];
      if (last) extras.push(finest(alias));
      joinCtes.push(`${name} AS${last ? "" : " MATERIALIZED"} (
  SELECT ${j === 1 ? "c" : alias}.*,
    ${extras.join(",\n    ")}
  FROM ${source}
  JOIN lvl${j} a${j} ON a${j}.k IS NOT DISTINCT FROM ${structKey(alias, columns)}
)`);
      source = name;
      alias = name;
    }
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
  // Cells whose rate effect is like-for-like, so it can be split further.
  const rated = full ? continuing : `match_level = ${k}`;
  const effects = full
    ? `CASE WHEN ${continuing} THEN ref_${k} END AS ref_price,
  CASE WHEN ${continuing} THEN (q1 - q0) * ref_0 ELSE 0 END AS volume,
  ${mixes.join(",\n  ")},
  CASE WHEN ${continuing} THEN ${rest} ELSE 0 END AS price,
  CASE WHEN q0 <= 0 AND NOT (q1 = 0 AND q0 <> 0) THEN s1 - s0 ELSE 0 END AS new_config,
  CASE WHEN q1 = 0 AND q0 <> 0 THEN s1 - s0 ELSE 0 END AS discontinued`
    : `ref_${k} AS ref_price,
  (q1 - q0) * ref_0 AS volume,
  ${mixes.join(",\n  ")},
  CASE WHEN match_level = ${k} THEN ${rest} ELSE 0 END AS price,
  CASE WHEN match_level < ${k} THEN ${rest} ELSE 0 END AS new_config,
  (q1 - q0) * (ref_${k} - ${survivingRef}) AS discontinued`;

  return `
WITH cells AS MATERIALIZED (
  SELECT ${allColumns.join(", ")},
    round(coalesce(sum(${units}) FILTER (WHERE ${period} = ${prior} AND ${hasUnits}), 0)::DOUBLE, 6) AS q0,
    coalesce(sum(${measure}) FILTER (WHERE ${period} = ${prior} AND ${hasUnits}), 0)::DOUBLE AS s0,
    round(coalesce(sum(${units}) FILTER (WHERE ${period} = ${current} AND ${hasUnits}), 0)::DOUBLE, 6) AS q1,
    coalesce(sum(${measure}) FILTER (WHERE ${period} = ${current} AND ${hasUnits}), 0)::DOUBLE AS s1,
    coalesce(sum(${measure}) FILTER (WHERE ${period} = ${prior} AND NOT ${hasUnits}), 0)::DOUBLE AS z0,
    coalesce(sum(${measure}) FILTER (WHERE ${period} = ${current} AND NOT ${hasUnits}), 0)::DOUBLE AS z1${
      gross
        ? `,
    coalesce(sum(${gross}) FILTER (WHERE ${period} = ${prior} AND ${hasUnits}), 0)::DOUBLE AS g0,
    coalesce(sum(${gross}) FILTER (WHERE ${period} = ${current} AND ${hasUnits}), 0)::DOUBLE AS g1`
        : cost
          ? `,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${prior} AND ${hasUnits}), 0)::DOUBLE AS rs0,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${current} AND ${hasUnits}), 0)::DOUBLE AS rs1`
          : ""
    }
  FROM ${ident(config.table)}
  WHERE ${period} IN (${prior}, ${current})
  GROUP BY ${allColumns.join(", ")}
),
${levelCtes.join(",\n")},
${joinCtes.join(",\n")},
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
SELECT ${allColumns.join(", ")}, q0, s0, q1, s1, z0, z1,${gross ? " g0, g1," : ""}${cost ? " rs0, rs1," : ""} match_level, surviving_level,
  ${Array.from({ length: k + 1 }, (_, j) => `ref_${j}`).join(", ")},
  CASE WHEN q1 = 0 AND q0 <> 0 THEN 'discontinued' WHEN q0 <= 0 THEN 'new' ELSE 'continuing' END AS status,
  ${effects},
  z1 - z0 AS no_units
FROM referenced
)
SELECT *${
    gross
      ? `,
  CASE WHEN ${rated} AND g0 <> 0 AND q0 > 0 AND q1 <> 0 THEN (g1 - q1 * g0 / q0) * (s0 / g0) ELSE 0 END AS price_list,
  price - CASE WHEN ${rated} AND g0 <> 0 AND q0 > 0 AND q1 <> 0 THEN (g1 - q1 * g0 / q0) * (s0 / g0) ELSE 0 END AS price_discount`
      : cost
        ? `,
  CASE WHEN ${rated} AND q0 > 0 THEN rs1 - q1 * rs0 / q0 ELSE 0 END AS price_sales,
  price - CASE WHEN ${rated} AND q0 > 0 THEN rs1 - q1 * rs0 / q0 ELSE 0 END AS cost_rate`
        : ""
  }
FROM priced_effects`;
}

/** What the bridge measures, for labels. */
export function measureName(config: BridgeConfig): "Sales" | "Margin" {
  return config.costColumn ? "Margin" : "Sales";
}

export function effectColumns(config: BridgeConfig): { key: string; label: string }[] {
  return [
    { key: "volume", label: "Volume" },
    ...config.levels.map((level, i) => ({ key: `mix_${i + 1}`, label: `Mix: ${level.name}` })),
    ...(config.costColumn
      ? [
          { key: "price_sales", label: "Price" },
          { key: "cost_rate", label: "Unit cost" },
        ]
      : config.grossColumn
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
  return `Where the full configuration did not match, matched on ${config.levels
    .slice(0, level)
    .map((l) => l.name)
    .join(" + ")}.`;
}

/** Thrown when the prior period has no positive units to bridge from. */
export class NoPriorUnits extends Error {
  constructor(prior: string | number, kind: "allNonPositive" | "netZero" = "allNonPositive") {
    super(
      kind === "netZero"
        ? `Units for prior period '${String(prior).replaceAll("'", "''")}' add up to zero or less.`
        : `Units for prior period '${String(prior).replaceAll("'", "''")}' are all zero or negative.`,
    );
    this.name = "NoPriorUnits";
  }
}

/** Marker comment on the bridge cells table when amounts outgrow exact integers. */
export const HUGE_AMOUNTS = "huge amounts";

/** The name of the main bridge cells table, whose comment carries the huge-amounts marker. */
export const DEFAULT_CELLS_TABLE = "bridge_cells";

/** The data-check sentence for the bridge being shown, when its amounts are too large to add up exactly. */
export async function amountsNote(query: Query, cellsTable: string = DEFAULT_CELLS_TABLE): Promise<string | null> {
  const rows = await query(
    `SELECT comment FROM duckdb_tables() WHERE table_name = '${cellsTable.replaceAll("'", "''")}' AND comment = '${HUGE_AMOUNTS}'`,
  ).catch(() => []);
  return rows.length === 0
    ? null
    : "Some amounts are too large to add up exactly, so the steps may not sum to the change.";
}

export async function runBridge(query: Query, config: BridgeConfig): Promise<BridgeResult> {
  const cellsTable = config.cellsTable ?? DEFAULT_CELLS_TABLE;
  const period = ident(config.periodColumn);

  const [priorTotals] = await query(
    `SELECT coalesce(sum(${ident(config.unitsColumn)}), 0)::DOUBLE AS q0
     FROM ${ident(config.table)} WHERE ${period} = ${literal(config.prior)}`,
  );
  if (!(Number(priorTotals.q0) > 0)) {
    const [positive] = await query(
      `SELECT count(*)::DOUBLE AS n FROM ${ident(config.table)} WHERE ${period} = ${literal(config.prior)} AND ${ident(config.unitsColumn)} > 0`,
    ).catch(() => [{ n: 0 }]);
    if (Number(positive?.n) > 0) {
      throw new NoPriorUnits(config.prior, "netZero");
    }
    throw new NoPriorUnits(config.prior);
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

  const effects = columns.map((c) => ({ ...c, value: Number(totals[c.key]) }));
  if ([Number(totals.s0), currentSales, ...effects.map((e) => e.value)].some((v) => Math.abs(v) > Number.MAX_SAFE_INTEGER)) {
    await query(`COMMENT ON TABLE ${ident(cellsTable)} IS '${HUGE_AMOUNTS}'`);
  } else {
    await query(`COMMENT ON TABLE ${ident(cellsTable)} IS NULL`).catch(() => {});
  }

  const coverageRows = await query(
    `SELECT match_level, count(*)::DOUBLE AS cells, sum(s1) AS sales
     FROM ${ident(cellsTable)} WHERE q1 <> 0 OR s1 <> 0
     GROUP BY match_level ORDER BY match_level DESC`,
  );

  return {
    priorSales: Number(totals.s0),
    currentSales,
    effects,
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
  /** Keeps groups where any grouping column contains this text, ignoring case. */
  search?: string;
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
  const conditions = filters.map((f) =>
    f.value === null ? `${ident(f.column)} IS NULL` : `CAST(${ident(f.column)} AS VARCHAR) = ${literal(f.value)}`,
  );
  const search = options.search?.trim();
  if (search) {
    conditions.push(
      "(" + options.columns.map((c) => `contains(lower(CAST(${ident(c)} AS VARCHAR)), ${literal(search.toLowerCase())})`).join(" OR ") + ")",
    );
  }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
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

export interface PeriodMoney {
  period: string;
  /** File rows for this period before filters, summed in integer billionths and rounded to whole dollars; NaN if any money value is unreadable. */
  inFile: number;
  /** Rows the filters keep, measured by the same rule. */
  afterFilters: number;
}

/** The two chosen periods, measured on both sides of the filters. */
export interface TieOut {
  prior: PeriodMoney;
  current: PeriodMoney;
}

/** True when a money column holds a finite number the billionth sum can read. */
function readableSql(column: string): string {
  const value = `CAST(${ident(column)} AS DOUBLE)`;
  return `(isfinite(${value}) AND abs(${value}) < 1e19)`;
}

/** A money column read as DOUBLE and rounded per row to integer billionths of a dollar. Values with more than nine decimals lose precision, and larger values can also lose precision in the DOUBLE multiplication. Blanks, non-finite values and magnitudes at least 1e19 yield NULL. */
function nanosSql(column: string): string {
  return `(CASE WHEN ${readableSql(column)} THEN CAST(ROUND(CAST(${ident(column)} AS DOUBLE) * 1000000000) AS HUGEINT) END)`;
}

/** Sales in integer billionths, or sales minus cost on margin. Each column is rounded to billionths before subtraction; on margin, blanks contribute zero as in measureSql. */
function exactMeasureSql(config: BridgeConfig): string {
  const sales = nanosSql(config.salesColumn);
  if (!config.costColumn) return sales;
  return `(coalesce(${sales}, 0) - coalesce(${nanosSql(config.costColumn)}, 0))`;
}

/** A total in billionths as whole dollars, rounding half away from zero with integer arithmetic, symmetric for negatives. */
const dollarsSql = (n: string) =>
  `(CASE WHEN ${n} >= 0 THEN (${n} + 500000000) // 1000000000 ELSE -((500000000 - (${n})) // 1000000000) END)`;

/**
 * Money per period on both sides of the setup's filters, in whole dollars. The
 * file relation is the same rows as the bridge's table before filtering, with
 * the same period column, so in-file minus after-filters is what the filters
 * removed. Each total is summed as exact integer billionths and rounded once,
 * so it cannot drift with the number of rows or with how the bridge groups them.
 */
export async function periodMoney(
  query: Query,
  config: BridgeConfig,
  file: { table: string; periodColumn: string },
): Promise<TieOut> {
  const measure = exactMeasureSql(config);
  const bad = config.costColumn
    ? `(${ident(config.salesColumn)} IS NOT NULL AND NOT ${readableSql(config.salesColumn)} OR ${ident(config.costColumn)} IS NOT NULL AND NOT ${readableSql(config.costColumn)})`
    : `(${ident(config.salesColumn)} IS NOT NULL AND NOT ${readableSql(config.salesColumn)})`;
  const totals = async (table: string, periodColumn: string) => {
    const period = ident(periodColumn);
    const [row] = await query(
      `WITH summed AS (
         SELECT coalesce(sum(${measure}) FILTER (WHERE ${period} = ${literal(config.prior)}), 0) AS "prior",
                coalesce(sum(${measure}) FILTER (WHERE ${period} = ${literal(config.current)}), 0) AS "current",
                count(*) FILTER (WHERE ${period} = ${literal(config.prior)} AND ${bad}) AS "priorBad",
                count(*) FILTER (WHERE ${period} = ${literal(config.current)} AND ${bad}) AS "currentBad"
         FROM ${ident(table)}
       )
       SELECT ${dollarsSql(`"prior"`)}::DOUBLE AS "prior", ${dollarsSql(`"current"`)}::DOUBLE AS "current",
              "priorBad"::DOUBLE AS "priorBad", "currentBad"::DOUBLE AS "currentBad"
       FROM summed`,
    );
    return {
      prior: Number(row.priorBad) > 0 ? NaN : Number(row.prior),
      current: Number(row.currentBad) > 0 ? NaN : Number(row.current),
    };
  };
  const inFile = await totals(file.table, file.periodColumn);
  const afterFilters = await totals(config.table, config.periodColumn);
  return {
    prior: { period: String(config.prior), inFile: inFile.prior, afterFilters: afterFilters.prior },
    current: { period: String(config.current), inFile: inFile.current, afterFilters: afterFilters.current },
  };
}

export interface TieOutLine {
  label: string;
  /** Whole dollars. In file - Excluded = In the bridge, exactly. */
  value: number;
}

/** The integer `whole()` in src/app/format.ts shows for a value: rounded half away from zero, keeping -0 and NaN. */
export function wholeDollars(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * The money tie-out, three lines per period: what the file holds, what the
 * filters removed, and what the bridge shows. File and filtered rows are
 * measured in integer billionths on their own relations; the bridge line uses
 * the bridge's rounded DOUBLE total. The displayed file line adds the difference
 * of the two measured whole-dollar totals to the bridge line. For finite totals
 * within safe integer range, the lines foot; with no filter the file line shows
 * the bridge's digits. It can differ from the independently rounded file sum.
 */
export function tieOutLines(config: BridgeConfig, tieOut: TieOut, result: BridgeResult): TieOutLine[] {
  const measure = measureName(config);
  const lines = (money: PeriodMoney, bridgeTotal: number): TieOutLine[] => {
    const inBridge = wholeDollars(bridgeTotal);
    const excluded = money.inFile - money.afterFilters;
    return [
      // Adding zero to -0 would show 0 where the Results KPI shows -0.
      { label: `${measure} in file, ${money.period}`, value: excluded === 0 ? inBridge : inBridge + excluded },
      { label: `Excluded by filters, ${money.period}`, value: excluded },
      { label: `${measure} in the bridge, ${money.period}`, value: inBridge },
    ];
  };
  return [...lines(tieOut.prior, result.priorSales), ...lines(tieOut.current, result.currentSales)];
}

export interface PriceBucket {
  label: string;
  cells: number;
  sales: number;
  share: number;
  priceEffect: number;
}

/**
 * Band edges in percent, low to high. A change that rounds to an edge belongs
 * to the band nearer no change, so +10.0% reads as "Up 5% to 10%" and -10.0%
 * as "Down 5% to 10%". Negative edges compare strictly and positive ones
 * inclusively, which is what makes each edge land on its near-zero side.
 */
const PRICE_BUCKETS: [number, string][] = [
  [-10, "Down more than 10%"],
  [-5, "Down 5% to 10%"],
  [-2, "Down 2% to 5%"],
  [-0.5, "Down 0.5% to 2%"],
  [0.5, "No change (within 0.5%)"],
  [2, "Up 0.5% to 2%"],
  [5, "Up 2% to 5%"],
  [10, "Up 5% to 10%"],
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
  // The comparison runs on the percentage rounded to six decimals. That snaps
  // the division's error off a bound, so 11.00 over 10.00 is +10.0% and files
  // under "Up 5% to 10%". Six decimals is far finer than the closest two
  // changes two-decimal prices up to 10,000 can hold (0.0001 of a percent), so
  // a change that is not a bound cannot move.
  const percent = `round((${change}) * 100, 6)`;
  const bucket =
    "CASE " +
    PRICE_BUCKETS.slice(0, -1)
      .map(([limit], i) => `WHEN ${percent} ${limit < 0 ? "<" : "<="} ${limit} THEN ${i}`)
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
      price: sum((key) => key.startsWith("price") || key === "cost_rate"),
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
  /** The unit cost part of the rate effect. Absent on a sales bridge. */
  unitCost?: number;
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
    let result: BridgeResult;
    try {
      result = await runBridge(query, {
        ...config,
        prior: periods[i - 1],
        current: periods[i],
        cellsTable: "bridge_trend",
      });
    } catch {
      // A period with no units has nothing to bridge from; leave that step out.
      continue;
    }
    const sum = (match: (key: string) => boolean) =>
      result.effects.filter((e) => match(e.key)).reduce((total, e) => total + e.value, 0);
    const unitCost = sum((key) => key === "cost_rate");
    steps.push({
      prior: String(periods[i - 1]),
      current: String(periods[i]),
      priorSales: result.priorSales,
      currentSales: result.currentSales,
      volume: sum((key) => key === "volume"),
      mix: sum((key) => key.startsWith("mix_")),
      price: sum((key) => key.startsWith("price")),
      ...(config.costColumn ? { unitCost } : {}),
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

export type AccountStatus = "new" | "lost" | "growing" | "shrinking";

export interface AccountGroup {
  status: AccountStatus;
  count: number;
  prior: number;
  current: number;
  change: number;
  /** Largest accounts in the group by size of change. */
  top: { name: string | null; prior: number; current: number; change: number }[];
}

/**
 * Splits the change by account: new, lost, growing and shrinking. The column
 * can be any column of the source table (customer, region, sales rep), not
 * only an attribute of the bridge.
 */
export async function accountBridge(
  query: Query,
  config: BridgeConfig,
  column: string,
  top = 15,
): Promise<AccountGroup[]> {
  const period = ident(config.periodColumn);
  const measure = measureSql(config);
  const accounts = `
    SELECT *, CASE
        WHEN s0 = 0 AND s1 <> 0 THEN 'new'
        WHEN s1 = 0 AND s0 <> 0 THEN 'lost'
        WHEN s1 >= s0 THEN 'growing'
        ELSE 'shrinking' END AS status
    FROM (
      SELECT CAST(${ident(column)} AS VARCHAR) AS name,
        coalesce(sum(${measure}) FILTER (WHERE ${period} = ${literal(config.prior)}), 0)::DOUBLE AS s0,
        coalesce(sum(${measure}) FILTER (WHERE ${period} = ${literal(config.current)}), 0)::DOUBLE AS s1
      FROM ${ident(config.table)}
      WHERE ${period} IN (${literal(config.prior)}, ${literal(config.current)})
      GROUP BY 1
    )
    WHERE s0 <> 0 OR s1 <> 0`;
  const totals = await query(
    `SELECT status, count(*)::DOUBLE AS n, sum(s0) AS s0, sum(s1) AS s1 FROM (${accounts}) GROUP BY status`,
  );
  const leaders = await query(
    `SELECT status, name, s0, s1 FROM (
       SELECT *, row_number() OVER (PARTITION BY status ORDER BY abs(s1 - s0) DESC, name ASC) AS position FROM (${accounts})
     ) WHERE position <= ${Math.floor(top)} ORDER BY status, position`,
  );
  return (["new", "lost", "growing", "shrinking"] as const).map((status) => {
    const row = totals.find((t) => t.status === status);
    const prior = Number(row?.s0 ?? 0);
    const current = Number(row?.s1 ?? 0);
    return {
      status,
      count: Number(row?.n ?? 0),
      prior,
      current,
      change: current - prior,
      top: leaders
        .filter((l) => l.status === status)
        .map((l) => ({
          name: l.name === null ? null : String(l.name),
          prior: Number(l.s0),
          current: Number(l.s1),
          change: Number(l.s1) - Number(l.s0),
        })),
    };
  });
}

export type PanelStatus = "continuing" | "new" | "lost" | "no_units";

interface PanelFigures {
  /**
   * The panel's own bridge, or null when its value has nothing to bridge.
   * The table a panel's `result.cellsTable` names is normally dropped before
   * the call returns, so callers must not rely on it existing.
   */
  result: BridgeResult | null;
  status: PanelStatus;
  priorSales: number;
  currentSales: number;
  change: number;
}

/** A single value, or the one combined remainder. `values` is a count. */
export type BridgePanel =
  | (PanelFigures & { combined: false; value: string | null; values: 1 })
  | (PanelFigures & { combined: true; value: null; values: number });

export interface BridgeBy {
  /** The column the panels split on. */
  column: string;
  /** The ordinary bridge over every row of the table. */
  total: BridgeResult;
  /** The value bridges, largest absolute change first, with the combined panel last. */
  panels: BridgePanel[];
  /**
   * One entry per effect of `total`, same key, label and order: the main
   * bridge's figure minus the sum of that effect over the panels that have a
   * bridge. Its sum is zero only when every panel has a bridge; otherwise it
   * sums to the change of the panels whose `result` is null.
   */
  between: Effect[];
}

/** Units and sales of one value, or of the values a combined panel pools. */
interface PanelPool {
  priorUnits: number;
  currentUnits: number;
  priorSales: number;
  currentSales: number;
}

/** One value's units and sales, from the census. */
interface PanelRow extends PanelPool {
  value: string | null;
}

/** One panel's rows and its filter, decided before any panel bridge runs. */
type PanelPlan = PanelPool &
  (
    | { combined: false; value: string | null; values: 1; where: string }
    | { combined: true; value: null; values: number; where: string }
  );

/** One temporary object this call created, and how to drop it. */
interface Helper {
  type: "VIEW" | "TABLE";
  name: string;
}

let helperSequence = 0;

/**
 * Random text for one helper name. Uses crypto.randomUUID or
 * crypto.getRandomValues when globalThis.crypto offers them, else Math.random.
 */
function randomText(): string {
  try {
    const crypto = (globalThis as unknown as { crypto?: Crypto }).crypto;
    if (crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replaceAll("-", "").slice(0, 8).toLowerCase();
    }
    if (crypto && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      let out = "";
      for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
      return out.slice(0, 8);
    }
  } catch {
    // Fall through to Math.random below.
  }
  return Math.random().toString(36).slice(2, 10);
}

/**
 * A candidate name for one helper object. The counter keeps names from one
 * module apart; the random text makes a repeated counter less likely to meet
 * another module's name.
 */
function helperName(kind: string): string {
  helperSequence += 1;
  return `bridge_by_${kind}_${helperSequence.toString(36)}_${randomText()}`;
}

/**
 * Whether a candidate name is free to claim. It matches no existing table or
 * view in any letter case, and it matches neither the source table nor the
 * main cells table in any letter case. A free name can still be taken before
 * the claim runs.
 */
async function isNameFree(query: Query, config: BridgeConfig, name: string): Promise<boolean> {
  if (name.toLowerCase() === config.table.toLowerCase()) return false;
  const mainCells = config.cellsTable ?? DEFAULT_CELLS_TABLE;
  if (name.toLowerCase() === mainCells.toLowerCase()) return false;
  const [found] = await query(
    `SELECT count(*)::INTEGER AS n FROM information_schema.tables WHERE lower(table_name) = lower(${literal(name)})`,
  );
  return Number(found.n) === 0;
}

/** Whether a plain creation failed because the name was already taken. */
function isTaken(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
}

/** The column's text form, with null and the empty string as one value. */
function collapsedValue(column: string): string {
  const id = ident(column);
  return `CASE WHEN ${id} IS NULL OR CAST(${id} AS VARCHAR) = '' THEN NULL ELSE CAST(${id} AS VARCHAR) END`;
}

/**
 * Per value of the column, the units and the sales of each period. Sales cover
 * every row of the period, rows with no units included, because that is what
 * BridgeResult.priorSales holds.
 */
async function census(query: Query, config: BridgeConfig, column: string): Promise<PanelRow[]> {
  const period = ident(config.periodColumn);
  const prior = literal(config.prior);
  const current = literal(config.current);
  const units = ident(config.unitsColumn);
  const sales = ident(config.salesColumn);
  const cost = config.costColumn ? ident(config.costColumn) : null;
  // The measure cellsSql inlines, so a panel's census figure is the bridge's own.
  const measure = cost ? `(coalesce(${sales}, 0) - coalesce(${cost}, 0))` : sales;
  const rows = await query(
    `SELECT ${collapsedValue(column)} AS value,
       coalesce(sum(${units}) FILTER (WHERE ${period} = ${prior}), 0)::DOUBLE AS prior_units,
       coalesce(sum(${units}) FILTER (WHERE ${period} = ${current}), 0)::DOUBLE AS current_units,
       coalesce(sum(${measure}) FILTER (WHERE ${period} = ${prior}), 0)::DOUBLE AS prior_sales,
       coalesce(sum(${measure}) FILTER (WHERE ${period} = ${current}), 0)::DOUBLE AS current_sales
      FROM ${ident(config.table)}
      WHERE ${period} IN (${prior}, ${current})
      GROUP BY 1`,
  );
  return rows.map((row) => ({
    value: row.value == null ? null : String(row.value),
    priorUnits: Number(row.prior_units),
    currentUnits: Number(row.current_units),
    priorSales: Number(row.prior_sales),
    currentSales: Number(row.current_sales),
  }));
}

/** Largest absolute change first, ties broken on the value's text. */
function byChange(a: PanelRow, b: PanelRow): number {
  const left = Math.abs(a.currentSales - a.priorSales);
  const right = Math.abs(b.currentSales - b.priorSales);
  if (left !== right) return right - left;
  return (a.value ?? "") < (b.value ?? "") ? -1 : 1;
}

function pooled(rows: PanelPool[]): PanelPool {
  const pool: PanelPool = { priorUnits: 0, currentUnits: 0, priorSales: 0, currentSales: 0 };
  for (const row of rows) {
    pool.priorUnits += row.priorUnits;
    pool.currentUnits += row.currentUnits;
    pool.priorSales += row.priorSales;
    pool.currentSales += row.currentSales;
  }
  return pool;
}

/**
 * Rows matching one value, or, for the combined panel, every row outside a set
 * of values. The null bucket is IS NOT DISTINCT FROM NULL, so it holds both the
 * column's nulls and its empty strings.
 */
function panelWhere(column: string, values: (string | null)[], combined: boolean): string {
  const collapsed = collapsedValue(column);
  const matched = values.map((value) => `${collapsed} IS NOT DISTINCT FROM ${value === null ? "NULL" : literal(value)}`);
  return combined ? `NOT (${matched.join(" OR ")})` : matched.join(" OR ");
}

/**
 * Pooled prior units decide whether a value has a bridge at all. A value whose
 * prior period was empty but that now sells is new, and a value that only ever
 * sold zero-unit rows has no units to bridge either way.
 */
function panelStatus(pool: PanelPool): PanelStatus {
  if (!(pool.priorUnits > 0)) {
    return pool.currentUnits > 0 && pool.priorSales === 0 ? "new" : "no_units";
  }
  return pool.currentUnits > 0 || pool.currentSales !== 0 ? "continuing" : "lost";
}

/**
 * What the panels leave of each effect of the main bridge: the main bridge's
 * figure minus the sum of that effect over the panels that have a bridge. A
 * panel with no result adds nothing, so the entries sum to zero only when every
 * panel has a bridge; otherwise they sum to the change of the resultless
 * panels. No effect figure is altered to force zero.
 */
function betweenEffects(total: BridgeResult, panels: BridgePanel[]): Effect[] {
  return total.effects.map((effect) => ({
    ...effect,
    value:
      effect.value -
      panels.reduce((sum, panel) => {
        const own = panel.result?.effects.find((e) => e.key === effect.key);
        return sum + (own?.value ?? 0);
      }, 0),
  }));
}

/**
 * The same bridge for every value of one column of the source table, plus the
 * main bridge those values split. Each panel is an ordinary bridge over that
 * value's rows alone, so what the panels leave of the main bridge's effects is
 * the mix between the values. The column can be any column of the table, not
 * only an attribute of the bridge.
 */
export async function bridgeBy(
  query: Query,
  config: BridgeConfig,
  column: string,
  limit = 12,
): Promise<BridgeBy> {
  const count = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const total = await runBridge(query, config);
  const rows = (await census(query, config, column)).sort(byChange);
  const leaders = rows.slice(0, count);
  const rest = rows.slice(count);
  const plans: PanelPlan[] = leaders.map((row) => ({
    ...row,
    where: panelWhere(column, [row.value], false),
    combined: false,
    values: 1,
  }));
  if (rest.length > 0) {
    // The combined panel holds the values the single panels leave out.
    plans.push({
      ...pooled(rest),
      where: panelWhere(column, leaders.map((row) => row.value), true),
      combined: true,
      value: null,
      values: rest.length,
    });
  }
  // Each panel bridges a view of its own rows into a cells table of its own.
  // The main cells table is written by the main bridge above and never
  // written, replaced or dropped again. A helper name is this call's own only
  // once a plain creation for it has succeeded; only such names are tracked for cleanup.
  const created: Helper[] = [];
  try {
    const panels: BridgePanel[] = [];
    for (const plan of plans) {
      let result: BridgeResult | null = null;
      if (plan.priorUnits > 0) {
        // The plain view creation is the claim. A taken name is retried and
        // the object in the way is never dropped.
        let view: string | null = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = helperName("panel");
          if (!(await isNameFree(query, config, candidate))) continue;
          try {
            await query(
              `CREATE TEMP VIEW ${ident(candidate)} AS SELECT * FROM ${ident(config.table)} WHERE ${plan.where}`,
            );
            view = candidate;
            created.push({ type: "VIEW", name: view });
            break;
          } catch (error) {
            if (isTaken(error)) continue;
            throw error;
          }
        }
        if (view === null) throw new Error("Could not find an unused name for a temporary object");
        // The plain table creation is the claim; runBridge then replaces this
        // call's own table. A taken name is retried without dropping the other object.
        let cells: string | null = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = helperName("cells");
          if (!(await isNameFree(query, config, candidate))) continue;
          try {
            await query(`CREATE TEMP TABLE temp.${ident(candidate)} ("claim" INTEGER)`);
            cells = candidate;
            created.push({ type: "TABLE", name: cells });
            break;
          } catch (error) {
            if (isTaken(error)) continue;
            throw error;
          }
        }
        if (cells === null) throw new Error("Could not find an unused name for a temporary object");
        try {
          result = await runBridge(query, { ...config, table: view, cellsTable: cells });
        } catch (error) {
          // The census has already decided this panel has prior units.
          if (!(error instanceof NoPriorUnits)) throw error;
        }
      }
      const status = panelStatus(plan);
      const figures: PanelFigures = result
        ? {
            result,
            status,
            priorSales: result.priorSales,
            currentSales: result.currentSales,
            change: result.currentSales - result.priorSales,
          }
        : {
            result: null,
            status,
            priorSales: plan.priorSales,
            currentSales: plan.currentSales,
            change: plan.currentSales - plan.priorSales,
          };
      panels.push(
        plan.combined
          ? { ...figures, combined: true, value: null, values: plan.values }
          : { ...figures, combined: false, value: plan.value, values: 1 },
      );
    }
    return { column, total, panels, between: betweenEffects(total, panels) };
  } finally {
    // Drop only names this call claimed, in reverse order, each in its own
    // try; a failed drop is tried once more, and no drop error replaces the
    // body's error or result. A helper whose drop fails twice stays until the
    // session ends, and a permanent table another statement creates under a
    // helper name after the claim is outside what the call can prevent.
    const failed: Helper[] = [];
    for (const helper of [...created].reverse()) {
      try {
        await query(`DROP ${helper.type} IF EXISTS temp.${ident(helper.name)}`);
      } catch {
        failed.push(helper);
      }
    }
    for (const helper of failed) {
      try {
        await query(`DROP ${helper.type} IF EXISTS temp.${ident(helper.name)}`);
      } catch {
        // The body's error or the call's result stands.
      }
    }
  }
}
