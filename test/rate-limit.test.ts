import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Fetcher, RateLimit } from "../server/cloudflare.ts";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readLimiter(): LimiterConfig {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
  assert.ok(isRecord(parsed));
  const listed = parsed.ratelimits;
  assert.ok(Array.isArray(listed));
  assert.deepEqual(
    listed.map((item) => (isRecord(item) ? item.name : undefined)),
    ["MAGIC_LINK_RATE_LIMIT"],
  );
  const entry = listed[0];
  assert.ok(isRecord(entry));
  const simple = entry.simple;
  assert.ok(isRecord(simple));
  const name = entry.name;
  const namespaceId = entry.namespace_id;
  const limit = simple.limit;
  const period = simple.period;
  if (typeof name !== "string" || typeof namespaceId !== "string" || typeof limit !== "number" || typeof period !== "number") {
    throw new Error("wrangler.jsonc rate limit binding is incomplete");
  }
  assert.equal(name, "MAGIC_LINK_RATE_LIMIT");
  assert.match(namespaceId, /^[1-9][0-9]*$/);
  assert.equal(period, 60);
  assert.equal(limit, 3);
  return { name, namespace_id: namespaceId, simple: { limit, period } };
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

function bindings(db: Env["DB"], rateLimit: RateLimit | undefined): Env {
  const assets: Fetcher = {
    async fetch() {
      return new Response("missing", { status: 500 });
    },
  };
  const env: Env = {
    ASSETS: assets,
    DB: db,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "0122456789abcdef0122456789abcdef",
    ACCOUNTS: "on",
    LOCAL_EMAIL_LOG: "on",
  };
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
    return await run(bindings(db, rateLimit), db, logs.lines, urls);
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
if (isolated === "limited") test("the configured number of sign-in links is the limit", limited);
else if (isolated === "jsonx") test("application/jsonx does not send a sign-in email", jsonx);
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
else if (isolated) throw new Error(`unknown rate limit case ${isolated}`);
else {
  test("wrangler.jsonc declares the magic-link rate limit", () => {
    readLimiter();
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
}
