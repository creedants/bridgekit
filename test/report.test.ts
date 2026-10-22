import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeConfig } from "../src/engine.ts";
import { buildReport, moverHeader, terms } from "../src/app/report.ts";

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

const marginConfig: BridgeConfig = { ...config, costColumn: "cost" };

test("sales mover headers keep today literals", () => {
  assert.deepEqual(moverHeader(config), [
    "Prior sales", "Current sales", "Change", "Volume", "Mix", "Price",
    "New config.", "Discontinued", "No units", "Prior price", "Current price", "Price change",
  ]);
});

test("a sales report keeps the sales title and headers", () => {
  const html = build();
  assert.equal(html.includes("<title>Sales bridge: 2025 to 2026</title>"), true, "sales title changed");
  assert.equal(html.includes("<h1>Sales bridge: 2025 to 2026</h1>"), true, "sales heading changed");
  assert.equal(html.includes("% of prior sales"), true, "sales bridge header changed");
  assert.equal(html.includes(`<th class="n">Price</th>`), true, "sales movers header changed");
  assert.equal(html.includes("Margin bridge"), false, "sales report names margin");
});

test("a margin report is titled Margin bridge with the margin headers", () => {
  const html = buildReport({
    config: marginConfig,
    result,
    description: ["Source: sample.csv", "Cost column: cost (bridge is on margin)"],
    movers: { label: "Product", rows: [], columns: ["product"] },
    priceBands: [],
  });
  assert.equal(html.includes("<title>Margin bridge: 2025 to 2026</title>"), true, "margin title is not Margin bridge");
  assert.equal(html.includes("<h1>Margin bridge: 2025 to 2026</h1>"), true, "margin heading is not Margin bridge");
  assert.equal(html.includes("% of prior margin"), true, "margin bridge header is not % of prior margin");
  assert.equal(html.includes("Price and unit cost"), true, "margin movers header is not Price and unit cost");
  assert.equal(html.includes("Sales bridge"), false, "margin report still says Sales bridge");
  assert.equal(html.includes("Cost column"), true, "margin setup lost the cost line");
  assert.equal(html.includes("cost (bridge is on margin)"), true, "margin setup lost the margin note");
});

test("margin mover headers and terms name the unit-margin figures", () => {
  assert.deepEqual(moverHeader(marginConfig), [
    "Prior margin", "Current margin", "Change", "Volume", "Mix", "Price and unit cost",
    "New config.", "Discontinued", "No units", "Prior unit margin", "Current unit margin", "Unit margin change",
  ]);
  const t = terms(marginConfig);
  assert.equal(t.bridgeTitle, "Margin bridge");
  assert.equal(t.ofPrior, "% of prior margin");
  assert.equal(t.priceEffect, "Price and unit cost");
  assert.equal(t.priorPrice, "Prior unit margin");
  assert.equal(t.currentPrice, "Current unit margin");
  assert.equal(t.priceChange, "Unit margin change");
  assert.equal(t.hintUnits, "Unit margins exclude sales with no units.");
  assert.equal(
    t.hintChange,
    "Unit margin change is the change in average unit margin and includes mix inside the row.",
  );
});

test("sales terms keep today literals", () => {
  const t = terms(config);
  assert.equal(t.bridgeTitle, "Sales bridge");
  assert.equal(t.ofPrior, "% of prior sales");
  assert.equal(t.priceEffect, "Price");
  assert.equal(t.priorPrice, "Prior price");
  assert.equal(t.currentPrice, "Current price");
  assert.equal(t.priceChange, "Price change");
  assert.equal(t.hintUnits, "Prices exclude sales with no units.");
  assert.equal(
    t.hintChange,
    "Price change is the change in average price and includes mix inside the row.",
  );
});
