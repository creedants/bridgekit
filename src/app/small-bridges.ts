import type { BridgeBy, BridgePanel, BridgeResult, PanelStatus, Query } from "../engine.ts";
import type { LoadedPeriods, PeriodView } from "./fileProblems.ts";
import { compact, signedWhole } from "./format.ts";

/**
 * The small-bridge rules and the page's read rules, in one place and free of
 * React, of the document and of the database, so the tests can check them
 * without a browser. `Waterfall.tsx` only draws: it takes the steps this file
 * decides and puts them on a canvas.
 *
 * The read rules are the latest-only ticket, which stops a superseded read from
 * installing its SQL over a newer one, and the period views, which say whether
 * the SQL in the database belongs to the setup on screen.
 */

/**
 * A read's result, or the fact that a newer read of the same resource started
 * before this one settled. A statement already issued cannot be recalled, so
 * the newest read's statements follow it in queue order; what supersession
 * stops is the older read issuing any more.
 */
export type Latest<T> =
  | { readonly status: "latest"; readonly value: T }
  | { readonly status: "superseded" };

export interface LatestTicket {
  /**
   * Runs `work` with a query that refuses, without calling the database, once a
   * newer ticket has started. Resolves `superseded` when that happens.
   */
  run<T>(query: Query, work: (current: Query) => Promise<T>): Promise<Latest<T>>;
}

// Thrown by the guarded query and caught by the ticket. No caller sees it.
const SUPERSEDED = Symbol("superseded");

/** One current read per resource: starting a ticket supersedes every earlier ticket. */
export function createLatestOnly(): { start(): LatestTicket } {
  let started = 0;
  return {
    start() {
      const ticket = ++started;
      const superseded = () => started > ticket;
      return {
        async run<T>(query: Query, work: (current: Query) => Promise<T>): Promise<Latest<T>> {
          const current: Query = async (sql) => {
            if (superseded()) throw SUPERSEDED;
            return query(sql);
          };
          try {
            const value = await work(current);
            return superseded() ? { status: "superseded" } : { status: "latest", value };
          } catch (error: unknown) {
            // A read that was replaced reports nothing, so a stale failure cannot
            // leave its error over the read that replaced it.
            if (error === SUPERSEDED || superseded()) return { status: "superseded" };
            throw error;
          }
        },
      };
    },
  };
}

export interface PeriodViews {
  /** The list on screen. Kept through a rebuild, so the period dropdown never empties. */
  readonly list: LoadedPeriods | null;
  /** The view whose SQL the database holds, or null while a rebuild is unfinished or failed. */
  readonly installed: PeriodView | null;
}

export const NO_PERIOD_VIEWS: PeriodViews = { list: null, installed: null };

export type PeriodViewsEvent =
  | { readonly type: "rebuilding" }
  | { readonly type: "rebuilt"; readonly view: PeriodView; readonly values: readonly string[] }
  | { readonly type: "noPeriodColumn"; readonly view: PeriodView };

/**
 * The list and the installed view move together only on `rebuilt`. A rebuild in
 * flight keeps the list on screen and drops the gate, because the SQL in the
 * database no longer belongs to any finished read.
 */
export function reducePeriodViews(state: PeriodViews, event: PeriodViewsEvent): PeriodViews {
  switch (event.type) {
    case "rebuilding":
      return { list: state.list, installed: null };
    case "rebuilt":
      return { list: { view: event.view, values: event.values }, installed: event.view };
    case "noPeriodColumn":
      // A setup with no period column has no period SQL of its own either, so the
      // gate stays shut until a later rebuild says which view the database holds.
      return { list: { view: event.view, values: [] }, installed: null };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** True only when the SQL in the database was built for `view` by a finished, newest read. */
export function viewsInstalled(state: PeriodViews, view: PeriodView | null): boolean {
  return view !== null && state.installed === view;
}

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

/**
 * Deltas are usually small next to the totals, so the axis starts above zero
 * when it has to. A level below zero lowers the axis to that level exactly.
 * Padding under it would move the shared scale, which already reaches the
 * lowest level on its own.
 */
export function axisFloor(bars: Step[]): number {
  const levels = barLevels(bars);
  const low = Math.min(...levels);
  const range = Math.max(...levels) - low;
  if (low < 0) return low;
  if (range <= 0 || low - range * 0.6 <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(range));
  return Math.floor((low - range * 0.6) / step) * step;
}

/** The sentence under the main waterfall and the full-size panel, or null when the axis starts at zero. */
export function axisCaption(bars: Step[]): string | null {
  const floor = axisFloor(bars);
  if (floor === 0) return null;
  return `Value axis starts at ${compact(floor)}, not zero, so the steps are visible.`;
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

/** What the grid does for the column the user has chosen. */
export type GridAction = "clear" | "keep" | "calculate";

/**
 * The grid is calculated for the bridge on screen. While that bridge is out
 * of date, a grid that already belongs to it stays, and any other column waits.
 * A fresh bridge keeps only the grid for the column now chosen.
 */
export function gridAction(column: string, stale: boolean, shownFor: string): GridAction {
  if (column === "") return "clear";
  if (stale) return shownFor === "" ? "clear" : "keep";
  return shownFor === column ? "keep" : "calculate";
}

/** The one sentence shown when the split cannot be calculated. */
export const SPLIT_FAILURE_SENTENCE = "The small bridges could not be calculated.";

/**
 * The grid, the failure, and the column each belongs to.
 * One variant is stored. Paint reads it and does not write it.
 */
export type SplitPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "calculating"; readonly column: string }
  | { readonly kind: "ready"; readonly column: string; readonly grid: BridgeBy }
  | { readonly kind: "failed"; readonly column: string };

export const IDLE_SPLIT_PHASE: SplitPhase = { kind: "idle" };

/**
 * What the shell renders. `failed` carries the existing sentence and no other.
 * `nothing` is an empty body under the select.
 */
export type SplitPaint =
  | { readonly view: "nothing" }
  | { readonly view: "calculating" }
  | { readonly view: "grid"; readonly grid: BridgeBy }
  | { readonly view: "failed"; readonly sentence: typeof SPLIT_FAILURE_SENTENCE };

export type SplitOutcome<T> =
  | { readonly status: "grid"; readonly result: T }
  | { readonly status: "drop" }
  | { readonly status: "fail" };

/**
 * One transition. `inputs` runs from the effect on the column, the notice and the run.
 * `settled` runs from the split runner.
 */
export type SplitEvent =
  | {
      readonly type: "inputs";
      readonly column: string;
      readonly stale: boolean;
    }
  | {
      readonly type: "settled";
      /** The column the runner took. */
      readonly request: string;
      readonly outcome: SplitOutcome<BridgeBy>;
      readonly displayed: string;
      readonly stale: boolean;
    };

/**
 * Stores a grid or a failure only when `splitBelongs` is true.
 * A result that fails that test leaves `phase` as it was.
 * `inputs` asks `gridAction`. The ready column is `shownFor`, and every other phase passes `""`.
 */
export function reduceSplitPhase(phase: SplitPhase, event: SplitEvent): SplitPhase {
  switch (event.type) {
    case "inputs": {
      const shownFor = phase.kind === "ready" ? phase.column : "";
      const action = gridAction(event.column, event.stale, shownFor);
      if (action === "keep") return phase;
      if (action === "clear") return phase.kind === "idle" ? phase : IDLE_SPLIT_PHASE;
      if (phase.kind === "calculating" && phase.column === event.column) return phase;
      return { kind: "calculating", column: event.column };
    }
    case "settled": {
      if (event.outcome.status === "drop") return phase;
      if (!splitBelongs(event.request, event.displayed, event.stale)) return phase;
      if (event.outcome.status === "fail") {
        if (phase.kind === "failed" && phase.column === event.request) return phase;
        return { kind: "failed", column: event.request };
      }
      if (
        phase.kind === "ready"
        && phase.column === event.request
        && phase.grid === event.outcome.result
      ) {
        return phase;
      }
      return { kind: "ready", column: event.request, grid: event.outcome.result };
    }
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Reads the phase and does not write it.
 * An empty column paints nothing, and so does a stale run with no grid of its own.
 * A matching ready grid paints while the stale notice is up.
 * A matching failed phase paints the sentence while the notice is absent.
 */
export function paintSplit(input: {
  phase: SplitPhase;
  column: string;
  stale: boolean;
}): SplitPaint {
  if (input.column === "") return { view: "nothing" };
  if (input.phase.kind === "ready" && input.phase.column === input.column) {
    return { view: "grid", grid: input.phase.grid };
  }
  if (input.phase.kind === "failed" && input.phase.column === input.column && !input.stale) {
    return { view: "failed", sentence: SPLIT_FAILURE_SENTENCE };
  }
  if (input.stale) return { view: "nothing" };
  return { view: "calculating" };
}

/** True when the request column is non-empty, equals the displayed column, and the notice is absent. */
function splitBelongs(request: string, displayed: string, stale: boolean): boolean {
  return !stale && request !== "" && request === displayed;
}

/**
 * Runs one split and keeps the result only while `splitBelongs` stays true.
 * `fail` is returned only while the split still belongs. A mismatch is a drop.
 */
export async function attemptSplit<Q, T>(input: {
  request: string;
  displayed: () => string;
  stale: () => boolean;
  prepare: () => Promise<Q>;
  calculate: (prepared: Q) => Promise<T>;
}): Promise<SplitOutcome<T>> {
  const belongs = () => splitBelongs(input.request, input.displayed(), input.stale());
  try {
    const prepared = await input.prepare();
    if (!belongs()) return { status: "drop" };
    const result = await input.calculate(prepared);
    if (!belongs()) return { status: "drop" };
    return { status: "grid", result };
  } catch (error: unknown) {
    console.error(error);
    if (!belongs()) return { status: "drop" };
    return { status: "fail" };
  }
}

/**
 * True for the statement that replaces the loaded table.
 * A temporary table and a view stay on the joining path.
 */
export function statementStartsTurn(sql: string): boolean {
  return /^\s*create\s+or\s+replace\s+table\b/i.test(sql);
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
  /** Runs after the current session and never joins it. */
  turn<T>(work: () => Promise<T>): Promise<T>;
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
      enqueue(session);
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

  function enqueue(session: Session): void {
    const run = tail.then(() => drain(session));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
  }

  function turn<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const session: Session = { jobs: [], accepting: false };
      session.jobs.push(async () => {
        try {
          resolve(await work());
        } catch (error) {
          reject(error);
        }
      });
      enqueue(session);
    });
  }

  return { schedule, turn };
}

/**
 * One block of the painted grid, in panel order. A value with a bridge draws
 * its bars; a value with nothing to bridge shows its two figures instead.
 */
export type PanelBlock =
  | { readonly kind: "bridge"; readonly title: string; readonly status: string | null; readonly bars: Step[] }
  | { readonly kind: "figures"; readonly title: string; readonly status: string | null; readonly prior: number; readonly current: number };

/**
 * The shared representation of a split result. The grid on screen, the
 * Excel sheet and the picture export each call drawGrid on that same result,
 * so their panel figures use the same derivation without rerunning the engine.
 */
export interface DrawnGrid {
  readonly blocks: PanelBlock[];
  readonly scale: ValueScale;
  readonly between: string;
}

/** One derivation of every block and the one axis they share. */
export function drawGrid(by: BridgeBy, priorLabel: string, currentLabel: string): DrawnGrid {
  const blocks: PanelBlock[] = by.panels.map((panel) => {
    const title = panelTitle(panel);
    const status = panelStatusLabel(panel.status);
    if (panel.result) return { kind: "bridge", title, status, bars: steps(panel.result, priorLabel, currentLabel) };
    return { kind: "figures", title, status, prior: panel.priorSales, current: panel.currentSales };
  });
  const scale = sharedScale(blocks.flatMap((block) => (block.kind === "bridge" ? [block.bars] : [])));
  return { blocks, scale, between: betweenLine(by) };
}

/**
 * The ready grid of the run on screen, published by the one writer in
 * `SmallBridges.tsx`. `App.tsx` cannot pass its grid through the export call,
 * so the exports read it here instead, keyed on the run's own result object.
 */
let shown: { owner: BridgeResult; grid: BridgeBy } | null = null;

/**
 * The grid exports may read for this phase on screen: the painted grid when the
 * select shows its column, and nothing while the paint hides it. The phase keeps
 * the grid either way, so returning to its column publishes it again.
 */
export function publishedGrid(phase: SplitPhase, column: string, stale: boolean): BridgeBy | null {
  const paint = paintSplit({ phase, column, stale });
  return paint.view === "grid" ? paint.grid : null;
}

/**
 * Publishes the grid exports may read for `owner`, and clears any earlier one
 * for any other phase. Idempotent: publishing the same ready grid twice keeps it.
 */
export function showSplit(owner: BridgeResult, phase: SplitPhase, column: string, stale: boolean): void {
  const grid = publishedGrid(phase, column, stale);
  shown = grid === null ? null : { owner, grid };
}

/** The published grid, or null when it belongs to another run or no grid is ready. */
export function shownSplit(owner: BridgeResult): BridgeBy | null {
  return shown !== null && shown.owner === owner ? shown.grid : null;
}

/** One rectangle on the composite picture, in CSS pixels. */
export interface PictureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the composite picture puts the main bridge, one cell per grid block
 * in rows of `columns`, and the wrapped between lines underneath.
 */
export interface PictureLayout {
  readonly width: number;
  readonly height: number;
  readonly main: PictureRect;
  readonly cells: PictureRect[];
  readonly between: string[];
}

/** The grid's fixed cell size on the picture, in CSS pixels. */
export const PICTURE_CELL_WIDTH = 420;
export const PICTURE_CELL_HEIGHT = 320;

/** Wraps at word boundaries near `width` characters, preserving overlong words. */
export function wrapBetweenLine(line: string, width: number): string[] {
  const words = line.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const joined = current ? `${current} ${word}` : word;
    if (joined.length <= width) {
      current = joined;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** The composite picture's geometry: the main bridge on top, the grid below it. */
export function pictureLayout(
  mainSize: { width: number; height: number },
  grid: DrawnGrid,
  columns: number,
): PictureLayout {
  const gap = 24;
  const lineHeight = 28;
  const charsPerLine = Math.max(20, Math.floor(Math.max(mainSize.width, columns * PICTURE_CELL_WIDTH) / 9));
  const width = Math.max(mainSize.width, columns * PICTURE_CELL_WIDTH);
  const rows = Math.ceil(grid.blocks.length / columns);
  const gridTop = mainSize.height + gap;
  const cells: PictureRect[] = grid.blocks.map((_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      x: column * PICTURE_CELL_WIDTH,
      y: gridTop + row * PICTURE_CELL_HEIGHT,
      width: PICTURE_CELL_WIDTH,
      height: PICTURE_CELL_HEIGHT,
    };
  });
  const between = wrapBetweenLine(grid.between, charsPerLine);
  const betweenTop = gridTop + rows * PICTURE_CELL_HEIGHT + gap / 2;
  return {
    width,
    height: betweenTop + between.length * lineHeight + gap,
    main: { x: 0, y: 0, width: mainSize.width, height: mainSize.height },
    cells,
    between,
  };
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
