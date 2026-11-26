/**
 * A rebuild of a triple index that fails to start does not keep the build row, and a rebuild sweeps the build collections an earlier
 * build left behind (bundle-273, Q-764, review finding F7 and the unproven point U3).
 *
 * ## The rules
 *
 * 1. **F7: a failed start gives the row back.** `beginTripleIndexBuild` claims the build row and then reads the cap and marks the journal;
 *    a store error there kept the row for its whole lease (120 s), so every rebuild and every journal batch of the space answered
 *    `busy` / `building` meanwhile.
 * 2. **U3: no build collection outlives its build.** A build that ended without dropping its collections (its process was killed in the
 *    fill, or the space was renamed under it: the rename carries `<space>_rdf_b<id>_*` along by prefix) left up to three collections that
 *    nothing named again. A build that holds the row drops every `<space>_rdf_b*` collection that is not its own. (A space delete drops them
 *    already: it drops every collection under the space's prefix, `spaces/lifecycle.ts`.)
 *
 * ## Seen red
 *
 * On 42c51f330: case 1 fails at the build row (still held after the failed start); case 2 at the collections left after the rebuild.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-rebuild-leaves-nothing-behind-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { assertIndexEqualsRecords, buildCollections, rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixn-left';
let d;

describe('a triple index rebuild leaves nothing behind', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixn-left', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: 15 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('F7: a start that fails after it claimed the row gives the row back, and the next rebuild is not busy', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const { runningTripleIndexBuild } = await import('../../server/dist/rdf/triple-index/store.js');
    const { getDb } = await import('../../server/dist/db/mongo.js');
    const proto = Object.getPrototypeOf(getDb().collection('probe'));
    const original = proto.updateMany;
    let fired = 0;
    proto.updateMany = async function failing(...args) {
      if (this.collectionName === `${S}_rdf_dirty` && fired === 0) { fired++; throw new Error('planted: the journal mark failed'); }
      return original.apply(this, args);
    };
    try { await assert.rejects(rebuildTripleIndex(S), /planted/); } finally { proto.updateMany = original; }
    assert.equal(fired, 1, 'the planted failure was reached');
    assert.equal(await runningTripleIndexBuild(S), null, 'the failed start does not hold the build row');
    assert.deepEqual(await buildCollections(d, S), [], 'and left no collection');
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built', 'the next rebuild is not refused as busy');
    await followUntilReady(d, S);
  });

  it('U3: a rebuild drops the build collections an earlier build left, and only those', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    for (const part of ['terms', 'quads', 'records']) await d.col(`${S}_rdf_b0123456789abcdef_${part}`).insertOne({ _id: 1 });
    // Not a build collection of the space: the sibling's name has the same shape, and it is not touched.
    await d.col('tixn-left-sibling_rdf_b0123456789abcdef_terms').insertOne({ _id: 1 });
    try {
      assert.deepEqual((await buildCollections(d, S)).length, 3, 'three orphaned collections stand');
      assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
      assert.deepEqual(await buildCollections(d, S), [], 'no build collection stands after a rebuild');
      assert.equal(await d.col('tixn-left-sibling_rdf_b0123456789abcdef_terms').countDocuments({}), 1, 'another space\'s collection stays');
    } finally { await d.col('tixn-left-sibling_rdf_b0123456789abcdef_terms').drop().catch(() => undefined); }
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
  });
});
