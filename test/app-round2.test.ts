import assert from "node:assert/strict";
import { test } from "node:test";
import { makeDownloader } from "../src/app/files.ts";
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
  type Setup,
} from "../src/app/setup.ts";

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
