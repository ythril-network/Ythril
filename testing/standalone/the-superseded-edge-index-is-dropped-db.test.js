/**
 * The old three-field edge unique index is DROPPED, not merely superseded — exercised against a real MongoDB.
 *
 * ## Why this needs a database and not a source read
 *
 * `createIndex` with a new key spec creates an ADDITIONAL index. That is the whole defect: after M-3 widened
 * the edge identity key to `(from, to, label, fromKind, toKind)`, a space that already existed still carried
 * `from_1_to_1_label_1` with its unique constraint intact — so an edge whose endpoints differ from another's
 * only in KIND has a free `_id` and is refused on the old key.
 *
 * A source read cannot see that. `createIndex` is called with the right shape, the drop is called too, and
 * whether the collection ends up with one unique index or two is a fact about Mongo rather than about the
 * source. It also cannot see the direction that matters more: that the drop does not take the NEW index with
 * it. Matching on a key shape is one typo away from matching both.
 *
 * ## The rule this leans on, and why a boot-time migration is allowed
 *
 * Migrations over SYNCED DATA must be lazy and self-healing, because rewriting replicated documents ships a
 * whole space to every peer as changes. An index is not data — it is local state, rebuilt from the documents,
 * and never replicated — so it is exactly the case that rule exempts.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/the-superseded-edge-index-is-dropped-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'idxprobe';
let mongo, shared;

const edges = () => mongo.col(`${SPACE}_edges`);
const keysOf = async () => (await edges().listIndexes().toArray())
  .filter(i => i.name !== '_id_')
  .map(i => Object.keys(i.key).join(','));

describe('the superseded edge identity index is dropped', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('edgeidx');
    shared = await import('../../server/dist/spaces/_shared.js');
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => {
    await edges().deleteMany({});
    // `listIndexes` on a collection that does not exist yet THROWS `ns does not exist` rather than returning
    // nothing — which is exactly why the production dropper opens with a try/catch, and is asserted below.
    try {
      for (const i of await edges().listIndexes().toArray()) {
        if (i.name !== '_id_') await edges().dropIndex(i.name);
      }
    } catch { /* no collection yet, so no indexes to clear */ }
  });

  it('the dropper is exported and reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof shared.dropSupersededEdgeIdentityIndex, 'function');
  });

  it('drops the old three-field unique index', async () => {
    await edges().createIndex({ from: 1, to: 1, label: 1 }, { unique: true });
    assert.deepEqual(await keysOf(), ['from,to,label'], 'the fixture did not take');

    await shared.dropSupersededEdgeIdentityIndex(edges());
    assert.deepEqual(await keysOf(), [], 'the superseded index survived, and it still refuses the widened rows');
  });

  it('and leaves the WIDENED index alone — the direction that matters more', async () => {
    /*
     * A key-shape match is one typo from matching both. Dropping the replacement would remove the uniqueness
     * guarantee on edge identity altogether, which is worse than the defect being fixed: duplicate
     * relationships would then store silently rather than being refused.
     */
    await edges().createIndex({ from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 }, { unique: true });
    await shared.dropSupersededEdgeIdentityIndex(edges());
    assert.deepEqual(await keysOf(), ['from,to,label,fromKind,toKind']);
  });

  it('leaves every other index alone', async () => {
    // `to_1` and `seq_1` exist for read paths and have nothing to do with identity. A sweep that matched on
    // "starts with from" or "is unique" would take one of them.
    await edges().createIndex({ to: 1 });
    await edges().createIndex({ seq: 1 });
    await edges().createIndex({ from: 1, to: 1, label: 1 }, { unique: true });
    await shared.dropSupersededEdgeIdentityIndex(edges());
    assert.deepEqual((await keysOf()).sort(), ['seq', 'to']);
  });

  it('is a no-op on a collection that does not exist yet', async () => {
    /*
     * The very first boot of a fresh space. `listIndexes` THROWS `ns does not exist` on a collection Mongo has
     * not materialised, so an unguarded dropper would fail space creation — and it runs inside a `Promise.all`
     * with eight others, so the rejection would take the whole batch. That is the reason for the try/catch, and
     * this is the case that holds it.
     */
    const virgin = mongo.col('never_created_edges');
    await shared.dropSupersededEdgeIdentityIndex(virgin);
    assert.ok(true, 'it returned rather than throwing');
  });

  it('is a no-op when the old index was never there', async () => {
    // The fresh-space case, and every boot after the first. It must not throw and must not log a failure for
    // an index that correctly does not exist.
    await edges().createIndex({ from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 }, { unique: true });
    await shared.dropSupersededEdgeIdentityIndex(edges());
    await shared.dropSupersededEdgeIdentityIndex(edges());
    assert.deepEqual(await keysOf(), ['from,to,label,fromKind,toKind']);
  });

  it('with the old index gone, two edges differing only in endpoint KIND both store', async () => {
    /*
     * The point of all of it. Under the old index these are one key and the second insert is a duplicate; under
     * the new one they are two keys, and `edgeIdFor` derives two ids for them.
     *
     * Asserted as an insert rather than through the write path, because what is under test is the INDEX: the
     * write path has its own coverage and would hide a constraint failure behind its own error handling.
     */
    await edges().createIndex({ from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 }, { unique: true });
    const base = { spaceId: SPACE, from: 'x', to: 'y', label: 'mentions' };
    await edges().insertOne({ _id: 'as-entity', ...base });
    await edges().insertOne({ _id: 'as-memory', ...base, toKind: 'fact' });
    assert.equal(await edges().countDocuments({}), 2,
      'the two relationships did not both store, so the widened identity is not reachable');
  });
});
