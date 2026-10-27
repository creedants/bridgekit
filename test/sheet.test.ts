import assert from "node:assert/strict";
import { test } from "node:test";
import { excelHeaderNames, excelHoleIndexes, firstSheetAsCsv, holeRenames } from "../src/app/sheet.ts";

async function formulaWorkbook(): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["period", "units", { formula: "1+1" }]);
  sheet.addRow(["2025", 10, { formula: "B2*C2" }]);
  sheet.addRow(["2025", 20, { formula: "B3*C3", result: "" }]);
  return workbook.xlsx.writeBuffer();
}

async function formulaFile(): Promise<File> {
  return new File([await formulaWorkbook()], "book.xlsx");
}

async function datedFormulaWorkbook(): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["period", "day", "units", { formula: "1+1" }]);
  sheet.addRow(["2025", new Date(Date.UTC(2025, 0, 15)), 10, { formula: "C2*4" }]);
  sheet.addRow(["2025", new Date(Date.UTC(2025, 1, 20)), 20, { formula: "C3*4", result: "" }]);
  return workbook.xlsx.writeBuffer();
}

async function headerOnlyWorkbook(): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["period", "units"]);
  return workbook.xlsx.writeBuffer();
}

async function rewriteWorkbook(
  buffer: ArrayBuffer,
  edits: Record<string, (xml: string) => string>,
): Promise<File> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  for (const [path, edit] of Object.entries(edits)) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`The workbook has no ${path}.`);
    zip.file(path, edit(await entry.async("text")));
  }
  return new File([await zip.generateAsync({ type: "arraybuffer" })], "book.xlsx");
}

function replaceOnce(xml: string, from: string, to: string): string {
  const next = xml.replace(from, to);
  if (next === xml) throw new Error(`The workbook XML does not hold ${from}.`);
  return next;
}

// Some writers save a part with every element name bound to a prefix instead of
// the default namespace. The prefix is declared on the root against that root's
// own namespace, so the part means exactly what the unprefixed one means.
function prefixPart(xml: string, prefix: string): string {
  const root = /<([A-Za-z_][\w.-]*)([^>]*)>/.exec(xml);
  if (!root) throw new Error("The part has no root element.");
  const namespace = /(?:^|\s)xmlns\s*=\s*"([^"]*)"/.exec(root[2]);
  if (!namespace) throw new Error("The part root declares no default namespace.");
  const insertAt = root.index + 1 + root[1].length;
  const opened = `${xml.slice(0, insertAt)} xmlns:${prefix}="${namespace[1]}"${xml.slice(insertAt)}`;
  return opened.replace(
    /<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g,
    (_, slash: string, name: string) => `<${slash}${prefix}:${name}`,
  );
}

// A styled but empty row 1, with every real row and cell reference moved down one.
function prependStyledBlankRow(xml: string): string {
  const moved = xml
    .replace(/(<row\b[^>]*?\br=")(\d+)(")/g, (_, head, number, tail) => `${head}${Number(number) + 1}${tail}`)
    .replace(
      /(<c\b[^>]*?\br=")([A-Z]+)(\d+)(")/g,
      (_, head, column, number, tail) => `${head}${column}${Number(number) + 1}${tail}`,
    )
    .replace(/(<dimension\b[^>]*?\bref=")([^"]*)(")/, (_, head, ref, tail) =>
      `${head}${ref.replace(/([A-Z]+)(\d+)/g, (__: string, column: string, number: string) => `${column}${Number(number) + 1}`)}${tail}`,
    );
  return moved.replace(/<sheetData>/, '<sheetData><row r="1"><c r="A1" s="0"/></row>');
}

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

test("counts a formula header under a leading styled blank row as the header", async () => {
  const book = await rewriteWorkbook(await formulaWorkbook(), {
    "xl/worksheets/sheet1.xml": prependStyledBlankRow,
  });
  const loaded = await firstSheetAsCsv(book);
  assert.equal(loaded.csv.split("\n").length, 3);
  assert.equal(loaded.formulaBlanks, 1);
});

test("finds the first sheet through a relative and through an absolute target", async () => {
  const relative = await firstSheetAsCsv(await formulaFile());
  const absolute = await firstSheetAsCsv(
    await rewriteWorkbook(await formulaWorkbook(), {
      "xl/_rels/workbook.xml.rels": (xml) =>
        replaceOnce(xml, 'Target="worksheets/sheet1.xml"', 'Target="/xl/worksheets/sheet1.xml"'),
    }),
  );
  assert.equal(relative.formulaBlanks, 1);
  assert.equal(absolute.formulaBlanks, 1);
  assert.equal(absolute.csv, relative.csv);
});

async function twoSheetWorkbook(): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const skipped = workbook.addWorksheet("skipped");
  skipped.addRow(["period", "units"]);
  skipped.addRow(["2025", { formula: "1+1" }]);
  const used = workbook.addWorksheet("used");
  used.addRow(["period", "units"]);
  used.addRow(["2026", 20]);
  return workbook.xlsx.writeBuffer();
}

test("counts nothing when the skipped first sheet resolves to a different target form", async () => {
  const targets = [
    "./worksheets/sheet1.xml",
    "../xl/worksheets/sheet1.xml",
    "../../xl/worksheets/sheet1.xml",
    "/../../xl/worksheets/sheet1.xml",
  ];
  for (const target of targets) {
    const book = await rewriteWorkbook(await twoSheetWorkbook(), {
      "xl/_rels/workbook.xml.rels": (xml) =>
        replaceOnce(xml, 'Target="worksheets/sheet1.xml"', `Target="${target}"`),
    });
    const loaded = await firstSheetAsCsv(book);
    assert.equal(loaded.csv, "period,units\n2026,20", target);
    assert.equal(loaded.formulaBlanks, 0, target);
  }
});

test("counts the imported sheet's formulas, not a skipped sheet's matching rows", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const skipped = workbook.addWorksheet("skipped");
  skipped.addRow(["period", "units"]);
  skipped.addRow(["2025", { formula: "1+1" }]);
  skipped.addRow(["2025", { formula: "2+2" }]);
  const used = workbook.addWorksheet("used");
  used.addRow(["period", "units"]);
  used.addRow(["2026", { formula: "3+3" }]);
  used.addRow(["2026", 30]);
  const book = await rewriteWorkbook(await workbook.xlsx.writeBuffer(), {
    "xl/_rels/workbook.xml.rels": (xml) =>
      replaceOnce(xml, 'Target="worksheets/sheet1.xml"', 'Target="./worksheets/sheet1.xml"'),
  });
  const loaded = await firstSheetAsCsv(book);
  assert.equal(loaded.csv, "period,units\n2026,\n2026,30");
  assert.equal(loaded.formulaBlanks, 1);
});

test("reads a single-quoted worksheet relationship id", async () => {
  const quotedSheetId = await firstSheetAsCsv(
    await rewriteWorkbook(await formulaWorkbook(), {
      "xl/workbook.xml": (xml) => replaceOnce(xml, 'r:id="rId4"', "r:id='rId4'"),
    }),
  );
  assert.equal(quotedSheetId.formulaBlanks, 1);
  const quotedRelationship = await firstSheetAsCsv(
    await rewriteWorkbook(await formulaWorkbook(), {
      "xl/_rels/workbook.xml.rels": (xml) => replaceOnce(xml, 'Id="rId4"', "Id='rId4'"),
    }),
  );
  assert.equal(quotedRelationship.formulaBlanks, 1);
});

test("loads a workbook whose worksheet and shared strings use a namespace prefix", async () => {
  const book = await formulaWorkbook();
  const plain = await firstSheetAsCsv(new File([book], "book.xlsx"));
  const prefixed = await firstSheetAsCsv(
    await rewriteWorkbook(book, {
      "xl/worksheets/sheet1.xml": (xml) => prefixPart(xml, "x"),
      "xl/sharedStrings.xml": (xml) => prefixPart(xml, "sst"),
    }),
  );
  assert.equal(prefixed.csv, plain.csv);
  assert.equal(prefixed.formulaBlanks, plain.formulaBlanks);
  assert.equal(prefixed.formulaBlanks, 1);
});

test("loads a workbook whose every spreadsheet part uses a namespace prefix", async () => {
  const book = await datedFormulaWorkbook();
  const plain = await firstSheetAsCsv(new File([book], "book.xlsx"));
  const prefixed = await firstSheetAsCsv(
    await rewriteWorkbook(book, {
      "xl/worksheets/sheet1.xml": (xml) => prefixPart(xml, "x"),
      "xl/sharedStrings.xml": (xml) => prefixPart(xml, "sst"),
      "xl/styles.xml": (xml) => prefixPart(xml, "st"),
      "xl/workbook.xml": (xml) => prefixPart(xml, "w"),
      "xl/_rels/workbook.xml.rels": (xml) => prefixPart(xml, "rel"),
    }),
  );
  // The date is the cell that reads back as a serial number when the styles
  // part does not reach the reader.
  assert.match(plain.csv, /2025-01-15/);
  assert.equal(prefixed.csv, plain.csv);
  assert.equal(prefixed.formulaBlanks, plain.formulaBlanks);
  assert.equal(prefixed.formulaBlanks, 1);
});

test("rejects a prefixed workbook with no data rows instead of loading it empty", async () => {
  const book = await rewriteWorkbook(await headerOnlyWorkbook(), {
    "xl/worksheets/sheet1.xml": (xml) => prefixPart(xml, "x"),
  });
  await assert.rejects(firstSheetAsCsv(book), /The first sheet of that workbook has no data rows\./);
});

async function payloadWorkbook(): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["period", "units", "check"]);
  sheet.addRow([2025, 10, { formula: "B2*4" }]);
  sheet.addRow([2026, 20, { formula: "B3*4", result: 80 }]);
  return workbook.xlsx.writeBuffer();
}

type SheetLoad = { csv: string; holes: readonly number[]; formulaBlanks: number };

// The payload spells a prefixed `<v/>` inside markup the repair must not touch,
// so a plain string rewrite would leave a bare `<v/>` the formula scan reads as
// a saved result. The prefixed twin prefixes the formula element only.
async function payloadTwins(
  formula: (open: string, close: string) => string,
): Promise<{ plain: SheetLoad; prefixed: SheetLoad }> {
  const book = await payloadWorkbook();
  const edit = (xml: string, prefix: string) =>
    replaceOnce(xml, `<${prefix}f>B2*4</${prefix}f>`, formula(`<${prefix}f>`, `</${prefix}f>`));
  const plain = await firstSheetAsCsv(
    await rewriteWorkbook(book, { "xl/worksheets/sheet1.xml": (xml) => edit(xml, "") }),
  );
  const prefixed = await firstSheetAsCsv(
    await rewriteWorkbook(book, {
      "xl/worksheets/sheet1.xml": (xml) => edit(prefixPart(xml, "x"), "x:"),
    }),
  );
  return { plain, prefixed };
}

function assertPayloadTwins(plain: SheetLoad, prefixed: SheetLoad): void {
  assert.equal(plain.csv, "period,units,check\n2025,10,\n2026,20,80");
  assert.equal(plain.formulaBlanks, 1);
  assert.equal(prefixed.csv, plain.csv);
  assert.equal(prefixed.formulaBlanks, plain.formulaBlanks);
}

test("keeps a comment in a prefixed worksheet out of the formula count", async () => {
  const { plain, prefixed } = await payloadTwins((open, close) => `${open}B2*4${close}<!-- <x:v/> -->`);
  assertPayloadTwins(plain, prefixed);
});

test("keeps a processing instruction in a prefixed worksheet out of the formula count", async () => {
  const { plain, prefixed } = await payloadTwins((open, close) => `${open}B2*4${close}<?review <x:v/> ?>`);
  assertPayloadTwins(plain, prefixed);
});

test("keeps a CDATA payload in a prefixed worksheet formula out of the formula count", async () => {
  const { plain, prefixed } = await payloadTwins(
    (open, close) => `${open}IF(B2&gt;0,"<![CDATA[<x:v/>]]>","")${close}`,
  );
  assertPayloadTwins(plain, prefixed);
});
