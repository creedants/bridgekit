import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as echarts from "echarts/core";
import { bridgeBy, measureName, type BridgeBy, type BridgeConfig, type Query } from "../engine.ts";
import { compact, signedCompact, whole } from "./format.ts";
import {
  attemptSplit,
  createSplitRunner,
  drawGrid,
  focusPlace,
  IDLE_SPLIT_PHASE,
  paintSplit,
  panelTitle,
  pictureLayout,
  reduceSplitPhase,
  showSplit,
  shownSplit,
  PICTURE_CELL_HEIGHT,
  PICTURE_CELL_WIDTH,
  type DrawnGrid,
  type PanelBlock,
  type SplitEvent,
  type SplitPhase,
  type Step,
  type ValueScale,
} from "./small-bridges.ts";
import { BridgeChart, bridgeOption, chartTheme, labelPlan, Legend, Waterfall } from "./Waterfall.tsx";
import type { Run } from "./Results.tsx";

/** The limit `bridgeBy` uses by default: at most 12 value panels, then the remainder. */
const LIMIT = 12;

/**
 * The column the grid splits on. A new calculation remounts the whole results
 * view and throws away every tab's state, so the choice lives out here and is
 * read back on mount: recalculating the bridge rebuilds the grid for the same
 * column instead of clearing it. It is a variable in this page's lifetime only,
 * so a reload starts again with no split and nothing is written anywhere.
 */
let chosen = "";

/**
 * A bridge for every value of one column of the loaded file, drawn as small
 * bridges below the main one. The engine decides the panels, their order, the
 * shared ordering and what a value with nothing to bridge shows; this file only
 * draws what it is given and formats it.
 *
 * `fresh` is the page's own verdict on the run, so the grid needs no notice text
 * to tell that its bridge is out of date.
 */
export function SmallBridges(props: { run: Run; query: () => Promise<Query>; fresh: boolean }) {
  const { config, textColumns } = props.run;
  // A file loaded later can have other columns, so a choice that names a column
  // this file has not got is dropped rather than run against it.
  const [column, setColumn] = useState(() => (chosen && textColumns.includes(chosen) ? chosen : ""));
  const [phase, setPhase] = useState<SplitPhase>(IDLE_SPLIT_PHASE);
  /** The panel shown at full size, or null while the grid is on screen. */
  const [open, setOpen] = useState<number | null>(null);
  /** Latest phase, so the inputs effect can reduce without listing the phase. */
  const phaseRef = useRef<SplitPhase>(IDLE_SPLIT_PHASE);
  const wanted = useRef(column);
  const openRef = useRef<number | null>(null);
  const configRef = useRef(config);
  const queryRef = useRef(props.query);
  const freshRef = useRef(props.fresh);
  const resultRef = useRef(props.run.result);
  const selectRef = useRef<HTMLSelectElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocus = useRef<"back" | "select" | number | null>(null);
  configRef.current = config;
  queryRef.current = props.query;
  freshRef.current = props.fresh;
  resultRef.current = props.run.result;
  openRef.current = open;

  const applyPhase = useCallback((event: SplitEvent): SplitPhase => {
    const next = reduceSplitPhase(phaseRef.current, event);
    phaseRef.current = next;
    setPhase(next);
    // The only writer of the published grid: exports read it through shownSplit.
    showSplit(resultRef.current, next);
    return next;
  }, []);

  const runner = useRef<ReturnType<typeof createSplitRunner> | null>(null);
  if (runner.current === null) {
    runner.current = createSplitRunner(async (next) => {
      const outcome = await attemptSplit({
        request: next,
        displayed: () => wanted.current,
        stale: () => !freshRef.current,
        prepare: () => queryRef.current(),
        calculate: (query) => bridgeBy(query, configRef.current, next, LIMIT),
      });
      applyPhase({
        type: "settled",
        request: next,
        outcome,
        displayed: wanted.current,
        stale: !freshRef.current,
      });
    });
  }

  useEffect(() => {
    wanted.current = column;
    chosen = column;
    const next = applyPhase({ type: "inputs", column, stale: !props.fresh });
    const nextPaint = paintSplit({ phase: next, column, stale: !props.fresh });
    if (nextPaint.view !== "grid" && openRef.current !== null) {
      pendingFocus.current = "select";
      setOpen(null);
    }
    if (next.kind === "calculating") runner.current?.request(column);
  }, [column, props.fresh, props.run]);

  useEffect(() => {
    return () => {
      wanted.current = "";
    };
  }, []);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    pendingFocus.current = null;
    if (pending === "back") {
      backRef.current?.focus();
      return;
    }
    if (pending === "select") {
      selectRef.current?.focus();
      return;
    }
    const button = triggers.current.get(pending) ?? null;
    const place = focusPlace("close", button?.isConnected === true);
    if (place === "trigger") button?.focus();
    else selectRef.current?.focus();
  }, [open, phase]);

  const openPanel = useCallback((index: number) => {
    pendingFocus.current = focusPlace("open", true) === "back" ? "back" : "select";
    setOpen(index);
  }, []);
  const closePanel = useCallback(() => {
    pendingFocus.current = openRef.current ?? "select";
    setOpen(null);
  }, []);

  const painted = paintSplit({ phase, column, stale: !props.fresh });

  return (
    <section className="split">
      <div className="toolbar">
        <label>
          Split by
          <select ref={selectRef} value={column} onChange={(e) => setColumn(e.target.value)}>
            <option value="">None</option>
            {textColumns.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <span className="chip">Preview</span>
        <span className="hint">Preview: Split by is new and may still change.</span>
      </div>
      {painted.view === "calculating" ? (
        <p className="hint" role="status">Calculating…</p>
      ) : painted.view === "failed" ? (
        <p className="error" role="alert">{painted.sentence}</p>
      ) : painted.view === "grid" ? (
        open === null ? (
          <Grid by={painted.grid} config={config} onOpen={openPanel} triggers={triggers.current} />
        ) : (
          <Opened by={painted.grid} index={open} config={config} onBack={closePanel} backRef={backRef} />
        )
      ) : null}
    </section>
  );
}

function Grid(props: {
  by: BridgeBy;
  config: BridgeConfig;
  onOpen: (index: number) => void;
  triggers: Map<number, HTMLButtonElement>;
}) {
  const priorLabel = String(props.config.prior);
  const currentLabel = String(props.config.current);
  // The one derivation of the grid's blocks and shared axis.
  const grid = useMemo(() => drawGrid(props.by, priorLabel, currentLabel), [props.by, priorLabel, currentLabel]);
  return (
    <>
      <Legend />
      <div className="panels">
        {grid.blocks.map((block, index) =>
          block.kind === "bridge" ? (
            <Panel
              key={block.title}
              title={block.title}
              bars={block.bars}
              scale={grid.scale}
              index={index}
              config={props.config}
              onOpen={props.onOpen}
              triggers={props.triggers}
            />
          ) : (
            <FiguresPanel key={block.title} block={block} config={props.config} />
          ),
        )}
      </div>
      <p className="hint">{grid.between}</p>
    </>
  );
}

/**
 * One value's bridge, drawn small. The panel's own title is a button, so the
 * value is its name and both the pointer and the keyboard open it. A value with
 * no bridge of its own has no button and shows its figures instead.
 */
const Panel = memo(function Panel(props: {
  title: string;
  bars: Step[] | null;
  scale: ValueScale;
  index: number;
  config: BridgeConfig;
  onOpen: (index: number) => void;
  triggers: Map<number, HTMLButtonElement>;
}) {
  return (
    <div className="panel">
      {props.bars ? (
        <button
          className="panel-title"
          ref={(node) => {
            if (node) props.triggers.set(props.index, node);
            else props.triggers.delete(props.index);
          }}
          onClick={() => props.onOpen(props.index)}
        >
          {props.title}
        </button>
      ) : (
        <span className="panel-title">{props.title}</span>
      )}
      {props.bars ? (
        <BridgeChart bars={props.bars} priorSales={props.bars[0]?.high ?? 0} scale={props.scale} slim ariaLabel={`Bridge for ${props.title}`} />
      ) : null}
    </div>
  );
});

/** A value with no bridge of its own, showing its two figures instead of a chart. */
function FiguresPanel(props: {
  block: Extract<PanelBlock, { kind: "figures" }>;
  config: BridgeConfig;
}) {
  return (
    <div className="panel">
      <span className="panel-title">{props.block.title}</span>
      <div className="panel-figures">
        {props.block.status && <p className="panel-status">{props.block.status}</p>}
        <table>
          <tbody>
            <tr>
              <th>Prior {measureName(props.config).toLowerCase()}</th>
              <td className="num">{whole(props.block.prior)}</td>
            </tr>
            <tr>
              <th>Current {measureName(props.config).toLowerCase()}</th>
              <td className="num">{whole(props.block.current)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The grid's fixed column count on the composite picture. */
export const SPLIT_PICTURE_COLUMNS = 3;

function loadPictureImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("the grid chart could not be drawn"));
    image.src = url;
  });
}

/**
 * The ready grid drawn off screen at a fixed width, with titles, figures and
 * the between line, at pixel ratio 2. Null when no grid is ready for this run.
 */
export async function splitPicture(run: Run): Promise<HTMLCanvasElement | null> {
  const by = shownSplit(run.result);
  if (!by) return null;
  const priorLabel = String(run.config.prior);
  const currentLabel = String(run.config.current);
  const grid: DrawnGrid = drawGrid(by, priorLabel, currentLabel);
  const layout = pictureLayout(
    { width: SPLIT_PICTURE_COLUMNS * PICTURE_CELL_WIDTH, height: 0 },
    grid,
    SPLIT_PICTURE_COLUMNS,
  );
  const ratio = 2;
  const canvas = document.createElement("canvas");
  canvas.width = layout.width * ratio;
  canvas.height = layout.height * ratio;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(ratio, ratio);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, layout.width, layout.height);
  const theme = chartTheme();
  const font = (size: number, weight = "") => `${weight ? `${weight} ` : ""}${size}px ${theme.font}`;
  // One holder off screen for every chart drawn in turn.
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(holder);
  try {
    for (let index = 0; index < grid.blocks.length; index += 1) {
      const block = grid.blocks[index];
      const cell = layout.cells[index];
      context.fillStyle = theme.text;
      context.font = font(15, "600");
      context.fillText(block.title, cell.x + 12, cell.y + 20);
      if (block.kind === "bridge") {
        const chartWidth = cell.width - 24;
        const chartHeight = cell.height - 60;
        const box = document.createElement("div");
        box.style.width = `${chartWidth}px`;
        box.style.height = `${chartHeight}px`;
        holder.appendChild(box);
        const chart = echarts.init(box, null, { width: chartWidth, height: chartHeight });
        try {
          const labels = block.bars.map((bar) => bar.label);
          const values = block.bars.map((bar) =>
            bar.kind === "total" ? compact(bar.value) : signedCompact(bar.value),
          );
          chart.setOption(
            bridgeOption({
              bars: block.bars,
              plan: labelPlan(labels, values, chartWidth),
              scale: grid.scale,
              width: chartWidth,
              theme,
              priorSales: 1,
              touch: () => false,
              selectable: () => false,
            }),
          );
          const image = await loadPictureImage(
            chart.getDataURL({ type: "png", pixelRatio: ratio, backgroundColor: "#ffffff" }),
          );
          context.drawImage(image, cell.x + 12, cell.y + 30, chartWidth, chartHeight);
        } finally {
          chart.dispose();
          box.remove();
        }
      } else {
        let y = cell.y + 44;
        context.font = font(13);
        if (block.status) {
          context.fillText(block.status, cell.x + 12, y);
          y += 22;
        }
        const measure = measureName(run.config).toLowerCase();
        context.fillText(`Prior ${measure}: ${whole(block.prior)}`, cell.x + 12, y);
        context.fillText(`Current ${measure}: ${whole(block.current)}`, cell.x + 12, y + 22);
      }
    }
    context.fillStyle = theme.text2;
    context.font = font(13);
    const top = layout.cells.length > 0 ? layout.cells[0].y : 0;
    const gridBottom = top + Math.ceil(grid.blocks.length / SPLIT_PICTURE_COLUMNS) * PICTURE_CELL_HEIGHT;
    layout.between.forEach((line, i) => {
      context.fillText(line, 12, gridBottom + 30 + i * 24);
    });
  } finally {
    holder.remove();
  }
  return canvas;
}
/**
 * The chosen value's bridge at full size, on its own axis like the main bridge.
 * Nothing inside it drills down, so the chart is not clickable and its tooltip
 * offers no movers. The value is the button's name where the panel put its own
 * title, and the "Split by" control above clears the view the same way.
 */
function Opened(props: {
  by: BridgeBy;
  index: number;
  config: BridgeConfig;
  onBack: () => void;
  backRef: RefObject<HTMLButtonElement | null>;
}) {
  const panel = props.by.panels[props.index];
  if (!panel?.result) return null;
  const title = panelTitle(panel);
  return (
    <Waterfall
      result={panel.result}
      priorLabel={String(props.config.prior)}
      currentLabel={String(props.config.current)}
      ariaLabel={`Bridge for ${title}`}
      controls={
        <button ref={props.backRef} className="quiet" onClick={props.onBack}>
          {title}
        </button>
      }
    />
  );
}
