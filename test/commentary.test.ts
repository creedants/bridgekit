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
  assert.equal(text[0], "Sales rose 10.0%, from 1M in 2025 to 1.1M in 2026 (+100K).");
  assert.match(text[1], /^The largest driver was volume \(\+60K, \+6\.0% of prior sales\), followed by price/);
  assert.match(text[1], /mix: Product \(−10K, -1\.0% of prior sales\)/);
  assert.match(text[2], /Like-for-like price added 30K, \+3\.0% of prior sales\. It is measured on the 95\.0%/);
  // Zero lines and the no-units line are left out when they are nil.
  assert.equal(text.some((p) => p.includes("no units")), false);
  assert.equal(text.join(" ").includes("discontinued"), false);
});

test("a fall is worded as a fall and the same input gives the same text", () => {
  const down = { ...result, currentSales: 900_000, effects: [{ key: "volume", label: "Volume", value: -100_000 }] };
  assert.equal(commentary(down, config)[0], "Sales fell 10.0%, from 1M in 2025 to 900K in 2026 (−100K).");
  assert.deepEqual(commentary(result, config), commentary(result, config));
});

test("two totals rounding to the same short figure still print differently", () => {
  const near = { ...result, priorSales: 2_400, currentSales: 2_440, effects: [] };
  assert.equal(
    commentary(near, config)[0],
    "Sales rose 1.7%, from 2.4K in 2025 to 2.44K in 2026 (+40).",
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
  assert.match(commentary(many, config)[1], /The other line adds up to \+10K\./);
  const more: BridgeResult = {
    ...many,
    effects: [...many.effects, { key: "mix_2", label: "Mix: Size", value: 20_000 }],
  };
  assert.match(commentary(more, { ...config, levels: [...config.levels, { name: "Size", columns: ["size"] }] })[1], /The other 2 lines add up to \+30K\./);
});
