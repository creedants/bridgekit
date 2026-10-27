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
        if (close !== -1) return close + 1;
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

function decodeEntities(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const amp = text.indexOf("&", index);
    if (amp === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, amp);
    const semicolon = text.indexOf(";", amp + 1);
    if (semicolon === -1 || semicolon - amp > 12) {
      output += "&";
      index = amp + 1;
      continue;
    }
    const body = text.slice(amp + 1, semicolon);
    const named = NAMED_ENTITIES.get(body);
    if (named !== undefined) {
      output += named;
      index = semicolon + 1;
      continue;
    }
    const numeric = numericEntity(body);
    if (numeric !== null) {
      output += numeric;
      index = semicolon + 1;
      continue;
    }
    output += "&";
    index = amp + 1;
  }
  return output;
}

/** The text an HTML part says, in one left-to-right pass so hostile input cannot backtrack. */
function htmlText(html: string): string {
  let output = "";
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      output += html.slice(index);
      break;
    }
    output += html.slice(index, open);
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
      output += "<";
      index = open + 1;
      continue;
    }
    const end = html.indexOf(">", nameStart);
    if (end === -1) {
      output += html.slice(open);
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
    if (BLOCK_TAGS.has(name)) output += "\n";
    index = end + 1;
  }
  return decodeEntities(output)
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

async function bodyOf(message: ForwardableEmailMessage): Promise<Body> {
  if (message.rawSize > RAW_PARSE_LIMIT) return { text: "", cut: true };
  try {
    const parsed = await PostalMime.parse(message.raw, { forceRfc822Attachments: true });
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

async function rowOf(message: ForwardableEmailMessage, receivedAt: string): Promise<SupportMailRow> {
  const body = await bodyOf(message);
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
  const row = skip === null ? await rowOf(message, receivedAt) : null;
  const failures: string[] = [];
  const forwarded = await forward(message, env.SUPPORT_FORWARD_TO);
  if (forwarded !== null) failures.push(forwarded);
  if (row !== null) {
    const stored = await store(env.DB, row);
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
