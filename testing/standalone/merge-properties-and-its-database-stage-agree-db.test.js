/**
 * `mergeProperties` and the database stage `mergePropertiesStage` are ONE rule in two spellings (bundle-62, Q-197).
 *
 * ## Why this test exists
 *
 * A file rewrite merges in the write's own pipeline (`brain/merge-fields.ts`: `mergePropertiesStage(incoming)`), so no edit landing between a
 * read and the write can lose a key; every writer that merges in application code spells the same rule as `mergeProperties`. Two spellings of one
 * rule agree only while something holds them to each other: this runs every row through BOTH, the stage as a real `updateOne` pipeline against
 * the test Mongo, and expects the same answer written out in the row.
 *
 * ## The rule
 *
 * The stored bag with the incoming one laid over it, ONE level deep, incoming wins per key:
 *
 *  - a nested object is replaced whole, never merged into;
 *  - a stored value that is not a plain object (absent, `null`, an array, a string, a number) counts as ABSENT, so the incoming bag is the result
 *    (an array spread into a map is `{ 0: .. }`, a string's characters: neither is a bag a caller ever stored);
 *  - a key that starts with `$` or holds a dot is data, carried by `$literal` inside the stage, never read as an operator or a path;
 *  - an empty incoming bag changes nothing.
 *
 * Red against 0ac12bdd: `mergePropertiesStage` is not exported; and `mergeProperties` spreads a stored array or string into the result.
 *
 * Run: node --test testing/standalone/merge-properties-and-its-database-stage-agree-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

/** `stored: undefined` is an absent field; every row states its expected result, never "whatever the other spelling gave". */
const ROWS = Object.freeze([
  { name: 'an overwritten key', stored: { a: 1, b: 2 }, incoming: { b: 3 }, expected: { a: 1, b: 3 } },
  { name: 'a new key beside a stored one', stored: { a: 1 }, incoming: { b: 2 }, expected: { a: 1, b: 2 } },
  { name: 'one level of nesting: a nested object is replaced whole', stored: { n: { x: 1, z: 3 }, a: 1 }, incoming: { n: { y: 2 } }, expected: { n: { y: 2 }, a: 1 } },
  { name: 'an absent stored bag', stored: undefined, incoming: { b: 2 }, expected: { b: 2 } },
  { name: 'a null stored bag', stored: null, incoming: { b: 2 }, expected: { b: 2 } },
  { name: 'a stored array', stored: ['x', 'y'], incoming: { b: 2 }, expected: { b: 2 } },
  { name: 'a stored string', stored: 'text', incoming: { b: 2 }, expected: { b: 2 } },
  { name: 'a stored number', stored: 5, incoming: { b: 2 }, expected: { b: 2 } },
  { name: 'a $-prefixed key', stored: { a: 1 }, incoming: { $weird: 'v' }, expected: { a: 1, $weird: 'v' } },
  { name: 'a $-prefixed value that is not a field path', stored: { a: 1 }, incoming: { b: '$a' }, expected: { a: 1, b: '$a' } },
  { name: 'a dotted key', stored: { a: 1 }, incoming: { 'a.b': 2 }, expected: { a: 1, 'a.b': 2 } },
  { name: 'an empty incoming bag over a stored one', stored: { a: 1 }, incoming: {}, expected: { a: 1 } },
  { name: 'an empty incoming bag over a non-object', stored: ['x'], incoming: {}, expected: {} },
]);

let mongo, mergeFields, rowSeq = 0;

/** Run the stage as the pipeline `$set` of a real update over a row with `stored`, and read the row back. */
async function throughTheDatabase(stored, incoming) {
  assert.equal(typeof mergeFields.mergePropertiesStage, 'function',
    'server/src/brain/merge-fields.ts exports no `mergePropertiesStage`: the database spelling of the rule is not there');
  const col = mongo.col('props_stage');
  const _id = `row-${++rowSeq}`;
  await col.insertOne({ _id, ...(stored !== undefined ? { properties: stored } : {}) });
  const res = await col.updateOne({ _id }, [{ $set: { properties: mergeFields.mergePropertiesStage(incoming) } }]);
  assert.equal(res.matchedCount, 1, 'the pipeline update matched no row');
  return (await col.findOne({ _id })).properties;
}

describe('mergeProperties and mergePropertiesStage are one rule', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('propsstage');
    mergeFields = await import('../../server/dist/brain/merge-fields.js');
  });
  after(async () => { await closeTestMongo(); });

  it('the table is not empty (a floor)', () => {
    assert.ok(ROWS.length >= 12, 'overwrite, nesting, absent, non-object, $-prefixed, dotted and empty are the rows the plan names');
  });

  for (const row of ROWS) {
    it(`mergeProperties: ${row.name}`, () => {
      assert.deepEqual(mergeFields.mergeProperties(row.stored, row.incoming), row.expected);
    });

    it(`mergePropertiesStage in a real update: ${row.name}`, async () => {
      assert.deepEqual(await throughTheDatabase(row.stored, row.incoming), row.expected);
    });
  }
});
