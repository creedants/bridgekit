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
  setupListQuery,
  userHasPro,
  workspaceCount,
  WorkspaceError,
} from "../server/workspace.ts";
import { listSetups as requestSetups, setupsForColumns } from "../src/app/account.ts";
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

async function storedSubscription(db: Awaited<ReturnType<typeof seeded>>, workspaceId = "w1") {
  const row = await db
    .prepare(
      `SELECT paddleSubscriptionId, paddleCustomerId, status, priceId, seats, currentPeriodEnd, lastEventAt
       FROM subscription WHERE organizationId = ?`,
    )
    .bind(workspaceId)
    .first<{
      paddleSubscriptionId: string;
      paddleCustomerId: string;
      status: string;
      priceId: string;
      seats: number;
      currentPeriodEnd: string | null;
      lastEventAt: string;
    }>();
  assert.ok(row);
  return row;
}

const columns = ["year", "units", "sales", "design"];
const setup = { periodColumn: "year", grain: "value", unitsColumn: "units", salesColumn: "sales", levels: [{ name: "Design", columns: ["design"] }], filters: [] };
const summary = {
  measure: "Sales", prior: "2025", current: "2026", priorTotal: 100, currentTotal: 110,
  effects: [{ label: "Volume", value: 10 }], attributes: ["Design"], exactMatchShare: 0.9, newAndDiscontinued: "difference",
};
const BRIDGE_FULL = "This workspace has 100 saved bridges. Delete one to save another.";

const rejects = (promise: Promise<unknown>, status: number, message?: string) =>
  assert.rejects(
    promise,
    (error) => error instanceof WorkspaceError && error.status === status && (message === undefined || error.message === message),
  );

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

test("a newer event for a different subscription id replaces the stored row", async () => {
  const db = await seeded();
  assert.equal(await applySubscription(db, subscription()), "applied");
  assert.equal(
    await applySubscription(db, subscription({ subscriptionId: "sub_other", occurredAt: "2026-10-05T00:00:00.000000Z", eventId: "evt_other" })),
    "applied",
  );
  const row = await storedSubscription(db);
  assert.equal(row.paddleSubscriptionId, "sub_other");
  assert.equal(row.status, "active");
  assert.equal(row.lastEventAt, "2026-10-05T00:00:00.000000Z");
});

test("a repeated event at the same time leaves the stored subscription unchanged", async () => {
  const db = await seeded();
  assert.equal(await applySubscription(db, subscription()), "applied");
  const before = await storedSubscription(db);
  assert.equal(await applySubscription(db, subscription({ eventId: "evt_repeat" })), "stale");
  assert.deepEqual(await storedSubscription(db), before);
});

test("a newer event for the same subscription id can mark it past_due", async () => {
  const db = await seeded();
  assert.equal(await applySubscription(db, subscription()), "applied");
  assert.equal(
    await applySubscription(db, subscription({ status: "past_due", occurredAt: "2026-10-05T00:00:00.000000Z", eventId: "evt_due" })),
    "applied",
  );
  const row = await storedSubscription(db);
  assert.equal(row.paddleSubscriptionId, "sub_1");
  assert.equal(row.status, "past_due");
});

test("a newer event for the same subscription id can mark it canceled", async () => {
  const db = await seeded();
  assert.equal(await applySubscription(db, subscription()), "applied");
  assert.equal(
    await applySubscription(db, subscription({ status: "canceled", occurredAt: "2026-10-05T00:00:00.000000Z", eventId: "evt_cancel" })),
    "applied",
  );
  const row = await storedSubscription(db);
  assert.equal(row.paddleSubscriptionId, "sub_1");
  assert.equal(row.status, "canceled");
});

test("a canceled row accepts a newer subscription id", async () => {
  const db = await seeded();
  assert.equal(await applySubscription(db, subscription({ status: "canceled" })), "applied");
  assert.equal(
    await applySubscription(db, subscription({ subscriptionId: "sub_next", status: "active", occurredAt: "2026-10-05T00:00:00.000000Z", eventId: "evt_next" })),
    "applied",
  );
  assert.equal((await storedSubscription(db)).paddleSubscriptionId, "sub_next");
});

test("an older event for a different subscription id leaves the stored id unchanged", async () => {
  const db = await seeded();
  assert.equal(await applySubscription(db, subscription()), "applied");
  assert.equal(
    await applySubscription(db, subscription({ subscriptionId: "sub_older", occurredAt: "2026-10-03T00:00:00.000000Z", eventId: "evt_older" })),
    "stale",
  );
  assert.equal((await storedSubscription(db)).paddleSubscriptionId, "sub_1");
});

test("a delayed old cancellation preserves the new paid subscription", async () => {
  const db = await seeded();
  await applySubscription(
    db,
    subscription({
      subscriptionId: "sub_old",
      currentPeriodEnd: "2099-01-01T00:00:00Z",
      eventId: "evt_sub_old_1",
      occurredAt: "2026-10-01T00:00:01.000000Z",
    }),
  );
  await applySubscription(
    db,
    subscription({
      subscriptionId: "sub_new",
      currentPeriodEnd: "2099-01-01T00:00:00Z",
      eventId: "evt_sub_new_3",
      occurredAt: "2026-10-01T00:00:03.000000Z",
    }),
  );
  await applySubscription(
    db,
    subscription({
      subscriptionId: "sub_old",
      status: "canceled",
      currentPeriodEnd: null,
      eventId: "evt_sub_old_2",
      occurredAt: "2026-10-01T00:00:02.000000Z",
    }),
  );
  assert.equal((await plan(db, "w1", new Date("2026-10-13T00:00:00Z"))).pro, true);
  assert.equal((await storedSubscription(db)).paddleSubscriptionId, "sub_new");
});

test("a subscription event for an unknown workspace is skipped", async () => {
  const db = await seeded();
  assert.equal(await applySubscription(db, subscription({ workspaceId: "missing" })), "unknown-workspace");
  assert.equal(await db.prepare(`SELECT organizationId FROM subscription WHERE organizationId = 'missing'`).first(), null);
});

test("members share saved setups and bridges; outsiders see nothing", async () => {
  const db = await seeded();
  await applySubscription(db, subscription());
  const older = await saveSetup(db, "u1", "w1", { name: "Older", columns, setup }, new Date("2026-10-04T00:00:00.000Z"));
  const newerSetup = { ...setup, levels: [{ name: "Region", columns: ["region"] }] };
  const newer = await saveSetup(
    db,
    "u1",
    "w1",
    { name: "Newer", columns: ["year", "units", "sales", "region"], setup: newerSetup },
    new Date("2026-10-04T01:00:00.000Z"),
  );
  assert.deepEqual(await listSetups(db, "u2", "w1", "absent"), [
    {
      id: newer.id,
      name: "Newer",
      setup: newerSetup,
      createdBy: "owner@example.com",
      createdAt: "2026-10-04T01:00:00.000Z",
      columnsKey: "region|sales|units|year",
    },
    {
      id: older.id,
      name: "Older",
      setup,
      createdBy: "owner@example.com",
      createdAt: "2026-10-04T00:00:00.000Z",
      columnsKey: "design|sales|units|year",
    },
  ]);
  await rejects(listSetups(db, "u2", "w1", "present"), 400, "This request does not take column names.");
  await rejects(listSetups(db, "u3", "w1", "present"), 404, "Workspace not found.");
  await rejects(listSetups(db, "u3", "w1", "absent"), 404, "Workspace not found.");

  await saveBridge(db, "u2", "w1", { name: "FY26 vs FY25", columns, setup, summary, filterColumns: ["design"] });
  const [bridge] = await listBridges(db, "u1", "w1");
  assert.deepEqual([bridge.name, bridge.summary.currentTotal, bridge.filterColumns], ["FY26 vs FY25", 110, ["design"]]);
  await rejects(listBridges(db, "u3", "w1"), 404);
  await rejects(deleteSaved(db, "u3", "w1", "setup", older.id), 404);
  await deleteSaved(db, "u2", "w1", "setup", older.id);
  assert.deepEqual(
    (await listSetups(db, "u1", "w1", "absent")).map((row) => row.id),
    [newer.id],
  );
});

test("a file load asks for saved setups without sending column names", async () => {
  const seen: { method: string; url: string; body: string | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await requestSetups("w1", ["zephyr-column", "quartz-column"]);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
  const url = new URL(seen[0].url, "http://localhost");
  assert.equal(url.pathname, "/api/workspaces/w1/setups");
  assert.equal(url.search, "");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].body, undefined);
  const wire = JSON.stringify(seen);
  assert.equal(wire.includes("zephyr-column"), false);
  assert.equal(wire.includes("quartz-column"), false);
});

test("saved setups match a column set in any order and keep the list order", () => {
  const stored = [
    { name: "newer", columnsKey: "design|sales|units|year" },
    { name: "blank", columnsKey: "" },
    { name: "other", columnsKey: "region|sales|units|year" },
    { name: "older", columnsKey: "design|sales|units|year" },
  ];
  assert.deepEqual(
    setupsForColumns(stored, ["sales", "units", "year", "design"]).map((row) => row.name),
    ["newer", "older"],
  );
  assert.deepEqual(setupsForColumns(stored, ["year", "units", "sales"]), []);
  assert.deepEqual(setupsForColumns(stored, []), []);
});

test("a file load keeps the matching setup and drops the stored key", async () => {
  const setupRow = { periodColumn: "year", grain: "value", unitsColumn: "units", salesColumn: "sales", levels: [], filters: [] };
  const match = {
    id: "new",
    name: "Newer",
    setup: setupRow,
    createdBy: "owner@example.com",
    createdAt: "2026-10-05T00:00:00.000Z",
    columnsKey: "design|sales|units|year",
  };
  const other = {
    id: "other",
    name: "Other",
    setup: setupRow,
    createdBy: "owner@example.com",
    createdAt: "2026-10-06T00:00:00.000Z",
    columnsKey: "region|sales|units|year",
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([match, other]), { status: 200, headers: { "content-type": "application/json" } });
  try {
    assert.deepEqual(await requestSetups("w1", ["sales", "units", "year", "design"]), [
      {
        id: "new",
        name: "Newer",
        setup: setupRow,
        createdBy: "owner@example.com",
        createdAt: "2026-10-05T00:00:00.000Z",
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("an empty column list does not ask for setups", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(await requestSetups("w1", []), []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("the setups list records only whether a column query was sent", () => {
  assert.equal(setupListQuery("https://bk.example/api/workspaces/w1/setups"), "absent");
  assert.equal(
    setupListQuery("https://bk.example/api/workspaces/w1/setups?column=period&column=design&column=finish&column=units&column=sales"),
    "present",
  );
  assert.equal(setupListQuery("https://bk.example/api/workspaces/w1/setups?column"), "present");
});

test("only setups without filter values and bridge totals can be saved", async () => {
  const db = await seeded();
  await applySubscription(db, subscription());
  const filtered = { ...setup, filters: [{ column: "design", mode: "include", values: ["C0001"] }] };
  await rejects(saveSetup(db, "u1", "w1", { name: "x", columns, setup: filtered }), 400);
  await rejects(saveSetup(db, "u1", "w1", { name: "x", columns: ["other"], setup }), 400);
  await rejects(saveBridge(db, "u1", "w1", { name: "x", columns, setup, summary: { ...summary, rows: [] } }), 400);
  await rejects(saveBridge(db, "u1", "w1", { name: "x", columns, setup, summary, filterColumns: ["customer"] }), 400);
});

test("100 saved bridges fit and the 101st is refused", async () => {
  const db = await seeded();
  await applySubscription(db, subscription());
  for (let index = 1; index < 100; index += 1) {
    await saveBridge(db, "u1", "w1", { name: `Bridge ${index}`, columns, setup, summary, filterColumns: [] });
  }
  const hundredth = await saveBridge(db, "u1", "w1", { name: "Bridge 100", columns, setup, summary, filterColumns: [] });
  assert.ok(hundredth.id);
  const count = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM saved_bridge WHERE organizationId = 'w1'`).first<{ n: number }>())?.n;
  assert.equal(await count(), 100);

  await rejects(
    saveBridge(db, "u1", "w1", { name: "Bridge 101", columns, setup, summary, filterColumns: [] }),
    409,
    BRIDGE_FULL,
  );
  assert.equal(await count(), 100);
  const listed = await listBridges(db, "u1", "w1");
  assert.equal(listed.length, 100);
  assert.equal(listed.some((row) => row.name === "Bridge 101"), false, "the refused bridge was saved");
});

test("the bridge cap is per workspace", async () => {
  const db = await seeded();
  await applySubscription(db, subscription());
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w2', 'Other', 'other', ?)`).bind(now).run();
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m9', 'w2', 'u1', 'owner', ?)`).bind(now).run();
  await applySubscription(db, subscription({ workspaceId: "w2" }));
  for (let index = 1; index <= 100; index += 1) {
    await saveBridge(db, "u1", "w1", { name: `Bridge ${index}`, columns, setup, summary, filterColumns: [] });
  }
  await rejects(saveBridge(db, "u1", "w1", { name: "One too many", columns, setup, summary, filterColumns: [] }), 409, BRIDGE_FULL);

  const saved = await saveBridge(db, "u1", "w2", { name: "Elsewhere", columns, setup, summary, filterColumns: [] });
  assert.ok(saved.id);
  assert.deepEqual((await listBridges(db, "u1", "w2")).map((row) => row.name), ["Elsewhere"]);
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

test("deleting an account cancels the workspace's live subscription before the rows go", async () => {
  const db = await seeded();
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w2', 'Solo', 'solo', ?)`).bind(now).run();
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m3', 'w2', 'u1', 'owner', ?)`).bind(now).run();
  await applySubscription(db, subscription({ workspaceId: "w2", subscriptionId: "sub_2" }));
  const sent: { method: string; url: string; body: unknown }[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    // The subscription is cancelled while its workspace still exists, so a
    // failed cancel can still leave the rows in place.
    assert.ok(await db.prepare(`SELECT id FROM organization WHERE id = 'w2'`).first(), "workspace still exists when Paddle is asked");
    sent.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ data: {} });
  }) as typeof fetch;
  await deleteSoleWorkspaces(db, "u1", { apiKey: "pdl_sdbx_key", environment: "sandbox", fetch: fake });
  assert.deepEqual(sent, [
    { method: "POST", url: "https://sandbox-api.paddle.com/subscriptions/sub_2/cancel", body: { effective_from: "next_billing_period" } },
  ]);
  assert.equal(await db.prepare(`SELECT id FROM organization WHERE id = 'w2'`).first(), null);
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
