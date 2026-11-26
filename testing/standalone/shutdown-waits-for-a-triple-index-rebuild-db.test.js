/**
 * Shutdown ends a triple index rebuild at its next page and waits for it before the database closes (bundle-273, Q-764, review finding F2,
 * its second part).
 *
 * ## The defect
 *
 * Shutdown stopped the upkeep job's timer and nothing else: a rebuild in flight (the upkeep's, or one an admin started, detached from its
 * request) ran on into `closeMongo`. A swap cut there is the failure `the-triple-index-swap-is-whole-or-unread-db` holds the index safe
 * from; a fill cut there left its build collections behind.
 *
 * ## The rules
 *
 * 1. **A rebuild in flight is awaited.** `awaitTripleIndexRebuilds(ms)` resolves once every rebuild of this process has ended, `false`
 *    when `ms` ran out first. The fill of a rebuild stops at its next page once the shutdown began (`beginShutdown`), drops its build
 *    collections, gives its row back, and answers `stopped`; the live index is untouched. A rebuild asked for after the shutdown began
 *    is not started.
 * 2. **The sequence awaits them before `closeMongo`.** `runShutdown` calls `awaitTripleIndexRebuilds` after the upkeep job is stopped and
 *    before it closes the database (the order is read from the sequence's text, as the other gates of the sequence read it).
 *
 * ## Seen red
 *
 * On 42c51f330: `awaitTripleIndexRebuilds` is not exported by `rebuild.js`, and `runShutdown` calls nothing of the kind.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/shutdown-waits-for-a-triple-index-rebuild-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { assertIndexEqualsRecords, buildCollections, rebuildModule } from './_triple-index-rebuild.mjs';
import { parkWrites, settleWithin } from './_write-faults.mjs';
import { readShutdownSequence } from './_shutdown-sequence.mjs';

const skip = await mongoSkipReason();
const S = 'tixs-down';
let d;
const buildOf = async () => (await d.col(`${S}_rdf_state`).findOne({ _id: 'state' }))?.buildId;

describe('shutdown waits for a triple index rebuild', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixs-down', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: 20 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('a rebuild whose fill is in flight is awaited, stops at its next page, and leaves the index and the row as they were', async () => {
    const { requestTripleIndexRebuild, awaitTripleIndexRebuilds } = await rebuildModule();
    assert.equal(typeof awaitTripleIndexRebuilds, 'function', 'rebuild.ts exports awaitTripleIndexRebuilds');
    const lifecycle = await import('../../server/dist/lifecycle.js');
    const { runningTripleIndexBuild } = await import('../../server/dist/rdf/triple-index/store.js');
    const { getDb } = await import('../../server/dist/db/mongo.js');
    const was = await buildOf();
    const park = parkWrites(Object.getPrototypeOf(getDb().collection('probe')));
    // The first fenced page of the fill: its transaction's fence write is parked, so the rebuild is in flight.
    const gate = park.arm(`${S}_rdf_state`, { when: (_method, args) => JSON.stringify(args.slice(0, 2)).includes('fencedWrites') });
    try {
      const rebuild = requestTripleIndexRebuild(S);
      await gate.reached;
      const waiting = awaitTripleIndexRebuilds(20_000);
      assert.equal((await settleWithin(waiting, 500)).settled, false, 'the wait does not end while a rebuild is in flight');
      lifecycle.beginShutdown();
      gate.release();
      assert.equal(await waiting, true, 'the wait ends when the rebuild has');
      assert.equal((await rebuild).outcome, 'stopped', 'the rebuild stopped at its next page');
      assert.equal(await runningTripleIndexBuild(S), null, 'it gave its row back');
      assert.deepEqual(await buildCollections(d, S), [], 'and dropped its collections');
      assert.equal(await buildOf(), was, 'the live index is the one it was');
      assert.equal((await requestTripleIndexRebuild(S)).outcome, 'stopped', 'no rebuild starts once the shutdown began');
      assert.equal(await runningTripleIndexBuild(S), null, 'and none claimed the row');
    } finally {
      gate.release();
      park.restore();
      lifecycle.resetLifecycleForTests();
    }
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
  });

  it('with no rebuild in flight the wait ends at once', async () => {
    const { awaitTripleIndexRebuilds } = await rebuildModule();
    assert.equal(await awaitTripleIndexRebuilds(50), true);
  });

  it('runShutdown awaits the rebuilds after the upkeep job stops and before the database closes', () => {
    const { body } = readShutdownSequence('.');
    const at = (text) => { const i = body.indexOf(text); assert.ok(i > -1, `the shutdown sequence has no \`${text}\``); return i; };
    const stopped = at('stopTripleIndexUpkeep()');
    const awaited = at('awaitTripleIndexRebuilds(');
    const closed = at('await closeMongo()');
    assert.ok(stopped < awaited, 'the upkeep job is stopped before the rebuilds are awaited: no tick starts a new one');
    assert.ok(awaited < closed, 'the rebuilds are awaited before the database closes');
  });
});
