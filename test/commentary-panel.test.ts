import assert from "node:assert/strict";
import { test } from "node:test";
import { commentaryPanel, commentaryPro, commentarySnapshot, noteSignedOut, type CommentaryState } from "../src/app/useConfig.ts";
import * as api from "../src/app/account.ts";
import type { Config } from "../src/app/account.ts";

// One row per state the panel can be in, decided without a browser.

const state = (over: Partial<CommentaryState> = {}): CommentaryState => ({
  config: null,
  user: undefined,
  workspaces: null,
  plans: {},
  clock: Date.parse("2026-10-12T00:00:00.000Z"),
  ...over,
});

const keyed: Config = { providers: [], commentary: true, billing: false };
const nokey: Config = { providers: [], commentary: false, billing: false };
const freePlan = { pro: false, status: null, seats: 1, currentPeriodEnd: null };
const proPlan = { pro: true, status: "active", seats: 1, currentPeriodEnd: null };

test("the flag off keeps the panel out whatever the deployment offers", () => {
  assert.equal(commentaryPanel(false, null, "unknown"), "hidden");
  assert.equal(commentaryPanel(false, nokey, "signed-out"), "hidden");
  assert.equal(commentaryPanel(false, keyed, "pro"), "hidden");
});

test("no key in the deployment keeps the panel out", () => {
  assert.equal(commentaryPanel(true, null, "unknown"), "hidden");
  assert.equal(commentaryPanel(true, null, "signed-out"), "hidden");
  assert.equal(commentaryPanel(true, null, "free"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "unknown"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "signed-out"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "free"), "hidden");
  assert.equal(commentaryPanel(true, nokey, "pro"), "hidden");
});

test("an answer still loading or failed keeps the panel out", () => {
  assert.equal(commentaryPanel(true, keyed, "unknown"), "hidden");
});

test("a signed-out visitor sees no panel", () => {
  assert.equal(commentaryPanel(true, keyed, "signed-out"), "hidden");
});

test("a signed-in person without Pro sees the hint and no button", () => {
  assert.equal(commentaryPanel(true, keyed, "free"), "hint");
});

test("a signed-in person with Pro sees the button", () => {
  assert.equal(commentaryPanel(true, keyed, "pro"), "button");
});

test("a Pro plan on any workspace the page has read is enough", () => {
  const one = state({ config: keyed, user: { id: "u", email: "a@b.c", name: "A" }, workspaces: [{ id: "w1", name: "W" }] });
  assert.equal(commentaryPro(one), "unknown");
  assert.equal(commentaryPro({ ...one, plans: { w1: freePlan } }), "free");
  assert.equal(commentaryPro({ ...one, plans: { w1: proPlan } }), "pro");

  const two = state({ ...one, workspaces: [{ id: "w1", name: "A" }, { id: "w2", name: "B" }] });
  assert.equal(commentaryPro(two), "unknown");
  assert.equal(commentaryPro({ ...two, plans: { w1: freePlan } }), "unknown");
  assert.equal(commentaryPro({ ...two, plans: { w1: freePlan, w2: freePlan } }), "free");
  assert.equal(commentaryPro({ ...two, plans: { w1: freePlan, w2: proPlan } }), "pro");
});

test("a signed-in person with no workspace has no Pro", () => {
  assert.equal(commentaryPro(state({ user: { id: "u", email: "a@b.c", name: "A" }, workspaces: [] })), "free");
});

test("an unread session or workspace list leaves the answer unknown", () => {
  assert.equal(commentaryPro(state()), "unknown");
  assert.equal(commentaryPro(state({ user: undefined })), "unknown");
  assert.equal(commentaryPro(state({ user: null })), "signed-out");
  assert.equal(commentaryPro(state({ user: { id: "u", email: "a@b.c", name: "A" } })), "unknown");
});

// The lifecycle that fills the record. These drive the real account wrappers
// against a fake fetch the way the Workspace panel does, so a read can land,
// fail, or arrive after the page has moved on.

type Reply = () => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let replies: Record<string, Reply> = {};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
  const reply = replies[path];
  if (!reply) return json({ error: `No fake answer for ${path}.` }, 500);
  return reply();
}) as typeof fetch;

const answer = (routes: Record<string, unknown>): void => {
  replies = Object.fromEntries(
    Object.entries(routes).map(([path, body]) => [path, typeof body === "function" ? (body as Reply) : () => json(body)]),
  );
};

/** A read that has not landed yet; land() releases it with the given body. */
function pending(): { reply: Reply; land: (body: unknown) => void } {
  let release!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { reply: () => waiting, land: (body) => release(json(body)) };
}

/** A read the server refuses, which is what the wrapper turns into a failure. */
const refused = (): Reply => () => json({ error: "Review simulated read failure." }, 500);

const user = { id: "u", email: "u@example.invalid", name: "U" };
const other = { id: "v", email: "v@example.invalid", name: "V" };
// A known end time ahead of the read, so the record's own clock is before it
// and the tests below decide what happens as the clock moves on.
const cancelEnd = new Date(Date.now() + 86_400_000).toISOString();
const canceledPlan = { pro: true, status: "canceled", seats: 1, currentPeriodEnd: cancelEnd };

const offer = (): "hidden" | "hint" | "button" =>
  commentaryPanel(true, commentarySnapshot().config, commentaryPro(commentarySnapshot()));

/** The record is module state, so every test starts the page from a sign-out. */
const signIn = async (workspaces: { id: string; name: string; plan: unknown }[]): Promise<void> => {
  const routes: Record<string, unknown> = {
    "/api/config": keyed,
    "/api/auth/get-session": { user },
    "/api/auth/organization/list": workspaces.map((w) => ({ id: w.id, name: w.name })),
  };
  for (const w of workspaces) routes[`/api/workspaces/${w.id}`] = { role: "owner", plan: w.plan };
  answer(routes);
  noteSignedOut();
  await api.getConfig();
  await api.getUser();
  await api.listWorkspaces();
};

/** Opening a workspace reads its plan. */
const openWorkspace = (id: string) => api.getPlan(id);

test("a workspace read as Pro is enough while another workspace is unread", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: proPlan }, { id: "free", name: "Free", plan: freePlan }]);
  await openWorkspace("pro");
  assert.equal(commentaryPro(commentarySnapshot()), "pro");
  assert.equal(offer(), "button");
});

test("a plan read that fails takes that workspace's plan back to unknown", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: proPlan }]);
  await openWorkspace("pro");
  assert.equal(offer(), "button");
  answer({ "/api/workspaces/pro": refused() });
  await assert.rejects(() => openWorkspace("pro"));
  assert.equal(offer(), "hidden");
});

test("a session read that fails takes the person back to unknown", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: proPlan }]);
  await openWorkspace("pro");
  assert.equal(offer(), "button");
  answer({ "/api/auth/get-session": refused() });
  await assert.rejects(() => api.getUser());
  assert.equal(commentarySnapshot().user, undefined);
  assert.equal(offer(), "hidden");
});

test("a workspace list read that fails takes the list back to unknown", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: proPlan }]);
  await openWorkspace("pro");
  assert.equal(offer(), "button");
  answer({ "/api/auth/organization/list": refused() });
  await assert.rejects(() => api.listWorkspaces());
  assert.equal(commentarySnapshot().workspaces, null);
  assert.equal(offer(), "hidden");
});

test("a different person signing in starts from nothing", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: proPlan }]);
  await openWorkspace("pro");
  assert.equal(offer(), "button");
  answer({ "/api/auth/get-session": { user: other } });
  await api.getUser();
  assert.deepEqual(commentarySnapshot().workspaces, null);
  assert.deepEqual(commentarySnapshot().plans, {});
  assert.equal(offer(), "hidden");
});

test("a session read begun before a sign-out writes nothing after it", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: proPlan }]);
  await openWorkspace("pro");
  assert.equal(offer(), "button");
  const late = pending();
  answer({ "/api/auth/get-session": late.reply });
  const before = api.getUser();
  answer({ "/api/auth/sign-out": {} });
  await api.signOut();
  late.land({ user });
  await before;
  assert.equal(commentarySnapshot().user, null);
  assert.equal(offer(), "hidden");
});

test("a successful account deletion hides the panel", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: proPlan }]);
  await openWorkspace("pro");
  assert.equal(offer(), "button");
  answer({ "/api/auth/delete-user": {} });
  await api.deleteAccount();
  assert.equal(commentarySnapshot().user, null);
  assert.equal(offer(), "hidden");
});

test("a cancelled plan stops counting as Pro at its end time", async () => {
  await signIn([{ id: "pro", name: "Pro", plan: canceledPlan }]);
  await openWorkspace("pro");
  assert.equal(offer(), "button");
  const seeded = commentarySnapshot();
  const end = Date.parse(cancelEnd);
  assert.equal(commentaryPro({ ...seeded, clock: end - 1 }), "pro");
  assert.equal(commentaryPanel(true, keyed, commentaryPro({ ...seeded, clock: end - 1 })), "button");
  assert.equal(commentaryPro({ ...seeded, clock: end }), "free");
  assert.equal(commentaryPanel(true, keyed, commentaryPro({ ...seeded, clock: end })), "hint");
});

test("the client's end-time rule is the server's rule", async () => {
  const { hasPro } = await import("../server/paddle.ts");
  const ended = "2026-10-12T12:00:00.000Z";
  const before = new Date("2026-10-12T11:59:59.000Z");
  const after = new Date("2026-10-12T12:00:01.000Z");
  const cases: [string, string | null, Date][] = [
    ["active", null, before],
    ["trialing", ended, before],
    ["past_due", ended, after],
    ["canceled", ended, before],
    ["canceled", ended, after],
    ["canceled", null, before],
    ["paused", ended, before],
  ];
  for (const [status, currentPeriodEnd, now] of cases) {
    const read = commentaryPro(
      state({
        user: { id: "u", email: "a@b.c", name: "A" },
        workspaces: [{ id: "w", name: "W" }],
        plans: { w: { pro: true, status, seats: 1, currentPeriodEnd } },
        clock: now.getTime(),
      }),
    );
    assert.equal(read === "pro", hasPro(status as "active", currentPeriodEnd, now), `${status} at ${now.toISOString()}`);
  }
});
