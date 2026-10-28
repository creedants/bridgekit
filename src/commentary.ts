import { measureName, wholeDollars, type BridgeConfig, type BridgeResult } from "./engine.ts";
import { distinctPair, signedShare } from "./app/format.ts";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const money = (n: number) => compact.format(n);
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + compact.format(Math.abs(n));
const percent = (n: number) => (Math.abs(n) * 100).toFixed(1) + "%";

/** A driver effect named for the reader: mix effects keep their attribute's case. */
function driverLabel(effect: { key: string; label: string }, config: BridgeConfig): string {
  if (effect.key.startsWith("mix_")) {
    const level = config.levels[Number(effect.key.slice(4)) - 1];
    if (level) return `mix: ${level.name}`;
    return effect.label.replace(/^Mix: /, "");
  }
  return effect.label.slice(0, 1).toLowerCase() + effect.label.slice(1);
}

/**
 * A written summary of the bridge. It is assembled from fixed sentence
 * patterns, so the same bridge always produces the same words.
 */
export function commentary(result: BridgeResult, config: BridgeConfig): string[] {
  const change = result.currentSales - result.priorSales;
  // A percentage of a zero or negative base misleads, so it is left out.
  const hasBase = result.priorSales > 0;
  const ofPrior = (n: number) => signedShare(n, result.priorSales);
  // The change prints like the bridge table: whole dollars, and with enough
  // digits that two totals rounding to the same short figure still differ.
  const [priorText, currentText] = distinctPair(result.priorSales, result.currentSales);
  const wholeChange = wholeDollars(change);
  const measure = measureName(config).toLowerCase();
  const paragraphs: string[] = [];

  paragraphs.push(
    change === 0
      ? `${measureName(config)} was unchanged at ${money(result.currentSales)} between ${config.prior} and ${config.current}.`
      : `${measureName(config)} ${change > 0 ? "rose" : "fell"}${hasBase ? " " + percent(change / result.priorSales) + "," : ""} from ${priorText} in ${config.prior} to ${currentText} in ${config.current} (${signed(wholeChange)}).`,
  );

  const drivers = result.effects
    .filter((e) => Math.abs(e.value) >= Math.abs(result.priorSales) * 0.0005)
    .toSorted((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (drivers.length > 0) {
    const describe = (e: (typeof drivers)[number]) =>
      `${driverLabel(e, config)} (${signed(e.value)}${hasBase ? `, ${ofPrior(e.value)} of prior ${measure}` : ""})`;
    const [first, ...rest] = drivers;
    const next = rest.slice(0, 3);
    const others = rest.slice(3).reduce((sum, e) => sum + e.value, 0);
    const tail = rest.length - 3;
    paragraphs.push(
      `The largest driver was ${describe(first)}` +
        (next.length ? `, followed by ${next.map(describe).join(", ")}.` : ".") +
        (tail > 1 ? ` The other ${tail} lines add up to ${signed(others)}.` : "") +
        (tail === 1 ? ` The other line adds up to ${signed(others)}.` : ""),
    );
  }

  const priceEffect = result.effects.filter((e) => e.key.startsWith("price")).reduce((sum, e) => sum + e.value, 0);
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const list = result.effects.find((e) => e.key === "price_list");
  const discount = result.effects.find((e) => e.key === "price_discount");
  paragraphs.push(
    `Like-for-like price ${priceEffect >= 0 ? "added" : "took away"} ${money(Math.abs(priceEffect))}${hasBase ? `, ${ofPrior(priceEffect)} of prior ${measure}` : ""}. ` +
      (list && discount
        ? `Of that, list price changes were ${signed(list.value)} and discount changes were ${signed(discount.value)}. `
        : "") +
      `It is measured on the ${percent(exact)} of current unit sales that matched an exact prior configuration.`,
  );

  const mixes = result.effects.filter((e) => e.key.startsWith("mix_"));
  if (mixes.length > 1) {
    const total = mixes.reduce((sum, e) => sum + e.value, 0);
    const top = mixes.toSorted((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
    const level = config.levels[Number(top.key.slice(4)) - 1];
    paragraphs.push(
      `Mix was ${signed(total)} in total. The largest part was ${level?.name ?? top.label.replace(/^Mix: /, "")} (${signed(top.value)}).`,
    );
  }

  const noUnits = result.effects.find((e) => e.key === "no_units");
  if (noUnits && noUnits.value !== 0) {
    paragraphs.push(
      `Sales on rows with no units, such as rebates, credits and fees, changed by ${signed(noUnits.value)} and are shown on their own line.`,
    );
  }
  return paragraphs;
}
