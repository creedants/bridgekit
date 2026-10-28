import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import type React from "react";
import type { BridgeResult } from "../engine.ts";
import { saveOnce } from "./files.ts";
import { compact, signedCompact } from "./format.ts";
import { axisCaption, axisFloor, chartStack, steps, type Step, type ValueScale } from "./small-bridges.ts";

echarts.use([BarChart, GridComponent, TooltipComponent, LegacyGridContainLabel, CanvasRenderer]);

/** The three colour words, the caller's controls and any action of its own. */
export function Legend(props: { controls?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="legend">
      <span className="key"><i style={{ background: "var(--up)" }} /> Increase</span>
      <span className="key"><i style={{ background: "var(--down)" }} /> Decrease</span>
      <span className="key"><i style={{ background: "var(--total)" }} /> Period total</span>
      <span className="legend-controls">{props.controls}</span>
      {props.actions}
    </div>
  );
}

export interface LabelPlan {
  /** Category labels, wrapped onto at most two lines and cut with "…" when even that is too long. */
  axis: string[];
  axisRotate: 0 | 50;
  /** Value labels, every one shown with its sign. */
  values: string[];
  /** Upright value labels when they are wider than a bar's slot. */
  valueRotate: 0 | 90;
  /** Room above the bars for the value labels. */
  top: number;
}

type Measure = (text: string, fontSize: number) => number;

/** A width estimate for tests and for a browser without a canvas. */
const estimate: Measure = (text, fontSize) => text.length * fontSize * 0.6;

const SHORT_TERMS: [string, string][] = [
  ["Discontinued configurations", "Discont. configs"],
  ["New configurations", "New configs"],
  ["Sales with no units", "No units"],
];

/** Words onto lines that fit; a word too wide alone is cut when `cutWords`, and otherwise the wrap fails. */
function wrap(text: string, fits: (line: string) => boolean, cutWords = false): string[] | null {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const joined = lines.length > 0 ? `${lines[lines.length - 1]} ${word}` : word;
    if (lines.length > 0 && fits(joined)) lines[lines.length - 1] = joined;
    else if (fits(word) || cutWords) lines.push(cut(word, fits));
    else return null;
  }
  return lines;
}

/** Cuts `text` with "…" to the longest start that fits. */
function cut(text: string, fits: (line: string) => boolean): string {
  if (fits(text)) return text;
  let end = text.length - 1;
  while (end > 1 && !fits(`${text.slice(0, end).trimEnd()}…`)) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Where a waterfall's labels go, decided before drawing so none overlaps another or loses its sign. Labels
 * that fit stay level; a bar slot too narrow for its words angles every category label instead; a long
 * attribute name is cut, and the tooltip keeps it whole.
 */
export function labelPlan(
  labels: readonly string[],
  values: readonly string[],
  widthPx: number,
  measure: Measure = estimate,
): LabelPlan {
  const valueSize = 11;
  const axisSize = widthPx < 560 ? 10 : 11;
  const widest = (texts: readonly string[], size: number) => Math.max(0, ...texts.map((t) => measure(t, size)));
  // The value axis takes about the width of the widest value; the rest is shared by the bars.
  const slot = (widthPx - widest(values, valueSize) - 20) / Math.max(labels.length, 1);
  const valueWidth = widest(values, valueSize);
  const valueRotate = valueWidth <= slot - 4 ? 0 : 90;
  const top = valueRotate === 0 ? 26 : Math.ceil(valueWidth) + 12;

  const lineFits = (line: string) => measure(line, axisSize) <= slot - 6;
  const shorter = (label: string) =>
    SHORT_TERMS.reduce((text, [long, brief]) => text.replace(long, brief), label.replace(" (like-for-like)", ""));
  // Seven characters a line is the least a level label can say; below that every label is angled.
  if (lineFits("Volume.")) {
    const axis = labels.map((label) => {
      for (const candidate of [label.replace(" (like-for-like)", ""), shorter(label)]) {
        const lines = wrap(candidate, lineFits);
        if (lines && lines.length <= 2) return lines.join("\n");
      }
      const [first, ...rest] = wrap(shorter(label), lineFits, true) ?? [];
      return rest.length === 0 ? first : `${first}\n${cut(rest.join(" "), lineFits)}`;
    });
    return { axis, axisRotate: 0, values: [...values], valueRotate, top };
  }
  const axis = labels.map((label) => cut(shorter(label), (line) => measure(line, axisSize) <= 110));
  return { axis, axisRotate: 50, values: [...values], valueRotate, top };
}

function canvasMeasure(font: string): Measure {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return estimate;
  return (text, fontSize) => {
    context.font = `${fontSize}px ${font}`;
    return context.measureText(text).width;
  };
}

/**
 * One bridge drawn as floating bars. The main waterfall and a small bridge in a
 * panel both draw through here, so one set of steps, colours and click plumbing
 * serves both. Without `onSelect` the chart is not clickable and its tooltip
 * says nothing about movers, which is what a panel that cannot be drilled needs.
 */
export function BridgeChart(props: {
  bars: Step[];
  /** The period sales the tooltip's share is of. */
  priorSales: number;
  /** Called with an effect key when its bar is clicked. */
  onSelect?: (effectKey: string) => void;
  /** One value axis several charts share, so their bar heights compare. */
  scale?: ValueScale;
  /** Drops the category labels and shrinks the axis text, for a chart too small to carry them. */
  slim?: boolean;
  ariaLabel: string;
  /** Hands the chart up so a caller can offer its own download. */
  onReady?: (chart: echarts.ECharts | null) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;
  const onReady = useRef(props.onReady);
  onReady.current = props.onReady;
  const { bars, priorSales, scale, slim } = props;

  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    onReady.current?.(chart);
    const colors = { total: token("--total"), up: token("--up"), down: token("--down") };
    const ink = token("--text");
    const stack = chartStack(bars);
    const valueText = (bar: Step) => (bar.kind === "total" ? compact(bar.value) : signedCompact(bar.value));
    const width = element.current.clientWidth;
    const plan = labelPlan(bars.map((b) => b.label), bars.map(valueText), width, canvasMeasure(token("--font")));
    // A finger has no hover: a tap shows the value, and the tooltip's own button opens Movers.
    const box = element.current;
    let touch = matchMedia("(pointer: coarse)").matches;
    const onPointer = (event: PointerEvent) => {
      touch = event.pointerType === "touch";
    };
    box.addEventListener("pointerdown", onPointer);

    chart.setOption({
      animation: false,
      textStyle: { fontFamily: token("--font") },
      grid: { left: 4, right: 8, top: slim ? 26 : plan.top, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        enterable: true,
        axisPointer: { type: touch ? "none" : "shadow" },
        backgroundColor: token("--bg"),
        borderColor: token("--line-strong"),
        textStyle: { color: ink, fontSize: 12 },
        formatter: (params: { dataIndex: number }[]) => {
          const bar = bars[params[0].dataIndex];
          const amount = bar.value.toLocaleString("en-US", { maximumFractionDigits: 0 });
          if (bar.kind === "total") return `<b>${bar.label}</b><br/>${amount}`;
          const share = ((bar.value / priorSales) * 100).toFixed(1);
          const hint = !onSelect.current
            ? ""
            : touch
              ? `<br/><button type="button" class="tip-action" data-movers="${params[0].dataIndex}">Show movers</button>`
              : "<br/><i>Select for movers</i>";
          return `<b>${bar.label}</b><br/>${bar.value > 0 ? "+" : ""}${amount}<br/>${share}% of prior sales${hint}`;
        },
      },
      xAxis: {
        type: "category",
        data: plan.axis,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: token("--line-strong") } },
        axisLabel: slim
          ? { show: false }
          : { color: token("--text-2"), fontSize: width < 560 ? 10 : 11, interval: 0, lineHeight: 14, rotate: plan.axisRotate },
      },
      yAxis: {
        type: "value",
        min: scale ? scale.min : axisFloor(bars),
        ...(scale ? { max: scale.max } : {}),
        axisLabel: { color: token("--text-3"), fontSize: slim ? 9 : 11, formatter: (v: number) => compact(v) },
        splitLine: { lineStyle: { color: token("--grid") } },
      },
      series: [
        {
          type: "bar",
          stack: "bridge",
          stackStrategy: stack.strategy,
          silent: true,
          itemStyle: { color: "transparent" },
          data: stack.bases,
        },
        {
          type: "bar",
          stack: "bridge",
          stackStrategy: stack.strategy,
          barMaxWidth: 52,
          // A small panel has no room to plan; its colliding labels are dropped, and its tooltip has every value.
          labelLayout: slim ? { hideOverlap: true } : undefined,
          cursor: onSelect.current ? "pointer" : "default",
          emphasis: { disabled: touch },
          label: {
            show: true,
            position: "top",
            color: ink,
            fontSize: slim ? 9 : 11,
            ...(!slim && plan.valueRotate === 90 ? { rotate: 90, align: "left", verticalAlign: "middle", distance: 4 } : {}),
            formatter: (p: { dataIndex: number }) => (slim ? valueText(bars[p.dataIndex]) : plan.values[p.dataIndex]),
          },
          data: bars.map((bar, index) => ({
            value: stack.extents[index],
            itemStyle: { color: colors[bar.kind], borderRadius: bar.kind === "total" ? [2, 2, 0, 0] : 2 },
          })),
        },
      ],
    });

    const select = (index: number) => {
      const key = bars[index]?.key;
      if (key) onSelect.current?.(key);
    };
    if (onSelect.current) {
      chart.on("click", (event) => {
        if (!touch) select(event.dataIndex);
      });
    }
    const onTipAction = (event: MouseEvent) => {
      const action = (event.target as Element).closest?.("[data-movers]");
      if (action) select(Number(action.getAttribute("data-movers")));
    };
    box.addEventListener("click", onTipAction);

    // A tooltip opened by touch has no mouse leaving to close it, and a swipe across the chart opens none.
    const hideTip = () => {
      chart.dispatchAction({ type: "hideTip" });
      chart.dispatchAction({ type: "downplay" });
    };
    let start: { x: number; y: number } | null = null;
    let swiped = false;
    const onTouchStart = (event: TouchEvent) => {
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      swiped = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const t = event.touches[0];
      if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) swiped = true;
    };
    const onTouchEnd = () => {
      if (swiped) setTimeout(hideTip, 0);
    };
    const tapElsewhere = (event: TouchEvent) => {
      if (!box.contains(event.target as Node)) hideTip();
    };
    box.addEventListener("touchstart", onTouchStart, { passive: true });
    box.addEventListener("touchmove", onTouchMove, { passive: true });
    box.addEventListener("touchend", onTouchEnd);
    document.addEventListener("touchstart", tapElsewhere, { passive: true });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      box.removeEventListener("pointerdown", onPointer);
      box.removeEventListener("click", onTipAction);
      box.removeEventListener("touchstart", onTouchStart);
      box.removeEventListener("touchmove", onTouchMove);
      box.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchstart", tapElsewhere);
      onReady.current?.(null);
      observer.disconnect();
      chart.dispose();
    };
  }, [bars, priorSales, scale, slim]);

  return <div ref={element} className="chart" role="img" aria-label={props.ariaLabel} />;
}

export function Waterfall(props: {
  result: BridgeResult;
  priorLabel: string;
  currentLabel: string;
  /** Called with an effect key when its bar is clicked. A chart without it is not clickable. */
  onSelect?: (effectKey: string) => void;
  footer?: React.ReactNode;
  /** Extra controls shown beside the legend. */
  controls?: React.ReactNode;
  /** The chart's accessible name. The main bridge keeps the sentence it has always used. */
  ariaLabel?: string;
}) {
  const chartRef = useRef<echarts.ECharts>(null);
  const bars = steps(props.result, props.priorLabel, props.currentLabel);
  const caption = axisCaption(bars);

  return (
    <figure className="waterfall">
      <Legend
        controls={props.controls}
        actions={
          <button
            className="quiet"
            onClick={() =>
              saveOnce(
                `bridge-${props.priorLabel}-to-${props.currentLabel}.png`,
                () => {
                  const url = chartRef.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
                  return url ? Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)) : null;
                },
                "image/png",
              )
            }
          >
            Download PNG
          </button>
        }
      />
      <BridgeChart
        bars={bars}
        priorSales={props.result.priorSales}
        onSelect={props.onSelect}
        ariaLabel={props.ariaLabel ?? "Waterfall chart of the sales bridge. The same numbers are in the table beside it."}
        onReady={(chart) => {
          chartRef.current = chart;
        }}
      />
      {caption && <figcaption>{caption}</figcaption>}
      {props.footer}
    </figure>
  );
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
