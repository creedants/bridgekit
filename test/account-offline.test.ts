import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as account from "../src/app/account.ts";

/**
 * The page asks its own server for the session, and, when the person presses the
 * button, for AI commentary. On the Cloudflare build a connection that has gone
 * makes fetch reject, and the browser's own "Failed to fetch" is not a sentence
 * to show. Both requests give one sentence instead, and a response the server
 * did send keeps the message it sent.
 */

const SENTENCE = "Could not reach the server. Check your connection and try again.";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const user = { id: "u", email: "u@example.invalid", name: "U" };

const SUMMARY: Parameters<typeof account.requestCommentary>[0] = {
  measure: "Sales",
  prior: "2025",
  current: "2026",
  priorTotal: 100,
  currentTotal: 120,
  effects: [{ label: "Volume", value: 20 }],
  attributes: ["Size"],
  exactMatchShare: 1,
  newAndDiscontinued: "difference",
};

type Reply = (path: string) => Response | Promise<Response>;

/** Answers every request for one test, records the paths asked for, and puts fetch back. */
async function withFake(reply: Reply, run: (asked: string[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    asked.push(path);
    return reply(path);
  }) as typeof fetch;
  try {
    await run(asked);
  } finally {
    globalThis.fetch = original;
  }
}

const unreachable: Reply = () => {
  throw new TypeError("Failed to fetch");
};

test("a request that never reached the server shows the sentence", async () => {
  await withFake(unreachable, async (asked) => {
    const failure = await account.getUser().catch((error: unknown) => error);
    assert.ok(failure instanceof Error, "the request resolved instead of failing");
    assert.equal(failure.message, SENTENCE);
    assert.equal(failure.message, account.UNREACHABLE_SENTENCE);
    assert.notEqual(failure.message, "Failed to fetch");
    assert.equal(account.UNREACHABLE_SENTENCE, SENTENCE);
    assert.deepEqual(asked, ["/api/auth/get-session"]);
  });
});

test("the commentary request shows the sentence, through the code the panel uses", async () => {
  await withFake(unreachable, async (asked) => {
    const failure = await account.requestCommentary(SUMMARY).catch((error: unknown) => error);
    assert.ok(failure instanceof Error, "the request resolved instead of failing");
    assert.equal(failure.message, SENTENCE);
    assert.equal(failure.message, account.UNREACHABLE_SENTENCE);
    assert.notEqual(failure.message, "Failed to fetch");
    assert.deepEqual(asked, ["/api/commentary"]);
  });

  const panel = readFileSync(new URL("../src/app/results/Summary.tsx", import.meta.url), "utf8");
  assert.ok(panel.includes("requestCommentary("), "the commentary panel does not call requestCommentary");
  assert.doesNotMatch(panel, /fetch\(/, "the commentary panel holds a fetch of its own");
});

test("a response the server sent keeps its own message", async () => {
  await withFake(
    () => json({ error: "Sign-in expired. Sign in again." }, 500),
    async () => {
      await assert.rejects(account.getUser(), { message: "Sign-in expired. Sign in again." });
    },
  );
  await withFake(
    () => json({ message: "Workspaces are read-only." }, 503),
    async () => {
      await assert.rejects(account.getUser(), { message: "Workspaces are read-only." });
    },
  );
  await withFake(
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    async () => {
      await assert.rejects(account.getUser(), { message: "The server returned 502." });
    },
  );
  await withFake(
    () => json({ error: "Commentary is unavailable." }, 500),
    async () => {
      await assert.rejects(account.requestCommentary(SUMMARY), { message: "Commentary is unavailable." });
    },
  );
  await withFake(
    () => json({ message: "No commentary today." }, 500),
    async () => {
      await assert.rejects(account.requestCommentary(SUMMARY), { message: "The server returned 500." });
    },
  );
});

test("a later retry works once the connection returns", async () => {
  let reads = 0;
  await withFake(
    () => {
      reads += 1;
      return reads === 1 ? unreachable("/api/auth/get-session") : json({ user });
    },
    async () => {
      await assert.rejects(account.getUser(), { message: SENTENCE });
      assert.deepEqual(await account.getUser(), user);
    },
  );

  let writes = 0;
  await withFake(
    () => {
      writes += 1;
      return writes === 1 ? unreachable("/api/commentary") : json({ paragraphs: ["a", "b"] });
    },
    async () => {
      await assert.rejects(account.requestCommentary(SUMMARY), { message: SENTENCE });
      assert.deepEqual(await account.requestCommentary(SUMMARY), ["a", "b"]);
    },
  );
});
