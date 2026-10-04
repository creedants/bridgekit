import { measureName, type BridgeConfig, type BridgeResult } from "./engine.ts";

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

export function summarize(result: BridgeResult, config: BridgeConfig): BridgeSummary {
  return {
    measure: measureName(config),
    prior: String(config.prior),
    current: String(config.current),
    priorTotal: Math.round(result.priorSales),
    currentTotal: Math.round(result.currentSales),
    effects: result.effects.map((e) => ({ label: e.label, value: Math.round(e.value) })),
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
