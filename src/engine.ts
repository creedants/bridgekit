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
 *   price    = s1 - R_k * q1                   cells matched at the full key
 *   new      = s1 - R_k * q1                   cells with no full-key match
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
  /** 0 = matched only at the total, levels.length = matched at the full key. */
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
function cumulativeColumns(levels: Level[], j: number): string[] {
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

  const windows: string[] = [];
  const groupPrices: string[] = [];
  for (let j = 1; j <= k; j++) {
    const partition = cumulativeColumns(config.levels, j).map(ident).join(", ");
    windows.push(`sum(q0) OVER (PARTITION BY ${partition}) AS q0_l${j}`);
    windows.push(`sum(s0) OVER (PARTITION BY ${partition}) AS s0_l${j}`);
    groupPrices.push(`CASE WHEN q0_l${j} > 0 THEN s0_l${j} / q0_l${j} END AS p0_l${j}`);
  }

  // R_j = coalesce(p0_lj, ..., p0_l1, r0)
  const refs: string[] = ["r0 AS ref_0"];
  for (let j = 1; j <= k; j++) {
    const chain = Array.from({ length: j }, (_, i) => `p0_l${j - i}`).join(", ");
    refs.push(`coalesce(${chain}, r0) AS ref_${j}`);
  }
  const matchLevel =
    "CASE " +
    Array.from({ length: k }, (_, i) => `WHEN p0_l${k - i} IS NOT NULL THEN ${k - i}`).join(" ") +
    " ELSE 0 END";

  const mixes = Array.from(
    { length: k },
    (_, i) => `(q1 - q0) * (ref_${i + 1} - ref_${i}) AS mix_${i + 1}`,
  );

  return `
WITH cells AS (
  SELECT ${allColumns.join(", ")},
    coalesce(sum(${units}) FILTER (WHERE ${period} = ${prior}), 0)::DOUBLE AS q0,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${prior}), 0)::DOUBLE AS s0,
    coalesce(sum(${units}) FILTER (WHERE ${period} = ${current}), 0)::DOUBLE AS q1,
    coalesce(sum(${sales}) FILTER (WHERE ${period} = ${current}), 0)::DOUBLE AS s1
  FROM ${ident(config.table)}
  WHERE ${period} IN (${prior}, ${current})
  GROUP BY ${allColumns.join(", ")}
),
windowed AS (
  SELECT *,
    sum(s0) OVER () / sum(q0) OVER () AS r0,
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
    ${refs.join(",\n    ")}
  FROM priced
)
SELECT ${allColumns.join(", ")}, q0, s0, q1, s1, match_level,
  ref_${k} AS ref_price,
  (q1 - q0) * ref_0 AS volume,
  ${mixes.join(",\n  ")},
  CASE WHEN match_level = ${k} THEN s1 - ref_${k} * q1 ELSE 0 END AS price,
  CASE WHEN match_level < ${k} THEN s1 - ref_${k} * q1 ELSE 0 END AS new_config
FROM referenced`;
}

function effectColumns(config: BridgeConfig): { key: string; label: string }[] {
  return [
    { key: "volume", label: "Volume" },
    ...config.levels.map((level, i) => ({ key: `mix_${i + 1}`, label: `Mix: ${level.name}` })),
    { key: "price", label: "Price (like-for-like)" },
    { key: "new_config", label: "New configurations" },
  ];
}

function coverageLabel(config: BridgeConfig, level: number): string {
  if (level === config.levels.length) return "Exact configuration";
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
    `SELECT sum(s0) AS s0, sum(s1) AS s1, ${columns
      .map((c) => `sum(${c.key}) AS ${c.key}`)
      .join(", ")}
     FROM ${ident(cellsTable)}`,
  );
  const currentSales = Number(totals.s1);

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
        share: currentSales === 0 ? 0 : sales / currentSales,
      };
    }),
    cellsTable,
  };
}

/** Effects summed by any subset of the level columns, largest movers first. */
export async function drill(
  query: Query,
  config: BridgeConfig,
  columns: string[],
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const known = new Set(cumulativeColumns(config.levels, config.levels.length));
  for (const column of columns) {
    if (!known.has(column)) throw new Error(`"${column}" is not a level column`);
  }
  const keys = columns.map(ident).join(", ");
  const effects = effectColumns(config).map((c) => c.key);
  return query(
    `SELECT ${keys}, sum(s0) AS s0, sum(s1) AS s1, ${effects
      .map((e) => `sum(${e}) AS ${e}`)
      .join(", ")}
     FROM ${ident(config.cellsTable ?? DEFAULT_CELLS_TABLE)}
     GROUP BY ${keys}
     ORDER BY abs(sum(${effects.join(" + ")})) DESC
     LIMIT ${Math.floor(limit)}`,
  );
}
