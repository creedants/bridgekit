import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { Query } from "../src/engine.ts";
import { makeDownloader } from "../src/app/files.ts";
import { createConnectionQueue, statementStartsTurn } from "../src/app/small-bridges.ts";
import {
  calculateGate,
  carryPeriods,
  ENGINE_LOADING_TEXT,
  mainView,
  measureColumns,
  nextPhase,
  initialPhase,
  withoutSample,
  type Column,
  type Phase,
  type PhaseEvent,
  type Setup,
} from "../src/app/setup.ts";
import { openDatabase } from "../src/duckdb.ts";
import { createSyntheticSales } from "../src/synth.ts";

// The table owner lives in the page component, and this runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already installs. The page database is kept off the wasm bundles the
// browser build imports by URL.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(new URL(url), "utf8");
      const { code } = transformSync(source, {
        loader: "tsx",
        format: "esm",
        jsx: "automatic",
        define: { "import.meta.env": "{}" },
      });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const NONE = { kind: "none" } as const;

function setup(patch: Partial<Setup> = {}): Setup {
  return {
    periodColumn: "year",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "net_sales",
    levels: [{ name: "Size", columns: ["size"] }],
    filters: [],
    ...patch,
  };
}

const reason = (input: Parameters<typeof calculateGate>[0]) => {
  const gate = calculateGate(input);
  return gate.ready ? null : gate.reason;
};

test("Calculate names only the parts still missing", () => {
  const both = { prior: "2025", current: "2026", problem: NONE };
  assert.equal(reason({ setup: setup({ levels: [] }), ...both }), "Choose at least one attribute.");
  assert.equal(reason({ setup: setup({ unitsColumn: "", salesColumn: "" }), ...both }), "Choose units and sales.");
  assert.equal(reason({ setup: setup({ unitsColumn: "" }), ...both }), "Choose units.");
  assert.equal(reason({ setup: setup({ salesColumn: "", levels: [] }), ...both }), "Choose sales and at least one attribute.");
  assert.equal(reason({ setup: setup(), prior: "", current: "", problem: NONE }), "Choose periods.");
  assert.equal(
    reason({ setup: setup({ unitsColumn: "", salesColumn: "", levels: [] }), prior: "", current: "", problem: NONE }),
    "Choose periods, units, sales and at least one attribute.",
  );
  assert.equal(reason({ setup: setup(), ...both }), null);
});

test("Calculate keeps its specific reasons", () => {
  assert.equal(
    reason({ setup: setup(), prior: "2026", current: "2026", problem: NONE }),
    "Prior and current must be different periods.",
  );
  const problem = { kind: "reason", message: "The units column holds text, not numbers." } as const;
  assert.equal(reason({ setup: setup({ unitsColumn: "" }), prior: "2025", current: "2026", problem }), problem.message);
});

test("Prior and current carry over only when both are still offered and differ", () => {
  const values = ["2024", "2025", "2026"];
  assert.deepEqual(carryPeriods({ prior: "2024", current: "2026" }, values, null), { prior: "2024", current: "2026" });
  assert.deepEqual(carryPeriods({ prior: "2023", current: "2025" }, values, null), { prior: "2025", current: "2026" });
  assert.deepEqual(carryPeriods({ prior: "2025", current: "2025" }, values, null), { prior: "2025", current: "2026" });
  assert.deepEqual(carryPeriods({ prior: "", current: "" }, values, { prior: "2024", current: "2025" }), {
    prior: "2024",
    current: "2025",
  });
  assert.deepEqual(carryPeriods({ prior: "", current: "" }, ["2026"], null), { prior: "", current: "2026" });
});

test("a second file with other periods gets that file's periods", () => {
  const first = carryPeriods({ prior: "", current: "" }, ["2024", "2025"], null);
  assert.deepEqual(first, { prior: "2024", current: "2025" });
  const second = carryPeriods(first, ["2025", "2026"], null);
  assert.deepEqual(second, { prior: "2025", current: "2026" });
  assert.deepEqual(carryPeriods(second, ["2025", "2026"], null), second);
});

test("the period column is not offered as units or sales", () => {
  const columns: Column[] = [
    { name: "year", type: "BIGINT" },
    { name: "region", type: "VARCHAR" },
    { name: "units", type: "BIGINT" },
    { name: "net_sales", type: "DOUBLE" },
  ];
  assert.deepEqual(measureColumns(columns, setup()).map((c) => c.name), ["units", "net_sales"]);
  assert.deepEqual(measureColumns(columns, setup({ periodColumn: "region" })).map((c) => c.name), ["year", "units", "net_sales"]);
});

test("loading a file drops the sample from the address", () => {
  assert.equal(withoutSample("https://pvmbridge.com/app/?sample"), "https://pvmbridge.com/app/");
  assert.equal(withoutSample("https://pvmbridge.com/app/?sample=sku&view=1"), "https://pvmbridge.com/app/?view=1");
  assert.equal(withoutSample("https://pvmbridge.com/app/"), null);
});

test("a file picked while the engine loads is acknowledged by name", () => {
  const phase = nextPhase(initialPhase(""), {
    type: "read",
    load: 1,
    source: "file",
    fileName: "North A-100.csv",
    label: "Reading North A-100.csv…",
  });
  assert.deepEqual(mainView(phase, "loading"), {
    kind: "loading",
    text: ENGINE_LOADING_TEXT,
    fileLine: "Got North A-100.csv. It opens as soon as the calculation engine has loaded.",
  });
  assert.deepEqual(mainView(phase, "ready"), { kind: "loading", text: "Reading North A-100.csv…" });
  const sample = nextPhase(initialPhase(""), { type: "read", load: 1, source: "sample", label: "Making the sample data…" });
  assert.deepEqual(mainView(sample, "loading"), { kind: "loading", text: ENGINE_LOADING_TEXT });
});

function saver() {
  const saved: string[] = [];
  return { saved, save: (name: string) => void saved.push(name) };
}

test("a triple click on a save button saves one file", async () => {
  let clock = 0;
  const { saved, save } = saver();
  const download = makeDownloader(save, () => clock, 800);
  for (const at of [0, 300, 600]) {
    clock = at;
    await download("movers.csv", "A-100,North", "text/csv");
  }
  assert.deepEqual(saved, ["movers.csv"]);
  clock = 2000;
  await download("movers.csv", "A-100,North", "text/csv");
  assert.deepEqual(saved, ["movers.csv", "movers.csv"]);
});

test("a slow file built while more clicks arrive is still saved once", async () => {
  let clock = 0;
  const { saved, save } = saver();
  const download = makeDownloader(save, () => clock, 800);
  let finish: (text: string) => void = () => {};
  const first = download("movers.csv", () => new Promise<string>((resolve) => (finish = resolve)), "text/csv");
  clock = 200;
  await download("movers.csv", () => "A-100", "text/csv");
  clock = 400;
  await download("movers.csv", () => "A-100", "text/csv");
  finish("A-100,North");
  await first;
  assert.deepEqual(saved, ["movers.csv"]);
});

test("different files save side by side, and a failed save frees its button", async () => {
  const { saved, save } = saver();
  const download = makeDownloader(save, () => 0, 800);
  await download("movers.csv", "A-100", "text/csv");
  await download("bridge.png", "png", "image/png");
  await assert.rejects(download("setup.json", () => { throw new Error("Could not read rows."); }, "application/json"));
  await download("setup.json", () => null, "application/json");
  await download("setup.json", "{}", "application/json");
  assert.deepEqual(saved, ["movers.csv", "bridge.png", "setup.json"]);
});

test("a load a newer pick replaced never writes", async () => {
  const { createTableOwner } = await import("../src/app/App.tsx");
  const tables = createTableOwner();
  const a = tables.claim();
  let writes = 0;
  const aWrite = a.write(async () => {
    writes += 1;
    return "A-100";
  });
  const b = tables.claim();
  const bWrite = b.write(async () => "B-200");
  assert.deepEqual(await aWrite, { status: "superseded" });
  assert.deepEqual(await bWrite, { status: "wrote", value: "B-200" });
  assert.equal(writes, 0);
  assert.equal(tables.owner()?.n, b.n);
});

test("a write already running finishes before the next starts, and the next lands last", async () => {
  const { createTableOwner } = await import("../src/app/App.tsx");
  const tables = createTableOwner();
  const log: string[] = [];
  let release: () => void = () => {};
  const holding = new Promise<void>((resolve) => (release = resolve));
  const a = tables.claim();
  const aWrite = a.write(async () => {
    log.push("A start");
    await holding;
    log.push("A end");
  });
  await settle();
  const b = tables.claim();
  const bWrite = b.write(async () => {
    log.push("B");
  });
  release();
  assert.deepEqual(await aWrite, { status: "wrote", value: undefined });
  assert.deepEqual(await bWrite, { status: "wrote", value: undefined });
  assert.deepEqual(log, ["A start", "A end", "B"]);
  assert.equal(tables.owner()?.n, b.n);
});

test("a failed newest load leaves the last written table as the owner", async () => {
  const { createTableOwner } = await import("../src/app/App.tsx");
  const tables = createTableOwner();
  const a = tables.claim();
  assert.deepEqual(await a.write(async () => "A-100"), { status: "wrote", value: "A-100" });
  const b = tables.claim();
  await assert.rejects(
    b.write(async () => {
      throw new Error("The file has no rows.");
    }),
    /The file has no rows/,
  );
  assert.equal(tables.owner()?.n, a.n);
});

function queued(raw: Query): Query {
  const statements = createConnectionQueue();
  return (sql) => (statementStartsTurn(sql) ? statements.turn(() => raw(sql)) : statements.schedule(() => raw(sql)));
}

async function columnNames(query: Query): Promise<string[]> {
  const described = await query('DESCRIBE "data"');
  return described.map((row) => String(row.column_name));
}

test("the table in DuckDB holds the last pick's rows", async () => {
  const { createTableOwner } = await import("../src/app/App.tsx");
  const raw = await openDatabase();
  const query = queued(raw);

  const tables = createTableOwner();
  const sample = tables.claim();
  const sampleWrite = sample.write(() => createSyntheticSales(raw, 2000, "data"));
  await settle();
  const file = tables.claim();
  const fileWrite = file.write(() => query('CREATE OR REPLACE TABLE "data" AS SELECT 1 AS "a"'));
  const outcomes = await Promise.all([sampleWrite, fileWrite]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["wrote", "wrote"]);
  assert.deepEqual(await columnNames(raw), ["a"]);
  assert.equal(tables.owner()?.n, file.n);
});

test("without an owner, a sample that hops before writing lands over the newer file", async () => {
  const raw = await openDatabase();
  const query = queued(raw);
  const older = Promise.resolve().then(() => createSyntheticSales(query, 2000, "data"));
  const newer = query('CREATE OR REPLACE TABLE "data" AS SELECT 1 AS "a"');
  await Promise.all([older, newer]);
  const names = await columnNames(query);
  assert.equal(names.length, 13);
  assert.ok(names.includes("units"), `the sample's columns landed last, but the table held ${names.join(", ")}`);
});

const PASTED = "period\tunits\n2025\t10\n";

test("a paste with nothing displayed loads the pasted cells at once", async () => {
  const { pasteIntent } = await import("../src/app/App.tsx");
  assert.equal(pasteIntent(PASTED, 0), "load");
});

test("a paste over displayed data asks before replacing it", async () => {
  const { pasteIntent } = await import("../src/app/App.tsx");
  assert.equal(pasteIntent(PASTED, 3), "ask");
});

test("text that is not a table is refused, displayed data or not", async () => {
  const { pasteIntent } = await import("../src/app/App.tsx");
  assert.equal(pasteIntent("just a sentence", 0), "refuse");
  assert.equal(pasteIntent("just a sentence", 3), "refuse");
});

const read = (load: number, source: "file" | "sample" = "file"): PhaseEvent => ({
  type: "read",
  load,
  source,
  ...(source === "file" ? { fileName: "own-" + load + ".csv" } : {}),
  label: "Reading…",
});
const loaded = (load: number): PhaseEvent => ({ type: "loaded", load });
const failed = (load: number): PhaseEvent => ({ type: "failed", load });
const ran = (load: number): PhaseEvent => ({ type: "ran", load });

/** Steps the real reducer and the real fold in the order the page applies them. */
function walk(fold: (shown: number, phase: Phase) => number, search: string, events: PhaseEvent[]) {
  let phase = initialPhase(search);
  let shown = 0;
  const markers: number[] = [];
  for (const event of events) {
    phase = nextPhase(phase, event);
    shown = fold(shown, phase);
    markers.push(shown);
  }
  return { phase, markers };
}

const marker = (trail: { markers: number[] }) => trail.markers[trail.markers.length - 1];

test("a paste before the first workspace is shown asks nothing", async () => {
  const { pasteIntent, visibleLoad } = await import("../src/app/App.tsx");
  const reading = walk(visibleLoad, "", [read(1)]);
  assert.equal(reading.phase.kind, "reading");
  assert.deepEqual(reading.markers, [0]);
  assert.equal(pasteIntent(PASTED, marker(reading)), "load");
  const workspace = walk(visibleLoad, "", [read(1), loaded(1)]);
  assert.equal(workspace.phase.kind, "workspace");
  assert.deepEqual(workspace.markers, [0, 1]);
  assert.equal(pasteIntent(PASTED, marker(workspace)), "ask");
});

test("a sample link asks nothing until its bridge is drawn", async () => {
  const { pasteIntent, visibleLoad } = await import("../src/app/App.tsx");
  const bridge = walk(visibleLoad, "?sample", [read(1, "sample"), loaded(1)]);
  assert.equal(bridge.phase.kind, "autoRun");
  assert.deepEqual(bridge.markers, [0, 0]);
  assert.equal(pasteIntent(PASTED, marker(bridge)), "load");
  const drawn = walk(visibleLoad, "?sample", [read(1, "sample"), loaded(1), ran(1)]);
  assert.equal(drawn.phase.kind, "workspace");
  assert.deepEqual(drawn.markers, [0, 0, 1]);
  assert.equal(pasteIntent(PASTED, marker(drawn)), "ask");
});

test("a newer reading load over displayed data still asks", async () => {
  const { pasteIntent, visibleLoad } = await import("../src/app/App.tsx");
  const trail = walk(visibleLoad, "", [read(1), loaded(1), read(2), read(3)]);
  assert.equal(trail.phase.kind, "reading");
  assert.deepEqual(trail.markers, [0, 1, 1, 1]);
  assert.equal(pasteIntent(PASTED, marker(trail)), "ask");
});

test("a refused load falling back keeps asking", async () => {
  const { pasteIntent, visibleLoad } = await import("../src/app/App.tsx");
  const trail = walk(visibleLoad, "", [read(1), loaded(1), read(2), read(3), loaded(2), failed(3)]);
  assert.equal(trail.phase.kind, "workspace");
  assert.notEqual(marker(trail), 0);
  assert.equal(pasteIntent(PASTED, marker(trail)), "ask");
});

test("a refused first load asks nothing", async () => {
  const { pasteIntent, visibleLoad } = await import("../src/app/App.tsx");
  const once = walk(visibleLoad, "", [read(1), failed(1)]);
  assert.equal(once.phase.kind, "start");
  assert.deepEqual(once.markers, [0, 0]);
  assert.equal(pasteIntent(PASTED, marker(once)), "load");
  const twice = walk(visibleLoad, "", [read(1), read(2), failed(2)]);
  assert.equal(twice.phase.kind, "start");
  assert.deepEqual(twice.markers, [0, 0, 0]);
  assert.equal(pasteIntent(PASTED, marker(twice)), "load");
});

test("a failed sample auto-run draws the workspace and then asks", async () => {
  const { pasteIntent, visibleLoad } = await import("../src/app/App.tsx");
  const loadedSample = walk(visibleLoad, "?sample", [read(1, "sample"), loaded(1)]);
  assert.equal(marker(loadedSample), 0);
  const trail = walk(visibleLoad, "?sample", [read(1, "sample"), loaded(1), failed(1)]);
  assert.equal(trail.phase.kind, "workspace");
  assert.notEqual(marker(trail), 0);
  assert.equal(pasteIntent(PASTED, marker(trail)), "ask");
});

test("late events from a superseded load change nothing", async () => {
  const { pasteIntent, visibleLoad } = await import("../src/app/App.tsx");
  const trail = walk(visibleLoad, "", [read(1), read(2), loaded(1), ran(1), failed(1)]);
  assert.equal(trail.phase.kind, "reading");
  assert.deepEqual(trail.markers, [0, 0, 0, 0, 0]);
  assert.equal(pasteIntent(PASTED, marker(trail)), "load");
});

test("only the workspace commit advances the load a paste compares against", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  const writes = [...source.matchAll(/displayed\.current\s*=/g)];
  assert.equal(writes.length, 1, `the marker has one writer, but found ${writes.length}`);
  const at = writes[0].index;
  assert.ok(at !== undefined, "the marker writer is found");
  const line = source.slice(at).split("\n")[0].trim();
  assert.equal(line, "displayed.current = visibleLoad(displayed.current, phase);");
  const afterLoadAt = source.indexOf("async function afterLoad");
  const loadSampleAt = source.indexOf("const loadSample", afterLoadAt);
  assert.ok(afterLoadAt >= 0 && loadSampleAt > afterLoadAt, "afterLoad sits before loadSample");
  assert.ok(
    !source.slice(afterLoadAt, loadSampleAt).includes("displayed.current"),
    "afterLoad does not touch the marker a paste reads",
  );
  assert.ok(source.includes("pasteIntent(text, displayed.current)"), "the paste handler reads the marker");
});

