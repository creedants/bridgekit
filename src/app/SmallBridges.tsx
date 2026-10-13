import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { bridgeBy, measureName, type BridgeBy, type BridgeConfig, type BridgePanel, type Query } from "../engine.ts";
import { whole } from "./format.ts";
import {
  betweenLine,
  panelStatusLabel,
  panelTitle,
  sharedScale,
  steps,
  type Step,
  type ValueScale,
} from "./small-bridges.ts";
import { BridgeChart, Legend, Waterfall } from "./Waterfall.tsx";
import type { Run } from "./Results.tsx";

/** The one sentence shown when the split cannot be calculated. */
const FAILURE = "The small bridges could not be calculated.";

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
 */
export function SmallBridges(props: { run: Run; query: () => Promise<Query> }) {
  const { config, textColumns } = props.run;
  // A file loaded later can have other columns, so a choice that names a column
  // this file has not got is dropped rather than run against it.
  const [column, setColumn] = useState(() => (chosen && textColumns.includes(chosen) ? chosen : ""));
  const [grid, setGrid] = useState<BridgeBy | null>(null);
  const [failure, setFailure] = useState("");
  /** The panel shown at full size, or null while the grid is on screen. */
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (!column) {
      chosen = "";
      setGrid(null);
      setFailure("");
      setOpen(null);
      return;
    }
    chosen = column;
    // A selection that has moved on drops the older answer, as every other tab
    // that runs its own engine work does. One connection serves the whole page,
    // so the late answer must never overwrite the newer one. The answer on
    // screen belongs to this column alone, so it goes until the new one lands.
    let stale = false;
    setFailure("");
    setGrid(null);
    setOpen(null);
    props
      .query()
      .then((query) => bridgeBy(query, config, column, LIMIT))
      .then((result) => {
        if (stale) return;
        setGrid(result);
      })
      .catch((error: unknown) => {
        console.error(error);
        if (stale) return;
        setFailure(FAILURE);
      });
    return () => {
      stale = true;
    };
  }, [props.run, column]);

  const openPanel = useCallback((index: number) => setOpen(index), []);
  const closePanel = useCallback(() => setOpen(null), []);

  return (
    <section className="split">
      <div className="toolbar">
        <label>
          Split by
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
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
        ) : (
          <p className="hint" role="status">Calculating…</p>
        )
      ) : open === null ? (
        <Grid by={grid} config={config} onOpen={openPanel} />
      ) : (
        <Opened by={grid} index={open} config={config} onBack={closePanel} />
      )}
    </section>
  );
}

function Grid(props: { by: BridgeBy; config: BridgeConfig; onOpen: (index: number) => void }) {
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
}) {
  const title = panelTitle(props.panel);
  const status = panelStatusLabel(props.panel.status);
  return (
    <div className="panel">
      {props.bars ? (
        <button className="panel-title" onClick={() => props.onOpen(props.index)}>{title}</button>
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
function Opened(props: { by: BridgeBy; index: number; config: BridgeConfig; onBack: () => void }) {
  const panel = props.by.panels[props.index];
  if (!panel?.result) return null;
  return (
    <Waterfall
      result={panel.result}
      priorLabel={String(props.config.prior)}
      currentLabel={String(props.config.current)}
      controls={
        <button className="quiet" onClick={props.onBack}>
          {panelTitle(panel)}
        </button>
      }
    />
  );
}
