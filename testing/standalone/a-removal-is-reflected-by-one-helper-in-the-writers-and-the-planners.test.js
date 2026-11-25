/**
 * The update writers and the record planners reflect a `deleteFields` removal through ONE helper (bundle-272, Q-962).
 *
 * ## What it prevents
 *
 * The block that turns the paths a caller named into `$set`/`$unset` was written inline in `updateEntityById`, `updateEdgeById`, `updateFact` and
 * `updateChrono`, once per writer with small differences (the entity's and the edge's reset `newTags`, the fact's and the chrono's loop). A fifth
 * and a sixth copy, in the planners, would have been decided by whichever writer its author read last. `reflectDeleteFields` is the one block; a
 * writer or planner that goes back to its own makes the rules differ per record kind again.
 *
 * ## The rows
 *
 * What the helper answers for a PATCH, written by hand: a pruned bag is re-set from the merged view, a whole removed field is unset and taken out
 * of `$set` (the store rejects one path in both), a field that is present and `undefined` is never re-set (the driver stores `null`), a wildcard
 * path prunes every element. The fields each kind may name are one table, `DELETABLE_FIELDS`.
 *
 * Run: node --test testing/standalone/a-removal-is-reflected-by-one-helper-in-the-writers-and-the-planners.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let reflectDeleteFields, DELETABLE_FIELDS;
before(async () => {
  ({ reflectDeleteFields, DELETABLE_FIELDS } = await import('../../server/dist/brain/delete-fields.js'));
});

describe('reflectDeleteFields: what a PATCH writer gets for the paths a caller named', () => {
  const FIELDS = ['description', 'tags', 'properties'];
  const run = (merged, paths, set = {}, fields = FIELDS) => {
    const unset = {};
    reflectDeleteFields(merged, paths, fields, set, unset);
    return { merged, set, unset };
  };

  it('a pruned bag is re-set from the merged view; a field no path touched stays out of $set', () => {
    const { set, unset } = run({ description: 'd', tags: ['a'], properties: { k: 1, j: 2 } }, ['properties.k']);
    assert.deepEqual(set, { properties: { j: 2 } });
    assert.deepEqual(unset, {});
  });

  it('a whole removed field is unset and taken out of $set', () => {
    const { set, unset } = run({ description: 'd', tags: ['a'], properties: {} }, ['tags'], { tags: ['a'], updatedAt: 't' });
    assert.deepEqual(unset, { tags: '' });
    assert.deepEqual(set, { updatedAt: 't' });
  });

  it('a path no listed field owns changes neither $set nor $unset', () => {
    const { set, unset } = run({ description: 'd', tags: [], properties: {}, title: 'kept' }, ['title']);
    assert.deepEqual(set, {});
    assert.deepEqual(unset, {});
  });

  it('a field that is present and undefined is never re-set', () => {
    const { set } = run({ description: undefined, tags: [], properties: {} }, ['description.x']);
    assert.deepEqual(set, {});
  });

  it('a wildcard path prunes every element and re-sets the field', () => {
    const { set } = run({ description: 'd', tags: [], properties: { items: [{ stale: 1, keep: 2 }, { stale: 3, keep: 4 }] } }, ['properties.items.*.stale']);
    assert.deepEqual(set, { properties: { items: [{ keep: 2 }, { keep: 4 }] } });
  });

  it('the table names a row for every knowledge type, each holding the three fields every kind shares', () => {
    for (const kind of ['entity', 'fact', 'chrono', 'edge']) {
      for (const field of ['description', 'tags', 'properties']) {
        assert.ok(DELETABLE_FIELDS[kind].includes(field), `${kind} cannot name ${field} in deleteFields`);
      }
    }
  });
});

describe('no writer and no planner reflects a removal by a block of its own', () => {
  const code = file => stripComments(readFileSync(file, 'utf8'));
  for (const file of ['entities', 'fact', 'chrono', 'edges']) {
    it(`brain/${file}.ts reflects through reflectDeleteFields, with no merged-view block of its own`, () => {
      const src = code(`server/src/brain/${file}.ts`);
      assert.match(src, /reflectDeleteFields\(merged, /, 'the writer does not reflect through the shared helper');
      assert.doesNotMatch(src, /applyDeleteFields\(merged\b/, 'the writer applies the paths to its merged view itself');
    });
  }
  for (const file of ['plan-entity', 'plan-fact', 'plan-chrono', 'plan-edge']) {
    it(`write-plan/${file}.ts folds a removal through foldRemovals`, () => {
      assert.match(code(`server/src/brain/write-plan/${file}.ts`), /foldRemovals\(/);
    });
  }
  it('the detector fires on the block it forbids (a planted copy of the writers\' line)', () => {
    const planted = stripComments('    applyDeleteFields(merged, deleteFieldsPaths);\n');
    assert.match(planted, /applyDeleteFields\(merged\b/);
  });
});
