/**
 * The upkeep of a space's triple index ends: a rebuild clears every journal row it can, the fill looks terms up by an index, and the
 * journal is scanned by indexes (bundle-273, Q-764, review findings F1, F3 and G5; contract rows 3 and 5).
 *
 * ## The rules
 *
 * 1. **F1: a `*` row whose writer died is cleared by the rebuild it asks for.** A `*` journal row never marked done (its process died, its
 *    mark failed) is abandoned once older than `journalRowAbandonedMs()`. A build marks such a row as its own (`seenBy`) as it marks the rows
 *    done, and its swap deletes it. Without it the row stays, the upkeep answers `journal` at every tick, and the space is rebuilt every
 *    minute for ever, its queries on the records.
 * 2. **F3: a build's dictionary has its unique key from the start.** The fill looks terms up by `k` (`terms.ts`); on a collection without
 *    the index each lookup scans it, so a fill grows with the square of the space.
 * 3. **G5: the journal has indexes.** The follower asks for a `*` row (`journalAsksForRebuild`) and for the rows it may clear
 *    (`clearableJournalRows`) on every run; neither scans the collection.
 *
 * ## Seen red
 *
 * On d5192c4f6: case 1 fails at the second upkeep (`journal` again, the row is still there); case 2 fails at the build's terms collection
 * (no `k_unique`); case 3 fails at the journal's indexes (no index on `key`).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-upkeep-holds-up-on-a-large-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { assertIndexEqualsRecords, rebuildModule, buildCollections } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixu-upkeep';
let d;

/** The names of the indexes of the collection `name`; none when it does not exist. */
async function indexNames(name) {
  try { return (await d.col(name).indexes()).map(i => i.name); } catch (err) {
    if (err?.codeName === 'NamespaceNotFound') return [];
    throw err;
  }
}

describe('the upkeep of a triple index holds up on a large space', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixu-upkeep', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: 30 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${String(i).padStart(2, '0')}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('F1: a `*` row whose writer died is cleared by the rebuild it asked for, and the next upkeep asks for nothing', async () => {
    const { journalRowAbandonedMs } = await import('../../server/dist/rdf/triple-index/journal.js');
    const { upkeepTripleIndex } = await import('../../server/dist/rdf/triple-index/verify.js');
    await d.col(`${S}_rdf_dirty`).insertOne({ _id: 'tixu-dead-writer', key: '*', done: false, at: Date.now() - journalRowAbandonedMs() - 60_000 });
    const first = await upkeepTripleIndex(S, { verify: false });
    assert.deepEqual([first.reason, first.rebuilt, first.outcome], ['journal', 'journal', 'built'], 'the abandoned `*` row asks for a rebuild, which is built');
    assert.equal(await d.col(`${S}_rdf_dirty`).countDocuments({}), 0, 'the rebuild cleared the row of the writer that died');
    const second = await upkeepTripleIndex(S, { verify: false });
    assert.equal(second.reason, null, 'the next upkeep asks for nothing: the space is not rebuilt for ever');
    await followUntilReady(d, S);
  });

  it('F1: a `*` row whose write is still in flight is not cleared by a rebuild', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    await d.col(`${S}_rdf_dirty`).insertOne({ _id: 'tixu-live-writer', key: '*', done: false, at: Date.now() });
    try {
      assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
      assert.equal(await d.col(`${S}_rdf_dirty`).countDocuments({ _id: 'tixu-live-writer' }), 1, 'a write that may still land keeps its row');
    } finally { await d.col(`${S}_rdf_dirty`).deleteOne({ _id: 'tixu-live-writer' }); }
  });

  it('F3: the dictionary of a build has its unique key before the fill reads it', async () => {
    const { beginTripleIndexBuild, fillTripleIndexBuild, swapTripleIndexBuild } = await rebuildModule();
    const build = await beginTripleIndexBuild(S);
    assert.ok(build, 'the build starts');
    try {
      assert.ok((await indexNames(build.target.terms)).includes('k_unique'), `the build's terms collection has k_unique: ${JSON.stringify(await indexNames(build.target.terms))}`);
      await fillTripleIndexBuild(build);
      await swapTripleIndexBuild(build);
    } catch (err) {
      await (await import('../../server/dist/rdf/triple-index/store.js')).releaseTripleIndexBuild(S, build.buildId);
      throw err;
    }
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
    assert.deepEqual(await buildCollections(d, S), [], 'no build collection is left');
  });

  it('G5: the journal has the indexes its scans use, and its scans use them', async () => {
    const dirty = `${S}_rdf_dirty`;
    const names = await indexNames(dirty);
    assert.ok(names.some(n => n.startsWith('key_')), `the journal has an index on key: ${JSON.stringify(names)}`);
    assert.ok(names.some(n => n.startsWith('done_')), `the journal has an index on done: ${JSON.stringify(names)}`);
    const rows = Array.from({ length: 20 }, (_, i) => ({ _id: `tixu-row-${i}`, key: `entity:p${i}`, done: i % 2 === 0, at: Date.now() - i }));
    await d.col(dirty).insertMany(rows);
    try {
      const abandonedBefore = Date.now() - 1_000;
      const scans = {
        'a `*` row': { key: '*' },
        'the rows the follower may clear': { key: { $ne: '*' }, $or: [{ done: true }, { at: { $lt: abandonedBefore } }] },
        'the build marking rows as its own': { at: { $lte: Date.now() }, $or: [{ done: true }, { at: { $lt: abandonedBefore } }] },
      };
      for (const [what, filter] of Object.entries(scans)) {
        const plan = JSON.stringify((await d.col(dirty).find(filter).explain('queryPlanner')).queryPlanner.winningPlan);
        assert.ok(!plan.includes('COLLSCAN'), `${what} does not scan the journal: ${plan}`);
      }
    } finally { await d.col(dirty).deleteMany({ _id: { $in: rows.map(r => r._id) } }); }
  });
});
