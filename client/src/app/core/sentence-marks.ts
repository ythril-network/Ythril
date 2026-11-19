import type { PageTranslator } from './page-translator';

/**
 * The private marks that set a name or a number apart inside a translated sentence (bundle-285 slice S11, Q-747; first built in the vote row
 * for slice S8, widened for the run block and the Save dialog).
 *
 * ## Why it exists
 *
 * A conversion's sentences are made by the translation layer from a closed set of keys, with the names of types, properties and values as
 * parameters. The drawing sets each name in the code face and each count in strong text, so the sentence has to be cut at them again after
 * the translation has put them in. The cut is made at four control characters that wrap the name or the number on its way in. The vote row,
 * the run block and the Save dialog all do this, so the characters, the wrapping and the cutting live here and nowhere else: two copies of a
 * private protocol drift.
 *
 * ## What it prevents
 *
 * - **A name forging a mark.** A name comes from a schema or from another member, so it may hold any character. Every function that wraps
 *   text takes ALL four marks out of it first, so a name cannot close itself early and set the rest of the sentence in the code face, open a
 *   name of its own, or pass for a number. A number is cleaned the same way.
 * - **A sentence bound as HTML.** The pieces are plain strings a template binds by interpolation, which escapes; nothing here makes markup.
 * - **A mark that is shown.** A mark the translation left unpaired (a translator who dropped half of a pair) is dropped, never shown, and the
 *   cut never throws: the sentence comes out as text.
 */

/** A piece of a sentence: some words, one name the drawing sets in the code face, or (`strong`) a number it sets in strong text. */
export interface SentencePiece { text: string; name: boolean; strong?: true }

/** The marks a name is wrapped in. They are control characters, so no real name holds one. */
const OPEN = '\u0001';
const CLOSE = '\u0002';
/** The same for a number the drawing sets in strong text: a second pair, so a strong piece is never a name. */
const STRONG_OPEN = '\u0003';
const STRONG_CLOSE = '\u0004';

const stripName = (s: string): string => s.split(OPEN).join('').split(CLOSE).join('');
const stripStrong = (s: string): string => s.split(STRONG_OPEN).join('').split(STRONG_CLOSE).join('');

/** The text with all four marks taken out: for text that is shown as it is, such as a reason or a network's name. */
export const stripMarks = (s: string): string => stripStrong(stripName(s));

/** A name wrapped in the name marks, for a sentence read back with `piecesOf`; a mark the name held is taken out first. */
export const markName = (name: string): string => `${OPEN}${stripMarks(name)}${CLOSE}`;

/** A text (a formatted number) wrapped in the strong marks, for a sentence read back with `piecesOf`; a mark it held is taken out first. */
export const markStrong = (text: string): string => `${STRONG_OPEN}${stripMarks(text)}${STRONG_CLOSE}`;

/**
 * The sentence with the first occurrence of `text` that is not already inside a marked piece wrapped in the strong marks: the count of a counted
 * sentence, which the plural mechanism formats and puts in itself (`{{count}}`), so it cannot be handed in marked. Unchanged when it is not there.
 */
export function strongFirst(sentence: string, text: string): string {
  if (!text) return sentence;
  let depth = 0;
  for (let i = 0; i <= sentence.length - text.length; i++) {
    const c = sentence[i];
    if (c === OPEN || c === STRONG_OPEN) depth++;
    else if ((c === CLOSE || c === STRONG_CLOSE) && depth > 0) depth--;
    else if (depth === 0 && sentence.startsWith(text, i)) return `${sentence.slice(0, i)}${markStrong(text)}${sentence.slice(i + text.length)}`;
  }
  return sentence;
}

/** A plain piece cut at its strong marks. An unpaired strong mark is dropped, never shown. */
function strongPieces(text: string): SentencePiece[] {
  const parts = text.split(STRONG_CLOSE);
  const pieces: SentencePiece[] = [];
  parts.forEach((part, i) => {
    const open = i < parts.length - 1 ? part.indexOf(STRONG_OPEN) : -1;
    const plain = stripStrong(open < 0 ? part : part.slice(0, open));
    if (plain) pieces.push({ text: plain, name: false });
    if (open >= 0) { const strong = stripStrong(part.slice(open + 1)); if (strong) pieces.push({ text: strong, name: false, strong: true }); }
  });
  return pieces;
}

/** A sentence with its marked names (and strong numbers) cut out as pieces, in order. A mark the translation left unpaired is dropped, never shown. */
export function piecesOf(sentence: string): SentencePiece[] {
  const parts = sentence.split(CLOSE);
  const pieces: SentencePiece[] = [];
  parts.forEach((part, i) => {
    const open = i < parts.length - 1 ? part.indexOf(OPEN) : -1;
    if (open < 0) {
      pieces.push(...strongPieces(stripName(part)));
      return;
    }
    pieces.push(...strongPieces(stripName(part.slice(0, open))));
    pieces.push({ text: stripMarks(part.slice(open + 1)), name: true });
  });
  return pieces;
}

/** How a sentence's text parameters are treated: a name is marked; `plain` text has its marks taken out; `trusted` text is a sentence already made here. */
export interface MarkHow { plain?: readonly string[]; trusted?: readonly string[] }

/** The parameters of a sentence with each text parameter treated as `how` says: marked as a name unless it is plain or trusted. */
export function markedParams(params: Record<string, unknown> | undefined, how: MarkHow): Record<string, unknown> | undefined {
  if (!params) return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    if (typeof value !== 'string' || how.trusted?.includes(key)) return [key, value];
    return [key, how.plain?.includes(key) ? stripMarks(value) : markName(value)];
  }));
}

/** The pieces of any sentence whose text parameters are names (marked) unless `how` says they are plain text or a sentence already made here. */
export function markedPieces(say: PageTranslator, key: string, params: Record<string, unknown>, how: MarkHow = {}): SentencePiece[] {
  return piecesOf(say(key, markedParams(params, how)));
}
