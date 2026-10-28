const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const wholeFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const priceFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const compact = (n: number) => compactFormat.format(n);
export const signedCompact = (n: number) => (n > 0 ? "+" : "") + compactFormat.format(n);
export const whole = (n: number) => wholeFormat.format(n);
export const signedWhole = (n: number) => (n > 0 ? "+" : "") + wholeFormat.format(n);
export const price = (n: number) => (Number.isFinite(n) ? priceFormat.format(n) : "");
export const percent = (n: number) => (Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "");
export const signedPercent = (n: number) => (Number.isFinite(n) ? (n > 0 ? "+" : "") + (n * 100).toFixed(1) + "%" : "");

/** A value as a share of the prior total. Dividing by the absolute prior keeps the value's sign when the prior total is negative, and a zero prior gives a number the formatters print as blank. */
export const shareOfPrior = (value: number, prior: number) => value / Math.abs(prior);

/** A share of the prior total with its sign kept, for sentences where a fall must read as a fall. */
export const signedShare = (value: number, prior: number) => signedPercent(shareOfPrior(value, prior));

/**
 * The two totals as short figures that read differently. Raises the compact
 * fraction digits until they differ, and falls back to whole dollars when
 * they still print the same.
 */
export function distinctPair(prior: number, current: number): [string, string] {
  for (let digits = 1; digits <= 3; digits += 1) {
    const format = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: digits });
    const pair: [string, string] = [format.format(prior), format.format(current)];
    if (pair[0] !== pair[1]) return pair;
  }
  return [whole(prior), whole(current)];
}

/** A count with its noun, singular only for exactly one. */
export const counted = (n: number, noun: string) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
