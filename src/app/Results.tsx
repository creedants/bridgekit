import { useId, useRef, useState } from "react";
import {
  measureName,
  type BridgeConfig,
  type BridgeResult,
  type DataCheck,
  type Query,
  type TieOut,
} from "../engine.ts";
import { roundBridge, shownTotal } from "../summary.ts";
import { percent, shareOfPrior, signedPercent, signedWhole, whole } from "./format.ts";
import { terms } from "./report.ts";
import type { Setup } from "./setup.ts";
import { Accounts } from "./results/Accounts.tsx";
import { Check, checkWarnings, useWholeRowWarning } from "./results/Check.tsx";
import { Movers } from "./results/Movers.tsx";
import { PriceChanges } from "./results/PriceChanges.tsx";
import { PriceGaps } from "./results/PriceGaps.tsx";
import { Kpi, matchLabel } from "./results/shared.tsx";
import { SetupCheck } from "./results/SetupCheck.tsx";
import { Summary } from "./results/Summary.tsx";
import { Trend } from "./results/Trend.tsx";
import { Unmatched } from "./results/Unmatched.tsx";
import { SmallBridges, splitPicture } from "./SmallBridges.tsx";
import { Waterfall } from "./Waterfall.tsx";

export interface Run {
  /** Text columns of the loaded file, for views that group by any column. */
  textColumns: string[];
  /** Every period in the loaded window, oldest first, for the trend view. */
  periods: string[];
  /** Human-readable lines describing the setup, for exports. */
  description: string[];
  /** Structured setup and file name, so the ticked report rebuilds Setup without copying values. */
  setup: Setup;
  source: string;
  /** Whether the data is one of the built-in samples, not the visitor's file. */
  sample: boolean;
  /** Data-row Excel formulas with no saved result, read as blank. Zero for a CSV, a paste, or a sample. */
  formulaBlanks: number;
  /** The engine's sentence when the amounts are too large to add up exactly, read when the bridge was calculated. */
  amounts: string | null;
  config: BridgeConfig;
  result: BridgeResult;
  check: DataCheck;
  /** Money on the file and after the filters, in whole dollars, for the tie-out on the Data check tab. */
  tieOut: TieOut;
  ms: number;
}

type Tab = "bridge" | "movers" | "accounts" | "price" | "gaps" | "trend" | "unmatched" | "setup" | "check";

/** WAI-ARIA tabs with automatic activation: the index a key moves to, or null for a key the strip ignores. */
export function tabAfterKey(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight") return (at + 1) % count;
  if (key === "ArrowLeft") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * The report's names choice. App owns it so it survives the keyed Results remount.
 * Optional so a direct render of Results without the choice still compiles; a missing
 * choice reads unticked and ignores ticks.
 */
export interface NamesChoice {
  omitNames?: boolean;
  onOmitNames?: (next: boolean) => void;
}

/**
 * Whether App still finds the run current. Results is keyed by run.id and never sees the
 * current setup, so App decides; a missing value reads stale, which keeps a report from
 * being saved for a run nobody has checked.
 */
export interface Freshness {
  fresh?: boolean;
  /**
   * Whether the period views in the database belong to this setup, so a live read
   * is this run's input. A missing value reads as belonging.
   */
  viewsCurrent?: boolean;
}

export function Results(props: { run: Run; query: () => Promise<Query> } & NamesChoice & Freshness) {
  const { run } = props;
  const { config } = run;
  const t = terms(config);
  // A bridge line that only exists for some data is left out when it is exactly zero.
  const result = {
    ...run.result,
    effects: run.result.effects.filter((e) => e.key !== "no_units" || e.value !== 0),
  };
  const shown = roundBridge(result.priorSales, result.currentSales, result.effects.map((e) => e.value));
  // The tabs that re-query the mutable view read it only while the run and its
  // views are current; a temp table fixed at calculation time needs no such guard.
  const viewQuery = props.fresh === false || props.viewsCurrent === false ? null : props.query;
  const [tab, setTab] = useState<Tab>("bridge");
  const [sortBy, setSortBy] = useState("change");
  const ids = useId();
  const panelId = `${ids}panel`;
  const tabId = (entry: Tab) => `${ids}tab-${entry}`;
  const tabEls = useRef<(HTMLButtonElement | null)[]>([]);
  const mixCount = run.result.effects.filter((e) => e.key.startsWith("mix_")).length;
  // With many attributes the chart gets crowded, so mix starts combined.
  const [combineMix, setCombineMix] = useState(mixCount > 4);

  const change = result.currentSales - result.priorSales;
  const priceEffect = result.effects.filter((e) => e.key.startsWith("price")).reduce((sum, e) => sum + e.value, 0);
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const fileWarnings = useWholeRowWarning(run, props.query);
  const warnings = checkWarnings(run, fileWarnings);

  const tabs: { id: Tab; label: string }[] = [
    { id: "bridge", label: "Bridge" },
    { id: "movers", label: "Movers" },
    { id: "accounts", label: "Accounts" },
    { id: "price", label: "Price changes" },
    { id: "gaps", label: "Price gaps" },
    { id: "trend", label: "Trend" },
    { id: "unmatched", label: "Unmatched" },
    { id: "setup", label: "Setup check" },
    { id: "check", label: warnings.length ? `Data check (${warnings.length})` : "Data check" },
  ];

  return (
    <>
      <h1 className="results-title" tabIndex={-1}>Price-volume-mix bridge</h1>
      <div className="kpis">
        <Kpi label={`${measureName(config)} ${config.prior}`} value={whole(shown.prior)} />
        <Kpi label={`${measureName(config)} ${config.current}`} value={whole(shown.current)} />
        <Kpi label="Change" value={signedWhole(shown.current - shown.prior)} note={signedPercent(shareOfPrior(change, result.priorSales))} />
        <Kpi label="Like-for-like price" value={signedWhole(shownTotal(shown, result.effects, "price"))} note={signedPercent(shareOfPrior(priceEffect, result.priorSales))} />
        <Kpi label="Matched exactly" value={percent(exact)} note={t.exactNote} />
      </div>
      <p className="hint">
        Like-for-like price: The price change on configurations sold in both periods. Configuration: One combination of
        attribute values, such as A-100, Large, Red.
      </p>

      <div className="tabs" role="tablist">
        {tabs.map((entry, i) => (
          <button
            key={entry.id}
            ref={(el) => {
              tabEls.current[i] = el;
            }}
            role="tab"
            id={tabId(entry.id)}
            aria-selected={tab === entry.id}
            aria-controls={panelId}
            // The roving tabindex follows the selection, so the strip needs no second focus state.
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => setTab(entry.id)}
            onKeyDown={(e) => {
              const next = tabAfterKey(e.key, i, tabs.length);
              if (next === null) return;
              // Home, End and the arrows would move the page or the strip without this.
              e.preventDefault();
              setTab(tabs[next].id);
              tabEls.current[next]?.focus();
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
        {tab === "bridge" && (
          <>
            <div className="bridge">
              <Waterfall
                result={combineMix ? withCombinedMix(result) : result}
                controls={
                  mixCount > 1 && (
                    <>
                      <label className="check">
                        <input type="checkbox" checked={combineMix} onChange={(e) => setCombineMix(e.target.checked)} />
                        Combine mix
                      </label>{" "}
                      <span className="hint">Shows the mix steps of all attributes as one Mix bar.</span>
                    </>
                  )
                }
                priorLabel={String(config.prior)}
                currentLabel={String(config.current)}
                below={() => splitPicture(run)}
                footer={<Summary run={run} result={result} shown={shown} query={props.query} fresh={props.fresh !== false && props.viewsCurrent !== false} omitNames={props.omitNames} onOmitNames={props.onOmitNames} />}
                onSelect={(key) => {
                  setSortBy(key.startsWith("mix_") ? "mix" : key.startsWith("price") || key === "cost_rate" ? "price" : key);
                  setTab("movers");
                }}
              />
              <div>
                <table>
                  <thead>
                    <tr><th>Bridge</th><th className="num">Amount</th><th className="num">% of prior</th></tr>
                  </thead>
                  <tbody>
                    <tr className="total"><td>{measureName(config)} {config.prior}</td><td className="num">{whole(shown.prior)}</td><td /></tr>
                    {result.effects.map((e, i) => (
                      <tr key={e.key}>
                        <td>{e.label}</td>
                        <td className="num">{signedWhole(shown.values[i])}</td>
                        <td className="num">{signedPercent(shareOfPrior(e.value, result.priorSales))}</td>
                      </tr>
                    ))}
                    <tr className="total"><td>{measureName(config)} {config.current}</td><td className="num">{whole(shown.current)}</td><td /></tr>
                  </tbody>
                </table>
                {run.amounts && <p className="notice">{run.amounts}</p>}
                {signNote(result.effects, config.newAndDiscontinued) && (
                  <p className="hint">{signNote(result.effects, config.newAndDiscontinued)}</p>
                )}
                <h3>{t.matchedHeading}</h3>
                <table>
                  <thead>
                    <tr><th>Compared against</th><th className="num">Share</th><th className="num">Configurations</th></tr>
                  </thead>
                  <tbody>
                    {result.coverage.map((c) => (
                      <tr key={c.level}>
                        <td>{matchLabel(config, c.level)}</td>
                        <td className="num">{percent(c.share)}</td>
                        <td className="num">{whole(c.cells)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hint">
                  Only exact matches count as price. The rest is in “New configurations”; see the Unmatched tab. {t.sharesNote}
                </p>
                <p className="hint">
                  New configurations sold in the current period but not the prior one. Discontinued configurations sold in
                  the prior period but not the current one.
                </p>
              </div>
            </div>
            <SmallBridges run={run} query={props.query} fresh={props.fresh !== false && props.viewsCurrent !== false} />
          </>
        )}
        {tab === "accounts" && <Accounts run={run} query={viewQuery} />}
        {tab === "gaps" && <PriceGaps run={run} query={props.query} />}
        {tab === "trend" && <Trend run={run} query={viewQuery} />}
        {tab === "setup" && <SetupCheck run={run} query={viewQuery} />}
        {tab === "price" && <PriceChanges run={run} query={props.query} />}
        {tab === "movers" && <Movers run={run} query={props.query} sortBy={sortBy} onSortBy={setSortBy} />}
        {tab === "unmatched" && <Unmatched run={run} query={props.query} />}
        {tab === "check" && <Check run={run} warnings={warnings} query={props.query} />}
      </div>
    </>
  );
}

/** The same bridge with the per-attribute mix lines added into one. */
function withCombinedMix(result: Run["result"]): Run["result"] {
  const mixes = result.effects.filter((e) => e.key.startsWith("mix_"));
  if (mixes.length < 2) return result;
  const combined = { key: "mix_all", label: "Mix", value: mixes.reduce((sum, e) => sum + e.value, 0) };
  const first = result.effects.indexOf(mixes[0]);
  return {
    ...result,
    effects: [...result.effects.slice(0, first), combined, ...result.effects.slice(first).filter((e) => !e.key.startsWith("mix_"))],
  };
}

/**
 * A step whose sign a reader would not expect: discontinued configurations that add sales, or new ones that take
 * sales away. Both come from the difference against the nearest comparable group, so at full sales there is no note.
 */
export function signNote(
  effects: readonly { key: string; value: number }[],
  newAndDiscontinued: BridgeConfig["newAndDiscontinued"],
): string | null {
  if (newAndDiscontinued === "full") return null;
  const sentences: string[] = [];
  if (effects.some((e) => e.key === "discontinued" && e.value > 0)) {
    sentences.push("Discontinued configurations is an increase here. The line is not the sales that were lost.");
  }
  if (effects.some((e) => e.key === "new_config" && e.value < 0)) {
    sentences.push("New configurations is a decrease here. The line is not the new sales.");
  }
  if (sentences.length === 0) return null;
  return `${sentences.join(" ")} It is the difference from the nearest comparable group, which can go either way.`;
}
