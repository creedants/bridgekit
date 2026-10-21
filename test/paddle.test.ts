import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createCheckout, createPortalSession, hasPro, parseSubscriptionEvent, verifyPaddleSignature } from "../server/paddle.ts";

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

test("a timestamp more than 5 seconds away fails", async () => {
  const header = `ts=${TS};h1=${sign(TS, BODY)}`;
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS + 5), true);
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS + 6), false);
  assert.equal(await verifyPaddleSignature(BODY, header, SECRET, TS - 6), false);
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

test("a subscription.created payload becomes a SubscriptionChange", () => {
  assert.deepEqual(parseSubscriptionEvent(created), {
    subscriptionId: "sub_01hv8x29kz0t586xy6zn1a62ny",
    customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    workspaceId: "org_abc123",
    status: "active",
    priceId: "pri_01gsz8x8sawmvhz1pv30nge1ke",
    seats: 10,
    currentPeriodEnd: "2024-05-12T10:18:47.635628Z",
    eventId: "evt_01hv8x2acma2gz7he8kg2s0hna",
    occurredAt: "2024-04-12T10:18:49.621022Z",
  });
});

test("seats come from the listed seat price when given", () => {
  const change = parseSubscriptionEvent(created, ["pri_01h1vjfevh5etwq3rb416a23h2"]);
  assert.equal(change?.priceId, "pri_01h1vjfevh5etwq3rb416a23h2");
  assert.equal(change?.seats, 1);
  assert.equal(parseSubscriptionEvent(created, ["pri_unknown"]), null);
});

test("a canceled subscription with no billing period has a null period end", () => {
  const canceled = { ...created, event_type: "subscription.canceled", data: { ...created.data, status: "canceled", current_billing_period: null } };
  assert.equal(parseSubscriptionEvent(canceled)?.status, "canceled");
  assert.equal(parseSubscriptionEvent(canceled)?.currentPeriodEnd, null);
});

test("unrelated events and payloads without a workspace are ignored", () => {
  assert.equal(parseSubscriptionEvent({ ...created, event_type: "transaction.completed" }), null);
  assert.equal(parseSubscriptionEvent({ ...created, data: { ...created.data, custom_data: null } }), null);
  assert.equal(parseSubscriptionEvent({ ...created, data: { ...created.data, custom_data: { workspace_id: "" } } }), null);
  assert.equal(parseSubscriptionEvent({ ...created, data: { ...created.data, status: "unknown" } }), null);
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
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ data: { id: "pstl_1", url: "https://paddle.com/portal/abc" } }, { status: 201 });
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
});

test("createPortalSession throws when Paddle errors or omits the URL", async () => {
  const base = { apiKey: "k", environment: "live" as const, customerId: "ctm_1" };
  const failing = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(createPortalSession({ ...base, fetch: failing }), /Paddle returned 500/);
  const noUrl = (async () => Response.json({ data: { id: "pstl_1" } })) as unknown as typeof fetch;
  await assert.rejects(createPortalSession({ ...base, fetch: noUrl }), /did not return a portal URL/);
});
