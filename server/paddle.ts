/**
 * Paddle Billing for Bridgekit Pro: webhook verification, subscription
 * parsing, entitlement, and starting a checkout.
 *
 * A workspace (Better Auth organization) buys Pro. We tag every checkout with
 * custom_data.workspace_id; Paddle copies custom_data from the transaction to
 * the subscription, so each subscription webhook tells us which workspace it
 * belongs to. Web-standard APIs only (fetch, crypto.subtle), so this runs on
 * Cloudflare Workers and in Node.
 *
 * Docs:
 *   https://developer.paddle.com/webhooks/signature-verification
 *   https://developer.paddle.com/webhooks/subscriptions/subscription-created
 *   https://developer.paddle.com/api-reference/transactions/create-transaction
 *   https://developer.paddle.com/build/transactions/default-payment-link
 */

export const PADDLE_API = {
  sandbox: "https://sandbox-api.paddle.com",
  live: "https://api.paddle.com",
} as const;
export type PaddleEnvironment = keyof typeof PADDLE_API;

/**
 * How old a signed delivery may be. Paddle retries any non-200 answer with
 * exponential backoff: three attempts in about two minutes on sandbox, and up
 * to 60 attempts over about two days on live, about 10 of them in the first
 * hour. It does not promise that a retry carries a freshly signed ts, so a
 * window shorter than the documented schedule can refuse a genuine retry and
 * the delayed event never applies. Three days covers that schedule with a day
 * of margin, and a delivery older than that is not a genuine retry but a
 * replay.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 259200;

const encoder = new TextEncoder();

/**
 * Checks the Paddle-Signature header, which looks like `ts=1671552777;h1=<hex>`.
 * Paddle signs `${ts}:${rawBody}` with HMAC-SHA256 using the endpoint's secret
 * key. During secret rotation the header carries more than one h1; any match
 * passes. rawBody must be the exact request text, before any JSON parsing.
 *
 * The window is past-only, which is what Paddle's own sample code does. It
 * still covers a retry that Paddle signed when the event happened, and it
 * tolerates our clock running behind Paddle's.
 */
export async function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let ts: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) return false;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts") ts = value;
    else if (key === "h1") signatures.push(value.toLowerCase());
  }
  if (!ts || !/^\d+$/.test(ts) || signatures.length === 0) return false;
  if (nowSeconds - Number(ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}:${rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  // Check every candidate so timing does not reveal which one matched.
  let ok = false;
  for (const signature of signatures) ok = constantTimeEqual(signature, expected) || ok;
  return ok;
}

/** Compares two strings in time that depends only on their length. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";
const STATUSES: readonly string[] = ["active", "trialing", "past_due", "paused", "canceled"];

/** Every subscription.* webhook carries the full subscription entity in `data`. */
const SUBSCRIPTION_EVENTS: readonly string[] = [
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled",
  "subscription.imported",
];

export interface SubscriptionChange {
  subscriptionId: string;
  customerId: string;
  workspaceId: string;
  status: SubscriptionStatus;
  priceId: string;
  seats: number;
  /** current_billing_period.ends_at; null when there is no current period, for example after cancellation. */
  currentPeriodEnd: string | null;
  eventId: string;
  /**
   * Paddle does not guarantee delivery order. Store this and ignore an event
   * older than the one already applied for the same subscription.
   */
  occurredAt: string;
}

/** Credentials and parsing rules for one deployment's Paddle account. */
export interface PaddleAccount {
  apiKey: string;
  environment: PaddleEnvironment;
  seatPriceIds?: readonly string[];
  /** For tests. */
  fetch?: typeof fetch;
}

/** One subscription as Paddle's API reports it, in domain terms. */
export interface PaddleSubscription {
  subscriptionId: string;
  customerId: string;
  /** custom_data.workspace_id, always the workspace that was asked for. */
  workspaceId: string;
  status: SubscriptionStatus;
  priceId: string;
  seats: number;
  /** current_billing_period.ends_at, or null when Paddle reports no period. */
  currentPeriodEnd: string | null;
  /** created_at, used only to order equally good subscriptions. */
  createdAt: string;
}

/** What a subscription webhook tells us: where to look. Carries no state. */
export interface SubscriptionEvent {
  eventId: string;
  occurredAt: string;
  workspaceId: string;
  subscriptionId: string;
  customerId: string;
}

/** Thrown when Paddle cannot answer for this subscription: nothing is written and the delivery should be retried. */
export class PaddleReadError extends Error {}

/**
 * Turns a parsed webhook body into the workspace and subscription it points
 * at. Returns null for other event types, malformed payloads, or subscriptions
 * without custom_data.workspace_id. It deliberately carries no status, seats or
 * period: the caller reads the current state from Paddle's API instead of
 * trusting the order in which events arrived.
 */
export function parseSubscriptionEvent(body: unknown, seatPriceIds?: readonly string[]): SubscriptionEvent | null {
  if (!isRecord(body) || typeof body.event_type !== "string" || !SUBSCRIPTION_EVENTS.includes(body.event_type)) return null;
  const { event_id: eventId, occurred_at: occurredAt, data } = body;
  if (typeof eventId !== "string" || typeof occurredAt !== "string") return null;
  const entity = parseSubscriptionEntity(data, seatPriceIds);
  if (!entity) return null;
  return {
    eventId,
    occurredAt,
    workspaceId: entity.workspaceId,
    subscriptionId: entity.subscriptionId,
    customerId: entity.customerId,
  };
}

/** The fields a webhook entity and a listed entity share, validated once so the two readers cannot drift. */
function parseSubscriptionEntity(data: unknown, seatPriceIds?: readonly string[]): Omit<PaddleSubscription, "createdAt"> | null {
  if (!isRecord(data)) return null;
  const { id, customer_id: customerId, status, items, custom_data: customData, current_billing_period: period } = data;
  if (typeof id !== "string" || typeof customerId !== "string") return null;
  if (typeof status !== "string" || !STATUSES.includes(status)) return null;
  if (!isRecord(customData) || typeof customData.workspace_id !== "string" || !customData.workspace_id) return null;
  if (!Array.isArray(items)) return null;

  const item = seatPriceIds ? items.find((candidate) => seatPriceIds.includes(priceOf(candidate) ?? "")) : items[0];
  const priceId = priceOf(item);
  const seats = isRecord(item) ? item.quantity : undefined;
  if (!priceId || typeof seats !== "number" || !Number.isInteger(seats) || seats < 1) return null;

  const endsAt = isRecord(period) && typeof period.ends_at === "string" ? period.ends_at : null;
  return {
    subscriptionId: id,
    customerId,
    workspaceId: customData.workspace_id,
    status: status as SubscriptionStatus,
    priceId,
    seats,
    currentPeriodEnd: endsAt,
  };
}

const PAGE_LIMIT = 5;

/**
 * Reads every subscription Paddle has for these customers and keeps the ones
 * tagged for this workspace. The URL is built here; nothing the response says
 * is fetched, so the API key only ever goes to Paddle's own address. A sixth
 * page means the account is larger than this deployment should page through,
 * so it fails rather than returning a partial list.
 */
export async function listWorkspaceSubscriptions(
  account: PaddleAccount,
  workspaceId: string,
  customerIds: readonly string[],
): Promise<PaddleSubscription[]> {
  const customers = [...new Set(customerIds.filter((id) => id !== ""))].map(encodeURIComponent);
  const subscriptions: PaddleSubscription[] = [];
  let after: string | undefined;
  for (let page = 1; ; page++) {
    if (page > PAGE_LIMIT) throw new PaddleReadError(`Paddle served more than ${PAGE_LIMIT} pages of subscriptions.`);
    const query = `customer_id=${customers.join(",")}&per_page=200${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`;
    const { data, hasMore } = await readSubscriptionsPage(account, `${PADDLE_API[account.environment]}/subscriptions?${query}`);
    for (const raw of data) {
      const createdAt = isRecord(raw) && typeof raw.created_at === "string" ? raw.created_at : undefined;
      const entity = parseSubscriptionEntity(raw, account.seatPriceIds);
      if (entity && createdAt && Number.isFinite(Date.parse(createdAt)) && entity.workspaceId === workspaceId) {
        subscriptions.push({ ...entity, createdAt });
      }
    }
    if (!hasMore) return subscriptions;
    const last = data[data.length - 1];
    const lastId = isRecord(last) && typeof last.id === "string" ? last.id : undefined;
    if (!lastId) throw new PaddleReadError("Paddle reported another page without an entity id to follow.");
    after = lastId;
  }
}

async function readSubscriptionsPage(account: PaddleAccount, url: string): Promise<{ data: unknown[]; hasMore: boolean }> {
  const doFetch = account.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { authorization: `Bearer ${account.apiKey}`, "paddle-version": "1" },
    });
  } catch {
    throw new PaddleReadError("Paddle could not be reached.");
  }
  if (!response.ok) throw new PaddleReadError(`Paddle returned ${response.status} when listing subscriptions.`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new PaddleReadError("Paddle returned a subscription list that was not JSON.");
  }
  if (!isRecord(json) || !Array.isArray(json.data)) throw new PaddleReadError("Paddle returned no subscription data array.");
  const meta = isRecord(json.meta) ? json.meta : undefined;
  const pagination = meta && isRecord(meta.pagination) ? meta.pagination : undefined;
  return { data: json.data, hasMore: pagination?.has_more === true };
}

const STATUS_RANK: Record<SubscriptionStatus, number> = { active: 0, trialing: 0, past_due: 1, paused: 2, canceled: 3 };

/**
 * Elects the one subscription a workspace stores. The order uses only Paddle's
 * own fields, so the same Paddle state picks the same subscription whatever
 * order the events arrived in. A subscription that grants Pro outranks one that
 * does not, which keeps a canceled subscription from displacing a paying one.
 */
export function chooseSubscription(candidates: readonly [PaddleSubscription, ...PaddleSubscription[]], now: Date): PaddleSubscription {
  const [first, ...rest] = candidates;
  let best = first;
  for (const candidate of rest) if (precedes(candidate, best, now)) best = candidate;
  return best;
}

function precedes(left: PaddleSubscription, right: PaddleSubscription, now: Date): boolean {
  const leftPro = hasPro(left.status, left.currentPeriodEnd, now);
  const rightPro = hasPro(right.status, right.currentPeriodEnd, now);
  if (leftPro !== rightPro) return leftPro;
  const rank = STATUS_RANK[left.status] - STATUS_RANK[right.status];
  if (rank !== 0) return rank < 0;
  const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (created !== 0) return created > 0;
  return left.subscriptionId > right.subscriptionId;
}

function priceOf(item: unknown): string | undefined {
  if (!isRecord(item) || !isRecord(item.price)) return undefined;
  return typeof item.price.id === "string" ? item.price.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a workspace gets Pro. active, trialing and past_due do (past_due is
 * Paddle's dunning window, so we keep access while it retries payment).
 * canceled keeps Pro until the paid period ends, if there is one. paused does not.
 */
export function hasPro(status: SubscriptionStatus, currentPeriodEnd: string | null, now: Date = new Date()): boolean {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
      return true;
    case "canceled": {
      if (!currentPeriodEnd) return false;
      const end = Date.parse(currentPeriodEnd);
      return Number.isFinite(end) && now.getTime() < end;
    }
    case "paused":
      return false;
  }
}

export interface CheckoutOptions {
  apiKey: string;
  environment: PaddleEnvironment;
  priceId: string;
  seats: number;
  workspaceId: string;
  /**
   * Paddle customer id (ctm_...). A transaction takes a customer id, not an
   * email, so to prefill the email create or look up the customer first.
   * Without one, the customer types their email at checkout.
   */
  customerId?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * Creates a Paddle transaction tagged with the workspace id and returns its
 * checkout URL. Paddle builds that URL from the account's default payment link
 * plus `?_ptxn=<transaction id>`. The default payment link must be a page on a
 * domain approved in Paddle (Website approval) and that page must load
 * Paddle.js, which opens the checkout for the transaction in the URL. To keep
 * Paddle.js off the main app, point the default payment link at a separate
 * page, for example a small pay page on its own path or subdomain.
 */
export interface PortalSessionOptions {
  apiKey: string;
  environment: PaddleEnvironment;
  customerId: string;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * Opens Paddle's customer portal for one customer and returns the URL to
 * send them to. The browser only ever opens the returned URL; the session
 * itself is created here, with the existing Paddle key and environment.
 */
export async function createPortalSession(options: PortalSessionOptions): Promise<{ portalUrl: string }> {
  if (!options.customerId) throw new Error("A customer id is needed for a portal session.");
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(
    `${PADDLE_API[options.environment]}/customers/${encodeURIComponent(options.customerId)}/portal-sessions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        "paddle-version": "1",
      },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) throw new Error(`Paddle returned ${response.status} when creating a portal session.`);
  const json: unknown = await response.json();
  const data = isRecord(json) && isRecord(json.data) ? json.data : undefined;
  const direct = data && typeof data.url === "string" ? data.url : undefined;
  const nested =
    data && isRecord(data.urls) && isRecord(data.urls.general) && typeof data.urls.general.overview === "string"
      ? (data.urls.general.overview as string)
      : undefined;
  const portalUrl = direct ?? nested;
  if (!portalUrl) throw new Error("Paddle did not return a portal URL.");
  return { portalUrl };
}

export async function createCheckout(options: CheckoutOptions): Promise<{ transactionId: string; checkoutUrl: string }> {
  if (!Number.isInteger(options.seats) || options.seats < 1) throw new Error("Seats must be a whole number of at least 1.");
  const body: Record<string, unknown> = {
    items: [{ price_id: options.priceId, quantity: options.seats }],
    custom_data: { workspace_id: options.workspaceId },
  };
  if (options.customerId) body.customer_id = options.customerId;

  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${PADDLE_API[options.environment]}/transactions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      "paddle-version": "1",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Paddle returned ${response.status} when creating a transaction.`);
  const json: unknown = await response.json();
  const data = isRecord(json) && isRecord(json.data) ? json.data : undefined;
  const transactionId = data?.id;
  const checkoutUrl = data && isRecord(data.checkout) ? data.checkout.url : undefined;
  if (typeof transactionId !== "string" || typeof checkoutUrl !== "string") {
    throw new Error("Paddle did not return a checkout URL. Check the default payment link is set and approved.");
  }
  return { transactionId, checkoutUrl };
}
