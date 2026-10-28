import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyFeatureBlocks } from "../scripts/feature-blocks.ts";
import { PAY_POLICY, TOOL_POLICY } from "../scripts/policy.ts";

test("public/_headers sends the same policies the pages carry", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const policies = [...headers.matchAll(/^\s+Content-Security-Policy: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(policies, [`${TOOL_POLICY}; frame-ancestors 'none'`, `${PAY_POLICY}; frame-ancestors 'none'`]);
});

const VARIANTS: Array<{ name: string; enabled: Record<string, boolean> }> = [
  { name: "free", enabled: {} },
  { name: "free with page counts", enabled: { counts: true } },
  { name: "full", enabled: { ai: true, counts: true, workspaces: true } },
];

function builtTextOf(file: string, enabled: Record<string, boolean>): string {
  const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  return applyFeatureBlocks(html, enabled)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const PRIVACY_SENTENCES = [
  "Last changed 28 October 2026.",
  "The tool can remember your column choices in your browser if you turn that on.",
  "They live in the tab’s memory and are gone",
  "Your setup is remembered only if you turn it on. If you tick Remember this setup in this browser, then after you calculate a bridge your column choices, attribute order and options are saved in your browser’s local storage, so the next file with the same columns opens ready. This includes your column names and attribute names, but no values from your data: filter selections are not saved for that reason.",
  "Unticking it deletes everything the tool saved.",
  "Cloudflare, which hosts the site, can see ordinary web server logs",
];

const PRIVACY_REPLACED = [
  "The tool remembers your column choices in your browser, and you can turn that off.",
  "memory and is gone",
  "Your setup is remembered unless you turn it off.",
  "Unticking Remember this setup in this browser deletes",
  "The tool then keeps one setting",
  "The company hosting the site",
  "Planned paid features such as saved workspaces",
];

const PRIVACY_FREE_ONLY =
  "Planned Pro features would use a server: saved workspaces would store your setup there, and AI commentary would send the bridge totals, never your file or its rows, to Anthropic’s Claude to write the text. This page will be updated before either is released, and uploading data will never be required to use the free tool.";

const TERMS_SENTENCES = [
  "Last changed 28 October 2026.",
  "Do not try to break or overload the site, and do not use it for anything unlawful.",
];

const TERMS_REPLACED = ["Last changed 27 October 2026.", "get around the limits of the site"];

test("every build of the privacy and terms pages carries the current wording", () => {
  for (const variant of VARIANTS) {
    const privacy = builtTextOf("privacy.html", variant.enabled);
    for (const sentence of PRIVACY_SENTENCES) {
      assert.ok(
        privacy.includes(sentence),
        `the ${variant.name} build of privacy.html does not say "${sentence}": restore that sentence as plain text`,
      );
    }
    for (const old of PRIVACY_REPLACED) {
      assert.ok(
        !privacy.includes(old),
        `the ${variant.name} build of privacy.html still says "${old}": restore the sentence that replaced it`,
      );
    }
    assert.equal(
      privacy.includes(PRIVACY_FREE_ONLY),
      !variant.enabled.workspaces,
      variant.enabled.workspaces
        ? `the ${variant.name} build of privacy.html says the planned Pro features are not released: keep that paragraph in the feature:!workspaces block`
        : `the ${variant.name} build of privacy.html does not say "${PRIVACY_FREE_ONLY}": restore it in the feature:!workspaces block of If this changes`,
    );

    const terms = builtTextOf("terms.html", variant.enabled);
    for (const sentence of TERMS_SENTENCES) {
      assert.ok(
        terms.includes(sentence),
        `the ${variant.name} build of terms.html does not say "${sentence}": restore that sentence as plain text`,
      );
    }
    for (const old of TERMS_REPLACED) {
      assert.ok(
        !terms.includes(old),
        `the ${variant.name} build of terms.html still says "${old}": restore the sentence that replaced it`,
      );
    }
  }
});
