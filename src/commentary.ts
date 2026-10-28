import { measureName, wholeDollars, type BridgeConfig, type BridgeResult } from "./engine.ts";
import { distinctPair, percent, signedShare, signedWhole, whole } from "./app/format.ts";

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
      ? `${measureName(config)} was unchanged at ${whole(result.currentSales)} between ${config.prior} and ${config.current}.`
      : `${measureName(config)} ${change > 0 ? "rose" : "fell"}${hasBase ? " " + percent(Math.abs(change / result.priorSales)) + "," : ""} from ${priorText} in ${config.prior} to ${currentText} in ${config.current} (${signedWhole(wholeChange)}).`,
  );

  // The threshold only picks the four named drivers and decides whether this
  // paragraph appears. Every other line joins the leftover sum, so the named
  // lines and the leftover add up to the change the table shows.
  const drivers = result.effects
    .filter((e) => Math.abs(e.value) >= Math.abs(result.priorSales) * 0.0005)
    .toSorted((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (drivers.length > 0) {
    const named = drivers.slice(0, 4);
    const describe = (e: (typeof named)[number]) =>
      `${driverLabel(e, config)} (${signedWhole(e.value)}${hasBase ? `, ${ofPrior(e.value)} of prior ${measure}` : ""})`;
    const [first, ...next] = named;
    const leftovers = result.effects.filter((e) => e.value !== 0 && !named.includes(e));
    const others = leftovers.reduce((sum, e) => sum + e.value, 0);
    const only = leftovers[0];
    paragraphs.push(
      `The largest driver was ${describe(first)}` +
        (next.length ? `, followed by ${next.map(describe).join(", ")}.` : ".") +
        (leftovers.length > 1 ? ` The other ${leftovers.length} lines add up to ${signedWhole(others)}.` : "") +
        (leftovers.length === 1 ? ` ${only.label} adds ${signedWhole(only.value)}.` : ""),
    );
  }

  const priceEffect = result.effects.filter((e) => e.key.startsWith("price")).reduce((sum, e) => sum + e.value, 0);
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const list = result.effects.find((e) => e.key === "price_list");
  const discount = result.effects.find((e) => e.key === "price_discount");
  paragraphs.push(
    `Like-for-like price ${priceEffect >= 0 ? "added" : "took away"} ${whole(Math.abs(priceEffect))}${hasBase ? `, ${ofPrior(priceEffect)} of prior ${measure}` : ""}. ` +
      (list && discount
        ? `Of that, list price changes were ${signedWhole(list.value)} and discount changes were ${signedWhole(discount.value)}. `
        : "") +
      `It is measured on the ${percent(exact)} of current unit sales that matched an exact prior configuration.`,
  );

  const mixes = result.effects.filter((e) => e.key.startsWith("mix_"));
  if (mixes.length > 1) {
    const total = mixes.reduce((sum, e) => sum + e.value, 0);
    const top = mixes.toSorted((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
    const level = config.levels[Number(top.key.slice(4)) - 1];
    paragraphs.push(
      `Mix was ${signedWhole(total)} in total. The largest part was ${level?.name ?? top.label.replace(/^Mix: /, "")} (${signedWhole(top.value)}).`,
    );
  }

  const noUnits = result.effects.find((e) => e.key === "no_units");
  if (noUnits && noUnits.value !== 0) {
    paragraphs.push(
      `Sales on rows with no units, such as rebates, credits and fees, changed by ${signedWhole(noUnits.value)} and are shown on their own line.`,
    );
  }
  return paragraphs;
}
