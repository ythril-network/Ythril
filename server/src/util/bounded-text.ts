/**
 * Where may a text be cut so each piece stays under a byte ceiling?
 *
 * ## What it prevents
 *
 * Two chunks of a customer's documentation (one 38 KB table, one 50 KB table) went to an HTTP embedder whole, because the chunker never
 * cuts a table, and the embedder answered HTTP 400 (input over its context): the passages were stored with no vector. Every producer of
 * embedded text needs the same answer to the same question, so it is asked here and nowhere else: the chunkers' bounding pass
 * (`files/converters/bound-chunks.ts`), the one builder of what is embedded (`brain/embed-text.ts`) and the last guard in `embed()`.
 *
 * ## The ceiling is in UTF-8 BYTES
 *
 * A byte count is an upper bound on the token count of a byte-level BPE or a WordPiece tokenizer (a token is at least one byte); a
 * UTF-16 length is not (a CJK character is one unit and three bytes, often two tokens). `fits` is therefore measured in bytes, with a
 * lone surrogate counted as the three bytes `Buffer.byteLength` counts.
 *
 * ## The rule, and what is inside so no caller can drop it
 *
 *  - A text that fits comes back as itself in one part.
 *  - Otherwise a cut lands on the LAST LINE BREAK that fits (so a table keeps whole rows, a fence whole lines), else at the furthest
 *    character that fits; never inside a surrogate pair; always advances (a ceiling smaller than one character still ends, one
 *    character a part). The rule is `markdown-window.ts`'s `splitPoint`, the reader's window cut, shared rather than copied.
 *  - It is LOSSLESS: the parts joined are the input.
 *  - It is LINEAR: each cut looks at a window of at most `maxBytes` UTF-16 units (a unit is at least one byte, so no more can fit),
 *    and the "rest fits" question is asked before the line-break search so the last part is not cut early. An upload may be 500 MiB,
 *    and a splitter that sliced the rest of the text for every probe would hold the event loop for minutes.
 */
import { isHighSurrogate, splitPoint } from '../files/markdown-window.js';

/** The UTF-8 length of `s`, a lone surrogate counted as the three bytes `Buffer.byteLength` counts. */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** The end of the part that starts at `from`: the whole rest when it fits, else the cut `splitPoint` finds in a window that cannot overshoot. */
function partEnd(text: string, from: number, maxBytes: number): number {
  const length = text.length;
  // A byte is at least one UTF-16 unit, so a rest longer than the ceiling in units cannot fit, and the byte count of a rest that
  // short is cheap to take.
  if (length - from <= maxBytes && utf8Bytes(from === 0 ? text : text.slice(from)) <= maxBytes) return length;
  let end = Math.min(length, from + maxBytes);
  // A window that ends between the halves of a pair takes the other half in, so `splitPoint` sees the whole pair and can back off it.
  if (end < length && isHighSurrogate(text.charCodeAt(end - 1))) end++;
  const window = text.slice(from, end);
  return from + splitPoint(window, 0, window.length, to => utf8Bytes(window.slice(0, to)) <= maxBytes);
}

/** `text` cut into parts of at most `maxBytes` UTF-8 bytes each: lossless (the parts joined are the text), `[text]` when it fits. */
export function boundedParts(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let from = 0;
  do {
    const to = partEnd(text, from, maxBytes);
    parts.push(from === 0 && to === text.length ? text : text.slice(from, to));
    from = to;
  } while (from < text.length);
  return parts;
}

/** The first part of {@link boundedParts} without cutting the rest: the text itself when it fits, else its beginning with `cut: true`. */
export function boundedPrefix(text: string, maxBytes: number): { text: string; cut: boolean } {
  const to = partEnd(text, 0, maxBytes);
  return to === text.length ? { text, cut: false } : { text: text.slice(0, to), cut: true };
}
