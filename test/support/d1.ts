import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../../server/cloudflare.ts";

/** A Cloudflare D1 stand-in over node:sqlite, with every migration applied, for testing server code against real SQL. */
export function testDatabase(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const statement = (sql: string, values: unknown[]): D1PreparedStatement => ({
    bind: (...next) => statement(sql, next),
    // node:sqlite rows have a null prototype; D1 returns plain objects.
    first: async <T>() => {
      const row = sqlite.prepare(sql).get(...(values as SQLInputValue[]));
      return (row ? { ...row } : null) as T | null;
    },
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...(values as SQLInputValue[])).map((row) => ({ ...row })) as T[],
      success: true,
      meta: {},
    }),
    run: async () => {
      const { changes } = sqlite.prepare(sql).run(...(values as SQLInputValue[]));
      return { results: [], success: true, meta: { changes: Number(changes) } } satisfies D1Result;
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: (statements) => Promise.all(statements.map((s) => s.run())),
    exec: async (sql) => sqlite.exec(sql),
  };
}
