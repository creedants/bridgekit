import assert from "node:assert/strict";
import { test } from "node:test";
import { blobIsUtf8, decodeCsvBuffer, ENCODING_SENTENCE, isUtf8Prefix, isValidUtf8, type DecodedCsv } from "../src/app/encoding.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = littleEndian ? code & 0xff : code >> 8;
    out[i * 2 + 1] = littleEndian ? code >> 8 : code & 0xff;
  }
  return out;
}

const BOM_UTF16_LE = [0xff, 0xfe];
const BOM_UTF16_BE = [0xfe, 0xff];
const BOM_UTF8 = [0xef, 0xbb, 0xbf];

// Pinned as a literal so rewording the sentence fails here too.
const SENTENCE = "This file's text encoding could not be read. Save it as CSV UTF-8.";

function joined(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Windows-1252 code points above ASCII, used to build a real Excel export.
const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
  "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
  "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  "¡": 0xa1, "¢": 0xa2, "£": 0xa3, "¤": 0xa4, "¥": 0xa5, "§": 0xa7, "¨": 0xa8,
  "©": 0xa9, "ª": 0xaa, "«": 0xab, "®": 0xae, "°": 0xb0, "±": 0xb1, "µ": 0xb5,
  "»": 0xbb, "¼": 0xbc, "½": 0xbd, "¾": 0xbe, "À": 0xc0, "Á": 0xc1, "Â": 0xc2,
  "Ã": 0xc3, "Ä": 0xc4, "Å": 0xc5, "Æ": 0xc6, "Ç": 0xc7, "È": 0xc8, "É": 0xc9,
  "Ê": 0xca, "Ë": 0xcb, "Ì": 0xcc, "Í": 0xcd, "Î": 0xce, "Ï": 0xcf, "Ñ": 0xd1,
  "Ò": 0xd2, "Ó": 0xd3, "Ô": 0xd4, "Õ": 0xd5, "Ö": 0xd6, "Ø": 0xd8, "Ù": 0xd9,
  "Ú": 0xda, "Û": 0xdb, "Ü": 0xdc, "Ý": 0xdd, "Þ": 0xde, "ß": 0xdf, "à": 0xe0,
  "á": 0xe1, "â": 0xe2, "ã": 0xe3, "ä": 0xe4, "å": 0xe5, "æ": 0xe6, "ç": 0xe7,
  "è": 0xe8, "é": 0xe9, "ê": 0xea, "ë": 0xeb, "ì": 0xec, "í": 0xed, "î": 0xee,
  "ï": 0xef, "ñ": 0xf1, "ò": 0xf2, "ó": 0xf3, "ô": 0xf4, "õ": 0xf5, "ö": 0xf6,
  "ø": 0xf8, "ù": 0xf9, "ú": 0xfa, "û": 0xfb, "ü": 0xfc, "ý": 0xfd, "þ": 0xfe,
  "ÿ": 0xff,
};

function windows1252(text: string): Uint8Array {
  return Uint8Array.from([...text].map((character) => {
    const byte = CP1252[character] ?? character.codePointAt(0)!;
    assert.ok(byte < 0x100, `no Windows-1252 byte for ${character}`);
    return byte;
  }));
}

function asUtf8(decision: DecodedCsv): Uint8Array {
  assert.equal(decision.kind, "utf8");
  return decision.kind === "utf8" ? decision.bytes : new Uint8Array();
}

function asText(decision: DecodedCsv): string {
  assert.equal(decision.kind, "text");
  return decision.kind === "text" ? decision.text : "";
}

test("a UTF-8 file with no byte-order mark is handed over unchanged", () => {
  const bytes = utf8("period,product,units,sales\n2025,Café,10,100.5\n");
  assert.deepEqual(asUtf8(decodeCsvBuffer(bytes)), bytes);
});

test("a UTF-8 file with a byte-order mark is handed over unchanged", () => {
  const bytes = joined(Uint8Array.from([0xef, 0xbb, 0xbf]), utf8("period,product,units,sales\n2025,Café,10,100.5\n"));
  assert.deepEqual(asUtf8(decodeCsvBuffer(bytes)), bytes);
});

test("a valid UTF-8 file that holds a NUL is still handed over unchanged", () => {
  const bytes = Uint8Array.from([0x41, 0x00, 0x62, 0x00, 0x0a, 0x00]);
  assert.deepEqual(asUtf8(decodeCsvBuffer(bytes)), bytes);
});

test("an empty file is handed over unchanged", () => {
  const bytes = new Uint8Array(0);
  assert.deepEqual(asUtf8(decodeCsvBuffer(bytes)), bytes);
});

test("Windows-1252 accented letters, the euro sign and curly quotes decode", () => {
  const text = "Café,€,“curly”,naïve,façade,Straße,à la carte";
  assert.equal(asText(decodeCsvBuffer(windows1252(text))), text);
});

test("UTF-16 little-endian with a byte-order mark decodes and drops the mark", () => {
  const text = "period,product,units,sales\n2025,Café,10,100.5\n";
  const bytes = joined(Uint8Array.from(BOM_UTF16_LE), utf16(text, true));
  assert.equal(asText(decodeCsvBuffer(bytes)), text);
});

test("UTF-16 big-endian with a byte-order mark decodes and drops the mark", () => {
  const text = "period,product,units,sales\n2025,Café,10,100.5\n";
  const bytes = joined(Uint8Array.from(BOM_UTF16_BE), utf16(text, false));
  assert.equal(asText(decodeCsvBuffer(bytes)), text);
});

test("UTF-16 without a byte-order mark shows the plain sentence", () => {
  for (const littleEndian of [true, false]) {
    const bytes = utf16("period,product\n2025,Café\n", littleEndian);
    assert.throws(() => decodeCsvBuffer(bytes), { message: ENCODING_SENTENCE });
  }
});

test("a marked UTF-16 file with an unpaired high surrogate shows the plain sentence", () => {
  for (const littleEndian of [true, false]) {
    const bytes = joined(Uint8Array.from(littleEndian ? BOM_UTF16_LE : BOM_UTF16_BE), utf16("period,product\n2025,Caf\uD800\n", littleEndian));
    assert.throws(() => decodeCsvBuffer(bytes), { message: SENTENCE });
  }
});

test("a marked UTF-16 file with an odd byte count shows the plain sentence", () => {
  for (const littleEndian of [true, false]) {
    const marked = joined(Uint8Array.from(littleEndian ? BOM_UTF16_LE : BOM_UTF16_BE), utf16("period,product\n2025,Café\n", littleEndian));
    assert.throws(() => decodeCsvBuffer(marked.subarray(0, marked.length - 1)), { message: SENTENCE });
  }
});

test("a UTF-8 mark on bytes that are not UTF-8 shows the plain sentence", () => {
  const bytes = joined(Uint8Array.from(BOM_UTF8), windows1252("period,product\n2025,Café\n"));
  assert.throws(() => decodeCsvBuffer(bytes), { message: SENTENCE });
});

test("a UTF-8 mark on valid UTF-8 is handled as the original file", () => {
  const bytes = joined(Uint8Array.from(BOM_UTF8), utf8("period,product\n2025,Café\n"));
  assert.deepEqual(asUtf8(decodeCsvBuffer(bytes)), bytes);
});

test("the five bytes Windows-1252 leaves undefined show the plain sentence", () => {
  for (const byte of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
    const bytes = joined(utf8("period,product\n2025,Caf"), Uint8Array.from([byte]), utf8("\n"));
    assert.throws(() => decodeCsvBuffer(bytes), { message: SENTENCE }, `byte ${byte.toString(16)}`);
  }
});

test("valid UTF-8 holding those control characters is handed over unchanged", () => {
  const bytes = utf8("period,product\n2025,Caf\u0081\u008d\u008f\u0090\u009d\n");
  assert.deepEqual(asUtf8(decodeCsvBuffer(bytes)), bytes);
});

test("binary junk shows the plain sentence", () => {
  assert.throws(() => decodeCsvBuffer(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), {
    message: ENCODING_SENTENCE,
  });
});

test("a UTF-32 byte-order mark shows the plain sentence", () => {
  assert.throws(
    () => decodeCsvBuffer(Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])),
    { message: ENCODING_SENTENCE },
  );
  assert.throws(
    () => decodeCsvBuffer(Uint8Array.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41])),
    { message: ENCODING_SENTENCE },
  );
});

test("isValidUtf8 tells a truncated multi-byte tail from junk", () => {
  assert.equal(isValidUtf8(utf8("Café")), true);
  assert.equal(isValidUtf8(Uint8Array.from([0x43, 0x61, 0x66, 0xc3])), false);
  assert.equal(isValidUtf8(Uint8Array.from([0xc3, 0xa9])), true);
});

test("isUtf8Prefix allows a prefix that stops inside a character", () => {
  // The prefix is bytes 0 to 65,535, so the lead byte of é sits at 65,535 and
  // its continuation at 65,536. The whole file is valid UTF-8.
  const boundary = joined(utf8("a".repeat(65535)), utf8("é"), utf8("period,product,units,sales\n2025,P2,10,100\n"));
  const prefix = boundary.subarray(0, 65536);
  assert.equal(isValidUtf8(prefix), false);
  assert.equal(isUtf8Prefix(prefix), true);
  assert.equal(isUtf8Prefix(boundary), true);
});

test("isUtf8Prefix still refuses a prefix that holds an invalid sequence", () => {
  assert.equal(isUtf8Prefix(Uint8Array.from([0x41, 0xff, 0x42])), false);
  assert.equal(isUtf8Prefix(Uint8Array.from([0x43, 0x61, 0x66, 0xc3, 0x28])), false);
  const damaged = joined(utf8("a".repeat(65535)), Uint8Array.from([0xff]), utf8("x"));
  assert.equal(isUtf8Prefix(damaged.subarray(0, 65536)), false);
});

test("isUtf8Prefix keeps no decoder state between files", () => {
  const boundary = joined(utf8("a".repeat(65535)), utf8("é"));
  const prefix = boundary.subarray(0, 65536);
  assert.equal(isUtf8Prefix(Uint8Array.from([0xff])), false);
  assert.equal(isUtf8Prefix(prefix), true);
  assert.equal(isUtf8Prefix(Uint8Array.from([0xc3, 0x28])), false);
  assert.equal(isUtf8Prefix(prefix), true);
  assert.equal(isUtf8Prefix(Uint8Array.from([0x69, 0xe2, 0x82])), true);
  assert.equal(isUtf8Prefix(Uint8Array.from([0x41])), true);
});

// A tiny slice size keeps the byte-check tests' files small while still
// splitting a character across two slices.
const PAGE = 64;

test("the byte check keeps a character split across two slices valid", async () => {
  // The lead byte of é ends slice 1 and its continuation starts slice 2.
  const bytes = joined(utf8("a".repeat(63)), utf8("é"), utf8("b".repeat(64)), utf8("z".repeat(64)));
  assert.equal(bytes.length, 193);
  assert.equal(await blobIsUtf8(new Blob([bytes]), PAGE), "valid");
});

test("a byte the check finds in its last slice is invalid", async () => {
  const bytes = joined(utf8("a".repeat(128)), Uint8Array.from([0xff]));
  assert.equal(await blobIsUtf8(new Blob([bytes]), PAGE), "invalid");
});

test("a multibyte character cut off at the end of the file is invalid", async () => {
  const bytes = joined(utf8("a".repeat(60)), Uint8Array.from([0xe2, 0x82]));
  assert.equal(await blobIsUtf8(new Blob([bytes]), PAGE), "invalid");
});

test("looksBinary refuses NUL and C0 controls but keeps text and UTF-16", async () => {
  const { looksBinary, NOT_TEXT_FILE } = await import("../src/app/encoding.ts");
  assert.equal(NOT_TEXT_FILE, "This file is not a text file. Save it as CSV UTF-8 or Excel (.xlsx).");
  assert.equal(looksBinary(new Uint8Array([])), false);
  assert.equal(looksBinary(utf8("period,units\n2025,10\n")), false);
  assert.equal(looksBinary(utf8("a\tb\rc\nd")), false);
  assert.equal(looksBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(looksBinary(Uint8Array.from([0x61, 0x00, 0x62])), true);
  assert.equal(looksBinary(Uint8Array.from([0x61, 0x07, 0x62])), true);
  assert.equal(looksBinary(joined(Uint8Array.from(BOM_UTF16_LE), utf16("a,b\n", true))), false);
});
