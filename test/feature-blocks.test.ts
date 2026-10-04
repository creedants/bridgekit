import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFeatureBlocks } from "../scripts/feature-blocks.ts";

const page = `<ul>
  <!-- feature:ai -->
  <li>AI</li>
  <!-- /feature:ai -->
  <li>Always</li>
</ul>
<p>No cookies<!-- feature:!pro -->, no accounts<!-- /feature:!pro --><!-- feature:pro --> unless you sign in<!-- /feature:pro -->.</p>
`;

test("blocks are kept or dropped with their marker lines; inline blocks keep the text around them", () => {
  assert.equal(
    applyFeatureBlocks(page, {}),
    "<ul>\n  <li>Always</li>\n</ul>\n<p>No cookies, no accounts.</p>\n",
  );
  assert.equal(
    applyFeatureBlocks(page, { ai: true, pro: true }),
    "<ul>\n  <li>AI</li>\n  <li>Always</li>\n</ul>\n<p>No cookies unless you sign in.</p>\n",
  );
});
