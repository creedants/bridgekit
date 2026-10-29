import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { bridgeBy, measureName, type BridgeBy, type BridgeConfig, type BridgePanel, type Query } from "../engine.ts";
import { whole } from "./format.ts";
import {
  attemptSplit,
  betweenLine,
  createSplitRunner,
  focusPlace,
  IDLE_SPLIT_PHASE,
  paintSplit,
  panelStatusLabel,
  panelTitle,
  reduceSplitPhase,
  sharedScale,
  steps,
  type SplitEvent,
  type SplitPhase,
  type Step,
  type ValueScale,
} from "./small-bridges.ts";
import { BridgeChart, Legend, Waterfall } from "./Waterfall.tsx";
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
  const selectRef = useRef<HTMLSelectElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocus = useRef<"back" | "select" | number | null>(null);
  configRef.current = config;
  queryRef.current = props.query;
  freshRef.current = props.fresh;
  openRef.current = open;

  const applyPhase = useCallback((event: SplitEvent): SplitPhase => {
    const next = reduceSplitPhase(phaseRef.current, event);
    phaseRef.current = next;
    setPhase(next);
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
    if (next.kind !== "ready" && openRef.current !== null) {
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
  // One pass builds every panel's bars and the one axis they all stand on.
  const drawn = useMemo(
    () => props.by.panels.map((panel) => ({ panel, bars: panel.result ? steps(panel.result, priorLabel, currentLabel) : null })),
    [props.by, priorLabel, currentLabel],
  );
  const scale = useMemo(() => sharedScale(drawn.flatMap((d) => (d.bars ? [d.bars] : []))), [drawn]);
  return (
    <>
      <Legend />
      <div className="panels">
        {drawn.map((d, index) => (
          <Panel
            key={panelTitle(d.panel)}
            panel={d.panel}
            bars={d.bars}
            scale={scale}
            index={index}
            config={props.config}
            onOpen={props.onOpen}
            triggers={props.triggers}
          />
        ))}
      </div>
      <p className="hint">{betweenLine(props.by)}</p>
    </>
  );
}

/**
 * One value's bridge, drawn small. The panel's own title is a button, so the
 * value is its name and both the pointer and the keyboard open it. A value with
 * no bridge of its own has no button and shows its figures instead.
 */
const Panel = memo(function Panel(props: {
  panel: BridgePanel;
  bars: Step[] | null;
  scale: ValueScale;
  index: number;
  config: BridgeConfig;
  onOpen: (index: number) => void;
  triggers: Map<number, HTMLButtonElement>;
}) {
  const title = panelTitle(props.panel);
  const status = panelStatusLabel(props.panel.status);
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
          {title}
        </button>
      ) : (
        <span className="panel-title">{title}</span>
      )}
      {props.bars ? (
        <BridgeChart bars={props.bars} priorSales={props.panel.priorSales} scale={props.scale} slim ariaLabel={`Bridge for ${title}`} />
      ) : (
        <div className="panel-figures">
          {status && <p className="panel-status">{status}</p>}
          <table>
            <tbody>
              <tr>
                <th>Prior {measureName(props.config).toLowerCase()}</th>
                <td className="num">{whole(props.panel.priorSales)}</td>
              </tr>
              <tr>
                <th>Current {measureName(props.config).toLowerCase()}</th>
                <td className="num">{whole(props.panel.currentSales)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});

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
