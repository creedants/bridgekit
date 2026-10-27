import { commentary } from "../commentary.ts";
import { coverageLabel, effectColumns, measureName, type AccountGroup, type BridgeConfig, type BridgeResult, type PriceBucket } from "../engine.ts";
import type { Setup } from "./setup.ts";
import { percent, shareOfPrior, signedPercent, signedWhole, whole } from "./format.ts";

const markup = (value: unknown) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Shared measure-specific labels for Movers and the report. */
const SALES = {
  bridgeTitle: "Sales bridge",
  ofPrior: "% of prior sales",
  prior: "Prior sales",
  current: "Current sales",
  matchedHeading: "How current sales were matched",
  matchedShare: "Share of matched sales",
  priceEffect: "Price",
  priorPrice: "Prior price",
  currentPrice: "Current price",
  priceChange: "Price change",
  hintUnits: "Prices exclude sales with no units.",
  hintChange: "Price change is the change in average price and includes mix inside the row.",
  exactNote: "of current sales with units",
  sharesNote: "Shares are of current sales on rows with units.",
  priceUp: "Sales with a price increase",
  priceFlat: "Sales with no change",
  priceDown: "Sales with a price decrease",
  matched: "Matched sales",
  againstPlan: "Against plan is the sales above or below what the planned increase would have delivered.",
  largestGroups: "Largest 200 groups by matched sales.",
  measure: "Sales",
  compared: "Sales compared",
  ofCompared: "of sales compared",
  lowMatch: (share: number) =>
    `Only ${percent(share)} of current sales matched an exact prior configuration. Consider fewer attributes, or check the Unmatched tab.`,
} as const;
const MARGIN = {
  bridgeTitle: "Margin bridge",
  ofPrior: "% of prior margin",
  prior: "Prior margin",
  current: "Current margin",
  matchedHeading: "How current margin was matched",
  matchedShare: "Share of matched margin",
  priceEffect: "Price and unit cost",
  priorPrice: "Prior unit margin",
  currentPrice: "Current unit margin",
  priceChange: "Unit margin change",
  hintUnits: "Unit margins exclude sales with no units.",
  hintChange: "Unit margin change is the change in average unit margin and includes mix inside the row.",
  exactNote: "of current margin with units",
  sharesNote: "Shares are of current margin on rows with units.",
  priceUp: "Margin with a price increase",
  priceFlat: "Margin with no change",
  priceDown: "Margin with a price decrease",
  matched: "Matched margin",
  againstPlan: "Against plan is the margin above or below what the planned increase would have delivered.",
  largestGroups: "Largest 200 groups by matched margin.",
  measure: "Margin",
  compared: "Margin compared",
  ofCompared: "of margin compared",
  lowMatch: (share: number) =>
    `Only ${percent(share)} of current margin matched an exact prior configuration. Consider fewer attributes, or check the Unmatched tab.`,
} as const;
interface Terms {
  bridgeTitle: string;
  ofPrior: string;
  prior: string;
  current: string;
  matchedHeading: string;
  matchedShare: string;
  priceEffect: string;
  priorPrice: string;
  currentPrice: string;
  priceChange: string;
  hintUnits: string;
  hintChange: string;
  exactNote: string;
  sharesNote: string;
  priceUp: string;
  priceFlat: string;
  priceDown: string;
  matched: string;
  againstPlan: string;
  largestGroups: string;
  measure: string;
  compared: string;
  ofCompared: string;
  lowMatch: (share: number) => string;
}
const TERMS = { SALES, MARGIN } satisfies Record<string, Terms>;

/** The report and Movers wording for this bridge: sales wording, or margin wording with a cost column. */
export function terms(config: BridgeConfig): Terms {
  return config.costColumn ? TERMS.MARGIN : TERMS.SALES;
}

/** The Movers columns after the grouping columns, in margin wording when the bridge is on margin. */
export function moverHeader(config: BridgeConfig): string[] {
  const t = terms(config);
  return [
    t.prior, t.current, "Change", "Volume", "Mix", t.priceEffect,
    "New config.", "Discontinued", "No units", t.priorPrice, t.currentPrice, t.priceChange,
  ];
}

/** The Trend tab columns, in order, so whether a margin bridge's Unit cost column appears is decided here rather than in the JSX. */
export function trendHeader(config: BridgeConfig): { label: string; num: boolean }[] {
  const unitCost = effectColumns(config).find((column) => column.key === "cost_rate")?.label;
  return [
    { label: "Periods", num: false },
    { label: "Change", num: true },
    { label: "Volume", num: true },
    { label: "Mix", num: true },
    { label: "Price", num: true },
    ...(config.costColumn && unitCost ? [{ label: unitCost, num: true }] : []),
    { label: "Price, % of prior", num: true },
    { label: "Price effect", num: false },
    { label: "New and discontinued", num: true },
    { label: "No units", num: true },
  ];
}
/** A table cell that begins with a formula character takes a leading apostrophe, as the CSV export does. */
const cell = (value: unknown) => {
  const text = String(value);
  return markup(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
};

const safeAttributeName = (level: BridgeConfig["levels"][number], index: number) =>
  level.columns.join(" + ") || `Attribute ${index + 1}`;

/** Human-readable lines describing the setup, for exports. Moved here from App.tsx so the report builds both states from one place. */
export function describeSetup(setup: Setup, prior: string | number, current: string | number, source: string): string[] {
  return [
    `Source: ${source}`,
    `Periods: ${prior} to ${current} (${setup.periodColumn}${setup.grain === "value" ? "" : ", by " + setup.grain})`,
    `Units column: ${setup.unitsColumn}`,
    `Sales column: ${setup.salesColumn}`,
    // Cost takes precedence over gross in cellsSql, so Setup lists gross only when cost is not set.
    ...(setup.grossColumn && !setup.costColumn ? [`Gross sales column: ${setup.grossColumn}`] : []),
    ...(setup.costColumn ? [`Cost column: ${setup.costColumn} (bridge is on margin)`] : []),
    ...setup.levels.map((level, i) => `Attribute ${i + 1}: ${level.name} (${level.columns.join(" + ")})`),
    `New and discontinued: ${setup.newAndDiscontinued === "full" ? "full sales, outside volume and mix" : "price difference only, units in volume"}`,
    ...setup.filters
      .filter((f) => f.values.length > 0)
      .map((f) => `Filter: ${f.column} ${f.mode === "include" ? "is one of" : "is not"} ${f.values.join(", ")}`),
  ];
}

/**
 * A self-contained HTML file, with no raw rows, so it can be emailed. By
 * default it holds the chart when one is given, the bridge, coverage, summary
 * and top movers, and names the file, the setup, its filter values and the
 * largest movers. With
 * omitNames it holds no chart, mover rows show ranks instead of names,
 * attribute labels fall back to column names, and Setup leaves out the file
 * name and filter values.
 */
export function buildReport(input: {
  config: BridgeConfig;
  result: BridgeResult;
  chartUrl?: string;
  description: string[];
  setup?: Setup;
  source?: string;
  movers: { label: string; rows: Record<string, unknown>[]; columns: string[] };
  priceBands: PriceBucket[];
  accounts?: { column: string; groups: AccountGroup[] };
  omitNames?: boolean;
}): string {
  const { config, result } = input;
  const omit = input.omitNames === true;
  const t = terms(config);
  const safeLevels = config.levels.map((level, i) => ({ ...level, name: safeAttributeName(level, i) }));
  const safeConfig: BridgeConfig = { ...config, levels: safeLevels };
  const safeEffects = result.effects.map((e) => {
    if (!e.key.startsWith("mix_")) return e;
    const index = Number(e.key.slice(4)) - 1;
    const safe = safeLevels[index]?.name ?? `Attribute ${index + 1}`;
    return { ...e, label: `Mix: ${safe}` };
  });
  const viewEffects = omit ? safeEffects : result.effects;
  const viewCoverage = omit
    ? result.coverage.map((c) => ({ ...c, label: coverageLabel(safeConfig, c.level) }))
    : result.coverage;
  const paragraphs = omit
    ? commentary({ ...result, effects: safeEffects }, safeConfig)
    : commentary(result, config);
  const safeMoversLabel = safeLevels[0]?.name ?? input.movers.label;
  const viewMoversLabel = omit ? safeMoversLabel : input.movers.label;
  const row = (cells: string[], tag = "td") =>
    `<tr>${cells.map((c, i) => `<${tag}${i > 0 ? ' class="n"' : ""}>${c}</${tag}>`).join("")}</tr>`;
  const bridge = [
    row([cell(`${measureName(config)} ${config.prior}`), whole(result.priorSales), ""]),
    ...viewEffects.map((e) => row([cell(e.label), signedWhole(e.value), signedPercent(shareOfPrior(e.value, result.priorSales))])),
    row([cell(`${measureName(config)} ${config.current}`), whole(result.currentSales), ""]),
  ];
  const mixOf = (r: Record<string, unknown>) =>
    config.levels.reduce((sum, _, i) => sum + Number(r[`mix_${i + 1}`] ?? 0), 0);
  const [, , change, volume, mix, priceEffect, newConfig, discontinued, noUnits] = moverHeader(config);
  const moverColumns = [
    { label: change, value: (r: Record<string, unknown>) => Number(r.s1) + Number(r.z1) - Number(r.s0) - Number(r.z0) },
    { label: volume, value: (r: Record<string, unknown>) => Number(r.volume) },
    { label: mix, value: mixOf },
    { label: priceEffect, value: (r: Record<string, unknown>) => Number(r.price) },
    { label: newConfig, value: (r: Record<string, unknown>) => Number(r.new_config) },
    { label: discontinued, value: (r: Record<string, unknown>) => Number(r.discontinued) },
    { label: noUnits, value: (r: Record<string, unknown>) => Number(r.no_units) },
  ];
  const movers = input.movers.rows.map((r, i) =>
    row([
      omit ? String(i + 1) : cell(input.movers.columns.map((c) => r[c] ?? "(blank)").join(" / ")),
      ...moverColumns.map((c) => signedWhole(c.value(r))),
    ]),
  );
  const summarySentence = omit
    ? "It holds totals, a written summary and the setup, leaves out the file name, filter values, mover names and chart, and holds no rows."
    : "It holds totals and a written summary, names the file, the setup, its filter values and the largest movers, and holds no rows.";
  const hasStructured = input.setup != null && input.source != null;
  const setupRows = (() => {
    if (!omit) {
      if (hasStructured) {
        return describeSetup(input.setup!, input.config.prior, input.config.current, input.source!).map((line) =>
          row(line.split(": ", 2).map(cell)),
        );
      }
      return input.description.map((line) => row(line.split(": ", 2).map(cell)));
    }
    if (!hasStructured) return [];
    const setup = input.setup!;
    const periodValue = `${input.config.prior} to ${input.config.current} (${setup.periodColumn}${setup.grain === "value" ? "" : ", by " + setup.grain})`;
    return [
      row([cell("Source"), cell("left out")]),
      row([cell("Periods"), cell(periodValue)]),
      row([cell("Units column"), cell(setup.unitsColumn)]),
      row([cell("Sales column"), cell(setup.salesColumn)]),
      ...(setup.grossColumn && !setup.costColumn
        ? [row([cell("Gross sales column"), cell(setup.grossColumn)])]
        : []),
      ...(setup.costColumn ? [row([cell("Cost column"), cell(`${setup.costColumn} (bridge is on margin)`)])] : []),
      ...safeLevels.map((safe, i) => row([cell(`Attribute ${i + 1}`), cell(safe.name)])),
      row([
        cell("New and discontinued"),
        cell(
          setup.newAndDiscontinued === "full"
            ? "full sales, outside volume and mix"
            : "price difference only, units in volume",
        ),
      ]),
      ...setup.filters
        .filter((f) => f.values.length > 0)
        .map(() => row([cell("Filter"), cell("left out")])),
    ];
  })();
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
<p class="muted">Created ${new Date().toISOString().slice(0, 10)} with PVM Bridge. ${summarySentence}</p>
${paragraphs.map((p) => `<p>${markup(p)}</p>`).join("\n")}
${omit ? "" : input.chartUrl ? `<img alt="Waterfall chart of the bridge" src="${input.chartUrl}">` : ""}
<h2>Bridge</h2>
<table>${row(["", "Amount", t.ofPrior], "th")}${bridge.join("")}</table>
<h2>${markup(t.matchedHeading)}</h2>
<table class="plain">${row(["Compared against", "Share", "Configurations"], "th")}${viewCoverage
    .map((c) => row([cell(c.label), percent(c.share), whole(c.cells)]))
    .join("")}</table>
<h2>Largest movers by ${markup(viewMoversLabel)}</h2>
<table class="plain">${row([cell(viewMoversLabel), ...moverColumns.map((c) => c.label)], "th")}${movers.join("")}</table>
<h2>How widely price moved</h2>
<table class="plain">${row(["Change in average price", t.matchedShare, "Price effect"], "th")}${input.priceBands
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
<table class="plain">${setupRows.join("")}</table>
</body></html>`;
}
