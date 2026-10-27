import assert from "node:assert/strict";
import { test } from "node:test";
import { excelHeaderNames, excelHoleIndexes, firstSheetAsCsv, holeRenames } from "../src/app/sheet.ts";

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

test("records only a missing header cell as a hole", () => {
  assert.deepEqual(excelHoleIndexes(["region", undefined, undefined, undefined], 4), [1, 2, 3]);
  assert.deepEqual(excelHoleIndexes(["region", undefined, "units", "sales"], 4), [1]);
  assert.deepEqual(excelHoleIndexes(["region", null, "units", "sales"], 4), []);
  assert.deepEqual(excelHoleIndexes(["region", "", "units", "sales"], 4), []);
  assert.deepEqual(excelHoleIndexes(["region", "   ", "units", "sales"], 4), []);
  assert.deepEqual(excelHoleIndexes(["region", "\t", "units", "sales"], 4), []);
  assert.deepEqual(excelHoleIndexes(["region", "\u00A0", "units", "sales"], 4), []);
  assert.deepEqual(excelHoleIndexes(["region", "\n", "units", "sales"], 4), []);
  assert.deepEqual(excelHoleIndexes(["undefined", undefined, "sales"], 3), [1]);
  assert.deepEqual(excelHoleIndexes([undefined, "product", "units", "sales"], 4), [0]);
  assert.deepEqual(excelHoleIndexes(["region"], 3), [1, 2]);
  assert.deepEqual(excelHoleIndexes([{ result: null }], 1), []);
  assert.deepEqual(excelHoleIndexes([{ text: "  " }], 1), []);
  assert.deepEqual(excelHoleIndexes(["undefined", "null"], 2), []);
});

test("renames a missing column without taking a filled header", () => {
  assert.deepEqual(holeRenames(["region", "undefined", "undefined_1", "undefined_2"], [1, 2, 3]), [
    { index: 1, from: "undefined", to: "column1" },
    { index: 2, from: "undefined_1", to: "column2" },
    { index: 3, from: "undefined_2", to: "column3" },
  ]);
  assert.deepEqual(holeRenames(["column1", "undefined", "COLUMN1_1", "sales"], [1]), [
    { index: 1, from: "undefined", to: "column1_2" },
  ]);
  assert.deepEqual(holeRenames(["column1", "undefined", "column1_1"], [1]), [
    { index: 1, from: "undefined", to: "column1_2" },
  ]);
  assert.deepEqual(holeRenames(["undefined", "undefined_1", "sales"], [1]), [
    { index: 1, from: "undefined_1", to: "column1" },
  ]);
  assert.deepEqual(holeRenames(["undefined", "product", "units", "sales"], [0]), [
    { index: 0, from: "undefined", to: "column0" },
  ]);
  assert.deepEqual(holeRenames(["undefined", "Column0"], [0]), [
    { index: 0, from: "undefined", to: "column0_1" },
  ]);
  assert.deepEqual(holeRenames(["Column1", "undefined", "units", "sales"], [1]), [
    { index: 1, from: "undefined", to: "column1_1" },
  ]);
  assert.deepEqual(holeRenames(["column1_1", "undefined", "units", "sales"], [1]), [
    { index: 1, from: "undefined", to: "column1" },
  ]);
  assert.deepEqual(holeRenames(["Sales report FY26", "undefined", "undefined_1", "undefined_2"], [1, 2, 3]), [
    { index: 1, from: "undefined", to: "column1" },
    { index: 2, from: "undefined_1", to: "column2" },
    { index: 3, from: "undefined_2", to: "column3" },
  ]);
  assert.deepEqual(holeRenames(["region", "undefined", "units", "sales"], [1]), [
    { index: 1, from: "undefined", to: "column1" },
  ]);
  assert.deepEqual(holeRenames(["region", "product", "units", "undefined"], [3]), [
    { index: 3, from: "undefined", to: "column3" },
  ]);
  assert.deepEqual(holeRenames(["foo", "undefined", "foo_1"], [1]), [
    { index: 1, from: "undefined", to: "column1" },
  ]);
  assert.deepEqual(holeRenames(["undefined", "sales"], []), []);
  const names = ["region", "undefined", "units", "undefined_1"];
  const holes = [3, 1];
  assert.deepEqual(holeRenames(names, holes), [
    { index: 1, from: "undefined", to: "column1" },
    { index: 3, from: "undefined_1", to: "column3" },
  ]);
  assert.deepEqual(names, ["region", "undefined", "units", "undefined_1"]);
  assert.deepEqual(holes, [3, 1]);
  assert.throws(() => holeRenames(["region"], [1]), RangeError);
  assert.throws(() => holeRenames(["region"], [1.5]), RangeError);
  assert.throws(() => holeRenames(["region"], [-1]), RangeError);
});

test("counts data-row formulas with no cached result and skips the header and cached results", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["period", "units", "sales", { formula: "1+1" }]);
  sheet.addRow(["2025", 10, 100, { formula: "B2*C2" }]);
  sheet.addRow(["2025", 20, 200, { formula: "B3*C3", result: 400 }]);
  sheet.addRow(["2026", 30, 300, { formula: "B4*C4", result: 0 }]);
  sheet.addRow(["2026", 40, 400, { formula: "B5*C5", result: false }]);
  sheet.addRow(["2026", 50, 500, { formula: "B6*C6", result: "" }]);
  sheet.addRow(["2026", 60, 600, { formula: "B7*C7", result: "hi" }]);
  sheet.addRow(["2026", 70, 700, { formula: "B8*C8" }]);
  const book = new File([await workbook.xlsx.writeBuffer()], "book.xlsx");
  const loaded = await firstSheetAsCsv(book);
  assert.equal(loaded.formulaBlanks, 2);
});

test("counts a single blank formula and no blanks for a fully cached sheet", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const single = new ExcelJS.Workbook();
  const one = single.addWorksheet("sales");
  one.addRow(["period", "units"]);
  one.addRow(["2025", { formula: "B2*2" }]);
  const oneBook = new File([await single.xlsx.writeBuffer()], "one.xlsx");
  assert.equal((await firstSheetAsCsv(oneBook)).formulaBlanks, 1);
  const cached = new ExcelJS.Workbook();
  const two = cached.addWorksheet("sales");
  two.addRow(["period", "units"]);
  two.addRow(["2025", { formula: "B2*2", result: 10 }]);
  two.addRow(["2026", { formula: "B3*2", result: 0 }]);
  const cachedBook = new File([await cached.xlsx.writeBuffer()], "cached.xlsx");
  assert.equal((await firstSheetAsCsv(cachedBook)).formulaBlanks, 0);
});
