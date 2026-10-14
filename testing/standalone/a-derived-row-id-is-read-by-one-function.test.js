/**
 * Whether an id is a derived row of a file — `<file>#…` — is read in ONE place, and a file whose own name holds a `#` is not one
 * (bundle-113; `isDerivedRowOf`, `files/moved-paths.ts`).
 *
 * ## What it holds
 *
 *  1. **The answer**: `a#chunk0` is a derived row of `a`, `a#b.txt` is too UNLESS it is known to be a top-level file, `ab` and `a.txt`
 *     are not (whole names), and `movedId`, `belongsTo` and `idAfterMove` ask the same function, so a top-level `a#b.txt` is not re-keyed
 *     with `a` and is still re-keyed when it is under a moved DIRECTORY (an `a/…` path has no `#` rule to consult).
 *  2. **The reading is not spelled twice**: no server source outside `moved-paths.ts` takes an id apart at its `#` (`lastIndexOf('#')`,
 *     or a `startsWith` of `<x>#`; the database prefix query that SELECTS the candidates of a file's links is not a reading), and the
 *     three consumers each call it. A reading spelled a second time is the weaker copy this module exists to remove: the delete's own `lastIndexOf('#')`
 *     had no guard for a file named `a#b.txt`.
 *
 * Mutations seen red (restored by hand): make `isDerivedRowOf` ignore `topLevelFiles`; spell `id.lastIndexOf('#')` in `remove-file-here.ts`.
 *
 * Run: node --test testing/standalone/a-derived-row-id-is-read-by-one-function.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const moved = await import('../../server/dist/files/moved-paths.js');
const OWN = new Set(['a#b.txt']);

describe('isDerivedRowOf and the id rules built on it', () => {
  it('a derived id is a derived row of its file, on whole names, unless it is known to be a top-level file', () => {
    assert.equal(moved.isDerivedRowOf('a#chunk0', 'a', moved.NO_TOP_LEVEL_FILES), true);
    assert.equal(moved.isDerivedRowOf('a#b.txt', 'a', moved.NO_TOP_LEVEL_FILES), true, 'with nothing known, the id reads as derived');
    assert.equal(moved.isDerivedRowOf('a#b.txt', 'a', OWN), false, 'a top-level file named a#b.txt was read as a derived row of a');
    assert.equal(moved.isDerivedRowOf('a#b.txt#chunk0', 'a#b.txt', OWN), true, 'a derived row OF the top-level file is its own');
    for (const id of ['ab', 'a.txt', 'a', 'b#a']) assert.equal(moved.isDerivedRowOf(id, 'a', moved.NO_TOP_LEVEL_FILES), false, id);
  });

  it('the move rule asks it: a top-level a#b.txt is not carried with a, a derived row is, and under a moved directory everything is', () => {
    assert.equal(moved.movedId('a#chunk0', 'a', 'c'), 'c#chunk0');
    assert.equal(moved.movedId('a#b.txt', 'a', 'c', OWN), null);
    assert.equal(moved.idAfterMove('a#b.txt', 'a', 'c', OWN), 'a#b.txt');
    assert.equal(moved.belongsTo('a#b.txt', 'a', OWN), false);
    assert.equal(moved.belongsTo('a#chunk0', 'a', OWN), true);
    assert.equal(moved.movedId('d/a#b.txt', 'd', 'e', new Set(['d/a#b.txt'])), 'e/a#b.txt', 'a file under the moved directory moves with it, whatever its name holds');
    assert.equal(moved.movedId('_extracted/a/img.png#face-chunk0', 'a', 'c'), '_extracted/c/img.png#face-chunk0');
  });
});

describe('the reading of a derived id\'s # is spelled once', () => {
  const sources = readTrackedSources('server/src').map(s => ({ file: s.file, text: stripComments(s.text) }));
  /** The ways a source takes an id apart at its `#`. */
  const READINGS = [/lastIndexOf\('#'\)/, /startsWith\(`\$\{[^`]*\}#`\)/];

  it('no server source but moved-paths.ts reads it', () => {
    const spelling = sources
      .filter(s => s.file !== 'server/src/files/moved-paths.ts')
      .flatMap(s => READINGS.filter(r => r.test(s.text)).map(r => `${s.file}: ${r}`));
    assert.deepEqual(spelling, [], 'an id is taken apart at its # outside isDerivedRowOf: it is the second copy, and it lacks the guard');
  });

  it('the three consumers call it (floor)', () => {
    const calling = sources.filter(s => /\bisDerivedRowOf\(/.test(s.text) || /\bmovedId\(/.test(s.text)).map(s => s.file);
    for (const file of ['server/src/brain/link-adjacency.ts', 'server/src/files/remove-file-here.ts', 'server/src/files/moved-paths.ts']) {
      assert.ok(calling.includes(file), `${file} no longer asks the one function: its own reading is back, or the file moved`);
    }
  });
});
