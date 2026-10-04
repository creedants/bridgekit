import Anthropic from "@anthropic-ai/sdk";
import { parseSummary, type BridgeSummary } from "../src/summary.ts";

/**
 * POST /api/commentary: bridge totals in, AI-written commentary out.
 *
 * The browser never sees the API key; it sends a BridgeSummary (totals and
 * names only) and gets paragraphs back. Anything that is not exactly a
 * summary is refused before it reaches Anthropic. The handler uses only the
 * web-standard Request and Response, so it runs on Cloudflare Workers, Netlify
 * or Vercel functions, Deno, or Node behind the dev server.
 */

export const MODEL = "claude-opus-5-5";
const MAX_BODY_BYTES = 16_000;

export interface CommentaryOptions {
  apiKey: string;
  model?: string;
  /** Decides whether this caller may spend API credit, for example a signed-in Pro user. */
  authorize?: (request: Request) => Promise<boolean>;
  /** For tests. */
  client?: Pick<Anthropic, "beta">;
}

const SYSTEM = `You write commentary on a price-volume-mix sales bridge for a finance or pricing team. You receive only the bridge totals, as JSON. Write three to five short paragraphs in plain business English, suitable for a monthly business review: what changed overall, what drove it, how the drivers relate to each other, how far to trust the price figure given the match coverage, and two or three specific questions the team should look into next.

How the bridge is built, so you read it correctly:
- Attributes are listed from most to least important. A configuration is one combination of all of them.
- Volume: the change in units valued at the prior period's overall average price.
- Mix, one line per attribute: the effect of selling more of the higher- or lower-priced groups of that attribute.
- Price (like-for-like): the change in price on configurations sold in both periods. With a list price and discounts split, those two lines make up price. In a margin bridge, price and unit cost make up the change in unit margin.
- New configurations: configurations with no exact prior match. With newAndDiscontinued "difference" this is only their price difference from the nearest comparable group, and their units are in volume and mix; with "full" it is their full sales.
- Discontinued configurations: the mirror of new.
- Sales with no units: rebates, credits and fees, bridged on their own line.
- exactMatchShare is the share of current unit sales whose configuration also sold in the prior period. Price is measured only on that share; when it is low, more of the change sits in new configurations.
- The effects add up exactly to the change between priorTotal and currentTotal.

Rules:
- Use only the figures given. Do not invent causes, products, customers, markets or events. Where the cause is unknown, say what would need checking.
- Do not assume a currency. Write amounts as plain numbers rounded sensibly, such as 1.2M or 340K. Percentages are of the prior total unless you say otherwise.
- Plain paragraphs only: no headings, bullet points, bold or other formatting.`;

export async function handleCommentary(request: Request, options: CommentaryOptions): Promise<Response> {
  if (request.method !== "POST") return reply(405, { error: "Use POST." });
  if (options.authorize && !(await options.authorize(request))) {
    return reply(403, { error: "AI commentary is part of Pro. Sign in to a workspace with Pro to use it." });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "That request is too large to be bridge totals." });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "The request was not valid JSON." });
  }
  const summary = parseSummary((body as { summary?: unknown } | null)?.summary);
  if (!summary) return reply(400, { error: "The request must contain bridge totals only." });

  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  try {
    const message = await client.beta.messages.create({
      model: options.model ?? MODEL,
      max_tokens: 16_000,
      output_config: { effort: "medium" },
      // If a safety check declines the request, Anthropic retries it on a recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: prompt(summary) }],
    });
    if (message.stop_reason === "refusal") {
      return reply(502, { error: "The AI model declined to write commentary for this bridge." });
    }
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (paragraphs.length === 0) return reply(502, { error: "The AI model returned no text." });
    return reply(200, { paragraphs, model: message.model });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return reply(429, { error: "The AI service is busy. Try again in a minute." });
    if (error instanceof Anthropic.APIError) return reply(502, { error: `The AI service returned an error (${error.status ?? "no status"}).` });
    return reply(502, { error: "Could not reach the AI service." });
  }
}

function prompt(summary: BridgeSummary): string {
  return `Here are the bridge totals:\n\n${JSON.stringify(summary, null, 2)}\n\nWrite the commentary.`;
}

function reply(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
