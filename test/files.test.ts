import assert from "node:assert/strict";
import { test } from "node:test";
import { toCsv, toExportCsv, toExportTsv, toTsv } from "../src/app/files.ts";

test("toCsv leaves the Excel upload rows unchanged", () => {
  const header = ["date", "@product", "units", "sales", "net_sales", "negative_numeric", "negative_text"];
  const rows = [
    ["2025-01-15", "-name", 10, 100, "-10", -12.5, "-12.5"],
    ["2026-01-15", "-name", 10, 120, "-15", -12.5, "-12.5"],
    ["2025-01-15", "+name", 10, 100, "-20", -12.5, "-12.5"],
    ["2026-01-15", "+name", 10, 120, "-30", -12.5, "-12.5"],
    ["2025-01-15", "=1+1", 10, 100, "-30", -12.5, "-12.5"],
    ["2026-01-15", "=1+1", 10, 120, "-45", -12.5, "-12.5"],
    ["2025-01-15", "@name", 10, 100, "-40", -12.5, "-12.5"],
    ["2026-01-15", "@name", 10, 120, "-60", -12.5, "-12.5"],
  ];
  assert.equal(
    toCsv(header.map(String), rows),
    [
      "date,@product,units,sales,net_sales,negative_numeric,negative_text",
      "2025-01-15,-name,10,100,-10,-12.5,-12.5",
      "2026-01-15,-name,10,120,-15,-12.5,-12.5",
      "2025-01-15,+name,10,100,-20,-12.5,-12.5",
      "2026-01-15,+name,10,120,-30,-12.5,-12.5",
      "2025-01-15,=1+1,10,100,-30,-12.5,-12.5",
      "2026-01-15,=1+1,10,120,-45,-12.5,-12.5",
      "2025-01-15,@name,10,100,-40,-12.5,-12.5",
      "2026-01-15,@name,10,120,-60,-12.5,-12.5",
    ].join("\n"),
  );
});

test("export writers neutralise formula text and the upload writers do not", () => {
  const cell = (
    value: unknown,
    exportedCsv: string,
    exportedTsv: string,
    ingestedCsv: string,
    ingestedTsv: string,
  ) => {
    assert.equal(toExportCsv(["h"], [[value]]), exportedCsv);
    assert.equal(toExportTsv(["h"], [[value]]), exportedTsv);
    assert.equal(toCsv(["h"], [[value]]), ingestedCsv);
    assert.equal(toTsv(["h"], [[value]]), ingestedTsv);
  };
  const unchanged = (value: unknown, text: string) => cell(value, text, text, text, text);

  cell("=1+1", "h\n'=1+1", "h\n'=1+1", "h\n=1+1", "h\n=1+1");
  cell("+SUM(1)", "h\n'+SUM(1)", "h\n'+SUM(1)", "h\n+SUM(1)", "h\n+SUM(1)");
  cell("-2+3", "h\n'-2+3", "h\n'-2+3", "h\n-2+3", "h\n-2+3");
  cell("@x", "h\n'@x", "h\n'@x", "h\n@x", "h\n@x");
  cell("\tcmd", "h\n'\tcmd", 'h\n"\'\tcmd"', "h\n\tcmd", "h\n\tcmd");
  cell("\r=cmd", 'h\n"\'\r=cmd"', 'h\n"\'\r=cmd"', "h\n\r=cmd", "h\n\r=cmd");
  cell("abc\r=1+1", 'h\n"abc\r=1+1"', 'h\n"abc\r=1+1"', "h\nabc\r=1+1", "h\nabc\r=1+1");
  cell("=a,b", 'h\n"\'=a,b"', "h\n'=a,b", 'h\n"=a,b"', "h\n=a,b");
  cell('say "hi"', 'h\n"say ""hi"""', 'h\nsay "hi"', 'h\n"say ""hi"""', 'h\nsay "hi"');
  cell('=say "hi"', 'h\n"\'=say ""hi"""', 'h\n\'=say "hi"', 'h\n"=say ""hi"""', 'h\n=say "hi"');
  cell("a,b", 'h\n"a,b"', "h\na,b", 'h\n"a,b"', "h\na,b");
  cell("a\nb", 'h\n"a\nb"', 'h\n"a\nb"', 'h\n"a\nb"', "h\na\nb");
  cell("abc\n=1+1", 'h\n"abc\n=1+1"', 'h\n"abc\n=1+1"', 'h\n"abc\n=1+1"', "h\nabc\n=1+1");
  cell("abc\t=1+1", "h\nabc\t=1+1", 'h\n"abc\t=1+1"', "h\nabc\t=1+1", "h\nabc\t=1+1");
  cell('a\t"b', 'h\na\t"b', 'h\n"a\t""b"', 'h\na\t"b', 'h\na\t"b');
  unchanged(-12.5, "h\n-12.5");
  cell("-12.5", "h\n'-12.5", "h\n'-12.5", "h\n-12.5", "h\n-12.5");
  unchanged(NaN, "h\nNaN");
  unchanged(-Infinity, "h\n-Infinity");
  unchanged(null, "h\n");
  unchanged(undefined, "h\n");
  unchanged("", "h\n");
  unchanged(true, "h\ntrue");
  unchanged(false, "h\nfalse");
  cell(-12n, "h\n'-12", "h\n'-12", "h\n-12", "h\n-12");
  unchanged(12n, "h\n12");
  cell("  =1+1", "h\n  =1+1", "h\n  =1+1", "h\n  =1+1", "h\n  =1+1");
  cell("'=1+1", "h\n'=1+1", "h\n'=1+1", "h\n'=1+1", "h\n'=1+1");

  assert.equal(toExportCsv(["@product"], [["=cmd|calc"]]), "'@product\n'=cmd|calc");
  assert.equal(toExportTsv(["@product"], [["=cmd|calc"]]), "'@product\n'=cmd|calc");
  assert.equal(toCsv(["@product"], [["=cmd|calc"]]), "@product\n=cmd|calc");
  assert.equal(toTsv(["@product"], [["=cmd|calc"]]), "@product\n=cmd|calc");
  assert.equal(
    toExportCsv(["=product", "Change"], [["=1+1", -100]]),
    "'=product,Change\n'=1+1,-100",
  );
  assert.equal(
    toExportTsv(["=product", "Change"], [["=1+1", -100]]),
    "'=product\tChange\n'=1+1\t-100",
  );
  assert.equal(toCsv(["=product", "Change"], [["=1+1", -100]]), "=product,Change\n=1+1,-100");
  assert.equal(toTsv(["=product", "Change"], [["=1+1", -100]]), "=product\tChange\n=1+1\t-100");
});
