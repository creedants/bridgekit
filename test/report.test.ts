import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import type { BridgeConfig } from "../src/engine.ts";
import { accountBridge, drill, priceDistribution, runBridge } from "../src/engine.ts";
import { buildReport, moverHeader, terms } from "../src/app/report.ts";
import { signedWhole, whole } from "../src/app/format.ts";

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
});

test("a mover name that begins with a formula character takes a leading apostrophe", () => {
  for (const name of ["=1+1", "+SUM(1)", "-name", "@name"]) {
    const html = build({ movers: { label: "Product", rows: [moverRow(name)], columns: ["product"] } });
    assert.equal(html.includes(`<td>'${name}</td>`), true, `${name} is not written as text`);
    assert.equal(html.includes(`<td>${name}</td>`), false, `${name} is still a formula`);
  }
});

test("a setup value that begins with = takes a leading apostrophe", () => {
  const html = build({ description: ["Source: =1+1.csv"] });
  assert.equal(html.includes(`<td class="n">'=1+1.csv</td>`), true, "setup value is not written as text");
  assert.equal(html.includes(`<td class="n">=1+1.csv</td>`), false, "setup value is still a formula");
});

test("a negative effect amount stays a formatted number", () => {
  const html = build();
  assert.equal(html.includes(`<td class="n">-100</td>`), true, "negative amount changed");
  assert.equal(html.includes(`<td class="n">'-100</td>`), false, "negative amount took an apostrophe");
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
  assert.equal(html.includes(`<th class="n">Price</th>`), true, "sales movers header changed");
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
  assert.equal(html.includes(">product</th>"), true, "the movers header lost the safe column label");
  assert.equal(html.includes("<td>1</td>"), true, "rank 1 is missing");
  assert.equal(html.includes("<td>2</td>"), true, "rank 2 is missing");
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

test("a ticked engine report leaves custom attribute, filter and separator-free names out", async () => {
  const prodValue = "ZX-PROD-A";
  const acctValue = "ZX-ACCT-OLD";
  const filterValue = "ZX-REGION-IN";
  const fileName = "zx-names.csv";
  const futureLine = "ZX-FUTURE-NAME";
  const attrOne = `${prodValue} assortment`;
  const attrTwo = `${acctValue} segment`;
  const query = await openDatabase();
  await query(`CREATE TABLE t (period VARCHAR, product VARCHAR, customer VARCHAR, region VARCHAR, units INTEGER, sales DOUBLE)`);
  await query(`INSERT INTO t VALUES
    ('2025', '${prodValue}', '${acctValue}', '${filterValue}', 10, 100),
    ('2025', '${prodValue}', 'ZX-ACCT-LOST', '${filterValue}', 10, 300),
    ('2025', 'ZX-PROD-GONE', 'ZX-ACCT-LOST', '${filterValue}', 10, 200),
    ('2026', '${prodValue}', '${acctValue}', '${filterValue}', 25, 350),
    ('2026', '${prodValue}', 'ZX-ACCT-NEW', '${filterValue}', 5, 150),
    ('2026', 'ZX-PROD-NEW', 'ZX-ACCT-NEW', '${filterValue}', 10, 400)`);
  const engineConfig: BridgeConfig = {
    table: "t",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [
      { name: attrOne, columns: ["product"] },
      { name: attrTwo, columns: ["customer"] },
    ],
  };
  const engineResult = await runBridge(query, engineConfig);
  const moverRows = await drill(query, engineConfig, { columns: ["product"], limit: 15 });
  const bands = (await priceDistribution(query, engineConfig)).buckets;
  const groups = await accountBridge(query, engineConfig, "customer");
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
    setup: {
      periodColumn: "period",
      grain: "value" as const,
      unitsColumn: "units",
      salesColumn: "sales",
      levels: [
        { name: attrOne, columns: ["product"] },
        { name: attrTwo, columns: ["customer"] },
      ],
      filters: [{ column: "region", mode: "include" as const, values: [filterValue] }],
      newAndDiscontinued: "difference" as const,
    },
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
