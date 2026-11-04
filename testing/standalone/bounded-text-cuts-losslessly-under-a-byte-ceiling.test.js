/**
 * Where a text may be cut so every piece stays under a byte ceiling — `util/bounded-text.ts` (Q-699, bundle-237).
 *
 * ## Why this exists
 *
 * Two chunks of a customer's documentation (one 38 KB table, one 50 KB table) were sent to the HTTP embedder whole, because the
 * chunker never cuts a table. The embedder answered HTTP 400 (input over its context) for both, and the passages were stored with
 * no vector. The cure is a splitter that every producer shares, so this module answers ONE question: where may a text be cut so
 * each piece fits a ceiling counted in UTF-8 BYTES (a byte count bounds the token count of a byte-level BPE or WordPiece
 * tokenizer; a UTF-16 length does not).
 *
 * ## What it must hold
 *
 *  - `utf8Bytes(s)` is the byte length, a lone surrogate counted as the three bytes `Buffer.byteLength` counts.
 *  - `boundedParts(text, maxBytes)` is LOSSLESS (the parts joined are the input), every part is at most `maxBytes` bytes, a text that
 *    fits comes back as itself in one part, a cut lands on the last line break that fits (else the furthest character), never inside
 *    a surrogate pair, and the loop always advances.
 *  - `boundedPrefix(text, maxBytes)` is `{ text, cut }`: the text itself when it fits, else its first part, with `cut: true`.
 *  - It stays linear: a 20 MB line with no break in it (an upload may be 500 MiB) is cut in under a second.
 *
 * Red at the unchanged base because the module does not exist: a unit has nothing to show but its own absence.
 *
 * Run: node --test testing/standalone/bounded-text-cuts-losslessly-under-a-byte-ceiling.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let utf8Bytes, boundedParts, boundedPrefix;

before(async () => {
  ({ utf8Bytes, boundedParts, boundedPrefix } = await import('../../server/dist/util/bounded-text.js'));
});

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** A seeded generator, so a failure names a case that runs the same again. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

const ALPHABET = ['a', 'b', ' ', '\n', '\n\n', '|', '漢', '字', 'é', '😀', '🧑‍💻', '```'];
const randomText = (rand, length) => Array.from({ length }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join('');

/** What every cut must keep, whatever the text: lossless, under the ceiling, no half of a surrogate pair at a seam. */
function assertSound(text, max, parts, what) {
  assert.ok(Array.isArray(parts) && parts.every(p => typeof p === 'string'), `${what}: parts is not an array of strings`);
  assert.equal(parts.join(''), text, `${what}: the parts joined are not the input (a cut dropped or repeated text)`);
  parts.forEach((p, i) => {
    assert.ok(bytes(p) <= max, `${what}: part ${i} is ${bytes(p)} bytes over a ${max}-byte ceiling`);
    assert.ok(p.length > 0 || parts.length === 1, `${what}: part ${i} is empty, so the cut did not advance`);
    if (p.length > 0) {
      assert.ok(!isLow(p.charCodeAt(0)) || i === 0 && isLow(text.charCodeAt(0)), `${what}: part ${i} starts on a low surrogate`);
      assert.ok(!isHigh(p.charCodeAt(p.length - 1)) || (i === parts.length - 1 && isHigh(text.charCodeAt(text.length - 1))),
        `${what}: part ${i} ends on a high surrogate, so a pair was cut in two`);
    }
  });
}

describe('the module answers the one question it is named for', () => {
  it('exports utf8Bytes, boundedParts and boundedPrefix', () => {
    assert.equal(typeof utf8Bytes, 'function');
    assert.equal(typeof boundedParts, 'function');
    assert.equal(typeof boundedPrefix, 'function');
  });

  it('utf8Bytes is the byte length, not the UTF-16 length', () => {
    for (const s of ['', 'abc', '漢字', 'é', '😀', 'a😀漢é\n', '\ud800', 'x'.repeat(10_000)]) {
      assert.equal(utf8Bytes(s), bytes(s), `utf8Bytes(${JSON.stringify(s.slice(0, 12))})`);
    }
  });
});

describe('boundedParts is lossless and bounded', () => {
  it('a text that fits is one part, itself — exactly at the ceiling too, and not at one byte over', () => {
    assert.deepEqual(boundedParts('', 512), ['']);
    assert.deepEqual(boundedParts('a\nb', 512), ['a\nb']);
    const exact = 'x'.repeat(511) + '\n';
    assert.deepEqual(boundedParts(exact, 512), [exact], 'a text of exactly the ceiling must not be cut');
    assert.equal(boundedParts(exact + 'y', 512).length, 2, 'one byte over the ceiling must be cut');
  });

  it('counts bytes: 4,000 CJK characters are 12,000 bytes and do not fit 6,000', () => {
    const text = '漢'.repeat(4_000);
    const parts = boundedParts(text, 6_000);
    assertSound(text, 6_000, parts, 'CJK');
    assert.equal(parts.length, 2, 'the length is under 6,000 UTF-16 units but over 6,000 bytes');
  });

  it('never cuts inside a surrogate pair, whatever the ceiling does to the pair', () => {
    const text = '😀'.repeat(2_500);                       // 10,000 bytes, 5,000 UTF-16 units
    for (const max of [512, 513, 514, 515, 6_000, 6_001, 6_002, 6_003]) {
      assertSound(text, max, boundedParts(text, max), `emoji at ${max}`);
    }
  });

  it('always advances: a ceiling the size of one character still ends, one character a part', () => {
    const text = '😀'.repeat(50);
    const parts = boundedParts(text, 4);
    assert.equal(parts.join(''), text);
    assert.equal(parts.length, 50);
  });

  it('cuts at the last line break that fits, so rows and lines stay whole', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| row ${String(i).padStart(4, '0')} | ${'v'.repeat(70)} |`).join('\n');
    const parts = boundedParts(rows, 6_000);
    assertSound(rows, 6_000, parts, 'table');
    assert.ok(parts.length >= 5, `a 32 KB table came back as ${parts.length} part(s)`);
    for (const p of parts.slice(0, -1)) assert.ok(p.endsWith('\n'), 'a part but the last must end at a line break');
    for (const p of parts) {
      for (const line of p.split('\n').filter(Boolean)) assert.match(line, /^\| row \d{4} \| v{70} \|$/, 'a row was cut in two');
    }
  });

  it('with no line break to use it cuts at the furthest character', () => {
    const line = 'q'.repeat(30_000);
    const parts = boundedParts(line, 6_000);
    assertSound(line, 6_000, parts, 'one line');
    assert.deepEqual(parts.map(p => p.length), [6_000, 6_000, 6_000, 6_000, 6_000]);
  });

  it('tests that the REST fits before it looks for a line break, so the last part is not cut early', () => {
    // 193 bytes in all: after the first cut at the break (index 100) what is left is 91 bytes and must come back whole,
    // not backed up to the break inside it.
    const text = 'x'.repeat(100) + '\n' + 'y'.repeat(60) + '\n' + 'z'.repeat(30);
    const parts = boundedParts(text, 150);
    assert.deepEqual(parts, ['x'.repeat(100) + '\n', 'y'.repeat(60) + '\n' + 'z'.repeat(30)]);
  });

  it('holds on random text with multi-byte characters, pairs, ZWJ sequences, fences and breaks (300 seeded cases)', () => {
    const rand = lcg(237);
    for (let i = 0; i < 300; i++) {
      const text = randomText(rand, 1 + Math.floor(rand() * 3_000));
      const max = 512 + Math.floor(rand() * 4_000);
      assertSound(text, max, boundedParts(text, max), `case ${i} (len ${text.length}, max ${max})`);
    }
  });

  it('stays linear: a 20 MB line with no break in it is cut in under a second', () => {
    // An upload may be 500 MiB. A splitter that slices the rest of the text for every probe is quadratic in the part count
    // and holds the event loop for minutes.
    const text = 'A'.repeat(20 * 1024 * 1024);
    const started = performance.now();
    const parts = boundedParts(text, 6_000);
    const took = performance.now() - started;
    assert.equal(parts.length, Math.ceil(text.length / 6_000));
    assert.ok(parts.every(p => p.length <= 6_000));
    assert.equal(parts.reduce((n, p) => n + p.length, 0), text.length, 'a cut dropped text');
    assert.ok(took < 1_000, `20 MB took ${Math.round(took)} ms`);
  });

  it('stays linear with a long run of multi-byte characters and rare breaks too', () => {
    const text = ('漢字😀'.repeat(300) + '\n').repeat(4_000);   // ~ 6 MB
    const started = performance.now();
    const parts = boundedParts(text, 6_000);
    const took = performance.now() - started;
    assert.equal(parts.join('').length, text.length);
    assert.ok(parts.every(p => bytes(p) <= 6_000));
    assert.ok(took < 1_500, `${Math.round(took)} ms`);
  });
});

describe('boundedPrefix is the first part, and says whether it cut', () => {
  it('a text that fits is returned as itself and cut: false', () => {
    const text = 'a short text\nin two lines';
    assert.deepEqual(boundedPrefix(text, 6_000), { text, cut: false });
  });

  it('a text that does not is its first part and cut: true', () => {
    const text = 'x'.repeat(100) + '\n' + 'y'.repeat(200);
    const r = boundedPrefix(text, 150);
    assert.equal(r.cut, true);
    assert.equal(r.text, boundedParts(text, 150)[0]);
    assert.ok(bytes(r.text) <= 150);
  });

  it('counts bytes and keeps a pair whole', () => {
    const cjk = boundedPrefix('漢'.repeat(3_000), 6_000);
    assert.equal(cjk.cut, true);
    assert.equal(cjk.text.length, 2_000);
    const emoji = boundedPrefix('😀'.repeat(2_000), 6_001);
    assert.ok(bytes(emoji.text) <= 6_001);
    assert.ok(!isHigh(emoji.text.charCodeAt(emoji.text.length - 1)), 'a surrogate pair was cut in two');
  });
});
