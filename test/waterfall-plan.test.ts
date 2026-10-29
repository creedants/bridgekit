import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { compact, signedCompact } from "../src/app/format.ts";
import type { Step } from "../src/app/small-bridges.ts";
import { steps } from "../src/app/small-bridges.ts";
import type { LabelPlan } from "../src/app/Waterfall.tsx";

// The label plan and the chart option live in Waterfall.tsx, which this runner
// cannot load by itself, so a load hook transforms it the way
// test/results-hint.test.ts does.

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(new URL(url), "utf8");
      const { code } = transformSync(source, { loader: "tsx", format: "esm", jsx: "automatic" });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { bridgeOption, labelPlan } = await import("../src/app/Waterfall.tsx");

const LABELS = [
  "2025",
  "Volume",
  "Mix: Model",
  "Mix: Finish",
  "Mix: Color",
  "Mix: Material",
  "Price (like-for-like)",
  "New configurations",
  "Discontinued configurations",
  "2026",
];
const VALUES = ["57.9M", "+4.8M", "+1.1M", "+823.7K", "+2.2M", "-93.7K", "+1M", "+3.5M", "-961.6K", "70.4M"];
const PRIOR = 57_940_000;

/** The bars of a bridge whose first and last labels are its periods and the rest its effects. */
function bridge(labels: string[], prior: number, amounts: number[]): Step[] {
  const effects = labels.slice(1, -1).map((label, i) => ({ key: `k${i}`, label, value: amounts[i] }));
  const current = prior + amounts.reduce((sum, value) => sum + value, 0);
  return steps({ priorSales: prior, currentSales: current, effects, coverage: [], cellsTable: "" }, labels[0], labels.at(-1)!);
}

/** Bars whose value labels read as VALUES. */
function tenSteps(): Step[] {
  return bridge(LABELS, PRIOR, [4_812_000, 1_093_000, 823_700, 2_215_000, -93_700, 1_004_000, 3_540_000, -961_600]);
}

const valueText = (bar: Step) => (bar.kind === "total" ? compact(bar.value) : signedCompact(bar.value));

const THEME = {
  font: "Sans",
  total: "#111",
  up: "#222",
  down: "#333",
  text: "#444",
  text2: "#555",
  text3: "#666",
  lineStrong: "#777",
  grid: "#888",
  bg: "#999",
};

/** The option as plain data, so a test can reach into it. */
function draw(bars: Step[], plan: LabelPlan, width: number, slim = false): Record<string, any> {
  return bridgeOption({
    bars,
    plan,
    slim,
    width,
    theme: THEME,
    priorSales: PRIOR,
    touch: () => false,
    selectable: () => !slim,
  });
}

function option(width: number, slim = false): Record<string, any> {
  return draw(tenSteps(), labelPlan(LABELS, VALUES, width), width, slim);
}

/** The path of every `rotate` key anywhere in an option, whatever its angle. */
function rotations(value: unknown, path = "option"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => rotations(item, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === "rotate" ? [`${path}.${key}`] : rotations(item, `${path}.${key}`),
  );
}

/** Width at the 11 px the row names and value labels are drawn in, as labelPlan estimates it. */
const at11 = (text: string) => text.length * 11 * 0.6;

// Recorded from the chart as it was before phone widths drew rows. 659 px is the main chart at 1440x900
// and 702 px at 1024x768; both drew every label level. The plan has since gained `layout` and lost
// `axisRotate: 0`, `valueRotate: 0` and `top: 26`, which a level plan always had; the option is unchanged.
const WIDE_PLAN = {
  layout: "columns",
  axis: ["2025", "Volume", "Mix:\nModel", "Mix:\nFinish", "Mix:\nColor", "Mix:\nMaterial", "Price", "New\nconfigs", "Discont.\nconfigs", "2026"],
  values: VALUES,
};
const WIDE_OPTION =
  '{"animation":false,"textStyle":{"fontFamily":"Sans"},"grid":{"left":4,"right":8,"top":26,"bottom":4,"containLabel":true},"tooltip":{"trigger":"axis","enterable":true,"axisPointer":{"type":"shadow"},"backgroundColor":"#999","borderColor":"#777","borderRadius":0,"textStyle":{"color":"#444","fontSize":12}},"xAxis":{"type":"category","data":["2025","Volume","Mix:\\nModel","Mix:\\nFinish","Mix:\\nColor","Mix:\\nMaterial","Price","New\\nconfigs","Discont.\\nconfigs","2026"],"axisTick":{"show":false},"axisLine":{"lineStyle":{"color":"#777"}},"axisLabel":{"color":"#555","fontSize":11,"interval":0,"lineHeight":14,"rotate":0}},"yAxis":{"type":"value","min":40000000,"axisLabel":{"color":"#666","fontSize":11},"splitLine":{"lineStyle":{"color":"#888"}}},"series":[{"type":"bar","stack":"bridge","stackStrategy":"all","silent":true,"itemStyle":{"color":"transparent"},"data":[0,57940000,62752000,63845000,64668700,66790000,66790000,67794000,70372400,0]},{"type":"bar","stack":"bridge","stackStrategy":"all","barMaxWidth":52,"cursor":"pointer","emphasis":{"disabled":false},"label":{"show":true,"position":"top","color":"#444","fontSize":11},"data":[{"value":57940000,"itemStyle":{"color":"#111","borderRadius":[2,2,0,0]}},{"value":4812000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":1093000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":823700,"itemStyle":{"color":"#222","borderRadius":2}},{"value":2215000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":93700,"itemStyle":{"color":"#333","borderRadius":2}},{"value":1004000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":3540000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":961600,"itemStyle":{"color":"#333","borderRadius":2}},{"value":70372400,"itemStyle":{"color":"#111","borderRadius":[2,2,0,0]}}]}]}';
const SLIM_OPTION =
  '{"animation":false,"textStyle":{"fontFamily":"Sans"},"grid":{"left":4,"right":8,"top":26,"bottom":4,"containLabel":true},"tooltip":{"trigger":"axis","enterable":true,"axisPointer":{"type":"shadow"},"backgroundColor":"#999","borderColor":"#777","borderRadius":0,"textStyle":{"color":"#444","fontSize":12}},"xAxis":{"type":"category","data":["2025","Volume","Mix:\\nModel","Mix:\\nFinish","Mix:\\nColor","Mix:\\nMaterial","Price","New\\nconfigs","Discont.\\nconfigs","2026"],"axisTick":{"show":false},"axisLine":{"lineStyle":{"color":"#777"}},"axisLabel":{"show":false}},"yAxis":{"type":"value","min":40000000,"axisLabel":{"color":"#666","fontSize":9},"splitLine":{"lineStyle":{"color":"#888"}}},"series":[{"type":"bar","stack":"bridge","stackStrategy":"all","silent":true,"itemStyle":{"color":"transparent"},"data":[0,57940000,62752000,63845000,64668700,66790000,66790000,67794000,70372400,0]},{"type":"bar","stack":"bridge","stackStrategy":"all","barMaxWidth":52,"labelLayout":{"hideOverlap":true},"cursor":"default","emphasis":{"disabled":false},"label":{"show":true,"position":"top","color":"#444","fontSize":9},"data":[{"value":57940000,"itemStyle":{"color":"#111","borderRadius":[2,2,0,0]}},{"value":4812000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":1093000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":823700,"itemStyle":{"color":"#222","borderRadius":2}},{"value":2215000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":93700,"itemStyle":{"color":"#333","borderRadius":2}},{"value":1004000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":3540000,"itemStyle":{"color":"#222","borderRadius":2}},{"value":961600,"itemStyle":{"color":"#333","borderRadius":2}},{"value":70372400,"itemStyle":{"color":"#111","borderRadius":[2,2,0,0]}}]}]}';

test("a desktop-width bridge keeps the label plan it had", () => {
  for (const width of [659, 702]) assert.deepEqual(labelPlan(LABELS, VALUES, width), WIDE_PLAN, `at ${width} px`);
});

test("a desktop-width bridge draws the chart it drew", () => {
  for (const width of [659, 702]) assert.equal(JSON.stringify(option(width)), WIDE_OPTION, `at ${width} px`);
  assert.equal(JSON.stringify(option(659, true)), SLIM_OPTION);
});

test("a desktop-width bridge keeps its value labels and tooltips", () => {
  const drawn = option(659);
  const labels = tenSteps().map((_, dataIndex) => drawn.series[1].label.formatter({ dataIndex }));
  assert.deepEqual(labels, VALUES);
  assert.equal(drawn.tooltip.formatter([{ dataIndex: 0 }]), "<b>2025</b><br/>57,940,000");
  assert.equal(
    drawn.tooltip.formatter([{ dataIndex: 1 }]),
    "<b>Volume</b><br/>+4,812,000<br/>8.3% of prior sales<br/><i>Select for movers</i>",
  );
  assert.equal(drawn.yAxis.axisLabel.formatter(40_000_000), "40M");
});

// 343 px is the main chart at 375x667 and 358 px at 390x844.
const PHONES = [343, 358];

const SAMPLE_LABELS = [
  "2025",
  "Volume",
  "Mix: Region",
  "Mix: Channel",
  "Mix: Tier",
  "Price (like-for-like)",
  "New configurations",
  "Discontinued configurations",
  "Sales with no units",
  "2026",
];
const SAMPLE = bridge(SAMPLE_LABELS, 1_284_500, [96_300, -12_450, 30_100, 4_780, 58_200, -41_930, -2_100, 0]);

for (const [name, bars] of [
  ["ten-step bridge", tenSteps()],
  ["sample-like bridge", SAMPLE],
] as const) {
  test(`a ${name} on a phone draws a level row per step`, () => {
    const labels = bars.map((bar) => bar.label);
    const values = bars.map(valueText);
    for (const width of PHONES) {
      const plan = labelPlan(labels, values, width);
      assert.equal(plan.layout, "rows", `at ${width} px`);
      if (plan.layout !== "rows") continue;
      assert.deepEqual(plan.values, values, `at ${width} px`);
      assert.equal(plan.axis.length, labels.length);
      for (const row of plan.axis) {
        assert.ok(!row.includes("\n"), `"${row}" is on more than one line at ${width} px`);
        assert.ok(at11(row) <= width * 0.4, `"${row}" is wider than 40% of ${width} px`);
      }
      assert.equal(plan.axis[labels.indexOf("Price (like-for-like)")], "Price");
      assert.equal(plan.axis[labels.indexOf("Discontinued configurations")], "Discont. configs");
      const widest = Math.max(...values.map(at11));
      assert.ok(plan.valueRoom >= widest + 4, `value room ${plan.valueRoom} px is short of ${widest} px at ${width} px`);
      assert.equal(plan.height, labels.length * 28 + 40);

      const drawn = draw(bars, plan, width);
      assert.deepEqual(rotations(drawn), [], `at ${width} px`);
      assert.equal(drawn.yAxis.type, "category");
      assert.equal(drawn.yAxis.inverse, true);
      assert.deepEqual(drawn.yAxis.data, plan.axis);
      assert.equal(drawn.yAxis.axisLabel.fontFamily, THEME.font, "row names are sized in the font they are drawn in");
      assert.equal(drawn.xAxis.type, "value");
      assert.equal(drawn.grid.right, 8 + plan.valueRoom);
      assert.equal(drawn.series[1].label.position, "right");
      assert.deepEqual(
        bars.map((_, dataIndex) => drawn.series[1].label.formatter({ dataIndex })),
        values,
      );
      const totals = drawn.series[1].data.filter((_: unknown, i: number) => bars[i].kind === "total");
      for (const total of totals) assert.deepEqual(total.itemStyle.borderRadius, [0, 2, 2, 0]);
    }
  });
}

test("a phone's rows keep the desktop chart's axis floor, bar extents and tooltips", () => {
  const rows = option(343);
  const columns = option(659);
  assert.equal(rows.xAxis.min, columns.yAxis.min);
  assert.deepEqual(rows.series[0], columns.series[0]);
  assert.deepEqual(
    rows.series[1].data.map((bar: { value: number }) => bar.value),
    columns.series[1].data.map((bar: { value: number }) => bar.value),
  );
  for (let dataIndex = 0; dataIndex < LABELS.length; dataIndex++) {
    assert.equal(rows.tooltip.formatter([{ dataIndex }]), columns.tooltip.formatter([{ dataIndex }]));
  }
});

test("a scaled bridge on a phone keeps its shared scale", () => {
  const bars = tenSteps();
  const plan = labelPlan(LABELS, VALUES, 343);
  const drawn = bridgeOption({
    bars,
    plan,
    scale: { min: 30_000_000, max: 90_000_000 },
    width: 343,
    theme: THEME,
    priorSales: PRIOR,
    touch: () => false,
    selectable: () => true,
  }) as Record<string, any>;
  assert.equal(drawn.xAxis.min, 30_000_000);
  assert.equal(drawn.xAxis.max, 90_000_000);
});

test("a small panel draws columns whatever its plan", () => {
  const bars = tenSteps();
  const rows = labelPlan(LABELS, VALUES, 230);
  assert.equal(rows.layout, "rows");
  const columns: LabelPlan = { layout: "columns", axis: rows.axis, values: rows.values };
  assert.equal(JSON.stringify(draw(bars, rows, 230, true)), JSON.stringify(draw(bars, columns, 230, true)));
  assert.equal(draw(bars, rows, 230, true).xAxis.type, "category");
});

test("a long bridge on a phone grows a row per step and turns no label", () => {
  const labels = ["2025", ...Array.from({ length: 23 }, (_, i) => `Mix: Group ${i + 1}`), "2026"];
  const bars = bridge(labels, 4_000_000, Array.from({ length: 23 }, (_, i) => (i % 3 === 0 ? -1 : 1) * (12_000 + i * 1_700)));
  const plan = labelPlan(labels, bars.map(valueText), 343);
  assert.equal(plan.layout, "rows");
  if (plan.layout !== "rows") return;
  assert.equal(plan.height, 25 * 28 + 40);
  assert.deepEqual(rotations(draw(bars, plan, 343)), []);
});
