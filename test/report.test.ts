import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeConfig } from "../src/engine.ts";
import { buildReport } from "../src/app/report.ts";

const config: BridgeConfig = {
  table: "sales",
  periodColumn: "period",
  prior: "2025",
  current: "2026",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
};

const result = {
  priorSales: 1000,
  currentSales: 900,
  effects: [{ key: "volume", label: "Volume", value: -100 }],
  coverage: [],
  cellsTable: "bridge_cells",
};

const build = (overrides: Partial<Parameters<typeof buildReport>[0]> = {}) =>
  buildReport({
    config,
    result,
    description: ["Source: sample.csv", "Periods: 2025 to 2026 (period, by month)"],
    movers: { label: "Product", rows: [], columns: ["product"] },
    priceBands: [],
    ...overrides,
  });

const moverRow = (name: string) => ({
  product: name,
  s0: 0,
  s1: 0,
  z0: 0,
  z1: 0,
  volume: 0,
  mix_1: 0,
  price: 0,
});

test("a mover name that begins with a formula character takes a leading apostrophe", () => {
  for (const name of ["=1+1", "+SUM(1)", "-name", "@name"]) {
    const html = build({ movers: { label: "Product", rows: [moverRow(name)], columns: ["product"] } });
    assert.equal(html.includes(`<td>'${name}</td>`), true, `${name} is not written as text`);
    assert.equal(html.includes(`<td>${name}</td>`), false, `${name} is still a formula`);
  }
});

test("a setup value that begins with = takes a leading apostrophe", () => {
  const html = build({ description: ["Source: =1+1.csv"] });
  assert.equal(html.includes(`<td class="n">'=1+1.csv</td>`), true, "setup value is not written as text");
  assert.equal(html.includes(`<td class="n">=1+1.csv</td>`), false, "setup value is still a formula");
});

test("a negative effect amount stays a formatted number", () => {
  const html = build();
  assert.equal(html.includes(`<td class="n">-100</td>`), true, "negative amount changed");
  assert.equal(html.includes(`<td class="n">'-100</td>`), false, "negative amount took an apostrophe");
});
