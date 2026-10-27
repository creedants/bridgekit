import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/duckdb.ts";
import type { BridgeConfig } from "../src/engine.ts";
import { accountBridge, drill, priceDistribution, runBridge } from "../src/engine.ts";
import { buildReport, moverHeader, terms } from "../src/app/report.ts";
import { signedWhole, whole } from "../src/app/format.ts";
import { PERIOD, VIEW, viewSql, type Setup } from "../src/app/setup.ts";

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
    assert.equal(
      html.includes(
        `<table><tr><th></th><th class="n">Amount</th><th class="n">% of prior sales</th></tr><tr><td>Sales 2025</td><td class="n">1,000</td><td class="n"></td></tr><tr><td>Volume</td><td class="n">-100</td><td class="n">-10.0%</td></tr><tr><td>Sales 2026</td><td class="n">900</td><td class="n"></td></tr></table>`,
      ),
      true,
      `${label}: bridge table changed`,
    );
    assert.equal(
      html.includes(
        `<tr><th>Product</th><th class="n">Change</th><th class="n">Volume</th><th class="n">Mix</th><th class="n">Price</th><th class="n">New config.</th><th class="n">Discontinued</th><th class="n">No units</th></tr>`,
      ),
      true,
      `${label}: movers header changed`,
    );
    for (const row of [
      `<tr><td>ZX-11</td><td class="n">+30</td><td class="n">+12</td><td class="n">+3</td><td class="n">+15</td><td class="n">0</td><td class="n">0</td><td class="n">0</td></tr>`,
      `<tr><td>ZX-12</td><td class="n">+45</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">+45</td><td class="n">0</td><td class="n">0</td></tr>`,
      `<tr><td>ZX-13</td><td class="n">-30</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">-30</td><td class="n">0</td></tr>`,
      `<tr><td>ZX-14</td><td class="n">+30</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">+30</td></tr>`,
    ]) {
      assert.equal(html.includes(row), true, `${label}: movers row changed: ${row}`);
    }
    assert.equal(html.includes(UNTICKED_SENTENCE), true, `${label}: unticked sentence changed`);
  }
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

const moversSection = (html: string): string => {
  const start = html.indexOf("Largest movers");
  const tableStart = html.indexOf("<table", start);
  const tableEnd = html.indexOf("</table>", tableStart);
  return html.slice(tableStart, tableEnd);
};

test("movers rows write each amount under its own header", () => {
  const html = build({ movers: { label: "Product", rows: distinctMovers(), columns: ["product"] } });
  const section = moversSection(html);
  assert.equal(
    section.includes(
      `<tr><th>Product</th><th class="n">Change</th><th class="n">Volume</th><th class="n">Mix</th><th class="n">Price</th><th class="n">New config.</th><th class="n">Discontinued</th><th class="n">No units</th></tr>`,
    ),
    true,
    "the movers header labels or their order changed",
  );
  for (const row of [
    `<tr><td>ZX-11</td><td class="n">+30</td><td class="n">+12</td><td class="n">+3</td><td class="n">+15</td><td class="n">0</td><td class="n">0</td><td class="n">0</td></tr>`,
    `<tr><td>ZX-12</td><td class="n">+45</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">+45</td><td class="n">0</td><td class="n">0</td></tr>`,
    `<tr><td>ZX-13</td><td class="n">-30</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">-30</td><td class="n">0</td></tr>`,
    `<tr><td>ZX-14</td><td class="n">+30</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">0</td><td class="n">+30</td></tr>`,
  ]) {
    assert.equal(section.includes(row), true, `a movers row lost its per-label values: ${row}`);
  }
});

const moversNumbers = (html: string): number[][] => {
  const section = moversSection(html);
  const rows = [...section.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) => m[1]);
  return rows
    .filter((row) => row.includes("<td"))
    .map((row) =>
      [...row.matchAll(/<td class="n">([^<]*)<\/td>/g)].map((m) =>
        Number(m[1].replaceAll(",", "").replace("+", ""))
      )
    );
};

const assertMoversFoot = (html: string) => {
  for (const label of ["New config.", "Discontinued", "No units"]) {
    assert.equal(html.includes(`<th class="n">${label}</th>`), true, `${label} header is missing`);
  }
  const rows = moversNumbers(html);
  assert.ok(rows.length > 0, "the movers table has no rows");
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
  for (const name of ["ZX-41", "ZX-42", "ZX-43", "ZX-44"]) {
    assert.equal(moversSection(html).includes(name), false, `${name} is still in the ticked movers table`);
  }
  assert.equal(moversSection(html).includes("<td>1</td>"), true, "rank 1 is missing from the ticked movers table");
});
