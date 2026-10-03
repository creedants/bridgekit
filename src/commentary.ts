import type { BridgeConfig, BridgeResult } from "./engine.ts";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const money = (n: number) => compact.format(n);
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + compact.format(Math.abs(n));
const percent = (n: number) => (Math.abs(n) * 100).toFixed(1) + "%";

/**
 * A written summary of the bridge. It is assembled from fixed sentence
 * patterns, so the same bridge always produces the same words.
 */
export function commentary(result: BridgeResult, config: BridgeConfig): string[] {
  const change = result.currentSales - result.priorSales;
  const ofPrior = (n: number) => percent(n / result.priorSales);
  const paragraphs: string[] = [];

  paragraphs.push(
    change === 0
      ? `Sales were unchanged at ${money(result.currentSales)} between ${config.prior} and ${config.current}.`
      : `Sales ${change > 0 ? "rose" : "fell"} ${ofPrior(change)}, from ${money(result.priorSales)} in ${config.prior} to ${money(result.currentSales)} in ${config.current} (${signed(change)}).`,
  );

  const drivers = result.effects
    .filter((e) => Math.abs(e.value) >= Math.abs(result.priorSales) * 0.0005)
    .toSorted((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (drivers.length > 0) {
    const describe = (e: (typeof drivers)[number]) => `${e.label.toLowerCase()} (${signed(e.value)}, ${ofPrior(e.value)} of prior sales)`;
    const [first, ...rest] = drivers;
    paragraphs.push(
      `The largest driver was ${describe(first)}` +
        (rest.length ? `, followed by ${rest.map(describe).join(", ")}.` : "."),
    );
  }

  const priceEffect = result.effects.filter((e) => e.key.startsWith("price")).reduce((sum, e) => sum + e.value, 0);
  const exact = result.coverage.find((c) => c.level === config.levels.length)?.share ?? 0;
  const list = result.effects.find((e) => e.key === "price_list");
  const discount = result.effects.find((e) => e.key === "price_discount");
  paragraphs.push(
    `Like-for-like price ${priceEffect >= 0 ? "added" : "took away"} ${money(Math.abs(priceEffect))}, ${ofPrior(priceEffect)} of prior sales. ` +
      (list && discount
        ? `Of that, list price changes were ${signed(list.value)} and discount changes were ${signed(discount.value)}. `
        : "") +
      `It is measured on the ${percent(exact)} of current unit sales that matched an exact prior configuration.`,
  );

  const mixes = result.effects.filter((e) => e.key.startsWith("mix_"));
  if (mixes.length > 1) {
    const total = mixes.reduce((sum, e) => sum + e.value, 0);
    const top = mixes.toSorted((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
    paragraphs.push(
      `Mix was ${signed(total)} in total. The largest part was ${top.label.replace("Mix: ", "").toLowerCase()} (${signed(top.value)}).`,
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
