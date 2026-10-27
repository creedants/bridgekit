import { openDatabase } from "../src/duckdb.ts";
import { runBridge, drill, type BridgeConfig, type BridgeResult } from "../src/engine.ts";
import { createSyntheticSales } from "../src/synth.ts";

const rows = Number(process.argv[2] ?? 3_000_000);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const signed = (n: number) => (n >= 0 ? "+" : "") + money(n);

function print(title: string, result: BridgeResult, ms: number): void {
  console.log(`\n${title}  (${ms.toFixed(0)} ms)`);
  console.log(`  ${"Prior sales".padEnd(28)} ${money(result.priorSales).padStart(14)}`);
  for (const e of result.effects) console.log(`  ${e.label.padEnd(28)} ${signed(e.value).padStart(14)}`);
  console.log(`  ${"Current sales".padEnd(28)} ${money(result.currentSales).padStart(14)}`);
  console.log("  Match coverage (share of current sales):");
  for (const c of result.coverage) {
    console.log(`    ${c.label.padEnd(44)} ${(c.share * 100).toFixed(1).padStart(5)}%  ${money(c.cells)} cells`);
  }
}

const query = await openDatabase();
let start = performance.now();
await createSyntheticSales(query, rows);
console.log(`Generated ${money(rows)} rows in ${(performance.now() - start).toFixed(0)} ms`);

const base = {
  table: "sales", periodColumn: "year", prior: 2025, current: 2026,
  unitsColumn: "units", salesColumn: "sales",
};
const full: BridgeConfig = {
  ...base,
  levels: [
    { name: "Model", columns: ["model"] },
    { name: "Finish", columns: ["finish"] },
    { name: "Color", columns: ["color", "upgrade"] },
    { name: "Material", columns: ["material"] },
  ],
};
const single: BridgeConfig = {
  ...base,
  levels: [{ name: "Model", columns: ["model"] }],
  cellsTable: "single_cells",
};

start = performance.now();
const fullResult = await runBridge(query, full);
print("Model > Finish > Color > Material", fullResult, performance.now() - start);

start = performance.now();
print("Model only", await runBridge(query, single), performance.now() - start);

console.log("\nTop models by total effect (full bridge):");
for (const row of await drill(query, full, { columns: ["model"], limit: 5 })) {
  console.log(
    `  ${String(row.model).padEnd(6)} price ${signed(Number(row.price)).padStart(12)}` +
      `  volume ${signed(Number(row.volume)).padStart(12)}  new ${signed(Number(row.new_config)).padStart(12)}`,
  );
}
