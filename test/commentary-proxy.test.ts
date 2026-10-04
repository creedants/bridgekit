import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCommentary, MODEL, type CommentaryOptions } from "../server/commentary.ts";
import type { BridgeConfig, BridgeResult } from "../src/engine.ts";
import { parseSummary, summarize } from "../src/summary.ts";

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
  assert.deepEqual(summarize(result, config), {
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
  });
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

test("the proxy sends the summary to the model and returns paragraphs", async () => {
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "Sales rose.\n\nVolume led." });
  const response = await handleCommentary(post({ summary: summarize(result, config) }), { apiKey: "k", client });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { paragraphs: ["Sales rose.", "Volume led."], model: MODEL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-opus-5-5");
  const content = (calls[0].messages as { content: string }[])[0].content;
  assert.match(content, /"priorTotal": 1000000/);
});

test("the proxy refuses anything that is not bridge totals, without calling the model", async () => {
  const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "x" });
  const options = { apiKey: "k", client };
  assert.equal((await handleCommentary(post({ summary: { rows: [] } }), options)).status, 400);
  assert.equal((await handleCommentary(post("not json"), options)).status, 400);
  assert.equal((await handleCommentary(post("x".repeat(20_000)), options)).status, 413);
  assert.equal((await handleCommentary(new Request("http://localhost/api/commentary"), options)).status, 405);
  const denied = await handleCommentary(post({ summary: summarize(result, config) }), { ...options, authorize: async () => false });
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);
});

test("a refusal from the model is reported, not shown as commentary", async () => {
  const { client } = fakeClient({ stop_reason: "refusal", text: "" });
  const response = await handleCommentary(post({ summary: summarize(result, config) }), { apiKey: "k", client });
  assert.equal(response.status, 502);
});
