import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import { authOptions, createAuth } from "../server/auth.ts";
import { testDatabase } from "./support/d1.ts";

/**
 * Better Auth links a provider account to an existing account by matching the
 * email the provider reports. Microsoft's common tenant reports an email
 * without proving the user owns it, so a Microsoft sign-in must not be allowed
 * to link to an existing account. These tests check that the built options do
 * not trust Microsoft, and that a real callback whose email matches an existing
 * account is refused without touching it.
 */

const ORIGIN = "http://127.0.0.1:8791";
const AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const MICROSOFT_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

function bindings(db: Env["DB"] = database()): Env {
  const assets: Fetcher = {
    async fetch() {
      return new Response("missing", { status: 500 });
    },
  };
  return {
    ASSETS: assets,
    DB: db,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: AUTH_SECRET,
    MICROSOFT_CLIENT_ID: "fake-microsoft-client",
    MICROSOFT_CLIENT_SECRET: "fake-microsoft-secret",
    GOOGLE_CLIENT_ID: "fake-google-client",
    GOOGLE_CLIENT_SECRET: "fake-google-secret",
    ACCOUNTS: "on",
    LOCAL_EMAIL_LOG: "on",
  };
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

function headers(client: string, cookie?: string): Record<string, string> {
  return { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": client, ...(cookie ? { cookie } : {}) };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned Microsoft id token whose claims a common-tenant sign-in may carry. */
function idToken(): string {
  const claims = {
    oid: "00000000-1111-2222-3333-444444444444",
    sub: "fake-subject",
    tid: MICROSOFT_TENANT,
    email: "victim@example.com",
    name: "Victim",
    iss: `https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`,
  };
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.sig`;
}

/** Microsoft's token and photo endpoints, and nothing else. */
function providerFetch(token: string): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("login.microsoftonline.com")) {
      return Response.json({
        token_type: "Bearer",
        access_token: "fake-access-token",
        id_token: token,
        expires_in: 3600,
      });
    }
    if (url.includes("graph.microsoft.com")) return new Response("not found", { status: 404 });
    throw new Error(`unexpected fetch to ${url}`);
  };
}

test("the built options do not trust Microsoft for account linking", async () => {
  const options = authOptions(bindings(), async () => 1);
  const trusted = options.account.accountLinking.trustedProviders;
  assert.equal(Array.isArray(trusted), true, "the trusted providers are a fixed list");
  assert.ok((trusted as string[]).includes("google"), "Google remains a trusted provider");
  assert.equal((trusted as string[]).includes("microsoft"), false, "Microsoft is not a trusted provider");
});

test("a Microsoft sign-in whose email matches an existing account is not linked to it", async () => {
  const logs = captureConsole();
  try {
    const env = bindings();
    const auth = createAuth(env, async () => 1);
    const client = "198.51.100.61";

    // The existing account, created through the emailed sign-in link.
    const sent = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: headers(client),
        body: JSON.stringify({ email: "victim@example.com", callbackURL: `${ORIGIN}/app/` }),
      }),
    );
    assert.equal(sent.status, 200, await sent.clone().text());
    const link = logs.lines.join("\n").match(/https?:\/\/\S*\/api\/auth\/magic-link\/verify\?\S+/);
    assert.ok(link, "the sign-in link was written to the log");
    const verified = await auth.handler(new Request(link[0], { headers: headers(client) }));
    assert.equal(verified.status, 302, await verified.clone().text());

    const victim = await env.DB.prepare(`SELECT id, emailVerified FROM user WHERE email = 'victim@example.com'`).first<{
      id: string;
      emailVerified: number;
    }>();
    assert.ok(victim, "the existing account was created");
    assert.equal(victim.emailVerified, 1, "the existing account has a verified email");

    const accountRows = async (): Promise<Record<string, unknown>[]> =>
      (
        await env.DB
          .prepare(`SELECT id, providerId, accountId, userId FROM account WHERE userId = ? ORDER BY providerId, accountId`)
          .bind(victim.id)
          .all<Record<string, unknown>>()
      ).results;
    const users = async (): Promise<number> =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM user`).first<{ n: number }>())?.n ?? 0;
    const accountsBefore = await accountRows();
    const usersBefore = await users();

    // Start the Microsoft sign-in and keep its state and cookies for the callback.
    const started = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: headers(client),
        body: JSON.stringify({ provider: "microsoft", callbackURL: `${ORIGIN}/app/` }),
      }),
    );
    assert.equal(started.status, 200, await started.clone().text());
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    assert.ok(state, "the sign-in answered with a state");
    const cookie = started.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.ok(cookie.length > 0, "the sign-in set its state cookie");

    const originalFetch = globalThis.fetch;
    let callback: Response;
    try {
      globalThis.fetch = providerFetch(idToken());
      callback = await auth.handler(
        new Request(`${ORIGIN}/api/auth/callback/microsoft?code=fake-code&state=${encodeURIComponent(state)}`, {
          headers: headers(client, cookie),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(callback.status, 302, await callback.clone().text());
    const location = new URL(callback.headers.get("location") ?? "");
    assert.equal(location.pathname, "/api/auth/error", "the callback redirected to the error page");
    assert.equal(location.searchParams.get("error"), "account_not_linked", "the callback said the account was not linked");
    assert.equal(
      callback.headers.getSetCookie().some((entry) => entry.startsWith("better-auth.session_token")),
      false,
      "the callback set a session cookie",
    );

    const microsoft = await env.DB.prepare(`SELECT id FROM account WHERE providerId = 'microsoft'`).all<{ id: string }>();
    assert.equal(microsoft.results.length, 0, "a Microsoft account row was written");
    assert.deepEqual(await accountRows(), accountsBefore, "the existing account gained or lost an account row");
    assert.equal(await users(), usersBefore, "the sign-in created a user");
  } finally {
    logs.restore();
  }
});
