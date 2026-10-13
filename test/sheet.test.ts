import assert from "node:assert/strict";
import { test } from "node:test";
import { excelHeaderNames } from "../src/app/sheet.ts";

test("names a blank header from its column index", () => {
  assert.deepEqual(excelHeaderNames(["region", null, "units", "sales"], 4), [
    "region",
    "column1",
    "units",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["region", undefined, "units", "sales"], 4), [
    "region",
    "column1",
    "units",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["region", "", "units", "sales"], 4), [
    "region",
    "column1",
    "units",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["region", "product", "units", null], 4), [
    "region",
    "product",
    "units",
    "column3",
  ]);
});

test("treats spaces and tabs as blank and keeps a non-breaking space", () => {
  assert.deepEqual(excelHeaderNames(["region", "   "], 2), ["region", "column1"]);
  assert.deepEqual(excelHeaderNames(["region", "\t"], 2), ["region", "column1"]);
  assert.deepEqual(excelHeaderNames(["region", " \t "], 2), ["region", "column1"]);
  assert.deepEqual(excelHeaderNames(["region", "\u00A0"], 2), ["region", "\u00A0"]);
});

test("suffixes a repeated header and a generated column name", () => {
  assert.deepEqual(excelHeaderNames(["column1", null, "column1_1"], 3), [
    "column1",
    "column1_1",
    "column1_1_1",
  ]);
  assert.deepEqual(excelHeaderNames(["foo", "foo", "foo"], 3), ["foo", "foo_1", "foo_2"]);
  assert.deepEqual(excelHeaderNames(["foo", "foo_1", "foo"], 3), ["foo", "foo_1", "foo_1_1"]);
  assert.deepEqual(excelHeaderNames(["foo", "foo_2", "foo"], 3), ["foo", "foo_2", "foo_1"]);
  assert.deepEqual(excelHeaderNames(["Column1", null, "sales"], 3), ["Column1", "column1_1", "sales"]);
  assert.deepEqual(excelHeaderNames(["A", "a"], 2), ["A", "a_1"]);
  assert.deepEqual(excelHeaderNames(["column1_1", null], 2), ["column1_1", "column1"]);
});

test("names a title row without skipping it", () => {
  assert.deepEqual(excelHeaderNames(["Sales report FY26", null, null, null], 4), [
    "Sales report FY26",
    "column1",
    "column2",
    "column3",
  ]);
});

test("flattens numbers, dates, formulas, and rich text before naming", () => {
  assert.deepEqual(
    excelHeaderNames(
      [
        2026,
        new Date("2026-01-15T00:00:00.000Z"),
        { result: 3 },
        { richText: [{ text: "sales" }, { text: " net" }] },
      ],
      4,
    ),
    ["2026", "2026-01-15", "3", "sales net"],
  );
  assert.deepEqual(excelHeaderNames(["2026", "2026-01-15", "3", "sales net"], 4), [
    "2026",
    "2026-01-15",
    "3",
    "sales net",
  ]);
  assert.deepEqual(excelHeaderNames([{ text: "units" }], 1), ["units"]);
  assert.deepEqual(excelHeaderNames([{ text: "  " }], 1), ["column0"]);
  assert.deepEqual(excelHeaderNames([{ result: null }], 1), ["column0"]);
  assert.deepEqual(excelHeaderNames([{ result: "" }], 1), ["column0"]);
  assert.deepEqual(excelHeaderNames([{}], 1), ["column0"]);
  assert.deepEqual(excelHeaderNames(["undefined", "null"], 2), ["undefined", "null"]);
});

test("pads a short row and stops at the sheet width", () => {
  assert.deepEqual(excelHeaderNames(["region"], 3), ["region", "column1", "column2"]);
  assert.deepEqual(excelHeaderNames(["region", "product", "units", "sales"], 2), ["region", "product"]);
});
