import * as duckdb from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { Query } from "../engine.ts";

export interface BrowserDatabase {
  query: Query;
  /** Loads a CSV or Parquet file into `table` without it leaving the browser. */
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
      if (!isParquet && !/\.(csv|tsv|txt)$/i.test(file.name)) {
        throw new Error("Use a CSV or Parquet file");
      }
      const registered = isParquet ? "upload.parquet" : "upload.csv";
      await db.registerFileHandle(registered, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      const reader = isParquet ? `read_parquet('${registered}')` : `read_csv('${registered}')`;
      await query(`CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM ${reader}`);
    },
  };
}
