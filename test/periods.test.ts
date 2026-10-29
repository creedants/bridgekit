import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPeriodList, trendPeriods } from "../src/app/periods.ts";
import { openDatabase } from "../src/duckdb.ts";
import { trend, type BridgeConfig } from "../src/engine.ts";

/** The period list is the only order; these tests read it from DuckDB. */
async function loadOnly(values: readonly string[]) {
  const query = await openDatabase();
  await query("SET threads = 1");
  await query("CREATE TABLE periods (p VARCHAR)");
  if (values.length > 0) {
    const rows = values.map((value) => `('${value.replaceAll("'", "''")}')`).join(", ");
    await query(`INSERT INTO periods VALUES ${rows}`);
  }
  return loadPeriodList(query, '"p"', '"periods"');
}

/** Same path the tool takes: list the periods, then bridge each consecutive pair. */
async function trendFor(periods: readonly string[], sales: readonly number[]) {
  const query = await openDatabase();
  await query("SET threads = 1");
  await query("CREATE TABLE sales (period VARCHAR, product VARCHAR, units BIGINT, sales DOUBLE)");
  const rows = periods.map((p, i) => `('${p.replaceAll("'", "''")}', 'P', 1, ${sales[i]})`).join(", ");
  await query(`INSERT INTO sales VALUES ${rows}`);
  const list = await loadPeriodList(query, '"period"', '"sales"');
  const ordered = trendPeriods(list.values, 13);
  const config: BridgeConfig = {
    table: "sales", periodColumn: "period",
    prior: ordered.at(-2) ?? "", current: ordered.at(-1) ?? "",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  };
  return { list, ordered, steps: await trend(query, config, ordered) };
}

test("months 8, 9, and 10 list, default, and step as numbers", async () => {
  const query = await openDatabase();
  await query("SET threads = 1");
  await query("CREATE TABLE sales (period VARCHAR, product VARCHAR, units BIGINT, sales DOUBLE)");
  await query(`INSERT INTO sales VALUES ('8', 'P', 1, 100), ('9', 'P', 1, 300), ('10', 'P', 1, 660)`);
  const list = await loadPeriodList(query, '"period"', '"sales"');
  assert.equal(list.sort, "numeric");
  assert.deepEqual(list.values, ["8", "9", "10"]);
  assert.deepEqual(list.values.slice(-2), ["9", "10"]);
  const ordered = trendPeriods(list.values, 13);
  const steps = await trend(query, {
    table: "sales", periodColumn: "period", prior: "9", current: "10",
    unitsColumn: "units", salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  }, ordered);
  assert.deepEqual(steps.map((s) => [s.prior, s.current]), [["8", "9"], ["9", "10"]]);
  assert.deepEqual(steps.map((s) => s.currentSales - s.priorSales), [200, 360]);
});

test("Unicode period text keeps the order the list query returns", async () => {
  // The emoji is a supplementary character, so DuckDB's UTF-8 order and
  // JavaScript's UTF-16 order disagree. Nothing in the page may re-sort it.
  const { list, ordered, steps } = await trendFor(["A", "\uFF3A", "\u{1F600}"], [100, 200, 300]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["A", "\uFF3A", "\u{1F600}"]);
  assert.deepEqual(ordered, ["A", "\uFF3A", "\u{1F600}"]);
  assert.deepEqual(steps.map((s) => [s.prior, s.current]), [["A", "\uFF3A"], ["\uFF3A", "\u{1F600}"]]);
  assert.deepEqual(steps.map((s) => s.currentSales - s.priorSales), [100, 100]);
});

test("plain digit strings past fifteen digits keep the text order", async () => {
  // Both long strings cast to Infinity as a DOUBLE; the column must stay text.
  const H = "1" + "0".repeat(309);
  const M = "2" + "0".repeat(308);
  const { list } = await trendFor(["0008", "9", H, M], [80, 100, 200, 300]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["0008", H, M, "9"]);
});

test("a column is numeric at fifteen digits and text at sixteen", async () => {
  const numeric = await loadOnly(["1", "999999999999999"]);
  assert.equal(numeric.sort, "numeric");
  assert.deepEqual(numeric.values, ["1", "999999999999999"]);

  const text = await loadOnly(["1", "9999999999999999"]);
  assert.equal(text.sort, "text");
  assert.deepEqual(text.values, ["1", "9999999999999999"]);
});

test("precision ties keep the order the whole column had as text", async () => {
  // Both sets are past 2^53, so the DOUBLE cast collapses each pair. The
  // column falls back to text order, which is origin/main's order.
  const negatives = await loadOnly(["-9007199254740993", "-9007199254740992", "1"]);
  assert.equal(negatives.sort, "text");
  assert.deepEqual(negatives.values, ["-9007199254740992", "-9007199254740993", "1"]);

  const widths = await loadOnly(["1", "9999999999999999", "10000000000000000"]);
  assert.equal(widths.sort, "text");
  assert.deepEqual(widths.values, ["1", "10000000000000000", "9999999999999999"]);
});

test("same-width leading zeros keep the same order as text", async () => {
  const list = await loadOnly(["11", "01", "10", "02"]);
  assert.equal(list.sort, "numeric");
  assert.deepEqual(list.values, ["01", "02", "10", "11"]);
});

test("mixed-width leading zeros sort by the number, then the original string", async () => {
  assert.deepEqual((await loadOnly(["10", "9", "8", "09"])).values, ["8", "09", "9", "10"]);
  assert.deepEqual((await loadOnly(["1.0", "01", "1", "-3", "-10"])).values, ["-10", "-3", "01", "1", "1.0"]);
});

test("negative numbers and decimals sort by the number", async () => {
  assert.deepEqual((await loadOnly(["4", "-3", "-20", "-10"])).values, ["-20", "-10", "-3", "4"]);
  assert.deepEqual((await loadOnly(["10", "1.5", "9.5", "1.25"])).values, ["1.25", "1.5", "9.5", "10"]);
  assert.deepEqual((await loadOnly(["1.5", "1.10"])).values, ["1.10", "1.5"]);
});

test("quarter labels in each of the four shapes order by the quarter they name", async () => {
  const shapes = [
    ["Q1 2025", "Q4 2024", "Q3 2024"],
    ["Q1-2025", "Q4-2024", "Q3-2024"],
    ["2025-Q2", "2024-Q4", "2025-Q1"],
    ["2025 Q2", "2024 Q4", "2025 Q1"],
  ];
  const expected = [
    ["Q3 2024", "Q4 2024", "Q1 2025"],
    ["Q3-2024", "Q4-2024", "Q1-2025"],
    ["2024-Q4", "2025-Q1", "2025-Q2"],
    ["2024 Q4", "2025 Q1", "2025 Q2"],
  ];
  for (const [index, values] of shapes.entries()) {
    const list = await loadOnly(values);
    assert.equal(list.sort, "text");
    assert.deepEqual(list.values, expected[index], values.join(", "));
  }
});

test("a quarterly text sample defaults to the last two quarters as prior and current", async () => {
  const { list, ordered, steps } = await trendFor(["Q3 2024", "Q4 2024", "Q1 2025"], [100, 200, 320]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["Q3 2024", "Q4 2024", "Q1 2025"]);
  assert.deepEqual(ordered, ["Q3 2024", "Q4 2024", "Q1 2025"]);
  assert.deepEqual(steps.map((s) => [s.prior, s.current]), [["Q3 2024", "Q4 2024"], ["Q4 2024", "Q1 2025"]]);
});

test("three-letter and full month-name labels each order by the month they name", async () => {
  assert.deepEqual(
    (await loadOnly(["Jan 2025", "Mar 2024", "Feb 2025"])).values,
    ["Mar 2024", "Jan 2025", "Feb 2025"],
  );
  assert.deepEqual(
    (await loadOnly(["MARCH 2024", "January 2025", "february 2024"])).values,
    ["february 2024", "MARCH 2024", "January 2025"],
  );
  // May is the same word as a three-letter and as a full month name, so it
  // joins whichever of the two the rest of the column is written in.
  assert.deepEqual((await loadOnly(["Jan 2025", "May 2024", "Mar 2025"])).values, ["May 2024", "Jan 2025", "Mar 2025"]);
  assert.deepEqual(
    (await loadOnly(["January 2025", "May 2024", "March 2025"])).values,
    ["May 2024", "January 2025", "March 2025"],
  );
});

test("year-month labels order by the month they name", async () => {
  assert.deepEqual((await loadOnly(["2025-10", "2025-03", "2024-12"])).values, ["2024-12", "2025-03", "2025-10"]);
});

test("fiscal-year labels order by year", async () => {
  assert.deepEqual((await loadOnly(["FY24", "FY25", "FY19"])).values, ["FY19", "FY24", "FY25"]);
  assert.deepEqual((await loadOnly(["FY2024", "FY2025", "FY2019"])).values, ["FY2019", "FY2024", "FY2025"]);
});

test("fiscal-year labels are read in either case and order by year", async () => {
  const list = await loadOnly(["fy2024", "Fy2025", "FY2023"]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["FY2023", "fy2024", "Fy2025"]);
});

test("fiscal quarter labels order across a fiscal year boundary", async () => {
  const list = await loadOnly(["FY2026-Q1", "FY2025-Q3", "FY2025-Q4"]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["FY2025-Q3", "FY2025-Q4", "FY2026-Q1"]);
});

test("fiscal year-to-date labels order across a fiscal year boundary", async () => {
  const list = await loadOnly(["FY2025 YTD", "FY2024 YTD", "FY2026 YTD"]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["FY2024 YTD", "FY2025 YTD", "FY2026 YTD"]);
});

test("ISO quarter labels are read in either case and order by the quarter they name", async () => {
  const list = await loadOnly(["2024-q3", "2024-Q4", "2025-q1"]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["2024-q3", "2024-Q4", "2025-q1"]);
});

test("labels that name the same period stay separate and order by their string", async () => {
  assert.deepEqual((await loadOnly(["q1 2025", "Q1 2025", "Q4 2024"])).values, ["Q4 2024", "Q1 2025", "q1 2025"]);
});

test("a column of 2,050 month labels keeps the latest 2,000", async () => {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const months = Array.from({ length: 2050 }, (_, index) => `${names[index % 12]} ${2000 + Math.floor(index / 12)}`);
  const shuffled = months.filter((_, index) => index % 2 === 1).concat(months.filter((_, index) => index % 2 === 0));
  const expected = months.slice(-2000);
  const list = await loadOnly(shuffled);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, expected);
});

test("a column of 250 daily dates keeps all 250", async () => {
  const day = 24 * 60 * 60 * 1000;
  const first = Date.UTC(2025, 11, 1);
  const dates = Array.from({ length: 250 }, (_, index) => new Date(first + index * day).toISOString().slice(0, 10));
  const shuffled = dates.filter((_, index) => index % 2 === 1).concat(dates.filter((_, index) => index % 2 === 0));
  const list = await loadOnly(shuffled);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, dates);
});

test("a mix of label shapes, or a value that matches none, stays in text order", async () => {
  const mixed = await loadOnly(["Q1 2025", "2024-Q4", "Jan 2025"]);
  assert.equal(mixed.sort, "text");
  assert.deepEqual(mixed.values, ["2024-Q4", "Jan 2025", "Q1 2025"]);

  // Two shapes that differ only in the separator are still two formats.
  const separators = await loadOnly(["2025-Q1", "2025 Q2"]);
  assert.deepEqual(separators.values, ["2025 Q2", "2025-Q1"]);

  // A three-letter month name and a full one are two formats, as are the two
  // fiscal-year lengths.
  assert.deepEqual(
    (await loadOnly(["January 2024", "Mar 2025", "September 2024"])).values,
    ["January 2024", "Mar 2025", "September 2024"],
  );
  assert.deepEqual((await loadOnly(["FY24", "FY2025"])).values, ["FY2025", "FY24"]);

  const alien = await loadOnly(["Q1 2025", "Q4 2024", "Q3 24"]);
  assert.deepEqual(alien.values, ["Q1 2025", "Q3 24", "Q4 2024"]);
});

test("Actual and Budget stay in text order", async () => {
  const list = await loadOnly(["Budget", "Actual"]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, ["Actual", "Budget"]);
});

test("quarter labels, prefixed labels, and bare month names stay in text order", async () => {
  const quarters = await loadOnly(["Q3", "Q1", "Q4", "Q2"]);
  assert.equal(quarters.sort, "text");
  assert.deepEqual(quarters.values, ["Q1", "Q2", "Q3", "Q4"]);

  const prefixed = await loadOnly(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12"]);
  assert.equal(prefixed.sort, "text");
  assert.deepEqual(prefixed.values, ["P1", "P10", "P11", "P12", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);

  const names = await loadOnly(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  assert.equal(names.sort, "text");
  assert.deepEqual(names.values, ["Apr", "Aug", "Dec", "Feb", "Jan", "Jul", "Jun", "Mar", "May", "Nov", "Oct", "Sep"]);
});

test("year-to-date labels stay in text order", async () => {
  const ytd = await loadOnly(["2025 YTD", "2024 YTD"]);
  assert.equal(ytd.sort, "text");
  assert.deepEqual(ytd.values, ["2024 YTD", "2025 YTD"]);
});

test("a mix of numbers and text, including forms that only look numeric, stays in text order", async () => {
  const mixed = await loadOnly(["10", "8", "9", "Q1"]);
  assert.equal(mixed.sort, "text");
  assert.deepEqual(mixed.values, ["10", "8", "9", "Q1"]);

  for (const alien of [" 8", "8 ", "1,000", "1e2", "+8", "1.", ".5"]) {
    assert.equal((await loadOnly(["10", "8", alien])).sort, "text", `${JSON.stringify(alien)} is not a plain number`);
  }
  assert.deepEqual((await loadOnly(["10", "1,000", "8"])).values, ["1,000", "10", "8"]);
  const newline = await loadOnly(["10", "8\n", "9"]);
  assert.equal(newline.sort, "text");
  assert.deepEqual(newline.values, ["10", "8\n", "9"]);
});

test("an empty period list is text", async () => {
  const list = await loadOnly([]);
  assert.equal(list.sort, "text");
  assert.deepEqual(list.values, []);
});

test("a capped window keeps the text decision made over the values it dropped", async () => {
  // Four digits, so the text order is also the age order and the cap's choice
  // is readable: the oldest fifty fall away and the rest stay oldest first.
  const values = ["#note", ...Array.from({ length: 2050 }, (_, index) => String(index + 1).padStart(4, "0"))];
  const expected = Array.from({ length: 2000 }, (_, index) => String(index + 51).padStart(4, "0"));
  const list = await loadOnly(values);
  assert.deepEqual(list.values, expected);
  assert.equal(list.sort, "text");
});

test("R9: month-first month labels order by the month they name", async () => {
  assert.deepEqual((await loadOnly(["12.2024", "01.2025", "03.2024"])).values, ["03.2024", "12.2024", "01.2025"]);
  assert.deepEqual((await loadOnly(["12/2024", "01/2025", "03/2024"])).values, ["03/2024", "12/2024", "01/2025"]);
});
