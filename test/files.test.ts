import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPastedTable, makeGuard, parsePlannedIncrease, shorten, toCsv, toExportCsv, toExportTsv, toTsv } from "../src/app/files.ts";

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
  cell('a\t"b', 'h\n"a\t""b"', 'h\n"a\t""b"', 'h\n"a\t""b"', 'h\na\t"b');
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

const root = fileURLToPath(new URL("..", import.meta.url));
const readRoot = (name: string) => readFileSync(join(root, name), "utf8");
const PARQUET_REFUSAL = "Parquet files are not supported. Save the file as CSV or Excel and try again.";

test("no site page or empty state promises Parquet", () => {
  for (const name of ["index.html", "guide.html", "README.md"]) {
    const text = readRoot(name);
    assert.equal(/parquet/i.test(text), false, `${name} still mentions Parquet`);
  }
  const app = readRoot(join("src", "app", "App.tsx"));
  assert.equal(/parquet/i.test(app.match(/Drop a .* file anywhere/)?.[0] ?? "parquet"), false, "empty state still mentions Parquet");
  const accepts = app.match(/accept="[^"]*"/g) ?? [];
  assert.equal(accepts.some((a) => /\.parquet/i.test(a)), false, "file picker still offers .parquet");
});

test("the database refuses Parquet without a third-party request", () => {
  const db = readRoot(join("src", "app", "db.ts"));
  assert.equal(db.includes("export const PARQUET_REFUSAL"), true, "Parquet sentence is not shared from the database module");
  assert.equal(db.includes(PARQUET_REFUSAL), true, "Parquet refusal sentence is missing");
  assert.equal(db.includes("read_parquet"), false, "read_parquet can still ask extensions.duckdb.org for code");
  assert.equal(db.includes("upload.parquet"), false, "parquet upload name remains");
  assert.equal(db.includes("Use a CSV or Excel (.xlsx) file"), true, "generic file error still names Parquet");
});

test("the picker refuses Parquet before any database work", () => {
  const app = readRoot(join("src", "app", "App.tsx"));
  assert.equal(app.includes("PARQUET_REFUSAL"), true, "picker does not reuse the shared Parquet sentence");
  assert.equal(app.includes("/\\.parquet$/i"), true, "picker check misses an uppercase .parquet");
  const loadFileAt = app.indexOf("const loadFile");
  assert.ok(loadFileAt !== -1, "loadFile is missing");
  const checkAt = app.indexOf("/\\.parquet$/i");
  assert.ok(checkAt > loadFileAt, "Parquet check is not in loadFile");
  const prefetchAt = app.indexOf("prefetchResults()", loadFileAt);
  assert.ok(checkAt < prefetchAt, "Parquet check runs after speculative loading starts");
});

test("the data preview shows dates as dates, not epoch milliseconds", () => {
  const app = readRoot(join("src", "app", "App.tsx"));
  assert.equal(app.includes("toISOString().slice(0, 10)"), true, "preview has no DATE to YYYY-MM-DD formatting");
  assert.equal(app.includes("previewCell"), true, "preview helper is missing");
});

test("only pasted cells with a header row and a tab count as a table", () => {
  assert.equal(isPastedTable("product\tunits\nA-100\t4"), true);
  assert.equal(isPastedTable("\r\nproduct\tunits\r\n\r\nA-100\t4\r\n"), true);
  assert.equal(isPastedTable("The North region sold more A-100 this year."), false);
  assert.equal(isPastedTable("4400"), false);
  assert.equal(isPastedTable("   \n\t \n  "), false);
  assert.equal(isPastedTable("x".repeat(100_000)), false);
  assert.equal(isPastedTable("product\tunits"), false);
  assert.equal(isPastedTable("product,units\nA-100\t4"), false);
});

test("a guard drops a second trigger while the first runs and just after", async () => {
  let clock = 0;
  const guard = makeGuard(() => clock, 800);
  let runs = 0;
  let finish = () => {};
  const first = guard.run(() => new Promise<void>((resolve) => {
    runs++;
    finish = resolve;
  }));
  await guard.run(() => void runs++);
  assert.equal(runs, 1);
  clock = 5000;
  finish();
  await first;
  clock = 5799;
  await guard.run(() => void runs++);
  assert.equal(runs, 1);
  clock = 6599;
  await guard.run(() => void runs++);
  assert.equal(runs, 2);
});

test("a guard drops every click of a slow triple click and frees the trigger after it", async () => {
  let clock = 0;
  const guard = makeGuard(() => clock, 800);
  let saved = 0;
  for (const at of [0, 465, 918]) {
    clock = at;
    await guard.run(() => void saved++);
  }
  assert.equal(saved, 1, "the 465 ms and 918 ms clicks must not save again");
  clock = 1717;
  await guard.run(() => void saved++);
  assert.equal(saved, 1, "the trigger stays held for 800 ms after the last suppressed click");
  clock = 2517;
  await guard.run(() => void saved++);
  assert.equal(saved, 2, "a separate deliberate click after the sequence saves again");
});

test("a guard frees its trigger at once when the work fails or saves nothing", async () => {
  const guard = makeGuard(() => 0, 800);
  await assert.rejects(guard.run(() => {
    throw new Error("no canvas");
  }), /no canvas/);
  let runs = 0;
  await guard.run(() => {
    runs++;
    return false;
  });
  await guard.run(() => void runs++);
  assert.equal(runs, 2);
  await guard.run(() => void runs++);
  assert.equal(runs, 2);
});

test("a long cell is cut to 39 characters and an ellipsis", () => {
  assert.equal(shorten("A-100"), "A-100");
  assert.equal(shorten("N".repeat(40)), "N".repeat(40));
  assert.equal(shorten("N".repeat(41)), "N".repeat(39) + "…");
  assert.equal(shorten("N".repeat(5000)), "N".repeat(39) + "…");
  assert.equal(shorten("價".repeat(5000)).length, 40);
  assert.equal(shorten("😀".repeat(50)), "😀".repeat(39) + "…");
});

test("a planned increase is a percentage from -100 to 1000", () => {
  assert.deepEqual(parsePlannedIncrease(""), "empty");
  assert.deepEqual(parsePlannedIncrease("   "), "empty");
  assert.deepEqual(parsePlannedIncrease("0"), { value: 0 });
  assert.deepEqual(parsePlannedIncrease("4%"), { value: 4 });
  assert.deepEqual(parsePlannedIncrease(" 2.5 "), { value: 2.5 });
  assert.deepEqual(parsePlannedIncrease("-100"), { value: -100 });
  assert.deepEqual(parsePlannedIncrease("1000"), { value: 1000 });
  for (const text of ["-100.01", "1000.01", "-999", "1e308", "abc", "4%%", "%", "1,5", "Infinity", "0x10"]) {
    assert.equal(parsePlannedIncrease(text), "invalid", text);
  }
});
