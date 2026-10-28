import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import { convertFormattedNumbers, decimalCommaNote } from "../src/app/numbers.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { readCsvTable } = await import("../src/app/db.ts");

const FIXTURE = new URL("./fixtures/monatsumsatz.csv", import.meta.url).pathname;

async function yearly(query: Awaited<ReturnType<typeof openDatabase>>, table: string): Promise<Map<string, number>> {
  const rows = await query(`SELECT year(Monat) AS year, sum(Umsatz) AS total FROM "${table}" GROUP BY 1`);
  return new Map(rows.map((row) => [String(row.year), Number(row.total)]));
}

test("Q8: a semicolon file with thousands dots loads whole amounts", async () => {
  const query = await openDatabase();
  await readCsvTable(query, "sales", FIXTURE);
  await convertFormattedNumbers(query, "sales");
  const years = await yearly(query, "sales");
  assert.equal(years.get("2025"), 2358790);
  assert.equal(years.get("2026"), 2397983);
  assert.equal(
    await decimalCommaNote(query, "sales"),
    "Numbers in Umsatz such as 9.600 were read with a dot between thousands, as 9600.",
  );
});

test("Q8: a comma file with thousands dots reads decimals and says so", async () => {
  const directory = await mkdtemp("/tmp/bridgekit-qa-");
  const file = path.join(directory, "comma-dots.csv");
  await writeFile(file, "period,units,amount\n2025,2,9.600\n2026,3,10.800\n");
  const query = await openDatabase();
  await readCsvTable(query, "dots", file);
  await convertFormattedNumbers(query, "dots");
  const rows = await query(`SELECT amount FROM dots ORDER BY period`);
  assert.deepEqual(rows.map((row) => Number(row.amount)), [9.6, 10.8]);
  assert.equal(
    await decimalCommaNote(query, "dots"),
    "Numbers in amount such as 9.600 were read as decimals, as 9.6. If they are whole numbers with dots between thousands, save the file with plain numbers.",
  );
});
