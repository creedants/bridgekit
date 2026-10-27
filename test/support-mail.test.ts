import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext, Fetcher, ForwardableEmailMessage } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import worker from "../server/worker.ts";
import { testDatabase } from "./support/d1.ts";

const SUPPORT = "support@pvmbridge.com";
const FORWARD_TO = "owner@example.invalid";
const REJECTION = "This message could not be delivered. Please try again later.";
const BODY_LIMIT = 100_000;
const RAW_PARSE_LIMIT = 5 * 1024 * 1024;
const CTX: ExecutionContext = { waitUntil() {} };

const assets: Fetcher = {
  async fetch() {
    return new Response("missing", { status: 500 });
  },
};

function supportEnv(fields: { DB?: Env["DB"]; SUPPORT_FORWARD_TO?: string } = {}): Env {
  return {
    ASSETS: assets,
    DB: fields.DB ?? testDatabase(),
    BETTER_AUTH_URL: "http://127.0.0.1:8790",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    SUPPORT_FORWARD_TO: fields.SUPPORT_FORWARD_TO,
  };
}

type FakeMessage = ForwardableEmailMessage & {
  readonly forwarded: string[];
  readonly rejected: string[];
  readonly reads: { count: number };
};

type MailOptions = {
  /** The header lines the raw text carries, and the same ones the platform exposes. */
  readonly headerLines: readonly string[];
  readonly body: string;
  readonly envelopeFrom?: string;
  readonly envelopeTo?: string;
  readonly rawSize?: number;
  /** A stream that throws if anything tries to read it. */
  readonly unreadable?: boolean;
};

function headersOf(lines: readonly string[]): Headers {
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return headers;
}

function countingRaw(text: string, reads: { count: number }, unreadable: boolean): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const inner = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    getReader() {
      if (unreadable) throw new Error("the raw message was read");
      reads.count += 1;
      return inner.getReader();
    },
  } as unknown as ReadableStream<Uint8Array>;
}

function mail(options: MailOptions): FakeMessage {
  const raw = `${options.headerLines.join("\r\n")}\r\n\r\n${options.body}`;
  const reads = { count: 0 };
  const forwarded: string[] = [];
  const rejected: string[] = [];
  return {
    from: options.envelopeFrom ?? "customer@example.invalid",
    to: options.envelopeTo ?? SUPPORT,
    headers: headersOf(options.headerLines),
    raw: countingRaw(raw, reads, options.unreadable ?? false),
    rawSize: options.rawSize ?? new TextEncoder().encode(raw).length,
    setReject(reason: string) {
      rejected.push(reason);
    },
    async forward(to: string) {
      forwarded.push(to);
    },
    forwarded,
    rejected,
    reads,
  };
}

async function rows(db: Env["DB"]): Promise<Record<string, unknown>[]> {
  const result = await db
    .prepare("SELECT id, receivedAt, envelopeFrom, envelopeTo, headerFrom, subject, headerDate, messageId, inReplyTo, body, bodyCut FROM support_mail ORDER BY receivedAt")
    .all();
  return result.results;
}

/** Records every console line without printing it. */
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

const PLAIN_HEADERS = [
  "From: Ada Lovelace <ada@example.invalid>",
  `To: ${SUPPORT}`,
  "Subject: A question about the bridge",
  "Date: Mon, 26 Oct 2026 10:00:00 +0000",
  "Message-ID: <plain-1@example.invalid>",
  "In-Reply-To: <earlier-1@example.invalid>",
  "Content-Type: text/plain; charset=utf-8",
];
const PLAIN_BODY = "How do I read the bridge table?";
// postal-mime ends the parsed text with a newline the raw body did not carry.
const PLAIN_STORED = `${PLAIN_BODY}\n`;

test("a plain-text message is stored whole and forwarded", async () => {
  const message = mail({ headerLines: PLAIN_HEADERS, body: PLAIN_BODY, envelopeFrom: "ada@example.invalid" });
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  const log = captureLog();
  try {
    await worker.email(message, env, CTX);
  } finally {
    log.restore();
  }
  assert.deepEqual(log.lines, []);
  assert.deepEqual(message.forwarded, [FORWARD_TO]);
  assert.deepEqual(message.rejected, []);
  assert.equal(message.reads.count, 1);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  const row = stored[0]!;
  assert.equal(typeof row.id, "string");
  assert.ok(String(row.id).length > 0);
  assert.match(String(row.receivedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(
    { ...row, id: undefined, receivedAt: undefined },
    {
      id: undefined,
      receivedAt: undefined,
      envelopeFrom: "ada@example.invalid",
      envelopeTo: SUPPORT,
      headerFrom: "Ada Lovelace <ada@example.invalid>",
      subject: "A question about the bridge",
      headerDate: "Mon, 26 Oct 2026 10:00:00 +0000",
      messageId: "<plain-1@example.invalid>",
      inReplyTo: "<earlier-1@example.invalid>",
      body: PLAIN_STORED,
      bodyCut: 0,
    },
  );
});

test("a multipart message stores only its text part", async () => {
  const body = [
    "--mix",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The plain part.",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>The <b>HTML</b> part.</p>",
    "--alt--",
    "--mix",
    'Content-Type: application/octet-stream; name="secret.bin"',
    'Content-Disposition: attachment; filename="secret.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    "QVRUQUNITUVOVENPTlRFTlQ=",
    "--mix--",
  ].join("\r\n");
  const message = mail({
    headerLines: [
      "From: Ada Lovelace <ada@example.invalid>",
      `To: ${SUPPORT}`,
      "Subject: An attachment",
      "Content-Type: multipart/mixed; boundary=\"mix\"",
    ],
    body,
  });
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  await worker.email(message, env, CTX);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.body, "The plain part.");
  assert.equal(String(stored[0]!.body).includes("<b>"), false);
  assert.equal(String(stored[0]!.body).includes("ATTACHMENTCONTENT"), false);
});

test("an HTML-only message stores tag-free text", async () => {
  const message = mail({
    headerLines: [
      "From: Ada Lovelace <ada@example.invalid>",
      `To: ${SUPPORT}`,
      "Subject: HTML only",
      "Content-Type: text/html; charset=utf-8",
    ],
    body: '<html><head><title>Boom</title><style>p { color: red }</style></head><body><script>alert("x")</script><p>A &amp; B &#8212; &#x2014; C</p><div>Line<br>Two</div></body></html>',
  });
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  await worker.email(message, env, CTX);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.body, "A & B \u2014 \u2014 C\n\nLine\nTwo");
  assert.equal(String(stored[0]!.body).includes("<"), false);
  assert.equal(String(stored[0]!.body).includes("alert"), false);
  assert.equal(String(stored[0]!.body).includes("color: red"), false);
});

test("a body longer than the limit is cut and marked", async () => {
  const message = mail({ headerLines: PLAIN_HEADERS, body: "a".repeat(BODY_LIMIT) });
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  await worker.email(message, env, CTX);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(String(stored[0]!.body).length, BODY_LIMIT);
  assert.equal(stored[0]!.bodyCut, 1);
});

test("a body exactly at the limit is kept whole", async () => {
  const message = mail({ headerLines: PLAIN_HEADERS, body: "a".repeat(BODY_LIMIT - 1) });
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  await worker.email(message, env, CTX);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(String(stored[0]!.body).length, BODY_LIMIT);
  assert.equal(stored[0]!.bodyCut, 0);
});

const SKIPPED = [
  { name: "auto-replied", headerLines: ["Auto-Submitted: auto-replied"] },
  { name: "empty Auto-Submitted", headerLines: ["Auto-Submitted:"] },
  { name: "list-id", headerLines: ["List-Id: <list.example.invalid>"] },
  { name: "empty envelope sender", headerLines: [], envelopeFrom: "" },
  { name: "mailer-daemon envelope", headerLines: [], envelopeFrom: "MAILER-DAEMON@example.invalid" },
  { name: "postmaster envelope", headerLines: [], envelopeFrom: "Postmaster@example.invalid" },
  { name: "noreply envelope", headerLines: [], envelopeFrom: "noreply@example.invalid" },
  { name: "no-reply envelope", headerLines: [], envelopeFrom: "No-Reply@example.invalid" },
  { name: "donotreply envelope", headerLines: [], envelopeFrom: "DoNotReply@example.invalid" },
  { name: "machine header From", headerLines: ["From: Mail Delivery <noreply@example.invalid>"] },
];

for (const skipped of SKIPPED) {
  test(`a message from a ${skipped.name} sender is forwarded and not stored`, async () => {
    const message = mail({
      headerLines: [
        "From: Ada Lovelace <ada@example.invalid>",
        `To: ${SUPPORT}`,
        "Subject: Automatic",
        ...skipped.headerLines,
      ],
      body: PLAIN_BODY,
      envelopeFrom: skipped.envelopeFrom,
    });
    const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
    await worker.email(message, env, CTX);
    assert.deepEqual(message.forwarded, [FORWARD_TO]);
    assert.deepEqual(message.rejected, []);
    assert.equal(message.reads.count, 0);
    assert.deepEqual(await rows(env.DB), []);
  });
}

const KEPT = [
  { name: 'Auto-Submitted "no"', headerLines: ["Auto-Submitted: no"], envelopeFrom: "customer@example.invalid" },
  { name: 'Auto-Submitted "No"', headerLines: ["Auto-Submitted: No"], envelopeFrom: "customer@example.invalid" },
  { name: "reply sender", headerLines: [], envelopeFrom: "reply@example.invalid" },
  { name: "noreply2 sender", headerLines: [], envelopeFrom: "noreply2@example.invalid" },
];

for (const kept of KEPT) {
  test(`a message from a ${kept.name} is stored`, async () => {
    const message = mail({
      headerLines: ["From: Ada Lovelace <ada@example.invalid>", `To: ${SUPPORT}`, "Subject: A person", ...kept.headerLines],
      body: PLAIN_BODY,
      envelopeFrom: kept.envelopeFrom,
    });
    const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
    await worker.email(message, env, CTX);
    assert.deepEqual(message.forwarded, [FORWARD_TO]);
    assert.deepEqual(message.rejected, []);
    assert.equal((await rows(env.DB)).length, 1);
  });
}

test("a missing forward address still stores, logs one line, and refuses the delivery", async () => {
  const message = mail({ headerLines: PLAIN_HEADERS, body: PLAIN_BODY });
  const env = supportEnv();
  const log = captureLog();
  try {
    await worker.email(message, env, CTX);
  } finally {
    log.restore();
  }
  assert.deepEqual(message.forwarded, []);
  assert.deepEqual(message.rejected, [REJECTION]);
  assert.deepEqual(log.lines, ["[support] support mail was not handled (forward-address-unset)"]);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.body, PLAIN_STORED);
  assert.equal(log.lines[0]!.includes("ada@example.invalid"), false);
  assert.equal(log.lines[0]!.includes("bridge table"), false);
});

test("a throwing forward still stores, logs one line, and refuses the delivery", async () => {
  const message = mail({ headerLines: PLAIN_HEADERS, body: PLAIN_BODY });
  message.forward = async () => {
    throw new Error("forwarding to owner@example.invalid failed");
  };
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  const log = captureLog();
  try {
    await worker.email(message, env, CTX);
  } finally {
    log.restore();
  }
  assert.deepEqual(message.rejected, [REJECTION]);
  assert.deepEqual(log.lines, ["[support] support mail was not handled (forward)"]);
  assert.equal((await rows(env.DB)).length, 1);
  assert.equal(log.lines[0]!.includes(FORWARD_TO), false);
  assert.equal(log.lines[0]!.includes("bridge table"), false);
});

test("a store failure forwards and keeps the delivery", async () => {
  const database = testDatabase();
  const db: Env["DB"] = {
    prepare() {
      throw new Error("the database is locked");
    },
    batch: database.batch,
    exec: database.exec,
  };
  const message = mail({ headerLines: PLAIN_HEADERS, body: PLAIN_BODY });
  const env = supportEnv({ DB: db, SUPPORT_FORWARD_TO: FORWARD_TO });
  const log = captureLog();
  try {
    await worker.email(message, env, CTX);
  } finally {
    log.restore();
  }
  assert.deepEqual(message.forwarded, [FORWARD_TO]);
  assert.deepEqual(message.rejected, []);
  assert.deepEqual(log.lines, ["[support] support mail was not handled (store)"]);
});

test("an oversized message stores its headers and an empty body without reading raw", async () => {
  const message = mail({
    headerLines: PLAIN_HEADERS,
    body: "not parsed",
    rawSize: RAW_PARSE_LIMIT + 1,
    unreadable: true,
  });
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  await worker.email(message, env, CTX);
  assert.deepEqual(message.forwarded, [FORWARD_TO]);
  assert.deepEqual(message.rejected, []);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.subject, "A question about the bridge");
  assert.equal(stored[0]!.messageId, "<plain-1@example.invalid>");
  assert.equal(stored[0]!.body, "");
  assert.equal(stored[0]!.bodyCut, 1);
});

test("the scheduled run deletes only mail received more than 90 days ago", async () => {
  const db = testDatabase();
  const at = Date.parse("2026-10-27T03:17:00.000Z");
  const insert = (id: string, receivedAt: string) =>
    db
      .prepare("INSERT INTO support_mail (id, receivedAt, envelopeFrom, envelopeTo, body, bodyCut) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, receivedAt, "ada@example.invalid", SUPPORT, "", 0)
      .run();
  await insert("older", new Date(at - 90 * 86_400_000 - 1).toISOString());
  await insert("exactly", new Date(at - 90 * 86_400_000).toISOString());
  await insert("recent", new Date(at - 89 * 86_400_000).toISOString());
  await worker.scheduled({ scheduledTime: at, cron: "17 3 * * *" }, supportEnv({ DB: db }), CTX);
  const result = await db.prepare("SELECT id FROM support_mail ORDER BY id").all();
  assert.deepEqual(result.results.map((row) => row.id), ["exactly", "recent"]);
});

test("the Worker exposes fetch, email and scheduled", () => {
  assert.deepEqual(Object.keys(worker).sort(), ["email", "fetch", "scheduled"]);
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.email, "function");
  assert.equal(typeof worker.scheduled, "function");
});

const HOSTILE_HEADERS = [
  "From: Customer <customer@example.invalid>",
  `To: ${SUPPORT}`,
  "Subject: Hostile body",
  "Content-Type: text/html; charset=utf-8",
];

test("a 5 MiB HTML body of ampersands is converted and cut within the time limit", async () => {
  const message = mail({
    headerLines: [...HOSTILE_HEADERS, "Content-Transfer-Encoding: 8bit"],
    body: "&".repeat(5_242_624),
  });
  assert.ok(message.rawSize < RAW_PARSE_LIMIT, `fixture raw size ${message.rawSize}`);
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  const started = performance.now();
  await worker.email(message, env, CTX);
  const elapsed = performance.now() - started;
  assert.deepEqual(message.forwarded, [FORWARD_TO]);
  assert.deepEqual(message.rejected, []);
  assert.ok(elapsed < 2000, `the 5 MiB body took ${elapsed.toFixed(1)} ms`);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.body, "&".repeat(BODY_LIMIT));
  assert.equal(stored[0]!.bodyCut, 1);
});

test("a quoted-printable HTML body of ampersands is converted and cut within the time limit", async () => {
  const message = mail({
    headerLines: [...HOSTILE_HEADERS, "Content-Transfer-Encoding: quoted-printable"],
    body: ("&".repeat(72) + "=\r\n").repeat(41_666) + "&".repeat(48),
  });
  assert.ok(message.rawSize < RAW_PARSE_LIMIT, `fixture raw size ${message.rawSize}`);
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  const started = performance.now();
  await worker.email(message, env, CTX);
  const elapsed = performance.now() - started;
  assert.deepEqual(message.forwarded, [FORWARD_TO]);
  assert.deepEqual(message.rejected, []);
  assert.ok(elapsed < 2000, `the quoted-printable body took ${elapsed.toFixed(1)} ms`);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.body, "&".repeat(BODY_LIMIT));
  assert.equal(stored[0]!.bodyCut, 1);
});

test("an unterminated head close tag stops the close-tag search", async () => {
  const message = mail({
    headerLines: [...HOSTILE_HEADERS, "Content-Transfer-Encoding: 8bit"],
    body: "<head>" + "</head".repeat(866_666),
  });
  assert.ok(message.rawSize < RAW_PARSE_LIMIT, `fixture raw size ${message.rawSize}`);
  const env = supportEnv({ SUPPORT_FORWARD_TO: FORWARD_TO });
  const started = performance.now();
  await worker.email(message, env, CTX);
  const elapsed = performance.now() - started;
  assert.deepEqual(message.forwarded, [FORWARD_TO]);
  assert.deepEqual(message.rejected, []);
  assert.ok(elapsed < 2000, `the unterminated close tag body took ${elapsed.toFixed(1)} ms`);
  const stored = await rows(env.DB);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.body, "");
  assert.equal(stored[0]!.bodyCut, 0);
});
