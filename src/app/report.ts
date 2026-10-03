import { commentary } from "../commentary.ts";
import type { BridgeConfig, BridgeResult } from "../engine.ts";
import { percent, signedPercent, signedWhole, whole } from "./format.ts";

const escape = (value: unknown) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * A single self-contained HTML file with the chart, bridge, coverage, summary
 * and top movers. It holds totals only, so it can be emailed without the data.
 */
export function buildReport(input: {
  config: BridgeConfig;
  result: BridgeResult;
  chartUrl?: string;
  description: string[];
  movers: { label: string; rows: Record<string, unknown>[]; columns: string[] };
}): string {
  const { config, result } = input;
  const row = (cells: string[], tag = "td") =>
    `<tr>${cells.map((c, i) => `<${tag}${i > 0 ? ' class="n"' : ""}>${c}</${tag}>`).join("")}</tr>`;
  const bridge = [
    row([`Sales ${escape(config.prior)}`, whole(result.priorSales), ""]),
    ...result.effects.map((e) => row([escape(e.label), signedWhole(e.value), signedPercent(e.value / result.priorSales)])),
    row([`Sales ${escape(config.current)}`, whole(result.currentSales), ""]),
  ];
  const mixOf = (r: Record<string, unknown>) =>
    config.levels.reduce((sum, _, i) => sum + Number(r[`mix_${i + 1}`] ?? 0), 0);
  const movers = input.movers.rows.map((r) =>
    row([
      escape(input.movers.columns.map((c) => r[c] ?? "(blank)").join(" / ")),
      signedWhole(Number(r.s1) + Number(r.z1) - Number(r.s0) - Number(r.z0)),
      signedWhole(Number(r.volume)),
      signedWhole(mixOf(r)),
      signedWhole(Number(r.price)),
    ]),
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sales bridge: ${escape(config.prior)} to ${escape(config.current)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#14181f;max-width:900px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
p{margin:0 0 10px}.muted{color:#6b7480;font-size:12px}
table{border-collapse:collapse;width:100%;margin:0 0 8px}td,th{padding:5px 8px;border-bottom:1px solid #e6e9ed;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#4a5360;border-bottom-color:#c4cad3}
.n{text-align:right;font-variant-numeric:tabular-nums}tr:first-child td,tr:last-child td{font-weight:600}
.plain tr td{font-weight:400}img{max-width:100%}
</style></head><body>
<h1>Sales bridge: ${escape(config.prior)} to ${escape(config.current)}</h1>
<p class="muted">Created ${new Date().toISOString().slice(0, 10)} with Bridgekit. Totals only; no row-level data is included.</p>
${commentary(result, config).map((p) => `<p>${escape(p)}</p>`).join("\n")}
${input.chartUrl ? `<img alt="Waterfall chart of the bridge" src="${input.chartUrl}">` : ""}
<h2>Bridge</h2>
<table>${row(["", "Amount", "% of prior sales"], "th")}${bridge.join("")}</table>
<h2>How current sales were matched</h2>
<table class="plain">${row(["Compared against", "Share", "Configurations"], "th")}${result.coverage
    .map((c) => row([escape(c.label), percent(c.share), whole(c.cells)]))
    .join("")}</table>
<h2>Largest movers by ${escape(input.movers.label)}</h2>
<table class="plain">${row([escape(input.movers.label), "Change", "Volume", "Mix", "Price"], "th")}${movers.join("")}</table>
<h2>Setup</h2>
<table class="plain">${input.description.map((line) => row(line.split(": ", 2).map(escape))).join("")}</table>
</body></html>`;
}
