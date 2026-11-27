/**
 * Every record write the triple index's follower does not see by position still reaches the index: the journal at the one db door brings it
 * in, or the index is marked not ready (bundle-273, Q-764 slice S2; design-r2 R2, R9; contract rows 1, 3 and 5).
 *
 * ## The rules
 *
 * 1. **Each unpositioned write site the design found lands in the index** once it returns and the follower has run: chrono redaction
 *    (`brain/chrono-redaction.ts`), the stamp a conversion sets (`brain/schema-convert-record.ts`), a converged file `updatedAt`
 *    (`sync/arrivals.ts`), the stale-spaceId repair a rename runs (`spaces/_shared.ts`, which changes no field the form reads), the boot
 *    re-key of the memory kind (`db/rekey-memory-kind-to-fact.ts`, an insert and a delete without a position) and the wipe
 *    (`spaces/lifecycle.ts`). The retype's unstamp and a file's link removal are in the journal spec beside this one (R6).
 * 2. **A writer the door cannot see marks the index not ready**: the positions rollback (`sync/positions-rollback.ts`, run on a client of its
 *    own before a 5.6 build writes with no journal) and the restore (`db/restore.ts`, which drops the index, so the follower starts it again).
 * 3. **A positioned write in a transaction that holds no floor** (`withLandingStamp` handed a session outside `inHeldTransaction`) lands in the
 *    index: its stamp settles before its commit, so the follower alone would pass its position before the record is visible.
 * 4. **A filter that cannot be reduced to ids** marks the index not ready (journal key `*`), and so does a dropped or renamed record collection.
 *
 * ## Seen red
 *
 * On 3d51a40fa (S1 only): see the slice's return for each first failing line.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/an-unpositioned-record-write-reaches-the-triple-index-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { buildIndexes } from './_triple-index-read.mjs';
import { assertIndexedAsStored, indexedStatements, indexState } from './_triple-index.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b273-tix-journal-sites';
const S = 'tixj-sites';
const W = 'tixj-wipe';
const RB = 'tixj-rollback';
const RS = 'tixj-restore';
const STAR = 'tixj-star';
const DROP = 'tixj-drop';
const MOVED = 'tixj-moved';
const SPACES = [S, W, RB, RS, STAR, DROP, MOVED];
const STAMP = '2026-03-04T05:06:07.000Z';
const TMP = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';

let d, stream, clock, follow, mongo, tmpDir;
const col = (space, part) => d.col(d.spaceCollection(space, part));
const common = (space, id) => ({ _id: id, spaceId: space, seq: 1, tags: [], createdAt: STAMP, updatedAt: STAMP });

/** Write `doc` into `part` of `space` the positioned way, as every write door does. */
async function landed(space, part, doc) {
  await stream.withLandingStamp(space, [stream.localRow(1)], async ([patch]) => {
    await col(space, part).replaceOne({ _id: doc._id }, { ...doc, ...patch }, { upsert: true });
  }, 'test.landing');
}

/** Run the space's follower to the end of a run that starts now. */
const followed = (space) => follow.followTripleIndex(space, () => clock.settledPositionCap(stream.recordPositions, space));

describe('an unpositioned record write reaches the triple index', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: SUITE, spaces: SPACES.map(id => ({ id, meta: rdfMeta(id) })) });
    stream = await import('../../server/dist/sync/record-position-stream.js');
    clock = await import('../../server/dist/util/position-clock.js');
    follow = await import('../../server/dist/rdf/triple-index/follow.js');
    mongo = await import('../../server/dist/db/mongo.js');
    tmpDir = fs.mkdtempSync(path.join(TMP, 'b273-tixj-'));
    // The follower applies to an index a rebuild built (pre-ship finding P2): build each space's, as the upkeep does.
    await buildIndexes(SPACES);
  });
  after(async () => {
    await d?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('chrono redaction (brain/chrono-redaction.ts): the redacted description leaves the index', async () => {
    const { redactLapsedChronoContent } = await import('../../server/dist/brain/chrono-redaction.js');
    await landed(S, 'chrono', { ...common(S, 'c1'), title: 'Meeting', type: 'event', startsAt: STAMP, description: 'a secret detail', _contentExpireAt: new Date(0) });
    assert.ok((await indexedStatements(d, S, 'chrono', 'c1')).some(s => s.includes('a secret detail')), 'the landed chrono states its description');
    assert.equal(await redactLapsedChronoContent(S, new Date()), 1, 'the sweep redacted the chrono');
    await followed(S);
    await assertIndexedAsStored(assert, d, S, 'chrono', 'chrono', 'c1');
  });

  it('a conversion stamp (brain/schema-convert-record.ts): the record states the form it conforms to', async () => {
    const { convertOneRecord } = await import('../../server/dist/brain/schema-convert-record.js');
    const { readMetaForWrite } = await import('../../server/dist/spaces/schema-stamp.js');
    await landed(S, 'entities', { ...common(S, 'e-conv'), name: 'Converted', type: 'thing' });
    const record = await col(S, 'entities').findOne({ _id: 'e-conv' });
    const run = { toFp: readMetaForWrite(S).stamp.fp, steps: [], splitDeclared: {} };
    await convertOneRecord(S, run, 'entity', record);
    const stored = await col(S, 'entities').findOne({ _id: 'e-conv' });
    assert.ok(Object.keys(stored).some(k => k !== 'pos' && !(k in record)), `the conversion stamped the record: ${JSON.stringify(stored)}`);
    await followed(S);
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', 'e-conv');
  });

  it('a converged file updatedAt (sync/arrivals.ts): the file states its new date', async () => {
    const { convergeFileStamps } = await import('../../server/dist/sync/arrivals.js');
    const id = 'notes/converged.md';
    await landed(S, 'files', { ...common(S, id), path: id, sizeBytes: 3, sha256: 'a'.repeat(64), author: { instanceId: 'peer-a' } });
    const NEW = '2026-05-06T07:08:09.000Z';
    const done = await convergeFileStamps(S, [{ _id: id, seq: 1, author: { instanceId: 'peer-a' }, updatedAt: NEW }], new Map([[id, STAMP]]));
    assert.deepEqual(done, [id], 'the file converged');
    await followed(S);
    await assertIndexedAsStored(assert, d, S, 'file', 'files', id);
  });

  it('the stale-spaceId repair (spaces/_shared.ts) changes no field the form reads, and the index still holds the record', async () => {
    const { repairStaleSpaceIds } = await import('../../server/dist/spaces/_shared.js');
    await landed(S, 'entities', { ...common(S, 'e-stale'), spaceId: 'elsewhere', name: 'Stale', type: 'thing' });
    assert.ok(await repairStaleSpaceIds(S) >= 1, 'the repair rewrote the row');
    await followed(S);
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', 'e-stale');
    assert.equal((await indexState(d, S)).status, 'ready', 'a write of a field no statement reads leaves the index ready');
  });

  it('the memory kind re-key (db/rekey-memory-kind-to-fact.ts): the re-keyed edge is in the index, the old id is not', async () => {
    const { rekeyMemoryKindToFact } = await import('../../server/dist/db/rekey-memory-kind-to-fact.js');
    await landed(S, 'facts', { ...common(S, 'f-mem'), fact: 'Remembered', type: 'note' });
    await landed(S, 'entities', { ...common(S, 'e-mem'), name: 'Rememberer', type: 'thing' });
    await landed(S, 'edges', { ...common(S, 'ed-mem-old'), from: 'f-mem', fromKind: 'memory', to: 'e-mem', toKind: 'entity', label: 'mentions' });
    const out = await rekeyMemoryKindToFact();
    const moved = await col(S, 'edges').find({ from: 'f-mem' }).toArray();
    assert.equal(moved.length, 1, `one edge from the fact remains: ${JSON.stringify(out)}`);
    assert.notEqual(moved[0]._id, 'ed-mem-old', 'the edge moved to its derived id');
    await followed(S);
    await assertIndexedAsStored(assert, d, S, 'edge', 'edges', moved[0]._id);
    assert.equal(await indexedStatements(d, S, 'edge', 'ed-mem-old'), null, 'the old edge id states nothing');
  });

  it('the wipe (spaces/lifecycle.ts): the wiped records leave the index', async () => {
    const lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    await landed(W, 'entities', { ...common(W, 'w1'), name: 'Wiped', type: 'thing' });
    assert.ok((await indexedStatements(d, W, 'entity', 'w1')).length > 0, 'the landed entity is in the index');
    await lifecycle.wipeSpace(W, ['entities']);
    assert.equal(await col(W, 'entities').countDocuments({}), 0, 'the wipe removed the entity');
    await followed(W);
    assert.equal(await indexedStatements(d, W, 'entity', 'w1'), null, 'the wiped entity states nothing');
  });

  it('the positions rollback (sync/positions-rollback.ts), run on its own client, marks the index not ready', async () => {
    const { rollBackPositions } = await import('../../server/dist/sync/positions-rollback.js');
    await landed(RB, 'entities', { ...common(RB, 'rb1'), name: 'Rolled back', type: 'thing' });
    assert.equal((await indexState(d, RB)).status, 'ready', 'the index starts ready');
    const own = mongo.getMongo().db(`ythril_harness_${SUITE}`);
    await rollBackPositions(own, { log: () => {}, discardUnresolvedForks: true });
    assert.notEqual((await indexState(d, RB))?.status, 'ready', 'after a rollback the next build writes with no journal, so the index is not ready');
  });

  it('the restore (db/restore.ts), on its own client, leaves no index, and a rebuild builds it again from the records', async () => {
    const dump = await import('../../server/dist/db/dump.js');
    const restore = await import('../../server/dist/db/restore.js');
    await landed(RS, 'entities', { ...common(RS, 'rs1'), name: 'Restored', type: 'thing' });
    const dest = path.join(tmpDir, 'dump');
    await dump.dumpDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);
    await col(RS, 'entities').updateOne({ _id: 'rs1' }, { $set: { name: 'Changed after the backup' } });
    await restore.restoreDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);
    assert.notEqual((await indexState(d, RS))?.status, 'ready', 'a restore leaves no ready index');
    // The restore dropped every space's index of this database: the rebuilds the upkeep would run.
    await buildIndexes(SPACES);
    await followed(RS);
    await assertIndexedAsStored(assert, d, RS, 'entity', 'entities', 'rs1');
  });

  it('a positioned write in a transaction that holds no floor is in the index once it committed', async () => {
    const { inBoundedTransaction } = await import('../../server/dist/db/bounded-transaction.js');
    await landed(S, 'entities', { ...common(S, 'e-before'), name: 'Before', type: 'thing' });
    await inBoundedTransaction(async (session) => {
      await stream.withLandingStamp(S, [stream.localRow(1)], async ([patch]) => {
        await col(S, 'entities').replaceOne({ _id: 'e-txn' }, { ...common(S, 'e-txn'), name: 'In a transaction', type: 'thing', ...patch }, { upsert: true, session });
      }, 'test.landing');
    });
    await followed(S);
    await assertIndexedAsStored(assert, d, S, 'entity', 'entities', 'e-txn');
  });

  it('a write whose filter cannot be reduced to ids marks the index not ready', async () => {
    await landed(STAR, 'entities', { ...common(STAR, 's1'), name: 'One', type: 'thing' });
    assert.equal((await indexState(d, STAR)).status, 'ready', 'the index starts ready');
    await col(STAR, 'entities').updateMany({ type: 'thing' }, { $set: { name: 'Renamed by type' } });
    await followed(STAR);
    assert.notEqual((await indexState(d, STAR)).status, 'ready', 'a write the journal cannot name record by record leaves the index needing a rebuild');
  });

  it('a dropped or renamed record collection marks the index not ready', async () => {
    await landed(DROP, 'facts', { ...common(DROP, 'df1'), fact: 'Dropped', type: 'note' });
    await landed(MOVED, 'entities', { ...common(MOVED, 'me1'), name: 'Moved away', type: 'thing' });
    assert.equal((await indexState(d, DROP)).status, 'ready', 'the index starts ready');
    assert.equal((await indexState(d, MOVED)).status, 'ready', 'the other index starts ready');
    await col(DROP, 'facts').drop();
    assert.notEqual((await indexState(d, DROP)).status, 'ready', 'a dropped record collection leaves the index needing a rebuild');
    await col(MOVED, 'entities').rename('tixj-elsewhere_entities');
    assert.notEqual((await indexState(d, MOVED)).status, 'ready', 'a record collection renamed away leaves the index needing a rebuild');
  });
});
