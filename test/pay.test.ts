import assert from "node:assert/strict";
import { test } from "node:test";
import { decideCheckout } from "../src/pay/pay.ts";

const workspace = "There is no checkout to open. Start from the Workspace panel in the tool.";
const unavailable = "Checkout is not available right now. Try again later.";
const clientToken = "test_token";

test("a link with no transaction says there is no checkout to open", () => {
  for (const search of ["", "?other=1"]) {
    assert.deepEqual(decideCheckout({ search, token: undefined }), ["show", workspace, null]);
    assert.deepEqual(decideCheckout({ search, token: "" }), ["show", workspace, null]);
    assert.deepEqual(decideCheckout({ search, token: clientToken }), ["show", workspace, null]);
  }
});

test("a transaction link with no client token says checkout is unavailable", () => {
  for (const search of ["?_ptxn=txn_fake", "?_ptxn=", "?_ptxn"]) {
    assert.deepEqual(decideCheckout({ search, token: undefined }), ["show", unavailable, "VITE_PADDLE_CLIENT_TOKEN"]);
    assert.deepEqual(decideCheckout({ search, token: "" }), ["show", unavailable, "VITE_PADDLE_CLIENT_TOKEN"]);
  }
});

test("a transaction link with a client token opens checkout", () => {
  for (const search of ["?_ptxn=txn_fake", "?other=1&_ptxn=txn_fake", "?_ptxn"]) {
    assert.deepEqual(decideCheckout({ search, token: clientToken }), ["open", clientToken]);
  }
});
