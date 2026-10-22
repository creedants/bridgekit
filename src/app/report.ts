import { commentary } from "../commentary.ts";
import { measureName, type AccountGroup, type BridgeConfig, type BridgeResult, type PriceBucket } from "../engine.ts";
import { percent, signedPercent, signedWhole, whole } from "./format.ts";

const markup = (value: unknown) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Shared measure-specific labels for Movers and the report. */
const SALES = {
  bridgeTitle: "Sales bridge",
  ofPrior: "% of prior sales",
  priceEffect: "Price",
  priorPrice: "Prior price",
  currentPrice: "Current price",
  priceChange: "Price change",
  hintUnits: "Prices exclude sales with no units.",
  hintChange: "Price change is the change in average price and includes mix inside the row.",
} as const;
const MARGIN = {
  bridgeTitle: "Margin bridge",
  ofPrior: "% of prior margin",
  priceEffect: "Price and unit cost",
  priorPrice: "Prior unit margin",
  currentPrice: "Current unit margin",
  priceChange: "Unit margin change",
  hintUnits: "Unit margins exclude sales with no units.",
  hintChange: "Unit margin change is the change in average unit margin and includes mix inside the row.",
} as const;
interface Terms {
  bridgeTitle: string;
  ofPrior: string;
  priceEffect: string;
  priorPrice: string;
  currentPrice: string;
  priceChange: string;
  hintUnits: string;
  hintChange: string;
}
const TERMS = { SALES, MARGIN } satisfies Record<string, Terms>;

/** The report and Movers wording for this bridge: sales wording, or margin wording with a cost column. */
export function terms(config: BridgeConfig): Terms {
  return config.costColumn ? TERMS.MARGIN : TERMS.SALES;
}

/** The Movers columns after the grouping columns, in margin wording when the bridge is on margin. */
export function moverHeader(config: BridgeConfig): string[] {
  const t = terms(config);
  const measure = measureName(config).toLowerCase();
  return [
    `Prior ${measure}`, `Current ${measure}`, "Change", "Volume", "Mix", t.priceEffect,
    "New config.", "Discontinued", "No units", t.priorPrice, t.currentPrice, t.priceChange,
  ];
}
/** A table cell that begins with a formula character takes a leading apostrophe, as the CSV export does. */
const cell = (value: unknown) => {
  const text = String(value);
  return markup(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
};

/**
 * A single self-contained HTML file with the chart, bridge, coverage, summary
 * and top movers. It holds totals and a written summary, names the file, the
 * setup and its filter values, and holds no rows, so it can be emailed.
 */
export function buildReport(input: {
  config: BridgeConfig;
  result: BridgeResult;
  chartUrl?: string;
  description: string[];
  movers: { label: string; rows: Record<string, unknown>[]; columns: string[] };
  priceBands: PriceBucket[];
  accounts?: { column: string; groups: AccountGroup[] };
}): string {
  const { config, result } = input;
  const t = terms(config);
  const row = (cells: string[], tag = "td") =>
    `<tr>${cells.map((c, i) => `<${tag}${i > 0 ? ' class="n"' : ""}>${c}</${tag}>`).join("")}</tr>`;
  const bridge = [
    row([cell(`${measureName(config)} ${config.prior}`), whole(result.priorSales), ""]),
    ...result.effects.map((e) => row([cell(e.label), signedWhole(e.value), signedPercent(e.value / result.priorSales)])),
    row([cell(`${measureName(config)} ${config.current}`), whole(result.currentSales), ""]),
  ];
  const mixOf = (r: Record<string, unknown>) =>
    config.levels.reduce((sum, _, i) => sum + Number(r[`mix_${i + 1}`] ?? 0), 0);
  const movers = input.movers.rows.map((r) =>
    row([
      cell(input.movers.columns.map((c) => r[c] ?? "(blank)").join(" / ")),
      signedWhole(Number(r.s1) + Number(r.z1) - Number(r.s0) - Number(r.z0)),
      signedWhole(Number(r.volume)),
      signedWhole(mixOf(r)),
      signedWhole(Number(r.price)),
    ]),
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${markup(t.bridgeTitle)}: ${markup(config.prior)} to ${markup(config.current)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#14181f;max-width:900px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
p{margin:0 0 10px}.muted{color:#6b7480;font-size:12px}
table{border-collapse:collapse;width:100%;margin:0 0 8px}td,th{padding:5px 8px;border-bottom:1px solid #e6e9ed;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#4a5360;border-bottom-color:#c4cad3}
.n{text-align:right;font-variant-numeric:tabular-nums}tr:first-child td,tr:last-child td{font-weight:600}
.plain tr td{font-weight:400}img{max-width:100%}
</style></head><body>
<h1>${markup(t.bridgeTitle)}: ${markup(config.prior)} to ${markup(config.current)}</h1>
<p class="muted">Created ${new Date().toISOString().slice(0, 10)} with Bridgekit. It holds totals and a written summary, names the file, the setup, its filter values and the largest movers, and holds no rows.</p>
${commentary(result, config).map((p) => `<p>${markup(p)}</p>`).join("\n")}
${input.chartUrl ? `<img alt="Waterfall chart of the bridge" src="${input.chartUrl}">` : ""}
<h2>Bridge</h2>
<table>${row(["", "Amount", t.ofPrior], "th")}${bridge.join("")}</table>
<h2>How current sales were matched</h2>
<table class="plain">${row(["Compared against", "Share", "Configurations"], "th")}${result.coverage
    .map((c) => row([cell(c.label), percent(c.share), whole(c.cells)]))
    .join("")}</table>
<h2>Largest movers by ${markup(input.movers.label)}</h2>
<table class="plain">${row([cell(input.movers.label), "Change", "Volume", "Mix", t.priceEffect], "th")}${movers.join("")}</table>
<h2>How widely price moved</h2>
<table class="plain">${row(["Change in average price", "Share of matched sales", "Price effect"], "th")}${input.priceBands
    .map((b) => row([cell(b.label), percent(b.share), signedWhole(b.priceEffect)]))
    .join("")}</table>
${
  input.accounts
    ? `<h2>Change by ${markup(input.accounts.column)}</h2>
<table class="plain">${row(["Group", "Count", "Change"], "th")}${input.accounts.groups
        .map((g) => row([cell(g.status[0].toUpperCase() + g.status.slice(1)), whole(g.count), signedWhole(g.change)]))
        .join("")}</table>`
    : ""
}
<h2>Setup</h2>
<table class="plain">${input.description.map((line) => row(line.split(": ", 2).map(cell))).join("")}</table>
</body></html>`;
}
