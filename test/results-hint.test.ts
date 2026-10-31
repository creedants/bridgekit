import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";

// The Setup check hint lives in src/app/results/SetupCheck.tsx, and this runner cannot load a
// .tsx file by itself, so a load hook transforms it with the esbuild copy the
// build already installs. The page-only modules are replaced the way
// test/data-check-notes.test.ts replaces them.

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
      const { code } = transformSync(source, { loader: "tsx", format: "esm", jsx: "automatic" });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const ONE_ROW = "With one attribute there is nothing to leave out.";
const FIRST = "Across these setups the price effect ranges from";
const RENAMED_LABEL =
  "When leaving out an attribute moves price a lot, the bridge depends on that attribute. Keep it if it describes the product itself; a label that changed between periods can hide a real price change.";
const MIX_SENTENCE = "that attribute separates products whose mix changed";
const LAST = "One that barely moves price and lowers the match rate can be dropped.";
const OLD = "An attribute whose removal moves price a lot is one that carries real mix: keep it.";

async function hint(prices: number[], rowCount: number): Promise<string> {
  const { setupCheckHint } = await import("../src/app/results/SetupCheck.tsx");
  return setupCheckHint(prices, rowCount);
}

test("the Setup check hint keeps its one-attribute sentence", async () => {
  assert.equal(await hint([100], 1), ONE_ROW);
});

test("the Setup check hint names a label that changed between periods", async () => {
  const text = await hint([0, 200], 2);
  assert.ok(text.includes(RENAMED_LABEL), `the hint does not hold the new sentence: ${text}`);
  assert.ok(!text.includes(MIX_SENTENCE), `the hint still says the attribute separates products whose mix changed: ${text}`);
  assert.ok(!text.includes(OLD), `the hint still holds the old sentence: ${text}`);
  assert.ok(!text.includes("keep it."), `the hint still says to keep it: ${text}`);
});

test("the Setup check hint keeps its first and last sentences and its figures", async () => {
  const text = await hint([-1234, 5678], 2);
  assert.ok(text.startsWith(`${FIRST} -1,234 to +5,678.`), `the opening sentence changed: ${text}`);
  assert.ok(text.endsWith(LAST), `the closing sentence changed: ${text}`);
});

test("a partial match says which attributes it matched on", async () => {
  const { matchLabel } = await import("../src/app/results/shared.tsx");
  const levels = [
    { name: "Size", columns: ["size"] },
    { name: "Colour", columns: ["colour"] },
    { name: "Product", columns: ["product"] },
  ];
  const config = { table: "t", periodColumn: "p", prior: "2025", current: "2026", unitsColumn: "u", salesColumn: "s", levels };
  assert.equal(matchLabel(config, 1), "Where the full configuration did not match, matched on Size.");
  assert.equal(matchLabel(config, 2), "Where the full configuration did not match, matched on Size + Colour.");
  assert.equal(matchLabel(config, 3), "Exact configuration");
  assert.equal(matchLabel(config, 0), "No comparable group (overall average)");
  assert.equal(matchLabel({ ...config, newAndDiscontinued: "full" }, 1), "New configuration (shown at full sales)");
});

const CUSTOMER =
  "An attribute that describes the customer, such as region or channel, can also move price a lot. It belongs last in the order, or it can be left out.";

test("the Setup check hint says where an attribute about the customer belongs", async () => {
  const text = await hint([-1234, 5678], 2);
  assert.ok(text.includes(`${RENAMED_LABEL} ${CUSTOMER} ${LAST}`), `the hint does not place the customer advice: ${text}`);
});

test("Movers says no rows match once a search finds nothing", async () => {
  const { emptyNote } = await import("../src/app/results/Movers.tsx");
  assert.equal(emptyNote([], "Z-999", "Z-999"), "No rows match.");
  assert.equal(emptyNote([], "Z-999", "Z-99"), null, "the note shows before the search has finished");
  assert.equal(emptyNote([{ size: "A-100" }], "A-100", "A-100"), null);
  const sizeRequest = JSON.stringify([0, [], "Z-999"]);
  const colourRequest = JSON.stringify([1, [], "Z-999"]);
  assert.equal(emptyNote([], colourRequest, sizeRequest), null, "a new grouping's rows are still on their way");
});

test("the Bridge table explains an unexpected Discontinued sign only when the line is a price difference", async () => {
  const { signNote } = await import("../src/app/Results.tsx");
  const effects = [{ key: "volume", value: 120 }, { key: "discontinued", value: 40 }];
  assert.equal(
    signNote(effects, "difference"),
    "Discontinued configurations is an increase here. The line is not the sales that were lost. It is the difference from the nearest comparable group, which can go either way.",
  );
  assert.equal(signNote(effects, "full"), null, "at full sales the line is the sales themselves");
  assert.equal(signNote([{ key: "discontinued", value: -40 }], "difference"), null);
});
