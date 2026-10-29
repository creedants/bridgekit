import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { Step } from "../src/app/small-bridges.ts";
import { steps } from "../src/app/small-bridges.ts";

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

/** Bars whose labels read as VALUES. */
function tenSteps(): Step[] {
  const amounts = [4_812_000, 1_093_000, 823_700, 2_215_000, -93_700, 1_004_000, 3_540_000, -961_600];
  const effects = LABELS.slice(1, -1).map((label, i) => ({ key: `k${i}`, label, value: amounts[i] }));
  const current = PRIOR + amounts.reduce((sum, value) => sum + value, 0);
  return steps({ priorSales: PRIOR, currentSales: current, effects, coverage: [], cellsTable: "" }, "2025", "2026");
}

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
function option(width: number, slim = false): Record<string, any> {
  const plan = labelPlan(LABELS, VALUES, width);
  return bridgeOption({
    bars: tenSteps(),
    plan,
    slim,
    width,
    theme: THEME,
    priorSales: PRIOR,
    touch: () => false,
    selectable: () => !slim,
  });
}

// Recorded from the chart as it was before phone widths drew rows. 659 px is the main chart at 1440x900
// and 702 px at 1024x768; both drew every label level.
const WIDE_PLAN = {
  axis: ["2025", "Volume", "Mix:\nModel", "Mix:\nFinish", "Mix:\nColor", "Mix:\nMaterial", "Price", "New\nconfigs", "Discont.\nconfigs", "2026"],
  axisRotate: 0,
  values: VALUES,
  valueRotate: 0,
  top: 26,
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
