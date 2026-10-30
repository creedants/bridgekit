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

const FAKE_DATABASE_MODULE = `
export const PARQUET_REFUSAL = "That file is a Parquet file. Save it as CSV or Excel, then choose it again.";
export function scheduleSpeculative() { return () => {}; }
export function openBrowserDatabase() { return Promise.resolve(globalThis.__bridgekitDatabase); }
`;

// The table owner lives in the page component, and this runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already installs. The page database is kept off the wasm bundles the
// browser build imports by URL.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    // The page database needs a browser and wasm bundles. The banner test mounts
    // the real App, so its database is replaced by one this runner scripts.
    if (specifier === "./db.ts" && context.parentURL?.endsWith("/src/app/App.tsx")) {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_DATABASE_MODULE)}`, shortCircuit: true };
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

test("the one-period gate advises Month when the period column spans months", () => {
  const base = setup({ periodColumn: "order_date", grain: "year" });
  const problem = {
    kind: "reason",
    message: 'With these settings "order_date" gives only one period, and a bridge compares two periods.',
  } as const;
  const input = { setup: base, prior: "", current: "2026", problem };
  const advised = calculateGate({ ...input, months: 2 });
  assert.equal(
    advised.ready,
    false,
    "one period with months behind it is not ready",
  );
  assert.equal(
    advised.ready ? null : advised.reason,
    'With these settings "order_date" gives only one period, so choose Month in Compare by.',
  );
  const single = calculateGate({ ...input, months: 1 });
  assert.equal(single.ready ? null : single.reason, problem.message);
  const unknown = calculateGate(input);
  assert.equal(unknown.ready ? null : unknown.reason, problem.message);
});

test("App passes the period column month count to the gate", async () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("months:"), "the gate call names months");
  assert.ok(source.includes("facts?.months"), "the month count comes from the period column facts");
  assert.ok(
    source.includes("setup.periodColumn"),
    "the month count is read from the chosen period column",
  );
  const { calculateGate: gate } = await import("../src/app/setup.ts");
  const probed = gate({
    setup: setup({ periodColumn: "d", grain: "ytd" }),
    prior: "",
    current: "2026",
    problem: { kind: "reason", message: 'With these settings "d" gives only one period, and more.' } as const,
    months: 3,
  });
  assert.equal(probed.ready ? null : probed.reason, 'With these settings "d" gives only one period, so choose Month in Compare by.');
});

test("the workbook note reads the same sentence Data check uses", async () => {
  const { workbookSheetNote } = await import("../src/app/App.tsx");
  assert.equal(
    workbookSheetNote("sheet:Sales|1"),
    'The workbook\'s first sheet, "Sales", was loaded; the other sheet was not.',
  );
  assert.equal(
    workbookSheetNote("sheet:Sales|2"),
    'The workbook\'s first sheet, "Sales", was loaded; the other 2 sheets were not.',
  );
  assert.equal(workbookSheetNote(""), null);
  assert.equal(workbookSheetNote(null), null);
  assert.equal(workbookSheetNote("sheet:|2"), null);
});

test("the load area shows the workbook note beside the file name", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("loadSheetNote"), "afterLoad reads the workbook note for the loaded table");
  assert.ok(source.includes("setSheetNote"), "the loaded note is kept in state");
  assert.ok(source.includes("{sheetNote"), "the load area renders the note");
  const topbarAt = source.indexOf("<header className=\"topbar\"");
  assert.ok(topbarAt >= 0, "the top bar is found");
  const topbar = source.slice(topbarAt, topbarAt + 2000);
  assert.ok(topbar.includes("sourceCaption") || topbar.includes('className="source"'), "the note sits with the file name");
  assert.ok(topbar.includes("{sheetNote"), "the note is beside the file name or load status");
  assert.ok(
    source.includes('The workbook\'s first sheet, "${name}", was loaded;'),
    "the load-area sentence matches Data check",
  );
});

test("Save setup to file leaves the guess markers out", async () => {
  const { persistedSetupForFile } = await import("../src/app/App.tsx");
  const { restoredSetup, isValidSetup } = await import("../src/app/setup.ts");
  const full = { ...setup(), fresh: true as const, salesFromValues: "net_sales" };
  const persisted = persistedSetupForFile(full);
  assert.ok(!("fresh" in persisted), "fresh is not exported");
  assert.ok(!("salesFromValues" in persisted), "salesFromValues is not exported");
  assert.equal(persisted.unitsColumn, full.unitsColumn);
  assert.equal(persisted.salesColumn, full.salesColumn);
  const text = JSON.stringify(persisted);
  assert.ok(!text.includes("fresh"), "the file text holds no fresh marker");
  assert.ok(!text.includes("salesFromValues"), "the file text holds no salesFromValues marker");
  const columns: Column[] = [
    { name: "year", type: "BIGINT" },
    { name: "units", type: "BIGINT" },
    { name: "net_sales", type: "DOUBLE" },
  ];
  // A setup saved by this branch: the export validates and keeps its mapping through a restore.
  const headFile = { ...persisted, levels: [{ name: "Size", columns: ["year"] }] };
  assert.ok(isValidSetup(headFile, columns), "a setup saved by this branch passes validation");
  const headRestored = restoredSetup(headFile);
  assert.equal(headRestored.periodColumn, persisted.periodColumn, "this branch's export keeps its period column");
  assert.equal(headRestored.unitsColumn, persisted.unitsColumn, "this branch's export keeps its units column");
  assert.equal(headRestored.salesColumn, persisted.salesColumn, "this branch's export keeps its sales column");
  assert.deepEqual(headRestored.levels, [{ name: "Size", columns: ["year"] }], "this branch's export keeps its attribute mapping");
  // A setup file saved by main: it validates, and the restore drops the guess markers.
  const mainFile = { ...full, levels: [{ name: "Size", columns: ["year"] }] };
  assert.ok(isValidSetup(mainFile, columns), "a setup saved by main passes validation");
  const restored = restoredSetup(mainFile);
  assert.ok(!("fresh" in restored), "a setup saved by main loads without its fresh marker");
  assert.ok(!("salesFromValues" in restored), "a setup saved by main loads without its salesFromValues marker");
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("persistedSetupForFile(setup)"), "Save setup to file exports the stripped setup");
  assert.ok(!source.includes("JSON.stringify(setup,"), "Save setup to file no longer serializes the raw setup");
});

test("the fallback's own period rebuild keeps a refused load's error", async () => {
  const { createRefusalHold, viewOf } = await import("../src/app/App.tsx");
  const view = viewOf(1, setup());
  assert.equal(view, viewOf(1, setup()), "the same load and setup build one view");
  const hold = createRefusalHold();
  hold.hold(view);
  assert.equal(hold.spend(view), true, "the fallback's own rebuild keeps the banner");
  assert.equal(hold.spend(view), false, "the hold covers one rebuild only");
});

test("a period rebuild the visitor starts clears a refused load's error", async () => {
  const { createRefusalHold, viewOf } = await import("../src/app/App.tsx");
  const fallback = viewOf(1, setup());
  const held = () => {
    const hold = createRefusalHold();
    hold.hold(fallback);
    return hold;
  };
  assert.equal(
    held().spend(viewOf(1, setup({ grain: "year" }))),
    false,
    "a change of Compare by does not spend the hold",
  );
  assert.equal(
    held().spend(viewOf(1, setup({ periodColumn: "other_date" }))),
    false,
    "a change of Period column does not spend the hold",
  );
  assert.equal(held().spend(viewOf(2, setup())), false, "a new load does not spend the hold");
  assert.equal(createRefusalHold().spend(fallback), false, "nothing held keeps nothing");
  // A setup change builds its view the same way, so the hold cannot reach it.
  assert.notEqual(viewOf(1, setup({ grain: "month" })), fallback, "a changed setup is a different view");
});

// The banner's lifetime spans the real App: the fallback's publish, the profile's
// refinement and the period rebuilds they start. These tests mount that component
// with a scripted database, so the wiring between them runs for real.

type HarnessListener = (event: Record<string, unknown>) => void;

class HarnessNode {
  nodeType: number;
  nodeName: string;
  childNodes: HarnessNode[] = [];
  parentNode: HarnessNode | null = null;
  private listeners = new Map<string, Set<HarnessListener>>();

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): HarnessNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): HarnessNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): HarnessNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[at + 1] ?? null;
  }

  get previousSibling(): HarnessNode | null {
    if (!this.parentNode) return null;
    const at = this.parentNode.childNodes.indexOf(this);
    return at > 0 ? this.parentNode.childNodes[at - 1] : null;
  }

  appendChild(child: HarnessNode): HarnessNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: HarnessNode, before: HarnessNode | null): HarnessNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before === null ? -1 : this.childNodes.indexOf(before);
    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: HarnessNode): HarnessNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) {
      this.childNodes.splice(at, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, listener: HarnessListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: HarnessListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Record<string, unknown>): boolean {
    event.target = event.target ?? this;
    for (const listener of this.listeners.get(String(event.type)) ?? []) listener.call(this, event);
    if (event.bubbles && this.parentNode) return this.parentNode.dispatchEvent(event);
    return true;
  }
}

class HarnessText extends HarnessNode {
  data: string;

  constructor(data: string) {
    super(3, "#text");
    this.data = String(data);
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(value: string) {
    this.data = String(value);
  }

  get textContent(): string {
    return this.data;
  }
}

class HarnessElement extends HarnessNode {
  tagName: string;
  localName: string;
  attributes = new Map<string, string>();
  style: Record<string, unknown> = { setProperty() {} };
  ownValue = "";
  ownSelected = false;
  checked = false;
  disabled = false;
  type = "";

  constructor(tagName: string) {
    super(1, String(tagName).toUpperCase());
    this.tagName = this.nodeName;
    this.localName = String(tagName).toLowerCase();
  }

  get namespaceURI(): string {
    return "http://www.w3.org/1999/xhtml";
  }

  /** An option answers with its value attribute, or with its text when it has none. */
  get value(): string {
    if (this.localName === "select") {
      const chosen = harnessNodes(this, "OPTION").find((option) => option.ownSelected);
      return chosen ? chosen.value : this.ownValue;
    }
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    return this.ownValue;
  }

  set value(next: string) {
    this.ownValue = String(next);
    if (this.localName === "select") {
      for (const option of harnessNodes(this, "OPTION")) option.selected = option.value === this.ownValue;
    }
  }

  /** Selecting an option clears its siblings, as a select does. */
  get selected(): boolean {
    return this.ownSelected;
  }

  set selected(next: boolean) {
    this.ownSelected = Boolean(next);
    if (!this.ownSelected || !this.parentNode) return;
    for (const sibling of this.parentNode.childNodes) {
      if (sibling !== this && sibling instanceof HarnessElement) sibling.ownSelected = false;
    }
  }

  get options(): HarnessElement[] {
    return harnessNodes(this, "OPTION");
  }

  get ownerDocument(): HarnessDocument {
    return harnessDocument;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(String(name), String(value));
  }

  setAttributeNS(_namespace: string, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(String(name)) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(String(name));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(String(name));
  }

  get textContent(): string {
    return this.childNodes.map((child) => (child as HarnessElement).textContent ?? "").join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "" && value != null) this.appendChild(new HarnessText(value));
  }

  closest(): null {
    return null;
  }

  focus(): void {}

  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

type HarnessDocument = HarnessElement & {
  createElement(tag: string): HarnessElement;
  createElementNS(namespace: string, tag: string): HarnessElement;
  createTextNode(text: string): HarnessText;
  createComment(text: string): HarnessText;
  documentElement: HarnessElement;
  body: HarnessElement;
  head: HarnessElement;
  HTMLIFrameElement: unknown;
  readyState: string;
};

let harnessDocument: HarnessDocument;

function installHarnessDom(): HarnessDocument {
  const existing = (globalThis as unknown as { document?: HarnessDocument }).document;
  if (existing && (existing as unknown as { body?: unknown }).body) return existing;
  const doc = new HarnessElement("#document") as unknown as HarnessDocument;
  (doc as unknown as { nodeType: number }).nodeType = 9;
  doc.readyState = "complete";
  doc.createElement = (tag: string) => new HarnessElement(tag);
  doc.createElementNS = (_namespace: string, tag: string) => new HarnessElement(tag);
  doc.createTextNode = (text: string) => new HarnessText(text);
  doc.createComment = (text: string) => new HarnessText(text);
  doc.documentElement = new HarnessElement("html");
  doc.head = new HarnessElement("head");
  doc.body = new HarnessElement("body");
  doc.HTMLIFrameElement = class extends HarnessElement {};
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  (doc as unknown as HarnessNode).appendChild(doc.documentElement);
  const windowListeners = new Map<string, Set<HarnessListener>>();
  const view: Record<string, unknown> = {
    document: doc,
    location: { href: "http://127.0.0.1:8790/app/", pathname: "/app/", search: "" },
    navigator: { userAgent: "node" },
    Event: class {
      type: string;
      constructor(type: string, init: Record<string, unknown> = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    Node: HarnessNode,
    Element: HarnessElement,
    HTMLElement: HarnessElement,
    HTMLIFrameElement: doc.HTMLIFrameElement,
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    addEventListener(type: string, listener: HarnessListener) {
      const set = windowListeners.get(type) ?? new Set();
      set.add(listener);
      windowListeners.set(type, set);
    },
    removeEventListener(type: string, listener: HarnessListener) {
      windowListeners.get(type)?.delete(listener);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (work: (time: number) => void) => globalThis.setTimeout(() => work(0), 0),
    cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    confirm: () => true,
    performance: globalThis.performance,
  };
  view.dispatch = (type: string, event: Record<string, unknown>) => {
    event.target = event.target ?? doc.body;
    for (const listener of windowListeners.get(type) ?? []) listener.call(view, event);
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = view;
  globals.document = doc;
  globals.location = view.location;
  globals.Node = HarnessNode;
  globals.Element = HarnessElement;
  globals.HTMLElement = HarnessElement;
  globals.HTMLIFrameElement = doc.HTMLIFrameElement;
  globals.Event = view.Event;
  globals.MutationObserver = view.MutationObserver;
  globals.requestAnimationFrame = view.requestAnimationFrame;
  globals.cancelAnimationFrame = view.cancelAnimationFrame;
  globals.matchMedia = view.matchMedia;
  globals.confirm = view.confirm;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  harnessDocument = doc;
  return doc;
}

const HARNESS_COLUMNS = [
  { column_name: "order_date", column_type: "DATE" },
  { column_name: "other_date", column_type: "DATE" },
  { column_name: "product", column_type: "VARCHAR" },
  { column_name: "units", column_type: "DOUBLE" },
  { column_name: "net_sales", column_type: "DOUBLE" },
];

const GOOD_CSV = [
  "order_date,other_date,product,units,net_sales",
  "2026-01-01,2025-01-01,A-100,2,20",
  "2026-02-01,2026-01-01,A-100,3,33",
  "2026-01-01,2025-01-01,B-200,4,40",
  "2026-02-01,2026-01-01,B-200,5,55",
].join("\n");

const HEADER_ONLY_CSV = "order_date,product,units,net_sales";

interface HarnessDatabase {
  loads: number;
  /** When set, the next DESCRIBE waits on it. */
  describeGate: (() => Promise<void>) | null;
  /** When set, the next profile read waits on it. */
  profileGate: (() => Promise<void>) | null;
  /** How many period views were built over the month grain. */
  monthViews: number;
  query(sql: string): Promise<readonly Record<string, unknown>[]>;
  loadFile(file: unknown, table: string): Promise<number>;
}

function harnessDatabase(): HarnessDatabase {
  const database: HarnessDatabase = {
    loads: 0,
    describeGate: null,
    profileGate: null,
    monthViews: 0,
    async query(sql: string) {
      if (sql.startsWith("CREATE OR REPLACE VIEW") && sql.includes("%Y-%m")) database.monthViews += 1;
      if (/^\s*DESCRIBE/i.test(sql)) {
        // The copy that a newer pick supersedes is held here so the newer pick
        // can arrive while its metadata is still being read.
        if (database.describeGate !== null) {
          const gate = database.describeGate;
          database.describeGate = null;
          await gate();
        }
        return HARNESS_COLUMNS;
      }
      if (sql.includes("duckdb_tables()")) return [];
      if (sql.includes("count(*)::DOUBLE AS n FROM")) return [{ n: 4 }];
      if (sql.includes("SELECT * FROM")) return [];
      if (sql.includes(" AS c0")) {
        if (database.profileGate !== null) {
          const gate = database.profileGate;
          database.profileGate = null;
          await gate();
        }
        // A real profile takes a moment, so the load's own columns commit first.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return [
          {
            c0: 2,
            c1: 2,
            c2: 2,
            c3: 2,
            c4: 2,
            lo0: "2026-01-01",
            hi0: "2026-02-01",
            m0: 2,
            lo1: "2025-01-01",
            hi1: "2026-01-01",
            m1: 2,
            s3: 14,
            s4: 148,
          },
        ];
      }
      if (sql.includes("arg_min")) return [{ present: 0, parsed: 0, records: 4, value: null, at: null, field: 2 }];
      if (sql.includes("ranked")) return [{ p: "2026", numeric: true }];
      return [];
    },
    async loadFile() {
      database.loads += 1;
      if (database.loads === 3) throw new Error("This file has no data rows.");
      return 0;
    },
  };
  return database;
}

function harnessNodes(node: HarnessNode, name: string, found: HarnessElement[] = []): HarnessElement[] {
  if (node instanceof HarnessElement && node.nodeName === name) found.push(node);
  for (const child of node.childNodes) harnessNodes(child, name, found);
  return found;
}

function harnessBanner(container: HarnessNode): string {
  return harnessNodes(container, "P")
    .filter((node) => node.getAttribute("role") === "alert")
    .map((node) => node.textContent)
    .join("");
}

function harnessOptions(select: HarnessElement): string[] {
  return harnessNodes(select, "OPTION").map((option) => option.textContent);
}

test("the banner stays through the fallback's refinement until a visitor change", async () => {
  const doc = installHarnessDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const database = harnessDatabase();
  (globalThis as unknown as { __bridgekitDatabase: HarnessDatabase }).__bridgekitDatabase = database;
  const { App } = await import("../src/app/App.tsx");
  const container = doc.createElement("div");
  doc.body.appendChild(container as unknown as HarnessNode);
  const root = createRoot(container as unknown as Element);
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await React.act(async () => {});
  };
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 300; i += 1) {
      if (check()) return;
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const selects = harnessNodes(container, "SELECT").map(
      (node) => `${node.value}(${harnessOptions(node).join("|")})`,
    );
    throw new Error(`timed out waiting for ${what}: selects ${selects.join(" ")}`);
  };
  const pick = async (name: string, text: string) => {
    const input = harnessNodes(container, "INPUT").find(
      (node) => node.getAttribute("type") === "file" || (node as unknown as { type?: string }).type === "file",
    );
    assert.ok(input, "a file picker is on screen");
    await React.act(async () => {
      (input as unknown as { files: unknown }).files = [new File([text], name, { type: "text/csv" })];
      input.value = "";
      input.dispatchEvent({
        type: "change",
        bubbles: true,
        target: input,
        preventDefault() {},
        stopPropagation() {},
      });
    });
    await flush();
  };
  try {
    await React.act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    await pick("A-100.csv", GOOD_CSV);
    await until(() => harnessBanner(container) === "" && harnessNodes(container, "SELECT").length > 0, "the first load");

    // A copy of the same file, held mid-read, then a header-only file while it reads.
    let releaseCopy: () => void = () => {};
    let releaseProfile: () => void = () => {};
    database.describeGate = () => new Promise<void>((resolve) => (releaseCopy = resolve));
    database.profileGate = () => new Promise<void>((resolve) => (releaseProfile = resolve));

    await pick("A-100 copy.csv", GOOD_CSV);
    await until(() => database.describeGate === null, "the copy's metadata read to start");
    await pick("A-100 header only.csv", HEADER_ONLY_CSV);

    await until(() => harnessBanner(container) === "This file has no data rows.", "the refused file's error");

    // The copy's read finishes late; the fallback has already published it.
    releaseCopy();
    await until(() => database.profileGate === null, "the fallback's profile to start");
    // The refusal is on screen while the profile lands, the moment the refinement
    // used to clear it.
    assert.equal(harnessBanner(container), "This file has no data rows.", "the refusal is on screen before the profile lands");
    // The first load already built a month view, so count only the refinement's own.
    database.monthViews = 0;
    releaseProfile();

    const compare = () => {
      const select = harnessNodes(container, "SELECT").find((node) => harnessOptions(node).includes("Year to date"));
      assert.ok(select, "the Compare by picker is on screen");
      return select;
    };
    await until(() => compare().value === "month", "the profile's refinement to Month");
    await until(() => database.monthViews > 0, "the refinement's period rebuild");

    assert.equal(
      harnessBanner(container),
      "This file has no data rows.",
      "the refusal stays after the automatic refinement and its period rebuild",
    );

    await React.act(async () => {
      const select = compare();
      select.value = "quarter";
      select.dispatchEvent({
        type: "change",
        bubbles: true,
        target: select,
        preventDefault() {},
        stopPropagation() {},
      });
    });
    await flush();
    assert.equal(harnessBanner(container), "", "a visitor's Compare by change clears the refusal");
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    doc.body.removeChild(container as unknown as HarnessNode);
  }
});
