import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import type React from "react";
import type { BridgeResult } from "../engine.ts";
import { compact, signedCompact } from "./format.ts";

echarts.use([BarChart, GridComponent, TooltipComponent, LegacyGridContainLabel, CanvasRenderer]);

interface Step {
  /** Effect key, or null for the two period totals. */
  key: string | null;
  label: string;
  /** Bottom and top of the bar on the value axis. */
  low: number;
  high: number;
  value: number;
  kind: "total" | "up" | "down";
}

function steps(result: BridgeResult, priorLabel: string, currentLabel: string): Step[] {
  const out: Step[] = [
    { key: null, label: priorLabel, low: 0, high: result.priorSales, value: result.priorSales, kind: "total" },
  ];
  let running = result.priorSales;
  for (const effect of result.effects) {
    const next = running + effect.value;
    out.push({
      key: effect.key,
      label: effect.label,
      low: Math.min(running, next),
      high: Math.max(running, next),
      value: effect.value,
      kind: effect.value >= 0 ? "up" : "down",
    });
    running = next;
  }
  out.push({ key: null, label: currentLabel, low: 0, high: result.currentSales, value: result.currentSales, kind: "total" });
  return out;
}

/** Deltas are usually small next to the totals, so the axis starts above zero when it has to. */
function axisFloor(bars: Step[]): number {
  const levels = bars.flatMap((b) => (b.kind === "total" ? [b.high] : [b.low, b.high]));
  const low = Math.min(...levels);
  const range = Math.max(...levels) - low;
  if (range <= 0 || low - range * 0.6 <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(range));
  return Math.floor((low - range * 0.6) / step) * step;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function Waterfall(props: {
  result: BridgeResult;
  priorLabel: string;
  currentLabel: string;
  /** Called with an effect key when its bar is clicked. */
  onSelect: (effectKey: string) => void;
  footer?: React.ReactNode;
  /** Extra controls shown beside the legend. */
  controls?: React.ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts>(null);
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;
  const bars = steps(props.result, props.priorLabel, props.currentLabel);
  const floor = axisFloor(bars);

  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    chartRef.current = chart;
    const colors = { total: token("--total"), up: token("--up"), down: token("--down") };
    const ink = token("--text");

    chart.setOption({
      animation: false,
      textStyle: { fontFamily: token("--font") },
      grid: { left: 4, right: 8, top: 26, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: token("--bg"),
        borderColor: token("--line-strong"),
        textStyle: { color: ink, fontSize: 12 },
        formatter: (params: { dataIndex: number }[]) => {
          const bar = bars[params[0].dataIndex];
          const amount = bar.value.toLocaleString("en-US", { maximumFractionDigits: 0 });
          if (bar.kind === "total") return `<b>${bar.label}</b><br/>${amount}`;
          const share = ((bar.value / props.result.priorSales) * 100).toFixed(1);
          return `<b>${bar.label}</b><br/>${bar.value > 0 ? "+" : ""}${amount}<br/>${share}% of prior sales<br/><i>Click for movers</i>`;
        },
      },
      xAxis: {
        type: "category",
        data: bars.map((b) => b.label.replace(" (like-for-like)", "").replace("New configurations", "New\nconfigs").replace("Discontinued configurations", "Discont.\nconfigs").replace("Sales with no units", "No\nunits").replace(": ", ":\n")),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: token("--line-strong") } },
        axisLabel: { color: token("--text-2"), fontSize: 11, interval: 0, lineHeight: 14 },
      },
      yAxis: {
        type: "value",
        min: floor,
        axisLabel: { color: token("--text-3"), fontSize: 11, formatter: (v: number) => compact(v) },
        splitLine: { lineStyle: { color: token("--grid") } },
      },
      series: [
        {
          type: "bar",
          stack: "bridge",
          silent: true,
          itemStyle: { color: "transparent" },
          data: bars.map((b) => b.low),
        },
        {
          type: "bar",
          stack: "bridge",
          barMaxWidth: 52,
          cursor: "pointer",
          label: {
            show: true,
            position: "top",
            color: ink,
            fontSize: 11,
            formatter: (p: { dataIndex: number }) => {
              const bar = bars[p.dataIndex];
              return bar.kind === "total" ? compact(bar.value) : signedCompact(bar.value);
            },
          },
          data: bars.map((b) => ({
            value: b.high - b.low,
            itemStyle: { color: colors[b.kind], borderRadius: b.kind === "total" ? [2, 2, 0, 0] : 2 },
          })),
        },
      ],
    });

    chart.on("click", (event) => {
      const key = bars[event.dataIndex]?.key;
      if (key) onSelect.current(key);
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [props.result, props.priorLabel, props.currentLabel]);

  return (
    <figure className="waterfall">
      <div className="legend">
        <span><i style={{ background: "var(--up)" }} /> Increase</span>
        <span><i style={{ background: "var(--down)" }} /> Decrease</span>
        <span><i style={{ background: "var(--total)" }} /> Period total</span>
        <span style={{ marginLeft: "auto" }}>{props.controls}</span>
        <button
          className="quiet"
          onClick={() => {
            const url = chartRef.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
            if (!url) return;
            const link = document.createElement("a");
            link.href = url;
            link.download = `bridge-${props.priorLabel}-to-${props.currentLabel}.png`;
            link.click();
          }}
        >
          Download PNG
        </button>
      </div>
      <div
        ref={element}
        className="chart"
        role="img"
        aria-label="Waterfall chart of the sales bridge. The same numbers are in the table beside it."
      />
      {floor > 0 && <figcaption>Value axis starts at {compact(floor)}, not zero, so the steps are visible.</figcaption>}
      {props.footer}
    </figure>
  );
}
