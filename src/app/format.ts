const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const wholeFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const compact = (n: number) => compactFormat.format(n);
export const signedCompact = (n: number) => (n >= 0 ? "+" : "") + compactFormat.format(n);
export const whole = (n: number) => wholeFormat.format(n);
export const signedWhole = (n: number) => (n > 0 ? "+" : "") + wholeFormat.format(n);
export const percent = (n: number) => (n * 100).toFixed(1) + "%";
