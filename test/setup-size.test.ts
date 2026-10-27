import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { isValidSetup, type Column, type Setup } from "../src/app/setup.ts";
import * as bounds from "../src/app/setup.ts";
import { parseSummary, type BridgeSummary } from "../src/summary.ts";
import { testDatabase } from "./support/d1.ts";

// The bounds the product promises. The tests use these numbers, not the
// exports, so a run at the base commit exercises the behaviour it lacks.
const MAX_COLUMNS = 1000;
const MAX_COLUMN_NAME = 300;
const MAX_LEVEL_NAME = 300;
const MAX_FILTER_VALUES = 500;
const MAX_FILTER_VALUE = 300;
const SAVE_LIMIT = 6 * 1024 * 1024;
const TOO_LARGE = "This is too large to save.";

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

/** `count` distinct column names of `length` characters, filled with printable ASCII or CJK. */
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

function largestSetupWithFilters(columns: string[]): Setup {
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
  return { name: "Largest setup", columns, setup };
}

function bridgeBody(columns: string[], setup: Setup, summary: BridgeSummary): BridgeBody {
  return { name: "Largest bridge", columns, setup, summary, filterColumns: [] };
}

function smallSetupBody(): SetupBody {
  return { name: "Small setup", columns: SMALL_COLUMNS, setup: SMALL_SETUP };
}

function smallBridgeBody(): BridgeBody {
  return { name: "Small bridge", columns: SMALL_COLUMNS, setup: SMALL_SETUP, summary: SMALL_SUMMARY, filterColumns: [] };
}

/** The largest summary `parseSummary` accepts: 40 effects and 20 attributes, each at its 120-character limit. */
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

test("exports the documented bounds", () => {
  assert.equal(bounds.MAX_COLUMNS, MAX_COLUMNS);
  assert.equal(bounds.MAX_COLUMN_NAME, MAX_COLUMN_NAME);
  assert.equal(bounds.MAX_LEVEL_NAME, MAX_LEVEL_NAME);
  assert.equal(bounds.MAX_FILTER_VALUES, MAX_FILTER_VALUES);
  assert.equal(bounds.MAX_FILTER_VALUE, MAX_FILTER_VALUE);
});

test("refuses a setup with more levels than its columns allow", () => {
  const three = ["a", "b", "c"];
  assert.equal(isValidSetup(setupAcross(three), columnsOf(three)), true);
  assert.equal(
    isValidSetup(
      setupWith([
        { name: "a", columns: ["a"] },
        { name: "b", columns: ["b"] },
        { name: "c", columns: ["c"] },
        { name: "d", columns: ["a"] },
      ]),
      columnsOf(three),
    ),
    false,
  );

  const many = columnNames(MAX_COLUMNS + 1, "a");
  assert.equal(isValidSetup(setupAcross(many.slice(0, MAX_COLUMNS)), columnsOf(many)), true);
  assert.equal(isValidSetup(setupAcross(many), columnsOf(many)), false);
});

test("refuses a level name past 300 characters unless it is one of its own columns", () => {
  const column = "a";
  assert.equal(isValidSetup(setupWith([{ name: "n".repeat(MAX_LEVEL_NAME + 1), columns: [column] }]), columnsOf([column])), false);
  assert.equal(isValidSetup(setupWith([{ name: "n".repeat(MAX_LEVEL_NAME), columns: [column] }]), columnsOf([column])), true);
  const header = "h".repeat(MAX_LEVEL_NAME + 100);
  assert.equal(isValidSetup(setupWith([{ name: header, columns: [header] }]), columnsOf([header])), true);
});

test("refuses a column that appears in two levels", () => {
  const columns = ["a", "b"];
  assert.equal(
    isValidSetup(
      setupWith([
        { name: "a", columns: ["a"] },
        { name: "a", columns: ["a"] },
      ]),
      columnsOf(columns),
    ),
    false,
  );
  assert.equal(
    isValidSetup(
      setupWith([
        { name: "a", columns: ["a"] },
        { name: "b", columns: ["b"] },
      ]),
      columnsOf(columns),
    ),
    true,
  );
});

test("refuses more filters than columns, a 501st value, or a 301-character value", () => {
  const columns = columnNames(3, "a");
  const filtered = (values: string[]) => setupWith([], [{ column: columns[0], mode: "include", values }]);
  assert.equal(isValidSetup(filtered(filterValues(MAX_FILTER_VALUES + 1, "v", 10)), columnsOf(columns)), false);
  assert.equal(isValidSetup(filtered(filterValues(MAX_FILTER_VALUES, "v", 10)), columnsOf(columns)), true);
  assert.equal(isValidSetup(filtered(filterValues(1, "v", MAX_FILTER_VALUE + 1)), columnsOf(columns)), false);
  assert.equal(isValidSetup(filtered(filterValues(1, "v", MAX_FILTER_VALUE)), columnsOf(columns)), true);
  const filter = (column: string): Setup["filters"][number] => ({ column, mode: "include", values: ["v"] });
  assert.equal(isValidSetup(setupWith([], columns.map(filter)), columnsOf(columns)), true);
  assert.equal(isValidSetup(setupWith([], [...columns.map(filter), filter(columns[0])]), columnsOf(columns)), false);
});

test("accepts the largest setup the app can build", () => {
  const columns = columnNames(MAX_COLUMNS, "a");
  assert.equal(isValidSetup(largestSetupWithFilters(columns), columnsOf(columns)), true);
});

test("refuses a setup save just over 6 MiB with 413, whatever Content-Length says", async () => {
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

test("refuses a bridge save just over 6 MiB with 413, whatever Content-Length says", async () => {
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

test("accepts a setup body of exactly 6 MiB", async () => {
  const { env, cookie, workspaceId } = await signedIn();
  const text = padded(smallSetupBody(), SAVE_LIMIT);
  const response = await post(env, workspaceId, "setups", cookie, text, {
    "content-length": String(Buffer.byteLength(text)),
  });
  assert.equal(response.status, 201, await response.text());
});

test("saves the largest setup and bridge the app can build, and small ones", async () => {
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

test("the largest setup and bridge bodies sit under the save limit", () => {
  for (const filler of ["a", "價", "\u0001"]) {
    const columns = columnNames(MAX_COLUMNS, filler);
    const setup = setupAcross(columns);
    const setupSize = Buffer.byteLength(JSON.stringify(setupBody(columns, setup)));
    const bridgeSize = Buffer.byteLength(JSON.stringify(bridgeBody(columns, setup, largestSummary(filler))));
    assert.ok(setupSize < SAVE_LIMIT, `${filler} setup ${setupSize} against ${SAVE_LIMIT}`);
    assert.ok(bridgeSize < SAVE_LIMIT, `${filler} bridge ${bridgeSize} against ${SAVE_LIMIT}`);
    assert.ok(parseSummary(largestSummary(filler)), filler);
  }
});
