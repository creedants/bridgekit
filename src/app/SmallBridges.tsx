import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { bridgeBy, measureName, type BridgeBy, type BridgeConfig, type BridgePanel, type Query } from "../engine.ts";
import { openBrowserDatabase } from "./db.ts";
import { whole } from "./format.ts";
import {
  attemptSplit,
  betweenLine,
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
  statementStartsTurn,
  steps,
  type ScreenBridge,
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

// One queue for the page's one connection. bridgeBy replaces bridge_cells, so
// a second engine call has to wait until the first has finished every statement.
// A file load, a paste, and a sample's table replacement take a turn that does
// not join the running call. The row generation records that the rows changed.
const pageQueue = createConnectionQueue();
const installs = createAttemptCache();
let shownRun: object | null = null;
let calculationOnScreen = 0;

function noteRun(run: object): void {
  if (shownRun === run) return;
  shownRun = run;
  calculationOnScreen += 1;
}

function installPageQueue(): Promise<void> {
  return installs.run(async () => {
    const database = await openBrowserDatabase();
    if (Reflect.get(database.query, "pageQueue") === true) return;
    const inner = database.query;
    const loadFile = database.loadFile.bind(database);
    const wrapped: Query = (sql) =>
      statementStartsTurn(sql) ? pageQueue.turn(() => inner(sql)) : pageQueue.schedule(() => inner(sql));
    Reflect.set(wrapped, "pageQueue", true);
    database.query = wrapped;
    database.loadFile = (file, table) => pageQueue.turn(() => loadFile(file, table));
  });
}

void installPageQueue().catch((error: unknown) => {
  console.error(error);
});

function noticeTexts(): string[] {
  const root = document.querySelector("main") ?? document.body;
  return [...root.querySelectorAll("p.notice")].map((node) => node.textContent ?? "");
}

function bridgeIsStale(): boolean {
  return noticesAreStale(noticeTexts());
}

/**
 * A bridge for every value of one column of the loaded file, drawn as small
 * bridges below the main one. The engine decides the panels, their order, the
 * shared ordering and what a value with nothing to bridge shows; this file only
 * draws what it is given and formats it.
 */
export function SmallBridges(props: { run: Run; query: () => Promise<Query> }) {
  noteRun(props.run);
  const { config, textColumns } = props.run;
  // A file loaded later can have other columns, so a choice that names a column
  // this file has not got is dropped rather than run against it.
  const [column, setColumn] = useState(() => (chosen && textColumns.includes(chosen) ? chosen : ""));
  const [grid, setGrid] = useState<BridgeBy | null>(null);
  const [failure, setFailure] = useState("");
  /** The panel shown at full size, or null while the grid is on screen. */
  const [open, setOpen] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [rowsEpoch, setRowsEpoch] = useState(0);
  const shownFor = useRef("");
  const wanted = useRef(column);
  const openRef = useRef<number | null>(null);
  const configRef = useRef(config);
  const queryRef = useRef(props.query);
  const selectRef = useRef<HTMLSelectElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocus = useRef<"back" | "select" | number | null>(null);
  configRef.current = config;
  queryRef.current = props.query;
  openRef.current = open;
  const screenRef = useRef<() => ScreenBridge>(() => ({
    column: wanted.current,
    calculation: calculationOnScreen,
    rows: pageQueue.generation(),
  }));
  screenRef.current = () => ({
    column: wanted.current,
    calculation: calculationOnScreen,
    rows: pageQueue.generation(),
  });

  const runner = useRef<ReturnType<typeof createSplitRunner> | null>(null);
  if (runner.current === null) {
    runner.current = createSplitRunner(async (next) => {
      const started = { ...screenRef.current(), column: next };
      const outcome = await attemptSplit({
        started,
        screen: () => screenRef.current(),
        stale: bridgeIsStale,
        install: installPageQueue,
        prepare: () => queryRef.current(),
        calculate: (query) => bridgeBy(query, configRef.current, next, LIMIT),
      });
      if (outcome.status === "drop") return;
      if (outcome.status === "fail") {
        shownFor.current = "";
        setGrid(null);
        setFailure(SPLIT_FAILURE_SENTENCE);
        return;
      }
      shownFor.current = next;
      setFailure("");
      setGrid(outcome.result);
    });
  }

  useEffect(() => pageQueue.whenTurnRejected(() => setRowsEpoch((n) => n + 1)), []);

  useEffect(() => {
    const root = document.querySelector("main") ?? document.body;
    const read = () => {
      const next = bridgeIsStale();
      setStale((prev) => (prev === next ? prev : next));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    wanted.current = column;
    chosen = column;
    const action = gridAction(column, stale || bridgeIsStale(), shownFor.current);
    if (action === "keep") return;
    setFailure("");
    setGrid(null);
    shownFor.current = "";
    if (openRef.current !== null) {
      pendingFocus.current = "select";
      setOpen(null);
    }
    if (action === "clear") return;
    runner.current?.request(column);
  }, [column, stale, props.run, rowsEpoch]);

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
  }, [open, grid]);

  const openPanel = useCallback((index: number) => {
    pendingFocus.current = focusPlace("open", true) === "back" ? "back" : "select";
    setOpen(index);
  }, []);
  const closePanel = useCallback(() => {
    pendingFocus.current = openRef.current ?? "select";
    setOpen(null);
  }, []);

  // Drop a grid that is not the one on screen before paint. The effect below
  // starts the replacement, and it runs too late to stop this frame.
  const liveStale = stale || bridgeIsStale();
  const action = gridAction(column, liveStale, shownFor.current);
  const drop = action !== "keep" && shownFor.current !== column;
  if (drop && (grid !== null || open !== null || failure !== "")) {
    shownFor.current = "";
    if (open !== null) pendingFocus.current = "select";
    if (grid !== null) setGrid(null);
    if (failure !== "") setFailure("");
    if (open !== null) setOpen(null);
  }

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
      </div>
      {!column ? null : grid === null ? (
        failure ? (
          <p className="error" role="alert">{failure}</p>
        ) : stale || bridgeIsStale() ? null : (
          <p className="hint" role="status">Calculating…</p>
        )
      ) : open === null ? (
        <Grid by={grid} config={config} onOpen={openPanel} triggers={triggers.current} />
      ) : (
        <Opened by={grid} index={open} config={config} onBack={closePanel} backRef={backRef} />
      )}
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
