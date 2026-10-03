import * as duckdb from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { Query } from "../engine.ts";
import { toCsv } from "./files.ts";

export interface BrowserDatabase {
  query: Query;
  /** Loads a CSV, Excel or Parquet file into `table` without it leaving the browser. */
  loadFile(file: File, table: string): Promise<void>;
}

// The wasm and worker files are bundled with the app so nothing is fetched
// from a third-party host.
export async function openBrowserDatabase(): Promise<BrowserDatabase> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const connection = await db.connect();

  const query: Query = async (sql) => {
    const result = await connection.query(sql);
    return result.toArray().map((row) => row.toJSON() as Record<string, unknown>);
  };

  return {
    query,
    async loadFile(file, table) {
      const isParquet = /\.parquet$/i.test(file.name);
      const isExcel = /\.xlsx$/i.test(file.name);
      if (!isParquet && !isExcel && !/\.(csv|tsv|txt)$/i.test(file.name)) {
        throw new Error("Use a CSV, Excel (.xlsx) or Parquet file");
      }
      const registered = isParquet ? "upload.parquet" : "upload.csv";
      if (isExcel) {
        await db.registerFileText(registered, await firstSheetAsCsv(file));
      } else {
        await db.registerFileHandle(registered, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      }
      const reader = isParquet ? `read_parquet('${registered}')` : `read_csv('${registered}')`;
      await query(`CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM ${reader}`);
      await convertFormattedNumbers(query, table);
    },
  };
}

/** Reads the first worksheet of an .xlsx file, taking formula results and formatting dates as ISO. */
async function firstSheetAsCsv(file: File): Promise<string> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new Error("The first sheet of that workbook has no data rows.");
  const plain = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "object" && value !== null) {
      const cell = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
      if (cell.richText) return cell.richText.map((part) => part.text).join("");
      if ("result" in cell) return plain(cell.result);
      if ("text" in cell) return cell.text;
      return "";
    }
    return value;
  };
  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    const values = (row.values as unknown[]).slice(1);
    rows.push(Array.from({ length: sheet.columnCount }, (_, i) => plain(values[i])));
  });
  return toCsv(rows[0].map(String), rows.slice(1));
}

/**
 * Spreadsheets often export numbers as text: "1,260", "$90.00", "(45)".
 * A text column is converted when every value parses as a number once that
 * formatting is removed and at least one value carries such formatting, so
 * plain codes such as "10023" are left alone.
 */
async function convertFormattedNumbers(query: Query, table: string): Promise<void> {
  const columns = (await query(`DESCRIBE "${table}"`))
    .filter((row) => String(row.column_type) === "VARCHAR")
    .map((row) => `"${String(row.column_name).replaceAll('"', '""')}"`);
  if (columns.length === 0) return;
  const cleaned = (c: string) =>
    `try_cast(regexp_replace(regexp_replace(trim(${c}), '[,$\\s]', '', 'g'), '^\\((.*)\\)$', '-\\1') AS DOUBLE)`;
  const [counts] = await query(
    `SELECT ${columns
      .map(
        (c, i) =>
          `count(${c})::DOUBLE AS n${i}, count(${cleaned(c)})::DOUBLE AS ok${i}, count(*) FILTER (WHERE regexp_matches(${c}, '[,$()]'))::DOUBLE AS f${i}`,
      )
      .join(", ")} FROM "${table}"`,
  );
  for (const [i, c] of columns.entries()) {
    const n = Number(counts[`n${i}`]);
    if (n > 0 && n === Number(counts[`ok${i}`]) && Number(counts[`f${i}`]) > 0) {
      await query(`ALTER TABLE "${table}" ALTER ${c} TYPE DOUBLE USING ${cleaned(c)}`);
    }
  }
}
