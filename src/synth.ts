import type { Query } from "./engine.ts";

/**
 * Made-up prescription-lens sales in the shape of a real export: one row per
 * job, add-ons folded into the line price, no stable SKU. 2026 differs from
 * 2025 by a price increase on the top designs, five new designs, one retired
 * coating and a shift toward photochromic lenses.
 */
export async function createSyntheticSales(query: Query, rows: number, table = "sales"): Promise<void> {
  await query("SELECT setseed(0.42)");
  await query(`
CREATE OR REPLACE TABLE "${table}" AS
WITH raw AS (
  SELECT
    CASE WHEN random() < 0.48 THEN 2025 ELSE 2026 END AS year,
    floor(pow(random(), 2.5) * 400)::INT AS cust_i,
    floor(pow(random(), 2.2) * 60)::INT AS design_r,
    floor(pow(random(), 2.0) * 12)::INT AS coat_r,
    floor(pow(random(), 1.8) * 8)::INT AS mat_i,
    random() AS photo_r, random() AS polar_r, random() AS finish_r,
    random() AS noise, random() AS units_r
  FROM range(${Math.floor(rows)})
),
shaped AS (
  SELECT year, cust_i, mat_i, noise,
    CASE WHEN year = 2025 THEN design_r % 55 ELSE design_r END AS design_i,
    CASE WHEN year = 2026 AND coat_r = 11 THEN 10 ELSE coat_r END AS coat_i,
    CASE
      WHEN photo_r < (CASE WHEN year = 2026 THEN 0.20 ELSE 0.12 END) THEN 'grey'
      WHEN photo_r < (CASE WHEN year = 2026 THEN 0.30 ELSE 0.19 END) THEN 'brown'
      ELSE 'none'
    END AS photochromic,
    polar_r < 0.08 AS polar,
    CASE WHEN finish_r < 0.3 THEN 'uncut' ELSE 'edged' END AS finish_type,
    CASE WHEN units_r < 0.1 THEN 2 ELSE 1 END AS jobs
  FROM raw
)
SELECT
  year,
  'C' || lpad(cust_i::VARCHAR, 4, '0') AS customer,
  'D' || lpad(design_i::VARCHAR, 2, '0') AS design,
  'CT' || lpad(coat_i::VARCHAR, 2, '0') AS coating,
  photochromic,
  polar,
  'M' || mat_i::VARCHAR AS material,
  finish_type,
  jobs,
  round(
    jobs
    * (40 + design_i * 2.5)
    * (1 + coat_i * 0.06)
    * (CASE photochromic WHEN 'grey' THEN 1.35 WHEN 'brown' THEN 1.4 ELSE 1 END)
    * (CASE WHEN polar THEN 1.25 ELSE 1 END)
    * (1 + mat_i * 0.08)
    * (CASE finish_type WHEN 'uncut' THEN 0.8 ELSE 1 END)
    * (1 - (cust_i % 7) * 0.03)
    * (0.97 + 0.06 * noise)
    * (CASE WHEN year = 2026 AND design_i < 20 THEN 1.04 ELSE 1 END),
    2
  ) AS sales
FROM shaped`);
}
