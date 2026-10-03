import { DuckDBInstance } from "@duckdb/node-api";
import type { Query } from "./engine.ts";

/** In-memory DuckDB for the command line and tests. */
export async function openDatabase(): Promise<Query> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  return async (sql) => {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects() as Record<string, unknown>[];
  };
}
