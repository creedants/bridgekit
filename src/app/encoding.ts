/**
 * Deciding how to read a CSV's bytes, apart from the database and the DOM so
 * Node can test it. A file that is already valid UTF-8 is never re-decoded.
 */

/** The one sentence shown when a file's text encoding cannot be read. */
export const ENCODING_SENTENCE = "This file's text encoding could not be read. Save it as CSV UTF-8.";

/** The one sentence shown when the file is not text at all. */
export const NOT_TEXT_FILE = "This file is not a text file. Save it as CSV UTF-8 or Excel (.xlsx).";

/**
 * True when the prefix holds a byte no text CSV uses: NUL or a C0 control
 * other than the whitespace a CSV needs. A UTF-16 byte-order mark exempts the
 * scan, because that file decodes as text below.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (startsWith(bytes, BOM_UTF16_LE) || startsWith(bytes, BOM_UTF16_BE)) return false;
  for (const byte of bytes) {
    if (byte === 0x00) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return true;
  }
  return false;
}

/**
 * The most the loader reads up front. A prefix may stop between two bytes of
 * one character, and a prefix that cannot decide is read in full, to tell its
 * encoding from its whole text.
 */
export const CSV_PREFIX_BYTES = 65536;

/**
 * How the loader hands a CSV to the database: the file's own bytes when they
 * are UTF-8, otherwise the text it decoded from them (UTF-16 by its mark, or
 * Windows-1252).
 */
export type CsvReading = { readonly kind: "bytes" } | { readonly kind: "text"; readonly text: string };

export type DecodedCsv = { kind: "utf8"; bytes: Uint8Array } | { kind: "text"; text: string };

// How a file was decided, kept between reads of the same File. A load that
// reads a refused file whole as text and the row locator that follows it must
// read one text, so the later call answers the load's decision. The label
// alone is kept: a large file's decoded string is not pinned for the tab's life.
const decidedReadings = new WeakMap<Blob, "bytes" | "text">();

/** Records how a load read a file, so a later read of it answers the same. */
export function rememberCsvReading(file: Blob, reading: CsvReading): void {
  decidedReadings.set(file, reading.kind);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF16_LE = new TextDecoder("utf-16le", { fatal: true });
const UTF16_BE = new TextDecoder("utf-16be", { fatal: true });
const WINDOWS_1252 = new TextDecoder("windows-1252");

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16_LE = [0xff, 0xfe];
const BOM_UTF16_BE = [0xfe, 0xff];
const BOM_UTF32_LE = [0xff, 0xfe, 0x00, 0x00];
const BOM_UTF32_BE = [0x00, 0x00, 0xfe, 0xff];

// Windows-1252 leaves these five byte values, and five alone, undefined.
const UNDEFINED_1252 = [0x81, 0x8d, 0x8f, 0x90, 0x9d];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

/** True when the bytes decode as UTF-8 with no error. */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * How much of a file the encoding check reads at a time, so a large file is
 * never held whole.
 */
export const ENCODING_CHECK_BYTES = 8 * 1024 * 1024;

/** What a file's bytes say about its text encoding. */
export type Utf8Verdict = "valid" | "invalid" | "unreadable";

/**
 * Decides whether a whole file is UTF-8 by reading it in slices, so no buffer
 * or string of the whole file is built. A slice that cannot be read answers
 * `"unreadable"`, kept apart from a byte the decoder refuses.
 */
export async function blobIsUtf8(file: Blob, sliceBytes = ENCODING_CHECK_BYTES): Promise<Utf8Verdict> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let at = 0; at < file.size; at += sliceBytes) {
    let slice: ArrayBuffer;
    try {
      slice = await file.slice(at, Math.min(at + sliceBytes, file.size)).arrayBuffer();
    } catch {
      return "unreadable";
    }
    try {
      decoder.decode(slice, { stream: true });
    } catch {
      return "invalid";
    }
  }
  // A character cut off at the end of the file is refused here, not in a slice.
  try {
    decoder.decode();
  } catch {
    return "invalid";
  }
  return "valid";
}

/**
 * True when every complete UTF-8 sequence in `bytes` decodes, allowing a final
 * character the caller cut short. A prefix of a longer file is the case: the
 * file can be valid UTF-8 while the prefix ends between a lead byte and its
 * continuations. A fresh decoder per call keeps no state between files.
 */
export function isUtf8Prefix(bytes: Uint8Array): boolean {
  const streaming = new TextDecoder("utf-8", { fatal: true });
  try {
    streaming.decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

// A byte-order mark declares UTF-16, so the decoder is fatal: an unpaired
// surrogate or a byte left over at the end means the file is damaged, and
// reading it would put replacement characters in the table.
function decodeMarkedUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  try {
    return littleEndian ? UTF16_LE.decode(bytes.subarray(2)) : UTF16_BE.decode(bytes.subarray(2));
  } catch {
    throw new Error(ENCODING_SENTENCE);
  }
}

/**
 * Classifies a whole CSV buffer. Bytes that are already valid UTF-8 are handed
 * back untouched. A UTF-16 buffer is decoded by its byte-order mark, and a
 * buffer that cannot be UTF-8 but reads as single-byte text is decoded as
 * Windows-1252. Anything else throws the one sentence.
 */
export function decodeCsvBuffer(bytes: Uint8Array): DecodedCsv {
  // A UTF-32 mark starts with the UTF-16 little-endian mark, so it is checked first.
  if (startsWith(bytes, BOM_UTF32_LE) || startsWith(bytes, BOM_UTF32_BE)) throw new Error(ENCODING_SENTENCE);
  // A UTF-8 mark declares UTF-8, so bytes that fail strict UTF-8 after it are
  // refused rather than guessed as Windows-1252.
  if (startsWith(bytes, BOM_UTF8)) {
    if (isValidUtf8(bytes)) return { kind: "utf8", bytes };
    throw new Error(ENCODING_SENTENCE);
  }
  if (startsWith(bytes, BOM_UTF16_LE)) return { kind: "text", text: decodeMarkedUtf16(bytes, true) };
  if (startsWith(bytes, BOM_UTF16_BE)) return { kind: "text", text: decodeMarkedUtf16(bytes, false) };
  if (isValidUtf8(bytes)) return { kind: "utf8", bytes };
  // A file can end between one character's lead byte and its continuations,
  // so its last character is only partly there: it is dropped, never replaced,
  // and the rows the file does hold still load. A file damaged anywhere before
  // the tail is not this case, and the check below refuses it.
  const cut = cutUtf8Tail(bytes);
  if (cut > 0) {
    try {
      return { kind: "text", text: UTF8.decode(bytes.subarray(0, bytes.length - cut)) };
    } catch {
      // A damaged byte before the tail: the single-byte check decides.
    }
  }
  if (readsAsSingleByteText(bytes)) return { kind: "text", text: WINDOWS_1252.decode(bytes) };
  throw new Error(ENCODING_SENTENCE);
}

/**
 * How many bytes at the end of `bytes` are one character the file cut short, or
 * 0 when the bytes are not valid UTF-8 apart from that character. Only a lead
 * byte with at least one continuation missing counts, so a damaged byte
 * anywhere else is not a cut character.
 */
function cutUtf8Tail(bytes: Uint8Array): number {
  for (let cut = 1; cut <= 3 && cut < bytes.length; cut++) {
    const lead = bytes[bytes.length - cut];
    const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (length <= cut) continue;
    let continuations = true;
    for (let at = bytes.length - cut + 1; at < bytes.length; at++) {
      if ((bytes[at] & 0xc0) !== 0x80) continuations = false;
    }
    if (continuations) return cut;
  }
  return 0;
}

// Windows-1252 defines a character for every byte except five, so a buffer that
// is not UTF-8 and holds no control byte except the whitespace a CSV uses is
// almost certainly a single-byte encoding. A byte Windows-1252 leaves undefined
// would decode as a control character the file does not really contain, so the
// encoding is not guessed.
function readsAsSingleByteText(bytes: Uint8Array): boolean {
  let highByte = false;
  for (const byte of bytes) {
    if (byte >= 0x80) {
      if (UNDEFINED_1252.includes(byte)) return false;
      highByte = true;
      continue;
    }
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return highByte;
}

/**
 * The loader's one decoding decision, so the database and the row locator read
 * the same text. Reads the whole file only when the prefix cannot decide, or
 * when an earlier load already read it as text. Throws NOT_TEXT_FILE or
 * ENCODING_SENTENCE.
 */
export async function readCsvFile(file: Blob): Promise<CsvReading> {
  const decided = decidedReadings.get(file);
  if (decided === "bytes") return { kind: "bytes" };
  if (decided === "text") {
    const whole = decodeCsvBuffer(new Uint8Array(await file.arrayBuffer()));
    if (whole.kind === "text") return { kind: "text", text: whole.text };
  }
  const prefix = new Uint8Array(await file.slice(0, CSV_PREFIX_BYTES).arrayBuffer());
  if (looksBinary(prefix)) throw new Error(NOT_TEXT_FILE);
  const continues = prefix.byteLength < file.size;
  if (continues && isUtf8Prefix(prefix)) {
    rememberCsvReading(file, { kind: "bytes" });
    return { kind: "bytes" };
  }
  const decision = decodeCsvBuffer(continues ? new Uint8Array(await file.arrayBuffer()) : prefix);
  const reading: CsvReading = decision.kind === "utf8" ? { kind: "bytes" } : { kind: "text", text: decision.text };
  rememberCsvReading(file, reading);
  return reading;
}
