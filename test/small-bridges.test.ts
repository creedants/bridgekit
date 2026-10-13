import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeBy, BridgePanel, BridgeResult } from "../src/engine.ts";
import {
  BETWEEN_SENTENCE,
  BLANK_TITLE,
  COMBINED_TITLE,
  attemptSplit,
  axisCaption,
  axisFloor,
  betweenLine,
  chartStack,
  createAttemptCache,
  createConnectionQueue,
  createSplitRunner,
  focusPlace,
  gridAction,
  noticesAreStale,
  panelStatusLabel,
  panelTitle,
  sharedScale,
  SPLIT_FAILURE_SENTENCE,
  splitBelongs,
  statementStartsTurn,
  steps,
  type ScreenBridge,
  type Step,
} from "../src/app/small-bridges.ts";
import { compact } from "../src/app/format.ts";

function bridge(priorSales: number, effects: [string, number][]): BridgeResult {
  let running = priorSales;
  const built = effects.map(([key, value]) => {
    running += value;
    return { key, label: key, value };
  });
  return { priorSales, currentSales: running, effects: built, coverage: [], cellsTable: "" };
}

/** The bars of one bridge, as a grid draws them. */
function drawn(result: BridgeResult): Step[] {
  return steps(result, "2025", "2026");
}

type ValuePanel = Extract<BridgePanel, { combined: false }>;
type RestPanel = Extract<BridgePanel, { combined: true }>;

function panel(over: Partial<ValuePanel> & { value: string | null }): BridgePanel {
  return {
    combined: false,
    values: 1,
    status: "continuing",
    priorSales: 0,
    currentSales: 0,
    change: 0,
    result: null,
    ...over,
  };
}

function rest(over: Partial<RestPanel>): BridgePanel {
  return {
    combined: true,
    value: null,
    values: 3,
    status: "continuing",
    priorSales: 0,
    currentSales: 0,
    change: 0,
    result: null,
    ...over,
  };
}

/** Both ends of every bar, which is what a scale has to cover. */
function levels(bars: Step[]): number[] {
  return bars.flatMap((bar) => (bar.kind === "total" ? [bar.high] : [bar.low, bar.high]));
}

test("a bridge's bars run from the prior total to the current one", () => {
  assert.deepEqual(
    drawn(bridge(1000, [["volume", 200], ["price", -50]])).map((bar) => [bar.label, bar.low, bar.high, bar.kind, bar.key]),
    [
      ["2025", 0, 1000, "total", null],
      ["volume", 1000, 1200, "up", "volume"],
      ["price", 1150, 1200, "down", "price"],
      ["2026", 0, 1150, "total", null],
    ],
  );
});

test("the floor rises only while every bar stays in view", () => {
  // The steps are as wide as the totals, so the axis starts at zero.
  assert.equal(axisFloor(drawn(bridge(1000, [["volume", 2000]]))), 0);
  // Steps are small next to the totals, so the axis starts above zero to show them.
  assert.equal(axisFloor(drawn(bridge(1000, [["volume", 20]]))), 980);
  // A step that crosses zero lowers the axis to the lowest level, so the bar is drawn whole.
  assert.equal(axisFloor(drawn(bridge(1000, [["volume", -1400]]))), -400);
  // A bridge wholly below zero lowers the axis to that level.
  assert.equal(axisFloor(drawn(bridge(-50, []))), -50);
  assert.equal(axisFloor(drawn(bridge(-50, [["price", 10], ["cost", -5]]))), -50);
  // Nothing at all leaves the axis at zero over one unit.
  assert.equal(axisFloor(drawn(bridge(0, []))), 0);
});

test("the caption is the existing sentence only when the axis does not start at zero", () => {
  assert.equal(axisCaption(drawn(bridge(1000, [["volume", 2000]]))), null);
  assert.equal(axisCaption(drawn(bridge(0, []))), null);
  const raised = `Value axis starts at ${compact(980)}, not zero, so the steps are visible.`;
  assert.equal(axisCaption(drawn(bridge(1000, [["volume", 20]]))), raised);
  const below = `Value axis starts at ${compact(-400)}, not zero, so the steps are visible.`;
  assert.equal(axisCaption(drawn(bridge(1000, [["volume", -1400]]))), below);
  assert.equal(axisCaption(drawn(bridge(-170, [["volume", -5]]))), `Value axis starts at ${compact(-175)}, not zero, so the steps are visible.`);
});

test("a panel's title is its value, with the two fixed titles for blank and combined", () => {
  assert.equal(panelTitle(panel({ value: "East" })), "East");
  assert.equal(panelTitle(panel({ value: "North & South" })), "North & South");
  assert.equal(panelTitle(panel({ value: null })), BLANK_TITLE);
  assert.equal(panelTitle(panel({ value: "" })), BLANK_TITLE);
  assert.equal(panelTitle(rest({ values: 4 })), COMBINED_TITLE);
});

test("a value with no bridge is named with the words the page already uses", () => {
  assert.equal(panelStatusLabel("new"), "New");
  assert.equal(panelStatusLabel("lost"), "Lost");
  assert.equal(panelStatusLabel("no_units"), "Sales with no units");
  // A value that bridges needs no word, so its panel shows a chart instead.
  assert.equal(panelStatusLabel("continuing"), null);
});

test("one scale covers every panel's bars, its negative steps included", () => {
  const all = [
    drawn(bridge(1000, [["volume", 200]])),
    drawn(bridge(400, [["volume", -900]])),
    drawn(bridge(50, [["volume", 10]])),
  ];
  assert.deepEqual(sharedScale(all), { min: -500, max: 1200 });
  for (const bars of all) {
    for (const level of levels(bars)) {
      assert.ok(level >= -500 && level <= 1200, `${level} is inside the scale`);
    }
  }
});

test("the scale's ceiling is the highest level any panel reaches", () => {
  const first = drawn(bridge(1000, [["volume", 200]]));
  const second = drawn(bridge(900, [["volume", 50]]));
  assert.equal(sharedScale([first, second]).max, 1200);
  assert.equal(sharedScale([second, first]).max, 1200);
});

test("a grid with nothing to draw still has a scale", () => {
  assert.deepEqual(sharedScale([]), { min: 0, max: 1 });
  assert.deepEqual(sharedScale([drawn(bridge(0, []))]), { min: 0, max: 1 });
});

test("the between line carries the sentence and one signed figure per effect", () => {
  const by = {
    column: "region",
    total: bridge(1000, [["volume", 200]]),
    between: [
      { key: "volume", label: "Volume", value: 1200 },
      { key: "price", label: "Price (like-for-like)", value: -350.5 },
      { key: "no_units", label: "Sales with no units", value: 0 },
    ],
    panels: [],
  } as BridgeBy;
  assert.equal(
    betweenLine(by),
    `${BETWEEN_SENTENCE} Volume +1,200, Price (like-for-like) -351, Sales with no units 0`,
  );
  assert.equal(BETWEEN_SENTENCE.endsWith(":"), true);
  // Each effect keeps the label the bridge table gives it, in the engine's order.
  assert.deepEqual(by.between.map((e) => e.label), ["Volume", "Price (like-for-like)", "Sales with no units"]);
});

test("a bar below zero keeps the base and height that meet at its ends", () => {
  // Prior margin -50, Price +10, Unit cost -5. The bar must run from low to high.
  assert.deepEqual(chartStack(drawn(bridge(-50, [["Price", 10], ["Unit cost", -5]]))), {
    strategy: "all",
    bases: [0, -50, -45, 0],
    extents: [-50, 10, 5, -45],
  });
});

test("a bar above zero keeps the same base and height", () => {
  assert.deepEqual(chartStack(drawn(bridge(1000, [["volume", 200], ["price", -50]]))), {
    strategy: "all",
    bases: [0, 1000, 1150, 0],
    extents: [1000, 200, 50, 1150],
  });
});

test("the setup notice is the only text that makes a result stale", () => {
  assert.equal(noticesAreStale(["Restored the setup you last used with these columns."]), false);
  assert.equal(
    noticesAreStale(["The setup changed since this bridge was calculated. Calculate again to update it.", "Reading periods…"]),
    true,
  );
  assert.equal(noticesAreStale([]), false);
});

test("a stale split calculates nothing, and the grid for that same column stays", () => {
  assert.equal(gridAction("", false, ""), "clear");
  assert.equal(gridAction("design", false, ""), "calculate");
  assert.equal(gridAction("design", true, "design"), "keep");
  assert.equal(gridAction("coating", true, "design"), "clear");
  assert.equal(gridAction("design", true, ""), "clear");
});

test("opening a panel focuses the way back, and closing focuses the panel or the select", () => {
  assert.equal(focusPlace("open", true), "back");
  assert.equal(focusPlace("close", true), "trigger");
  assert.equal(focusPlace("close", false), "select");
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("statements from one engine call stay together and a later call waits", async () => {
  const queue = createConnectionQueue();
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const query = (name: string) =>
    queue.schedule(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${name}:start`);
      await delay(12);
      active -= 1;
      order.push(`${name}:end`);
    });
  async function runBridge(tag: string) {
    await query(`${tag}:prior`);
    await query(`${tag}:create`);
    await query(`${tag}:totals`);
    await query(`${tag}:coverage`);
  }
  async function bridgeBy(tag: string) {
    await runBridge(tag);
    await query(`${tag}:census`);
    await query(`${tag}:panel`);
  }
  const clicked = new Promise<void>((resolve) => {
    setTimeout(() => {
      void query("click").then(() => resolve());
    }, 8);
  });
  await Promise.all([bridgeBy("grid"), clicked]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    "grid:prior:start",
    "grid:prior:end",
    "grid:create:start",
    "grid:create:end",
    "grid:totals:start",
    "grid:totals:end",
    "grid:coverage:start",
    "grid:coverage:end",
    "grid:census:start",
    "grid:census:end",
    "grid:panel:start",
    "grid:panel:end",
    "click:start",
    "click:end",
  ]);
});

test("a split replaced before it starts never runs, and only the latest follows a running one", async () => {
  const ran: string[] = [];
  const runner = createSplitRunner(async (column) => {
    ran.push(`${column}:start`);
    await delay(15);
    ran.push(`${column}:end`);
  });
  runner.request("design");
  runner.request("coating");
  runner.request("material");
  await runner.settled();
  assert.deepEqual(ran, ["material:start", "material:end"]);

  const followed: string[] = [];
  const second = createSplitRunner(async (column) => {
    followed.push(`${column}:start`);
    await delay(15);
    followed.push(`${column}:end`);
  });
  second.request("design");
  await Promise.resolve();
  second.request("coating");
  second.request("customer");
  await second.settled();
  assert.deepEqual(followed, ["design:start", "design:end", "customer:start", "customer:end"]);
});

const screen = (over: Partial<ScreenBridge> = {}): ScreenBridge => ({
  column: "coating",
  calculation: 1,
  rows: 0,
  ...over,
});

test("a split result belongs only to the bridge and the rows it started with", () => {
  const started = screen();
  assert.equal(splitBelongs(started, screen(), false), true);
  assert.equal(splitBelongs(started, screen({ column: "design" }), false), false);
  assert.equal(splitBelongs(started, screen({ calculation: 2 }), false), false);
  assert.equal(splitBelongs(started, screen({ rows: 1 }), false), false);
  assert.equal(splitBelongs(started, screen(), true), false);
  assert.equal(splitBelongs(screen({ column: "" }), screen({ column: "" }), false), false);
});

test("replacing the loaded table takes its own turn, and a temporary table does not", () => {
  assert.equal(statementStartsTurn('\nCREATE OR REPLACE TABLE "sales" AS'), true);
  assert.equal(statementStartsTurn('CREATE OR REPLACE TEMP TABLE bridge_cells'), false);
  assert.equal(statementStartsTurn("CREATE OR REPLACE VIEW bridge_ready AS SELECT 1"), false);
  assert.equal(statementStartsTurn("SELECT 1"), false);
});

test("a load waits out the engine call instead of joining it", async () => {
  const queue = createConnectionQueue();
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const run = async (name: string, body: () => Promise<unknown>) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${name}:start`);
    await body();
    active -= 1;
    order.push(`${name}:end`);
  };
  const engine = (async () => {
    await queue.schedule(() => run("prior", () => delay(8)));
    const loading = queue.turn(() => run("load", () => delay(8)));
    await queue.schedule(() => run("panel", () => delay(8)));
    await loading;
  })();
  await engine;
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["prior:start", "prior:end", "panel:start", "panel:end", "load:start", "load:end"]);
});

test("a rejected load restores the row generation and the next load is a new one", async () => {
  const queue = createConnectionQueue();
  let notices = 0;
  const stop = queue.whenTurnRejected(() => {
    notices += 1;
  });
  const started = queue.turn(async () => {
    assert.equal(queue.generation(), 1);
    throw new Error("load failed");
  });
  assert.equal(queue.generation(), 1);
  await assert.rejects(started, /load failed/);
  assert.equal(queue.generation(), 0);
  assert.equal(notices, 1);
  await queue.turn(async () => {
    assert.equal(queue.generation(), 1);
  });
  assert.equal(queue.generation(), 1);
  assert.equal(notices, 1);
  stop();
});

test("a failed queue install is forgotten, and the split ends on the existing sentence", async () => {
  assert.equal(SPLIT_FAILURE_SENTENCE, "The small bridges could not be calculated.");
  const cache = createAttemptCache();
  let opens = 0;
  const here = screen();
  const fail = await attemptSplit({
    started: here,
    screen: () => here,
    stale: () => false,
    install: () => cache.run(async () => {
      opens += 1;
      throw new Error("worker did not start");
    }),
    prepare: async () => "query",
    calculate: async () => "grid",
  });
  assert.deepEqual(fail, { status: "fail" });
  const again = await attemptSplit({
    started: here,
    screen: () => here,
    stale: () => false,
    install: () => cache.run(async () => {
      opens += 1;
    }),
    prepare: async () => "query",
    calculate: async (prepared) => prepared,
  });
  assert.deepEqual(again, { status: "grid", result: "query" });
  assert.equal(opens, 2);

  const moved = screen({ rows: 1 });
  const dropped = await attemptSplit({
    started: here,
    screen: () => moved,
    stale: () => false,
    install: async () => {
      throw new Error("worker did not start");
    },
    prepare: async () => "query",
    calculate: async () => "grid",
  });
  assert.deepEqual(dropped, { status: "drop" });
});
