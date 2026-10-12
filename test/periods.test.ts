import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePeriods, distinctPeriodSort, loadPeriodList, type PeriodSort } from "../src/app/periods.ts";
import { openDatabase } from "../src/duckdb.ts";

function ordered(values: readonly string[], sort: PeriodSort): string[] {
  return values.slice().toSorted(comparePeriods(sort));
}

test("months 8, 9, and 10 sort as numbers", () => {
  assert.equal(distinctPeriodSort(["10", "8", "9"]), "numeric");
  assert.deepEqual(ordered(["10", "8", "9"], "numeric"), ["8", "9", "10"]);
});

test("four-digit years keep the same order as text", () => {
  const years = ["2026", "2024", "2025"];
  assert.equal(distinctPeriodSort(years), "numeric");
  assert.deepEqual(ordered(years, "numeric"), ["2024", "2025", "2026"]);
  assert.deepEqual(ordered(years, "text"), ["2024", "2025", "2026"]);
});

test("same-width leading zeros keep the same order as text", () => {
  const values = ["11", "01", "10", "02"];
  assert.equal(distinctPeriodSort(values), "numeric");
  assert.deepEqual(ordered(values, "numeric"), ["01", "02", "10", "11"]);
  assert.deepEqual(ordered(values, "text"), ["01", "02", "10", "11"]);
});

test("mixed-width leading zeros sort by the number, then the original string", () => {
  assert.deepEqual(ordered(["10", "9", "8", "09"], "numeric"), ["8", "09", "9", "10"]);
  assert.deepEqual(ordered(["1.0", "01", "1", "-3", "-10"], "numeric"), ["-10", "-3", "01", "1", "1.0"]);
});

test("negative numbers and decimals sort by the number", () => {
  assert.deepEqual(ordered(["4", "-3", "-20", "-10"], "numeric"), ["-20", "-10", "-3", "4"]);
  assert.deepEqual(ordered(["10", "1.5", "9.5", "1.25"], "numeric"), ["1.25", "1.5", "9.5", "10"]);
  assert.deepEqual(ordered(["1.5", "1.10"], "numeric"), ["1.10", "1.5"]);
});

test("integers past 2^53 that collapse to one number break by the original string", () => {
  const values = ["9007199254740993", "9007199254740992"];
  assert.equal(distinctPeriodSort(values), "numeric");
  assert.deepEqual(ordered(values, "numeric"), ["9007199254740992", "9007199254740993"]);
});

test("quarter labels, prefixed labels, and month names stay in text order", () => {
  assert.equal(distinctPeriodSort(["Q3", "Q1", "Q4", "Q2"]), "text");
  assert.deepEqual(ordered(["Q3", "Q1", "Q4", "Q2"], "text"), ["Q1", "Q2", "Q3", "Q4"]);

  assert.equal(distinctPeriodSort(["2025-Q2", "2024-Q4", "2025-Q1"]), "text");
  assert.deepEqual(ordered(["2025-Q2", "2024-Q4", "2025-Q1"], "text"), ["2024-Q4", "2025-Q1", "2025-Q2"]);

  const prefixed = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12"];
  assert.equal(distinctPeriodSort(prefixed), "text");
  assert.deepEqual(ordered(prefixed, "text"), ["P1", "P10", "P11", "P12", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);

  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  assert.equal(distinctPeriodSort(names), "text");
  assert.deepEqual(ordered(names, "text"), ["Apr", "Aug", "Dec", "Feb", "Jan", "Jul", "Jun", "Mar", "May", "Nov", "Oct", "Sep"]);
});

test("date grains and year-to-date labels stay in text order", () => {
  assert.equal(distinctPeriodSort(["2025-10", "2025-03", "2025-09"]), "text");
  assert.deepEqual(ordered(["2025-10", "2025-03", "2025-09"], "text"), ["2025-03", "2025-09", "2025-10"]);
  assert.equal(distinctPeriodSort(["2025 YTD", "2024 YTD"]), "text");
  assert.deepEqual(ordered(["2025 YTD", "2024 YTD"], "text"), ["2024 YTD", "2025 YTD"]);
});

test("a mix of numbers and text, including forms that only look numeric, stays in text order", () => {
  assert.equal(distinctPeriodSort(["10", "8", "9", "Q1"]), "text");
  assert.deepEqual(ordered(["10", "8", "9", "Q1"], "text"), ["10", "8", "9", "Q1"]);
  for (const alien of [" 8", "8 ", "1,000", "1e2", "+8", "1.", ".5"]) {
    assert.equal(distinctPeriodSort(["10", "8", alien]), "text");
  }
  assert.deepEqual(ordered(["10", "1,000", "8"], "text"), ["1,000", "10", "8"]);
});

async function load(values: readonly string[]) {
  const query = await openDatabase();
  await query("SET threads = 1");
  await query("CREATE TABLE periods (p VARCHAR)");
  if (values.length > 0) {
    const list = values.map((value) => `('${value.replaceAll("'", "''")}')`).join(", ");
    await query(`INSERT INTO periods VALUES ${list}`);
  }
  return loadPeriodList(query, '"p"', '"periods"');
}

test("the database list orders months 8, 9, and 10 as numbers", async () => {
  const list = await load(["10", "8", "9"]);
  assert.equal(list.sort, "numeric");
  assert.deepEqual(list.values, ["8", "9", "10"]);
});

test("the database list keeps text order when one value is not a plain number", async () => {
  const list = await load(["10", "8", "9", "Q1"]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["10", "8", "9", "Q1"]);
});

test("an empty period list is text", async () => {
  const list = await load([]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, []);
});

test("integers that collapse in IEEE-754 keep the string tie-break in the database", async () => {
  const list = await load(["9007199254740993", "1", "9007199254740992"]);
  assert.equal(list.sort, "numeric");
  assert.deepEqual(list.values, ["1", "9007199254740992", "9007199254740993"]);
});

test("a capped window keeps the text decision made over the values it dropped", async () => {
  const values = ["#note", ...Array.from({ length: 250 }, (_, index) => String(index + 1))];
  const list = await load(values);
  assert.equal(list.values.length, 200);
  assert.equal(list.values.includes("#note"), false);
  assert.equal(list.values[0], "144");
  assert.equal(list.values.at(-1), "99");
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values.slice().toSorted(comparePeriods(list.sort)), [...list.values]);
  assert.equal(distinctPeriodSort(list.values), "numeric");
});
