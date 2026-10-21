import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  chooseSubscription,
  createCheckout,
  createPortalSession,
  hasPro,
  listWorkspaceSubscriptions,
  PaddleReadError,
  parseSubscriptionEvent,
  SIGNATURE_TOLERANCE_SECONDS,
  verifyPaddleSignature,
  type PaddleAccount,
  type PaddleSubscription,
} from "../server/paddle.ts";

const SECRET = "pdl_ntfset_01gkpjp8bkh3jp2ppmhrmtx3pw_test";
const TS = 1_671_552_777;
const BODY = '{"event_id":"evt_1","event_type":"subscription.created"}';
const sign = (ts: number, body: string, secret = SECRET) => createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");

test("a correctly signed webhook passes", async () => {
  assert.equal(await verifyPaddleSignature(BODY, `ts=${TS};h1=${sign(TS, BODY)}`, SECRET, TS + 3), true);
});

test("any h1 may match while Paddle rotates the secret", async () => {
  const header = `ts=${TS};h1=${sign(TS, BODY, "old-secret")};h1=${sign(TS, BODY)}`;
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS), true);
});

test("a tampered body or wrong secret fails", async () => {
  const header = `ts=${TS};h1=${sign(TS, BODY)}`;
  assert.equal(await verifyPaddleSignature(BODY.replace("evt_1", "evt_2"), header, SECRET, TS), false);
  assert.equal(await verifyPaddleSignature(BODY, header, "another-secret", TS), false);
});

test("the past-only signature window refuses an old delivery and still verifies a future stamp", async () => {
  const header = `ts=${TS};h1=${sign(TS, BODY)}`;
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS + 7200), true);
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS + SIGNATURE_TOLERANCE_SECONDS), true);
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS + SIGNATURE_TOLERANCE_SECONDS + 1), false);
  // Only Paddle can sign a future stamp, so the window is not symmetric.
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS - 86400), true);
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS - SIGNATURE_TOLERANCE_SECONDS - 1), true);
});

test("missing or malformed headers fail", async () => {
  const h1 = sign(TS, BODY);
  for (const header of [null, "", `h1=${h1}`, `ts=${TS}`, `ts=abc;h1=${h1}`, `ts=${TS},h1=${h1}`, `ts=${TS};h1=${h1.slice(0, 10)}`]) {
    assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS), false, String(header));
  }
});

// Shape from https://developer.paddle.com/webhooks/subscriptions/subscription-created, with our custom_data.
const created = {
  event_id: "evt_01hv8x2acma2gz7he8kg2s0hna",
  event_type: "subscription.created",
  occurred_at: "2024-04-12T10:18:49.621022Z",
  notification_id: "ntf_01hv8x2af22vrrz7k67g06x1kq",
  data: {
    id: "sub_01hv8x29kz0t586xy6zn1a62ny",
    status: "active",
    customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    items: [
      { price: { id: "pri_01gsz8x8sawmvhz1pv30nge1ke" }, quantity: 10 },
      { price: { id: "pri_01h1vjfevh5etwq3rb416a23h2" }, quantity: 1 },
    ],
    custom_data: { workspace_id: "org_abc123" },
    current_billing_period: { starts_at: "2024-04-12T10:18:47.635628Z", ends_at: "2024-05-12T10:18:47.635628Z" },
    scheduled_change: null,
  },
};

test("a subscription.created payload becomes the five routing fields", () => {
  assert.deepEqual(parseSubscriptionEvent(created), {
    eventId: "evt_01hv8x2acma2gz7he8kg2s0hna",
    occurredAt: "2024-04-12T10:18:49.621022Z",
    workspaceId: "org_abc123",
    subscriptionId: "sub_01hv8x29kz0t586xy6zn1a62ny",
    customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
  });
});

test("the seat price item must exist when a price list is given", () => {
  assert.ok(parseSubscriptionEvent(created, ["pri_01h1vjfevh5etwq3rb416a23h2"]));
  assert.equal(parseSubscriptionEvent(created, ["pri_unknown"]), null);
});

test("a canceled subscription with no billing period still routes", () => {
  const canceled = { ...created, event_type: "subscription.canceled", data: { ...created.data, status: "canceled", current_billing_period: null } };
  assert.equal(parseSubscriptionEvent(canceled)?.subscriptionId, "sub_01hv8x29kz0t586xy6zn1a62ny");
});

test("unrelated events and payloads without a workspace are ignored", () => {
  assert.equal(parseSubscriptionEvent({ ...created, event_type: "transaction.completed" }), null);
  assert.equal(parseSubscriptionEvent({ ...created, data: { ...created.data, custom_data: null } }), null);
  assert.equal(parseSubscriptionEvent({ ...created, data: { ...created.data, custom_data: { workspace_id: "" } } }), null);
  assert.equal(parseSubscriptionEvent({ ...created, data: { ...created.data, status: "unknown" } }), null);
  assert.equal(parseSubscriptionEvent({ ...created, data: { ...created.data, items: [{ price: { id: "pri_1" }, quantity: 0 }] } }), null);
  assert.equal(parseSubscriptionEvent("not an object"), null);
  assert.equal(parseSubscriptionEvent(null), null);
});

test("hasPro grants Pro for paying states and until a canceled period ends", () => {
  const now = new Date("2024-05-01T00:00:00Z");
  assert.equal(hasPro("active", null, now), true);
  assert.equal(hasPro("trialing", null, now), true);
  assert.equal(hasPro("past_due", "2024-04-01T00:00:00Z", now), true);
  assert.equal(hasPro("paused", "2024-06-01T00:00:00Z", now), false);
  assert.equal(hasPro("canceled", "2024-05-12T10:18:47Z", now), true);
  assert.equal(hasPro("canceled", "2024-05-01T00:00:00Z", now), false);
  assert.equal(hasPro("canceled", "2024-04-30T23:59:59Z", now), false);
  assert.equal(hasPro("canceled", null, now), false);
  assert.equal(hasPro("canceled", "not a date", now), false);
});

const account = (fake: typeof fetch): PaddleAccount => ({ apiKey: "pdl_sdbx_key", environment: "sandbox", fetch: fake });

const listed = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  customer_id: "ctm_1",
  items: [{ price: { id: "pri_seat" }, quantity: 2 }],
  custom_data: { workspace_id: "org_1" },
  current_billing_period: { starts_at: "2024-04-12T10:18:47Z", ends_at: "2024-05-12T10:18:47Z" },
  created_at: "2024-04-12T10:18:49Z",
  ...over,
});

const listedSubscription = (over: Partial<PaddleSubscription> = {}): PaddleSubscription => ({
  subscriptionId: "sub_1",
  customerId: "ctm_1",
  workspaceId: "org_1",
  status: "active",
  priceId: "pri_seat",
  seats: 2,
  currentPeriodEnd: "2099-01-01T00:00:00Z",
  createdAt: "2024-01-01T00:00:00Z",
  ...over,
});

test("listWorkspaceSubscriptions reads the account's list once with the key and refuses redirects", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ data: [listed()], meta: { pagination: { has_more: false } } });
  }) as unknown as typeof fetch;
  const list = await listWorkspaceSubscriptions(account(fake), "org_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sandbox-api.paddle.com/subscriptions?per_page=200");
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer pdl_sdbx_key", "paddle-version": "1" });
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(list, [
    {
      subscriptionId: "sub_1",
      customerId: "ctm_1",
      workspaceId: "org_1",
      status: "active",
      priceId: "pri_seat",
      seats: 2,
      currentPeriodEnd: "2024-05-12T10:18:47Z",
      createdAt: "2024-04-12T10:18:49Z",
    },
  ]);
});

test("listWorkspaceSubscriptions keeps every subscription tagged for the asked workspace, whatever its customer", async () => {
  const fake = (async () =>
    Response.json({
      data: [
        listed({ id: "sub_1", customer_id: "ctm_1" }),
        listed({ id: "sub_2", customer_id: "ctm_2" }),
        listed({ id: "sub_3", customer_id: "ctm_1", custom_data: { workspace_id: "org_other" } }),
        listed({ id: "sub_4", created_at: "not a time" }),
      ],
      meta: { pagination: { has_more: false } },
    })) as unknown as typeof fetch;
  const list = await listWorkspaceSubscriptions(account(fake), "org_1");
  assert.deepEqual(
    list.map((subscription) => [subscription.subscriptionId, subscription.customerId]),
    [
      ["sub_1", "ctm_1"],
      ["sub_2", "ctm_2"],
    ],
  );
});

test("listWorkspaceSubscriptions follows the next page from the last entity id", async () => {
  const urls: string[] = [];
  const pages = [
    { data: [listed({ id: "sub_1" }), listed({ id: "sub_2" })], meta: { pagination: { has_more: true } } },
    { data: [listed({ id: "sub_3" })], meta: { pagination: { has_more: false } } },
  ];
  const fake = (async (url: string) => {
    urls.push(url);
    return Response.json(pages[urls.length - 1]);
  }) as unknown as typeof fetch;
  const list = await listWorkspaceSubscriptions(account(fake), "org_1");
  assert.deepEqual(urls, [
    "https://sandbox-api.paddle.com/subscriptions?per_page=200",
    "https://sandbox-api.paddle.com/subscriptions?per_page=200&after=sub_2",
  ]);
  assert.deepEqual(
    list.map((subscription) => subscription.subscriptionId),
    ["sub_1", "sub_2", "sub_3"],
  );
});

test("listWorkspaceSubscriptions rejects when Paddle cannot answer", async () => {
  for (const status of [404, 429, 500]) {
    const failing = (async () => new Response("{}", { status })) as unknown as typeof fetch;
    await assert.rejects(listWorkspaceSubscriptions(account(failing), "org_1"), PaddleReadError);
  }
  const noData = (async () => Response.json({ meta: { pagination: { has_more: false } } })) as unknown as typeof fetch;
  await assert.rejects(listWorkspaceSubscriptions(account(noData), "org_1"), PaddleReadError);
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  await assert.rejects(listWorkspaceSubscriptions(account(offline), "org_1"), PaddleReadError);
});

test("listWorkspaceSubscriptions refuses a sixth page", async () => {
  let reads = 0;
  const fake = (async () => {
    reads += 1;
    return Response.json({ data: [listed({ id: `sub_${reads}` })], meta: { pagination: { has_more: true } } });
  }) as unknown as typeof fetch;
  await assert.rejects(listWorkspaceSubscriptions(account(fake), "org_1"), PaddleReadError);
  assert.equal(reads, 5);
});

test("listWorkspaceSubscriptions never fetches a URL from the response body", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    return Response.json({
      data: [listed()],
      meta: { pagination: { has_more: false, next: "https://sandbox-api.paddle.com/subscriptions?after=other" } },
      links: { next: "https://evil.example/subscriptions" },
    });
  }) as unknown as typeof fetch;
  await listWorkspaceSubscriptions(account(fake), "org_1");
  assert.deepEqual(urls, ["https://sandbox-api.paddle.com/subscriptions?per_page=200"]);
});

test("chooseSubscription prefers a paying subscription over a newer canceled one", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const paying = listedSubscription({ subscriptionId: "sub_paying", createdAt: "2024-01-01T00:00:00Z" });
  const canceled = listedSubscription({
    subscriptionId: "sub_canceled",
    status: "canceled",
    currentPeriodEnd: "2024-05-15T00:00:00Z",
    createdAt: "2024-05-01T00:00:00Z",
  });
  assert.equal(chooseSubscription([canceled, paying], now).subscriptionId, "sub_paying");
});

test("chooseSubscription takes the newest created subscription among paying ones", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const older = listedSubscription({ subscriptionId: "sub_old", createdAt: "2024-01-01T00:00:00Z" });
  const newer = listedSubscription({ subscriptionId: "sub_new", createdAt: "2024-05-01T00:00:00Z" });
  assert.equal(chooseSubscription([older, newer], now).subscriptionId, "sub_new");
});

test("chooseSubscription ranks canceled with paid time left above paused, and paused above expired canceled", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const canceledWithTime = listedSubscription({
    subscriptionId: "sub_canceled_time",
    status: "canceled",
    currentPeriodEnd: "2024-07-01T00:00:00Z",
  });
  const paused = listedSubscription({ subscriptionId: "sub_paused", status: "paused" });
  const canceledExpired = listedSubscription({
    subscriptionId: "sub_canceled_expired",
    status: "canceled",
    currentPeriodEnd: "2024-05-01T00:00:00Z",
  });
  assert.equal(chooseSubscription([paused, canceledWithTime], now).subscriptionId, "sub_canceled_time");
  assert.equal(chooseSubscription([canceledExpired, paused], now).subscriptionId, "sub_paused");
});

test("chooseSubscription elects the same subscription for every order of four candidates", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const candidates = [
    listedSubscription({ subscriptionId: "sub_a", status: "paused", createdAt: "2024-05-01T00:00:00Z" }),
    listedSubscription({ subscriptionId: "sub_b", status: "canceled", currentPeriodEnd: "2024-07-01T00:00:00Z", createdAt: "2024-04-01T00:00:00Z" }),
    listedSubscription({ subscriptionId: "sub_c", status: "active", createdAt: "2024-03-01T00:00:00Z" }),
    listedSubscription({ subscriptionId: "sub_d", status: "active", createdAt: "2024-05-15T00:00:00Z" }),
  ];
  const permutations = (items: PaddleSubscription[]): PaddleSubscription[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
  for (const order of permutations(candidates)) {
    assert.equal(chooseSubscription(order as [PaddleSubscription, ...PaddleSubscription[]], now).subscriptionId, "sub_d");
  }
});

test("createCheckout posts a tagged transaction and returns Paddle's checkout URL", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(
      { data: { id: "txn_01abc", checkout: { url: "https://pay.example.com/checkout?_ptxn=txn_01abc" } } },
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await createCheckout({
    apiKey: "pdl_sdbx_apikey_x",
    environment: "sandbox",
    priceId: "pri_01gsz8x8sawmvhz1pv30nge1ke",
    seats: 5,
    workspaceId: "org_abc123",
    customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    fetch: fakeFetch,
  });
  assert.deepEqual(result, { transactionId: "txn_01abc", checkoutUrl: "https://pay.example.com/checkout?_ptxn=txn_01abc" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sandbox-api.paddle.com/transactions");
  assert.deepEqual(calls[0].init.headers, {
    authorization: "Bearer pdl_sdbx_apikey_x",
    "content-type": "application/json",
    "paddle-version": "1",
  });
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    items: [{ price_id: "pri_01gsz8x8sawmvhz1pv30nge1ke", quantity: 5 }],
    custom_data: { workspace_id: "org_abc123" },
    customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
  });
});

test("createCheckout throws when Paddle errors or omits the URL", async () => {
  const base = { apiKey: "k", environment: "live" as const, priceId: "pri_1", seats: 1, workspaceId: "org_1" };
  const failing = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(createCheckout({ ...base, fetch: failing }), /Paddle returned 400/);
  const noUrl = (async () => Response.json({ data: { id: "txn_1", checkout: null } })) as unknown as typeof fetch;
  await assert.rejects(createCheckout({ ...base, fetch: noUrl }), /did not return a checkout URL/);
  await assert.rejects(createCheckout({ ...base, seats: 0, fetch: noUrl }), /at least 1/);
});

test("createPortalSession posts to the customer portal endpoint and returns the URL", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  // The documented shape: data.urls.general.overview.
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(
      { data: { id: "pstl_1", urls: { general: { overview: "https://paddle.com/portal/abc" } } } },
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  const result = await createPortalSession({ apiKey: "k", environment: "sandbox", customerId: "ctm_1", fetch: fakeFetch });
  assert.deepEqual(result, { portalUrl: "https://paddle.com/portal/abc" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions");
  assert.deepEqual(calls[0].init.headers, {
    authorization: "Bearer k",
    "content-type": "application/json",
    "paddle-version": "1",
  });
  assert.equal(calls[0].init.redirect, "manual");
});

test("createPortalSession throws when Paddle errors or omits the URL", async () => {
  const base = { apiKey: "k", environment: "live" as const, customerId: "ctm_1" };
  const failing = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(createPortalSession({ ...base, fetch: failing }), /Paddle returned 500/);
  const noUrl = (async () => Response.json({ data: { id: "pstl_1" } })) as unknown as typeof fetch;
  await assert.rejects(createPortalSession({ ...base, fetch: noUrl }), /did not return a portal URL/);
  const flat = (async () => Response.json({ data: { id: "pstl_1", url: "https://paddle.com/portal/flat" } })) as unknown as typeof fetch;
  assert.deepEqual(await createPortalSession({ ...base, fetch: flat }), { portalUrl: "https://paddle.com/portal/flat" });
});
