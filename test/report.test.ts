import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { transformSync } from "esbuild";
import { openDatabase } from "../src/duckdb.ts";
import type { BridgeConfig, Query } from "../src/engine.ts";
import { accountBridge, drill, priceDistribution, runBridge } from "../src/engine.ts";
import { buildReport, moverHeader, terms } from "../src/app/report.ts";
import { signedWhole, whole } from "../src/app/format.ts";
import { roundBridge, shownTotal } from "../src/summary.ts";
import { PERIOD, VIEW, viewSql, type Setup } from "../src/app/setup.ts";

// Results lives in a .tsx file, so the D141 end-to-end test loads it the way
// test/commentary-panel.test.ts does: esbuild transforms it, the browser
// database's `?url` imports are stubbed, and the two components that open that
// database on load are replaced. The Waterfall stub records the footer, which
// is the Summary element whose props the download path receives.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    if (specifier.endsWith("SmallBridges.tsx")) {
      return { url: "data:text/javascript,export const SmallBridges = () => null; export const splitPicture = async () => null", shortCircuit: true };
    }
    if (specifier.endsWith("Waterfall.tsx")) {
      return {
        url: "data:text/javascript,export const Waterfall = (props) => { globalThis.__d141Footer = props.footer; return props.footer ?? null }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(new URL(url), "utf8");
      const { code } = transformSync(source, {
        loader: "tsx",
        format: "esm",
        jsx: "automatic",
        define: { "import.meta.env": "{}" },
      });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const config: BridgeConfig = {
  table: "sales",
  periodColumn: "period",
  prior: "2025",
  current: "2026",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
};

const result = {
  priorSales: 1000,
  currentSales: 900,
  effects: [{ key: "volume", label: "Volume", value: -100 }],
  coverage: [],
  cellsTable: "bridge_cells",
};

const build = (overrides: Partial<Parameters<typeof buildReport>[0]> = {}) =>
  buildReport({
    config,
    result,
    description: ["Source: sample.csv", "Periods: 2025 to 2026 (period, by month)"],
    movers: { label: "Product", rows: [], columns: ["product"] },
    priceBands: [],
    ...overrides,
  });

const moverRow = (name: string) => ({
  product: name,
  s0: 0,
  s1: 0,
  z0: 0,
  z1: 0,
  volume: 0,
  mix_1: 0,
  price: 0,
  new_config: 0,
  discontinued: 0,
  no_units: 0,
});

const distinctMovers = () => [
  { product: "ZX-11", s0: 100, s1: 130, z0: 0, z1: 0, volume: 12, mix_1: 3, price: 15, new_config: 0, discontinued: 0, no_units: 0 },
  { product: "ZX-12", s0: 0, s1: 45, z0: 0, z1: 0, volume: 0, mix_1: 0, price: 0, new_config: 45, discontinued: 0, no_units: 0 },
  { product: "ZX-13", s0: 30, s1: 0, z0: 0, z1: 0, volume: 0, mix_1: 0, price: 0, new_config: 0, discontinued: -30, no_units: 0 },
  { product: "ZX-14", s0: 20, s1: 50, z0: 0, z1: 0, volume: 0, mix_1: 0, price: 0, new_config: 0, discontinued: 0, no_units: 30 },
];

/** Each `<h2` heading's text and the span from its closing tag to the next heading, or to the end of the document, whether or not the opening tag carries attributes. */
const sectionsOf = (html: string): { text: string; start: number; end: number }[] =>
  [...html.matchAll(/<h2(?:\s[^>]*)?>([\s\S]*?)<\/h2>/g)].map((match, index, all) => ({
    text: match[1].trim(),
    start: (match.index ?? 0) + match[0].length,
    end: all[index + 1]?.index ?? html.length,
  }));

/** Whole-heading matchers, one per section the tests read. */
const HEADINGS: Record<string, RegExp> = {
  Bridge: /^Bridge$/,
  Setup: /^Setup$/,
  "Largest movers": /^Largest movers by .+$/,
};

/** A table's rows as ordered cell text, from the one section whose whole heading matches, with tag attributes and the spacing between tags ignored. */
const tableRows = (html: string, heading: string): string[][] => {
  const matcher = HEADINGS[heading];
  assert.ok(matcher, `the test has no heading matcher for ${heading}`);
  const matches = sectionsOf(html).filter((section) => matcher.test(section.text));
  assert.equal(matches.length, 1, `the report has ${matches.length} ${heading} sections, wanted 1`);
  const { start: from, end: to } = matches[0];
  const section = html.slice(from, to);
  const start = section.indexOf("<table");
  const end = section.indexOf("</table>", start);
  assert.ok(start !== -1 && end > start, `the ${heading} section holds no table`);
  return [...section.slice(start, end).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, text]) => text.trim()),
  );
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One KPI's value and note, read from the rendered page. */
const kpiOf = (html: string, label: string) => {
  const match = html.match(
    new RegExp(`<div class="kpi-label">${escaped(label)}</div><div class="kpi-value">([^<]*)</div>(?:<div class="kpi-note">([^<]*)</div>)?`),
  );
  assert.ok(match, `the page has no ${label} KPI`);
  return { value: match[1], note: match[2] ?? "" };
};

/** One bridge row's amount and share, read from the rendered page. */
const screenRowOf = (html: string, label: string) => {
  const match = html.match(
    new RegExp(`<tr><td>${escaped(label)}</td><td class="num">([^<]*)</td><td class="num">([^<]*)</td></tr>`),
  );
  assert.ok(match, `the page bridge table has no ${label} row`);
  return [match[1], match[2]];
};

test("a mover name that begins with a formula character takes a leading apostrophe", () => {
  for (const name of ["=1+1", "+SUM(1)", "-name", "@name"]) {
    const html = build({ movers: { label: "Product", rows: [moverRow(name)], columns: ["product"] } });
    const [, row] = tableRows(html, "Largest movers");
    assert.equal(row[0], `'${name}`, `${name} is not written as text`);
    assert.notEqual(row[0], name, `${name} is still a formula`);
  }
});

test("a setup value that begins with = takes a leading apostrophe", () => {
  const [source] = tableRows(build({ description: ["Source: =1+1.csv"] }), "Setup");
  assert.deepEqual(source, ["Source", "'=1+1.csv"], "setup value is not written as text");
});

test("a negative effect amount stays a formatted number", () => {
  const volume = tableRows(build(), "Bridge").find(([label]) => label === "Volume");
  assert.deepEqual(volume, ["Volume", "-100", "-10.0%"], "negative amount changed or took an apostrophe");
});

const marginConfig: BridgeConfig = { ...config, costColumn: "cost" };

test("sales mover headers keep today literals", () => {
  assert.deepEqual(moverHeader(config), [
    "Prior sales", "Current sales", "Change", "Volume", "Mix", "Price",
    "New config.", "Discontinued", "No units", "Prior price", "Current price", "Price change",
  ]);
});

test("a sales report keeps the sales title and headers", () => {
  const html = build();
  assert.equal(html.includes("<title>Sales bridge: 2025 to 2026</title>"), true, "sales title changed");
  assert.equal(html.includes("<h1>Sales bridge: 2025 to 2026</h1>"), true, "sales heading changed");
  assert.equal(html.includes("% of prior sales"), true, "sales bridge header changed");
  const [moversHeaders] = tableRows(html, "Largest movers");
  assert.ok(moversHeaders.includes("Price"), "sales movers header changed");
  assert.equal(html.includes("Margin bridge"), false, "sales report names margin");
  assert.equal(html.includes("className"), false, "sales report carries a React attribute");
});

test("a margin report is titled Margin bridge with the margin headers", () => {
  const html = buildReport({
    config: marginConfig,
    result,
    description: ["Source: sample.csv", "Cost column: cost (bridge is on margin)"],
    movers: { label: "Product", rows: [], columns: ["product"] },
    priceBands: [],
  });
  assert.equal(html.includes("<title>Margin bridge: 2025 to 2026</title>"), true, "margin title is not Margin bridge");
  assert.equal(html.includes("<h1>Margin bridge: 2025 to 2026</h1>"), true, "margin heading is not Margin bridge");
  assert.equal(html.includes("% of prior margin"), true, "margin bridge header is not % of prior margin");
  assert.equal(html.includes("Price and unit cost"), true, "margin movers header is not Price and unit cost");
  assert.equal(html.includes("Sales bridge"), false, "margin report still says Sales bridge");
  assert.equal(html.includes("Cost column"), true, "margin setup lost the cost line");
  assert.equal(html.includes("cost (bridge is on margin)"), true, "margin setup lost the margin note");
});

test("margin mover headers and terms name the unit-margin figures", () => {
  assert.deepEqual(moverHeader(marginConfig), [
    "Prior margin", "Current margin", "Change", "Volume", "Mix", "Price and unit cost",
    "New config.", "Discontinued", "No units", "Prior unit margin", "Current unit margin", "Unit margin change",
  ]);
  const t = terms(marginConfig);
  assert.equal(t.bridgeTitle, "Margin bridge");
  assert.equal(t.ofPrior, "% of prior margin");
  assert.equal(t.priceEffect, "Price and unit cost");
  assert.equal(t.priorPrice, "Prior unit margin");
  assert.equal(t.currentPrice, "Current unit margin");
  assert.equal(t.priceChange, "Unit margin change");
  assert.equal(t.hintUnits, "Unit margins exclude sales with no units.");
  assert.equal(
    t.hintChange,
    "Unit margin change is the change in average unit margin and includes mix inside the row.",
  );
});

test("sales terms keep today literals", () => {
  const t = terms(config);
  assert.equal(t.bridgeTitle, "Sales bridge");
  assert.equal(t.ofPrior, "% of prior sales");
  assert.equal(t.priceEffect, "Price");
  assert.equal(t.priorPrice, "Prior price");
  assert.equal(t.currentPrice, "Current price");
  assert.equal(t.priceChange, "Price change");
  assert.equal(t.hintUnits, "Prices exclude sales with no units.");
  assert.equal(
    t.hintChange,
    "Price change is the change in average price and includes mix inside the row.",
  );
});

const UNTICKED_SENTENCE =
  "It holds totals and a written summary, names the file, the setup, its filter values and the largest movers, and holds no rows.";
const TICKED_SENTENCE =
  "It holds totals, a written summary and the setup, leaves out the file name, filter values, mover names and chart, and holds no rows.";

const namesFixture = () => ({
  config: { ...config, newAndDiscontinued: "full" as const },
  result,
  description: [
    "Source: q3-sample.csv",
    "Periods: 2025 to 2026 (period, by month)",
    "Units column: units",
    "Sales column: sales",
    "Attribute 1: Product (product)",
    "New and discontinued: full sales, outside volume and mix",
    "Filter: region is one of ZX-90, ZX-91",
  ],
  setup: {
    periodColumn: "period",
    grain: "month" as const,
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
    filters: [{ column: "region", mode: "include" as const, values: ["ZX-90", "ZX-91"] }],
    newAndDiscontinued: "full" as const,
  },
  source: "q3-sample.csv",
  movers: {
    label: "Product",
    columns: ["product"],
    rows: [moverRow("ZX-41"), moverRow("ZX-42")],
  },
  priceBands: [{ label: "Up 0.5% to 2%", cells: 2, sales: 500, share: 0.5, priceEffect: 30 }],
  accounts: {
    column: "Customer",
    groups: [
      { status: "new", count: 2, prior: 0, current: 100, change: 100, top: [{ name: "ZX-77", prior: 0, current: 60, change: 60 }] },
      { status: "lost", count: 1, prior: 50, current: 0, change: -50, top: [{ name: "ZX-78", prior: 50, current: 0, change: -50 }] },
    ],
  },
  chartUrl: "data:image/png;base64,AAA",
});

// This wrapper let the fixture run against the base revision, before
// buildReport accepted omitNames, to record the failing test.
const reportWith = (input: unknown): string =>
  buildReport(input as Parameters<typeof buildReport>[0]);

test("a names-out report leaves mover values, filter values and the file name out", () => {
  const html = reportWith({ ...namesFixture(), omitNames: true });
  for (const absent of ["ZX-41", "ZX-42", "ZX-90", "ZX-91", "ZX-77", "ZX-78", "q3-sample.csv"]) {
    assert.equal(html.includes(absent), false, `${absent} is still in the report`);
  }
  assert.equal(html.includes("<img"), false, "the chart image is still in the report");
  assert.equal(html.includes(TICKED_SENTENCE), true, "the ticked sentence is missing");
  assert.equal(html.includes(UNTICKED_SENTENCE), false, "the unticked sentence is still in the report");
  const [moversHeaders, ...rankRows] = tableRows(html, "Largest movers");
  assert.equal(moversHeaders[0], "product", "the movers header lost the safe column label");
  assert.deepEqual(rankRows.map(([rank]) => rank), ["1", "2"], "the mover ranks are missing");
  assert.equal(html.includes("left out"), true, "the setup stand-in is missing");
  for (const kept of ["Volume", "-100", "Up 0.5% to 2%", "+30", "2025 to 2026", "Change by Customer"]) {
    assert.equal(html.includes(kept), true, `${kept} left the report`);
  }
});

test("an unticked report keeps today output and names", () => {
  const base = reportWith(namesFixture());
  const unticked = reportWith({ ...namesFixture(), omitNames: false });
  assert.equal(unticked, base, "omitNames false changed today output");
  for (const present of ["ZX-41", "ZX-42", "q3-sample.csv", "ZX-90", "<img", UNTICKED_SENTENCE]) {
    assert.equal(unticked.includes(present), true, `${present} is missing from the unticked report`);
  }
});

const BRIDGE_BASELINE = [
  ["", "Amount", "% of prior sales"],
  ["Sales 2025", "1,000", ""],
  ["Volume", "-100", "-10.0%"],
  ["Sales 2026", "900", ""],
];

const MOVERS_BASELINE = [
  ["Product", "Change", "Volume", "Mix", "Price", "New config.", "Discontinued", "No units"],
  ["ZX-11", "+30", "+12", "+3", "+15", "0", "0", "0"],
  ["ZX-12", "+45", "0", "0", "0", "+45", "0", "0"],
  ["ZX-13", "-30", "0", "0", "0", "0", "-30", "0"],
  ["ZX-14", "+30", "0", "0", "0", "0", "0", "+30"],
];

test("an unticked report keeps a fixed baseline whether the flag is absent or false", () => {
  const fixture = {
    movers: { label: "Product", rows: distinctMovers(), columns: ["product"] },
  };
  const states = [
    ["absent", build(fixture)],
    ["false", build({ ...fixture, omitNames: false })],
  ] as const;
  for (const [label, html] of states) {
    assert.equal(html.includes("<title>Sales bridge: 2025 to 2026</title>"), true, `${label}: title changed`);
    assert.equal(html.includes("<h1>Sales bridge: 2025 to 2026</h1>"), true, `${label}: heading changed`);
    assert.deepEqual(tableRows(html, "Bridge"), BRIDGE_BASELINE, `${label}: bridge cells changed`);
    assert.deepEqual(tableRows(html, "Largest movers"), MOVERS_BASELINE, `${label}: movers cells changed`);
    assert.equal(html.includes(UNTICKED_SENTENCE), true, `${label}: unticked sentence changed`);
  }
});

test("a largest movers row rounds once, so its whole parts add up to its whole Change", () => {
  const fractional = {
    product: "ZX-51",
    s0: 100.4,
    s1: 102.4,
    z0: 0,
    z1: 0,
    volume: 0.6,
    mix_1: 0.6,
    price: 0.8,
    new_config: 0,
    discontinued: 0,
    no_units: 0,
  };
  const html = build({ movers: { label: "Product", rows: [fractional], columns: ["product"] } });
  const [, row] = tableRows(html, "Largest movers");
  const shown = row.slice(1).map((text) => Number(text.replace("+", "")));
  const [change, ...parts] = shown;
  assert.equal(change, 2, `the row's whole Change is ${row[1]}, not the rounded difference of 2`);
  assert.equal(
    parts.reduce((sum, part) => sum + part, 0),
    change,
    `the shown parts ${row.slice(2).join(" ")} add up to ${parts.reduce((sum, part) => sum + part, 0)}, not the shown Change ${row[1]}`,
  );
});

test("a section heading with an attribute still bounds its own table", () => {
  const html = build().replace("<h2>Bridge</h2>", '<h2 class="lead">Bridge</h2>');
  assert.deepEqual(tableRows(html, "Bridge"), BRIDGE_BASELINE, "a Bridge heading with an attribute lost its table");
});

test("a section lookup rejects a heading that is missing, duplicated or renamed", () => {
  const html = build();
  assert.equal(tableRows(html, "Bridge").length, BRIDGE_BASELINE.length, "the unedited report does not read the Bridge table");

  const intruder = html.replace("<h2>Bridge</h2>", "<h2>Bridge</h2>\n<h2>Unrelated section</h2>");
  assert.throws(() => tableRows(intruder, "Bridge"), /Bridge section holds no table/, "an unrelated heading between the Bridge heading and its table still reads a table");

  const duplicated = html.replace("<h2>Bridge</h2>", "<h2>Bridge</h2>\n<h2>Bridge</h2>");
  assert.throws(() => tableRows(duplicated, "Bridge"), /2 Bridge sections, wanted 1/, "a second Bridge heading still reads one table");

  const renamed = html.replace("<h2>Bridge</h2>", "<h2>Bridge archive</h2>");
  assert.throws(() => tableRows(renamed, "Bridge"), /0 Bridge sections, wanted 1/, "a Bridge archive heading still reads the Bridge table");

  const wrongMovers = html.replace("<h2>Largest movers by Product</h2>", "<h2>Largest movers Product</h2>");
  assert.throws(() => tableRows(wrongMovers, "Largest movers"), /0 Largest movers sections, wanted 1/, "a movers heading without 'by' still reads the movers table");
});

test("a ticked engine report applies its region filter and leaves custom attribute, filter and separator-free names out", async () => {
  const prodValue = "ZX-PROD-A";
  const acctValue = "ZX-ACCT-OLD";
  const filterValue = "ZX-REGION-IN";
  const fileName = "zx-names.csv";
  const futureLine = "ZX-FUTURE-NAME";
  const attrOne = `${prodValue} assortment`;
  const attrTwo = `${acctValue} segment`;
  const query = await openDatabase();
  await query(`DROP TABLE IF EXISTS data`);
  await query(`CREATE TABLE data (period VARCHAR, product VARCHAR, customer VARCHAR, region VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO data VALUES
    ('2025', '${prodValue}', '${acctValue}', '${filterValue}', 10, 100),
    ('2025', '${prodValue}', 'ZX-ACCT-LOST', '${filterValue}', 10, 300),
    ('2025', 'ZX-PROD-GONE', 'ZX-ACCT-LOST', '${filterValue}', 10, 200),
    ('2026', '${prodValue}', '${acctValue}', '${filterValue}', 25, 350),
    ('2026', '${prodValue}', 'ZX-ACCT-NEW', '${filterValue}', 5, 150),
    ('2026', 'ZX-PROD-NEW', 'ZX-ACCT-NEW', '${filterValue}', 10, 400),
    ('2025', 'ZX-PROD-OUT', 'ZX-ACCT-OUT', 'ZX-REGION-OUT', 40, 900),
    ('2026', 'ZX-PROD-OUT', 'ZX-ACCT-OUT', 'ZX-REGION-OUT', 50, 950)`);
  const setup: Setup = {
    periodColumn: "period",
    grain: "value",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [
      { name: attrOne, columns: ["product"] },
      { name: attrTwo, columns: ["customer"] },
    ],
    filters: [{ column: "region", mode: "include", values: [filterValue] }],
    newAndDiscontinued: "difference",
  };
  const engineConfig: BridgeConfig = {
    table: VIEW,
    periodColumn: PERIOD,
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: setup.levels,
    newAndDiscontinued: "difference",
  };
  await query(`DROP VIEW IF EXISTS ${VIEW}`);
  await query(viewSql(setup));
  const engineResult = await runBridge(query, engineConfig);
  assert.equal(engineResult.priorSales, 600, "the region filter did not hold the prior total to the in-region rows");
  assert.equal(engineResult.currentSales, 900, "the region filter did not hold the current total to the in-region rows");
  const moverRows = await drill(query, engineConfig, { columns: ["product"], limit: 15 });
  const bands = (await priceDistribution(query, engineConfig)).buckets;
  const groups = await accountBridge(query, engineConfig, "customer");
  await query(`DROP VIEW IF EXISTS ${VIEW}`);
  await query(viewSql({ ...setup, filters: [] }));
  const unfiltered = await runBridge(query, engineConfig);
  assert.equal(unfiltered.priorSales, 1500, "the unfiltered prior total is not the whole file");
  assert.equal(unfiltered.currentSales, 1850, "the unfiltered current total is not the whole file");
  assert.notEqual(engineResult.priorSales, unfiltered.priorSales, "the filter changed no total, so the test cannot catch a dropped filter");
  const description = [
    `Source: ${fileName}`,
    "Periods: 2025 to 2026 (period)",
    "Units column: units",
    "Sales column: sales",
    `Attribute 1: ${attrOne} (product)`,
    `Attribute 2: ${attrTwo} (customer)`,
    "New and discontinued: price difference only, units in volume",
    `Filter: region is one of ${filterValue}`,
    futureLine,
  ];
  const input = {
    config: engineConfig,
    result: engineResult,
    chartUrl: "data:image/png;base64,AAA",
    description,
    setup,
    source: fileName,
    movers: { label: attrOne, rows: moverRows, columns: ["product"] },
    priceBands: bands,
    accounts: { column: "customer", groups },
  };
  const ticked = buildReport({ ...input, omitNames: true });
  const lowered = ticked.toLowerCase();
  for (const absent of [prodValue, acctValue, filterValue, fileName, futureLine, attrOne, attrTwo]) {
    assert.equal(lowered.includes(absent.toLowerCase()), false, `${absent} is still in the ticked report`);
  }
  assert.equal(ticked.includes("<img"), false, "the chart image is still in the ticked report");
  assert.equal(ticked.includes(TICKED_SENTENCE), true, "the ticked sentence is missing");
  assert.equal(ticked.includes(whole(engineResult.priorSales)), true, "prior total left the ticked report");
  assert.equal(ticked.includes(whole(engineResult.currentSales)), true, "current total left the ticked report");
  for (const effect of engineResult.effects) {
    assert.equal(ticked.includes(signedWhole(effect.value)), true, `effect ${effect.key} amount left the ticked report`);
  }
  for (const band of bands) {
    assert.equal(ticked.includes(band.label), true, `price band ${band.label} left the ticked report`);
  }
  assert.equal(ticked.includes("left out"), true, "the setup stand-in is missing");
});

test("a ticked report ignores private text after a second separator in recognized setup lines", () => {
  const privateText = "ZX-PRIVATE-ORG";
  const dirtyDescription = [
    "Source: q3-sample.csv",
    `Periods: 2025 to 2026 (period): ${privateText}`,
    `Units column: units: ${privateText}`,
    `Sales column: sales: ${privateText}`,
    `Gross sales column: gross_sales: ${privateText}`,
    `Cost column: cost (bridge is on margin): ${privateText}`,
    `New and discontinued: price difference only, units in volume: ${privateText}`,
    `Filter: region is one of ZX-90: ${privateText}`,
    `Attribute 1: Product (product): ${privateText}`,
  ];
  const grossSetup = {
    periodColumn: "period",
    grain: "value" as const,
    unitsColumn: "units",
    salesColumn: "sales",
    grossColumn: "gross_sales",
    levels: [{ name: "Product", columns: ["product"] }],
    filters: [{ column: "region", mode: "include" as const, values: ["ZX-90"] }],
    newAndDiscontinued: "difference" as const,
  };
  const grossConfig: BridgeConfig = {
    table: "sales",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    grossColumn: "gross_sales",
    levels: [{ name: "Product", columns: ["product"] }],
    newAndDiscontinued: "difference",
  };
  const costSetup = {
    periodColumn: "period",
    grain: "month" as const,
    unitsColumn: "units",
    salesColumn: "sales",
    costColumn: "cost",
    levels: [{ name: "Product", columns: ["product"] }],
    filters: [{ column: "region", mode: "include" as const, values: ["ZX-90"] }],
    newAndDiscontinued: "full" as const,
  };
  const costConfig: BridgeConfig = {
    table: "sales",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    costColumn: "cost",
    levels: [{ name: "Product", columns: ["product"] }],
    newAndDiscontinued: "full",
  };
  for (const [setup, cfg, wanted] of [
    [grossSetup, grossConfig, ["period", "units", "sales", "gross_sales", "2025 to 2026", "price difference only, units in volume"]],
    [costSetup, costConfig, ["period", "units", "sales", "cost (bridge is on margin)", "2025 to 2026", "full sales, outside volume and mix"]],
  ] as const) {
    const ticked = reportWith({
      config: cfg,
      result,
      description: dirtyDescription,
      setup,
      source: "q3-sample.csv",
      movers: { label: "Product", rows: [], columns: ["product"] },
      priceBands: [],
      omitNames: true,
    });
    const lowered = ticked.toLowerCase();
    assert.equal(lowered.includes(privateText.toLowerCase()), false, `${privateText} is still in the ticked report`);
    for (const keep of wanted) {
      assert.equal(lowered.includes(keep.toLowerCase()), true, `${keep} left the ticked report`);
    }
  }
});

/** Each movers data row's seven signed amounts, left to right. */
const moversNumbers = (html: string): number[][] =>
  tableRows(html, "Largest movers")
    .slice(1)
    .map((cells) => cells.slice(1).map((text) => Number(text.replaceAll(",", "").replace("+", ""))));

const assertMoversFoot = (html: string) => {
  const [headers = [], ...dataRows] = tableRows(html, "Largest movers");
  for (const label of ["New config.", "Discontinued", "No units"]) {
    assert.ok(headers.includes(label), `${label} header is missing`);
  }
  assert.ok(dataRows.length > 0, "the movers table has no rows");
  const rows = moversNumbers(html);
  for (const numbers of rows) {
    assert.equal(numbers.length, 7, `a movers row has ${numbers.length} numbers instead of 7`);
    const [change, ...parts] = numbers;
    assert.equal(
      change,
      parts.reduce((a, b) => a + b, 0),
      `a movers row does not foot: change ${change} against parts ${parts.join(", ")}`,
    );
  }
  assert.ok(
    rows.some((numbers) => numbers[4] !== 0 || numbers[5] !== 0 || numbers[6] !== 0),
    "no movers row carries a new, discontinued or no-units amount",
  );
};

const footConfig = (overrides: Partial<BridgeConfig> = {}): BridgeConfig => ({
  table: "t",
  periodColumn: "period",
  prior: "2025",
  current: "2026",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Product", columns: ["product"] }],
  ...overrides,
});

const footReport = async (engineConfig: BridgeConfig, ddl: string, values: string, omitNames = false) => {
  const query = await openDatabase();
  await query(ddl);
  await query(`INSERT INTO t VALUES ${values}`);
  const engineResult = await runBridge(query, engineConfig);
  const moverRows = await drill(query, engineConfig, { columns: ["product"], limit: 15 });
  return buildReport({
    config: engineConfig,
    result: engineResult,
    description: ["Source: zx-foot.csv", "Periods: 2025 to 2026 (period)"],
    movers: { label: "Product", rows: moverRows, columns: ["product"] },
    priceBands: [],
    omitNames,
  });
};

const FOOT_VALUES = `('2025', 'ZX-41', 10, 100),
    ('2026', 'ZX-41', 10, 120),
    ('2026', 'ZX-42', 5, 80),
    ('2025', 'ZX-43', 8, 90),
    ('2025', 'ZX-44', 0, 20),
    ('2026', 'ZX-44', 0, 50)`;
const FOOT_DDL = `CREATE TABLE t (period VARCHAR, product VARCHAR, units INTEGER, sales DOUBLE)`;

test("movers rows foot in difference mode", async () => {
  const html = await footReport(footConfig({ newAndDiscontinued: "difference" }), FOOT_DDL, FOOT_VALUES);
  assertMoversFoot(html);
});

test("movers rows foot in full mode", async () => {
  const html = await footReport(footConfig({ newAndDiscontinued: "full" }), FOOT_DDL, FOOT_VALUES);
  assertMoversFoot(html);
});

test("movers rows foot on a margin bridge", async () => {
  const html = await footReport(
    footConfig({ costColumn: "cost", newAndDiscontinued: "full" }),
    `CREATE TABLE t (period VARCHAR, product VARCHAR, units INTEGER, sales DOUBLE, cost DOUBLE)`,
    `('2025', 'ZX-41', 10, 100, 60),
    ('2026', 'ZX-41', 10, 120, 70),
    ('2026', 'ZX-42', 5, 80, 50),
    ('2025', 'ZX-43', 8, 90, 55),
    ('2025', 'ZX-44', 0, 20, 0),
    ('2026', 'ZX-44', 0, 50, 0)`,
  );
  assertMoversFoot(html);
});

test("a ticked movers table keeps ranks and the footing columns", async () => {
  const html = await footReport(footConfig({ newAndDiscontinued: "full" }), FOOT_DDL, FOOT_VALUES, true);
  assertMoversFoot(html);
  const [, ...rows] = tableRows(html, "Largest movers");
  for (const name of ["ZX-41", "ZX-42", "ZX-43", "ZX-44"]) {
    assert.equal(rows.some(([cell]) => cell === name), false, `${name} is still in the ticked movers table`);
  }
  assert.equal(rows[0]?.[0], "1", "rank 1 is missing from the ticked movers table");
});

const budgetResult = {
  priorSales: 50756.38,
  currentSales: 52142.15,
  effects: [
    { key: "volume", label: "Volume", value: 610.7051 },
    { key: "mix_1", label: "Mix: Product", value: 474.9887 },
    { key: "price_list", label: "Price (list)", value: 413.7554 },
    { key: "new_config", label: "New configurations", value: 443.5355 },
    { key: "no_units", label: "Sales with no units", value: -557.2147 },
  ],
  coverage: [],
  cellsTable: "bridge_cells",
};

test("R141: the report's bridge lines foot to its totals and its summary quotes that change", () => {
  const independent = budgetResult.effects.reduce((sum, effect) => sum + Math.round(effect.value), 0);
  assert.notEqual(
    independent,
    Math.round(budgetResult.currentSales) - Math.round(budgetResult.priorSales),
    "the sample no longer shows the defect: rounding each line on its own misses the shown change",
  );
  const html = build({ result: budgetResult });
  const [, ...rows] = tableRows(html, "Bridge");
  const amounts = rows.map((cells) => Number(cells[1].replaceAll(",", "").replace("+", "")));
  const prior = amounts[0];
  const current = amounts[amounts.length - 1];
  const lines = amounts.slice(1, -1);
  assert.equal(prior + lines.reduce((sum, value) => sum + value, 0), current, `the shown lines do not add up: ${amounts.join(", ")}`);
  const summary = html.match(/<p>([^<]*)<\/p>/)?.[1] ?? "";
  assert.ok(summary.includes(`+${(current - prior).toLocaleString("en-US")}`), `the first sentence does not quote the change: ${summary}`);
});

/**
 * The review's reproduction: prior 100.4, current 100.6, one price effect of
 * 0.2, so the rounded bridge shows 100, 101 and a price line of +1.
 */
const reproRun = () => ({
  check: {
    rows: 2,
    priorRows: 1,
    currentRows: 1,
    otherPeriodRows: 0,
    blankPeriodRows: 0,
    blankMeasureRows: 0,
    negativeUnitRows: 0,
    negativeSalesRows: 0,
    zeroUnitSalesRows: 0,
  },
  config: {
    table: "data",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
  },
  result: {
    priorSales: 100.4,
    currentSales: 100.6,
    effects: [{ key: "price", label: "Price (like-for-like)", value: 0.2 }],
    coverage: [{ level: 1, label: "Exact configuration", cells: 1, sales: 100.6, share: 1 }],
    cellsTable: "bridge_cells",
  },
  tieOut: {
    prior: { period: "2025", inFile: 100.4, afterFilters: 100.4 },
    current: { period: "2026", inFile: 100.6, afterFilters: 100.6 },
  },
  ms: 1,
  textColumns: ["product"],
  periods: ["2025", "2026"],
  description: ["Source: A-100.csv", "Periods: 2025 to 2026 (period)"],
  setup: {
    periodColumn: "period",
    grain: "value" as const,
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [{ name: "Product", columns: ["product"] }],
    filters: [],
  },
  source: "A-100.csv",
  sample: false,
  formulaBlanks: 0,
  amounts: null,
});

/** An empty read, except the price distribution's totals statement, which answers one zero row. */
const reproQuery = (): Promise<Query> =>
  Promise.resolve(((sql: string) =>
    sql.includes("sum(s1) AS sales") && !sql.includes("GROUP BY")
      ? Promise.resolve([{ sales: 0, price_effect: 0 }])
      : Promise.resolve([])) as Query);

test("D141: the price KPI, its table line and the summary print one amount, and the report keeps the exact share", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Results } = await import("../src/app/Results.tsx");
  const { summaryReport } = await import("../src/app/results/Summary.tsx");
  const html = renderToStaticMarkup(React.createElement(Results, { run: reproRun() as never, query: reproQuery }));

  const kpi = (label: string) => kpiOf(html, label);
  const screenRow = (label: string) => screenRowOf(html, label);

  const summarySentence = "Sales rose 0.2%, from 100 in 2025 to 101 in 2026 (+1).";
  assert.deepEqual(kpi("Like-for-like price"), { value: "+1", note: "+0.2%" });
  assert.deepEqual(screenRow("Price (like-for-like)"), ["+1", "+0.2%"]);
  assert.equal(html.includes(summarySentence), true, "the summary does not quote the shown totals and the exact change");
  assert.equal(
    html.includes("Like-for-like price added 1, +0.2% of prior sales."),
    true,
    "the summary's price paragraph does not quote the shown amount and the exact share",
  );

  const footer = (globalThis as unknown as { __d141Footer?: { props: Parameters<typeof summaryReport>[0] } }).__d141Footer;
  assert.ok(footer, "the waterfall did not hand back the summary element");
  const desk = globalThis as unknown as { document?: unknown };
  const before = desk.document;
  desk.document = { querySelector: () => null };
  let report: string;
  try {
    report = await summaryReport(footer.props, null);
  } finally {
    if (before === undefined) delete desk.document;
    else desk.document = before;
  }

  assert.equal(report.includes(summarySentence), true, "the downloaded report does not hold the same summary sentence");
  assert.deepEqual(
    tableRows(report, "Bridge").find(([label]) => label === "Price (like-for-like)"),
    ["Price (like-for-like)", "+1", "+0.2%"],
    "the downloaded report's price line changed amount or share",
  );
  assert.equal(report.includes("Sales rose 1.0%"), false, "the downloaded report still derives the share from rounded totals");

  const amount = (text: string) => Number(text.replaceAll(",", "").replace("+", ""));
  const summaryMatch = html.match(/Like-for-like price added ([0-9][0-9,]*)/);
  assert.ok(summaryMatch, "the summary has no price amount");
  assert.equal(amount(kpi("Like-for-like price").value), 1, "the price KPI is not the shown price line");
  assert.equal(amount(screenRow("Price (like-for-like)")[0]), 1, "the table's price line is not the shown price line");
  assert.equal(amount(summaryMatch[1]), 1, "the summary's price amount is not the shown price line");
});

test("D141: a split price sentence follows the shown price total on the page and in the report", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Results } = await import("../src/app/Results.tsx");
  const { summaryReport } = await import("../src/app/results/Summary.tsx");
  const query = await openDatabase();
  await query(`DROP TABLE IF EXISTS data`);
  await query(`CREATE TABLE data (year VARCHAR, model VARCHAR, units INTEGER, sales DOUBLE, gross DOUBLE)`);
  await query(`INSERT INTO data VALUES ('2025', 'A-100', 2, 100.45, 110), ('2026', 'A-100', 3, 150.58, 165.49)`);
  const engineConfig: BridgeConfig = {
    table: "data",
    periodColumn: "year",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    grossColumn: "gross",
    levels: [{ name: "Model", columns: ["model"] }],
    newAndDiscontinued: "difference",
  };
  const engineResult = await runBridge(query, engineConfig);
  assert.equal(engineResult.priorSales, 100.45, "the repro's prior total changed");
  assert.equal(engineResult.currentSales, 150.58, "the repro's current total changed");
  const shown = roundBridge(engineResult.priorSales, engineResult.currentSales, engineResult.effects.map((e) => e.value));
  const list = engineResult.effects.find((e) => e.key === "price_list");
  const discount = engineResult.effects.find((e) => e.key === "price_discount");
  assert.ok(list && discount, "the gross column did not split price into list price and discounts");
  assert.ok(list.value + discount.value < 0, "the exact price sum is not negative");
  assert.equal(shownTotal(shown, engineResult.effects, "price"), 1, "the shown price lines no longer total +1");

  const run = {
    textColumns: ["model"],
    periods: ["2025", "2026"],
    description: ["Source: A-100.csv", "Periods: 2025 to 2026 (year)"],
    setup: {
      periodColumn: "year",
      grain: "value" as const,
      unitsColumn: "units",
      salesColumn: "sales",
      grossColumn: "gross",
      levels: [{ name: "Model", columns: ["model"] }],
      filters: [],
      newAndDiscontinued: "difference" as const,
    },
    source: "A-100.csv",
    sample: false,
    formulaBlanks: 0,
    amounts: null,
    config: engineConfig,
    result: engineResult,
    check: {
      rows: 2, priorRows: 1, currentRows: 1, otherPeriodRows: 0, blankPeriodRows: 0,
      blankMeasureRows: 0, negativeUnitRows: 0, negativeSalesRows: 0, zeroUnitSalesRows: 0,
    },
    tieOut: {
      prior: { period: "2025", inFile: 100.45, afterFilters: 100.45 },
      current: { period: "2026", inFile: 150.58, afterFilters: 150.58 },
    },
    ms: 1,
  };
  const html = renderToStaticMarkup(React.createElement(Results, { run: run as never, query: () => Promise.resolve(query) }));

  assert.deepEqual(kpiOf(html, "Like-for-like price"), { value: "+1", note: "-0.1%" });
  assert.deepEqual(screenRowOf(html, "List price"), ["+1", "+0.4%"]);
  assert.deepEqual(screenRowOf(html, "Discounts"), ["0", "-0.5%"]);
  const sentence =
    "Like-for-like price added 1, -0.1% of prior sales. Of that, list price changes were +1 and discount changes were 0.";
  assert.equal(html.includes(sentence), true, "the page summary's price word does not follow the shown +1");
  assert.equal(html.includes("Like-for-like price took away 1"), false, "the page summary still says took away 1");

  const footer = (globalThis as unknown as { __d141Footer?: { props: Parameters<typeof summaryReport>[0] } }).__d141Footer;
  assert.ok(footer, "the waterfall did not hand back the summary element");
  const desk = globalThis as unknown as { document?: unknown };
  const before = desk.document;
  desk.document = { querySelector: () => null };
  let report: string;
  try {
    report = await summaryReport(footer.props, []);
  } finally {
    if (before === undefined) delete desk.document;
    else desk.document = before;
  }

  assert.equal(report.includes(sentence), true, "the downloaded report's price word does not follow the shown +1");
  assert.equal(report.includes("Like-for-like price took away 1"), false, "the downloaded report still says took away 1");
  assert.deepEqual(
    tableRows(report, "Bridge").find(([label]) => label === "List price"),
    ["List price", "+1", "+0.4%"],
    "the downloaded report's list price line changed",
  );
  assert.deepEqual(
    tableRows(report, "Bridge").find(([label]) => label === "Discounts"),
    ["Discounts", "0", "-0.5%"],
    "the downloaded report's discount line changed",
  );
});
