import assert from "node:assert/strict";
import { test } from "node:test";
import { countPageView, pageView } from "../server/counts.ts";
import type { SubscriptionChange } from "../server/paddle.ts";
import {
  applySubscription,
  deleteSaved,
  deleteSoleWorkspaces,
  freeSeats,
  listBridges,
  listSetups,
  plan,
  saveBridge,
  saveSetup,
  userHasPro,
  workspaceCount,
  WorkspaceError,
} from "../server/workspace.ts";
import { testDatabase } from "./support/d1.ts";

const now = "2026-10-04T00:00:00.000Z";

async function seeded() {
  const db = testDatabase();
  for (const [id, email] of [["u1", "owner@example.com"], ["u2", "colleague@example.com"], ["u3", "outsider@example.com"]]) {
    await db.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, '', ?, 1, ?, ?)`).bind(id, email, now, now).run();
  }
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w1', 'Pricing', 'pricing', ?)`).bind(now).run();
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m1', 'w1', 'u1', 'owner', ?), ('m2', 'w1', 'u2', 'member', ?)`).bind(now, now).run();
  return db;
}

const subscription = (over: Partial<SubscriptionChange> = {}): SubscriptionChange => ({
  subscriptionId: "sub_1", customerId: "ctm_1", workspaceId: "w1", status: "active", priceId: "pri_1",
  seats: 3, currentPeriodEnd: "2027-10-04T00:00:00Z", eventId: "evt_1", occurredAt: "2026-10-04T01:00:00.000000Z", ...over,
});

const columns = ["year", "units", "sales", "design"];
const setup = { periodColumn: "year", grain: "value", unitsColumn: "units", salesColumn: "sales", levels: [{ name: "Design", columns: ["design"] }], filters: [] };
const summary = {
  measure: "Sales", prior: "2025", current: "2026", priorTotal: 100, currentTotal: 110,
  effects: [{ label: "Volume", value: 10 }], attributes: ["Design"], exactMatchShare: 0.9, newAndDiscontinued: "difference",
};

const rejects = (promise: Promise<unknown>, status: number) =>
  assert.rejects(promise, (e) => e instanceof WorkspaceError && e.status === status);

test("saving needs Pro; a signed Paddle event grants it with its seat count", async () => {
  const db = await seeded();
  assert.deepEqual(await plan(db, "w1"), { pro: false, status: null, seats: 1, currentPeriodEnd: null });
  await rejects(saveSetup(db, "u1", "w1", { name: "Default", columns, setup }), 402);
  assert.equal(await applySubscription(db, subscription()), "applied");
  assert.deepEqual(await plan(db, "w1", new Date(now)), { pro: true, status: "active", seats: 3, currentPeriodEnd: "2027-10-04T00:00:00Z" });
  assert.equal(await userHasPro(db, "u2", new Date(now)), true);
  assert.equal(await userHasPro(db, "u3", new Date(now)), false);
});

test("an older Paddle event does not overwrite a newer one, and unknown workspaces are skipped", async () => {
  const db = await seeded();
  await applySubscription(db, subscription());
  assert.equal(await applySubscription(db, subscription({ status: "canceled", occurredAt: "2026-10-03T00:00:00.000000Z" })), "stale");
  assert.equal((await plan(db, "w1", new Date(now))).status, "active");
  assert.equal(await applySubscription(db, subscription({ workspaceId: "nope" })), "unknown-workspace");
});

test("members share saved setups and bridges; outsiders see nothing", async () => {
  const db = await seeded();
  await applySubscription(db, subscription());
  const { id } = await saveSetup(db, "u1", "w1", { name: "Default", columns, setup });
  const shared = await listSetups(db, "u2", "w1", ["design", "sales", "units", "year"]);
  assert.deepEqual(shared.map((s) => [s.id, s.name, s.createdBy]), [[id, "Default", "owner@example.com"]]);
  assert.deepEqual(await listSetups(db, "u2", "w1", ["other"]), []);
  await rejects(listSetups(db, "u3", "w1", columns), 404);

  await saveBridge(db, "u2", "w1", { name: "FY26 vs FY25", columns, setup, summary, filterColumns: ["design"] });
  const [bridge] = await listBridges(db, "u1", "w1");
  assert.deepEqual([bridge.name, bridge.summary.currentTotal, bridge.filterColumns], ["FY26 vs FY25", 110, ["design"]]);
  await rejects(listBridges(db, "u3", "w1"), 404);
  await rejects(deleteSaved(db, "u3", "w1", "setup", id), 404);
  await deleteSaved(db, "u2", "w1", "setup", id);
  assert.deepEqual(await listSetups(db, "u1", "w1", columns), []);
});

test("only setups without filter values and bridge totals can be saved", async () => {
  const db = await seeded();
  await applySubscription(db, subscription());
  const filtered = { ...setup, filters: [{ column: "design", mode: "include", values: ["Acme"] }] };
  await rejects(saveSetup(db, "u1", "w1", { name: "x", columns, setup: filtered }), 400);
  await rejects(saveSetup(db, "u1", "w1", { name: "x", columns: ["other"], setup }), 400);
  await rejects(saveBridge(db, "u1", "w1", { name: "x", columns, setup, summary: { ...summary, rows: [] } }), 400);
  await rejects(saveBridge(db, "u1", "w1", { name: "x", columns, setup, summary, filterColumns: ["customer"] }), 400);
});

test("the workspace count is of owned workspaces, and memberships elsewhere do not add to it", async () => {
  const db = await seeded();
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w2', 'Other', 'other', ?)`).bind(now).run();
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m4', 'w2', 'u1', 'member', ?), ('m5', 'w2', 'u3', 'owner', ?)`).bind(now, now).run();
  assert.equal(await workspaceCount(db, "u1"), 1);
  assert.equal(await workspaceCount(db, "u2"), 0);
  assert.equal(await workspaceCount(db, "u3"), 1);

  await db.prepare(`DELETE FROM member WHERE id = 'm1'`).run();
  assert.equal(await workspaceCount(db, "u1"), 0);

  // Seats already spent on a member or a live pending invitation are free again
  // once those go, and the invitation that holds a seat is not counted twice.
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m6', 'w1', 'u3', 'member', ?)`).bind(now).run();
  await applySubscription(db, subscription({ seats: 3 }));
  await db.prepare(`INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES ('i1', 'w1', 'a@example.com', 'member', 'pending', '2026-11-01T00:00:00.000Z', ?, 'u1'), ('i2', 'w1', 'b@example.com', 'member', 'pending', '2020-01-01T00:00:00.000Z', ?, 'u1')`).bind(now, now).run();
  const nowDate = new Date(now);
  // Two members and one live invitation fill the three seats.
  assert.equal(await freeSeats(db, "w1", nowDate), 0);
  assert.equal(await freeSeats(db, "w1", nowDate, "i1"), 1);
  await db.prepare(`UPDATE invitation SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE id = 'i1'`).run();
  assert.equal(await freeSeats(db, "w1", nowDate), 1);
  // Two members in a three-seat workspace with no invitation hold one of them.
  await applySubscription(db, subscription({ workspaceId: "w2" }));
  assert.equal(await freeSeats(db, "w2", nowDate), 1);
});

test("deleting an account removes the workspaces it is alone in, with their saved items", async () => {
  const db = await seeded();
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w2', 'Solo', 'solo', ?)`).bind(now).run();
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m3', 'w2', 'u1', 'owner', ?)`).bind(now).run();
  await applySubscription(db, subscription({ workspaceId: "w2" }));
  await saveSetup(db, "u1", "w2", { name: "Mine", columns, setup });
  await deleteSoleWorkspaces(db, "u1");
  const left = await db.prepare(`SELECT id FROM organization ORDER BY id`).all<{ id: string }>();
  assert.deepEqual(left.results.map((r) => r.id), ["w1"]);
  assert.equal((await db.prepare(`SELECT count(*) AS n FROM saved_setup`).first<{ n: number }>())?.n, 0);
});

test("page counts keep the path and referring site only, and skip bots and non-pages", async () => {
  const db = testDatabase();
  const html = new Response("<html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  const articles = new Set(["/guide.html", "/method.html", "/privacy.html", "/price-volume-mix-analysis.html", "/grouping-level.html"]);
  const visit = (url: string, headers: Record<string, string>) =>
    pageView(new Request(url, { headers: { "user-agent": "Mozilla/5.0", ...headers } }), html, articles);
  assert.deepEqual(visit("https://bk.example/app/?sample=3", { referer: "https://www.linkedin.com/feed/x" }), { path: "/app/", referrer: "www.linkedin.com" });
  assert.deepEqual(visit("https://bk.example/guide.html", { referer: "https://bk.example/" }), { path: "/guide", referrer: "" });
  assert.deepEqual(visit("https://bk.example/guide", { referer: "https://bk.example/method" }), { path: "/guide", referrer: "" });
  assert.equal(visit("https://bk.example/", { "user-agent": "Googlebot/2.1" }), null);
  assert.equal(visit("https://bk.example/", { "sec-fetch-dest": "iframe" }), null);
  assert.equal(pageView(new Request("https://bk.example/x.js"), new Response("", { headers: { "content-type": "text/javascript" } }), articles), null);
  await countPageView(db, { path: "/", referrer: "" }, "2026-10-04");
  await countPageView(db, { path: "/", referrer: "" }, "2026-10-04");
  assert.deepEqual((await db.prepare(`SELECT * FROM page_views`).all()).results, [{ day: "2026-10-04", path: "/", referrer: "", views: 2 }]);
});
