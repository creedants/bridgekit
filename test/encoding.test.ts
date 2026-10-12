import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCsvBuffer, ENCODING_SENTENCE, isValidUtf8, type DecodedCsv } from "../src/app/encoding.ts";

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

function joined(...parts: Uint8Array[]): Uint8Array {
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
