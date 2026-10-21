import type { BridgeBy, BridgePanel, BridgeResult, PanelStatus } from "../engine.ts";
import { compact, signedWhole } from "./format.ts";

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

/** The one sentence shown when the split cannot be calculated. */
export const SPLIT_FAILURE_SENTENCE = "The small bridges could not be calculated.";

const stampedGenerationBrand = Symbol("StampedGeneration");
const liveGenerationBrand = Symbol("LiveGeneration");

/**
 * Queue generation at the first render of a run object.
 * Built only by `noteDisplayedRun`. A live reading does not satisfy this type.
 */
export interface StampedGeneration {
  readonly [stampedGenerationBrand]: "StampedGeneration";
  readonly value: number;
}

/**
 * `pageQueue.generation()` at a settle or a paint.
 * Built only by `readLiveGeneration`. Never stored on a phase.
 */
export interface LiveGeneration {
  readonly [liveGenerationBrand]: "LiveGeneration";
  readonly value: number;
}

/** The run on screen, plus the generation stamped the first time that object rendered. */
export interface RunStamp {
  /** The same object `Results` passes down. Identity, not `run.id`, is the change. */
  readonly run: object;
  /** Increments once per new run object. Starts at 1 for the first run. */
  readonly calculation: number;
  readonly stampedGeneration: StampedGeneration;
}

/**
 * Column plus the displayed run's calculation and stamp.
 * This object has no field for the generation at the start of a split.
 */
export interface SplitIdentity {
  readonly column: string;
  readonly calculation: number;
  readonly stampedGeneration: StampedGeneration;
}

/**
 * The grid, the failure, and the column the grid was shown for.
 * One variant is stored. Paint reads it and does not write it.
 */
export type SplitPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "calculating"; readonly identity: SplitIdentity }
  | { readonly kind: "ready"; readonly identity: SplitIdentity; readonly grid: BridgeBy }
  | { readonly kind: "failed"; readonly identity: SplitIdentity };

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
 * One transition. `inputs` runs from the effect on column, stale, run, and rowsEpoch.
 * `settled` runs from the split runner.
 */
export type SplitEvent =
  | {
      readonly type: "inputs";
      readonly column: string;
      readonly displayed: SplitIdentity;
      readonly stale: boolean;
    }
  | {
      readonly type: "settled";
      /** Copied from the run stamp when the runner took the column. */
      readonly request: SplitIdentity;
      readonly outcome: SplitOutcome<BridgeBy>;
      readonly displayed: SplitIdentity;
      readonly liveGeneration: LiveGeneration;
      readonly stale: boolean;
    };

/**
 * Records the queue generation when `run` first differs from `prior.run`.
 * A later call with the same object returns `prior`, whatever `generationAtRender` is.
 */
export function noteDisplayedRun(
  prior: RunStamp | null,
  run: object,
  generationAtRender: number,
): RunStamp {
  if (prior !== null && prior.run === run) return prior;
  return {
    run,
    calculation: (prior?.calculation ?? 0) + 1,
    stampedGeneration: stampGeneration(generationAtRender),
  };
}

/** Call at settle and at paint with `pageQueue.generation()`. */
export function readLiveGeneration(generation: number): LiveGeneration {
  return { [liveGenerationBrand]: "LiveGeneration", value: generation };
}

/** Copies the stamp off the run. The column is the select, or the column the runner took. */
export function displayedIdentity(stamp: RunStamp, column: string): SplitIdentity {
  return {
    column,
    calculation: stamp.calculation,
    stampedGeneration: stamp.stampedGeneration,
  };
}

/**
 * Stores a grid or a failure only when `splitBelongs` is true.
 * A result that fails that test leaves `phase` as it was.
 * `inputs` asks `gridAction`. The ready column is `shownFor`, and every other phase passes `""`.
 */
export function reduceSplitPhase(phase: SplitPhase, event: SplitEvent): SplitPhase {
  switch (event.type) {
    case "inputs": {
      const shownFor = phase.kind === "ready" ? phase.identity.column : "";
      const action = gridAction(event.column, event.stale, shownFor);
      if (action === "keep") return phase;
      if (action === "clear") return phase.kind === "idle" ? phase : IDLE_SPLIT_PHASE;
      const identity: SplitIdentity = {
        column: event.column,
        calculation: event.displayed.calculation,
        stampedGeneration: event.displayed.stampedGeneration,
      };
      if (phase.kind === "calculating" && sameIdentity(phase.identity, identity)) return phase;
      return { kind: "calculating", identity };
    }
    case "settled": {
      if (event.outcome.status === "drop") return phase;
      if (!splitBelongs(event.request, event.displayed, event.liveGeneration, event.stale)) return phase;
      if (event.outcome.status === "fail") {
        if (phase.kind === "failed" && sameIdentity(phase.identity, event.request)) return phase;
        return { kind: "failed", identity: event.request };
      }
      if (
        phase.kind === "ready"
        && sameIdentity(phase.identity, event.request)
        && phase.grid === event.outcome.result
      ) {
        return phase;
      }
      return { kind: "ready", identity: event.request, grid: event.outcome.result };
    }
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Reads the phase and does not write it.
 * An empty column, or a stamp that differs from the live generation, paints nothing.
 * That includes a grid stored while it belonged, and a calculation still in flight.
 * A matching ready grid paints while the stale notice is up.
 * A matching failed phase paints the sentence while the notice is absent, and the same inputs paint it again.
 */
export function paintSplit(input: {
  phase: SplitPhase;
  displayed: SplitIdentity;
  liveGeneration: LiveGeneration;
  stale: boolean;
}): SplitPaint {
  if (input.displayed.column === "") return { view: "nothing" };
  if (input.displayed.stampedGeneration.value !== input.liveGeneration.value) return { view: "nothing" };
  if (input.phase.kind === "ready" && sameIdentity(input.phase.identity, input.displayed)) {
    return { view: "grid", grid: input.phase.grid };
  }
  if (
    input.phase.kind === "failed"
    && sameIdentity(input.phase.identity, input.displayed)
    && !input.stale
  ) {
    return { view: "failed", sentence: SPLIT_FAILURE_SENTENCE };
  }
  if (input.stale) return { view: "nothing" };
  return { view: "calculating" };
}

/**
 * True when the request column is non-empty and equals the displayed column,
 * the calculation counters are equal, the request stamp is the displayed stamp,
 * that stamp's value equals the live generation, and the stale notice is absent.
 * Compares the run's stamp with the live generation. Does not compare two live readings.
 */
function splitBelongs(
  request: SplitIdentity,
  displayed: SplitIdentity,
  liveGeneration: LiveGeneration,
  stale: boolean,
): boolean {
  return !stale
    && request.column !== ""
    && request.column === displayed.column
    && request.calculation === displayed.calculation
    && request.stampedGeneration === displayed.stampedGeneration
    && request.stampedGeneration.value === liveGeneration.value;
}

function sameIdentity(left: SplitIdentity, right: SplitIdentity): boolean {
  return left.column === right.column
    && left.calculation === right.calculation
    && left.stampedGeneration.value === right.stampedGeneration.value;
}

function stampGeneration(value: number): StampedGeneration {
  return { [stampedGenerationBrand]: "StampedGeneration", value };
}

/**
 * Runs one split and keeps the result only while `splitBelongs` stays true.
 * A failed install is a failure, not a hang, because the await sits in this try.
 * `fail` is returned only while the split still belongs. A mismatch is a drop.
 */
export async function attemptSplit<Q, T>(input: {
  request: SplitIdentity;
  displayed: () => SplitIdentity;
  liveGeneration: () => LiveGeneration;
  stale: () => boolean;
  install: () => Promise<void>;
  prepare: () => Promise<Q>;
  calculate: (prepared: Q) => Promise<T>;
}): Promise<SplitOutcome<T>> {
  const belongs = () => splitBelongs(
    input.request,
    input.displayed(),
    input.liveGeneration(),
    input.stale(),
  );
  try {
    await input.install();
    if (!belongs()) return { status: "drop" };
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

/**
 * Remembers a successful attempt and forgets a rejected one, so the next caller
 * tries again instead of awaiting the same failure.
 */
export function createAttemptCache(): { run(start: () => Promise<void>): Promise<void> } {
  let pending: Promise<void> | null = null;
  return {
    run(start) {
      if (pending) return pending;
      let attempt: Promise<void> | null = null;
      attempt = start().then(
        () => undefined,
        (error: unknown) => {
          if (pending === attempt) pending = null;
          throw error;
        },
      );
      pending = attempt;
      return attempt;
    },
  };
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
  /** Runs after the current session and never joins it. Bumps the row generation before the work starts. */
  turn<T>(work: () => Promise<T>): Promise<T>;
  generation(): number;
  /** Fires when a rejected turn restores the row generation. Returns the unsubscribe. */
  whenTurnRejected(listen: () => void): () => void;
} {
  let current: Session | null = null;
  let tail: Promise<void> = Promise.resolve();
  let rows = 0;
  const rejected = new Set<() => void>();

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
    const stamp = ++rows;
    return new Promise<T>((resolve, reject) => {
      const session: Session = { jobs: [], accepting: false };
      session.jobs.push(async () => {
        try {
          resolve(await work());
        } catch (error) {
          if (rows === stamp) {
            rows = stamp - 1;
            for (const listen of [...rejected]) listen();
          }
          reject(error);
        }
      });
      enqueue(session);
    });
  }

  return {
    schedule,
    turn,
    generation: () => rows,
    whenTurnRejected(listen) {
      rejected.add(listen);
      return () => rejected.delete(listen);
    },
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
