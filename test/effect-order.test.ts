import assert from "node:assert/strict";
import { test } from "node:test";
import { effectColumns, type BridgeConfig } from "../src/engine.ts";
import { moverHeader, trendHeader } from "../src/app/report.ts";
import { roundBridge } from "../src/summary.ts";

const base: BridgeConfig = {
  table: "sales",
  periodColumn: "period",
  prior: "2025",
  current: "2026",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [
    { name: "Model", columns: ["model"] },
    { name: "Finish", columns: ["finish"] },
  ],
};

const tail = ["New configurations", "Discontinued configurations", "Sales with no units"];

test("a sales bridge lists price, then volume, then one mix step per attribute, then the tail", () => {
  assert.deepEqual(
    effectColumns(base).map((column) => column.label),
    ["Price (like-for-like)", "Volume", "Mix: Model", "Mix: Finish", ...tail],
  );
});

test("a margin bridge lists price and unit cost first, then volume and mix", () => {
  assert.deepEqual(
    effectColumns({ ...base, costColumn: "cost" }).map((column) => column.label),
    ["Price", "Unit cost", "Volume", "Mix: Model", "Mix: Finish", ...tail],
  );
});

test("a gross bridge lists list price and discounts first, then volume and mix", () => {
  assert.deepEqual(
    effectColumns({ ...base, grossColumn: "gross" }).map((column) => column.label),
    ["List price", "Discounts", "Volume", "Mix: Model", "Mix: Finish", ...tail],
  );
});

test("the movers header puts price before volume and mix, for sales and for margin", () => {
  assert.deepEqual(moverHeader(base), [
    "Prior sales", "Current sales", "Change", "Price", "Volume", "Mix",
    "New config.", "Discontinued", "No units", "Prior price", "Current price", "Price change",
  ]);
  assert.deepEqual(moverHeader({ ...base, costColumn: "cost" }), [
    "Prior margin", "Current margin", "Change", "Price and unit cost", "Volume", "Mix",
    "New config.", "Discontinued", "No units", "Prior unit margin", "Current unit margin", "Unit margin change",
  ]);
});

test("the trend header lists price before volume and mix", () => {
  const labels = trendHeader(base).map((column) => column.label);
  assert.ok(labels.indexOf("Price") < labels.indexOf("Volume"), `Price is not before Volume in ${labels.join(", ")}`);
  assert.ok(labels.indexOf("Price") < labels.indexOf("Mix"), `Price is not before Mix in ${labels.join(", ")}`);
  assert.deepEqual(labels, [
    "Periods", "Change", "Price", "Price, % of prior", "Price effect", "Volume", "Mix", "New and discontinued", "No units",
  ]);
});

test("a rank array gives the same values whichever order the lines are passed in", () => {
  const forward = roundBridge(10, 10, [2.5, -2.5], 1, [0, 1]);
  const reversed = roundBridge(10, 10, [-2.5, 2.5], 1, [1, 0]);
  assert.deepEqual(forward.values, [3, -3], `the ranked lines rounded to ${forward.values.join(", ")}`);
  assert.deepEqual(reversed.values.toReversed(), [3, -3], `the reversed lines rounded to ${reversed.values.join(", ")}`);
  assert.equal(forward.values.reduce((sum, value) => sum + value, 0), 0, "the ranked lines do not add up to the change");
});
