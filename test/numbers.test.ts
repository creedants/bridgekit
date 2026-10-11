import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";
import { openDatabase } from "../src/duckdb.ts";

const EURO_FILE = `period;sku;units;net_sales
2024;A;10,00;1.234,56
2024;B;4,00;12,50
2025;A;10,00;1.500,00
2025;B;4,00;15,00
`;

function asNumber(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  assert.equal(typeof number, "number");
  if (typeof number !== "number" || !Number.isFinite(number)) assert.fail(`${String(value)} is not a finite number`);
  return number;
}

test("a semicolon file of decimal commas loads as decimals", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-comma-");
  const file = path.join(directory, "sales.csv");
  await writeFile(file, EURO_FILE);
  const query = await openDatabase();
  await query(`CREATE TABLE euro AS SELECT * FROM read_csv('${file}', delim=';', header=true)`);
  await convertFormattedNumbers(query, "euro");

  const described = await query(`DESCRIBE euro`);
  const typeOf = (name: string) => described.find((row) => row.column_name === name)?.column_type;
  const rows = await query(`SELECT period, sku, units, net_sales FROM euro ORDER BY rowid`);
  assert.deepEqual(
    rows.map((row) => [String(row.period), row.sku]),
    [
      ["2024", "A"],
      ["2024", "B"],
      ["2025", "A"],
      ["2025", "B"],
    ],
  );
  const actual = {
    types: { units: typeOf("units"), net_sales: typeOf("net_sales") },
    units: rows.map((row) => asNumber(row.units)),
    net_sales: rows.map((row) => asNumber(row.net_sales)),
    note: await decimalCommaNote(query, "euro"),
  };
  const expected = {
    types: { units: "DOUBLE", net_sales: "DOUBLE" },
    units: [10, 4, 10, 4],
    net_sales: [1234.56, 12.5, 1500, 15],
    note: "2 columns were read as numbers written with a decimal comma.",
  };
  const sameNumber = (value: number, expectedValue: number) => Math.abs(value - expectedValue) < 1e-9;
  const matches =
    actual.types.units === expected.types.units &&
    actual.types.net_sales === expected.types.net_sales &&
    actual.note === expected.note &&
    actual.units.every((value, index) => sameNumber(value, expected.units[index])) &&
    actual.net_sales.every((value, index) => sameNumber(value, expected.net_sales[index]));
  assert.deepEqual(matches ? expected : actual, expected);
});
