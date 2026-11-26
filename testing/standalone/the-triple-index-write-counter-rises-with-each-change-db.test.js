/**
 * The triple index's state row counts its changes: `writes` rises by one in every apply transaction, every rebuild swap and every stale
 * mark, in the same transaction as the change it counts (bundle-378, Q-976 S2, contract row 1).
 *
 * ## Why
 *
 * A planning count of the index (`IndexRead.estimate`) is the same number for as long as the index has not changed. The counter is what
 * says it has not: a count kept under the counter it was made at is reused while the state row still reads that counter, and never after
 * a change. So every change must raise it, and a change that did not land must not: an apply that lost its lease, or whose transaction was
 * aborted, leaves the counter where it was.
 *
 * ## Seen red
 *
 * On d97660409 the state row has no `writes` field.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-write-counter-rises-with-each-change-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixw-writes';
const OWNER = 'tixw-owner';

let d, store;
const state = () => d.col(`${S}_rdf_state`).findOne({ _id: 'state' });
const writes = async () => {
  const w = (await state())?.writes;
  assert.equal(typeof w, 'number', `the state row counts its changes: writes is ${JSON.stringify(w)}`);
  return w;
};

describe('the triple index write counter rises with each change', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b378-tixw', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    store = await import('../../server/dist/rdf/triple-index/store.js');
    await landAll(d, S, [['entities', entityDoc(S, 'w0', 'Counted zero', 'thing')]]);
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('an apply raises it by one; an apply that lost its lease or was aborted does not', async () => {
    const { formKey, appliedPos } = await state();
    await d.col(`${S}_rdf_state`).updateOne({ _id: 'lease' }, { $set: { owner: OWNER, until: Date.now() + 60_000 } }, { upsert: true });
    try {
      const w0 = await writes();
      assert.equal(await store.applyTripleIndexBatch(S, { formKey, owner: OWNER, changes: [], appliedPos }), 'applied');
      assert.equal(await writes(), w0 + 1, 'an apply transaction raises the counter by one');
      assert.equal(await store.applyTripleIndexBatch(S, { formKey, owner: 'another-owner', changes: [], appliedPos }), 'lease-lost');
      assert.equal(await writes(), w0 + 1, 'an apply that lost its lease changes nothing, the counter included');
      // A journal batch meeting a running rebuild aborts its transaction: nothing it wrote lands, the counter included.
      assert.equal(await store.claimTripleIndexBuild(S, 'feedfacefeedface', 60_000), true);
      try {
        assert.equal(await store.applyTripleIndexBatch(S, { formKey, owner: OWNER, changes: [], appliedPos, clearJournal: ['tixw-row'] }), 'building');
      } finally { await store.releaseTripleIndexBuild(S, 'feedfacefeedface'); }
      assert.equal(await writes(), w0 + 1, 'an aborted apply transaction leaves the counter where it was');
    } finally {
      await d.col(`${S}_rdf_state`).deleteOne({ _id: 'lease' });
    }
  });

  it('a follower run raises it with each batch it applies', async () => {
    const w0 = await writes();
    await landAll(d, S, [['entities', entityDoc(S, 'w1', 'Counted one', 'thing')]]);
    await followUntilReady(d, S);
    assert.ok(await writes() > w0, 'the follower applied the write and raised the counter');
  });

  it('a stale mark raises it by one, and the rebuild swap that follows raises it again', async () => {
    const w0 = await writes();
    await store.markTripleIndexStale(S);
    assert.equal((await state()).status, 'stale');
    assert.equal(await writes(), w0 + 1, 'a stale mark raises the counter by one');
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    assert.ok(await writes() > w0 + 1, 'the swap raises the counter and never resets it');
  });
});
