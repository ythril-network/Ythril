/**
 * The tests evaluate a Mongo filter against a document with ONE matcher, `testing/_shared/filter-matcher.mjs`
 * (bundle-56 dedup, item 8).
 *
 * ## What this prevents
 *
 * "Does this document satisfy this filter?" was written three times, each a little different: `job-stall-rule.test.js`
 * (`$or`, `$lt`, `$exists`, equality; arguments as `(filter, doc)`), `turning-suppression-on-sweeps-stored-vectors.test.js`
 * (`$or`, `$in`, `$nin`, `$ne`, `$exists`; `(doc, filter)`) and the fake Ythril tool server (dotted paths, `$and`, the
 * comparisons; `(doc, filter)`). Each evaluated "enough Mongo" for its own filter, so a rule tested against one of them
 * said nothing about the others, and an operator one of them lacked was a throw in one test and a silent
 * non-match in the next. The three asked the same question, so they now ask the module.
 *
 * ## The guards the module keeps inside
 *
 * An operator it does not know THROWS (a matcher that returned `false` for `$regex` would make every test of "this
 * rule selects nothing" pass for the wrong reason). A comparison against a missing or null value never matches, as in
 * MongoDB. A malformed `$and` / `$or` / `$in` throws instead of being read as "no condition".
 *
 * ## What is NOT claimed
 *
 * That MongoDB agrees. The module is a model of the operators the tests use, for checking a RULE (which documents a
 * filter selects); a query-semantics question (type brackets, arrays as values, collation) needs a database, and the
 * `-db` tests have one.
 *
 * Run: node --test testing/standalone/one-mongo-filter-matcher-serves-the-tests.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'testing/_shared/filter-matcher.mjs';
const load = () => import(pathToFileURL(resolve(REPO_ROOT, MODULE)).href);

/** [what, document, filter, expected]. */
const ROWS = [
  ['an empty filter matches everything', { a: 1 }, {}, true],
  ['no filter at all matches everything', { a: 1 }, undefined, true],
  ['equality on a present value', { a: 1 }, { a: 1 }, true],
  ['equality on a different value', { a: 1 }, { a: 2 }, false],
  ['equality is strict: 1 is not "1"', { a: 1 }, { a: '1' }, false],
  ['equality on a missing key', { a: 1 }, { b: 1 }, false],
  ['equality with null matches a null value', { a: null }, { a: null }, true],
  ['every key must hold (ANDed)', { a: 1, b: 2 }, { a: 1, b: 3 }, false],
  ['a dotted path reads into the document', { p: { q: { r: 5 } } }, { 'p.q.r': 5 }, true],
  ['a dotted path through a scalar is missing, not an error', { p: 3 }, { 'p.q': 1 }, false],
  ['$eq', { a: 1 }, { a: { $eq: 1 } }, true],
  ['$ne on a different value', { a: 1 }, { a: { $ne: 2 } }, true],
  ['$ne on a missing key matches, as in MongoDB', { b: 1 }, { a: { $ne: 2 } }, true],
  ['$ne on the same value', { a: 2 }, { a: { $ne: 2 } }, false],
  ['$gt', { a: 5 }, { a: { $gt: 4 } }, true],
  ['$gt at the boundary', { a: 5 }, { a: { $gt: 5 } }, false],
  ['$gte at the boundary', { a: 5 }, { a: { $gte: 5 } }, true],
  ['$lt at the boundary is not a match (equality must not reap)', { a: 5 }, { a: { $lt: 5 } }, false],
  ['$lt below', { a: 4 }, { a: { $lt: 5 } }, true],
  ['$lte at the boundary', { a: 5 }, { a: { $lte: 5 } }, true],
  ['ISO timestamps compare as text, in time order', { at: '2026-01-02T00:00:00.000Z' }, { at: { $lt: '2026-01-03T00:00:00.000Z' } }, true],
  ['a comparison against a missing value never matches', { b: 1 }, { a: { $lt: 5 } }, false],
  ['a comparison against null never matches ($lte 0)', { a: null }, { a: { $lte: 0 } }, false],
  ['a comparison against null never matches ($gte 0)', { a: null }, { a: { $gte: 0 } }, false],
  ['several operators on one key are ANDed', { a: 5 }, { a: { $gt: 1, $lt: 9 } }, true],
  ['several operators on one key: one fails', { a: 5 }, { a: { $gt: 1, $lt: 3 } }, false],
  ['$in holds a member', { a: 'x' }, { a: { $in: ['x', 'y'] } }, true],
  ['$in holds no member', { a: 'z' }, { a: { $in: ['x', 'y'] } }, false],
  ['$nin excludes a member', { a: 'x' }, { a: { $nin: ['x', 'y'] } }, false],
  ['$nin passes a non-member', { a: 'z' }, { a: { $nin: ['x', 'y'] } }, true],
  ['$nin passes a missing key', { b: 1 }, { a: { $nin: ['x'] } }, true],
  ['$exists: true on a present key', { a: 1 }, { a: { $exists: true } }, true],
  ['$exists: true on a present null', { a: null }, { a: { $exists: true } }, true],
  ['$exists: true on a missing key', { b: 1 }, { a: { $exists: true } }, false],
  ['$exists: false on a missing key', { b: 1 }, { a: { $exists: false } }, true],
  ['$exists: false on a present key', { a: 1 }, { a: { $exists: false } }, false],
  ['$and holds when every branch holds', { a: 1, b: 2 }, { $and: [{ a: 1 }, { b: 2 }] }, true],
  ['$and fails when one branch fails', { a: 1, b: 2 }, { $and: [{ a: 1 }, { b: 3 }] }, false],
  ['$or holds when one branch holds', { a: 1 }, { $or: [{ a: 2 }, { a: 1 }] }, true],
  ['$or fails when none holds', { a: 1 }, { $or: [{ a: 2 }, { a: 3 }] }, false],
  ['$or beside a plain key: both must hold', { a: 1, b: 2 }, { b: 2, $or: [{ a: 9 }, { a: 1 }] }, true],
  ['$or beside a plain key: the plain key fails', { a: 1, b: 2 }, { b: 3, $or: [{ a: 9 }, { a: 1 }] }, false],
  ['logic nests', { a: 1, b: 2 }, { $or: [{ $and: [{ a: 9 }, { b: 2 }] }, { $and: [{ a: 1 }, { b: { $gt: 1 } }] }] }, true],
];

/** The stalled-job filter's own shape, as the rule test uses it: a status, and a cutoff on two clocks. */
const STALLED = (cutoff) => ({
  status: 'processing',
  $or: [
    { progressAt: { $lt: cutoff } },
    { progressAt: { $exists: false }, claimedAt: { $lt: cutoff } },
    { progressAt: null, claimedAt: { $lt: cutoff } },
  ],
});

describe('matchesFilter', () => {
  for (const [what, doc, filter, expected] of ROWS) {
    it(what, async () => {
      const { matchesFilter } = await load();
      assert.equal(matchesFilter(doc, filter), expected);
    });
  }

  it('does not change the document it was handed', async () => {
    const { matchesFilter } = await load();
    const doc = { a: { b: [1, 2] }, c: null };
    const before = structuredClone(doc);
    matchesFilter(doc, { 'a.b': { $in: [1] }, $or: [{ c: null }] });
    assert.deepEqual(doc, before);
  });

  it('answers the shape the stalled-job rule needs, row by row', async () => {
    const { matchesFilter } = await load();
    const cutoff = '2026-01-02T00:00:00.000Z';
    const old = '2026-01-01T00:00:00.000Z';
    const fresh = '2026-01-03T00:00:00.000Z';
    assert.equal(matchesFilter({ status: 'processing', claimedAt: old, progressAt: fresh }, STALLED(cutoff)), false, 'still ticking');
    assert.equal(matchesFilter({ status: 'processing', claimedAt: old, progressAt: old }, STALLED(cutoff)), true, 'stopped ticking');
    assert.equal(matchesFilter({ status: 'processing', claimedAt: old }, STALLED(cutoff)), true, 'no progressAt at all');
    assert.equal(matchesFilter({ status: 'processing', claimedAt: old, progressAt: null }, STALLED(cutoff)), true, 'progressAt null');
    assert.equal(matchesFilter({ status: 'pending', claimedAt: old, progressAt: old }, STALLED(cutoff)), false, 'not processing');
    assert.equal(matchesFilter({ status: 'processing', claimedAt: old, progressAt: cutoff }, STALLED(cutoff)), false, 'ticked exactly at the cutoff');
  });
});

describe('what the matcher refuses rather than guesses', () => {
  const refused = [
    ['an operator it does not know', { a: { $regex: 'x' } }, /\$regex/],
    ['a top-level operator it does not know', { $nor: [{ a: 1 }] }, /\$nor/],
    ['$where', { $where: 'true' }, /\$where/],
    ['a $or that is not a list', { $or: { a: 1 } }, /\$or/],
    ['an empty $or', { $or: [] }, /\$or/],
    ['a $and that is not a list', { $and: 'x' }, /\$and/],
    ['an empty $and', { $and: [] }, /\$and/],
    ['an $in that is not a list', { a: { $in: 'x' } }, /\$in/],
    ['a $nin that is not a list', { a: { $nin: 1 } }, /\$nin/],
    ['a list as a value (that is an $in)', { a: [1, 2] }, /\$in/],
    ['a Date as a value (it has no keys, so it would select everything)', { a: new Date(0) }, /not plain/],
    ['an empty operator object', { a: {} }, /empty operator/],
  ];
  for (const [what, filter, mentions] of refused) {
    it(`throws on ${what}, naming it`, async () => {
      const { matchesFilter, UnsupportedFilterError } = await load();
      assert.throws(() => matchesFilter({ a: 1 }, filter), (err) => err instanceof UnsupportedFilterError && mentions.test(err.message));
    });
  }

  it('readPath reads a dotted path and says undefined where there is none', async () => {
    const { readPath } = await load();
    assert.equal(readPath({ a: { b: 2 } }, 'a.b'), 2);
    assert.equal(readPath({ a: { b: 2 } }, 'a.c'), undefined);
    assert.equal(readPath({ a: null }, 'a.b'), undefined);
    assert.equal(readPath({ a: 1 }, 'a.b.c'), undefined);
  });
});

describe('no test keeps its own filter matcher', () => {
  /*
   * Derived, never listed: every tracked source under testing/. A hand-written matcher has one of two shapes - a branch
   * on an operator's name (`op === '$exists'`, `case '$in'`) or a table of them (`$lt: (v, x) =>`). Filters written
   * as DATA (`{ $or: [...] }`) have neither.
   */
  const BRANCH = /(?:===|!==|case)\s*['"]\$(?:or|and|nor|exists|eq|ne|lt|lte|gt|gte|in|nin)['"]/;
  const TABLE = /\$(?:eq|ne|lt|lte|gt|gte|in|nin)\s*:\s*\(/;

  it('only the matcher module evaluates operators', () => {
    const files = trackedSources(['testing'], { ext: ['.mjs', '.js'], floor: 500, exclude: [MODULE] });
    assert.ok(files.length >= 400, `the scan saw only ${files.length} sources`);
    const copies = files.filter((f) => {
      const text = stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
      return BRANCH.test(text) || TABLE.test(text);
    });
    assert.deepEqual(copies, [], `these evaluate Mongo operators themselves; use matchesFilter from ${MODULE}`);
  });

  it('the three that used to keep one import the module', () => {
    for (const f of [
      'testing/_shared/fake-ythril-tool-server.mjs',
      'testing/standalone/job-stall-rule.test.js',
      'testing/standalone/turning-suppression-on-sweeps-stored-vectors.test.js',
    ]) assert.match(readFileSync(resolve(REPO_ROOT, f), 'utf8'), /filter-matcher\.mjs/, `${f} does not import the matcher`);
  });
});
