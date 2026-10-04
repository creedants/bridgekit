import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PAY_POLICY, TOOL_POLICY } from "../scripts/policy.ts";

test("public/_headers sends the same policies the pages carry", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const policies = [...headers.matchAll(/^\s+Content-Security-Policy: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(policies, [`${TOOL_POLICY}; frame-ancestors 'none'`, `${PAY_POLICY}; frame-ancestors 'none'`]);
});
