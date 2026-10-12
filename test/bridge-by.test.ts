import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import {
  bridgeBy,
  cellsSql,
  runBridge,
  type BridgeBy,
  type BridgeConfig,
  type BridgePanel,
  type Query,
} from "../src/engine.ts";
import { createSyntheticSales } from "../src/synth.ts";

function near(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} expected ${expected}, got ${actual}`);
}

function figure(panel: BridgePanel, key: string): number {
  return panel.result?.effects.find((e) => e.key === key)?.value ?? 0;
}

function betweenFigure(by: BridgeBy, key: string): number {
  const found = by.between.find((e) => e.key === key);
  assert.ok(found, `missing effect ${key}`);
  return found.value;
}

function panelFor(by: BridgeBy, value: string | null): BridgePanel {
  const found = by.panels.find((panel) => panel.value === value);
  assert.ok(found, `no panel for ${value}`);
  return found;
}

function combinedPanel(by: BridgeBy): BridgePanel {
  const found = by.panels.find((panel) => panel.combined);
  assert.ok(found, "no combined panel");
  return found;
}

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function literal(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

/** Names of the objects the temp catalog holds, which is where the panels work. */
async function temporaryObjects(query: Query): Promise<string[]> {
  const rows = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_catalog = 'temp' ORDER BY table_name`,
  );
  return rows.map((row) => String(row.table_name));
}

/**
 * The identities that hold whatever the picked column, the levels and the
 * settings are. A panel with no bridge still folds into them through the mix
 * line, so the last assertion is the complete accounting.
 */
function assertReconciles(by: BridgeBy, tolerance = 1e-9): void {
  const change = by.total.currentSales - by.total.priorSales;
  for (const panel of by.panels) {
    if (panel.result) {
      const sum = panel.result.effects.reduce((total, effect) => total + effect.value, 0);
      near(sum, panel.change, `panel ${panel.value} effects`);
    }
  }
  const changes = by.panels.reduce((sum, panel) => sum + panel.change, 0);
  assert.ok(Math.abs(changes - change) <= tolerance * Math.max(1, Math.abs(change)), `panels change ${changes}, main ${change}`);
  for (const effect of by.total.effects) {
    const panels = by.panels.reduce((sum, panel) => sum + figure(panel, effect.key), 0);
    assert.ok(
      Math.abs(panels + betweenFigure(by, effect.key) - effect.value) <= tolerance * Math.max(1, Math.abs(effect.value)),
      `effect ${effect.key} ${panels} + ${betweenFigure(by, effect.key)} is not ${effect.value}`,
    );
  }
  const bridged = by.panels.filter((panel) => panel.result).reduce((sum, panel) => sum + panel.change, 0);
  const mix = by.between.reduce((sum, effect) => sum + effect.value, 0);
  assert.ok(Math.abs(bridged + mix - change) <= tolerance * Math.max(1, Math.abs(change)), `bridged ${bridged} plus mix ${mix} is not ${change}`);
}

const HAND = {
  periodColumn: "period",
  prior: "p0",
  current: "p1",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Design", columns: ["design"] }],
};

/**
 * Seven rows, one bridge level, three values of the picked column.
 *
 *   basic   p0 30 units 300, p1 36 units 370
 *   premium p0 15 units 400, p1 12 units 384
 *
 * Main bridge. Prior average price 700 / 45 = 15.5556, basic 300 / 30 = 10,
 * premium 400 / 15 = 26.6667.
 *   volume  (36 - 30 + 12 - 15) * 15.5556 = 3 * 15.5556 = 46.6667
 *   mix_1   6 * (10 - 15.5556) + (12 - 15) * (26.6667 - 15.5556) = -33.3333 - 33.3333 = -66.6667
 *   price   basic 370 - 300 - 6 * 10 = 10, premium 384 - 400 + 3 * 26.6667 = 64, so 74
 *   700 prior plus 54 gives 754.
 *
 * East is prior only, so it is one cell of 5 premium units at 100.
 *   prior 100, current 0, change -100. Its own average price is 20, so volume
 *   (0 - 5) * 20 = -100, mix 0, price 0, discontinued 0.
 * North has both cells.
 *   prior 400, current 494, change 94. Its prior average 400 / 20 = 20, basic
 *   10, premium 30. volume 2 * 20 = 40, mix 2 * (30 - 20) = 20, price
 *   110 - 100 - 0 * 10 = 10 and 384 - 300 - 2 * 30 = 24, so 34.
 * South grew its basic units.
 *   prior 200, current 260, change 60. Its average price is 10, so volume
 *   6 * 10 = 60, mix 0, price 260 - 200 - 6 * 10 = 0.
 *
 * The mix between the values is non-zero because volume moved from East, which
 * sold premium at 20 a unit, to South, which sells basic at 10. Each panel
 * prices its own volume at its own prior average while the main bridge prices
 * the whole shift at the blended 15.5556, so the panels' volume sums to 0
 * against the main bridge's 46.6667. The premium price effect differs for the
 * same reason. The main bridge pools North's and East's prior premium rows
 * into one cell of 15 units at 26.6667, while North's panel prices its own
 * premium at 30, which leaves 64 - 24 = 40 on the price line.
 */
test("a hand-checked table reconciles across values, with the mix between them", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'North', 'basic', 10, 100), ('p0', 'North', 'premium', 10, 300),
    ('p0', 'South', 'basic', 20, 200), ('p0', 'East', 'premium', 5, 100),
    ('p1', 'North', 'basic', 10, 110), ('p1', 'North', 'premium', 12, 384),
    ('p1', 'South', 'basic', 26, 260)`);
  const config: BridgeConfig = { ...HAND, table: "t" };
  const by = await bridgeBy(query, config, "region");

  // The prior average price and each cell's price, so the arithmetic below is exact.
  const average = 700 / 45;
  const basic = 300 / 30;
  const premium = 400 / 15;
  const mainVolume = 3 * average;
  const mainMix = 6 * (basic - average) - 3 * (premium - average);

  assert.equal(by.column, "region");
  near(by.total.priorSales, 700);
  near(by.total.currentSales, 754);
  near(by.total.effects.reduce((sum, e) => sum + e.value, 0), 54);
  for (const [key, value] of [["volume", mainVolume], ["mix_1", mainMix], ["price", 74]] as const) {
    near(by.total.effects.find((e) => e.key === key)!.value, value, `main ${key}`);
  }

  assert.deepEqual(
    by.panels.map((panel) => [panel.value, panel.status, panel.priorSales, panel.currentSales, panel.change]),
    [
      ["East", "lost", 100, 0, -100],
      ["North", "continuing", 400, 494, 94],
      ["South", "continuing", 200, 260, 60],
    ],
  );
  for (const [key, value] of [
    ["East", [["volume", -100], ["mix_1", 0], ["price", 0], ["discontinued", 0], ["new_config", 0], ["no_units", 0]]],
    ["North", [["volume", 40], ["mix_1", 20], ["price", 34], ["discontinued", 0], ["new_config", 0], ["no_units", 0]]],
    ["South", [["volume", 60], ["mix_1", 0], ["price", 0], ["discontinued", 0], ["new_config", 0], ["no_units", 0]]],
  ] as const) {
    const panel = panelFor(by, key);
    for (const [effect, expected] of value) near(figure(panel, effect), expected, `${key} ${effect}`);
    assert.ok(panel.result, `${key} has a bridge`);
  }

  assertReconciles(by);
  near(by.between.reduce((sum, e) => sum + e.value, 0), 0, "mix between values sums to zero");
  for (const [key, value] of [["volume", mainVolume], ["mix_1", mainMix - 20], ["price", 40]] as const) {
    near(betweenFigure(by, key), value, `between ${key}`);
  }
  for (const key of ["new_config", "discontinued", "no_units"]) {
    near(betweenFigure(by, key), 0, `between ${key}`);
  }

  for (const region of ["East", "North", "South"]) {
    await query(`CREATE OR REPLACE TABLE own AS SELECT * FROM t WHERE region = ${literal(region)}`);
    const own = await runBridge(query, { ...config, table: "own" });
    assert.deepEqual(panelFor(by, region).result, own, `panel ${region} equals its own bridge`);
  }
});

test("synthetic sales reconcile by customer and by design, and the values with no bridge leave their change on the mix line", async () => {
  const query = await openDatabase();
  await createSyntheticSales(query, 2_000);
  const config: BridgeConfig = {
    table: "sales",
    periodColumn: "year",
    prior: 2025,
    current: 2026,
    unitsColumn: "jobs",
    salesColumn: "sales",
    levels: [
      { name: "Design", columns: ["design"] },
      { name: "Coating", columns: ["coating"] },
      { name: "Color", columns: ["photochromic", "polar"] },
      { name: "Material", columns: ["material"] },
    ],
  };
  for (const column of ["customer", "design"]) {
    const by = await bridgeBy(query, config, column);
    assert.equal(by.panels.length, 13, `${column} panels`);
    assertReconciles(by);
    const withoutBridge = by.panels.filter((panel) => panel.result === null);
    assert.ok(withoutBridge.length > 0, `${column} has a value with no bridge`);
    const theirChange = withoutBridge.reduce((sum, panel) => sum + panel.change, 0);
    const mix = by.between.reduce((sum, effect) => sum + effect.value, 0);
    assert.ok(
      Math.abs(mix - theirChange) < 1e-6 * Math.max(1, Math.abs(theirChange)),
      `${column} mix ${mix} against the unbridged change ${theirChange}`,
    );
    assert.ok(combinedPanel(by).values > 1, `${column} combines several values`);
  }
});

test("a value present only in the current period is new and has no bridge", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'keep', 'basic', 10, 100), ('p1', 'keep', 'basic', 10, 110), ('p1', 'fresh', 'basic', 5, 60)`);
  const by = await bridgeBy(query, { ...HAND, table: "t" }, "region");

  const fresh = panelFor(by, "fresh");
  assert.equal(fresh.status, "new");
  assert.equal(fresh.result, null);
  near(fresh.priorSales, 0);
  near(fresh.currentSales, 60);
  near(fresh.change, 60);

  const keep = panelFor(by, "keep");
  assert.equal(keep.status, "continuing");
  near(keep.change, 10);
  assertReconciles(by);
  // The new value's cells join the basic cell of the bridge, so it shows as volume and price there.
  near(by.total.effects.find((e) => e.key === "new_config")!.value, 0);
  near(by.total.effects.reduce((sum, e) => sum + e.value, 0), 70);
});

/**
 * East's premium rows are gone. A panel that holds only those rows prices the
 * lost units at its own prior average of 20, which is also its reference price,
 * so the discontinued line nets to zero and the whole change is volume.
 */
test("a value present only in the prior period is lost and still bridges", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'gone', 'basic', 10, 100), ('p0', 'keep', 'basic', 10, 100), ('p1', 'keep', 'basic', 12, 132)`);
  const config: BridgeConfig = { ...HAND, table: "t" };
  const by = await bridgeBy(query, config, "region");

  const gone = panelFor(by, "gone");
  assert.equal(gone.status, "lost");
  assert.ok(gone.result, "a lost value has a real bridge");
  near(gone.priorSales, 100);
  near(gone.currentSales, 0);
  near(gone.change, -100);
  near(figure(gone, "volume"), -100);
  for (const key of ["mix_1", "price", "new_config", "discontinued", "no_units"]) near(figure(gone, key), 0, `lost ${key}`);
  assertReconciles(by);

  await query(`CREATE TABLE own AS SELECT * FROM t WHERE region = 'gone'`);
  const own = await runBridge(query, { ...config, table: "own" });
  assert.deepEqual(gone.result, own);
  const [cells] = await query(`SELECT count(*)::INTEGER AS other FROM "bridge_cells" WHERE status <> 'discontinued'`);
  assert.equal(cells.other, 0, "every cell of a lost value is discontinued");
});

test("values whose rows have no units in a period have no bridge", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'fee', 'basic', 0, 20), ('p1', 'fee', 'basic', 3, 8),
    ('p0', 'blank', 'basic', 0, 20), ('p1', 'blank', 'basic', 0, 5),
    ('p0', 'keep', 'basic', 10, 100), ('p1', 'keep', 'basic', 10, 110)`);
  const by = await bridgeBy(query, { ...HAND, table: "t" }, "region");

  // 'fee' sold nothing but a credit in the prior period, so it is not new even
  // though it has units now.
  const fee = panelFor(by, "fee");
  assert.equal(fee.status, "no_units");
  assert.equal(fee.result, null);
  near(fee.priorSales, 20);
  near(fee.currentSales, 8);
  near(fee.change, -12);

  const blank = panelFor(by, "blank");
  assert.equal(blank.status, "no_units");
  assert.equal(blank.result, null);
  near(blank.change, -15);

  const keep = panelFor(by, "keep");
  assert.equal(keep.status, "continuing");
  assert.ok(keep.result, "the value with units bridges");
  near(keep.change, 10);
  assertReconciles(by);
  near(by.total.effects.find((e) => e.key === "no_units")!.value, -35);
  near(by.total.effects.reduce((sum, e) => sum + e.value, 0), 123 - 140);
});

test("null and the empty string are one value of the picked column", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', NULL, 'basic', 10, 100), ('p0', '', 'basic', 5, 50),
    ('p1', NULL, 'basic', 12, 120), ('p1', '', 'basic', 6, 60)`);
  const config: BridgeConfig = { ...HAND, table: "t" };
  const by = await bridgeBy(query, config, "region");

  assert.equal(by.panels.length, 1);
  const blank = by.panels[0];
  assert.equal(blank.value, null);
  assert.equal(blank.combined, false);
  assert.equal(blank.values, 1);
  assert.equal(blank.status, "continuing");
  near(blank.priorSales, 150, "null and empty string sales add up");
  near(blank.change, 30);
  assert.deepEqual(blank.result, await runBridge(query, config));
  assert.ok(by.panels.every((panel) => !panel.combined));
  near(by.between.reduce((sum, e) => sum + e.value, 0), 0);
});

test("fewer values than the limit leaves no combined panel", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'a', 'basic', 10, 100), ('p0', 'b', 'basic', 10, 100),
    ('p1', 'a', 'basic', 10, 110), ('p1', 'b', 'basic', 20, 200)`);
  const by = await bridgeBy(query, { ...HAND, table: "t" }, "region", 12);

  assert.equal(by.panels.length, 2);
  assert.deepEqual(by.panels.map((panel) => panel.value), ["b", "a"]);
  assert.ok(by.panels.every((panel) => panel.combined === false && panel.values === 1));
  assertReconciles(by);
});

test("one more value than the limit adds a combined panel for the tail", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'a', 'basic', 10, 100), ('p0', 'b', 'basic', 10, 100), ('p0', 'c', 'basic', 10, 100),
    ('p1', 'a', 'basic', 12, 110), ('p1', 'b', 'basic', 8, 80), ('p1', 'c', 'basic', 6, 60)`);
  const config: BridgeConfig = { ...HAND, table: "t" };
  const by = await bridgeBy(query, config, "region", 2);

  // Changes are c -40, b -20, a +10, so the two single panels are c and b and
  // the combined panel holds a's rows alone.
  assert.deepEqual(by.panels.map((panel) => [panel.combined, panel.value, panel.values]), [
    [false, "c", 1],
    [false, "b", 1],
    [true, null, 1],
  ]);
  const combined = combinedPanel(by);
  assert.equal(combined.status, "continuing");
  near(combined.priorSales, 100);
  near(combined.currentSales, 110);
  near(combined.change, 10);
  await query(`CREATE TABLE own AS SELECT * FROM t WHERE region = 'a'`);
  assert.deepEqual(combined.result, await runBridge(query, { ...config, table: "own" }));
  assertReconciles(by);
  near(by.total.effects.reduce((sum, e) => sum + e.value, 0), -50);
});

test("a limit below one, or one that is not a whole number, is clamped", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'a', 'basic', 10, 100), ('p0', 'b', 'basic', 10, 100), ('p0', 'c', 'basic', 10, 100),
    ('p1', 'a', 'basic', 12, 110), ('p1', 'b', 'basic', 8, 80), ('p1', 'c', 'basic', 6, 60)`);
  const config: BridgeConfig = { ...HAND, table: "t" };
  for (const [limit, singles, combined] of [
    [0, 1, 2],
    [-5, 1, 2],
    [2.7, 2, 1],
    [12, 3, 0],
  ] as const) {
    const by = await bridgeBy(query, config, "region", limit);
    assert.equal(by.panels.filter((panel) => !panel.combined).length, singles, `limit ${limit} single panels`);
    const tail = by.panels.filter((panel) => panel.combined);
    assert.equal(tail.length, combined > 0 ? 1 : 0, `limit ${limit} combined panel`);
    if (tail.length > 0) assert.equal(tail[0].values, combined, `limit ${limit} combined values`);
    assertReconciles(by);
  }
});

test("a column that does not exist throws and leaves nothing behind", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES ('p0', 'a', 'basic', 10, 100), ('p1', 'a', 'basic', 12, 120)`);
  await assert.rejects(bridgeBy(query, { ...HAND, table: "t" }, "nope"), /column "nope" not found/);
  assert.deepEqual(await temporaryObjects(query), ["bridge_cells"]);
  const [cells] = await query(`SELECT count(*)::INTEGER AS n FROM "bridge_cells"`);
  assert.equal(cells.n, 1, "the main cells table is still there");
});

test("a column name and a value that carry SQL are data", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, "re'g""ion; DROP TABLE t" VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'North''; DROP TABLE t', 'basic', 10, 100), ('p0', 'So"uth; DROP TABLE t', 'basic', 10, 200),
    ('p1', 'North''; DROP TABLE t', 'basic', 10, 110), ('p1', 'So"uth; DROP TABLE t', 'basic', 20, 400)`);
  const by = await bridgeBy(query, { ...HAND, table: "t" }, "re'g\"ion; DROP TABLE t");

  assert.deepEqual(
    by.panels.map((panel) => [panel.value, panel.change]),
    [
      ["So\"uth; DROP TABLE t", 200],
      ["North'; DROP TABLE t", 10],
    ],
  );
  const [rows] = await query(`SELECT count(*)::INTEGER AS n FROM t`);
  assert.equal(rows.n, 4, "the source table survived");
  assert.deepEqual(await temporaryObjects(query), ["bridge_cells"]);
  assertReconciles(by);
});

test("the picked column can be an attribute, another column, or the period column", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE m (period VARCHAR, region VARCHAR, design VARCHAR, coating VARCHAR, units INTEGER, sales DOUBLE, gross DOUBLE, cost DOUBLE)`);
  await query(`INSERT INTO m VALUES
    ('p0', 'North', 'D1', 'matte', 10, 100, 120, 60), ('p0', 'North', 'D2', 'matte', 5, 200, 230, 150),
    ('p0', 'South', 'D1', 'matte', 20, 200, 240, 120),
    ('p1', 'North', 'D1', 'matte', 10, 110, 128, 65), ('p1', 'North', 'D2', 'matte', 6, 260, 290, 190),
    ('p1', 'South', 'D1', 'matte', 22, 220, 250, 130)`);
  const base: BridgeConfig = {
    ...HAND,
    table: "m",
    levels: [
      { name: "Design", columns: ["design"] },
      { name: "Coating", columns: ["coating"] },
    ],
  };
  const shapes: { label: string; config: BridgeConfig; keys: string[] }[] = [
    { label: "sales", config: base, keys: ["volume", "mix_1", "mix_2", "price", "new_config", "discontinued", "no_units"] },
    { label: "margin", config: { ...base, costColumn: "cost" }, keys: ["volume", "mix_1", "mix_2", "price_sales", "cost_rate", "new_config", "discontinued", "no_units"] },
    { label: "gross", config: { ...base, grossColumn: "gross" }, keys: ["volume", "mix_1", "mix_2", "price_list", "price_discount", "new_config", "discontinued", "no_units"] },
    { label: "full", config: { ...base, newAndDiscontinued: "full" }, keys: ["volume", "mix_1", "mix_2", "price", "new_config", "discontinued", "no_units"] },
  ];
  for (const shape of shapes) {
    for (const column of ["design", "region", "period"]) {
      const by = await bridgeBy(query, shape.config, column);
      assert.deepEqual(
        by.total.effects.map((e) => e.key),
        shape.keys,
        `${shape.label} by ${column} effects`,
      );
      assert.deepEqual(by.between.map((e) => e.key), shape.keys, `${shape.label} by ${column} mix keys`);
      assertReconciles(by, 1e-6);
    }
  }
});

test("panels are ordered by absolute change, with the combined panel last", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'a', 'basic', 10, 100), ('p0', 'b', 'basic', 10, 100), ('p0', 'c', 'basic', 10, 100),
    ('p0', 'd', 'basic', 10, 100), ('p0', 'e', 'basic', 10, 100),
    ('p1', 'a', 'basic', 12, 130), ('p1', 'b', 'basic', 11, 110), ('p1', 'c', 'basic', 10, 100),
    ('p1', 'd', 'basic', 9, 80), ('p1', 'e', 'basic', 7, 70)`);
  const by = await bridgeBy(query, { ...HAND, table: "t" }, "region", 2);

  // Changes are a +30, e -30, d -20, b +10, c 0. a and e tie on absolute
  // change, and the value's text puts a first.
  assert.deepEqual(by.panels.map((panel) => [panel.combined, panel.value, panel.values, panel.change]), [
    [false, "a", 1, 30],
    [false, "e", 1, -30],
    [true, null, 3, -10],
  ]);
  const combined = combinedPanel(by);
  assert.equal(combined.value, null);
  near(combined.priorSales, 300);
  near(combined.currentSales, 290);
  assertReconciles(by);
  near(by.total.effects.reduce((sum, e) => sum + e.value, 0), -10);
});

test("the main cells table holds the main cells and no temporary object survives the call", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE s (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO s VALUES
    ('p0', 'a', 'basic', 10, 100), ('p0', 'b', 'basic', 10, 200),
    ('p1', 'a', 'basic', 12, 120), ('p1', 'b', 'basic', 8, 160)`);
  const config: BridgeConfig = { ...HAND, table: "s", cellsTable: "main_cells" };

  await runBridge(query, config);
  const before = await query(`SELECT * FROM "main_cells" ORDER BY design`);
  const by = await bridgeBy(query, config, "region", 1);
  assert.ok(by.panels.some((panel) => panel.result !== null));
  assert.deepEqual(await query(`SELECT * FROM "main_cells" ORDER BY design`), before, "the main cells are back");

  const temporary = await temporaryObjects(query);
  assert.ok(temporary.includes("main_cells"), "the cells table is still a temporary table");
  assert.ok(!temporary.includes("bridge_by_panel"), "the panel view is gone");
  assert.ok(!temporary.includes("bridge_by_hold"), "the hold table is gone");

  let panelGuards = 0;
  const failing: Query = async (sql) => {
    if (sql.startsWith("SELECT") && sql.includes("AS q0") && !sql.includes(`FROM ${ident(config.table)}`)) {
      panelGuards += 1;
      if (panelGuards === 2) throw new Error("the second panel bridge is refused");
    }
    return query(sql);
  };
  await runBridge(query, config);
  const held = await query(`SELECT * FROM "main_cells" ORDER BY design`);
  await assert.rejects(bridgeBy(failing, config, "region", 1), /second panel bridge is refused/);
  assert.deepEqual(await query(`SELECT * FROM "main_cells" ORDER BY design`), held, "a failed call still restores the cells");
  const afterFailure = await temporaryObjects(query);
  assert.ok(afterFailure.includes("main_cells"));
  assert.ok(!afterFailure.includes("bridge_by_panel"), "a failed call still drops the view");
  assert.ok(!afterFailure.includes("bridge_by_hold"), "a failed call still drops the hold table");
  await assert.rejects(query(`SELECT * FROM temp."bridge_by_panel"`), /does not exist/);
  await assert.rejects(query(`SELECT * FROM temp."bridge_by_hold"`), /does not exist/);
});

test("the main bridge is an ordinary bridge and the generated SQL is untouched", async () => {
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, region VARCHAR, design VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('p0', 'North', 'basic', 10, 100), ('p0', 'South', 'basic', 20, 200),
    ('p1', 'North', 'basic', 10, 110), ('p1', 'South', 'basic', 26, 260)`);
  const config: BridgeConfig = { ...HAND, table: "t" };
  const by = await bridgeBy(query, config, "region");

  assert.deepEqual(by.total, await runBridge(query, config));
  const sql = cellsSql(config);
  assert.ok(!sql.includes("bridge_by_panel"), "the cells SQL holds no panel object");
  assert.ok(!sql.includes("IS NOT DISTINCT FROM"), "the cells SQL holds no panel predicate");
  for (const region of ["North", "South"]) {
    await query(`CREATE OR REPLACE TABLE own AS SELECT * FROM t WHERE region = ${literal(region)}`);
    assert.deepEqual(panelFor(by, region).result, await runBridge(query, { ...config, table: "own" }));
  }
});
