import assert from "node:assert/strict";
import { test } from "node:test";
import { fileProblem, MAX_PERIOD_VALUES, type FileProblemInput } from "../src/app/fileProblems.ts";
import type { Column } from "../src/app/setup.ts";

const text = (name: string): Column => ({ name, type: "VARCHAR" });
const number = (name: string): Column => ({ name, type: "INTEGER" });
const date = (name: string): Column => ({ name, type: "DATE" });

function input(over: Partial<FileProblemInput>): FileProblemInput {
  return {
    columns: [],
    rows: 0,
    periodColumn: "",
    periods: [],
    unitsColumn: "",
    salesColumn: "",
    ...over,
  };
}

const HEALTHY = input({
  columns: [number("period"), text("design"), number("units"), number("sales")],
  rows: 4,
  periodColumn: "period",
  periods: ["2024", "2025"],
  unitsColumn: "units",
  salesColumn: "sales",
});

test("the sample file and any file that bridges give no message", () => {
  const sample = input({
    columns: [number("year"), text("customer"), text("design"), number("jobs"), number("sales")],
    rows: 1000,
    periodColumn: "year",
    periods: ["2024", "2025", "2026"],
    unitsColumn: "jobs",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(sample), { kind: "none" });
  assert.deepEqual(fileProblem(HEALTHY), { kind: "none" });
});

test("a real date column compared by year stays under the period label limit", () => {
  const dates = input({
    columns: [date("order_date"), text("design"), number("units"), number("sales")],
    rows: 300,
    periodColumn: "order_date",
    periods: ["2024", "2025"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(dates), { kind: "none" });
});

test("a 0-byte CSV and a header-only file say the file has no data rows", () => {
  const empty = input({ columns: [text("column0")], rows: 0, periodColumn: "", periods: [] });
  assert.deepEqual(fileProblem(empty), {
    kind: "reason",
    message: "This file has no data rows, so there is nothing to bridge.",
  });

  // A header-only file has its columns but every one is text and no period.
  const headerOnly = input({
    columns: [text("period"), text("design"), text("units"), text("sales")],
    rows: 0,
    periodColumn: "period",
    periods: [],
    unitsColumn: "",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(headerOnly), {
    kind: "reason",
    message: "This file has no data rows, so there is nothing to bridge.",
  });
});

test("a period column with one value says a bridge compares two periods", () => {
  const onePeriod = input({ ...HEALTHY, periods: ["2025"] });
  assert.deepEqual(fileProblem(onePeriod), {
    kind: "reason",
    message: 'The period column "period" has only one value, and a bridge compares two periods.',
  });
});

test("a text column named like the missing measure names that column", () => {
  const salesIsText = input({
    columns: [number("period"), text("design"), number("units"), text("net_sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(salesIsText), {
    kind: "reason",
    message: 'Sales must be a column of numbers, and "net_sales" holds text.',
  });

  const unitsIsText = input({
    columns: [number("period"), text("design"), text("qty"), number("sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(unitsIsText), {
    kind: "reason",
    message: 'Units must be a column of numbers, and "qty" holds text.',
  });
});

test("the message goes once the measure holds a numeric column", () => {
  const picked = input({
    columns: [number("period"), text("design"), number("units"), text("net_sales")],
    rows: 4,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "units",
  });
  assert.deepEqual(fileProblem(picked), { kind: "none" });
});

test("a file with no column of numbers says the measures must be numbers", () => {
  const attributesOnly = input({
    columns: [text("period"), text("design"), text("coating"), text("material")],
    rows: 12,
    periodColumn: "period",
    periods: ["2025", "2026"],
    unitsColumn: "",
    salesColumn: "",
  });
  assert.deepEqual(fileProblem(attributesOnly), {
    kind: "reason",
    message: "Sales and Units must be columns of numbers, and this file has none.",
  });
});

test("a period column with very many values is a note beside the general hint", () => {
  const periods = Array.from({ length: 200 }, (_, i) => `2023-${String(i).padStart(3, "0")}`);
  const mixedDates = input({
    columns: [text("order_date"), text("design"), number("units"), number("sales")],
    rows: 300,
    periodColumn: "order_date",
    periods,
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(mixedDates), {
    kind: "note",
    message: `The period column "order_date" holds more than ${MAX_PERIOD_VALUES} values, and a period column should hold a few period labels such as years or months.`,
  });
});

test("the period label limit fires one value above it and not at it", () => {
  const periods = (count: number) => Array.from({ length: count }, (_, i) => `label-${i}`);
  const atLimit = { ...HEALTHY, periods: periods(MAX_PERIOD_VALUES) };
  assert.deepEqual(fileProblem(atLimit), { kind: "none" });
  const overLimit = { ...HEALTHY, periods: periods(MAX_PERIOD_VALUES + 1) };
  assert.equal(fileProblem(overLimit).kind, "note");
});

test("no message without a period column picked", () => {
  const unpicked = { ...HEALTHY, periodColumn: "", periods: [] };
  assert.deepEqual(fileProblem(unpicked), { kind: "none" });
});

test("a text column named like a value in a non-measure role is left alone", () => {
  // "price_note" is text and the tool already guards against it, but a column
  // named like the period column must never be offered as its own fix.
  const periodNamedLikeValue = input({
    columns: [text("period_value"), text("design"), number("units"), number("sales")],
    rows: 4,
    periodColumn: "period_value",
    periods: ["2025", "2026"],
    unitsColumn: "units",
    salesColumn: "sales",
  });
  assert.deepEqual(fileProblem(periodNamedLikeValue), { kind: "none" });
});
