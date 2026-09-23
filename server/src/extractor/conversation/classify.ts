/**
 * Phase 2 of the conversation extractor — classify turns, the code half (`F-31`, DECOMPOSITION.md §2).
 *
 * The judgements of this phase (2.3 a speaker's role when the source does not say, 2.5 whether a candidate
 * paste is material the speaker brought) are Jev-style decisions made elsewhere. What is here is what code can
 * decide, and it decides it so that those questions are only ever asked about the turns that need them:
 *
 *  - 2.1 split an image caption from the speech around it;
 *  - 2.2 keep captions as CONTEXT — the type says so: `speech` and `captions` are separate fields, and only
 *    `speech` is ever handed to a step that writes claims;
 *  - 2.4 propose paste candidates, with the reason each was proposed;
 *  - 2.6 mark a photo-only reaction (*"Wow, that's a great photo!"*) as riding along in a neighbour's claim.
 */
import type { LoadedConversation, LoadedTurn } from './load.js';

export interface ClassifiedTurn extends LoadedTurn {
  /** The words the speaker actually said, captions removed. The ONLY text a claim may be written from. */
  speech: string;
  /** Machine-written image descriptions — context for understanding, never a source of claims (2.2). */
  captions: string[];
  /** 2.4: why this turn might be pasted material, if it might. Empty means it is not a candidate. */
  pasteReasons: string[];
  /** 2.6: a reaction to a photo with nothing of its own — it rides in a neighbour's `sourceTurns`. */
  ridesAlong: boolean;
}

/** `[image: …]`, `[photo: …]`, `[picture: …]`, `[img: …]` — the caption shapes transcripts carry. */
const CAPTION_RE = /\[(?:image|photo|picture|img|shares?|shared)\s*:\s*([^\]]*)\]/gi;

/** 2.1 */
export function splitCaptions(text: string): { speech: string; captions: string[] } {
  const captions: string[] = [];
  const speech = text.replace(CAPTION_RE, (_m, c: string) => { captions.push(c.trim()); return ' '; })
    .replace(/\s+/g, ' ').trim();
  return { speech, captions };
}

/**
 * Words that carry no content of their own in a reaction. Kept deliberately small: a false "rides along"
 * drops a turn's own fact, while a false "has content" costs one extra claim candidate that phase 5 can fold.
 */
const FILLER = new Set([
  'wow', 'oh', 'omg', 'aw', 'aww', 'awww', 'haha', 'lol', 'yay', 'nice', 'cool', 'great', 'amazing', 'awesome',
  'lovely', 'beautiful', 'gorgeous', 'cute', 'so', 'such', 'a', 'an', 'the', 'that', "that's", 'thats', 'this',
  "it's", 'its', 'is', 'looks', 'look', 'what', 'how', 'photo', 'pic', 'picture', 'shot', 'image', 'really',
  'very', 'just', 'love', 'it', 'i', 'thanks', 'thank', 'you', 'omg', 'yes', 'yeah', 'totally', 'too',
]);

/** Content words: tokens not in the reaction vocabulary. */
function contentWordCount(speech: string): number {
  return speech.toLowerCase().split(/[^a-z']+/).filter(w => w.length > 0 && !FILLER.has(w)).length;
}

/** Document structure no one speaks in: headings, code fences, log lines, tables, stack frames. */
function structureReasons(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const reasons: string[] = [];
  if (/```/.test(text)) reasons.push('code fence');
  if (lines.filter(l => /^\s{0,3}#{1,6}\s/.test(l)).length >= 2) reasons.push('headings');
  if (lines.filter(l => /^\s*\|.*\|\s*$/.test(l)).length >= 3) reasons.push('table');
  if (lines.filter(l => /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\s*\[\d{2}:\d{2}(:\d{2})?\]|^\s*(ERROR|WARN|INFO|DEBUG)\b/.test(l)).length >= 3) reasons.push('log lines');
  if (lines.filter(l => /^\s+at\s+\S+.*\(.*:\d+(:\d+)?\)\s*$/.test(l)).length >= 2) reasons.push('stack trace');
  return reasons;
}

/** A turn far longer than its speaker's usual is a paste candidate: `LENGTH_FACTOR` × their median, and at least `MIN_PASTE_CHARS`. */
export const LENGTH_FACTOR = 4;
export const MIN_PASTE_CHARS = 600;

/**
 * The median of an ascending `sorted` with ONE occurrence of `value` left out — the turn being measured.
 * Reads by index rather than copying: the element at logical position i is `sorted[i]` before the removed
 * slot and `sorted[i + 1]` after it.
 */
export function medianWithout(sorted: readonly number[], value: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < value) lo = mid + 1; else hi = mid; }
  const cut = lo < sorted.length && sorted[lo] === value ? lo : -1;
  const n = cut === -1 ? sorted.length : sorted.length - 1;
  if (n === 0) return 0;
  const at = (i: number) => sorted[cut !== -1 && i >= cut ? i + 1 : i]!;
  return n % 2 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
}

/** Classify every turn of a loaded conversation (2.1, 2.2, 2.4, 2.6). */
export function classifyTurns(conversation: LoadedConversation): ClassifiedTurn[][] {
  // The median is per SPEAKER, across the whole conversation: one person's normal turn is another's essay.
  // And it is taken over the speaker's OTHER turns — a paste counted in its own median raises the bar it is
  // measured against, which in a short conversation is enough to hide it (caught by this module's test).
  //
  // Sorted ONCE per speaker, and the leave-one-out median read by index: a history of years is thousands of
  // turns, and re-sorting per turn would make this quadratic in the one input guaranteed to be long.
  const lengths = new Map<string, number[]>();
  for (const s of conversation.sessions) for (const t of s.turns) {
    const arr = lengths.get(t.speaker) ?? [];
    arr.push(splitCaptions(t.text).speech.length);
    lengths.set(t.speaker, arr);
  }
  for (const arr of lengths.values()) arr.sort((a, b) => a - b);
  const typicalExcept = (speaker: string, own: number) => medianWithout(lengths.get(speaker) ?? [], own);

  return conversation.sessions.map(s => s.turns.map((t) => {
    const { speech, captions } = splitCaptions(t.text);
    const pasteReasons = structureReasons(t.text);
    const typical = typicalExcept(t.speaker, speech.length);
    const threshold = Math.max(MIN_PASTE_CHARS, LENGTH_FACTOR * typical);
    if (speech.length > threshold) pasteReasons.unshift(`${speech.length} chars against a typical ${typical}`);
    const ridesAlong = captions.length > 0 && contentWordCount(speech) === 0;
    return { ...t, speech, captions, pasteReasons, ridesAlong };
  }));
}
