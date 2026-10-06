/**
 * Every space's tombstones collection carries a `{ type: 1, seq: 1 }` index once the space is initialised — 5.6.3
 * (bundle-46 port, vet T7).
 *
 * ## Why
 *
 * The tombstone pager serves a peer one page per TYPE in seq order (`listTombstones(space, sinceSeq, limit, type)`,
 * asked at the 5000 clamp since `Q-237`), and the tie-safe pager re-asks from a seq within a run. Without an index
 * that leads with the type and orders by seq, each of those pages is a scan and an in-memory sort over the space's
 * whole tombstone history, five times per space per peer per cycle. `initSpace` is where a space's indexes are
 * made, so a space created after the upgrade and one that existed before both get it (the first 5.6.3 boot builds it
 * per space, which the upgrade note states).
 *
 * Asserted on the index's KEY, in order, not on its name: a name is a spelling, the key is what the planner uses.
 *
 * **5.6.8 (bundle-52, `Q-277`):** the index is `{ type: 1, seq: 1, _id: 1 }` — the tie-safe tombstone read pages by `(seq, _id)`, which the
 * bare `{ type: 1, seq: 1 }` cannot order. The key is read out of `SEQ_KEYSET_INDEXES` (`util/seq-keyset.ts`), the one declaration, and a
 * space initialised here is a NEW one, so `initSpace` creates it with the collection; a space that existed before gets it from the
 * background pass (`a-keyset-read-uses-its-index-db`).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-tombstones-collection-is-indexed-by-type-and-seq-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'tomb-index';
let door;

describe('a space\'s tombstones are indexed by type, then seq', { skip }, () => {
  before(async () => {
    // `openPushDoor` initialises each space exactly as production does (`initSpace`).
    door = await openPushDoor({ suite: 'tombindex', spaces: [{ id: S, label: 'Tombstone index', folders: [] }] });
  });
  after(async () => { await door?.close(); });

  it('after initSpace the tombstones collection has an index keyed { type: 1, seq: 1, _id: 1 }', async () => {
    const { SEQ_KEYSET_INDEXES } = await import('../../server/dist/util/seq-keyset.js');
    const declared = SEQ_KEYSET_INDEXES.find(ix => ix.part === 'tombstones' && 'type' in ix.keys);
    assert.ok(declared, 'SEQ_KEYSET_INDEXES no longer declares the typed tombstone index — re-point this gate');
    assert.deepEqual(Object.entries(declared.keys), [['type', 1], ['seq', 1], ['_id', 1]], 'the declared typed tombstone index is not { type, seq, _id }');
    const indexes = await door.coll(S, 'tombstones').indexes();
    assert.ok(indexes.length >= 1, 'fixture check: the tombstones collection has no index at all, so initSpace never ran');
    const keys = indexes.map(i => Object.entries(i.key));
    assert.ok(keys.some(k => JSON.stringify(k) === JSON.stringify(Object.entries(declared.keys))),
      `no { type: 1, seq: 1, _id: 1 } index on ${S}_tombstones, so every per-type tombstone page is a scan and a sort: `
      + JSON.stringify(indexes.map(i => i.key)));
  });
});
