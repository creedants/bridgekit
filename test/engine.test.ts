import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import { runBridge, drill, unmatched, dataCheck, priceDistribution, type BridgeConfig, type BridgeResult } from "../src/engine.ts";
import { createSyntheticSales } from "../src/synth.ts";

function effect(result: BridgeResult, key: string): number {
  const found = result.effects.find((e) => e.key === key);
  assert.ok(found, `missing effect ${key}`);
  return found.value;
}

function total(result: BridgeResult): number {
  return result.effects.reduce((sum, e) => sum + e.value, 0);
}

function near(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} expected ${expected}, got ${actual}`);
}

test("single attribute matches the hand-worked classic bridge", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'A', 10, 100.0), ('p0', 'B', 10, 200.0),
    ('p1', 'A', 10, 110.0), ('p1', 'B', 20, 400.0), ('p1', 'C', 5, 150.0)
  ) v(period, product, units, sales)`);
  const result = await runBridge(query, {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  });

  // Prior average price 15. Volume (35-20)*15. Mix A (10-10)*(10-15) + B (20-10)*(20-15).
  // Price A 110-100. New C 150 - 5*15.
  near(effect(result, "volume"), 225);
  near(effect(result, "mix_1"), 50);
  near(effect(result, "price"), 10);
  near(effect(result, "new_config"), 75);
  near(total(result), result.currentSales - result.priorSales);
  assert.equal(result.priorSales, 300);
  assert.equal(result.currentSales, 660);
});

test("an unmatched configuration falls back to its parent group's prior price", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'D1', 'basic', 10, 100.0), ('p0', 'D1', 'premium', 10, 300.0),
    ('p0', 'D2', 'basic', 20, 400.0),
    ('p1', 'D1', 'basic', 10, 100.0), ('p1', 'D1', 'premium', 10, 300.0),
    ('p1', 'D2', 'basic', 20, 400.0), ('p1', 'D2', 'premium', 4, 200.0)
  ) v(period, design, coating, units, sales)`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Design", columns: ["design"] }, { name: "Coating", columns: ["coating"] }],
  };
  const result = await runBridge(query, config);

  // D2/premium is new; D2 sold at 20 last year, so it is valued at 4*20 = 80
  // and the remaining 120 is the new-configuration effect. Nothing repriced.
  near(effect(result, "price"), 0);
  near(effect(result, "new_config"), 120);
  near(total(result), 200);

  const [row] = await query(
    `SELECT match_level, ref_price FROM ${result.cellsTable} WHERE design = 'D2' AND coating = 'premium'`,
  );
  assert.equal(Number(row.match_level), 1);
  near(Number(row.ref_price), 20);

  const [missing] = await unmatched(query, config);
  assert.equal(missing.coating, "premium");
  near(Number(missing.new_config), 120);

  const filtered = await drill(query, config, {
    columns: ["coating"], filters: [{ column: "design", value: "D2" }], sortBy: "new_config",
  });
  assert.deepEqual(filtered.map((row) => row.coating), ["premium", "basic"]);

  const check = await dataCheck(query, config);
  assert.equal(check.rows, 7);
  assert.equal(check.priorRows, 3);
  assert.equal(check.currentRows, 4);
  assert.equal(check.negativeUnitRows, 0);

  const fallback = result.coverage.find((c) => c.level === 1);
  assert.ok(fallback);
  near(fallback.share, 200 / 1000);
  assert.equal(fallback.label, "Fell back to Design");
});

test("multi-column levels and null attribute values reconcile", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'D1', 'grey', true, 5, 500.0), ('p0', 'D1', NULL, false, 10, 600.0),
    ('p1', 'D1', 'grey', true, 6, 660.0), ('p1', 'D1', NULL, false, 8, 520.0),
    ('p1', 'D1', 'grey', false, 2, 150.0)
  ) v(period, design, photochromic, polar, units, sales)`);
  const result = await runBridge(query, {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [
      { name: "Design", columns: ["design"] },
      { name: "Color", columns: ["photochromic", "polar"] },
    ],
  });

  near(total(result), 1330 - 1100);
  // grey/polar 660 - 6*100, null/non-polar 520 - 8*60: the null group matched itself.
  near(effect(result, "price"), 60 + 40);
  assert.equal(result.coverage.find((c) => c.level === 2)?.cells, 2);
});

test("synthetic lens data reconciles, and level order does not move volume or price", async () => {
  const query = await openDatabase();
  await createSyntheticSales(query, 200_000);
  const base = {
    table: "sales", periodColumn: "year", prior: 2025, current: 2026,
    unitsColumn: "jobs", salesColumn: "sales",
  };
  const levels = [
    { name: "Design", columns: ["design"] },
    { name: "Coating", columns: ["coating"] },
    { name: "Color", columns: ["photochromic", "polar"] },
    { name: "Material", columns: ["material"] },
  ];
  const forward = await runBridge(query, { ...base, levels });
  const reversed = await runBridge(query, { ...base, levels: levels.toReversed(), cellsTable: "reversed" });

  const delta = forward.currentSales - forward.priorSales;
  assert.ok(Math.abs(total(forward) - delta) < 1e-6 * Math.abs(delta));
  assert.ok(Math.abs(total(reversed) - delta) < 1e-6 * Math.abs(delta));
  assert.ok(Math.abs(effect(forward, "volume") - effect(reversed, "volume")) < 1e-3);
  assert.ok(Math.abs(effect(forward, "price") - effect(reversed, "price")) < 1e-3);

  const shares = forward.coverage.reduce((sum, c) => sum + c.share, 0);
  near(shares, 1);

  const byDesign = await drill(query, { ...base, levels }, { columns: ["design"], limit: 1000 });
  const drilled = byDesign.reduce(
    (sum, row) =>
      sum + ["volume", "mix_1", "mix_2", "mix_3", "mix_4", "price", "new_config", "discontinued"]
        .reduce((s, key) => s + Number(row[key]), 0),
    0,
  );
  assert.ok(Math.abs(drilled - delta) < 1e-6 * Math.abs(delta));

  // Each group's effects equal that group's own sales change.
  for (const row of byDesign) {
    const own = ["volume", "mix_1", "mix_2", "mix_3", "mix_4", "price", "new_config", "discontinued"]
      .reduce((s, key) => s + Number(row[key]), 0);
    assert.ok(Math.abs(own - (Number(row.s1) - Number(row.s0))) < 1e-3, `design ${row.design}`);
  }
});

test("returns that net prior units below zero still reconcile per configuration", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'A', 10, 100.0), ('p0', 'B', -2, -50.0), ('p0', 'C', 0, -30.0),
    ('p1', 'A', 12, 132.0), ('p1', 'B', 3, 90.0), ('p1', 'C', 1, 20.0)
  ) v(period, product, units, sales)`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  const result = await runBridge(query, config);
  near(total(result), 242 - 20);
  // C's prior credit of -30 has no units, so it is bridged on its own line.
  near(effect(result, "no_units"), 30);
  assert.equal(result.priorSales, 20);
  for (const row of await drill(query, config, { columns: ["product"] })) {
    const own = Number(row.volume) + Number(row.mix_1) + Number(row.price) + Number(row.new_config) + Number(row.discontinued) + Number(row.no_units);
    near(own, Number(row.s1) + Number(row.z1) - Number(row.s0) - Number(row.z0), `product ${row.product}`);
  }
});

test("discontinued configurations mirror new ones", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'D1', 'basic', 10, 100.0), ('p0', 'D1', 'premium', 10, 300.0),
    ('p0', 'D2', 'basic', 20, 400.0), ('p0', 'D3', 'basic', 10, 400.0),
    ('p1', 'D1', 'basic', 10, 100.0), ('p1', 'D2', 'basic', 20, 400.0)
  ) v(period, design, coating, units, sales)`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Design", columns: ["design"] }, { name: "Coating", columns: ["coating"] }],
  };
  const result = await runBridge(query, config);

  // Prior average price 1200 / 50 = 24. Volume (30 - 50) * 24.
  near(effect(result, "volume"), -480);
  // D1/premium: D1 survives, so design mix is -10 * (20 - 24) and the premium
  // over D1, -10 * (30 - 20), is discontinued. D3 is gone entirely, so all of
  // -10 * (40 - 24) is discontinued.
  near(effect(result, "mix_1"), 40);
  near(effect(result, "mix_2"), 0);
  near(effect(result, "discontinued"), -100 - 160);
  near(effect(result, "price"), 0);
  near(total(result), 500 - 1200);
});

test("full mode shows new and discontinued at full sales, outside volume and mix", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'A', 10, 100.0), ('p0', 'B', 10, 200.0), ('p0', 'D', 5, 400.0),
    ('p1', 'A', 10, 110.0), ('p1', 'B', 20, 400.0), ('p1', 'C', 5, 150.0)
  ) v(period, product, units, sales)`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
    newAndDiscontinued: "full",
  };
  const result = await runBridge(query, config);

  // Continuing A and B: prior average 300 / 20 = 15.
  near(effect(result, "volume"), (30 - 20) * 15);
  near(effect(result, "mix_1"), 10 * (20 - 15));
  near(effect(result, "price"), 10);
  near(effect(result, "new_config"), 150);
  near(effect(result, "discontinued"), -400);
  near(total(result), 660 - 700);
  for (const row of await drill(query, config, { columns: ["product"] })) {
    const own = ["volume", "mix_1", "price", "new_config", "discontinued", "no_units"]
      .reduce((s, key) => s + Number(row[key]), 0);
    near(own, Number(row.s1) - Number(row.s0), `product ${row.product}`);
  }
});

test("a gross column splits price into list price and discounts", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'A', 10, 1000.0, 900.0), ('p0', 'B', 10, 500.0, 500.0),
    ('p1', 'A', 10, 1100.0, 935.0), ('p1', 'B', 10, 500.0, 500.0)
  ) v(period, product, units, gross, net)`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "net", grossColumn: "gross",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  const result = await runBridge(query, config);

  // A: list price 100 -> 110 at the prior 90% net rate, then the rate falls to 85%.
  near(effect(result, "price_list"), 10 * (110 - 100) * 0.9);
  near(effect(result, "price_discount"), 10 * 110 * (0.85 - 0.9));
  near(total(result), 35);
  assert.equal(result.effects.some((e) => e.key === "price"), false);

  const [row] = await drill(query, config, { columns: ["product"], sortBy: "price" });
  near(Number(row.price), 35);

  const distribution = await priceDistribution(query, config);
  const up = distribution.buckets.find((b) => b.label === "Up 2% to 5%");
  assert.equal(up?.cells, 1);
  near(up!.share, 935 / 1435);
  near(distribution.averageChange, 35 / 1400);
});

test("rejects a missing prior period and duplicate columns", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT 'p1' AS period, 'A' AS product, 1 AS units, 1.0 AS sales`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  await assert.rejects(runBridge(query, config), /No units found for prior period/);
  await assert.rejects(
    runBridge(query, { ...config, prior: "p1", levels: [...config.levels, ...config.levels] }),
    /more than one level/,
  );
});
