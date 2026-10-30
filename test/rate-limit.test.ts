import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { limitMagicLinkSignIn } from "../server/auth.ts";
import type { Fetcher, RateLimit } from "../server/cloudflare.ts";
import { EMAIL_NOT_SET_UP } from "../server/email.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { testDatabase } from "./support/d1.ts";

const ORIGIN = "http://127.0.0.1:8790";
const CLIENT = "192.0.2.10";
const FORWARDED = "198.51.100.24";
const TOO_MANY = { message: "Too many requests. Please try again later." };
const JSON_ONLY = { message: "Content-Type must be application/json." };

type LimitCall = { key: string; success: boolean };
type LimiterConfig = { name: string; namespace_id: string; simple: { limit: number; period: number } };
type EnvWithCommentary = Env & { COMMENTARY_RATE_LIMIT?: RateLimit };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readLimiter(name = "MAGIC_LINK_RATE_LIMIT"): LimiterConfig {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
  assert.ok(isRecord(parsed));
  const listed = parsed.ratelimits;
  assert.ok(Array.isArray(listed));
  assert.deepEqual(
    listed.map((item) => (isRecord(item) ? item.name : undefined)),
    ["MAGIC_LINK_RATE_LIMIT", "COMMENTARY_RATE_LIMIT"],
  );
  const entry = listed.find((item) => isRecord(item) && item.name === name);
  assert.ok(isRecord(entry));
  const simple = entry.simple;
  assert.ok(isRecord(simple));
  const foundName = entry.name;
  const namespaceId = entry.namespace_id;
  const limit = simple.limit;
  const period = simple.period;
  if (typeof foundName !== "string" || typeof namespaceId !== "string" || typeof limit !== "number" || typeof period !== "number") {
    throw new Error("wrangler.jsonc rate limit binding is incomplete");
  }
  assert.equal(foundName, name);
  assert.match(namespaceId, /^[1-9][0-9]*$/);
  assert.equal(period, 60);
  if (name === "MAGIC_LINK_RATE_LIMIT") {
    assert.equal(limit, 3);
  } else if (name === "COMMENTARY_RATE_LIMIT") {
    assert.equal(limit, 5);
    assert.notEqual(namespaceId, "1001");
    const magic = listed.find((item) => isRecord(item) && item.name === "MAGIC_LINK_RATE_LIMIT");
    assert.ok(isRecord(magic));
    assert.equal(typeof magic.namespace_id, "string");
    assert.notEqual(namespaceId, magic.namespace_id);
  } else {
    throw new Error(`unknown rate limit binding ${name}`);
  }
  return { name: foundName, namespace_id: namespaceId, simple: { limit, period } };
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

function bindings(db: Env["DB"], rateLimit: RateLimit | undefined, mail: "local" | "none" = "local", authUrl = ORIGIN): Env {
  const assets: Fetcher = {
    async fetch() {
      return new Response("missing", { status: 500 });
    },
  };
  const env: Env = {
    ASSETS: assets,
    DB: db,
    BETTER_AUTH_URL: authUrl,
    BETTER_AUTH_SECRET: "0122456789abcdef0122456789abcdef",
    ACCOUNTS: "on",
  };
  if (mail === "local") env.LOCAL_EMAIL_LOG = "on";
  if (rateLimit) env.MAGIC_LINK_RATE_LIMIT = rateLimit;
  return env;
}

function limiter(limit: number, calls: LimitCall[]): RateLimit {
  const counts = new Map<string, number>();
  return {
    async limit({ key }) {
      const used = counts.get(key) ?? 0;
      const success = used < limit;
      counts.set(key, used + 1);
      calls.push({ key, success });
      return { success };
    },
  };
}

function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const previous = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const methods = ["debug", "info", "log", "warn", "error"] as const;
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      const text = args.map((arg) => String(arg)).join(" ");
      lines.push(text);
      if (!text.includes("[email]")) previous[method](...args);
    };
  }
  return {
    lines,
    restore() {
      console.debug = previous.debug;
      console.info = previous.info;
      console.log = previous.log;
      console.warn = previous.warn;
      console.error = previous.error;
    },
  };
}

async function withWorker<T>(
  rateLimit: RateLimit | undefined,
  run: (env: Env, db: Env["DB"], lines: string[], urls: string[]) => Promise<T>,
  mail: "local" | "none" = "local",
  authUrl = ORIGIN,
): Promise<T> {
  const db = database();
  const logs = captureConsole();
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    urls.push(url);
    return original(input, init);
  };
  try {
    return await run(bindings(db, rateLimit, mail, authUrl), db, logs.lines, urls);
  } finally {
    globalThis.fetch = original;
    logs.restore();
  }
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

async function call(url: string, env: Env, init: RequestInit = {}): Promise<Response> {
  return dispatch(env, new Request(url, init));
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return "";
  return JSON.parse(text);
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: ORIGIN, "content-type": "application/json", ...extra };
}

function validBody(email: string): string {
  return JSON.stringify({ email, callbackURL: `${ORIGIN}/app/` });
}

async function signIn(env: Env, body: string, headers: Record<string, string>, url = `${ORIGIN}/api/auth/sign-in/magic-link`): Promise<Response> {
  return call(url, env, { method: "POST", headers, body });
}

function emailCount(lines: string[]): number {
  return lines.filter((line) => line.includes("[email]")).length;
}

async function countRows(db: Env["DB"], table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>();
  assert.ok(row);
  return row.n;
}

async function assertNoRateLimitTable(db: Env["DB"]): Promise<void> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('verification', 'rateLimit') ORDER BY name")
    .all<{ name: string }>();
  assert.deepEqual(
    rows.results.map((row) => row.name),
    ["verification"],
  );
}

function assertQuiet(lines: string[], urls: string[], hidden: readonly string[]): void {
  assert.deepEqual(
    urls.filter((url) => url.startsWith("https://api.resend.com")),
    [],
  );
  for (const secret of hidden) assert.equal(lines.some((line) => line.includes(secret)), false);
}

async function limited(): Promise<void> {
  const limit = readLimiter().simple.limit;
  const calls: LimitCall[] = [];
  await withWorker(limiter(limit, calls), async (env, db, lines, urls) => {
    const accepted = [];
    for (let index = 0; index < limit; index += 1) {
      const response = await signIn(env, validBody(`allowed${index}@example.invalid`), jsonHeaders({ "cf-connecting-ip": CLIENT }));
      accepted.push({ status: response.status, body: await response.json() });
    }
    const before = { rows: await countRows(db, "verification"), emails: emailCount(lines) };
    const refused = await signIn(env, validBody("refused@example.invalid"), jsonHeaders({ "cf-connecting-ip": CLIENT }));
    assert.deepEqual(
      {
        accepted,
        refusal: {
          status: refused.status,
          body: await refused.json(),
          retryAfter: refused.headers.get("x-retry-after"),
        },
        calls,
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      {
        accepted: Array.from({ length: limit }, () => ({ status: 200, body: { status: true } })),
        refusal: { status: 429, body: TOO_MANY, retryAfter: null },
        calls: [...Array.from({ length: limit }, () => ({ key: CLIENT, success: true })), { key: CLIENT, success: false }],
        rows: before.rows,
        emails: before.emails,
      },
    );
    assert.equal(before.rows, limit);
    assert.equal(before.emails, limit);
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  });
}

/** A base URL whose path keeps the auth routes under the Worker's /api/auth mount. */
const MOVED_PREFIX = "/api/auth/app";

/**
 * Better Auth mounts its endpoints under the pathname of its base URL, so a
 * BETTER_AUTH_URL that carries a path moves the magic-link sign-in route. The
 * moved route owes the same limit and the same 429 as the route it moved from.
 */
async function movedRoute(): Promise<void> {
  const limit = readLimiter().simple.limit;
  const calls: LimitCall[] = [];
  const authUrl = `${ORIGIN}${MOVED_PREFIX}`;
  await withWorker(limiter(limit, calls), async (env, db, lines, urls) => {
    const moved = `${authUrl}/sign-in/magic-link`;
    const accepted = [];
    for (let index = 0; index < limit; index += 1) {
      const response = await signIn(env, validBody(`moved${index}@example.invalid`), jsonHeaders({ "cf-connecting-ip": CLIENT }), moved);
      accepted.push({ status: response.status, body: await response.json() });
    }
    const before = { rows: await countRows(db, "verification"), emails: emailCount(lines) };
    const refused = await signIn(env, validBody("moved-over@example.invalid"), jsonHeaders({ "cf-connecting-ip": CLIENT }), moved);
    assert.deepEqual(
      {
        accepted,
        refusal: { status: refused.status, body: await refused.json(), retryAfter: refused.headers.get("x-retry-after") },
        calls,
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      {
        accepted: Array.from({ length: limit }, () => ({ status: 200, body: { status: true } })),
        refusal: { status: 429, body: TOO_MANY, retryAfter: null },
        calls: [...Array.from({ length: limit }, () => ({ key: CLIENT, success: true })), { key: CLIENT, success: false }],
        rows: before.rows,
        emails: before.emails,
      },
    );
    assert.equal(before.rows, limit);
    assert.equal(before.emails, limit);
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  }, "local", authUrl);
}

/**
 * The limiter itself, for a base path the Worker does not mount under /api:
 * the moved route spends a slot and answers the same 429 the unmoved one does.
 */
async function movedAnywhere(): Promise<void> {
  const limit = readLimiter().simple.limit;
  const calls: LimitCall[] = [];
  const rateLimit = limiter(limit, calls);
  const moved = `${ORIGIN}/app/sign-in/magic-link`;
  const outcomes = [];
  for (let index = 0; index <= limit; index += 1) {
    const refusal = await limitMagicLinkSignIn(
      new Request(moved, { method: "POST", headers: jsonHeaders({ "cf-connecting-ip": CLIENT }), body: validBody(`elsewhere${index}@example.invalid`) }),
      rateLimit,
    );
    outcomes.push(refusal === null ? null : { status: refusal.status, body: await refusal.json(), retryAfter: refusal.headers.get("x-retry-after") });
  }
  assert.deepEqual(outcomes, [
    ...Array.from({ length: limit }, () => null),
    { status: 429, body: TOO_MANY, retryAfter: null },
  ]);
}

async function jsonx(): Promise<void> {
  const limit = readLimiter().simple.limit;
  const calls: LimitCall[] = [];
  await withWorker(limiter(limit, calls), async (env, db, lines, urls) => {
    const accepted = [];
    for (let index = 0; index < limit; index += 1) {
      const response = await signIn(env, validBody(`json${index}@example.invalid`), jsonHeaders({ "cf-connecting-ip": CLIENT }));
      accepted.push({ status: response.status, body: await response.json() });
    }
    const before = { rows: await countRows(db, "verification"), emails: emailCount(lines) };
    const refused = await signIn(
      env,
      validBody("jsonx@example.invalid"),
      jsonHeaders({ "cf-connecting-ip": CLIENT, "content-type": "application/jsonx" }),
    );
    assert.deepEqual(
      {
        accepted,
        refusal: { status: refused.status, body: await refused.json() },
        calls,
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      {
        accepted: Array.from({ length: limit }, () => ({ status: 200, body: { status: true } })),
        refusal: { status: 415, body: JSON_ONLY },
        calls: Array.from({ length: limit }, () => ({ key: CLIENT, success: true })),
        rows: before.rows,
        emails: before.emails,
      },
    );
    assert.equal(before.rows, limit);
    assert.equal(before.emails, limit);
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  });
}

const LIBRARY_EMAIL = { message: "[body.email] Invalid email address", code: "VALIDATION_ERROR" };
const LIBRARY_TOKEN = { message: "[query.token] Invalid input: expected string, received undefined", code: "VALIDATION_ERROR" };
const SECOND = "192.0.2.11";

async function refuses(send: (env: Env) => Promise<Response>, expected: { status: number; body: unknown }, hidden: readonly string[] = [CLIENT]): Promise<void> {
  const calls: LimitCall[] = [];
  await withWorker(limiter(readLimiter().simple.limit, calls), async (env, db, lines, urls) => {
    const response = await send(env);
    assert.deepEqual(
      {
        status: response.status,
        body: await responseBody(response),
        calls,
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      { status: expected.status, body: expected.body, calls: [], rows: 0, emails: 0 },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, hidden);
  });
}

async function untilLimited(send: (env: Env, index: number) => Promise<Response>, hidden: readonly string[] = [CLIENT]): Promise<void> {
  const limit = readLimiter().simple.limit;
  const calls: LimitCall[] = [];
  await withWorker(limiter(limit, calls), async (env, db, lines, urls) => {
    const accepted = [];
    for (let index = 0; index < limit; index += 1) {
      const response = await send(env, index);
      accepted.push({ status: response.status, body: await response.json() });
    }
    const before = { rows: await countRows(db, "verification"), emails: emailCount(lines) };
    const refused = await send(env, limit);
    assert.deepEqual(
      {
        accepted,
        refusal: { status: refused.status, body: await refused.json(), retryAfter: refused.headers.get("x-retry-after") },
        calls,
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      {
        accepted: Array.from({ length: limit }, () => ({ status: 200, body: { status: true } })),
        refusal: { status: 429, body: TOO_MANY, retryAfter: null },
        calls: [...Array.from({ length: limit }, () => ({ key: CLIENT, success: true })), { key: CLIENT, success: false }],
        rows: before.rows,
        emails: before.emails,
      },
    );
    assert.equal(before.rows, limit);
    assert.equal(before.emails, limit);
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, hidden);
  });
}

async function jsonXml(): Promise<void> {
  await refuses(
    (env) => signIn(env, validBody("xml@example.invalid"), jsonHeaders({ "cf-connecting-ip": CLIENT, "content-type": "application/json+xml" })),
    { status: 415, body: JSON_ONLY },
  );
}

async function getSignIn(): Promise<void> {
  await refuses(
    (env) => call(`${ORIGIN}/api/auth/sign-in/magic-link`, env, { method: "GET", headers: jsonHeaders({ "cf-connecting-ip": CLIENT }) }),
    { status: 404, body: "" },
  );
}

async function putSignIn(): Promise<void> {
  await refuses(
    (env) =>
      call(`${ORIGIN}/api/auth/sign-in/magic-link`, env, {
        method: "PUT",
        headers: jsonHeaders({ "cf-connecting-ip": CLIENT }),
        body: validBody("put@example.invalid"),
      }),
    { status: 404, body: { error: "Not found." } },
  );
}

async function extraField(): Promise<void> {
  await untilLimited((env, index) =>
    signIn(
      env,
      JSON.stringify({ email: `extra${index}@example.invalid`, callbackURL: `${ORIGIN}/app/`, note: "extra" }),
      jsonHeaders({ "cf-connecting-ip": CLIENT }),
    ),
  );
}

async function largeSignIn(): Promise<void> {
  const padding = "x".repeat(2 * 1024 * 1024);
  await untilLimited((env, index) =>
    signIn(
      env,
      JSON.stringify({ email: `large${index}@example.invalid`, callbackURL: `${ORIGIN}/app/`, padding }),
      jsonHeaders({ "cf-connecting-ip": CLIENT }),
    ),
  );
}

async function charsetSignIn(): Promise<void> {
  await untilLimited((env, index) =>
    signIn(
      env,
      validBody(`charset${index}@example.invalid`),
      jsonHeaders({ "cf-connecting-ip": CLIENT, "content-type": "application/json; charset=iso-8859-1" }),
    ),
  );
}

async function deletedType(): Promise<void> {
  await refuses((env) => {
    const request = new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { origin: ORIGIN, "cf-connecting-ip": CLIENT },
      body: validBody("deleted@example.invalid"),
    });
    request.headers.delete("content-type");
    return dispatch(env, request);
  }, { status: 415, body: JSON_ONLY });
}

async function plainText(): Promise<void> {
  await refuses(
    (env) => signIn(env, validBody("plain@example.invalid"), jsonHeaders({ "cf-connecting-ip": CLIENT, "content-type": "text/plain" })),
    { status: 415, body: JSON_ONLY },
  );
}

async function formSignIn(): Promise<void> {
  await refuses(
    (env) =>
      signIn(
        env,
        `email=${encodeURIComponent("form@example.invalid")}&callbackURL=${encodeURIComponent(`${ORIGIN}/app/`)}`,
        jsonHeaders({ "cf-connecting-ip": CLIENT, "content-type": "application/x-www-form-urlencoded" }),
      ),
    { status: 415, body: JSON_ONLY },
  );
}

async function trailingSlash(): Promise<void> {
  await refuses(
    (env) => signIn(env, validBody("slash@example.invalid"), jsonHeaders({ "cf-connecting-ip": CLIENT }), `${ORIGIN}/api/auth/sign-in/magic-link/`),
    { status: 404, body: "" },
  );
}

async function querySignIn(): Promise<void> {
  await untilLimited((env, index) =>
    signIn(env, validBody(`query${index}@example.invalid`), jsonHeaders({ "cf-connecting-ip": CLIENT }), `${ORIGIN}/api/auth/sign-in/magic-link?source=test`),
  );
}

async function verifyLink(): Promise<void> {
  await refuses(
    (env) => call(`${ORIGIN}/api/auth/magic-link/verify`, env, { method: "GET", headers: { origin: ORIGIN, "cf-connecting-ip": CLIENT } }),
    { status: 400, body: LIBRARY_TOKEN },
  );
}

async function twoClients(): Promise<void> {
  const limit = readLimiter().simple.limit;
  const calls: LimitCall[] = [];
  await withWorker(limiter(limit, calls), async (env, db, lines, urls) => {
    const accepted = [];
    for (const client of [CLIENT, SECOND]) {
      for (let index = 0; index < limit; index += 1) {
        const response = await signIn(env, validBody(`${client === CLIENT ? "first" : "second"}${index}@example.invalid`), jsonHeaders({ "cf-connecting-ip": client }));
        accepted.push({ client, status: response.status, body: await response.json() });
      }
    }
    const refusals = [];
    for (const client of [CLIENT, SECOND]) {
      const response = await signIn(env, validBody(`${client === CLIENT ? "first" : "second"}-over@example.invalid`), jsonHeaders({ "cf-connecting-ip": client }));
      refusals.push({
        client,
        status: response.status,
        body: await response.json(),
        retryAfter: response.headers.get("x-retry-after"),
      });
    }
    assert.deepEqual(
      { accepted, refusals, calls, rows: await countRows(db, "verification"), emails: emailCount(lines) },
      {
        accepted: [CLIENT, SECOND].flatMap((client) => Array.from({ length: limit }, () => ({ client, status: 200, body: { status: true } }))),
        refusals: [CLIENT, SECOND].map((client) => ({ client, status: 429, body: TOO_MANY, retryAfter: null })),
        calls: [
          ...[CLIENT, SECOND].flatMap((client) => Array.from({ length: limit }, () => ({ key: client, success: true }))),
          ...[CLIENT, SECOND].map((client) => ({ key: client, success: false })),
        ],
        rows: limit * 2,
        emails: limit * 2,
      },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT, SECOND]);
  });
}

async function forwardedIp(): Promise<void> {
  await untilLimited(
    (env, index) =>
      signIn(
        env,
        validBody(`forward${index}@example.invalid`),
        jsonHeaders({
          "cf-connecting-ip": CLIENT,
          "x-forwarded-for": `198.51.100.${index}`,
          "x-real-ip": `203.0.113.${index}`,
        }),
      ),
    [CLIENT, "198.51.100.", "203.0.113."],
  );
}

async function throwingLimit(): Promise<void> {
  const rateLimit: RateLimit = {
    async limit() {
      throw new Error("limiter unavailable");
    },
  };
  await withWorker(rateLimit, async (env, db, lines, urls) => {
    const response = await signIn(env, validBody("throw@example.invalid"), jsonHeaders({ "cf-connecting-ip": CLIENT }));
    assert.deepEqual(
      {
        status: response.status,
        body: await response.json(),
        retryAfter: response.headers.get("x-retry-after"),
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      { status: 429, body: TOO_MANY, retryAfter: null, rows: 0, emails: 0 },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  });
}

async function mistyped(): Promise<void> {
  const calls: LimitCall[] = [];
  const bad = JSON.stringify({ email: "not-an-email" });
  await withWorker(limiter(readLimiter().simple.limit, calls), async (env, db, lines, urls) => {
    const attempts = [
      { body: bad, headers: jsonHeaders({ "cf-connecting-ip": CLIENT }) },
      { body: bad, headers: jsonHeaders({ "cf-connecting-ip": CLIENT, "content-type": "application/jsonx" }) },
      { body: bad, headers: jsonHeaders() },
      { body: bad, headers: jsonHeaders({ "content-type": "application/jsonx" }) },
    ];
    const rejected = [];
    for (const attempt of attempts) {
      const response = await signIn(env, attempt.body, attempt.headers);
      rejected.push({ status: response.status, body: await response.json() });
    }
    const accepted = await signIn(env, validBody("accepted@example.invalid"), jsonHeaders({ "cf-connecting-ip": CLIENT }));
    assert.deepEqual(
      {
        rejected,
        accepted: { status: accepted.status, body: await accepted.json() },
        calls,
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      {
        rejected: [
          { status: 400, body: LIBRARY_EMAIL },
          { status: 415, body: JSON_ONLY },
          { status: 400, body: LIBRARY_EMAIL },
          { status: 415, body: JSON_ONLY },
        ],
        accepted: { status: 200, body: { status: true } },
        calls: [{ key: CLIENT, success: true }],
        rows: 1,
        emails: 1,
      },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  });
}

async function rejected(): Promise<void> {
  const calls: LimitCall[] = [];
  await withWorker(limiter(readLimiter().simple.limit, calls), async (env, db, lines, urls) => {
    const headers = jsonHeaders({ "cf-connecting-ip": CLIENT });
    const attempts = [
      { body: JSON.stringify({ email: "not-an-email" }), headers },
      { body: JSON.stringify("not-an-email"), headers },
      { body: JSON.stringify({ email: "named@example.invalid", name: 1 }), headers },
      {
        body: JSON.stringify({ email: "plain@example.invalid" }),
        headers: { ...headers, "content-type": "text/plain" },
      },
      { body: JSON.stringify({}), headers },
      { body: "not json", headers },
    ];
    const statuses: number[] = [];
    for (const attempt of attempts) {
      const response = await signIn(env, attempt.body, attempt.headers);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    const accepted = await signIn(env, validBody("accepted@example.invalid"), headers);
    assert.deepEqual(
      {
        statuses,
        calls,
        accepted: { status: accepted.status, body: await accepted.json() },
        rows: await countRows(db, "verification"),
        emails: emailCount(lines),
      },
      {
        statuses: [400, 400, 400, 415, 400, 400],
        calls: [{ key: CLIENT, success: true }],
        accepted: { status: 200, body: { status: true } },
        rows: 1,
        emails: 1,
      },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  });
}

async function missingIp(): Promise<void> {
  const calls: LimitCall[] = [];
  await withWorker(limiter(readLimiter().simple.limit, calls), async (env, db, lines, urls) => {
    const attempts = [
      jsonHeaders(),
      jsonHeaders({ "cf-connecting-ip": "" }),
      jsonHeaders({ "cf-connecting-ip": "   " }),
      jsonHeaders({ "x-forwarded-for": FORWARDED }),
    ];
    const outcomes = [];
    for (const [index, headers] of attempts.entries()) {
      const response = await signIn(env, validBody(`absent${index}@example.invalid`), headers);
      outcomes.push({
        status: response.status,
        body: await response.json(),
        retryAfter: response.headers.get("x-retry-after"),
      });
    }
    assert.deepEqual(
      { outcomes, calls, rows: await countRows(db, "verification"), emails: emailCount(lines) },
      {
        outcomes: attempts.map(() => ({ status: 429, body: TOO_MANY, retryAfter: null })),
        calls: [],
        rows: 0,
        emails: 0,
      },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT, FORWARDED]);
  });
}

async function unbound(): Promise<void> {
  readLimiter();
  await withWorker(undefined, async (env, db, lines, urls) => {
    const outcomes = [];
    for (let index = 0; index < 6; index += 1) {
      const headers = index === 0 ? jsonHeaders() : jsonHeaders({ "cf-connecting-ip": CLIENT });
      const response = await signIn(env, validBody(`open${index}@example.invalid`), headers);
      outcomes.push({ status: response.status, body: await response.json() });
    }
    assert.deepEqual(
      { outcomes, rows: await countRows(db, "verification"), emails: emailCount(lines) },
      {
        outcomes: Array.from({ length: 6 }, () => ({ status: 200, body: { status: true } })),
        rows: 6,
        emails: 6,
      },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  });
}

async function refusedForNoMail(): Promise<void> {
  const limit = readLimiter().simple.limit;
  const calls: LimitCall[] = [];
  await withWorker(limiter(limit, calls), async (env, db, lines, urls) => {
    const outcomes = [];
    for (let index = 0; index <= limit; index += 1) {
      const response = await signIn(env, validBody(`nomail${index}@example.invalid`), jsonHeaders({ "cf-connecting-ip": CLIENT }));
      outcomes.push({ status: response.status, body: await response.json() });
    }
    assert.deepEqual(
      { outcomes, calls, rows: await countRows(db, "verification"), emails: emailCount(lines) },
      {
        outcomes: Array.from({ length: limit + 1 }, () => ({ status: 503, body: { message: EMAIL_NOT_SET_UP } })),
        calls: [],
        rows: 0,
        emails: 0,
      },
    );
    await assertNoRateLimitTable(db);
    assertQuiet(lines, urls, [CLIENT]);
  }, "none");
}

function withCommentary(env: Env, rateLimit: RateLimit | undefined): EnvWithCommentary {
  return rateLimit === undefined ? env : { ...env, COMMENTARY_RATE_LIMIT: rateLimit };
}

function commentaryEnv(db: Env["DB"]): Env {
  return {
    ASSETS: {
      async fetch() {
        return new Response("missing", { status: 500 });
      },
    },
    DB: db,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "0122456789abcdef0122456789abcdef",
    ACCOUNTS: "on",
    LOCAL_EMAIL_LOG: "on",
    ANTHROPIC_API_KEY: "sk-ant-fake-not-a-real-key",
  };
}

const COMMENTARY_SUMMARY = {
  measure: "Sales",
  prior: "2025",
  current: "2026",
  priorTotal: 1_000_000,
  currentTotal: 1_100_001,
  effects: [
    { label: "Volume", value: 60_000 },
    { label: "Price (like-for-like)", value: 40_000 },
  ],
  attributes: ["Design", "Material"],
  exactMatchShare: 0.951,
  newAndDiscontinued: "difference",
};

let commentaryClients = 0;

function commentaryClientIp(): string {
  commentaryClients += 1;
  return `203.0.113.${(commentaryClients % 254) + 1}`;
}

function commentaryAuthPrefix(baseURL: string): string {
  const pathname = new URL(baseURL).pathname;
  return pathname === "/" ? "/api/auth" : pathname.replace(/\/+$/, "");
}

function captureCommentaryLog(): { lines: string[]; restore(): void } {
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
        model: "claude-opus-5-5",
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

async function signInCommentaryMember(
  env: Env,
  email: string,
  slug: string,
  pro: boolean,
): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const prefix = commentaryAuthPrefix(env.BETTER_AUTH_URL);
  const recorded = captureCommentaryLog();
  try {
    const signIn = await dispatch(
      env,
      new Request(`${origin}${prefix}/sign-in/magic-link`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "x-forwarded-for": commentaryClientIp() },
        body: JSON.stringify({ email, callbackURL: `${origin}/app/` }),
      }),
    );
    assert.equal(signIn.status, 200, await signIn.text());
    const link = recorded.lines
      .join("\n")
      .match(new RegExp(`${origin.replaceAll(".", "\\.")}${prefix.replaceAll("/", "\\/")}/magic-link/verify\\?\\S+`))?.[0];
    assert.ok(link, "the sign-in link was not written to the log");
    const verified = await dispatch(env, new Request(link, { headers: { origin, "x-forwarded-for": commentaryClientIp() } }));
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
        headers: { origin, "content-type": "application/json", cookie, "x-forwarded-for": commentaryClientIp() },
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

function commentaryRequest(cookie: string, headers: Record<string, string>, body: string): Request {
  return new Request(`${ORIGIN}/api/commentary`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...headers },
    body,
  });
}

async function commentaryLimited(): Promise<void> {
  const limit = readLimiter("COMMENTARY_RATE_LIMIT").simple.limit;
  const calls: LimitCall[] = [];
  const db = database();
  const env = withCommentary(commentaryEnv(db), limiter(limit, calls));
  const fence = fenceAnthropic();
  try {
    const { cookie, userId } = await signInCommentaryMember(env, "pro-limit@example.invalid", "pro-limit", true);
    const outcomes = await commentaryOutcomes(env, cookie, limit + 1, () => ({ origin: ORIGIN }));
    assert.deepEqual(
      { outcomes, fence: fence.urls.length, keys: calls.map((entry) => entry.key) },
      {
        outcomes: [
          ...Array.from({ length: limit }, () => ALLOWED_COMMENTARY),
          { status: 429, body: COMMENTARY_TOO_QUICKLY, retryAfter: null, xRetryAfter: null },
        ],
        fence: limit,
        keys: Array.from({ length: limit + 1 }, () => userId),
      },
    );
  } finally {
    fence.restore();
  }
}

const ALLOWED_COMMENTARY = {
  status: 200,
  body: { paragraphs: ["Sales rose.", "Volume led."], model: "claude-opus-5-5" },
  retryAfter: null,
  xRetryAfter: null,
};
const COMMENTARY_TOO_QUICKLY = { error: "You are sending commentary requests too quickly." };

async function commentaryOutcomes(
  env: Env,
  cookie: string,
  count: number,
  headersFor: (index: number) => Record<string, string>,
): Promise<{ status: number; body: unknown; retryAfter: string | null; xRetryAfter: string | null }[]> {
  const body = JSON.stringify({ summary: COMMENTARY_SUMMARY });
  const outcomes = [];
  for (let index = 0; index < count; index += 1) {
    const response = await dispatch(env, commentaryRequest(cookie, headersFor(index), body));
    outcomes.push({
      status: response.status,
      body: await response.json(),
      retryAfter: response.headers.get("retry-after"),
      xRetryAfter: response.headers.get("x-retry-after"),
    });
  }
  return outcomes;
}

async function commentaryBadBody(): Promise<void> {
  const calls: LimitCall[] = [];
  const env = withCommentary(commentaryEnv(database()), limiter(readLimiter("COMMENTARY_RATE_LIMIT").simple.limit, calls));
  const fence = fenceAnthropic();
  try {
    const { cookie } = await signInCommentaryMember(env, "pro-body@example.invalid", "pro-body", true);
    const bodies = ["x".repeat(20_000), "not json", JSON.stringify({ summary: { rows: [] } })];
    const outcomes = [];
    for (const body of bodies) {
      const response = await dispatch(env, commentaryRequest(cookie, { origin: ORIGIN }, body));
      outcomes.push({ status: response.status, body: await response.json() });
    }
    assert.deepEqual(
      { outcomes, calls, fence: fence.urls.length },
      {
        outcomes: [
          { status: 413, body: { error: "That request is too large to be bridge totals." } },
          { status: 400, body: { error: "The request was not valid JSON." } },
          { status: 400, body: { error: "The request must contain bridge totals only." } },
        ],
        calls: [],
        fence: 0,
      },
    );
  } finally {
    fence.restore();
  }
}

async function commentaryUnbound(): Promise<void> {
  const env = withCommentary(commentaryEnv(database()), undefined);
  const fence = fenceAnthropic();
  try {
    const { cookie } = await signInCommentaryMember(env, "pro-open@example.invalid", "pro-open", true);
    const outcomes = await commentaryOutcomes(env, cookie, 6, () => ({ origin: ORIGIN }));
    assert.deepEqual(
      { outcomes, fence: fence.urls.length },
      { outcomes: Array.from({ length: 6 }, () => ALLOWED_COMMENTARY), fence: 6 },
    );
  } finally {
    fence.restore();
  }
}

async function commentaryThrowing(): Promise<void> {
  const calls: LimitCall[] = [];
  const rateLimit: RateLimit = {
    async limit({ key }) {
      calls.push({ key, success: false });
      throw new Error("binding down");
    },
  };
  const env = withCommentary(commentaryEnv(database()), rateLimit);
  const fence = fenceAnthropic();
  const recorded = captureCommentaryLog();
  try {
    const { cookie, userId } = await signInCommentaryMember(env, "pro-throw@example.invalid", "pro-throw", true);
    const outcomes = await commentaryOutcomes(env, cookie, 1, () => ({ origin: ORIGIN }));
    assert.deepEqual(
      { outcomes, fence: fence.urls.length, calls, logged: recorded.lines.some((line) => line.includes("binding down")) },
      {
        outcomes: [{ status: 429, body: COMMENTARY_TOO_QUICKLY, retryAfter: null, xRetryAfter: null }],
        fence: 0,
        calls: [{ key: userId, success: false }],
        logged: false,
      },
    );
  } finally {
    recorded.restore();
    fence.restore();
  }
}

async function commentaryTwoMembers(): Promise<void> {
  const calls: LimitCall[] = [];
  const limit = readLimiter("COMMENTARY_RATE_LIMIT").simple.limit;
  const env = withCommentary(commentaryEnv(database()), limiter(limit, calls));
  const fence = fenceAnthropic();
  try {
    const first = await signInCommentaryMember(env, "pro-a@example.invalid", "pro-a", true);
    const second = await signInCommentaryMember(env, "pro-b@example.invalid", "pro-b", true);
    const firstOutcomes = await commentaryOutcomes(env, first.cookie, limit, () => ({ origin: ORIGIN }));
    const secondOutcome = await commentaryOutcomes(env, second.cookie, 1, () => ({ origin: ORIGIN }));
    assert.deepEqual(
      {
        first: firstOutcomes,
        second: secondOutcome,
        fence: fence.urls.length,
        keys: calls.map((entry) => entry.key),
      },
      {
        first: Array.from({ length: limit }, () => ALLOWED_COMMENTARY),
        second: [ALLOWED_COMMENTARY],
        fence: limit + 1,
        keys: [...Array.from({ length: limit }, () => first.userId), second.userId],
      },
    );
  } finally {
    fence.restore();
  }
}

async function commentaryTwoAddresses(): Promise<void> {
  const calls: LimitCall[] = [];
  const limit = readLimiter("COMMENTARY_RATE_LIMIT").simple.limit;
  const env = withCommentary(commentaryEnv(database()), limiter(limit, calls));
  const fence = fenceAnthropic();
  try {
    const { cookie, userId } = await signInCommentaryMember(env, "pro-addresses@example.invalid", "pro-addresses", true);
    const addresses = ["192.0.2.10", "192.0.2.10", "192.0.2.10", "192.0.2.11", "192.0.2.11", "192.0.2.11"];
    assert.equal(addresses.length, limit + 1);
    const outcomes = await commentaryOutcomes(env, cookie, addresses.length, (index) => ({
      origin: ORIGIN,
      "cf-connecting-ip": addresses[index],
    }));
    assert.deepEqual(
      { outcomes, fence: fence.urls.length, keys: calls.map((entry) => entry.key) },
      {
        outcomes: [
          ...Array.from({ length: limit }, () => ALLOWED_COMMENTARY),
          { status: 429, body: COMMENTARY_TOO_QUICKLY, retryAfter: null, xRetryAfter: null },
        ],
        fence: limit,
        keys: Array.from({ length: addresses.length }, () => userId),
      },
    );
  } finally {
    fence.restore();
  }
}

function withoutSecrets(stdout: string | null, stderr: string | null): string {
  return `${stdout ?? ""}\n${stderr ?? ""}`
    .split("\n")
    .filter((line) => !line.includes("[email]") && !line.includes("magic-link/verify"))
    .join("\n");
}

function runIsolated(name: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, BRIDGEKIT_RATE_LIMIT_CASE: name };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_")) delete env[key];
  }
  const result = spawnSync(process.execPath, ["--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8" });
  assert.equal(result.status, 0, withoutSecrets(result.stdout, result.stderr));
}

const isolated = process.env.BRIDGEKIT_RATE_LIMIT_CASE;
if (isolated === "limited") test("the configured number of sign-in links is the limit", limited);else if (isolated === "jsonx") test("application/jsonx does not send a sign-in email", jsonx);
else if (isolated === "json-xml") test("application/json+xml does not send a sign-in email", jsonXml);
else if (isolated === "get") test("GET sign-in does not send a sign-in email", getSignIn);
else if (isolated === "put") test("PUT sign-in does not send a sign-in email", putSignIn);
else if (isolated === "extra") test("an extra JSON field still uses a sign-in slot", extraField);
else if (isolated === "large") test("a large sign-in body still uses a sign-in slot", largeSignIn);
else if (isolated === "charset") test("a JSON charset parameter still uses a sign-in slot", charsetSignIn);
else if (isolated === "deleted") test("a sign-in with no content type does not send", deletedType);
else if (isolated === "plain") test("text/plain does not send a sign-in email", plainText);
else if (isolated === "form") test("a form sign-in does not send a sign-in email", formSignIn);
else if (isolated === "slash") test("a trailing slash does not send a sign-in email", trailingSlash);
else if (isolated === "query") test("a query string still uses a sign-in slot", querySignIn);
else if (isolated === "verify") test("magic-link verify does not send a sign-in email", verifyLink);
else if (isolated === "clients") test("each client address gets its own sign-in limit", twoClients);
else if (isolated === "forwarded") test("the sign-in limit key is CF-Connecting-IP", forwardedIp);
else if (isolated === "throwing") test("a failing rate limit binding refuses the sign-in", throwingLimit);
else if (isolated === "mistyped") test("a mistyped address does not spend a sign-in slot", mistyped);
else if (isolated === "rejected") test("a rejected sign-in address does not spend a link", rejected);
else if (isolated === "missing-ip") test("a sign-in with no client address is refused", missingIp);
else if (isolated === "unbound") test("sign-in has no limit when the binding is absent", unbound);
else if (isolated === "refused-mail") test("a sign-in refused for no email does not spend a limit slot", refusedForNoMail);
else if (isolated === "moved") test("a moved sign-in route keeps the sign-in limit", movedRoute);
else if (isolated === "moved-anywhere") test("the limiter covers the sign-in route under any base path", movedAnywhere);
else if (isolated) throw new Error(`unknown rate limit case ${isolated}`);
else {
  test("wrangler.jsonc declares the magic-link rate limit", () => {
    readLimiter();
    readLimiter("COMMENTARY_RATE_LIMIT");
  });
  test("the configured number of sign-in links is the limit", () => runIsolated("limited"));
  test("application/jsonx does not send a sign-in email", () => runIsolated("jsonx"));
  test("application/json+xml does not send a sign-in email", () => runIsolated("json-xml"));
  test("GET sign-in does not send a sign-in email", () => runIsolated("get"));
  test("PUT sign-in does not send a sign-in email", () => runIsolated("put"));
  test("an extra JSON field still uses a sign-in slot", () => runIsolated("extra"));
  test("a large sign-in body still uses a sign-in slot", () => runIsolated("large"));
  test("a JSON charset parameter still uses a sign-in slot", () => runIsolated("charset"));
  test("a sign-in with no content type does not send", () => runIsolated("deleted"));
  test("text/plain does not send a sign-in email", () => runIsolated("plain"));
  test("a form sign-in does not send a sign-in email", () => runIsolated("form"));
  test("a trailing slash does not send a sign-in email", () => runIsolated("slash"));
  test("a query string still uses a sign-in slot", () => runIsolated("query"));
  test("magic-link verify does not send a sign-in email", () => runIsolated("verify"));
  test("each client address gets its own sign-in limit", () => runIsolated("clients"));
  test("the sign-in limit key is CF-Connecting-IP", () => runIsolated("forwarded"));
  test("a failing rate limit binding refuses the sign-in", () => runIsolated("throwing"));
  test("a mistyped address does not spend a sign-in slot", () => runIsolated("mistyped"));
  test("a rejected sign-in address does not spend a link", () => runIsolated("rejected"));
  test("a sign-in with no client address is refused", () => runIsolated("missing-ip"));
  test("sign-in has no limit when the binding is absent", () => runIsolated("unbound"));
  test("a sign-in refused for no email does not spend a limit slot", () => runIsolated("refused-mail"));
  test("a moved sign-in route keeps the sign-in limit", () => runIsolated("moved"));
  test("the limiter covers the sign-in route under any base path", () => runIsolated("moved-anywhere"));
  test("the sixth commentary request from one Pro member is refused", commentaryLimited);
  test("a refused commentary body does not spend a slot", commentaryBadBody);
  test("commentary has no limit when the binding is absent", commentaryUnbound);
  test("a failing commentary rate limit binding refuses the request", commentaryThrowing);
  test("two Pro members do not share a commentary limit", commentaryTwoMembers);
  test("one Pro member on two addresses shares one commentary limit", commentaryTwoAddresses);
}
