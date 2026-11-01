import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { matchedPercent, signedRoundedCompact, signedWhole } from "../src/app/format.ts";

// The results page and its panels live in .tsx files, so a load hook transforms
// them the way test/results-hint.test.ts does. The browser database's `?url`
// imports and the panel that opens it on load are replaced, and
// `import.meta.env` reads as an empty object for App.tsx's optional workspace.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
    }
    if (specifier.endsWith("SmallBridges.tsx")) {
      return {
        url: "data:text/javascript,export const SmallBridges = () => null; export const splitPicture = async () => null",
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

test("the Accounts tab guesses the account column or asks for one", async () => {
  const { accountGuess } = await import("../src/app/results/Accounts.tsx");
  assert.equal(accountGuess(["StockCode", "Country", "Customer name"]), "Customer name");
  assert.equal(accountGuess(["Sold to", "StockCode"]), "Sold to");
  assert.equal(accountGuess(["StockCode", "Country"]), "");
});

test("a matched share never reads 100.0% while it is short of all sales", () => {
  assert.equal(matchedPercent(0.99996), "99.9%");
  assert.equal(matchedPercent(1), "100.0%");
  assert.equal(matchedPercent(0.95), "95.0%");
  assert.equal(matchedPercent(1 - 1e-12), "99.9%");
  assert.equal(matchedPercent(0.9999999999, true), "100.0%");
});

test("a bar label keeps whole units below a thousand and a short unit above", () => {
  assert.equal(signedRoundedCompact(-284.1), signedWhole(-284.1));
  assert.equal(signedRoundedCompact(-284.1), "-284");
  assert.equal(signedRoundedCompact(1_500_000), "+1.5M");
});

test("the results page explains its terms, its chart labels and the price counts", async () => {
  const { resultTerms, CHART_TERMS } = await import("../src/app/Results.tsx");
  const { terms } = await import("../src/app/report.ts");
  const { priceNote } = await import("../src/app/results/PriceChanges.tsx");
  const config = {
    table: "t",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [],
  };
  const sales = resultTerms(terms(config), config);
  assert.ok(sales.includes("Volume: The change in units at the overall prior average price."), sales);
  assert.ok(
    sales.includes(
      "Mix: The change in units valued at how much more expensive or cheaper the group is than the group above it.",
    ),
    sales,
  );
  const margin = resultTerms(terms({ ...config, costColumn: "cost" }), { ...config, costColumn: "cost" });
  assert.ok(margin.includes("Volume: The change in units at the overall prior average unit margin."), margin);
  assert.ok(margin.includes("how much higher or lower the group's unit margin is"), margin);
  assert.ok(CHART_TERMS.includes("K, M and B"), CHART_TERMS);
  assert.ok(CHART_TERMS.includes("Discont. configs"), CHART_TERMS);
  const SALES_NOTE =
    "Counts only exactly matched configurations with positive units in both periods and positive prior sales, after each configuration's rows with units are added together. The Bridge price step can include other configurations.";
  const MARGIN_SENTENCE = "On a margin bridge, compare the combined Price and Unit cost steps.";
  assert.equal(priceNote("sales"), SALES_NOTE, "the sales note changed");
  assert.equal(priceNote("margin"), `${SALES_NOTE.replace("prior sales", "prior margin")} ${MARGIN_SENTENCE}`);
  assert.equal(priceNote("sales").includes(MARGIN_SENTENCE), false, "the sales note names the margin steps");
});

test("a margin bridge places configurations by unit margin and a sales bridge by price", async () => {
  const { placementNote } = await import("../src/app/results/PriceChanges.tsx");
  const price =
    "Each configuration counted here is placed by how much its average price moved between the two periods.";
  const margin =
    "Each configuration counted here is placed by how much its average unit margin moved between the two periods.";
  assert.equal(placementNote("sales"), price, "the sales bridge does not place configurations by average price");
  assert.equal(placementNote("margin"), margin, "the margin bridge does not place configurations by average unit margin");
  assert.equal(placementNote("sales").includes("unit margin"), false, "the sales bridge names unit margin");
  assert.equal(placementNote("margin").includes("average price"), false, "the margin bridge names average price");
});

test("Full sales says Volume and Mix cover continuing configurations only", async () => {
  const { resultTerms } = await import("../src/app/Results.tsx");
  const { terms } = await import("../src/app/report.ts");
  const sentence =
    "With Full sales selected, Volume and Mix cover continuing configurations only, using prior averages from those configurations.";
  const config = {
    table: "t",
    periodColumn: "period",
    prior: "2025",
    current: "2026",
    unitsColumn: "units",
    salesColumn: "sales",
    levels: [],
  };
  for (const withCost of [false, true]) {
    const base = withCost ? { ...config, costColumn: "cost" } : config;
    assert.ok(resultTerms(terms(base), { ...base, newAndDiscontinued: "full" }).includes(sentence), "full sales has no sentence");
    assert.equal(
      resultTerms(terms(base), { ...base, newAndDiscontinued: "difference" }).includes(sentence),
      false,
      "difference mode carries the full sales sentence",
    );
    assert.equal(resultTerms(terms(base), base).includes(sentence), false, "an unset setting carries the full sales sentence");
  }
});

test("the top bar keeps the export label and a reading label wins", async () => {
  const { EXPORTING, statusLine } = await import("../src/app/App.tsx");
  assert.equal(EXPORTING, "Preparing Excel file…");
  assert.equal(statusLine(null, [EXPORTING]), "Preparing Excel file…");
  assert.equal(statusLine("Reading ZX-file.csv…", [EXPORTING]), "Reading ZX-file.csv…");
  assert.equal(statusLine(null, []), "");
});

test("the Accounts tab asks for its column before it shows any figures", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Accounts } = await import("../src/app/results/Accounts.tsx");
  const run = {
    textColumns: ["StockCode"],
    config: {
      table: "t",
      periodColumn: "period",
      prior: "2025",
      current: "2026",
      unitsColumn: "units",
      salesColumn: "sales",
      levels: [],
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(Accounts, { run: run as never, query: null, column: "", onColumn: () => {} }),
  );
  assert.ok(html.includes("Account column"), html);
  assert.match(html, /<option value=""[^>]*>Choose a column<\/option>/, html);
  assert.ok(html.includes("Choose the account column to see these groups."), html);
  assert.equal(html.includes("kpi-value"), false, html);
});
