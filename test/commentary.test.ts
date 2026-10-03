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
  assert.match(text[1], /^The largest driver was volume \(\+60K, 6\.0% of prior sales\), followed by price/);
  assert.match(text[2], /Like-for-like price added 30K, 3\.0% of prior sales\. It is measured on the 95\.0%/);
  // Zero lines and the no-units line are left out when they are nil.
  assert.equal(text.some((p) => p.includes("no units")), false);
  assert.equal(text.join(" ").includes("discontinued"), false);
});

test("a fall is worded as a fall and the same input gives the same text", () => {
  const down = { ...result, currentSales: 900_000, effects: [{ key: "volume", label: "Volume", value: -100_000 }] };
  assert.equal(commentary(down, config)[0], "Sales fell 10.0%, from 1M in 2025 to 900K in 2026 (−100K).");
  assert.deepEqual(commentary(result, config), commentary(result, config));
});
