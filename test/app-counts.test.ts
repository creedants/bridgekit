import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { Run } from "../src/app/Results.tsx";

// The count sentences live in .tsx components, and this runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already installs. The page database is kept off the wasm bundles the
// browser build imports by URL.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: 'data:text/javascript,export default "stub"', shortCircuit: true };
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

const CHECK = {
  rows: 100,
  priorRows: 50,
  currentRows: 50,
  otherPeriodRows: 0,
  blankPeriodRows: 0,
  blankMeasureRows: 0,
  negativeUnitRows: 0,
  negativeSalesRows: 0,
  zeroUnitSalesRows: 0,
};

function run(check: Partial<typeof CHECK>): Run {
  return {
    check: { ...CHECK, ...check },
    config: { levels: [{ name: "Model", columns: ["model"] }], prior: "2025", current: "2026" },
    result: { coverage: [{ level: 1, share: 1 }] },
  } as unknown as Run;
}

async function warnings(check: Partial<typeof CHECK>): Promise<string[]> {
  const { checkWarnings } = await import("../src/app/Results.tsx");
  return checkWarnings(run(check));
}

test("the blank units or sales sentence is singular for one row", async () => {
  assert.deepEqual(await warnings({ blankMeasureRows: 1 }), [
    "1 row has blank units or sales and counts as zero.",
  ]);
  assert.deepEqual(await warnings({ blankMeasureRows: 2 }), [
    "2 rows have blank units or sales and count as zero.",
  ]);
});

test("the negative units sentence is singular for one row", async () => {
  assert.deepEqual(await warnings({ negativeUnitRows: 1 }), [
    "1 row has negative units (returns or credits). They are netted against sales of the same configuration.",
  ]);
  assert.deepEqual(await warnings({ negativeUnitRows: 3 }), [
    "3 rows have negative units (returns or credits). They are netted against sales of the same configuration.",
  ]);
});

test("the zero units sentence is singular for one row", async () => {
  assert.deepEqual(await warnings({ zeroUnitSalesRows: 1 }), [
    "1 row has sales but zero units (rebates, credits or fees). It is bridged on its own line, \u201cSales with no units\u201d, and kept out of price.",
  ]);
  assert.deepEqual(await warnings({ zeroUnitSalesRows: 2 }), [
    "2 rows have sales but zero units (rebates, credits or fees). They are bridged on their own line, \u201cSales with no units\u201d, and kept out of price.",
  ]);
});

test("the blank period sentence is singular for one row", async () => {
  assert.deepEqual(await warnings({ blankPeriodRows: 1 }), [
    "1 row has a blank period and is ignored.",
  ]);
  assert.deepEqual(await warnings({ blankPeriodRows: 4 }), [
    "4 rows have a blank period and are ignored.",
  ]);
});

test("no count at zero is reported as a row", async () => {
  assert.deepEqual(await warnings({}), []);
});

test("the loaded file line says one row and one column", async () => {
  const { sourceCaption } = await import("../src/app/App.tsx");
  assert.equal(sourceCaption("Sales.csv", 1, 5), "Sales.csv \u00b7 1 row \u00b7 5 columns");
  assert.equal(sourceCaption("Sales.csv", 2, 1), "Sales.csv \u00b7 2 rows \u00b7 1 column");
  assert.equal(sourceCaption("Sales.csv", 0, 0), "Sales.csv \u00b7 0 rows \u00b7 0 columns");
});

test("the account note says one value for one group", async () => {
  const { accountNote } = await import("../src/app/Results.tsx");
  assert.equal(accountNote(1, "North"), "1 North value");
  assert.equal(accountNote(2, "North"), "2 North values");
});

test("the attribute option says one value for one distinct value", async () => {
  const { distinctLabel } = await import("../src/app/SetupPanel.tsx");
  assert.equal(distinctLabel(1), " (1 value)");
  assert.equal(distinctLabel(12), " (12 values)");
  assert.equal(distinctLabel(undefined), "");
});
