import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import {
  blobIsUtf8,
  CSV_PREFIX_BYTES,
  decodeCsvBuffer,
  ENCODING_SENTENCE,
  isUtf8Prefix,
  isValidUtf8,
  readCsvFile,
  type CsvReading,
  type DecodedCsv,
} from "../src/app/encoding.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("?url")) {
      return { url: "data:text/javascript,export default \"stub\"", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

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

/** A File that counts what a load reads from it, so a test can prove a read count. */
class CountingFile extends File {
  wholeReads = 0;
  streamReads = 0;
  sliceSizes: number[] = [];

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.wholeReads += 1;
    return super.arrayBuffer();
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const part = super.slice(start, end, contentType);
    this.sliceSizes.push(part.size);
    return part;
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    this.streamReads += 1;
    return super.stream();
  }
}

/**
 * A file that reports more bytes than it holds, so a size limit is exercised
 * without allocating the bytes. A slice still returns the real content.
 */
class ReportedSizeFile extends CountingFile {
  readonly reportedSize: number;

  constructor(parts: BlobPart[], name: string, reportedSize: number) {
    super(parts, name);
    this.reportedSize = reportedSize;
  }

  override get size(): number {
    return this.reportedSize;
  }
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

// Pinned as a literal, like the encoding sentence, so rewording fails here too.
const TOO_BIG = "This file is too big to open in this browser. Try a smaller file, or save it with fewer rows or columns.";

test("a CSV whose invalid byte comes after the checked prefix shows the plain sentence", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const lines = ["period,product,units,sales,note"];
  for (let index = 0; index < 4000; index++) {
    lines.push(`2025,A-100,${(index % 5) + 1},${100 + index},note ${index}`);
  }
  const text = `${lines.join("\n")}\n`;
  assert.ok(text.length > 65536);
  // Every byte the prefix check reads is valid UTF-8, and only the last is not.
  const bytes = joined(utf8(text), Uint8Array.from([0xff]));
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "late-byte.csv");
  await writeFile(filePath, bytes);
  const file = new File([bytes], "late-byte.csv");
  const reading = await readCsvFile(file);
  // The late-byte check needs the file's own bytes, so the reading must hand them over.
  assert.deepEqual(reading, { kind: "bytes" });
  const query = await openDatabase();
  await assert.rejects(
    stageCsvAndSwap(query, file, "data", filePath, "month first", reading),
    (error: unknown) => (error as Error).message === SENTENCE,
    SENTENCE,
  );
});

test("a CSV of valid but unusual UTF-8 that fails for another reason keeps the database's own error", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const { readCsvFile } = await import("../src/app/encoding.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  // A byte-order mark, a composed é, a combining mark, a four-byte character,
  // then one field past the database's line limit.
  const text = `period,product,note\n2025,A-100,café\n2026,A-101,e\u0301\n2025,A-102,\u{1F600}\n2026,A-103,"${"x".repeat(2_097_152)}"\n`;
  const bytes = joined(Uint8Array.from(BOM_UTF8), utf8(text));
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "unusual-utf8.csv");
  await writeFile(filePath, bytes);
  const file = new File([bytes], "unusual-utf8.csv");
  const reading = await readCsvFile(file);
  assert.equal(reading.kind, "bytes");
  const query = await openDatabase();
  const failure = await stageCsvAndSwap(query, file, "data", filePath, "month first", reading).then(
    () => null,
    (error: unknown) => error as Error,
  );
  assert.ok(failure instanceof Error);
  assert.notEqual(failure.message, SENTENCE);
  assert.notEqual(failure.message, TOO_BIG);
  // Pinned as a literal so a changed database message fails here.
  assert.ok(failure.message.startsWith("Invalid Input Error: CSV Error on Line:"), failure.message);
});

test("a direct stageCsvAndSwap call with no reading argument still runs the check", async () => {
  const { stageCsvAndSwap } = await import("../src/app/db.ts");
  const rows = ["period,product,units,sales"];
  for (let index = 0; index < 12; index++) rows.push(`2025,A-10${index},${index + 1},${100 + index}`);
  // The invalid byte sits inside the prefix, so this test pins the default and
  // not how much of the file the check reads.
  const bytes = joined(utf8(`${rows.join("\n")}\n`), Uint8Array.from([0xff]));
  assert.ok(bytes.length < 65536);
  const file = new File([bytes], "small.csv");
  const query = async (): Promise<never> => {
    throw new Error("The reader refused the file.");
  };
  await assert.rejects(
    stageCsvAndSwap(query, file, "data", "small.csv"),
    (error: unknown) => (error as Error).message === SENTENCE,
    SENTENCE,
  );
});

/**
 * A database whose next statement starts a fresh instance when the Node
 * binding has invalidated this one. The browser's database survives the
 * internal error a refused CSV scan raises inside an aggregate, so the retry
 * can run there; @duckdb/node-api marks the instance unusable instead.
 */
async function recoveringDatabase(): Promise<(sql: string) => Promise<Record<string, unknown>[]>> {
  const { openDatabase } = await import("../src/duckdb.ts");
  let current = await openDatabase();
  return async (sql) => {
    let reopened = false;
    for (;;) {
      try {
        return await current(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (reopened || !message.includes("database has been invalidated")) throw error;
        reopened = true;
        current = await openDatabase();
      }
    }
  };
}

test("a Windows-1252 file whose only high byte comes after 64 KiB loads", async () => {
  const { loadCsv } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const lines = ["period,product,units,sales,note"];
  for (let index = 0; index < 4000; index++) {
    lines.push(`2025,A-100,${(index % 5) + 1},${100 + index},note ${index}`);
  }
  const text = `${lines.join("\n")}\n2025,P5X,1,900,late\n`;
  const bytes = new Uint8Array(utf8(text));
  const at = text.indexOf("P5X") + 2;
  // The prefix holds ASCII alone, so it reads as UTF-8 and the byte below is
  // the first one the database cannot read.
  assert.ok(at >= CSV_PREFIX_BYTES, "the only high byte sits past the prefix");
  bytes[at] = 0xe9;
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "late-product.csv");
  await writeFile(filePath, bytes);
  const file = new File([bytes], "late-product.csv");
  assert.deepEqual(await readCsvFile(file), { kind: "bytes" });
  const query = await recoveringDatabase();
  let registrations = 0;
  const register = async (reading: CsvReading) => {
    registrations += 1;
    if (reading.kind === "text") await writeFile(filePath, reading.text);
  };
  await loadCsv(query, file, "data", filePath, "month first", register);
  const [counted] = await query("SELECT count(*)::DOUBLE AS n FROM data");
  assert.equal(Number(counted.n), 4001);
  const [last] = await query("SELECT product, note FROM data ORDER BY rowid DESC LIMIT 1");
  assert.equal(String(last.product), "P5é");
  assert.equal(String(last.note), "late");
  // The number conversion and the row locator read the same file again, and
  // must answer the reading the load settled on rather than the prefix's.
  assert.equal((await readCsvFile(file)).kind, "text");
  assert.equal(registrations, 2);
});

/** A late Windows-1252 CSV: ASCII through the prefix, its one high byte past it. */
function lateWindows1252Csv(name: string): Uint8Array<ArrayBuffer> {
  const lines = ["period,product,units,sales,note"];
  for (let index = 0; index < 4000; index++) {
    lines.push(`2025,A-100,${(index % 5) + 1},${100 + index},note ${index}`);
  }
  const text = `${lines.join("\n")}\n2025,P5X,1,900,late\n`;
  const bytes = new Uint8Array(utf8(text));
  const at = text.indexOf("P5X") + 2;
  assert.ok(at >= CSV_PREFIX_BYTES, "the only high byte sits past the prefix");
  bytes[at] = 0xe9;
  assert.ok(bytes.length < 1024 * 1024, `${name} stays small on disk`);
  return bytes;
}

test("a late Windows-1252 file over the limit shows the sentence without a whole-file read", async () => {
  const { loadCsv } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const bytes = lateWindows1252Csv("over-limit.csv");
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "over-limit.csv");
  await writeFile(filePath, bytes);
  // The reported size decides the limit; the bytes on disk stay small.
  const file = new ReportedSizeFile([bytes], "over-limit.csv", 40 * 1024 * 1024);
  const query = await recoveringDatabase();
  let registrations = 0;
  const register = async (reading: CsvReading) => {
    registrations += 1;
    if (reading.kind === "text") await writeFile(filePath, reading.text);
  };
  await assert.rejects(
    loadCsv(query, file, "data", filePath, "month first", register),
    (error: unknown) => (error as Error).message === SENTENCE,
    SENTENCE,
  );
  assert.equal(file.wholeReads, 0, "a file over the limit is never read whole");
  assert.equal(registrations, 1);
});

test("a late Windows-1252 file at the limit still loads", async () => {
  const { loadCsv } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const bytes = lateWindows1252Csv("at-limit.csv");
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "at-limit.csv");
  await writeFile(filePath, bytes);
  const file = new ReportedSizeFile([bytes], "at-limit.csv", 32 * 1024 * 1024);
  const query = await recoveringDatabase();
  const register = async (reading: CsvReading) => {
    if (reading.kind === "text") await writeFile(filePath, reading.text);
  };
  await loadCsv(query, file, "data", filePath, "month first", register);
  const [counted] = await query("SELECT count(*)::DOUBLE AS n FROM data");
  assert.equal(Number(counted.n), 4001);
  const [last] = await query("SELECT product FROM data ORDER BY rowid DESC LIMIT 1");
  assert.equal(String(last.product), "P5é");
  assert.equal(file.wholeReads, 1);
});

test("a UTF-8 file over 64 KiB loads without a whole-file read and with one registration", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { loadCsv } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const lines = ["period,product,units,sales,note"];
  for (let index = 0; index < 4000; index++) {
    lines.push(`2025,A-100,${(index % 5) + 1},${100 + index},note ${index}`);
  }
  const text = `${lines.join("\n")}\n`;
  assert.ok(text.length > CSV_PREFIX_BYTES);
  const bytes = utf8(text);
  const file = new CountingFile([bytes], "plain.csv");
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "plain.csv");
  await writeFile(filePath, bytes);
  const query = await openDatabase();
  let registrations = 0;
  await loadCsv(query, file, "data", filePath, "month first", async () => {
    registrations += 1;
  });
  const [counted] = await query("SELECT count(*)::DOUBLE AS n FROM data");
  assert.equal(Number(counted.n), 4000);
  assert.equal(file.wholeReads, 0, "a file that loads needs no whole-file read");
  assert.equal(file.streamReads, 0);
  assert.ok(file.sliceSizes.length > 0, "the encoding and header checks read the prefix");
  assert.deepEqual(file.sliceSizes.filter((size) => size > CSV_PREFIX_BYTES), []);
  assert.equal(registrations, 1);
});

test("a file invalid in both readings shows the plain sentence after one whole-file check", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { loadCsv } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const lines = ["period,product,units,sales,note"];
  for (let index = 0; index < 4000; index++) {
    lines.push(`2025,A-100,${(index % 5) + 1},${100 + index},note ${index}`);
  }
  const text = `${lines.join("\n")}\n2025,P5X,1,900,late\n`;
  const bytes = new Uint8Array(utf8(text));
  const at = text.indexOf("P5X") + 2;
  const control = text.indexOf("late") + 1;
  assert.ok(at >= CSV_PREFIX_BYTES, "both damaged bytes sit past the prefix");
  bytes[at] = 0xff;
  // 0x81 is one of the five bytes Windows-1252 leaves undefined.
  bytes[control] = 0x81;
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "both-readings.csv");
  await writeFile(filePath, bytes);
  const file = new CountingFile([bytes], "both-readings.csv");
  assert.deepEqual(await readCsvFile(file), { kind: "bytes" });
  const query = await openDatabase();
  let registrations = 0;
  await assert.rejects(
    loadCsv(query, file, "data", filePath, "month first", async () => {
      registrations += 1;
    }),
    (error: unknown) => (error as Error).message === SENTENCE,
    SENTENCE,
  );
  // The sentence is only shown after the whole file was read and refused.
  assert.equal(file.wholeReads, 1);
  assert.equal(registrations, 1);
});

test("a CSV cut inside its final character loads at both sizes with the byte dropped", async () => {
  const { openDatabase } = await import("../src/duckdb.ts");
  const { loadCsv } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  for (const padding of [0, 70000]) {
    const label = padding === 0 ? "a file at most 64 KiB" : "a file over 64 KiB";
    const lines = [
      "period,product,units,sales,note",
      `2025,P1,1,100,${"x".repeat(padding)}first`,
      "2025,P2,2,110,second",
      "2025,P3,3,120,third",
      "2025,P4,4,130,last",
    ];
    const text = `${lines.join("\n")}\n`;
    // The file ends between a lead byte and its continuations.
    const bytes = joined(utf8(text), Uint8Array.from([0xe9]));
    assert.equal(bytes.length > CSV_PREFIX_BYTES, padding > 0, label);
    const directory = await mkdtemp("/tmp/bridgekit-encoding-");
    const filePath = path.join(directory, "cut-character.csv");
    await writeFile(filePath, bytes);
    const file = new File([bytes], "cut-character.csv");
    const query = await openDatabase();
    const register = async (reading: CsvReading) => {
      if (reading.kind === "text") await writeFile(filePath, reading.text);
    };
    await loadCsv(query, file, "data", filePath, "month first", register);
    const [counted] = await query("SELECT count(*)::DOUBLE AS n FROM data");
    assert.equal(Number(counted.n), 4, label);
    const [last] = await query("SELECT product, note FROM data ORDER BY rowid DESC LIMIT 1");
    assert.equal(String(last.product), "P4", label);
    assert.equal(String(last.note), "last", label);
  }
});

test("a final cut character is dropped and a mid-file damage still refuses", () => {
  const whole = "period,product,units,sales\n2025,P1,1,100\n";
  const cut = joined(utf8(whole), Uint8Array.from([0xe9]));
  assert.equal(asText(decodeCsvBuffer(cut)), whole);
  // A single byte that is not a lead byte is read as Windows-1252, not dropped.
  assert.equal(asText(decodeCsvBuffer(joined(utf8(whole), Uint8Array.from([0xff])))), `${whole}ÿ`);
  // A byte Windows-1252 cannot hold in the middle is damage, not a cut character.
  const damaged = joined(
    utf8("period,product,units,sales\n2025,P1,"),
    Uint8Array.from([0x81]),
    utf8("1,100\n"),
    Uint8Array.from([0xe9]),
  );
  assert.throws(() => decodeCsvBuffer(damaged), { message: SENTENCE });
});

test("an out-of-memory failure on a file with a late invalid byte is too big with no retry", async () => {
  const { loadCsv, loadFailure } = await import("../src/app/db.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const lines = ["period,product,units,sales,note"];
  for (let index = 0; index < 4000; index++) {
    lines.push(`2025,A-100,${(index % 5) + 1},${100 + index},note ${index}`);
  }
  const text = `${lines.join("\n")}\n2025,P5X,1,900,late\n`;
  const bytes = new Uint8Array(utf8(text));
  const at = text.indexOf("P5X") + 2;
  assert.ok(at >= CSV_PREFIX_BYTES, "the invalid byte sits past the prefix");
  bytes[at] = 0xff;
  const directory = await mkdtemp("/tmp/bridgekit-encoding-");
  const filePath = path.join(directory, "late-byte.csv");
  await writeFile(filePath, bytes);
  const file = new CountingFile([bytes], "late-byte.csv");
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (sql.includes("read_csv")) throw new Error("Out of Memory Error: Allocation failure");
    return [];
  };
  let registrations = 0;
  const failure = await loadCsv(query, file, "data", filePath, "month first", async () => {
    registrations += 1;
  }).then(
    () => null,
    (error: unknown) => loadFailure(error),
  );
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, TOO_BIG);
  // Out of memory is decided first: the file the database could not hold is
  // never read whole, and no second reading is registered.
  assert.equal(file.wholeReads, 0);
  assert.equal(registrations, 1);
});
