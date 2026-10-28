import assert from "node:assert/strict";
import { test } from "node:test";
import { commentary } from "../src/commentary.ts";
import type { BridgeConfig, BridgeResult } from "../src/engine.ts";

const config: BridgeConfig = {
  table: "t", periodColumn: "period", prior: "2025", current: "2026",
  unitsColumn: "units", salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
};

const result: BridgeResult = {
  priorSales: 1_000_000,
  currentSales: 1_100_000,
  effects: [
    { key: "volume", label: "Volume", value: 60_000 },
    { key: "mix_1", label: "Mix: Product", value: -10_000 },
    { key: "price", label: "Price (like-for-like)", value: 30_000 },
    { key: "new_config", label: "New configurations", value: 20_000 },
    { key: "discontinued", label: "Discontinued configurations", value: 0 },
    { key: "no_units", label: "Sales with no units", value: 0 },
  ],
  coverage: [{ level: 1, label: "Exact configuration", cells: 10, sales: 1_000_000, share: 0.95 }],
  cellsTable: "bridge_cells",
};

test("the summary states the change, ranks the drivers and qualifies price", () => {
  const text = commentary(result, config);
  assert.equal(text[0], "Sales rose 10.0%, from 1,000,000 in 2025 to 1,100,000 in 2026 (+100,000).");
  assert.equal(
    text[1],
    "The largest driver was volume (+60,000, +6.0% of prior sales), followed by price (like-for-like) (+30,000, +3.0% of prior sales), new configurations (+20,000, +2.0% of prior sales), mix: Product (-10,000, -1.0% of prior sales).",
  );
  assert.equal(
    text[2],
    "Like-for-like price added 30,000, +3.0% of prior sales. It is measured on the 95.0% of current unit sales that matched an exact prior configuration.",
  );
  // Zero lines and the no-units line are left out when they are nil.
  assert.equal(text.some((p) => p.includes("no units")), false);
  assert.equal(text.join(" ").includes("discontinued"), false);
});

test("a fall is worded as a fall and the same input gives the same text", () => {
  const down = { ...result, currentSales: 900_000, effects: [{ key: "volume", label: "Volume", value: -100_000 }] };
  assert.equal(commentary(down, config)[0], "Sales fell 10.0%, from 1,000,000 in 2025 to 900,000 in 2026 (-100,000).");
  assert.deepEqual(commentary(result, config), commentary(result, config));
});

test("two totals rounding to the same short figure still print differently", () => {
  const near = { ...result, priorSales: 2_400, currentSales: 2_440, effects: [] };
  assert.equal(
    commentary(near, config)[0],
    "Sales rose 1.7%, from 2,400 in 2025 to 2,440 in 2026 (+40).",
  );
});

test("fractional totals that would both print whole still read differently", () => {
  const fractional = { ...result, priorSales: 2400.1, currentSales: 2400.2, effects: [] };
  const headline = commentary(fractional, config)[0];
  assert.match(headline, /from 2,400\.1 in 2025 to 2,400\.2 in 2026/);
  const equal = { ...result, priorSales: 2400, currentSales: 2400, effects: [] };
  assert.match(commentary(equal, config)[0], /was unchanged/);
});

test("the change prints the raw change rounded like the bridge table", () => {
  const small = { ...result, priorSales: 100.49, currentSales: 134.51, effects: [] };
  assert.match(commentary(small, config)[0], /\(\+34\)\.$/);
  const tiny = { ...result, priorSales: 100.4, currentSales: 100.6, effects: [] };
  assert.match(commentary(tiny, config)[0], /\(0\)\.$/);
});

test("F9: every unnamed line joins the leftover sum, including one below the threshold", () => {
  const five = ["Product", "Size", "Colour", "Finish", "Material"];
  const f9: BridgeResult = {
    ...result,
    priorSales: 1_000_000,
    currentSales: 1_199_778,
    effects: [
      { key: "volume", label: "Volume", value: 100_000 },
      { key: "price", label: "Price (like-for-like)", value: 20_000 },
      { key: "mix_1", label: "Mix: Product", value: 50_000 },
      { key: "mix_2", label: "Mix: Size", value: 30_000 },
      { key: "mix_3", label: "Mix: Colour", value: -148 },
      { key: "mix_4", label: "Mix: Finish", value: -79 },
      { key: "mix_5", label: "Mix: Material", value: 5 },
      { key: "discontinued", label: "Discontinued configurations", value: 0 },
      { key: "no_units", label: "Sales with no units", value: 0 },
    ],
  };
  const drivers = commentary(f9, { ...config, levels: five.map((name) => ({ name, columns: [name.toLowerCase()] })) })[1];
  assert.match(drivers, /^The largest driver was volume \(\+100,000, \+10\.0% of prior sales\), followed by /);
  assert.ok(drivers.endsWith(" The other 3 lines add up to -222."), drivers);
  // The two zero lines are not counted as leftover lines.
  assert.equal(drivers.includes("Discontinued"), false);
});

test("a single leftover line is named, with the table's amount style", () => {
  const levels = ["Product", "Size", "Colour"];
  const one: BridgeResult = {
    ...result,
    priorSales: 1_000_000,
    currentSales: 1_199_716,
    effects: [
      { key: "volume", label: "Volume", value: 100_000 },
      { key: "price", label: "Price (like-for-like)", value: 50_000 },
      { key: "mix_1", label: "Mix: Product", value: 30_000 },
      { key: "mix_2", label: "Mix: Size", value: -284 },
      { key: "mix_3", label: "Mix: Colour", value: 20_000 },
    ],
  };
  const text = commentary(one, { ...config, levels: levels.map((name) => ({ name, columns: [name.toLowerCase()] })) });
  assert.ok(text[1].endsWith(" Mix: Size adds -284."), text[1]);
});

test("amounts print whole with an ASCII sign, never a decimal or a compact suffix", () => {
  const tiny: BridgeResult = {
    ...result,
    priorSales: 1_000,
    currentSales: 1_001.2,
    effects: [{ key: "price", label: "Price (like-for-like)", value: 1.2 }],
  };
  const text = commentary(tiny, config);
  assert.match(text[2], /^Like-for-like price added 1, /);
  assert.equal(text.join(" ").includes("1.2"), false);
  assert.equal(text.join(" ").includes("−"), false);
  assert.equal(text.slice(1).join(" ").includes("K"), false);
});

test("one leftover line adds up in the singular and two in the plural", () => {
  const many: BridgeResult = {
    ...result,
    priorSales: 10_000_000,
    effects: [
      { key: "volume", label: "Volume", value: 600_000 },
      { key: "price", label: "Price (like-for-like)", value: 300_000 },
      { key: "mix_1", label: "Mix: Product", value: -100_000 },
      { key: "new_config", label: "New configurations", value: 200_000 },
      { key: "discontinued", label: "Discontinued configurations", value: 10_000 },
      { key: "no_units", label: "Sales with no units", value: 0 },
    ],
  };
  assert.match(commentary(many, config)[1], /Discontinued configurations adds \+10,000\.$/);
  const more: BridgeResult = {
    ...many,
    effects: [...many.effects, { key: "mix_2", label: "Mix: Size", value: 20_000 }],
  };
  assert.match(
    commentary(more, { ...config, levels: [...config.levels, { name: "Size", columns: ["size"] }] })[1],
    /The other 2 lines add up to \+30,000\.$/,
  );
});
