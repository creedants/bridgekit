import assert from "node:assert/strict";
import { APIError } from "better-auth";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import { EMAIL_NOT_SET_UP } from "../server/email.ts";
import type { Env } from "../server/env.ts";
import { sendEmail } from "../server/email.ts";
import { testDatabase } from "./support/d1.ts";

const TO = "review@example.invalid";
const SUBJECT = "Your PVM Bridge sign-in link";
const LINK =
  "http://127.0.0.1:8790/api/auth/magic-link/verify?token=8f2504e0d4f4e5f6a7b8c9d0e1f2a3b4&callbackURL=http%3A%2F%2F127.0.0.1%3A8790%2Fapp%2F";
const TEXT = `Sign in to PVM Bridge:\n\n${LINK}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`;

const assets: Fetcher = {
  async fetch() {
    return new Response("missing", { status: 500 });
  },
};

/** The mail fields are the only part of the environment sendEmail reads. */
function mailEnv(fields: { RESEND_API_KEY?: string; EMAIL_FROM?: string; LOCAL_EMAIL_LOG?: string }): Env {
  return {
    ASSETS: assets,
    DB: testDatabase(),
    BETTER_AUTH_URL: "http://127.0.0.1:8790",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    ...fields,
  };
}

type Sent = { url: string; init: RequestInit };

/** Records every fetch instead of reaching Resend. */
async function withFetch(run: (sent: Sent[]) => Promise<void>): Promise<Sent[]> {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    sent.push({ url, init: init ?? {} });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await run(sent);
  } finally {
    globalThis.fetch = original;
  }
  return sent;
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

function assertNoSecretLeaked(lines: string[], label: string): void {
  for (const line of lines) {
    assert.equal(line.includes("magic-link/verify"), false, `${label} logged the link: ${line}`);
    assert.equal(line.includes("token="), false, `${label} logged the token: ${line}`);
    assert.equal(line.includes(TO), false, `${label} logged the address: ${line}`);
  }
}

test("a key and a sender put the same request on the wire", async () => {
  const sent = await withFetch(async () => {
    await sendEmail(mailEnv({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "PVM Bridge <no-reply@example.invalid>" }), TO, SUBJECT, TEXT);
  });
  assert.deepEqual(sent, [
    {
      url: "https://api.resend.com/emails",
      init: {
        method: "POST",
        headers: { authorization: "Bearer re_test_key", "content-type": "application/json" },
        body: JSON.stringify({ from: "PVM Bridge <no-reply@example.invalid>", to: TO, subject: SUBJECT, text: TEXT }),
      },
    },
  ]);
});

test("a key and a sender still send when the local log is on", async () => {
  const sent = await withFetch(async () => {
    await sendEmail(mailEnv({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "no-reply@example.invalid", LOCAL_EMAIL_LOG: "on" }), TO, SUBJECT, TEXT);
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
});

test("a sender with no key is not sent and not logged", async () => {
  const log = captureLog();
  try {
    await assert.rejects(sendEmail(mailEnv({ EMAIL_FROM: "no-reply@example.invalid" }), TO, SUBJECT, TEXT), (error: unknown) => {
      assert.ok(error instanceof APIError);
      assert.equal(error.message, EMAIL_NOT_SET_UP);
      return true;
    });
  } finally {
    log.restore();
  }
  assert.deepEqual(log.lines, []);
});

test("no key and LOCAL_EMAIL_LOG exactly on writes the message to the log", async () => {
  const log = captureLog();
  try {
    await sendEmail(mailEnv({ LOCAL_EMAIL_LOG: "on" }), TO, SUBJECT, TEXT);
  } finally {
    log.restore();
  }
  assert.deepEqual(log.lines, [`[email] to ${TO}: ${SUBJECT}\n${TEXT}`]);
});

test("no key and a local log that is not exactly on throws and logs nothing", async () => {
  for (const value of [undefined, "", "ON", "true", " on"] as const) {
    const label = `LOCAL_EMAIL_LOG ${JSON.stringify(value)}`;
    const log = captureLog();
    let thrown: unknown;
    try {
      await sendEmail(mailEnv(value === undefined ? {} : { LOCAL_EMAIL_LOG: value }), TO, SUBJECT, TEXT);
    } catch (error) {
      thrown = error;
    } finally {
      log.restore();
    }
    assert.ok(thrown instanceof Error, `${label} did not throw`);
    assert.ok(thrown instanceof APIError, `${label} did not throw an APIError`);
    assert.equal(thrown.statusCode, 503);
    assert.equal(thrown.message, EMAIL_NOT_SET_UP);
    assert.deepEqual(log.lines, [], label);
    assertNoSecretLeaked(log.lines, label);
  }
});

test("no key and a missing local log are the same thing", async () => {
  const log = captureLog();
  try {
    await assert.rejects(sendEmail(mailEnv({}), TO, SUBJECT, TEXT));
  } finally {
    log.restore();
  }
  assert.deepEqual(log.lines, []);
});