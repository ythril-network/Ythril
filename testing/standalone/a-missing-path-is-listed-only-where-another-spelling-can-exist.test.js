/**
 * A path that is not on the disk costs a directory read only where another spelling of its name could be (Q-581, bundle-88 review F6).
 *
 * ## The rule
 *
 * `heldSpellingOf` finds a file held under another Unicode form of the key it was asked for, by listing the directory a segment is missing from.
 * Every GET or `read_file` of a name that is nowhere used to list the directory, however large, for a name that could have no other spelling:
 * an unauthenticated-looking probe costs one full `readdir` each, limited only by the global rate limiter.
 *
 *  1. A segment made only of ASCII characters that no other character normalises to has no other spelling, so a missing one is not listed:
 *     the answer is `null` with no `readdir`.
 *  2. The set of ASCII characters that something else normalises to is DERIVED here from the whole code space, and the module's own
 *     predicate must name exactly them: a short list kept by hand goes stale the day Unicode adds one (it is three today: the Kelvin sign
 *     U+212A is a K, U+037E is a `;`, U+1FEF is a backtick).
 *  3. A segment that has another spelling (a non-ASCII name, or one of those three) is still looked up in its directory, and a file held under
 *     the other spelling is found (control, so the skip cannot have widened into never looking).
 *
 * Not skipped for "a name equal to its own NFC and NFD forms": the CJK compatibility ideographs (U+F900 and its kin) normalise to the unified
 * ideograph, so `豈` has another spelling although it is its own NFC and NFD form.
 *
 * ## Seen red
 *
 * On the base 1 (a missing ASCII name listed its directory) and the export of the predicate in 2.
 *
 * Run: node --test testing/standalone/a-missing-path-is-listed-only-where-another-spelling-can-exist.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const S = 'spellings';
let root, heldSpellingOf, canHaveAnotherSpelling, previousRoot;

/** The directory reads `body` makes through `fs/promises`, by directory. */
async function readdirsDuring(body) {
  const seen = [];
  const original = fsp.readdir;
  fsp.readdir = function spied(dir, ...rest) { seen.push(String(dir)); return original.call(this, dir, ...rest); };
  try { return { result: await body(), seen }; } finally { fsp.readdir = original; }
}

before(async () => {
  previousRoot = process.env['DATA_ROOT'];
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-spellings-'));
  process.env['DATA_ROOT'] = data;
  root = path.join(data, 'files', S);
  fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dir', 'present.txt'), 'x');
  ({ heldSpellingOf, canHaveAnotherSpelling } = await import('../../server/dist/files/held-spelling.js'));
});
after(() => {
  if (previousRoot === undefined) delete process.env['DATA_ROOT']; else process.env['DATA_ROOT'] = previousRoot;
  fs.rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
});

describe('a missing path is listed only where another spelling can exist', () => {
  it('a missing ASCII name answers null without listing its directory (1)', async () => {
    const { result, seen } = await readdirsDuring(() => heldSpellingOf(S, 'dir/absent.txt'));
    assert.equal(result, null);
    assert.deepEqual(seen, [], `the lookup of a name with no other spelling listed ${JSON.stringify(seen)}`);
    const top = await readdirsDuring(() => heldSpellingOf(S, 'nothing-here/at-all.txt'));
    assert.equal(top.result, null);
    assert.deepEqual(top.seen, []);
  });

  it('the predicate names exactly the ASCII characters another character normalises to, derived from the whole code space (2)', () => {
    assert.equal(typeof canHaveAnotherSpelling, 'function', 'held-spelling.ts no longer exports canHaveAnotherSpelling');
    const derived = new Set();
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const nfc = String.fromCodePoint(cp).normalize('NFC');
      if (/^[\x00-\x7f]+$/.test(nfc)) for (const ch of nfc) derived.add(ch);
    }
    assert.ok(derived.size >= 1, 'the derivation found no ASCII character with another spelling: the loop read nothing');
    const flagged = new Set();
    for (let cp = 0; cp < 0x80; cp++) if (canHaveAnotherSpelling(String.fromCharCode(cp))) flagged.add(String.fromCharCode(cp));
    assert.deepEqual([...flagged].sort(), [...derived].sort(), 'the predicate and the Unicode tables disagree about which ASCII characters have another spelling');
    assert.equal(canHaveAnotherSpelling('plain-name.txt'), false);
    assert.equal(canHaveAnotherSpelling('Café.txt'), true);
    assert.equal(canHaveAnotherSpelling('豈'), true, 'a name that is its own NFC and NFD form still has a compatibility-ideograph spelling');
  });

  it('a segment that can have another spelling is looked up in its directory, and the file under that spelling is found (3)', async (t) => {
    const kelvin = 'Kelvin-K.txt';
    fs.writeFileSync(path.join(root, 'dir', kelvin), 'x');
    if (!fs.readdirSync(path.join(root, 'dir')).includes(kelvin)) { t.skip('this file system normalises the name on write: the fixture cannot exist here'); return; }
    const found = await readdirsDuring(() => heldSpellingOf(S, `dir/${kelvin.normalize('NFC')}`));
    assert.ok(found.result, 'a file held under the Kelvin-sign spelling of its name was not found');
    assert.equal(path.basename(found.result.abs), kelvin);
    assert.ok(found.seen.length > 0, 'the lookup found it without listing the directory: the fixture proves nothing');
    const missing = await readdirsDuring(() => heldSpellingOf(S, 'dir/Café-absent.txt'));
    assert.equal(missing.result, null);
    assert.ok(missing.seen.length > 0, 'a missing non-ASCII name was not looked up in its directory');
  });
});
