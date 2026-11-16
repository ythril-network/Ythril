/**
 * No tracked text file holds an invisible or look-alike character: a zero-width character, a bidirectional control, a soft
 * hyphen, a no-break space, or a byte-order mark anywhere but the first position.
 *
 * ## The defect this prevents
 *
 * The tools that write files for an agent turn a typed backslash-u escape into the raw character (Q-834, 2026-11-16: seven
 * regular expressions and strings in this repository held a raw no-break space, narrow no-break space or byte-order mark
 * where an escape was meant). Nobody sees the character in review, it changes what a string compares equal to, and a bidi
 * control can reorder what a reader sees against what runs (the Trojan Source shape). The harness reports it on every write
 * (~/.claude/hooks/invisible-chars.js); CI cannot import the harness, so this lint holds the repository to the same set.
 *
 * ## What is allowed, and why
 *
 * - A zero-width space between `*` and `/`: the one way to write the closing token of a block comment INSIDE a block
 *   comment, which an escape cannot do. The comment strippers' docblocks quote it.
 * - A zero-width joiner between two pictographs: an emoji sequence (a person with a laptop), which is text, not a slip.
 * - An entry of no-tracked-text-holds-an-invisible-character.allow.json: a file and a code point, with its reason and a
 *   review date. An entry without a reason, past its date, or matching nothing fails.
 *
 * Write the escape instead of the raw character: in a regular expression `\xA0`, or `\u{202F}` with the u flag; in a string
 * String.fromCharCode. The character set here is written as numbers, so this file never holds one itself.
 *
 * Run: node --test testing/standalone/no-tracked-text-holds-an-invisible-character.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTrackedTextSources } from './_sources.mjs';

/** Code point -> name: the set ~/.claude/hooks/invisible-chars.js reports. */
const NAMES = new Map([
  [0x00A0, 'no-break space'], [0x00AD, 'soft hyphen'], [0x180E, 'Mongolian vowel separator'],
  [0x200B, 'zero-width space'], [0x200C, 'zero-width non-joiner'], [0x200D, 'zero-width joiner'],
  [0x200E, 'left-to-right mark'], [0x200F, 'right-to-left mark'],
  [0x202A, 'left-to-right embedding'], [0x202B, 'right-to-left embedding'], [0x202C, 'pop directional formatting'],
  [0x202D, 'left-to-right override'], [0x202E, 'right-to-left override'], [0x202F, 'narrow no-break space'],
  [0x2060, 'word joiner'], [0x2066, 'left-to-right isolate'], [0x2067, 'right-to-left isolate'],
  [0x2068, 'first strong isolate'], [0x2069, 'pop directional isolate'], [0xFEFF, 'byte-order mark (not at the start)'],
]);
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const codePointName = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;

/** Is the character at `i` one of the two shapes the header allows by rule? */
function allowedByShape(text, i, c) {
  if (c === 0x200B) return text[i - 1] === '*' && text[i + 1] === '/';
  if (c === 0x200D) {
    const before = String.fromCodePoint(text.codePointAt(i - 2) ?? 0);
    const prev = PICTOGRAPH.test(before) ? before : String.fromCodePoint(text.codePointAt(i - 1) ?? 0);
    const next = String.fromCodePoint(text.codePointAt(i + 1) ?? 0);
    return PICTOGRAPH.test(prev) && PICTOGRAPH.test(next);
  }
  return false;
}

/** Every reported character of `sources`: { file, line, col, codePoint, name }. */
export function invisibleCharacters(sources) {
  const found = [];
  for (const { file, text } of sources) {
    let line = 1;
    let col = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) { line++; col = 0; continue; }
      col++;
      if (!NAMES.has(c) || (c === 0xFEFF && i === 0) || allowedByShape(text, i, c)) continue;
      found.push({ file, line, col, codePoint: codePointName(c), name: NAMES.get(c) });
    }
  }
  return found;
}

const ALLOW_FILE = fileURLToPath(new URL('./no-tracked-text-holds-an-invisible-character.allow.json', import.meta.url));
const ALLOW = JSON.parse(readFileSync(ALLOW_FILE, 'utf8'));

describe('no tracked text file holds an invisible or look-alike character', () => {
  it('every allow entry has a reason and a review date that has not passed', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const e of ALLOW) {
      assert.ok(typeof e.reason === 'string' && e.reason.length > 20, `${e.file} ${e.codePoint}: give the reason`);
      assert.match(String(e.reviewBy), /^\d{4}-\d{2}-\d{2}$/, `${e.file} ${e.codePoint}: reviewBy is a date`);
      assert.ok(e.reviewBy >= today, `${e.file} ${e.codePoint}: reviewBy ${e.reviewBy} has passed; look at it again`);
    }
  });

  it('the tracked and new text files hold none outside the allowed shapes and the allow list', (t) => {
    const sources = readTrackedTextSources(['.'], { untracked: true, floor: 1000 });
    assert.ok(sources.length > 2000, `read only ${sources.length} files; the scan is not seeing the repository`);
    const hits = invisibleCharacters(sources);
    const allowed = (h) => ALLOW.some(e => e.file === h.file && e.codePoint === h.codePoint);
    const stale = ALLOW.filter(e => !hits.some(h => h.file === e.file && h.codePoint === e.codePoint));
    t.diagnostic(`allow entries: ${ALLOW.length}`);
    assert.deepEqual(hits.filter(h => !allowed(h)).map(h => `${h.file}:${h.line}:${h.col} ${h.codePoint} ${h.name}`), [],
      'write the escape (\\xA0, or \\u{202F} with the u flag) or String.fromCharCode instead of the raw character');
    assert.deepEqual(stale.map(e => `${e.file} ${e.codePoint}`), [], 'an allow entry that matches nothing is removed');
  });

  it('the scanner finds a planted character, and passes the two allowed shapes', () => {
    const ch = (c) => String.fromCodePoint(c);
    const planted = [
      { file: 'a.ts', text: `const ok = 1;\nconst bad = /^${ch(0xFEFF)}x/;\n` },
      { file: 'b.ts', text: `const s = 'a${ch(0x202E)}b';\n` },
      { file: 'c.ts', text: `/** the next *${ch(0x200B)}/ closes it */\n` },
      { file: 'd.md', text: `A ${ch(0x1F9D1)}${ch(0x200D)}${ch(0x1F4BB)} dev\n` },
      { file: 'e.md', text: `${ch(0xFEFF)}starts with a mark\n` },
      { file: 'f.md', text: `not an emoji a${ch(0x200D)}b\n` },
    ];
    assert.deepEqual(invisibleCharacters(planted).map(h => `${h.file}:${h.line}:${h.col} ${h.codePoint}`),
      ['a.ts:2:15 U+FEFF', 'b.ts:1:13 U+202E', 'f.md:1:15 U+200D']);
  });
});
