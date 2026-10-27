import PostalMime from "postal-mime";
import type { D1Database, ForwardableEmailMessage } from "./cloudflare.ts";
import type { Env } from "./env.ts";

const BODY_LIMIT = 100_000; // characters (code points) kept
const RAW_PARSE_LIMIT = 5 * 1024 * 1024; // bytes; exactly this much is parsed
const RETENTION_MS = 90 * 86_400_000;
const REJECTION = "This message could not be delivered. Please try again later.";

/** What the skip rules read: the envelope and those headers, never the body. */
type SenderFacts = {
  envelopeFrom: string;
  headerFrom: string | null;
  autoSubmitted: string | null;
  listId: string | null;
};

const MACHINE_LOCAL_PARTS = new Set(["mailer-daemon", "postmaster", "noreply", "no-reply", "donotreply"]);

/** A match is forwarded and not stored. A new rule is one row here. */
const SKIP_RULES: readonly (readonly [name: string, matches: (facts: SenderFacts) => boolean])[] = [
  ["auto-submitted", (facts) => facts.autoSubmitted !== null && facts.autoSubmitted.trim().toLowerCase() !== "no"],
  ["list-id", (facts) => facts.listId !== null],
  ["empty envelope sender", (facts) => facts.envelopeFrom.trim() === ""],
  [
    "automatic sender",
    (facts) =>
      MACHINE_LOCAL_PARTS.has(localPart(facts.envelopeFrom)) ||
      (facts.headerFrom !== null && MACHINE_LOCAL_PARTS.has(localPart(addressIn(facts.headerFrom)))),
  ],
];

function localPart(value: string): string {
  const at = value.lastIndexOf("@");
  return at === -1 ? "" : value.slice(0, at).trim().toLowerCase();
}

function addressIn(value: string): string {
  const open = value.lastIndexOf("<");
  const close = value.lastIndexOf(">");
  return open !== -1 && close > open ? value.slice(open + 1, close).trim() : value.trim();
}

function skipReason(message: ForwardableEmailMessage): string | null {
  const facts: SenderFacts = {
    envelopeFrom: message.from,
    headerFrom: message.headers.get("from"),
    autoSubmitted: message.headers.get("auto-submitted"),
    listId: message.headers.get("list-id"),
  };
  for (const [name, matches] of SKIP_RULES) {
    if (matches(facts)) return name;
  }
  return null;
}

type Body = { readonly text: string; readonly cut: boolean };

type SupportMailRow = {
  id: string;
  receivedAt: string;
  envelopeFrom: string;
  envelopeTo: string;
  headerFrom: string | null;
  subject: string | null;
  headerDate: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  body: string;
  bodyCut: 0 | 1;
};

const BLOCK_TAGS = new Set(["br", "p", "div", "tr", "li", "table", "blockquote", "hr", "h1", "h2", "h3", "h4", "h5", "h6"]);
const DROPPED_TAGS = new Set(["script", "style", "head"]);

function isAsciiLetterOrDigit(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** The tag's name, from just after `<` or `</` to the first `>`, space or `/`. */
function tagNameAt(html: string, start: number): string {
  let end = start;
  while (end < html.length) {
    const code = html.codePointAt(end) ?? 0;
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 47 || code === 62) break;
    end += 1;
  }
  return html.slice(start, end);
}

/** The index just past the element's close tag, found without lowercasing the whole input. */
function closeOf(html: string, name: string, from: number): number {
  let index = from;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) return -1;
    if (html[open + 1] === "/") {
      const end = open + 2 + name.length;
      if (html.slice(open + 2, end).toLowerCase() === name) {
        const close = html.indexOf(">", end);
        // A later candidate's search starts after this one, so it cannot find a `>` this one missed.
        if (close === -1) return -1;
        return close + 1;
      }
    }
    index = open + 1;
  }
  return -1;
}

const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", "\""],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
]);

function codePointText(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return String.fromCodePoint(value);
}

function numericEntity(body: string): string | null {
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const digits = body.slice(2);
    if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
    return codePointText(Number.parseInt(digits, 16));
  }
  if (body.startsWith("#")) {
    const digits = body.slice(1);
    if (!/^[0-9]+$/.test(digits)) return null;
    return codePointText(Number.parseInt(digits, 10));
  }
  return null;
}

const OUTPUT_BATCH = 1024;

/** Joins output fragments in batches, so a hostile body cannot build a long join list. */
function collector(): { add(part: string): void; text(): string } {
  const batches: string[] = [];
  let pending: string[] = [];
  return {
    add(part) {
      if (part === "") return;
      pending.push(part);
      if (pending.length === OUTPUT_BATCH) {
        batches.push(pending.join(""));
        pending = [];
      }
    },
    text() {
      batches.push(pending.join(""));
      pending = [];
      return batches.join("");
    },
  };
}

function decodeEntities(text: string): string {
  const out = collector();
  let index = 0;
  while (index < text.length) {
    const amp = text.indexOf("&", index);
    if (amp === -1) {
      out.add(text.slice(index));
      break;
    }
    out.add(text.slice(index, amp));
    // The `;` has to sit within 12 code units of the `&`, so only that window is searched.
    const window = text.slice(amp + 1, amp + 13);
    const relative = window.indexOf(";");
    if (relative === -1) {
      out.add("&");
      index = amp + 1;
      continue;
    }
    const semicolon = amp + 1 + relative;
    const body = text.slice(amp + 1, semicolon);
    const named = NAMED_ENTITIES.get(body);
    if (named !== undefined) {
      out.add(named);
      index = semicolon + 1;
      continue;
    }
    const numeric = numericEntity(body);
    if (numeric !== null) {
      out.add(numeric);
      index = semicolon + 1;
      continue;
    }
    out.add("&");
    index = amp + 1;
  }
  return out.text();
}

/**
 * The text an HTML part says, collected in one left-to-right pass. Each scan starts where the
 * previous one stopped: a tag at its `>`, a comment at its `-->`, a dropped element at its close
 * tag, whose `>` search ends the walk once no `>` is left. The entity scan that follows reads at
 * most 12 code units past its `&`. No search restarts over the remaining input, so hostile input
 * cannot make this pass quadratic.
 */
function htmlText(html: string): string {
  const out = collector();
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      out.add(html.slice(index));
      break;
    }
    out.add(html.slice(index, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }
    let nameStart = open + 1;
    const closing = html[nameStart] === "/";
    if (closing) nameStart += 1;
    const first = html[nameStart];
    if (first === undefined || !isAsciiLetterOrDigit(first)) {
      out.add("<");
      index = open + 1;
      continue;
    }
    const end = html.indexOf(">", nameStart);
    if (end === -1) {
      out.add(html.slice(open));
      break;
    }
    const name = tagNameAt(html, nameStart).toLowerCase();
    if (DROPPED_TAGS.has(name)) {
      if (closing) {
        index = end + 1;
        continue;
      }
      const close = closeOf(html, name, end + 1);
      if (close === -1) break;
      index = close;
      continue;
    }
    if (BLOCK_TAGS.has(name)) out.add("\n");
    index = end + 1;
  }
  return decodeEntities(out.text())
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keeps the first BODY_LIMIT code points, so a cut never splits a surrogate pair. */
function capBody(text: string): Body {
  if (text.length <= BODY_LIMIT) return { text, cut: false };
  let end = 0;
  let count = 0;
  for (const character of text) {
    if (count === BODY_LIMIT) return { text: text.slice(0, end), cut: true };
    end += character.length;
    count += 1;
  }
  return { text, cut: false };
}

/** The raw bytes to parse, or null when the message is too large to parse or its stream fails. */
async function rawOf(message: ForwardableEmailMessage): Promise<ArrayBuffer | null> {
  if (message.rawSize > RAW_PARSE_LIMIT) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = message.raw.getReader();
  } catch {
    return null;
  }
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes.buffer;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** Parses the buffered message and returns its text. Never throws. */
async function bodyOf(raw: ArrayBuffer | null): Promise<Body> {
  if (raw === null) return { text: "", cut: true };
  try {
    const parsed = await PostalMime.parse(raw, { forceRfc822Attachments: true });
    const text =
      parsed.text !== undefined && parsed.text !== ""
        ? parsed.text
        : parsed.html !== undefined
          ? htmlText(parsed.html)
          : "";
    return capBody(text);
  } catch {
    return { text: "", cut: true };
  }
}

function rowOf(message: ForwardableEmailMessage, receivedAt: string, body: Body): SupportMailRow {
  return {
    id: crypto.randomUUID(),
    receivedAt,
    envelopeFrom: message.from,
    envelopeTo: message.to,
    headerFrom: message.headers.get("from"),
    subject: message.headers.get("subject"),
    headerDate: message.headers.get("date"),
    messageId: message.headers.get("message-id"),
    inReplyTo: message.headers.get("in-reply-to"),
    body: body.text,
    bodyCut: body.cut ? 1 : 0,
  };
}

async function forward(
  message: ForwardableEmailMessage,
  to: string | undefined,
): Promise<"forward" | "forward-address-unset" | null> {
  if (to === undefined || to === "") return "forward-address-unset";
  try {
    await message.forward(to);
    return null;
  } catch {
    return "forward";
  }
}

async function store(db: D1Database, row: SupportMailRow): Promise<"store" | null> {
  try {
    await db
      .prepare(
        "INSERT INTO support_mail (id, receivedAt, envelopeFrom, envelopeTo, headerFrom, subject, headerDate, messageId, inReplyTo, body, bodyCut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.receivedAt,
        row.envelopeFrom,
        row.envelopeTo,
        row.headerFrom,
        row.subject,
        row.headerDate,
        row.messageId,
        row.inReplyTo,
        row.body,
        row.bodyCut,
      )
      .run();
    return null;
  } catch {
    return "store";
  }
}

/** Handles one message Email Routing delivered to the support address. */
export async function receiveSupportMail(
  message: ForwardableEmailMessage,
  env: Pick<Env, "DB" | "SUPPORT_FORWARD_TO">,
): Promise<void> {
  const receivedAt = new Date().toISOString();
  const skip = skipReason(message);
  // The bytes are read now but parsed only after the forward, so conversion cannot delay it.
  const raw = skip === null ? await rawOf(message) : null;
  const failures: string[] = [];

  const forwarded = await forward(message, env.SUPPORT_FORWARD_TO);
  if (forwarded !== null) failures.push(forwarded);

  if (skip === null) {
    const body = await bodyOf(raw);
    const stored = await store(env.DB, rowOf(message, receivedAt, body));
    if (stored !== null) failures.push(stored);
  }
  if (failures.length > 0) {
    console.error(
      `[support] support mail was not handled (${failures.join(", ")})${skip === null ? "" : `; not stored: ${skip}`}`,
    );
  }
  if (forwarded !== null) message.setReject(REJECTION);
}

/** Deletes stored support mail received more than 90 days before `now`. */
export async function purgeSupportMail(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  await db.prepare("DELETE FROM support_mail WHERE receivedAt < ?").bind(cutoff).run();
}
