/**
 * The table of meta keys a release added (`sync/meta-skew.ts`) names every key the previous release refuses, and only those (R6-7).
 *
 * ## What it holds, and why it is a gate
 *
 * A schema write that sets a key an earlier release does not read warns of the members that may refuse it (`membersBehindNewKeys`). Which keys
 * those are is a fact about RELEASES, not about this build's body — the body at run time cannot know what the previous one accepted — so the
 * server carries it as a table (`NEW_META_KEYS`, `NEW_TYPE_FIELDS`, each key to the first release that reads it). A table of that kind rots
 * the way a list does: the next release adds a meta key, nobody adds a row, and the warning is silently never given for it. So the table is
 * held to the previous release's own body, loaded as it shipped (`_previous-release.mjs`):
 *
 *  - every top-level key this build's `SpaceMetaBody` accepts and `v5.6.10`'s did not is a row of `NEW_META_KEYS`, and the other way round;
 *  - every field this build's inline type schema accepts and the previous one did not is a row of `NEW_TYPE_FIELDS`;
 *  - a row of either table names a key the previous release REFUSES (a row for a key it reads warns about nothing), and a `since` that
 *    parses as a version above the previous release and not above this build's next minor.
 *
 * A type field the table lists that this build does not accept yet (`rules`, the type-level half of F-46) is allowed: the table is what the
 * release will read, and a key the body does not take yet is not a write that can be made. The first direction (a new key with no row) is
 * the one that goes wrong silently.
 *
 * ## Seen red
 *
 * By mutation, each put back by hand: a row removed from `NEW_META_KEYS` is found by the first group; a row for a key the old body reads
 * (`purpose`) is found by the third. The comparisons are one function over two key lists, so the same function judges the real tables and a
 * table with a row dropped or added, below.
 *
 * Run: node --test testing/standalone/the-since-table-names-every-key-new-since-the-previous-release.test.js
 * (requires a prior server build and the tag v5.6.10 in the checkout)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { releaseSkipReason, loadRelease, PREDECESSOR_TAG } from './_previous-release.mjs';

const skip = releaseSkipReason();
const BODY = 'server/src/spaces/body-schemas.ts';

/** The keys of `added` not in `before` that `table` lacks, and the keys of `table` that `before` already holds: what a table gets wrong. */
function whatTheTableGetsWrong({ before, now, table }) {
  const added = now.filter(k => !before.includes(k));
  return {
    missing: added.filter(k => !Object.hasOwn(table, k)),
    stale: Object.keys(table).filter(k => before.includes(k)),
  };
}

describe(`the since-tables against the previous release (${PREDECESSOR_TAG})`, { skip }, () => {
  let loaded, oldMetaKeys, newMetaKeys, oldTypeFields, newTypeFields, NEW_META_KEYS, NEW_TYPE_FIELDS, comparePeerVersions;
  before(async () => {
    loaded = await loadRelease([BODY]);
    const oldBody = loaded.modules[BODY];
    const newBody = await import('../../server/dist/spaces/body-schemas.js');
    ({ NEW_META_KEYS, NEW_TYPE_FIELDS } = await import('../../server/dist/sync/meta-skew.js'));
    ({ comparePeerVersions } = await import('../../server/dist/sync/peer-floor.js'));
    oldMetaKeys = Object.keys(oldBody.SpaceMetaBody.shape);
    newMetaKeys = Object.keys(newBody.SpaceMetaBody.shape);
    // The old body keeps its inline type definition as one branch of a union (the one with a naming pattern); this build exports it.
    const oldInline = oldBody.TypeSchemaZ.def.options.find(o => o?.shape?.namingPattern);
    assert.ok(oldInline, 'the previous release\'s inline type schema was not found among its TypeSchemaZ options');
    oldTypeFields = Object.keys(oldInline.shape);
    newTypeFields = Object.keys(newBody.InlineTypeSchemaZ.shape);
  });
  after(() => loaded?.cleanup());

  it('the premise: both bodies were read, and this build accepts at least what the previous one did', () => {
    assert.ok(oldMetaKeys.length >= 7 && newMetaKeys.length > oldMetaKeys.length, `old ${oldMetaKeys.length} keys, new ${newMetaKeys.length}`);
    assert.ok(oldTypeFields.length >= 7, `only ${oldTypeFields.length} type fields read at ${PREDECESSOR_TAG}`);
    assert.deepEqual(oldMetaKeys.filter(k => !newMetaKeys.includes(k)), [], 'a meta key the previous release accepts is gone from this build');
  });

  it('every meta key new since the previous release is a row of NEW_META_KEYS, and no row is for a key it already read', () => {
    assert.deepEqual(whatTheTableGetsWrong({ before: oldMetaKeys, now: newMetaKeys, table: NEW_META_KEYS }), { missing: [], stale: [] });
  });

  it('every type field new since the previous release is a row of NEW_TYPE_FIELDS, and no row is for a field it already read', () => {
    assert.deepEqual(whatTheTableGetsWrong({ before: oldTypeFields, now: newTypeFields, table: NEW_TYPE_FIELDS }), { missing: [], stale: [] });
  });

  it('every row names a release above the previous one: a row that says "already read" would warn about nothing', () => {
    for (const [key, since] of [...Object.entries(NEW_META_KEYS), ...Object.entries(NEW_TYPE_FIELDS)]) {
      assert.ok(comparePeerVersions(since, PREDECESSOR_TAG.replace(/^v/, '')) > 0, `${key}: ${since} is not above ${PREDECESSOR_TAG}`);
    }
  });

  describe('seen red: the same function over a table with a row dropped or added', () => {
    it('a dropped row is found', () => {
      const [first, ...rest] = Object.keys(NEW_META_KEYS);
      assert.ok(first !== undefined, 'NEW_META_KEYS is empty: stampSkew is the first key this build adds');
      const without = Object.fromEntries(rest.map(k => [k, NEW_META_KEYS[k]]));
      assert.deepEqual(whatTheTableGetsWrong({ before: oldMetaKeys, now: newMetaKeys, table: without }).missing, [first]);
    });
    it('a row for a key the previous release reads is found', () => {
      const withStale = { ...NEW_META_KEYS, purpose: '5.7.0' };
      assert.deepEqual(whatTheTableGetsWrong({ before: oldMetaKeys, now: newMetaKeys, table: withStale }).stale, ['purpose']);
    });
  });
});
