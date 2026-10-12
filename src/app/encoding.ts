/**
 * Deciding how to read a CSV's bytes, apart from the database and the DOM so
 * Node can test it. A file that is already valid UTF-8 is never re-decoded.
 */

/** The one sentence shown when a file's text encoding cannot be read. */
export const ENCODING_SENTENCE = "This file's text encoding could not be read. Save it as CSV UTF-8.";

export type DecodedCsv = { kind: "utf8"; bytes: Uint8Array } | { kind: "text"; text: string };

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF16_LE = new TextDecoder("utf-16le");
const UTF16_BE = new TextDecoder("utf-16be");
const WINDOWS_1252 = new TextDecoder("windows-1252");

const BOM_UTF16_LE = [0xff, 0xfe];
const BOM_UTF16_BE = [0xfe, 0xff];
const BOM_UTF32_LE = [0xff, 0xfe, 0x00, 0x00];
const BOM_UTF32_BE = [0x00, 0x00, 0xfe, 0xff];

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
 * Classifies a whole CSV buffer. Bytes that are already valid UTF-8 are handed
 * back untouched. A UTF-16 buffer is decoded by its byte-order mark, and a
 * buffer that cannot be UTF-8 but reads as single-byte text is decoded as
 * Windows-1252. Anything else throws the one sentence.
 */
export function decodeCsvBuffer(bytes: Uint8Array): DecodedCsv {
  // A UTF-32 mark starts with the UTF-16 little-endian mark, so it is checked first.
  if (startsWith(bytes, BOM_UTF32_LE) || startsWith(bytes, BOM_UTF32_BE)) throw new Error(ENCODING_SENTENCE);
  if (startsWith(bytes, BOM_UTF16_LE)) return { kind: "text", text: UTF16_LE.decode(bytes.subarray(2)) };
  if (startsWith(bytes, BOM_UTF16_BE)) return { kind: "text", text: UTF16_BE.decode(bytes.subarray(2)) };
  if (isValidUtf8(bytes)) return { kind: "utf8", bytes };
  if (readsAsSingleByteText(bytes)) return { kind: "text", text: WINDOWS_1252.decode(bytes) };
  throw new Error(ENCODING_SENTENCE);
}

// Windows-1252 maps every byte to a character, so a buffer that is not UTF-8
// but holds only printable text and the whitespace a CSV uses is almost
// certainly a single-byte encoding. A NUL or another control byte means the
// bytes are not text, so the encoding is not guessed.
function readsAsSingleByteText(bytes: Uint8Array): boolean {
  let highByte = false;
  for (const byte of bytes) {
    if (byte >= 0x80) {
      highByte = true;
      continue;
    }
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return highByte;
}
