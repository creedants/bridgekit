import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";
import type { BridgeResult } from "../engine.ts";
import { compact, signedCompact } from "./format.ts";

echarts.use([BarChart, GridComponent, TooltipComponent, LegacyGridContainLabel, CanvasRenderer]);

interface Step {
  label: string;
  /** Bottom and top of the bar on the value axis. */
  low: number;
  high: number;
  value: number;
  kind: "total" | "up" | "down";
}

function steps(result: BridgeResult, priorLabel: string, currentLabel: string): Step[] {
  const out: Step[] = [
    { label: priorLabel, low: 0, high: result.priorSales, value: result.priorSales, kind: "total" },
  ];
  let running = result.priorSales;
  for (const effect of result.effects) {
    const next = running + effect.value;
    out.push({
      label: effect.label,
      low: Math.min(running, next),
      high: Math.max(running, next),
      value: effect.value,
      kind: effect.value >= 0 ? "up" : "down",
    });
    running = next;
  }
  out.push({ label: currentLabel, low: 0, high: result.currentSales, value: result.currentSales, kind: "total" });
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

export function Waterfall(props: { result: BridgeResult; priorLabel: string; currentLabel: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const bars = steps(props.result, props.priorLabel, props.currentLabel);
  const floor = axisFloor(bars);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    const colors = { total: token("--total"), up: token("--up"), down: token("--down") };
    const ink = token("--text-primary");
    const muted = token("--text-muted");

    chart.setOption({
      animation: false,
      grid: { left: 8, right: 8, top: 28, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: token("--surface-1"),
        borderColor: token("--grid"),
        textStyle: { color: ink },
        formatter: (params: { dataIndex: number }[]) => {
          const bar = bars[params[0].dataIndex];
          const amount = bar.value.toLocaleString("en-US", { maximumFractionDigits: 0 });
          if (bar.kind === "total") return `<b>${bar.label}</b><br/>${amount}`;
          const share = ((bar.value / props.result.priorSales) * 100).toFixed(1);
          return `<b>${bar.label}</b><br/>${bar.value >= 0 ? "+" : ""}${amount}<br/>${share}% of prior sales`;
        },
      },
      xAxis: {
        type: "category",
        data: bars.map((b) => b.label),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: token("--axis") } },
        axisLabel: { color: token("--text-secondary"), interval: 0, width: 84, overflow: "break" },
      },
      yAxis: {
        type: "value",
        min: floor,
        axisLabel: { color: muted, formatter: (v: number) => compact(v) },
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
          barMaxWidth: 56,
          label: {
            show: true,
            position: "top",
            color: ink,
            formatter: (p: { dataIndex: number }) => {
              const bar = bars[p.dataIndex];
              return bar.kind === "total" ? compact(bar.value) : signedCompact(bar.value);
            },
          },
          data: bars.map((b) => ({
            value: b.high - b.low,
            itemStyle: { color: colors[b.kind], borderRadius: b.kind === "total" ? [4, 4, 0, 0] : 3 },
          })),
        },
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [props.result, props.priorLabel, props.currentLabel, dark]);

  return (
    <figure className="waterfall">
      <div className="legend">
        <span><i style={{ background: "var(--up)" }} /> Increase</span>
        <span><i style={{ background: "var(--down)" }} /> Decrease</span>
        <span><i style={{ background: "var(--total)" }} /> Period total</span>
      </div>
      <div ref={element} className="chart" role="img" aria-label="Waterfall chart of the sales bridge; the same numbers are in the table below" />
      {floor > 0 && <figcaption>Value axis starts at {compact(floor)}, not zero, so the steps are visible.</figcaption>}
    </figure>
  );
}
