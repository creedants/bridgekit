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

/**
 * The two stack segments that draw one bar from `low` to `high`.
 * `strategy` is `all` because a chart's default stack keeps a negative base
 * apart from a positive height, and the bar would then start at zero.
 */
export interface ChartStack {
  strategy: "all";
  bases: number[];
  extents: number[];
}

export function chartStack(bars: Step[]): ChartStack {
  return {
    strategy: "all",
    bases: bars.map((bar) => bar.low),
    extents: bars.map((bar) => bar.high - bar.low),
  };
}

/** The sentence the page already shows when the calculated bridge is out of date. */
export const STALE_NOTICE =
  "The setup changed since this bridge was calculated. Calculate again to update it.";

export function noticesAreStale(texts: readonly string[]): boolean {
  return texts.includes(STALE_NOTICE);
}

/** What the grid does for the column the user has chosen. */
export type GridAction = "clear" | "keep" | "calculate";

/**
 * The grid is calculated for the bridge on screen. While that bridge is out
 * of date, a grid that already belongs to it stays, and any other column waits.
 */
export function gridAction(column: string, stale: boolean, shownFor: string): GridAction {
  if (column === "") return "clear";
  if (!stale) return "calculate";
  if (shownFor === column) return "keep";
  return "clear";
}

/** Where keyboard focus goes when a panel opens or closes. */
export type FocusPlace = "back" | "trigger" | "select";

export function focusPlace(action: "open" | "close", triggerConnected: boolean): FocusPlace {
  if (action === "open") return "back";
  return triggerConnected ? "trigger" : "select";
}

interface Session {
  jobs: Array<() => Promise<void>>;
  accepting: boolean;
}

/**
 * One connection's statements, never overlapping. Statements a caller awaits
 * one after another join one session, so an engine call is not split by
 * another caller. A call that arrives while a statement is still running
 * waits for a later session.
 */
export function createConnectionQueue(): {
  schedule<T>(work: () => Promise<T>): Promise<T>;
} {
  let current: Session | null = null;
  let tail: Promise<void> = Promise.resolve();

  function schedule<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Resolve only after `accepting` is set, in this function. Resolving
      // inside `work` would run the caller's next statement before this
      // session could claim it.
      const launch = (session: Session) => async () => {
        session.accepting = false;
        try {
          const value = await work();
          session.accepting = true;
          resolve(value);
          await takeContinuations(session);
        } catch (error) {
          session.accepting = true;
          reject(error);
          await takeContinuations(session);
        } finally {
          session.accepting = false;
        }
      };
      if (current?.accepting) {
        current.jobs.push(launch(current));
        return;
      }
      const session: Session = { jobs: [], accepting: false };
      session.jobs.push(launch(session));
      const run = tail.then(() => drain(session));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
    });
  }

  async function drain(session: Session): Promise<void> {
    current = session;
    try {
      while (session.jobs.length > 0) {
        const job = session.jobs.shift();
        if (!job) break;
        await job();
      }
    } finally {
      if (current === session) current = null;
    }
  }

  async function takeContinuations(session: Session): Promise<void> {
    for (let hop = 0; hop < 16; hop += 1) {
      const before = session.jobs.length;
      await Promise.resolve();
      if (session.jobs.length > before) return;
    }
  }

  return { schedule };
}

/**
 * Remembers only the latest column. A column replaced before its turn
 * started never runs. The column already running finishes, then the latest
 * one runs.
 */
export function createSplitRunner(work: (column: string) => Promise<void>): {
  request(column: string): void;
  settled(): Promise<void>;
} {
  let pending: string | null = null;
  let running = false;
  let idle: Promise<void> = Promise.resolve();
  let resolveIdle: () => void = () => {};

  function request(column: string): void {
    pending = column;
    if (running) return;
    running = true;
    idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    queueMicrotask(() => {
      void pump();
    });
  }

  async function pump(): Promise<void> {
    try {
      while (pending !== null) {
        const column = pending;
        pending = null;
        await work(column);
      }
    } finally {
      running = false;
      if (pending !== null) {
        running = true;
        queueMicrotask(() => {
          void pump();
        });
        return;
      }
      resolveIdle();
    }
  }

  return {
    request,
    settled: () => idle,
  };
}
