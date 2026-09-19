/**
 * What bytes a `{ content, encoding }` pair means — the question, answered once for both doors.
 *
 * ## Why this is a module
 *
 * A file can be written through the REST upload and through the `write_file` tool, and both have to turn a
 * JSON string into bytes. That is one rule, and one rule written twice is the defect this codebase produces
 * most: the weaker copy wins silently, because nothing compares them.
 *
 * It arrived as a parity report rather than as a bug. The MCP door had no `encoding` at all, so a session
 * reached through MCP could create a text file and could never create a byte file — asked for by
 * the canary operator on 2026-09-08 after a coding session of theirs could not put a photograph on a record.
 * Closing that by adding a second decode beside the first would have fixed the symptom and planted the
 * cause.
 *
 * ## The guard a hand-written copy drops, and it is the whole reason this throws
 *
 * **`Buffer.from(s, 'base64')` does not fail on input that is not base64.** It skips every character
 * outside the alphabet and decodes whatever is left, so the obvious two lines — read the encoding, call
 * `Buffer.from` — accept a `data:image/png;base64,…` prefix, a JSON fragment or a paragraph of prose and
 * store a short, corrupt file under a 2xx. Nothing downstream can tell: the bytes have a sha256 and a size
 * like any others, the type sniffer reports whatever the leading bytes happen to look like, and the caller
 * finds out when something eventually fails to open it.
 *
 * So the check lives here and it REFUSES, rather than returning bytes it cannot vouch for. A caller that
 * gets a buffer back has base64 that decodes to exactly what it says.
 *
 * ## One question per module
 *
 * It answers *"what bytes is this"*. It does not check a quota, does not know a path, and does not write
 * anything — each of those belongs to the door, which has different answers for each of them.
 */

/** The encodings a caller may name. Both doors offer the same two, and neither offers a third. */
export const CONTENT_ENCODINGS = ['utf8', 'base64'] as const;

export type ContentEncoding = (typeof CONTENT_ENCODINGS)[number];

/**
 * Base64 as Node will actually accept it, plus the whitespace a wrapped encoder emits.
 *
 * `-` and `_` are in the class because Node's `'base64'` decoder accepts base64url alphabet characters, so
 * refusing them here would refuse input that decodes correctly — a validator stricter than the decoder it
 * guards rejects working callers, which is the failure mode that gets a validator deleted.
 */
const BASE64_CHARS = /^[A-Za-z0-9+/\-_\s]*={0,2}$/;

/** The message a door shows for a bad encoding name, so both doors say the same thing. */
export function encodingError(value: unknown): string {
  return `encoding must be one of ${CONTENT_ENCODINGS.map(e => `'${e}'`).join(' or ')}`
    + ` — received ${JSON.stringify(value)}`;
}

/** True when `value` names an encoding both doors accept. `undefined` is `utf8`, which is the default. */
export function isContentEncoding(value: unknown): value is ContentEncoding {
  return typeof value === 'string' && (CONTENT_ENCODINGS as readonly string[]).includes(value);
}

/**
 * The bytes `content` means under `encoding`.
 *
 * @throws {RangeError} when the encoding is not one of the two, or when base64 content is not base64. A
 * `RangeError` rather than a plain `Error` because the REST upload path already maps that to a 400 and the
 * tool dispatcher already turns a thrown message into a refusal — so a caller is told, on either door,
 * instead of being handed a file that is quietly wrong.
 */
export function decodeContent(content: string, encoding: unknown = 'utf8'): Buffer {
  const enc: unknown = encoding ?? 'utf8';
  if (!isContentEncoding(enc)) throw new RangeError(encodingError(enc));
  if (enc === 'utf8') return Buffer.from(content, 'utf8');

  if (!BASE64_CHARS.test(content)) {
    throw new RangeError(
      'content is not base64. A character outside the base64 alphabet was found, which `Buffer.from` would '
      + 'have silently SKIPPED — storing a short, corrupt file under a success. The usual cause is a data '
      + 'URL: send only the part after `base64,`, never the `data:image/png;base64,` prefix.');
  }
  const stripped = content.replace(/\s+/g, '');
  if (stripped.replace(/=+$/, '').length % 4 === 1) {
    throw new RangeError(
      'content is not base64: its length cannot be produced by base64 encoding, so it has been truncated '
      + 'or joined from pieces. Decoding it would store a file shorter than the one you sent.');
  }
  return Buffer.from(stripped, 'base64');
}
