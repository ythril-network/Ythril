/**
 * A rebuild of a space's triple index writes into collections named by its build id and swaps them in; every batch is fenced on the build
 * row in `rdf_state`, so only the build holding it lands (bundle-273, Q-764 slice S4; design-r2 R5; contract rows 1 and 4).
 *
 * ## The rules
 *
 * 1. **A write during the build is in the result.** A positioned write and a journaled write that land after the build read the records
 *    and before it swapped are in the index once the follower has run after the swap.
 * 2. **Two rebuilds at once: one builds, the other is refused.** Started together, one answers `built` and the other `busy`.
 * 3. **A builder whose lease ran out is fenced.** When another build has taken the build row, the first one's next batch and its swap are
 *    refused (`RebuildFenced`), and the index is the second one's.
 * 4. **An expired lease's late batch is refused** even when nobody took the row over, the index stays the one it was, and no collection
 *    of the refused build is left.
 *
 * ## Seen red
 *
 * On 65080cae3 (no rebuild): every case fails at the import of `server/dist/rdf/triple-index/rebuild.js` (ERR_MODULE_NOT_FOUND).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-triple-index-rebuild-is-fenced-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { assertIndexedAsStored } from './_triple-index.mjs';
import { assertIndexEqualsRecords, buildCollections, rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-fence';
let d;
const state = () => d.col(`${S}_rdf_state`).findOne({ _id: 'state' });

describe('a triple index rebuild is fenced', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-fence', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    const docs = [];
    for (let i = 0; i < 20; i++) docs.push(['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]);
    await landAll(d, S, docs);
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('a write that lands while the build runs is in the index after its swap', async () => {
    const { beginTripleIndexBuild, fillTripleIndexBuild, swapTripleIndexBuild } = await rebuildModule();
    const build = await beginTripleIndexBuild(S);
    assert.ok(build, 'the build row was free');
    await fillTripleIndexBuild(build);
    // After the build read the records, before it swaps: a positioned write and one the journal carries.
    await landAll(d, S, [['entities', entityDoc(S, 'late', 'Late Comer', 'person')]]);
    await d.col(d.spaceCollection(S, 'entities')).updateOne({ _id: 'p3' }, { $set: { name: 'Renamed During Build' } });
    await swapTripleIndexBuild(build);
    assert.equal((await state()).buildId, build.buildId, 'the index is the swapped build');
    await followUntilReady(d, S);
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', 'late');
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', 'p3');
    await assertIndexEqualsRecords(assert, d, S);
    assert.deepEqual(await buildCollections(d, S), [], 'no build collection is left after the swap');
  });

  it('two rebuilds started together: one builds, the other is refused', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const outcomes = (await Promise.all([rebuildTripleIndex(S), rebuildTripleIndex(S)])).map(r => r.outcome).sort();
    assert.deepEqual(outcomes, ['built', 'busy']);
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
  });

  it('a builder whose lease ran out and was taken over is fenced at its next batch and at its swap', async () => {
    const { beginTripleIndexBuild, fillTripleIndexBuild, swapTripleIndexBuild } = await rebuildModule();
    const first = await beginTripleIndexBuild(S, { leaseMs: 1 });
    assert.ok(first);
    await sleep(30);
    const second = await beginTripleIndexBuild(S);
    assert.ok(second, 'a build row whose lease ran out is taken by the next build');
    await assert.rejects(fillTripleIndexBuild(first), { name: 'RebuildFenced' });
    await assert.rejects(swapTripleIndexBuild(first), { name: 'RebuildFenced' });
    await fillTripleIndexBuild(second);
    await swapTripleIndexBuild(second);
    assert.equal((await state()).buildId, second.buildId, 'the index is the build that held the row');
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
  });

  it('a late batch of an expired lease is refused, the index stays as it was, and its collections are dropped', async () => {
    const { beginTripleIndexBuild, fillTripleIndexBuild } = await rebuildModule();
    const was = (await state()).buildId;
    const build = await beginTripleIndexBuild(S, { leaseMs: 1 });
    assert.ok(build);
    await sleep(30);
    await assert.rejects(fillTripleIndexBuild(build), { name: 'RebuildFenced' });
    assert.equal((await state()).buildId, was, 'the index is still the one it was');
    assert.deepEqual(await buildCollections(d, S), [], 'the refused build left no collection');
  });
});
