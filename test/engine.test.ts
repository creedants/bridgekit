import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import { runBridge, drill, unmatched, dataCheck, priceDistribution, sensitivity, trend, priceRealization, priceGaps, accountBridge, periodMoney, tieOutLines, type BridgeConfig, type BridgeResult, type Level } from "../src/engine.ts";
import { PERIOD, VIEW, quote, viewSql, type Setup } from "../src/app/setup.ts";
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
  const searched = await drill(query, config, { columns: ["design", "coating"], search: "PREM" });
  assert.deepEqual(searched.map((row) => `${row.design}/${row.coating}`).sort(), ["D1/premium", "D2/premium"]);

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

  // Leaving out the color attribute lets the photochromic shift leak into price.
  const alternatives = await sensitivity(query, { ...base, levels });
  assert.deepEqual(alternatives.map((a) => a.label), ["Your setup", "Without Design", "Without Coating", "Without Color", "Without Material"]);
  near(alternatives[0].price, effect(forward, "price"));
  assert.ok(alternatives[3].price > alternatives[0].price * 1.5);
  assert.ok(alternatives[3].exactShare > alternatives[0].exactShare);

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

test("trend bridges each pair of consecutive periods", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('q1', 'A', 10, 100.0), ('q2', 'A', 10, 110.0), ('q3', 'A', 20, 240.0)
  ) v(period, product, units, sales)`);
  const steps = await trend(
    query,
    { table: "t", periodColumn: "period", prior: "q1", current: "q2", unitsColumn: "units", salesColumn: "sales",
      levels: [{ name: "Product", columns: ["product"] }] },
    ["q1", "q2", "q3"],
  );
  assert.deepEqual(steps.map((s) => [s.prior, s.current]), [["q1", "q2"], ["q2", "q3"]]);
  near(steps[0].price, 10);
  near(steps[0].volume, 0);
  near(steps[1].volume, 110);
  near(steps[1].price, 20);
  for (const s of steps) near(s.volume + s.mix + s.price + s.newAndDiscontinued + s.noUnits, s.currentSales - s.priorSales);
});

test("price realization by group and price gaps against peers", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'A', 'c1', 10, 100.0), ('p0', 'A', 'c2', 10, 100.0), ('p0', 'B', 'c1', 10, 200.0),
    ('p1', 'A', 'c1', 10, 110.0), ('p1', 'A', 'c2', 10, 90.0), ('p1', 'B', 'c1', 10, 200.0)
  ) v(period, product, customer, units, sales)`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }, { name: "Customer", columns: ["customer"] }],
  };
  await runBridge(query, config);

  const byCustomer = await priceRealization(query, config, ["customer"]);
  const c1 = byCustomer.find((r) => r.keys.customer === "c1")!;
  near(c1.priceEffect, 10);
  near(c1.change, 10 / 300);
  const c2 = byCustomer.find((r) => r.keys.customer === "c2")!;
  near(c2.change, -0.1);

  // Product A sells at 11 to c1 and 9 to c2: the peer average is 10. B has one buyer, so no peers.
  const gaps = await priceGaps(query, config);
  assert.equal(gaps.rows.length, 1);
  assert.equal(gaps.rows[0].keys.customer, "c2");
  near(gaps.rows[0].peerPrice, 10);
  near(gaps.totalOpportunity, 10);
  near(gaps.comparedSales, 200);
});

test("a cost column bridges margin and splits the rate effect into price and unit cost", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'A', 10, 100.0, 60.0), ('p0', 'B', 10, 200.0, 150.0),
    ('p1', 'A', 10, 110.0, 65.0), ('p1', 'B', 20, 400.0, 300.0)
  ) v(period, product, units, sales, cost)`);
  const config: BridgeConfig = {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales", costColumn: "cost",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  const result = await runBridge(query, config);

  // Margin 90 -> 145. Unit margins: A 4 -> 4.5, B 5 -> 5; prior average 4.5.
  assert.equal(result.priorSales, 90);
  assert.equal(result.currentSales, 145);
  near(effect(result, "volume"), 10 * 4.5);
  near(effect(result, "mix_1"), 10 * (5 - 4.5));
  near(effect(result, "price_sales"), 10);
  near(effect(result, "cost_rate"), -5);
  near(total(result), 55);
});

test("account bridge splits the change into new, lost, growing and shrinking", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('p0', 'keep', 'A', 10, 100.0), ('p0', 'gone', 'A', 5, 50.0), ('p0', 'down', 'A', 10, 100.0),
    ('p1', 'keep', 'A', 12, 130.0), ('p1', 'fresh', 'A', 4, 40.0), ('p1', 'down', 'A', 6, 60.0)
  ) v(period, customer, product, units, sales)`);
  const groups = await accountBridge(query, {
    table: "t", periodColumn: "period", prior: "p0", current: "p1",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  }, "customer");
  const by = Object.fromEntries(groups.map((g) => [g.status, g]));
  assert.deepEqual([by.new.count, by.lost.count, by.growing.count, by.shrinking.count], [1, 1, 1, 1]);
  near(by.new.change, 40);
  near(by.lost.change, -50);
  near(by.growing.change, 30);
  near(by.shrinking.change, -40);
  assert.equal(by.lost.top[0].name, "gone");
  near(groups.reduce((sum, g) => sum + g.change, 0), 230 - 250);
});

test("review findings: float units that net to zero, offsetting splits, null sales with cost, reserved names", async () => {
  const query = await openDatabase();
  const base = { periodColumn: "period", prior: "p0", current: "p1", unitsColumn: "units", salesColumn: "sales" };
  const levels = [{ name: "Product", columns: ["product"] }];

  await query(`CREATE TABLE f AS SELECT * FROM (VALUES
    ('p0', 'A', 0.1::DOUBLE, 10.0), ('p0', 'A', 0.2::DOUBLE, 20.0), ('p0', 'A', -0.3::DOUBLE, -29.0),
    ('p0', 'B', 10::DOUBLE, 100.0), ('p1', 'A', 2::DOUBLE, 110.0), ('p1', 'B', 10::DOUBLE, 100.0)
  ) v(period, product, units, sales)`);
  const floats = await runBridge(query, { ...base, table: "f", levels });
  near(total(floats), floats.currentSales - floats.priorSales);
  assert.ok(floats.effects.every((e) => Math.abs(e.value) < 1e6));

  await query(`CREATE TABLE c AS SELECT * FROM (VALUES
    ('p0', 'A', 10, 100.0, 60.0), ('p1', 'A', 10, 150.0, 110.0),
    ('p0', 'B', 5, 50.0, 30.0), ('p1', 'B', 5, NULL, 20.0)
  ) v(period, product, units, sales, cost)`);
  const marginConfig = { ...base, table: "c", costColumn: "cost", levels };
  const margin = await runBridge(query, marginConfig);
  // A: price +50 and unit cost -50 offset exactly, and both are still reported.
  const [a] = (await drill(query, marginConfig, { columns: ["product"] })).filter((row) => row.product === "A");
  near(Number(a.price_sales), 50);
  near(Number(a.cost_rate), -50);
  // B: sales are blank this period but its cost of 20 still counts.
  assert.equal(margin.currentSales, 40 - 20);
  near(total(margin), 20 - 60);

  await query(`CREATE TABLE r AS SELECT 'p0' AS period, 'x' AS status, 1 AS units, 1.0 AS sales`);
  await assert.rejects(
    runBridge(query, { ...base, table: "r", levels: [{ name: "Status", columns: ["status"] }] }),
    /uses internally/,
  );
});

function gap(actual: number, expected: number): number {
  const diff = Math.abs(actual - expected);
  const scale = Math.max(Math.abs(actual), Math.abs(expected));
  if (diff <= 1e-9) return diff;
  return scale === 0 ? diff : diff / scale;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function assertClose(actual: number, expected: number, label: string): void {
  const seen = gap(actual, expected);
  assert.ok(seen <= 1e-9, `${label} expected ${expected}, got ${actual}, gap ${seen}`);
}

test("cell rows match the previous cells SQL", async () => {
  const query = await openDatabase();
  const levels: Level[] = [
    { name: "Design", columns: ["design"] },
    { name: "Coating", columns: ["coating"] },
    { name: "Color", columns: ["photochromic", "polar"] },
    { name: "Material", columns: ["material"] },
  ];
  await createSyntheticSales(query, 100, "s100");
  await createSyntheticSales(query, 2_000, "s2000");
  await createSyntheticSales(query, 10_000, "s10000");
  await query(`CREATE TABLE hand AS SELECT * FROM (VALUES
    ('p0', 'A', 10, 100.0), ('p0', 'B', 10, 200.0),
    ('p1', 'A', 10, 110.0), ('p1', 'B', 20, 400.0), ('p1', 'C', 5, 150.0),
    ('p0', 'A', 0, 7.0), ('p1', 'B', 0, 4.0)
  ) v(period, product, units, sales)`);
  await query(`CREATE TABLE disc AS SELECT * FROM (VALUES
    ('p0', 'D1', 'basic', 10, 100.0), ('p0', 'D1', 'premium', 10, 300.0),
    ('p0', 'D2', 'old', 8, 80.0),
    ('p1', 'D1', 'basic', 10, 100.0), ('p1', 'D1', 'premium', 12, 360.0),
    ('p1', 'D2', 'newcoat', 4, 200.0)
  ) v(period, design, coating, units, sales)`);
  await query(`CREATE TABLE nulls AS SELECT * FROM (VALUES
    ('p0', NULL, 'basic', 2.5, 10.0),
    ('p0', 'D1', NULL, 1.5, 20.0),
    ('p0', 'D1', 'basic', 4, 40.0),
    ('p1', NULL, 'premium', 1, 7.0),
    ('p1', 'D1', NULL, 0, 3.0),
    ('p1', 'D1', 'basic', 5, 55.0)
  ) v(period, design, coating, units, sales)`);
  await query(`CREATE TABLE data (
    order_date DATE, design VARCHAR, customer VARCHAR, jobs INTEGER, sales DOUBLE
  )`);
  await query(`INSERT INTO data VALUES
    (DATE '2025-01-10', 'A', 'keep', 2, 20),
    (DATE '2025-08-10', 'A', 'keep', 3, 30),
    (DATE '2025-01-10', 'A', 'drop', 9, 90),
    (DATE '2026-03-01', 'A', 'keep', 4, 50),
    (DATE '2026-03-01', 'B', 'keep', 1, 15),
    (DATE '2026-09-01', 'A', 'keep', 8, 80)
  `);
  const ytd: Setup = {
    periodColumn: "order_date",
    grain: "ytd",
    unitsColumn: "jobs",
    salesColumn: "sales",
    levels: [{ name: "Design", columns: ["design"] }],
    filters: [{ column: "customer", mode: "include", values: ["keep"] }],
  };
  await query(viewSql(ytd));

  const synth = {
    periodColumn: "year",
    prior: 2025,
    current: 2026,
    unitsColumn: "jobs",
    salesColumn: "sales",
  } as const;
  const shapes: { label: string; config: BridgeConfig; drill?: { columns: string[]; filter: { column: string; value: string } } }[] = [
    { label: "100 rows, four attributes", config: { ...synth, table: "s100", levels } },
    { label: "2000 rows, four attributes", config: { ...synth, table: "s2000", levels } },
    { label: "10000 rows, four attributes", config: { ...synth, table: "s10000", levels } },
    { label: "100 rows, one attribute", config: { ...synth, table: "s100", levels: [levels[0]] } },
    { label: "gross column", config: { ...synth, table: "s2000", levels, grossColumn: "gross_sales" } },
    { label: "cost column", config: { ...synth, table: "s2000", levels, costColumn: "cost" } },
    { label: "full new and discontinued", config: { ...synth, table: "s2000", levels, newAndDiscontinued: "full" } },
    {
      label: "zero-unit rows",
      config: {
        table: "hand", periodColumn: "period", prior: "p0", current: "p1",
        unitsColumn: "units", salesColumn: "sales",
        levels: [{ name: "Product", columns: ["product"] }],
      },
    },
    {
      label: "new and discontinued configurations",
      config: {
        table: "disc", periodColumn: "period", prior: "p0", current: "p1",
        unitsColumn: "units", salesColumn: "sales",
        levels: [{ name: "Design", columns: ["design"] }, { name: "Coating", columns: ["coating"] }],
      },
      drill: { columns: ["coating"], filter: { column: "design", value: "D2" } },
    },
    {
      label: "null attribute values",
      config: {
        table: "nulls", periodColumn: "period", prior: "p0", current: "p1",
        unitsColumn: "units", salesColumn: "sales",
        levels: [{ name: "Design", columns: ["design"] }, { name: "Coating", columns: ["coating"] }],
      },
    },
    {
      label: "year-to-date view with a customer filter",
      config: {
        table: VIEW, periodColumn: PERIOD, prior: "2025 YTD", current: "2026 YTD",
        unitsColumn: "jobs", salesColumn: "sales",
        levels: [{ name: "Design", columns: ["design"] }],
      },
    },
  ];

  for (const shape of shapes) {
    const config = { ...shape.config, cellsTable: "new_cells" };
    const result = await runBridge(query, config);
    await query(`CREATE OR REPLACE TEMP TABLE old_cells AS ${legacyCellsSql(shape.config)}`);
    const columns = (await query(`SELECT name, type FROM pragma_table_info('new_cells')`)).map((row) => ({
      name: String(row.name),
      type: String(row.type),
    }));
    const oldColumns = (await query(`SELECT name FROM pragma_table_info('old_cells')`)).map((row) => String(row.name));
    assert.deepEqual(columns.map((column) => column.name), oldColumns, `${shape.label} columns`);

    const keys = shape.config.levels.flatMap((level) => level.columns);
    const order = keys.map((key) => ident(key)).join(", ");
    const fresh = await query(`SELECT * FROM new_cells ORDER BY ${order}`);
    const previous = await query(`SELECT * FROM old_cells ORDER BY ${order}`);
    assert.equal(fresh.length, previous.length, `${shape.label} row count`);
    assert.ok(fresh.length > 0, `${shape.label} produced no cells`);

    for (let i = 0; i < fresh.length; i++) {
      for (const column of columns) {
        const actual = fresh[i][column.name];
        const expected = previous[i][column.name];
        const actualNumber = asNumber(actual);
        const expectedNumber = asNumber(expected);
        if (actualNumber !== null && expectedNumber !== null) {
          assertClose(actualNumber, expectedNumber, `${shape.label} ${column.name} row ${i}`);
        } else {
          assert.equal(actual ?? null, expected ?? null, `${shape.label} ${column.name} row ${i}`);
        }
      }
    }

    const [totals] = await query(`SELECT sum(s0 + z0) AS s0, sum(s1 + z1) AS s1, sum(s1) AS unit_s1 FROM old_cells`);
    assertClose(result.priorSales, Number(totals.s0), `${shape.label} prior sales`);
    assertClose(result.currentSales, Number(totals.s1), `${shape.label} current sales`);
    for (const effect of result.effects) {
      const [sum] = await query(`SELECT sum(${ident(effect.key)}) AS v FROM old_cells`);
      assertClose(effect.value, Number(sum.v), `${shape.label} effect ${effect.key}`);
    }
    const coverage = await query(
      `SELECT match_level, count(*)::DOUBLE AS cells, sum(s1) AS sales
       FROM old_cells WHERE q1 <> 0 OR s1 <> 0
       GROUP BY match_level ORDER BY match_level DESC`,
    );
    assert.equal(result.coverage.length, coverage.length, `${shape.label} coverage rows`);
    const unitSales = Number(totals.unit_s1);
    for (let i = 0; i < result.coverage.length; i++) {
      const actual = result.coverage[i];
      const expected = coverage[i];
      assert.equal(actual.level, Number(expected.match_level), `${shape.label} coverage level`);
      assert.equal(actual.cells, Number(expected.cells), `${shape.label} coverage cells`);
      assertClose(actual.sales, Number(expected.sales), `${shape.label} coverage sales`);
      const share = unitSales === 0 ? 0 : Number(expected.sales) / unitSales;
      assertClose(actual.share, share, `${shape.label} coverage share`);
    }

    if (shape.drill) {
      const options = {
        columns: shape.drill.columns,
        filters: [shape.drill.filter],
        sortBy: "change" as const,
      };
      const fromNew = await drill(query, config, options);
      const fromOld = await drill(query, { ...shape.config, cellsTable: "old_cells" }, options);
      assert.equal(fromNew.length, fromOld.length, `${shape.label} drill rows`);
      for (let i = 0; i < fromNew.length; i++) {
        for (const key of Object.keys(fromNew[i])) {
          const actual = asNumber(fromNew[i][key]);
          const expected = asNumber(fromOld[i][key]);
          if (actual !== null && expected !== null) assertClose(actual, expected, `${shape.label} drill ${key}`);
          else assert.equal(fromNew[i][key] ?? null, fromOld[i][key] ?? null, `${shape.label} drill ${key}`);
        }
      }
    }
  }
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

test("money tie-out: the file's money less the excluded rows equals the bridge, to the cent", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE data (
    order_date DATE, customer VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE, cost DOUBLE
  )`);
  await query(`INSERT INTO data VALUES
    (DATE '2025-02-01', 'keep', 'A', 2, 100.10, 60.00),
    (DATE '2025-03-01', 'keep', 'B', NULL, 50.05, NULL),
    (DATE '2025-03-02', 'drop', 'A', 5, 250.25, 100.00),
    (DATE '2026-02-01', 'keep', 'A', 3, 180.33, 90.00),
    (DATE '2026-03-01', 'drop', 'A', 1, 999.99, 400.00),
    (DATE '2027-01-01', 'keep', 'A', 4, 700.00, 300.00)
  `);
  const setup: Setup = {
    periodColumn: "order_date",
    grain: "year",
    unitsColumn: "units",
    salesColumn: "sales",
    costColumn: "cost",
    levels: [{ name: "Design", columns: ["design"] }],
    filters: [{ column: "customer", mode: "include", values: ["keep"] }],
  };
  // The app builds its unfiltered relation from the same view definition, so the
  // period column cannot drift from the one the bridge reads.
  await query(`DROP VIEW IF EXISTS data_all`);
  await query(viewSql({ ...setup, filters: [] }));
  await query(`ALTER VIEW ${quote(VIEW)} RENAME TO ${quote("data_all")}`);
  await query(viewSql(setup));

  const config: BridgeConfig = {
    table: VIEW, periodColumn: PERIOD, prior: "2025", current: "2026",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Design", columns: ["design"] }],
  };
  const result = await runBridge(query, config);
  const check = await dataCheck(query, config);
  const money = await periodMoney(query, config, { table: "data_all", periodColumn: PERIOD });

  // In the file: 100.10 + 50.05 + 250.25 and 180.33 + 999.99. The 2027 row is another period.
  near(money.prior.inFile, 400.4);
  near(money.current.inFile, 1180.32);
  // After the customer filter: 100.10 + 50.05 and 180.33. The two drop rows are out.
  near(money.prior.afterFilters, 150.15);
  near(money.current.afterFilters, 180.33);

  // Existing figures for the same file are unchanged: the no-unit row still counts.
  near(result.priorSales, 150.15);
  near(result.currentSales, 180.33);
  near(effect(result, "volume"), 50.05);
  near(effect(result, "mix_1"), 0);
  near(effect(result, "price"), 30.18);
  near(effect(result, "new_config"), 0);
  near(effect(result, "discontinued"), 0);
  near(effect(result, "no_units"), -50.05);
  near(total(result), result.currentSales - result.priorSales);
  assert.equal(check.rows, 4);
  assert.equal(check.priorRows, 2);
  assert.equal(check.currentRows, 1);
  assert.equal(check.otherPeriodRows, 1);

  const lines = tieOutLines(config, money, result);
  assert.deepEqual(lines.map((line) => line.label), [
    "Sales in file, 2025",
    "Excluded by filters, 2025",
    "Sales in the bridge, 2025",
    "Sales in file, 2026",
    "Excluded by filters, 2026",
    "Sales in the bridge, 2026",
  ]);
  const cents = (value: number) => Math.round(value * 100);
  assert.deepEqual(lines.map((line) => cents(line.value)), [40040, 25025, 15015, 118032, 99999, 18033]);
  for (const period of [0, 1]) {
    // In file minus excluded is in the bridge, to the cent, on the lines themselves.
    assert.equal(
      cents(lines[period * 3].value) - cents(lines[period * 3 + 1].value),
      cents(lines[period * 3 + 2].value),
    );
    assert.equal(cents(lines[period * 3 + 2].value), cents(period === 0 ? result.priorSales : result.currentSales));
  }

  // With no filter there is nothing to exclude, and the file equals the bridge.
  await query(viewSql({ ...setup, filters: [] }));
  const all = await runBridge(query, config);
  const allMoney = await periodMoney(query, config, { table: "data_all", periodColumn: PERIOD });
  near(allMoney.prior.inFile, 400.4);
  near(allMoney.prior.afterFilters, 400.4);
  near(all.priorSales, 400.4);
  near(allMoney.current.afterFilters, 1180.32);
  near(all.currentSales, 1180.32);
  const allLines = tieOutLines(config, allMoney, all);
  assert.deepEqual(allLines.map((line) => cents(line.value)), [40040, 0, 40040, 118032, 0, 118032]);

  // On margin the same identity holds with sales minus cost as the measure.
  await query(viewSql(setup));
  const marginConfig: BridgeConfig = { ...config, costColumn: "cost" };
  const margin = await runBridge(query, marginConfig);
  const marginMoney = await periodMoney(query, marginConfig, { table: "data_all", periodColumn: PERIOD });
  near(marginMoney.prior.inFile, 240.4);
  near(marginMoney.prior.afterFilters, 90.15);
  near(margin.priorSales, 90.15);
  near(marginMoney.current.afterFilters, 90.33);
  near(margin.currentSales, 90.33);
  const marginLines = tieOutLines(marginConfig, marginMoney, margin);
  assert.deepEqual(marginLines.map((line) => line.label).slice(0, 3), [
    "Margin in file, 2025",
    "Excluded by filters, 2025",
    "Margin in the bridge, 2025",
  ]);
  assert.deepEqual(marginLines.map((line) => cents(line.value)), [24040, 15025, 9015, 69032, 59999, 9033]);
});

test("money tie-out is stable for fractional cents across grouping orders", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE data (
    year INTEGER, product VARCHAR, grp VARCHAR, customer VARCHAR, units INTEGER, sales DOUBLE
  )`);
  await query(`INSERT INTO data VALUES
    (2025, 'A', 'X', 'drop', 1, 0.001),
    (2025, 'B', 'X', 'drop', 1, 0.003),
    (2025, 'B', 'Y', 'drop', 1, 0.051),
    (2025, 'A', 'X', 'keep', 1, 10.001),
    (2025, 'A', 'Y', 'keep', 1, 10.023),
    (2025, 'B', 'X', 'keep', 1, 10.051),
    (2026, 'A', 'X', 'keep', 1, 0.001),
    (2026, 'B', 'X', 'keep', 1, 0.003),
    (2026, 'B', 'Y', 'keep', 1, 0.051)
  `);
  const setup: Setup = {
    periodColumn: "year",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
    filters: [{ column: "customer", mode: "include", values: ["keep"] }],
  };
  await query(`DROP VIEW IF EXISTS data_all`);
  await query(viewSql({ ...setup, filters: [] }));
  await query(`ALTER VIEW ${quote(VIEW)} RENAME TO ${quote("data_all")}`);
  await query(viewSql(setup));

  const base: Omit<BridgeConfig, "levels"> = {
    table: VIEW, periodColumn: PERIOD, prior: "2025", current: "2026",
    unitsColumn: "units", salesColumn: "sales",
  };
  const byProduct: BridgeConfig = { ...base, levels: [{ name: "Product", columns: ["product"] }] };
  const byGrp: BridgeConfig = { ...base, levels: [{ name: "Grp", columns: ["grp"] }] };

  const moneyProduct = await periodMoney(query, byProduct, { table: "data_all", periodColumn: PERIOD });
  const moneyGrp = await periodMoney(query, byGrp, { table: "data_all", periodColumn: PERIOD });
  // The file and filter measurements do not group, so both configs measure the same.
  assert.deepEqual(moneyProduct, moneyGrp);

  const resultProduct = await runBridge(query, byProduct);
  const resultGrp = await runBridge(query, byGrp);
  // Grouping changes the floating-point accumulation inside the bridge but not the money.
  // The existing bridge totals stay within a fraction of a cent of each other.
  assert.ok(Math.abs(resultProduct.priorSales - resultGrp.priorSales) < 1e-6);
  assert.ok(Math.abs(resultProduct.currentSales - resultGrp.currentSales) < 1e-6);

  const linesProduct = tieOutLines(byProduct, moneyProduct, resultProduct);
  const linesGrp = tieOutLines(byGrp, moneyGrp, resultGrp);
  // Stable cent rounding makes the shown lines identical across grouping orders.
  assert.deepEqual(linesProduct, linesGrp);

  const toCents = (value: number) => Math.round(value * 100);
  const stableCents = (value: number) => Math.round((value + 1e-6) * 100);
  for (const lines of [linesProduct, linesGrp]) {
    for (const period of [0, 1]) {
      assert.equal(
        toCents(lines[period * 3].value) - toCents(lines[period * 3 + 1].value),
        toCents(lines[period * 3 + 2].value),
      );
    }
    // No gap is absorbed into Excluded: the bridge line equals the measured
    // filtered total, and Excluded is the measured file minus that filtered total.
    assert.equal(toCents(lines[2].value), stableCents(moneyProduct.prior.afterFilters));
    assert.equal(toCents(lines[5].value), stableCents(moneyProduct.current.afterFilters));
    assert.equal(toCents(lines[1].value), toCents(lines[0].value) - stableCents(moneyProduct.prior.afterFilters));
    assert.equal(toCents(lines[4].value), toCents(lines[3].value) - stableCents(moneyProduct.current.afterFilters));
  }
  // The fractional-cent prior ties out instead of showing a one-cent gap.
  // In file 0.001 + 0.003 + 0.051 + 10.001 + 10.023 + 10.051, excluded drops the fractional trio.
  // The current period is the reviewer's minimal fractional file, with no filter on it.
  assert.deepEqual(linesProduct.map((line) => toCents(line.value)), [3013, 5, 3008, 6, 0, 6]);
});

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

function cumulativeColumns(levels: Level[], j: number): string[] {
  return levels.slice(0, j).flatMap((level) => level.columns);
}

function legacyCellsSql(config: BridgeConfig): string {
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
  const measure = cost ? `(coalesce(${sales}, 0) - coalesce(${cost}, 0))` : sales;
  const full = config.newAndDiscontinued === "full";
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
WITH cells AS (
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
