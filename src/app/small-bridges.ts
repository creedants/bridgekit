import type { BridgeBy, BridgePanel, BridgeResult, PanelStatus } from "../engine.ts";
import { signedWhole } from "./format.ts";

/**
 * Every rule behind a bridge's bars and behind the small-bridge grid, in one
 * place and free of React, of the document and of the database, so the tests
 * can check them without a browser. `Waterfall.tsx` only draws: it takes the
 * steps this file decides and puts them on a canvas.
 */

/** A panel whose column value is empty or null. The page already writes "(blank)". */
export const BLANK_TITLE = "(blank)";

/** The panel that pools the values the single panels leave out. */
export const COMBINED_TITLE = "All other values";

/**
 * One value axis every panel is drawn on, so a bar's height means the same
 * thing on any panel. `max` is the highest level any panel's bars touch.
 */
export interface ValueScale {
  min: number;
  max: number;
}

export interface Step {
  /** Effect key, or null for the two period totals. */
  key: string | null;
  label: string;
  /** Bottom and top of the bar on the value axis. */
  low: number;
  high: number;
  value: number;
  kind: "total" | "up" | "down";
}

export function steps(result: BridgeResult, priorLabel: string, currentLabel: string): Step[] {
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
export function axisFloor(bars: Step[]): number {
  const levels = bars.flatMap((b) => (b.kind === "total" ? [b.high] : [b.low, b.high]));
  const low = Math.min(...levels);
  const range = Math.max(...levels) - low;
  if (range <= 0 || low - range * 0.6 <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(range));
  return Math.floor((low - range * 0.6) / step) * step;
}

/** Both ends of every bar, in the order the floor rule reads them. */
function barLevels(bars: Step[]): number[] {
  return bars.flatMap((bar) => (bar.kind === "total" ? [bar.high] : [bar.low, bar.high]));
}

/**
 * The value axis every panel is drawn on, decided from all the panels' bars
 * together. The ceiling is the highest level any panel reaches. The floor is
 * the one chart's own floor rule applied to all the bars at once, so the small
 * steps of a grid of small bridges stay visible, and it never rises above the
 * lowest bar, so no step is drawn cut in half.
 */
export function sharedScale(barsList: Step[][]): ValueScale {
  const levels = barsList.flatMap(barLevels);
  if (levels.length === 0) return { min: 0, max: 1 };
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  if (high - low <= 0) return { min: 0, max: high > 0 ? high : 1 };
  return { min: Math.min(axisFloor(barsList.flat()), low), max: high };
}

/**
 * A panel's title: the value itself, "(blank)" when the column value is empty
 * or null, and "All other values" for the combined panel.
 */
export function panelTitle(panel: BridgePanel): string {
  if (panel.combined) return COMBINED_TITLE;
  return panel.value === null || panel.value === "" ? BLANK_TITLE : panel.value;
}

/**
 * The page's own word for a value with no bridge of its own, or null when the
 * value bridges and needs no word. "New" and "Lost" are the words the Accounts
 * tab already uses for a value that appears in one period only, and "Sales with
 * no units" is the engine's own name for the line those rows are bridged on.
 */
const STATUS_WORDS: Record<PanelStatus, string | null> = {
  continuing: null,
  new: "New",
  lost: "Lost",
  no_units: "Sales with no units",
};

export function panelStatusLabel(status: PanelStatus): string | null {
  return STATUS_WORDS[status];
}

/** The sentence above the figures, which is the one the ticket dictates. */
export const BETWEEN_SENTENCE =
  "Each small bridge stands on its own. Together they add up to the total change; the price, volume and mix bars differ from the main bridge by the mix between values:";

/**
 * The whole line under the grid: the sentence and one signed figure per effect,
 * each with the label the bridge table already gives it, so a reader can tell
 * which figure is which effect.
 */
export function betweenLine(by: BridgeBy): string {
  const figures = by.between.map((effect) => `${effect.label} ${signedWhole(effect.value)}`).join(", ");
  return `${BETWEEN_SENTENCE} ${figures}`.trim();
}
