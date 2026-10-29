import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCommentary, commentaryClient, MODEL, type CommentaryOptions, type CommentarySpender } from "../server/commentary.ts";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import type { BridgeConfig, BridgeResult } from "../src/engine.ts";
import { parseSummary, summarize } from "../src/summary.ts";
import { testDatabase } from "./support/d1.ts";

const config: BridgeConfig = {
  table: "t", periodColumn: "period", prior: "2025", current: "2026",
  unitsColumn: "units", salesColumn: "sales",
  levels: [{ name: "Design", columns: ["design"] }, { name: "Material", columns: ["material"] }],
};
const result: BridgeResult = {
  priorSales: 1_000_000.4,
  currentSales: 1_100_000.6,
  effects: [
    { key: "volume", label: "Volume", value: 60_000.2 },
    { key: "price", label: "Price (like-for-like)", value: 40_000 },
  ],
  coverage: [
    { level: 0, label: "Total", cells: 1, sales: 50_000, share: 0.05 },
    { level: 2, label: "Exact configuration", cells: 10, sales: 950_000, share: 0.95123 },
  ],
  cellsTable: "bridge_cells",
};

test("the summary holds rounded totals and names, nothing else", () => {
  const summary = summarize(result, config);
  assert.deepEqual(summary, {
    measure: "Sales",
    prior: "2025",
    current: "2026",
    priorTotal: 1_000_000,
    currentTotal: 1_100_001,
    effects: [
      { label: "Volume", value: 60_001 },
      { label: "Price (like-for-like)", value: 40_000 },
    ],
    attributes: ["Design", "Material"],
    exactMatchShare: 0.951,
    newAndDiscontinued: "difference",
  });
  assert.equal(
    summary.priorTotal + summary.effects.reduce((sum, effect) => sum + effect.value, 0),
    summary.currentTotal,
  );
});

test("only an exact summary passes the server's check", () => {
  const summary = summarize(result, config);
  assert.deepEqual(parseSummary(summary), summary);
  assert.equal(parseSummary({ ...summary, rows: [{ customer: "A" }] }), null);
  assert.equal(parseSummary({ ...summary, effects: [{ label: "Volume", value: 1, customer: "A" }] }), null);
  assert.equal(parseSummary({ ...summary, prior: "x".repeat(500) }), null);
  assert.equal(parseSummary({ ...summary, priorTotal: "1000" }), null);
  assert.equal(parseSummary({ ...summary, exactMatchShare: 2 }), null);
  assert.equal(parseSummary([summary]), null);
});

function fakeClient(reply: { stop_reason: string; text: string }) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { model: params.model, stop_reason: reply.stop_reason, content: [{ type: "text", text: reply.text }] };
        },
      },
    },
  } as unknown as CommentaryOptions["client"];
  return { client, calls };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/commentary", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

const DAY = "2026-10-27";
const dayNow = () => new Date(`${DAY}T12:00:00Z`);
const summaryPayload = { summary: summarize(result, config) };

// The stand-in enforces the migration's foreign key, so a handler-level spender needs its user row.
async function addMember(db: Env["DB"], id: string): Promise<CommentarySpender> {
  await db
    .prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
    .bind(id, id, `${id}@example.invalid`, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")
    .run();
  return id as CommentarySpender;
}

async function counts(db: Env["DB"]): Promise<{ userId: string; day: string; requests: number }[]> {
  const { results } = await db
    .prepare("SELECT userId, day, requests FROM commentary_daily ORDER BY userId, day")
    .all<{ userId: string; day: string; requests: number }>();
  return results;
}

test("the proxy sends the summary to the model and returns paragraphs", async () => {
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose.\n\nVolume led." });
  const response = await handleCommentary(post({ summary: summarize(result, config) }), { apiKey: "k", client });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { paragraphs: ["Sales rose.", "Volume led."], model: MODEL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-opus-5-5");
  const content = (calls[0].messages as { content: string }[])[0].content;
  assert.match(content, /"priorTotal": 1000000/);
  const system = String(calls[0].system);
  assert.ok(
    system.includes(
      "Every figure is rounded to a whole number, so one line can differ by up to one from its exact value while the lines still add up.",
    ),
    "the request does not say the rounded lines can each differ by one",
  );
  assert.equal(system.includes("The effects add up exactly to the change"), false, "the request still says the lines add up exactly");
});

test("one accepted request makes one upstream attempt", async () => {
  assert.equal(commentaryClient("k").maxRetries, 0);
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose." });
  const response = await handleCommentary(post(summaryPayload), { apiKey: "k", client });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("the proxy refuses anything that is not bridge totals, without calling the model", async () => {
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "x" });
  const options = { apiKey: "k", client };
  assert.equal((await handleCommentary(post({ summary: { rows: [] } }), options)).status, 400);
  assert.equal((await handleCommentary(post("not json"), options)).status, 400);
  assert.equal((await handleCommentary(post("x".repeat(20_000)), options)).status, 413);
  assert.equal((await handleCommentary(new Request("http://localhost/api/commentary"), options)).status, 405);
  const denied = await handleCommentary(post({ summary: summarize(result, config) }), {
    ...options,
    spender: async () => null,
    rateLimit: undefined,
    ledger: testDatabase(),
  });
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);
});

test("a refusal from the model is reported, not shown as commentary", async () => {
  const { client } = fakeClient({ stop_reason: "refusal", text: "" });
  const response = await handleCommentary(post({ summary: summarize(result, config) }), { apiKey: "k", client });
  assert.equal(response.status, 502);
});

const DAILY_SENTENCE = "You have reached today's commentary limit. Try again tomorrow.";

test("the hundredth commentary request passes and the hundred-and-first is refused", async () => {
  const db = testDatabase();
  const spender = await addMember(db, "capped-member");
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose." });
  const options = { apiKey: "k", client, spender: async () => spender, rateLimit: undefined, ledger: db, now: dayNow };
  for (let n = 0; n < 100; n += 1) {
    const response = await handleCommentary(post(summaryPayload), options);
    assert.equal(response.status, 200, `request ${n + 1} was refused`);
  }
  const refused = await handleCommentary(post(summaryPayload), options);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: DAILY_SENTENCE });
  assert.equal(calls.length, 100);
  assert.deepEqual(await counts(db), [{ userId: spender, day: DAY, requests: 100 }]);
});

test("a new UTC day starts at zero", async () => {
  const db = testDatabase();
  const spender = await addMember(db, "next-day-member");
  await db.prepare("INSERT INTO commentary_daily (userId, day, requests) VALUES (?, ?, 100)").bind(spender, DAY).run();
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose." });
  const response = await handleCommentary(post(summaryPayload), {
    apiKey: "k", client, spender: async () => spender, rateLimit: undefined, ledger: db,
    now: () => new Date("2026-10-28T00:00:00Z"),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(await counts(db), [
    { userId: spender, day: DAY, requests: 100 },
    { userId: spender, day: "2026-10-28", requests: 1 },
  ]);
});

test("one member's day does not use another member's", async () => {
  const db = testDatabase();
  const capped = await addMember(db, "first-member");
  const fresh = await addMember(db, "second-member");
  await db.prepare("INSERT INTO commentary_daily (userId, day, requests) VALUES (?, ?, 100)").bind(capped, DAY).run();
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose." });
  const response = await handleCommentary(post(summaryPayload), {
    apiKey: "k", client, spender: async () => fresh, rateLimit: undefined, ledger: db, now: dayNow,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(await counts(db), [
    { userId: capped, day: DAY, requests: 100 },
    { userId: fresh, day: DAY, requests: 1 },
  ]);
});

test("two requests at the hundredth slot give one pass and one refusal", async () => {
  const db = testDatabase();
  const spender = await addMember(db, "racing-member");
  await db.prepare("INSERT INTO commentary_daily (userId, day, requests) VALUES (?, ?, 99)").bind(spender, DAY).run();
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose." });
  const options = { apiKey: "k", client, spender: async () => spender, rateLimit: undefined, ledger: db, now: dayNow };
  const responses = await Promise.all([handleCommentary(post(summaryPayload), options), handleCommentary(post(summaryPayload), options)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
  assert.equal(calls.length, 1);
  assert.deepEqual(await counts(db), [{ userId: spender, day: DAY, requests: 100 }]);
});

test("a request the per-minute limit refuses is not counted", async () => {
  const db = testDatabase();
  const spender = await addMember(db, "quick-member");
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose." });
  const response = await handleCommentary(post(summaryPayload), {
    apiKey: "k",
    client,
    spender: async () => spender,
    rateLimit: {
      async limit() {
        return { success: false };
      },
    },
    ledger: db,
    now: dayNow,
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "You are sending commentary requests too quickly." });
  assert.equal(calls.length, 0);
  assert.deepEqual(await counts(db), []);
});

const SITE = "http://127.0.0.1:8790";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const PRO_ENV = { ACCOUNTS: "on", LOCAL_EMAIL_LOG: "on", ANTHROPIC_API_KEY: "sk-ant-fake-not-a-real-key" } as const;

let clients = 0;

function clientIp(): string {
  clients += 1;
  return `203.0.113.${(clients % 254) + 1}`;
}

// Better Auth reads pragma_table_info through D1 batch. The shared stand-in
// answers batch with run(), which drops those rows, and sign-in then answers 500.
function database(): Env["DB"] {
  const db = testDatabase();
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    exec: (sql) => db.exec(sql),
  };
}

function workerEnv(db: Env["DB"], extra: Partial<Env> = {}): Env {
  const assets: Fetcher = {
    async fetch() {
      return new Response("missing", { status: 500 });
    },
  };
  return {
    ASSETS: assets,
    DB: db,
    BETTER_AUTH_URL: SITE,
    BETTER_AUTH_SECRET: AUTH_SECRET,
    ...extra,
  };
}

function refusingLimiter(calls: { key: string; success: boolean }[]): NonNullable<Env["COMMENTARY_RATE_LIMIT"]> {
  return {
    async limit({ key }) {
      calls.push({ key, success: false });
      return { success: false };
    },
  };
}

function authPrefix(baseURL: string): string {
  const pathname = new URL(baseURL).pathname;
  return pathname === "/" ? "/api/auth" : pathname.replace(/\/+$/, "");
}

async function dispatch(env: Env, request: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(request, env, {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  });
  await Promise.all(pending);
  return response;
}

function captureLog(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const previous = { debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  for (const method of ["debug", "info", "log", "warn", "error"] as const) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  return {
    lines,
    restore() {
      Object.assign(console, previous);
    },
  };
}

function fenceAnthropic(): { urls: string[]; restore(): void } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    if (new URL(url).hostname === "api.anthropic.com") {
      urls.push(url);
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: MODEL,
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [{ type: "text", text: "Sales rose.\n\nVolume led." }],
      });
    }
    return original(input, init);
  };
  return {
    urls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function signInMember(
  env: Env,
  email: string,
  slug: string,
  pro: boolean,
): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const prefix = authPrefix(env.BETTER_AUTH_URL);
  const recorded = captureLog();
  try {
    const signIn = await dispatch(
      env,
      new Request(`${origin}${prefix}/sign-in/magic-link`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "x-forwarded-for": clientIp() },
        body: JSON.stringify({ email, callbackURL: `${origin}/app/` }),
      }),
    );
    assert.equal(signIn.status, 200, await signIn.text());
    const link = recorded.lines
      .join("\n")
      .match(new RegExp(`${origin.replaceAll(".", "\\.")}${prefix.replaceAll("/", "\\/")}/magic-link/verify\\?\\S+`))?.[0];
    assert.ok(link, "the sign-in link was not written to the log");
    const verified = await dispatch(env, new Request(link, { headers: { origin, "x-forwarded-for": clientIp() } }));
    assert.equal(verified.status, 302, await verified.text());
    const cookie = verified.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.notEqual(cookie, "", "the verification set no session cookie");
    const created = await dispatch(
      env,
      new Request(`${origin}${prefix}/organization/create`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", cookie, "x-forwarded-for": clientIp() },
        body: JSON.stringify({ name: slug, slug }),
      }),
    );
    const createdBody = await created.text();
    assert.equal(created.status, 200, createdBody);
    const workspaceId = (JSON.parse(createdBody) as { id: string }).id;
    if (pro) {
      await env.DB
        .prepare(
          "INSERT INTO subscription VALUES (?, 'sub_review', 'ctm_review', 'active', 'pri_review', 2, '2099-01-01T00:00:00Z', '2026-10-12T00:00:00Z')",
        )
        .bind(workspaceId)
        .run();
    }
    const user = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
    assert.ok(user);
    return { cookie, userId: user.id, workspaceId };
  } finally {
    recorded.restore();
  }
}

function commentaryRequest(cookie: string | undefined, headers: Record<string, string>, body: string): Request {
  const all: Record<string, string> = { "content-type": "application/json", ...headers };
  if (cookie !== undefined) all.cookie = cookie;
  return new Request(`${SITE}/api/commentary`, { method: "POST", headers: all, body });
}

const summaryBody = JSON.stringify({ summary: summarize(result, config) });

async function proCommentary(email: string, slug: string, headers: Record<string, string>): Promise<{ status: number; body: unknown; calls: number }> {
  const env = workerEnv(database(), PRO_ENV);
  const fence = fenceAnthropic();
  try {
    const { cookie } = await signInMember(env, email, slug, true);
    const response = await dispatch(env, commentaryRequest(cookie, headers, summaryBody));
    return { status: response.status, body: await response.json(), calls: fence.urls.length };
  } finally {
    fence.restore();
  }
}

test("a Pro commentary post from another origin does not call the model", async () => {
  assert.deepEqual(await proCommentary("pro-foreign@example.invalid", "pro-foreign", { origin: "https://evil.example" }), {
    status: 403,
    body: { error: "Requests must come from this site." },
    calls: 0,
  });
});

test("a Pro commentary post with no origin does not call the model", async () => {
  assert.deepEqual(await proCommentary("pro-missing@example.invalid", "pro-missing", {}), {
    status: 403,
    body: { error: "Requests must come from this site." },
    calls: 0,
  });
});

test("a Pro commentary post with an empty origin does not call the model", async () => {
  assert.deepEqual(await proCommentary("pro-empty@example.invalid", "pro-empty", { origin: "" }), {
    status: 403,
    body: { error: "Requests must come from this site." },
    calls: 0,
  });
});

const PRO_SENTENCE = "AI commentary is part of Pro. Sign in to a workspace with Pro to use it.";

test("a signed-out commentary post from another origin is refused as cross-site", async () => {
  const env = workerEnv(database(), PRO_ENV);
  const fence = fenceAnthropic();
  try {
    const response = await dispatch(env, commentaryRequest(undefined, { origin: "https://evil.example" }, summaryBody));
    assert.deepEqual(
      { status: response.status, body: await response.json(), calls: fence.urls.length },
      { status: 403, body: { error: "Requests must come from this site." }, calls: 0 },
    );
  } finally {
    fence.restore();
  }
});

test("a signed-out commentary post from this site stays on the Pro refusal", async () => {
  const limiterCalls: { key: string; success: boolean }[] = [];
  const env = workerEnv(database(), { ...PRO_ENV, COMMENTARY_RATE_LIMIT: refusingLimiter(limiterCalls) });
  const fence = fenceAnthropic();
  try {
    const response = await dispatch(env, commentaryRequest(undefined, { origin: SITE }, summaryBody));
    assert.deepEqual(
      { status: response.status, body: await response.json(), calls: fence.urls.length, limiterCalls },
      { status: 403, body: { error: PRO_SENTENCE }, calls: 0, limiterCalls: [] },
    );
  } finally {
    fence.restore();
  }
});

test("a same-origin commentary post from a member without Pro stays on the Pro refusal", async () => {
  const limiterCalls: { key: string; success: boolean }[] = [];
  const env = workerEnv(database(), { ...PRO_ENV, COMMENTARY_RATE_LIMIT: refusingLimiter(limiterCalls) });
  const fence = fenceAnthropic();
  try {
    const { cookie } = await signInMember(env, "free@example.invalid", "free-member", false);
    const response = await dispatch(env, commentaryRequest(cookie, { origin: SITE }, summaryBody));
    assert.deepEqual(
      { status: response.status, body: await response.json(), calls: fence.urls.length, limiterCalls },
      { status: 403, body: { error: PRO_SENTENCE }, calls: 0, limiterCalls: [] },
    );
  } finally {
    fence.restore();
  }
});

test("a same-origin Pro post with no API key stays on the Pro refusal", async () => {
  const limiterCalls: { key: string; success: boolean }[] = [];
  const env = workerEnv(database(), {
    ACCOUNTS: "on",
    LOCAL_EMAIL_LOG: "on",
    COMMENTARY_RATE_LIMIT: refusingLimiter(limiterCalls),
  });
  const fence = fenceAnthropic();
  try {
    const { cookie } = await signInMember(env, "pro-no-key@example.invalid", "pro-no-key", true);
    const response = await dispatch(env, commentaryRequest(cookie, { origin: SITE }, summaryBody));
    assert.deepEqual(
      { status: response.status, body: await response.json(), calls: fence.urls.length, limiterCalls },
      { status: 403, body: { error: PRO_SENTENCE }, calls: 0, limiterCalls: [] },
    );
  } finally {
    fence.restore();
  }
});

test("commentary is not found when accounts are off", async () => {
  const limiterCalls: { key: string; success: boolean }[] = [];
  const env = workerEnv(database(), { COMMENTARY_RATE_LIMIT: refusingLimiter(limiterCalls) });
  const fence = fenceAnthropic();
  try {
    const response = await dispatch(env, commentaryRequest(undefined, { origin: "https://evil.example" }, summaryBody));
    assert.deepEqual(
      { status: response.status, body: await response.json(), calls: fence.urls.length, limiterCalls },
      { status: 404, body: { error: "Not found." }, calls: 0, limiterCalls: [] },
    );
  } finally {
    fence.restore();
  }
});

test("GET commentary from another origin is not found", async () => {
  const env = workerEnv(database(), PRO_ENV);
  const fence = fenceAnthropic();
  try {
    const response = await dispatch(env, new Request(`${SITE}/api/commentary`, { headers: { origin: "https://evil.example" } }));
    assert.deepEqual(
      { status: response.status, body: await response.json(), calls: fence.urls.length },
      { status: 404, body: { error: "Not found." }, calls: 0 },
    );
  } finally {
    fence.restore();
  }
});

test("a workspace write from another origin is still refused as cross-site", async () => {
  const env = workerEnv(database(), PRO_ENV);
  const response = await dispatch(
    env,
    new Request(`${SITE}/api/workspaces/perf-local/setups`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Requests must come from this site." });
});

test("a Pro commentary request through the route is counted for today", async () => {
  const env = workerEnv(database(), PRO_ENV);
  const fence = fenceAnthropic();
  try {
    const { cookie, userId } = await signInMember(env, "pro-counted@example.invalid", "pro-counted", true);
    const response = await dispatch(env, commentaryRequest(cookie, { origin: SITE }, summaryBody));
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(fence.urls.length, 1);
    assert.deepEqual(await counts(env.DB), [{ userId, day: new Date().toISOString().slice(0, 10), requests: 1 }]);
  } finally {
    fence.restore();
  }
});

test("a Pro commentary request through the route at the cap is refused with the sentence", async () => {
  const env = workerEnv(database(), PRO_ENV);
  const fence = fenceAnthropic();
  try {
    const { cookie, userId } = await signInMember(env, "pro-at-cap@example.invalid", "pro-at-cap", true);
    await env.DB
      .prepare("INSERT INTO commentary_daily (userId, day, requests) VALUES (?, ?, 100)")
      .bind(userId, new Date().toISOString().slice(0, 10))
      .run();
    const response = await dispatch(env, commentaryRequest(cookie, { origin: SITE }, summaryBody));
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: DAILY_SENTENCE });
    assert.equal(fence.urls.length, 0);
  } finally {
    fence.restore();
  }
});

test("a member without Pro is not counted", async () => {
  const env = workerEnv(database(), PRO_ENV);
  const fence = fenceAnthropic();
  try {
    const { cookie } = await signInMember(env, "free-uncounted@example.invalid", "free-uncounted", false);
    const response = await dispatch(env, commentaryRequest(cookie, { origin: SITE }, summaryBody));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: PRO_SENTENCE });
    assert.equal(fence.urls.length, 0);
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM commentary_daily").first<{ total: number }>();
    assert.equal(row?.total, 0);
  } finally {
    fence.restore();
  }
});
