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

const freePage = `<ul>
  <!-- feature:!workspaces -->
  <li>The site sets no cookies and has no accounts.</li>
  <!-- /feature:!workspaces -->
  <!-- feature:workspaces -->
  <li>The site sets no cookies unless you sign in to a Pro workspace. Signing in sets one cookie that keeps you signed in; signing out removes it.</li>
  <!-- /feature:workspaces -->
  <!-- feature:ai -->
  <li>Optional AI commentary</li>
  <!-- /feature:ai -->
</ul>
<p><!-- feature:!counts -->No analytics.<!-- /feature:!counts --><!-- feature:counts -->No tracking scripts.<!-- /feature:counts --></p>
`;

test("a counts-only build keeps the no-account and no-tracking sentences", () => {
  assert.equal(
    applyFeatureBlocks(freePage, { counts: true, workspaces: false, ai: false }),
    "<ul>\n  <li>The site sets no cookies and has no accounts.</li>\n</ul>\n<p>No tracking scripts.</p>\n",
  );
});
