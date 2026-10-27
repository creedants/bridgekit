import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";

// The Setup check hint lives in Results.tsx, and this runner cannot load a
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
        url: "data:text/javascript,export const SmallBridges = () => null",
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
  "When leaving out an attribute moves price a lot, that attribute separates products whose mix changed. Keep it if it describes the product itself; a label that changed between periods can hide a real price change.";
const LAST = "One that barely moves price and lowers the match rate can be dropped.";
const OLD = "An attribute whose removal moves price a lot is one that carries real mix: keep it.";

async function hint(prices: number[], rowCount: number): Promise<string> {
  const { setupCheckHint } = await import("../src/app/Results.tsx");
  return setupCheckHint(prices, rowCount);
}

test("the Setup check hint keeps its one-attribute sentence", async () => {
  assert.equal(await hint([100], 1), ONE_ROW);
});

test("the Setup check hint names a label that changed between periods", async () => {
  const text = await hint([0, 200], 2);
  assert.ok(text.includes(RENAMED_LABEL), `the hint does not hold the new sentence: ${text}`);
  assert.ok(!text.includes(OLD), `the hint still holds the old sentence: ${text}`);
  assert.ok(!text.includes("keep it."), `the hint still says to keep it: ${text}`);
});

test("the Setup check hint keeps its first and last sentences and its figures", async () => {
  const text = await hint([-1234, 5678], 2);
  assert.ok(text.startsWith(`${FIRST} -1,234 to +5,678.`), `the opening sentence changed: ${text}`);
  assert.ok(text.endsWith(LAST), `the closing sentence changed: ${text}`);
});
