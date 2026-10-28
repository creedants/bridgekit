import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { BridgeResult } from "../engine.ts";
import { makeGuard } from "./files.ts";
import { compact, signedCompact } from "./format.ts";
import { axisCaption, axisFloor, chartStack, steps, type Step, type ValueScale } from "./small-bridges.ts";

echarts.use([BarChart, GridComponent, TooltipComponent, LegacyGridContainLabel, CanvasRenderer]);

/** The three colour words, the caller's controls and any action of its own. */
export function Legend(props: { controls?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="legend">
      <span><i style={{ background: "var(--up)" }} /> Increase</span>
      <span><i style={{ background: "var(--down)" }} /> Decrease</span>
      <span><i style={{ background: "var(--total)" }} /> Period total</span>
      <span style={{ marginLeft: "auto" }}>{props.controls}</span>
      {props.actions}
    </div>
  );
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
    // On a narrow chart the category labels are angled and value labels that would collide are dropped.
    const narrow = element.current.clientWidth < 560;

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
          const share = ((bar.value / priorSales) * 100).toFixed(1);
          const hint = onSelect.current ? "<br/><i>Select for movers</i>" : "";
          return `<b>${bar.label}</b><br/>${bar.value > 0 ? "+" : ""}${amount}<br/>${share}% of prior sales${hint}`;
        },
      },
      xAxis: {
        type: "category",
        data: bars.map((b) => {
          const label = (narrow ? b.label.replace(": ", " ") : b.label).replace(" (like-for-like)", "");
          const wrapped = narrow
            ? label.replace("New configurations", "New\nconfigs").replace("Discontinued configurations", "Discont.\nconfigs")
            : label.replace("New configurations", "New\nconfigurations").replace("Discontinued configurations", "Discontinued\nconfigurations");
          return wrapped.replace("Sales with no units", "No\nunits").replace(": ", ":\n");
        }),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: token("--line-strong") } },
        axisLabel: slim
          ? { show: false }
          : { color: token("--text-2"), fontSize: narrow ? 10 : 11, interval: 0, lineHeight: 14, rotate: narrow ? 50 : 0 },
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
          labelLayout: { hideOverlap: true },
          cursor: onSelect.current ? "pointer" : "default",
          label: {
            show: true,
            position: "top",
            color: ink,
            fontSize: slim ? 9 : 11,
            formatter: (p: { dataIndex: number }) => {
              const bar = bars[p.dataIndex];
              return bar.kind === "total" ? compact(bar.value) : signedCompact(bar.value);
            },
          },
          data: bars.map((bar, index) => ({
            value: stack.extents[index],
            itemStyle: { color: colors[bar.kind], borderRadius: bar.kind === "total" ? [2, 2, 0, 0] : 2 },
          })),
        },
      ],
    });

    if (onSelect.current) {
      chart.on("click", (event) => {
        const key = bars[event.dataIndex]?.key;
        if (key) onSelect.current?.(key);
      });
    }

    // A tooltip opened by touch has no mouse leaving to close it.
    const box = element.current;
    const hideTip = () => chart.dispatchAction({ type: "hideTip" });
    const tapElsewhere = (event: TouchEvent) => {
      if (!box.contains(event.target as Node)) hideTip();
    };
    box.addEventListener("touchend", hideTip);
    document.addEventListener("touchstart", tapElsewhere, { passive: true });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      box.removeEventListener("touchend", hideTip);
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
  const [pngGuard] = useState(() => makeGuard());
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
              pngGuard.run(() => {
                const url = chartRef.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
                if (!url) return false;
                const link = document.createElement("a");
                link.href = url;
                link.download = `bridge-${props.priorLabel}-to-${props.currentLabel}.png`;
                link.click();
              })
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
