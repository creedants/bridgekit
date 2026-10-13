import assert from "node:assert/strict";
import { test } from "node:test";
import { excelHeaderNames } from "../src/app/sheet.ts";

test("writes the word undefined for a missing header cell", () => {
  assert.deepEqual(excelHeaderNames(["region", undefined, undefined, undefined], 4), [
    "region",
    "undefined",
    "undefined",
    "undefined",
  ]);
  assert.deepEqual(excelHeaderNames(["region", undefined, "units", "sales"], 4), [
    "region",
    "undefined",
    "units",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["region", null, "units", "sales"], 4), [
    "region",
    "null",
    "units",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["region", "", "units", "sales"], 4), [
    "region",
    "",
    "units",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["region", "product", "units", undefined], 4), [
    "region",
    "product",
    "units",
    "undefined",
  ]);
});

test("keeps spaces and tabs and a non-breaking space", () => {
  assert.deepEqual(excelHeaderNames(["region", "   "], 2), ["region", "   "]);
  assert.deepEqual(excelHeaderNames(["region", "\t"], 2), ["region", "\t"]);
  assert.deepEqual(excelHeaderNames(["region", " \t "], 2), ["region", " \t "]);
  assert.deepEqual(excelHeaderNames(["region", "\u00A0"], 2), ["region", "\u00A0"]);
  assert.deepEqual(excelHeaderNames(["region", "\n"], 2), ["region", "\n"]);
});

test("keeps filled headers as written, including duplicates and non-ASCII case", () => {
  assert.deepEqual(excelHeaderNames(["Ä", "ä", "units", "sales"], 4), ["Ä", "ä", "units", "sales"]);
  assert.deepEqual(excelHeaderNames(["K", "K", "units", "sales"], 4), ["K", "K", "units", "sales"]);
  assert.deepEqual(excelHeaderNames(["ẞ", "ß", "units", "sales"], 4), ["ẞ", "ß", "units", "sales"]);
  assert.deepEqual(excelHeaderNames(["foo", "foo", "foo"], 3), ["foo", "foo", "foo"]);
  assert.deepEqual(excelHeaderNames(["foo", "foo_1", "foo"], 3), ["foo", "foo_1", "foo"]);
  assert.deepEqual(excelHeaderNames(["foo", "foo_2", "foo"], 3), ["foo", "foo_2", "foo"]);
  assert.deepEqual(excelHeaderNames(["A", "a", "A_1", "a_1"], 4), ["A", "a", "A_1", "a_1"]);
  assert.deepEqual(excelHeaderNames(["column1", undefined, "COLUMN1_1", "sales"], 4), [
    "column1",
    "undefined",
    "COLUMN1_1",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["column1", undefined, "column1"], 3), [
    "column1",
    "undefined",
    "column1",
  ]);
  assert.deepEqual(excelHeaderNames(["Column1", undefined, "units", "sales"], 4), [
    "Column1",
    "undefined",
    "units",
    "sales",
  ]);
  assert.deepEqual(excelHeaderNames(["column1_1", undefined, "units", "sales"], 4), [
    "column1_1",
    "undefined",
    "units",
    "sales",
  ]);
});

test("names a title row without skipping it", () => {
  assert.deepEqual(excelHeaderNames(["Sales report FY26", undefined, undefined, undefined], 4), [
    "Sales report FY26",
    "undefined",
    "undefined",
    "undefined",
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
  assert.deepEqual(excelHeaderNames([{ text: "  " }], 1), ["  "]);
  assert.deepEqual(excelHeaderNames([{ result: null }], 1), ["null"]);
  assert.deepEqual(excelHeaderNames([{ result: "" }], 1), [""]);
  assert.deepEqual(excelHeaderNames([{}], 1), [""]);
  assert.deepEqual(excelHeaderNames(["undefined", "null"], 2), ["undefined", "null"]);
});

test("pads a short row and stops at the sheet width", () => {
  assert.deepEqual(excelHeaderNames(["region"], 3), ["region", "undefined", "undefined"]);
  assert.deepEqual(excelHeaderNames(["region", "product", "units", "sales"], 2), ["region", "product"]);
});
