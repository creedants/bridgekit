import assert from "node:assert/strict";
import { test } from "node:test";
import { commentaryPanel, commentaryPro, type CommentaryState } from "../src/app/useConfig.ts";
import type { Config } from "../src/app/account.ts";

// One row per state the panel can be in, decided without a browser.

const state = (over: Partial<CommentaryState> = {}): CommentaryState => ({
  config: null,
  user: undefined,
  workspaces: null,
  plans: {},
  ...over,
});

const keyed: Config = { providers: [], commentary: true, billing: false };
const nokey: Config = { providers: [], commentary: false, billing: false };
const freePlan = { pro: false, status: null, seats: 1, currentPeriodEnd: null };
const proPlan = { pro: true, status: "active", seats: 1, currentPeriodEnd: null };

test("the flag off keeps the panel out whatever the deployment offers", () => {
  assert.equal(commentaryPanel(false, null, "unknown"), "hidden");
  assert.equal(commentaryPanel(false, nokey, "signed-out"), "hidden");
  assert.equal(commentaryPanel(false, keyed, "pro"), "hidden");
});

test("no key in the deployment keeps the panel out", () => {
  assert.equal(commentaryPanel(true, null, "unknown"), "hidden");
  assert.equal(commentaryPanel(true, null, "signed-out"), "hidden");
  assert.equal(commentaryPanel(true, null, "free"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "unknown"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "signed-out"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "free"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "pro"), "hidden");
});

test("an answer still loading or failed keeps the panel out", () => {
  assert.equal(commentaryPanel(true, keyed, "unknown"), "hidden");
});

test("a signed-out visitor sees no panel", () => {
  assert.equal(commentaryPanel(true, keyed, "signed-out"), "hidden");
});

test("a signed-in person without Pro sees the hint and no button", () => {
  assert.equal(commentaryPanel(true, keyed, "free"), "hint");
});

test("a signed-in person with Pro sees the button", () => {
  assert.equal(commentaryPanel(true, keyed, "pro"), "button");
});

test("a Pro plan on any workspace the page has read is enough", () => {
  const one = state({ config: keyed, user: { id: "u", email: "a@b.c", name: "A" }, workspaces: [{ id: "w1", name: "W" }] });
  assert.equal(commentaryPro(one), "unknown");
  assert.equal(commentaryPro({ ...one, plans: { w1: freePlan } }), "free");
  assert.equal(commentaryPro({ ...one, plans: { w1: proPlan } }), "pro");

  const two = state({ ...one, workspaces: [{ id: "w1", name: "A" }, { id: "w2", name: "B" }] });
  assert.equal(commentaryPro(two), "unknown");
  assert.equal(commentaryPro({ ...two, plans: { w1: freePlan } }), "unknown");
  assert.equal(commentaryPro({ ...two, plans: { w1: freePlan, w2: freePlan } }), "free");
  assert.equal(commentaryPro({ ...two, plans: { w1: freePlan, w2: proPlan } }), "pro");
});

test("a signed-in person with no workspace has no Pro", () => {
  assert.equal(commentaryPro(state({ user: { id: "u", email: "a@b.c", name: "A" }, workspaces: [] })), "free");
});

test("an unread session or workspace list leaves the answer unknown", () => {
  assert.equal(commentaryPro(state()), "unknown");
  assert.equal(commentaryPro(state({ user: undefined })), "unknown");
  assert.equal(commentaryPro(state({ user: null })), "signed-out");
  assert.equal(commentaryPro(state({ user: { id: "u", email: "a@b.c", name: "A" } })), "unknown");
});
