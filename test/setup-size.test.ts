import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { totalRowOffers } from "../src/app/profile.ts";
import { columnsKey, isValidSetup, loadSavedSetup, saveSetup, type Column, type Filter, type Setup } from "../src/app/setup.ts";
import { parseSummary, type BridgeSummary } from "../src/summary.ts";
import { testDatabase } from "./support/d1.ts";

// The numbers the tests use, kept as literals so a run at the base commit
// exercises the behaviour it lacks. The column numbers are the server's
// limits. The filter numbers only size a fixture at the editor's 500-value
// query limit and a 300-character value; no code enforces a filter bound.
const MAX_COLUMNS = 1000;
const MAX_COLUMN_NAME = 300;
const MAX_FILTER_VALUES = 500;
const MAX_FILTER_VALUE = 300;
const SAVE_LIMIT = 8 * 1024 * 1024;
const TOO_LARGE = "This is too large to save.";
const SETUP_MISMATCH = "That setup does not match the columns.";

const ORIGIN = "http://127.0.0.1:8790";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const OWNER = "owner@example.invalid";

type Sent = { url: string; init: RequestInit };

let clients = 0;

function clientIp(): string {
  clients += 1;
  return `203.0.113.${(clients % 254) + 1}`;
}

/** Records every console line and every fetch, without printing or sending. */
function record(): { lines: string[]; sent: Sent[]; restore(): void } {
  const lines: string[] = [];
  const sent: Sent[] = [];
  const previous = { debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  for (const method of ["debug", "info", "log", "warn", "error"] as const) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    sent.push({ url, init: init ?? {} });
    if (url !== "https://api.resend.com/emails") return original(input, init);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    lines,
    sent,
    restore() {
      Object.assign(console, previous);
      globalThis.fetch = original;
    },
  };
}

/** An environment over one database, varying only the mail fields and the base URL. */
function mailEnv(db: Env["DB"], fields: Partial<Env>, base: string = ORIGIN): Env {
  return {
    ASSETS: {
      async fetch() {
        return new Response("missing", { status: 500 });
      },
    },
    DB: db,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: AUTH_SECRET,
    ACCOUNTS: "on",
    ...fields,
  };
}

// Better Auth reads pragma_table_info through D1 batch. This stand-in's batch
// uses run(), which drops rows, and sign-in then answers 500.
function database(): Env["DB"] {
  const db = testDatabase();
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    exec: (sql) => db.exec(sql),
  };
}

function authPrefix(baseURL: string): string {
  const pathname = new URL(baseURL).pathname;
  return pathname === "/" ? "/api/auth" : pathname.replace(/\/+$/, "");
}

async function call(url: string, env: Env, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(new Request(url, init), env, {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  });
  await Promise.all(pending);
  return response;
}

/** Signs an owner in through the real magic-link flow and opens a Pro workspace. */
async function session(base: string = ORIGIN): Promise<{ env: Env; db: Env["DB"]; cookie: string; workspaceId: string }> {
  const db = database();
  const env = mailEnv(db, { LOCAL_EMAIL_LOG: "on" }, base);
  const origin = new URL(base).origin;
  const prefix = authPrefix(base);
  const recorded = record();
  try {
    const signIn = await call(`${origin}${prefix}/sign-in/magic-link`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": clientIp() },
      body: JSON.stringify({ email: OWNER, callbackURL: `${ORIGIN}/app/` }),
    });
    assert.equal(signIn.status, 200, await signIn.text());
    const link = recorded.lines
      .join("\n")
      .match(new RegExp(`http://127\\.0\\.0\\.1:8790${prefix.replaceAll("/", "\\/")}/magic-link/verify\\?\\S+`))?.[0];
    assert.ok(link, "the sign-in link was not written to the log");
    const verified = await call(link, env, { headers: { origin: ORIGIN, "x-forwarded-for": clientIp() } });
    assert.equal(verified.status, 302, await verified.text());
    const cookie = verified.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.notEqual(cookie, "", "the verification set no session cookie");
    const created = await call(`${origin}${prefix}/organization/create`, env, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie, "x-forwarded-for": clientIp() },
      body: JSON.stringify({ name: "Size test", slug: "size-test" }),
    });
    const createdBody = await created.text();
    assert.equal(created.status, 200, createdBody);
    const workspaceId = (JSON.parse(createdBody) as { id: string }).id;
    await db
      .prepare("INSERT INTO subscription VALUES (?, 'sub_size', 'ctm_size', 'active', 'pri_size', 2, '2099-01-01T00:00:00Z', '2026-10-12T00:00:00Z')")
      .bind(workspaceId)
      .run();
    return { env, db, cookie, workspaceId };
  } finally {
    recorded.restore();
  }
}

let signed: Promise<{ env: Env; db: Env["DB"]; cookie: string; workspaceId: string }> | null = null;

function signedIn(): Promise<{ env: Env; db: Env["DB"]; cookie: string; workspaceId: string }> {
  signed ??= session();
  return signed;
}

/** Builds distinct column names from an index prefix and the supplied filler. */
function columnNames(count: number, filler: string, length: number = MAX_COLUMN_NAME): string[] {
  return Array.from({ length: count }, (_, index) => {
    const prefix = `c${index}-`;
    return prefix + filler.repeat(Math.max(0, length - prefix.length));
  });
}

function filterValues(count: number, filler: string, length: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const prefix = `v${index}-`;
    return prefix + filler.repeat(Math.max(0, length - prefix.length));
  });
}

function columnsOf(names: string[]): Column[] {
  return names.map((name) => ({ name, type: "" }));
}

function setupWith(levels: Setup["levels"], filters: Setup["filters"] = []): Setup {
  return { periodColumn: "", grain: "value", unitsColumn: "", salesColumn: "", levels, filters };
}

function setupAcross(columns: string[]): Setup {
  return setupWith(columns.map((column) => ({ name: column, columns: [column] })));
}

function setupWithTwoLongFilters(columns: string[]): Setup {
  const values = filterValues(MAX_FILTER_VALUES, "價", MAX_FILTER_VALUE);
  return setupWith(
    columns.map((column) => ({ name: column, columns: [column] })),
    [
      { column: columns[0], mode: "include", values },
      { column: columns[1], mode: "exclude", values },
    ],
  );
}

const SMALL_COLUMNS = ["year", "units", "sales", "design"];
const SMALL_SETUP: Setup = {
  periodColumn: "year",
  grain: "value",
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [{ name: "Design", columns: ["design"] }],
  filters: [],
};
const SMALL_SUMMARY: BridgeSummary = {
  measure: "Sales",
  prior: "2025",
  current: "2026",
  priorTotal: 100,
  currentTotal: 110,
  effects: [{ label: "Volume", value: 10 }],
  attributes: ["Design"],
  exactMatchShare: 0.9,
  newAndDiscontinued: "difference",
};

interface SetupBody {
  name: string;
  columns: string[];
  setup: Setup;
}

interface BridgeBody extends SetupBody {
  summary: BridgeSummary;
  filterColumns: string[];
}

function setupBody(columns: string[], setup: Setup): SetupBody {
  return { name: "Large setup", columns, setup };
}

function bridgeBody(columns: string[], setup: Setup, summary: BridgeSummary): BridgeBody {
  return { name: "Large bridge", columns, setup, summary, filterColumns: [] };
}

function smallSetupBody(): SetupBody {
  return { name: "Small setup", columns: SMALL_COLUMNS, setup: SMALL_SETUP };
}

function smallBridgeBody(): BridgeBody {
  return { name: "Small bridge", columns: SMALL_COLUMNS, setup: SMALL_SETUP, summary: SMALL_SUMMARY, filterColumns: [] };
}

/** A summary with 40 effects, 20 attributes, and 120-character text fields. */
function largestSummary(filler = "s"): BridgeSummary {
  const text = filler.repeat(120);
  return {
    measure: "Sales",
    prior: text,
    current: text,
    priorTotal: 100,
    currentTotal: 110,
    effects: Array.from({ length: 40 }, (_, value) => ({ label: text, value })),
    attributes: Array.from({ length: 20 }, () => text),
    exactMatchShare: 0.5,
    newAndDiscontinued: "difference",
  };
}

/** Pads a JSON body with a `padding` key until it is exactly `size` bytes. */
function padded(body: object, size: number): string {
  const base = Buffer.byteLength(JSON.stringify(body));
  const overhead = Buffer.byteLength(JSON.stringify({ ...body, padding: "" })) - base;
  const json = JSON.stringify({ ...body, padding: "p".repeat(size - base - overhead) });
  assert.equal(Buffer.byteLength(json), size);
  return json;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function post(
  env: Env,
  workspaceId: string,
  route: "setups" | "bridges",
  cookie: string | null,
  body: BodyInit,
  headers: Record<string, string> = {},
  stream = false,
): Promise<Response> {
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie === null ? {} : { cookie }), ...headers },
    body,
  };
  if (stream) init.duplex = "half";
  return call(`${ORIGIN}/api/workspaces/${workspaceId}/${route}`, env, init);
}

test("accepts 1,000 levels and two filters of 500 values", () => {
  const columns = columnNames(MAX_COLUMNS, "a");
  assert.equal(isValidSetup(setupWithTwoLongFilters(columns), columnsOf(columns)), true);
});

test("refuses more levels than columns with 400", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const columns = ["a", "b"];
  const level = (name: string): Setup["levels"][number] => ({ name, columns: [name] });
  const refused = await post(
    env,
    workspaceId,
    "setups",
    cookie,
    JSON.stringify(setupBody(columns, setupWith([level("a"), level("b"), level("a")]))),
  );
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: SETUP_MISMATCH });
  const accepted = await post(
    env,
    workspaceId,
    "setups",
    cookie,
    JSON.stringify(setupBody(columns, setupWith([level("a"), level("b")]))),
  );
  assert.equal(accepted.status, 201, await accepted.text());
});

test("refuses a 301-character level name and accepts 300", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const columns = ["design"];
  const refused = await post(
    env,
    workspaceId,
    "setups",
    cookie,
    JSON.stringify(setupBody(columns, setupWith([{ name: "n".repeat(301), columns: ["design"] }]))),
  );
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: SETUP_MISMATCH });
  const accepted = await post(
    env,
    workspaceId,
    "setups",
    cookie,
    JSON.stringify(setupBody(columns, setupWith([{ name: "n".repeat(300), columns: ["design"] }]))),
  );
  assert.equal(accepted.status, 201, await accepted.text());
});

test("refuses a column in two levels with 400", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const columns = ["a", "b"];
  const refused = await post(
    env,
    workspaceId,
    "setups",
    cookie,
    JSON.stringify(
      setupBody(
        columns,
        setupWith([
          { name: "a", columns: ["a"] },
          { name: "b", columns: ["a"] },
        ]),
      ),
    ),
  );
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: SETUP_MISMATCH });
  const accepted = await post(
    env,
    workspaceId,
    "setups",
    cookie,
    JSON.stringify(
      setupBody(
        columns,
        setupWith([
          { name: "a", columns: ["a"] },
          { name: "b", columns: ["b"] },
        ]),
      ),
    ),
  );
  assert.equal(accepted.status, 201, await accepted.text());
});

test("refuses a setup save just over 8 MiB with 413, whatever Content-Length says", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const text = padded(smallSetupBody(), SAVE_LIMIT + 1);
  const accurate = await post(env, workspaceId, "setups", cookie, text, {
    "content-length": String(Buffer.byteLength(text)),
  });
  const absent = await post(env, workspaceId, "setups", cookie, text);
  const understated = await post(env, workspaceId, "setups", cookie, streamOf(text), { "content-length": "1024" }, true);
  for (const [label, response] of [
    ["accurate Content-Length", accurate],
    ["no Content-Length", absent],
    ["understated Content-Length", understated],
  ] as const) {
    assert.equal(response.status, 413, label);
    assert.deepEqual(await response.json(), { error: TOO_LARGE }, label);
  }
});

test("refuses a bridge save just over 8 MiB with 413, whatever Content-Length says", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const text = padded(smallBridgeBody(), SAVE_LIMIT + 1);
  const accurate = await post(env, workspaceId, "bridges", cookie, text, {
    "content-length": String(Buffer.byteLength(text)),
  });
  const absent = await post(env, workspaceId, "bridges", cookie, text);
  const understated = await post(env, workspaceId, "bridges", cookie, streamOf(text), { "content-length": "1024" }, true);
  for (const [label, response] of [
    ["accurate Content-Length", accurate],
    ["no Content-Length", absent],
    ["understated Content-Length", understated],
  ] as const) {
    assert.equal(response.status, 413, label);
    assert.deepEqual(await response.json(), { error: TOO_LARGE }, label);
  }
});

test("accepts a setup body of exactly 8 MiB", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const text = padded(smallSetupBody(), SAVE_LIMIT);
  const response = await post(env, workspaceId, "setups", cookie, text, {
    "content-length": String(Buffer.byteLength(text)),
  });
  assert.equal(response.status, 201, await response.text());
});

test("saves 1,000-column setup and bridge fixtures, and small ones", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const columns = columnNames(MAX_COLUMNS, "a");
  const setup = setupAcross(columns);
  const largeSetup = await post(env, workspaceId, "setups", cookie, JSON.stringify(setupBody(columns, setup)));
  assert.equal(largeSetup.status, 201, await largeSetup.text());
  const largeBridge = await post(
    env,
    workspaceId,
    "bridges",
    cookie,
    JSON.stringify(bridgeBody(columns, setup, largestSummary())),
  );
  assert.equal(largeBridge.status, 201, await largeBridge.text());
  const smallSetup = await post(env, workspaceId, "setups", cookie, JSON.stringify(smallSetupBody()));
  assert.equal(smallSetup.status, 201, await smallSetup.text());
  const smallBridge = await post(env, workspaceId, "bridges", cookie, JSON.stringify(smallBridgeBody()));
  assert.equal(smallBridge.status, 201, await smallBridge.text());
});

test("refuses an anonymous oversized setup save with 403 and writes no row", async () => {
  const { env, workspaceId } = await signedIn();
  const count = async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM saved_setup WHERE organizationId = ?")
      .bind(workspaceId)
      .first<{ n: number }>();
    return row?.n ?? -1;
  };
  const before = await count();
  const response = await post(env, workspaceId, "setups", null, padded(smallSetupBody(), SAVE_LIMIT + 1));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Sign in first." });
  assert.equal(await count(), before);
});

test("answers 400 for a body at the limit that is not JSON", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const response = await post(env, workspaceId, "setups", cookie, "#".repeat(SAVE_LIMIT));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "The request was not valid JSON." });
});

test("answers 400 for a save body that was already read", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const request = new Request(`${ORIGIN}/api/workspaces/${workspaceId}/setups`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie },
    body: JSON.stringify(smallSetupBody()),
  });
  await request.text();
  const response = await app.fetch(request, env, { waitUntil() {}, passThroughOnException() {}, props: {} });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "The request was not valid JSON." });
});

test("cancels an oversized chunked body once and stops pulling", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const CHUNK = 64 * 1024;
  let pulls = 0;
  let cancels = 0;
  let pullsAfterCancel = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (cancelled) {
          pullsAfterCancel += 1;
          return;
        }
        pulls += 1;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancels += 1;
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await post(env, workspaceId, "setups", cookie, source, { "content-length": "1" }, true);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: TOO_LARGE });
  assert.equal(pulls, Math.floor(SAVE_LIMIT / CHUNK) + 1);
  assert.equal(cancels, 1);
  assert.equal(pullsAfterCancel, 0);
});

test("the ASCII, CJK, and escaped-control fixtures sit under 8 MiB", () => {
  for (const filler of ["a", "價", "\u0001"]) {
    const columns = columnNames(MAX_COLUMNS, filler);
    const setup = setupAcross(columns);
    const setupSize = Buffer.byteLength(JSON.stringify(setupBody(columns, setup)));
    const bridgeSize = Buffer.byteLength(JSON.stringify({ ...bridgeBody(columns, setup, largestSummary(filler)), filterColumns: columns }));
    assert.ok(setupSize < SAVE_LIMIT, `${filler} setup ${setupSize} against ${SAVE_LIMIT}`);
    assert.ok(bridgeSize < SAVE_LIMIT, `${filler} bridge ${bridgeSize} against ${SAVE_LIMIT}`);
    assert.ok(parseSummary(largestSummary(filler)), filler);
  }
});

// The remembered and loaded paths read localStorage at call time, so a stub
// replaces it for this file. Its stored keys enumerate the way a real Storage
// does, because the opt-out path walks Object.keys(localStorage).
const rememberedStore = new Map<string, string>();
const rememberedMethods = {
  getItem: (key: string) => rememberedStore.get(key) ?? null,
  setItem: (key: string, value: string) => void rememberedStore.set(key, value),
  removeItem: (key: string) => void rememberedStore.delete(key),
  key: (index: number) => [...rememberedStore.keys()][index] ?? null,
  get length() {
    return rememberedStore.size;
  },
  clear: () => rememberedStore.clear(),
};
const rememberedLocalStorage = new Proxy(rememberedMethods, {
  get: (target, key) => (typeof key === "string" && !(key in target) ? rememberedStore.get(key) : Reflect.get(target, key)),
  ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...rememberedStore.keys()])],
  getOwnPropertyDescriptor: (target, key) =>
    typeof key === "string" && rememberedStore.has(key)
      ? { value: rememberedStore.get(key), enumerable: true, configurable: true, writable: true }
      : Reflect.getOwnPropertyDescriptor(target, key),
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: rememberedLocalStorage,
});

beforeEach(() => rememberedStore.clear());

test("restores a 301-character attribute name saved before the editor cap", () => {
  const setup: Setup = { ...SMALL_SETUP, levels: [{ ...SMALL_SETUP.levels[0], name: "N".repeat(301) }] };
  assert.equal(isValidSetup(setup, columnsOf(SMALL_COLUMNS)), true);
  saveSetup(columnsOf(SMALL_COLUMNS), setup);
  const restored = loadSavedSetup(columnsOf(SMALL_COLUMNS));
  assert.equal(restored?.levels[0]?.name, "N".repeat(301));
});

test("restores a 400-character header name after its chip is removed", () => {
  const header = "h".repeat(400);
  const columns: Column[] = [...columnsOf(SMALL_COLUMNS), { name: header, type: "VARCHAR" }];
  const level = { name: header, columns: [header, "design"] };
  const setup: Setup = { ...SMALL_SETUP, levels: [{ ...level, columns: level.columns.filter((column) => column !== header) }] };
  assert.equal(isValidSetup(setup, columns), true);
  saveSetup(columns, setup);
  const restored = loadSavedSetup(columns);
  assert.equal(restored?.levels[0]?.name, header);
});

test("accepts a 301-character filter value after a file round trip", () => {
  const setup: Setup = {
    ...SMALL_SETUP,
    filters: [{ column: "design", mode: "include", values: ["P".repeat(301)] }],
  };
  assert.equal(isValidSetup(JSON.parse(JSON.stringify(setup)), columnsOf(SMALL_COLUMNS)), true);
});

test("accepts the 501st total-row value offered for a 500-value filter", () => {
  const filters: Filter[] = [
    { column: "design", mode: "exclude", values: Array.from({ length: 500 }, (_, index) => `value-${index}`) },
  ];
  const offers = totalRowOffers([{ column: "design", value: "total", rows: 1 }], filters);
  assert.equal(offers.length, 1);
  const offered = offers[0].filters.find((filter) => filter.column === "design");
  assert.equal(offered?.values.length, 501);
  const setup: Setup = { ...SMALL_SETUP, filters: offers[0].filters };
  assert.equal(isValidSetup(setup, columnsOf(SMALL_COLUMNS)), true);
});

test("drops filters from a remembered mapping that holds a 301-character value", () => {
  const key = `bridgekit:setup:${columnsKey(SMALL_COLUMNS)}`;
  rememberedStore.set(
    key,
    JSON.stringify({ ...SMALL_SETUP, filters: [{ column: "design", mode: "include", values: ["V".repeat(301)] }] }),
  );
  const restored = loadSavedSetup(columnsOf(SMALL_COLUMNS));
  assert.notEqual(restored, null);
  assert.deepEqual(restored?.filters, []);
});

test("accepts 1,001 levels over 1,001 columns", () => {
  const names = Array.from({ length: 1001 }, (_, index) => `column-${index}`);
  const setup: Setup = {
    ...SMALL_SETUP,
    periodColumn: "",
    unitsColumn: "",
    salesColumn: "",
    levels: names.map((name) => ({ name, columns: [name] })),
  };
  assert.equal(isValidSetup(setup, names.map((name) => ({ name, type: "" }))), true);
});
