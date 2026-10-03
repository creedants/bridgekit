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
