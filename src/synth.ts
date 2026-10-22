import type { Setup } from "./app/setup.ts";
import type { Query } from "./engine.ts";

/**
 * Made-up configuration sales in the shape of a real export: one row per unit,
 * add-ons folded into the line price, no stable SKU. 2026 differs from 2025 by a
 * price increase on the top models, five new models, one retired finish and a
 * shift toward color. gross_sales is the price before customer discounts, which
 * deepen slightly for half the customers, and cost rises 3% in 2026.
 *
 * Values come from hashing the row number, so the same row count always
 * produces the same data in Node and in the browser.
 */
export async function createSyntheticSales(query: Query, rows: number, table = "sales"): Promise<void> {
  await query(`
CREATE OR REPLACE TABLE "${table}" AS
WITH raw AS (
  SELECT
    i,
    CASE WHEN ((hash(i * 16 + 1) % 1000000) / 1000000.0) < 0.48 THEN 2025 ELSE 2026 END AS year,
    floor(pow(((hash(i * 16 + 2) % 1000000) / 1000000.0), 2.5) * 400)::INT AS cust_i,
    floor(pow(((hash(i * 16 + 3) % 1000000) / 1000000.0), 2.2) * 60)::INT AS model_r,
    floor(pow(((hash(i * 16 + 4) % 1000000) / 1000000.0), 2.0) * 12)::INT AS finish_r,
    floor(pow(((hash(i * 16 + 5) % 1000000) / 1000000.0), 1.8) * 8)::INT AS material_i,
    ((hash(i * 16 + 6) % 1000000) / 1000000.0) AS color_r, ((hash(i * 16 + 7) % 1000000) / 1000000.0) AS upgrade_r, ((hash(i * 16 + 8) % 1000000) / 1000000.0) AS delivery_r,
    ((hash(i * 16 + 9) % 1000000) / 1000000.0) AS noise, ((hash(i * 16 + 10) % 1000000) / 1000000.0) AS units_r
  FROM range(${Math.floor(rows)}) t(i)
),
shaped AS (
  SELECT i, year, cust_i, material_i, noise,
    CASE WHEN year = 2025 THEN model_r % 55 ELSE model_r END AS model_i,
    CASE WHEN year = 2026 AND finish_r = 11 THEN 10 ELSE finish_r END AS finish_i,
    CASE
      WHEN color_r < (CASE WHEN year = 2026 THEN 0.20 ELSE 0.12 END) THEN 'blue'
      WHEN color_r < (CASE WHEN year = 2026 THEN 0.30 ELSE 0.19 END) THEN 'red'
      ELSE 'none'
    END AS color,
    upgrade_r < 0.08 AS upgrade,
    CASE WHEN delivery_r < 0.3 THEN 'kit' ELSE 'assembled' END AS delivery,
    CASE WHEN units_r < 0.1 THEN 2 ELSE 1 END AS units
  FROM raw
)
SELECT * EXCLUDE (cust_i),
  round(sales / (1 - (cust_i % 7) * 0.03 - CASE WHEN year = 2026 AND cust_i % 2 = 0 THEN 0.01 ELSE 0 END), 2) AS gross_sales
FROM (
SELECT
  cust_i,
  year,
  round(units * (18 + model_i * 1.1) * (1 + material_i * 0.05) * (1 + finish_i * 0.03) * (CASE WHEN year = 2026 THEN 1.03 ELSE 1 END), 2) AS cost,
  make_date(year, 1 + (hash(i * 16 + 11) % 12)::INT, 1 + (hash(i * 16 + 12) % 28)::INT) AS order_date,
  'C' || lpad(cust_i::VARCHAR, 4, '0') AS customer,
  'MD' || lpad(model_i::VARCHAR, 2, '0') AS model,
  'FN' || lpad(finish_i::VARCHAR, 2, '0') AS finish,
  color,
  upgrade,
  'MT' || material_i::VARCHAR AS material,
  delivery,
  units,
  round(
    units
    * (40 + model_i * 2.5)
    * (1 + finish_i * 0.06)
    * (CASE color WHEN 'blue' THEN 1.35 WHEN 'red' THEN 1.4 ELSE 1 END)
    * (CASE WHEN upgrade THEN 1.25 ELSE 1 END)
    * (1 + material_i * 0.08)
    * (CASE delivery WHEN 'kit' THEN 0.8 ELSE 1 END)
    * (1 - (cust_i % 7) * 0.03)
    * (0.97 + 0.06 * noise)
    * (CASE WHEN year = 2026 AND model_i < 20 THEN 1.04 ELSE 1 END),
    2
  ) AS sales
FROM shaped
)`);
}

/** Default row count for the configuration sample. */
export const SAMPLE_ROWS = 1_000_000;
/** The most `?sample=<number>` may ask for. */
export const MAX_SAMPLE_ROWS = 5_000_000;

/**
 * Made-up SKU-level sales in the shape of an ordinary product list: one row per
 * sales line, a stable SKU, a customer, units and sales. 2026 raises prices by
 * 3% on matching SKUs numbered 003 through 020, retires four SKUs and adds two,
 * so the bridge has volume, mix, price, new and discontinued lines.
 *
 * Values come from hashing the row number, so the same row count always
 * produces the same data in Node and in the browser.
 */
export async function createSkuSales(query: Query, rows: number, table = "sales"): Promise<void> {
  await query(`
CREATE OR REPLACE TABLE "${table}" AS
WITH raw AS (
  SELECT
    i,
    CASE WHEN ((hash(i * 16 + 1) % 1000000) / 1000000.0) < 0.5 THEN 2025 ELSE 2026 END AS year,
    floor(pow(((hash(i * 16 + 2) % 1000000) / 1000000.0), 2.0) * 40)::INT AS sku_i,
    floor(pow(((hash(i * 16 + 3) % 1000000) / 1000000.0), 2.5) * 120)::INT AS cust_i,
    ((hash(i * 16 + 4) % 1000000) / 1000000.0) AS units_r
  FROM range(${Math.floor(rows)}) t(i)
),
shaped AS (
  SELECT
    i, year, cust_i,
    CASE WHEN year = 2026 AND sku_i < 2 THEN sku_i + 40 ELSE sku_i END AS sku_i,
    1 + floor(units_r * 4)::INT AS units
  FROM raw
  WHERE NOT (year = 2026 AND sku_i >= 38)
)
SELECT
  year,
  'SKU-' || lpad((sku_i + 1)::VARCHAR, 3, '0') AS sku,
  'C' || lpad(cust_i::VARCHAR, 4, '0') AS customer,
  units,
  round(units * (CASE WHEN year = 2026 AND sku_i < 20 THEN 1.03 ELSE 1 END)
    * (20 + ((hash((sku_i + 1) * 16 + 5) % 1000000) / 1000000.0) * 80), 2) AS sales
FROM shaped`);
}

/**
 * Made-up budget and actual sales by product, with units and sales for each
 * row. Actual units can differ from budget, and a hash selects products for a
 * 2% price rise. The first product is actual only and the last is budget only.
 *
 * The generator starts with at least four products, using floor(rows / 2) when
 * larger. Each period omits one product, so an input of 24 produces 22 rows
 * across twelve products. Values come from hashing the product number, so the
 * same input always produces the same data in Node and in the browser.
 */
export async function createBudgetSales(query: Query, rows: number, table = "sales"): Promise<void> {
  const products = Math.max(4, Math.floor(rows / 2));
  await query(`
CREATE OR REPLACE TABLE "${table}" AS
WITH products AS (
  SELECT i FROM range(${products}) t(i)
),
budget AS (
  SELECT
    i,
    'P' || lpad((i + 1)::VARCHAR, 2, '0') AS product,
    1 + floor(pow(((hash(i * 16 + 1) % 1000000) / 1000000.0), 2.0) * 400)::INT AS units,
    40 + ((hash(i * 16 + 2) % 1000000) / 1000000.0) * 60 AS price
  FROM products
),
actual AS (
  SELECT
    i, product,
    greatest(1, round(units * (0.7 + ((hash(i * 16 + 3) % 1000000) / 1000000.0) * 0.6)))::INT AS units,
    price * (CASE WHEN ((hash(i * 16 + 4) % 1000000) / 1000000.0) < 0.5 THEN 1.02 ELSE 1 END) AS price
  FROM budget
)
SELECT 'Budget' AS period, product, units, round(units * price, 2) AS sales
FROM budget WHERE i <> 0
UNION ALL
SELECT 'Actual' AS period, product, units, round(units * price, 2) AS sales
FROM actual WHERE i <> ${products - 1}`);
}

/** One built-in sample: its data, source label, preset setup and optional period pair. */
export interface Sample {
  readonly name: "config" | "sku" | "budget";
  /** The source label shown in the top bar, the setup description and the Excel export. */
  readonly label: string;
  /** Preset setup, so the sample opens ready to calculate. */
  readonly setup: Setup;
  /**
   * Whether calculating this sample writes its setup to this browser, the way a
   * user file does. False for a demonstration that must not overwrite a setup
   * saved for a file with the same columns.
   */
  readonly savesSetup: boolean;
  /** Prior and current to prefer when the period order would put them the other way round. */
  readonly periods?: { readonly prior: string; readonly current: string };
  /** Row count used when the URL does not name one. */
  readonly rows: number;
  readonly create: (query: Query, rows: number, table: string) => Promise<void>;
}

const CONFIG_SAMPLE: Sample = {
  name: "config",
  label: "Sample data (made-up configuration sales)",
  setup: {
    periodColumn: "year",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [
      { name: "Model", columns: ["model"] },
      { name: "Finish", columns: ["finish"] },
      { name: "Color", columns: ["color", "upgrade"] },
      { name: "Material", columns: ["material"] },
    ],
    filters: [],
  },
  rows: SAMPLE_ROWS,
  savesSetup: true,
  create: createSyntheticSales,
};

const SKU_SAMPLE: Sample = {
  name: "sku",
  label: "Sample data (made-up product sales)",
  setup: {
    periodColumn: "year",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "SKU", columns: ["sku"] }],
    filters: [],
  },
  rows: 250_000,
  savesSetup: false,
  create: createSkuSales,
};

const BUDGET_SAMPLE: Sample = {
  name: "budget",
  label: "Sample data (made-up budget and actual sales)",
  setup: {
    periodColumn: "period",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
    filters: [],
  },
  // Code-point order puts Actual first, so the pair has to be named.
  periods: { prior: "Budget", current: "Actual" },
  rows: 24,
  savesSetup: false,
  create: createBudgetSales,
};

const SAMPLES = new Map<string, Sample>([
  [CONFIG_SAMPLE.name, CONFIG_SAMPLE],
  [SKU_SAMPLE.name, SKU_SAMPLE],
  [BUDGET_SAMPLE.name, BUDGET_SAMPLE],
]);

/**
 * `?sample` to a sample and the row count to generate. A number of 1000 or more
 * keeps its meaning: the configuration sample at that many rows, capped. A named
 * sample loads at its own size. Anything else, including no value, is the
 * configuration sample at its default row count.
 */
export function resolveSample(param: string | null): { sample: Sample; rows: number } {
  const requested = Number(param);
  if (requested >= 1000) return { sample: CONFIG_SAMPLE, rows: Math.min(Math.floor(requested), MAX_SAMPLE_ROWS) };
  const named = param === null ? undefined : SAMPLES.get(param);
  return named ? { sample: named, rows: named.rows } : { sample: CONFIG_SAMPLE, rows: CONFIG_SAMPLE.rows };
}
