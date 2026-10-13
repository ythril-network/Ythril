/**
 * Structural detection of cp1252-mis-decoded UTF-8, replacing a hand-written list of signatures.
 *
 * ## Why the list had to go
 *
 * The gate matched `â€`, `â”` and `â•` — the openings of mis-decoded U+20xx punctuation and U+25xx box
 * drawing, each added after being found in the tree. It reported clean while `server/src/api/tokens.ts` still
 * carried `Ã—`, the double-encoding of `×`, because that starts with `Ã` and is only TWO characters long.
 *
 * Two misses from the same cause: the pattern named the instances somebody had already tripped over, so every
 * new shape of the same defect was invisible until it bit. A gate that enumerates its enemies is a gate that
 * is always one behind.
 *
 * ## What replaces it
 *
 * The structural question. Take a run of adjacent non-ASCII characters and encode it back to cp1252 — the
 * codepage the corruption came from. If those bytes are valid UTF-8 AND decode to something SHORTER than the
 * run, the run is mis-decoded text: three characters that were one, or two that were one.
 *
 * Correct text does not do that. `×` is a single character with no preceding partner; `—` likewise. Their
 * cp1252 bytes are `0xD7` and — for a real em-dash — not representable in a way that forms a valid multibyte
 * sequence. The shortening requirement is what makes this safe: a conversion that keeps or grows the length
 * is not a repair, so it is refused.
 *
 * ## The table is explicit on purpose
 *
 * A positional string literal for the 0x80–0x9F block put a repair off by four bytes and turned an em dash
 * into U+2010 without failing anything. Byte→codepoint pairs cannot shift.
 */

/** cp1252 0x80–0x9F: the only bytes that do not map to their own Latin-1 codepoint. */
const HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const CP_TO_BYTE = new Map(Object.entries(HIGH).map(([b, cp]) => [cp, Number(b)]));

/**
 * The five bytes cp1252 leaves undefined: 0x81, 0x8D, 0x8F, 0x90, 0x9D.
 *
 * .NET's decoder — the one behind PowerShell, which is where this corruption comes from — passes them
 * through as the matching C1 control codepoint rather than failing. Without them the round-trip is
 * incomplete in a way that hides a whole class: `═` (U+2550) is `E2 95 90`, and its third byte is 0x90, so
 * mis-decoded box-drawing of that kind was undetectable and unrepairable until this map existed.
 */
const UNDEFINED_PASSTHROUGH = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

function toCp1252Byte(ch) {
  const cp = ch.codePointAt(0);
  if (cp <= 0x7f) return cp;
  if (CP_TO_BYTE.has(cp)) return CP_TO_BYTE.get(cp);
  if (UNDEFINED_PASSTHROUGH.has(cp)) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The text this run was before it was mis-decoded, or `null` when the run is not mis-decoded text.
 *
 * Exported so a repair and the gate cannot disagree about what counts — one implementation, both callers.
 */
export function repairRun(run) {
  const bytes = [];
  for (const ch of run) {
    const b = toCp1252Byte(ch);
    if (b === null) return null;
    bytes.push(b);
  }
  let out;
  try {
    out = decoder.decode(new Uint8Array(bytes));
  } catch {
    return null; // not valid UTF-8, so this run was never double-encoded
  }
  // A repair must SHORTEN. Equal length means nothing was double-encoded and converting would corrupt
  // correct text — this single condition is what makes the check safe to run over the whole tree.
  if (out.length >= run.length) return null;
  // A control character on the other side means the run was not what we thought.
  if (/[\u0000-\u0008\u000E-\u001F\u007F]/.test(out)) return null;
  return out;
}

/** Runs of two or more adjacent non-ASCII characters — where mis-decoded text lives. */
const RUN = /[^\u0000-\u007F]{2,}/g;

/**
 * Corrupt `s` the way a cp1252 mis-decode really does — for TESTS, so a fixture is generated, never typed.
 *
 * Typing them is not merely tedious, it is unreliable: `═` mis-decodes to `â•` followed by U+0090, an
 * INVISIBLE control character. A hand-written fixture silently omitted it, so an assertion tested a string
 * that cannot occur and then failed against a detector that was right.
 */
export function mojibakeOf(s) {
  const BYTE_TO_CP = new Map(Object.entries(HIGH).map(([b, cp]) => [Number(b), cp]));
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    if (b <= 0x7f) out += String.fromCharCode(b);
    else if (BYTE_TO_CP.has(b)) out += String.fromCharCode(BYTE_TO_CP.get(b));
    else out += String.fromCharCode(b);
  }
  return out;
}

/**
 * Whether `bytes` are valid UTF-8 — the question `findMojibake` cannot ask.
 *
 * `findMojibake` reads a decoded string, and a decoder given one stray cp1252 byte (an em dash saved as 0x97)
 * does not fail: it substitutes U+FFFD, a single non-ASCII character, which the two-or-more run rule never
 * looks at. The file still compiles, and the line shows a replacement character wherever it is read as UTF-8.
 * Asking the bytes themselves leaves nothing to substitute.
 */
export function isValidUtf8(bytes) {
  try {
    decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Every mis-decoded run in `src`, as `{ found, shouldBe }`. Empty when the text is clean. */
export function findMojibake(src) {
  const hits = [];
  for (const m of src.matchAll(RUN)) {
    const shouldBe = repairRun(m[0]);
    if (shouldBe !== null) hits.push({ found: m[0], shouldBe });
  }
  return hits;
}
