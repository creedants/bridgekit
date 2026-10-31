import { measureName, tieRank, type BridgeConfig, type BridgeResult } from "./engine.ts";

/**
 * The bridge reduced to its totals: the only thing that may leave the browser,
 * and only when the user asks (AI commentary, saving to a workspace). It holds
 * names the user chose (measure, attributes, effect labels, period labels) and
 * whole-number totals; never rows, and never a value from a text column such
 * as a customer or product.
 */
export interface BridgeSummary {
  measure: "Sales" | "Margin";
  prior: string;
  current: string;
  priorTotal: number;
  currentTotal: number;
  effects: { label: string; value: number }[];
  /** Attribute names, most important first. */
  attributes: string[];
  /** Share of current unit sales matched to the same configuration in the prior period, 0 to 1. */
  exactMatchShare: number;
  newAndDiscontinued: "difference" | "full";
}

/** A bridge rounded to one unit, so the shown effect lines plus the shown prior total equal the shown current total. */
export interface RoundedBridge {
  prior: number;
  current: number;
  /** One rounded value per input effect, in the same order. */
  values: number[];
}

/**
 * Rounds a bridge with the largest-remainder rule: floor every effect, then hand
 * the leftover units to the largest remainders, so prior + sum(values) === current.
 * A rank array decides ties, so the order the values are listed in cannot move a unit.
 */
export function roundBridge(
  prior: number,
  current: number,
  values: readonly number[],
  unit = 1,
  rank?: readonly number[],
): RoundedBridge {
  const priorUnits = Math.round(prior / unit);
  const currentUnits = Math.round(current / unit);
  const lines = values.map((value, index) => {
    const exact = value / unit;
    const floor = Math.floor(exact);
    return { index, rank: rank?.[index] ?? index, floor, remainder: exact - floor, size: Math.abs(value) };
  });
  const leftover = currentUnits - priorUnits - lines.reduce((sum, line) => sum + line.floor, 0);
  const k = Math.max(-lines.length, Math.min(lines.length, leftover));
  const step = k < 0 ? -1 : 1;
  const ranked = [...lines].sort((a, b) =>
    k < 0
      ? a.remainder - b.remainder || b.size - a.size || a.rank - b.rank
      : b.remainder - a.remainder || b.size - a.size || a.rank - b.rank,
  );
  const moved = new Set(ranked.slice(0, Math.abs(k)).map((line) => line.index));
  return {
    prior: priorUnits * unit,
    current: currentUnits * unit,
    values: lines.map((line) => (line.floor + (moved.has(line.index) ? step : 0)) * unit),
  };
}

/** Rounds a bridge's effects by their own keys, so the order they are listed in cannot move a shown unit. */
export function roundEffects(
  prior: number,
  current: number,
  effects: readonly { key: string; value: number }[],
  unit = 1,
): RoundedBridge {
  return roundBridge(
    prior,
    current,
    effects.map((effect) => effect.value),
    unit,
    effects.map((effect) => tieRank(effect.key)),
  );
}

/**
 * The rounded total of the effect lines whose key starts with `prefix`. A KPI,
 * the table lines it sums and the written summary print this one figure.
 */
export function shownTotal(shown: RoundedBridge, effects: readonly { key: string }[], prefix: string): number {
  return effects.reduce((sum, effect, index) => (effect.key.startsWith(prefix) ? sum + (shown.values[index] ?? 0) : sum), 0);
}

export function summarize(result: BridgeResult, config: BridgeConfig): BridgeSummary {
  const shown = roundEffects(result.priorSales, result.currentSales, result.effects);
  return {
    measure: measureName(config),
    prior: String(config.prior),
    current: String(config.current),
    priorTotal: shown.prior,
    currentTotal: shown.current,
    effects: result.effects.map((e, i) => ({ label: e.label, value: shown.values[i] })),
    attributes: config.levels.map((l) => l.name),
    exactMatchShare: Math.round((result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0) * 1000) / 1000,
    newAndDiscontinued: config.newAndDiscontinued ?? "difference",
  };
}

const LIMITS = { text: 120, effects: 40, attributes: 20 };

/**
 * Checks untrusted input against the exact shape above and nothing more, so a
 * server cannot be handed rows or free text dressed up as a summary.
 */
export function parseSummary(value: unknown): BridgeSummary | null {
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LIMITS.text;
  const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const exactKeys = (o: object, keys: string[]) => {
    const own = Object.keys(o);
    return own.length === keys.length && keys.every((k) => own.includes(k));
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const keys = ["measure", "prior", "current", "priorTotal", "currentTotal", "effects", "attributes", "exactMatchShare", "newAndDiscontinued"];
  const ok =
    exactKeys(s, keys) &&
    (s.measure === "Sales" || s.measure === "Margin") &&
    text(s.prior) &&
    text(s.current) &&
    number(s.priorTotal) &&
    number(s.currentTotal) &&
    Array.isArray(s.effects) &&
    s.effects.length > 0 &&
    s.effects.length <= LIMITS.effects &&
    s.effects.every(
      (e) => typeof e === "object" && e !== null && exactKeys(e, ["label", "value"]) && text(e.label) && number(e.value),
    ) &&
    Array.isArray(s.attributes) &&
    s.attributes.length > 0 &&
    s.attributes.length <= LIMITS.attributes &&
    s.attributes.every(text) &&
    number(s.exactMatchShare) &&
    s.exactMatchShare >= 0 &&
    s.exactMatchShare <= 1 &&
    (s.newAndDiscontinued === "difference" || s.newAndDiscontinued === "full");
  return ok ? (s as unknown as BridgeSummary) : null;
}
