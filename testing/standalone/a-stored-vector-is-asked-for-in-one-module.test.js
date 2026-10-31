/**
 * Whether a stored record HOLDS A VECTOR is asked in ONE module (`server/src/brain/holds-vector.ts`), in the three spellings the
 * store and the code need (Q-656, bundle-211).
 *
 * ## What it prevents
 *
 * The backfill, the suppression sweep, the completeness count and the worker each wrote "has a vector" in their own words:
 * `embedding: { $exists: true }`, `{ $isArray: '$embedding' }`, `Array.isArray(doc['embedding']) && length > 0`. They disagree on
 * the two shapes a stored field can take besides a vector: `embedding: null` (a record a failed write or an import left) and
 * `embedding: []`. `$exists: false` misses the null, `$isArray` calls the empty array a vector, and the worker counts neither as
 * one. A record with `embedding: null` was therefore queued by neither backfill walk, and a record with `[]` was owed by the
 * worker and never by the sweep. One module owns the question (the query, the aggregation expression and the JS test over one
 * definition: a NON-EMPTY array), so a fourth spelling cannot give a fifth answer.
 *
 * ## What is asked, with the comments stripped
 *
 * - the detector flags each planted copy of a spelling (the gate cannot pass because its pattern is broken), and leaves alone
 *   what is not the vector: `faceEmbedding`, a bare `embedding` variable (a face descriptor), a `$exists` on another field;
 * - no file in `server/src` outside `brain/holds-vector.ts` writes `embedding: { $exists`, `$isArray: '$embedding'`, or
 *   `Array.isArray(<x>.embedding` / `Array.isArray(<x>['embedding']`.
 *
 * Run: node --test testing/standalone/a-stored-vector-is-asked-for-in-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HOME = 'server/src/brain/holds-vector.ts';

/** The spellings, each with the name it is reported under. `\bembedding` does not match `faceEmbedding`. */
const SPELLINGS = [
  ['a query on the field', /\bembedding['"]?\s*:\s*\{\s*\$exists/],
  ['an aggregation on the field', /\$isArray\s*:\s*['"]\$embedding['"]/],
  ['a JS array test on the field', /Array\.isArray\(\s*[\w$]+(?:\??\.embedding\b|\[\s*['"]embedding['"]\s*\])/],
];

const spellingsIn = (src) => SPELLINGS.filter(([, re]) => re.test(stripComments(src))).map(([name]) => name);

describe('a stored vector is asked for in one module', () => {
  it('the detector flags each planted copy and leaves what is not the vector alone', () => {
    assert.deepEqual(spellingsIn("const f = { embedding: { $exists: true } };"), ['a query on the field']);
    assert.deepEqual(spellingsIn("const f = { 'embedding': {$exists: false} };"), ['a query on the field']);
    assert.deepEqual(spellingsIn("{ $addFields: { holdsVector: { $isArray: '$embedding' } } }"), ['an aggregation on the field']);
    assert.deepEqual(spellingsIn("const v = Array.isArray(doc['embedding']) && doc['embedding'].length > 0;"), ['a JS array test on the field']);
    assert.deepEqual(spellingsIn('const v = Array.isArray(row.embedding);'), ['a JS array test on the field']);
    assert.deepEqual(spellingsIn('const v = Array.isArray(row?.embedding);'), ['a JS array test on the field']);
    // Not the vector: a face descriptor, a bare variable, another field, a comment that names the spelling.
    assert.deepEqual(spellingsIn('if (!Array.isArray(embedding)) return false;'), []);
    assert.deepEqual(spellingsIn('const f = { faceEmbedding: { $exists: true } };'), []);
    assert.deepEqual(spellingsIn('const f = { parentFileId: { $exists: true } };'), []);
    assert.deepEqual(spellingsIn("// was { embedding: { $exists: true } }\nconst f = 1;"), []);
  });

  it('no file outside holds-vector.ts spells the question itself', () => {
    const files = trackedSources('server/src', { floor: 200 }).filter(f => f !== HOME);
    const copies = [];
    for (const f of files) {
      for (const name of spellingsIn(readFileSync(f, 'utf8'))) copies.push(`${f}: ${name}`);
    }
    assert.deepEqual(copies, [], 'a module spells "holds a vector" itself instead of importing it from brain/holds-vector.ts');
  });
});
