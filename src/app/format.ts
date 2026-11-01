const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const wholeFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const priceFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// No formatter prints exponent notation. A figure past what the short units
// can show is capped, and the table's own whole figures print in full.
const AMOUNT_CAP = 1e18;
const HUGE_AMOUNT = "1,000,000T+";
const PERCENT_CAP = 1_000_000;

export const compact = (n: number) =>
  Math.abs(n) >= AMOUNT_CAP ? (n < 0 ? "-" : "") + HUGE_AMOUNT : compactFormat.format(n);
export const signedCompact = (n: number) => (n > 0 ? "+" : "") + compact(n);
export const whole = (n: number) => wholeFormat.format(n);
export const signedWhole = (n: number) => (n > 0 ? "+" : "") + wholeFormat.format(n);
/** A short figure that prints whole units below a thousand, as the table does. */
export const roundedCompact = (n: number) => (Math.abs(n) < 1000 ? whole(n) : compact(n));
export const signedRoundedCompact = (n: number) => (n > 0 ? "+" : "") + roundedCompact(n);
export const price = (n: number) => (Number.isFinite(n) ? priceFormat.format(n) : "");
export const percent = (n: number) => {
  if (!Number.isFinite(n)) return "";
  const value = n * 100;
  if (Math.abs(value) > PERCENT_CAP) return value < 0 ? "<-1,000,000%" : ">1,000,000%";
  return value.toFixed(1) + "%";
};
export const signedPercent = (n: number) => {
  if (!Number.isFinite(n)) return "";
  const value = n * 100;
  if (Math.abs(value) > PERCENT_CAP) return value < 0 ? "<-1,000,000%" : ">1,000,000%";
  return (n > 0 ? "+" : "") + value.toFixed(1) + "%";
};

/**
 * A matched share. A complete result with a positive share prints 100.0%, because every reported
 * coverage row sits at the full configuration, whatever the last bits of the computed share say.
 * Otherwise a share below one that would round up to 100.0% prints 99.9%, because it did not
 * cover everything, and any other share prints as computed.
 */
export const matchedPercent = (n: number, complete = false) => {
  if (complete && Number.isFinite(n) && n > 0) return "100.0%";
  if (!Number.isFinite(n) || n <= 0) return percent(n);
  if (n >= 1) return percent(n);
  const text = percent(n);
  return text === "100.0%" ? "99.9%" : text;
};

/** A value as a share of the prior total. Dividing by the absolute prior keeps the value's sign when the prior total is negative, and a zero prior gives a number the formatters print as blank. */
export const shareOfPrior = (value: number, prior: number) => value / Math.abs(prior);

/** A share of the prior total with its sign kept, for sentences where a fall must read as a fall. */
export const signedShare = (value: number, prior: number) => signedPercent(shareOfPrior(value, prior));

/**
 * Starts with whole figures. When distinct finite totals print alike, tries up
 * to ten fractional digits. Falls back to the whole figures if they still
 * print alike.
 */
export function distinctPair(prior: number, current: number): [string, string] {
  const pair: [string, string] = [whole(prior), whole(current)];
  if (pair[0] !== pair[1]) return pair;
  if (!Number.isFinite(prior) || !Number.isFinite(current)) return pair;
  if (prior === current) return pair;
  for (let digits = 1; digits <= 10; digits += 1) {
    const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: digits });
    const finer: [string, string] = [format.format(prior), format.format(current)];
    if (finer[0] !== finer[1]) return finer;
  }
  return pair;
}

/** A count with its noun, singular only for exactly one. */
export const counted = (n: number, noun: string) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
