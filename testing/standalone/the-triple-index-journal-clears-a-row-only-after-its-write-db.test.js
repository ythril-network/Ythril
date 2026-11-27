/**
 * The triple index's write journal: one row per write, cleared only once that write has marked it done and the follower has read the record
 * again after the mark; filters on ids name their records (bundle-273, Q-764 slice S2; design-r2 R2 and R6; contract rows 1, 2 and 4).
 *
 * ## The rules
 *
 * 1. **R2, two overlapping writes to one record both land.** Each write journals its own row (its own `_id`, `key` = kind:id), so a write that
 *    finishes first and has its row cleared does not clear the row of a write still in flight.
 * 2. **R2, the overlap of finding F2.** A row that is not done (its write may not have landed) survives a follower run that re-read the record,
 *    and keeps the space's journal outstanding (`hasOutstandingJournalRows`, the barrier S3 asks); once it is done, the next run applies the
 *    record and clears it.
 * 3. **A row its writer never marked** (the process died between the write and the mark) is cleared, after the record is read again, once it is
 *    older than the write bound.
 * 4. **R6: the retype's unstamp and a file's link removal name their records.** Their filters (`edgeEndsAt`, `{ fromKind, from: $in }`) are not
 *    ids; each reads its ids first, so the journal names each record and the index stays ready.
 *
 * ## Seen red
 *
 * On 3d51a40fa (S1 only): see the slice's return for each first failing line.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-journal-clears-a-row-only-after-its-write-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { buildIndexes } from './_triple-index-read.mjs';
import { assertIndexedAsStored, indexedStatements, indexState } from './_triple-index.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b273-tix-journal';
const J = 'tixj-rows';
const R6 = 'tixj-ids';
const STAMP = '2026-03-04T05:06:07.000Z';

let d, stream, clock, follow, journal, raw;
const col = (space, part) => d.col(d.spaceCollection(space, part));
/** A collection on the client's own database handle, around the door: a write here is one the journal never sees. */
const rawCol = (space, part) => raw.collection(d.spaceCollection(space, part));
const dirty = (space) => raw.collection(`${space}_rdf_dirty`);
const common = (space, id) => ({ _id: id, spaceId: space, seq: 1, tags: [], createdAt: STAMP, updatedAt: STAMP });

async function landed(space, part, doc) {
  await stream.withLandingStamp(space, [stream.localRow(1)], async ([patch]) => {
    await col(space, part).replaceOne({ _id: doc._id }, { ...doc, ...patch }, { upsert: true });
  }, 'test.landing');
}

const followed = (space) => follow.followTripleIndex(space, () => clock.settledPositionCap(stream.recordPositions, space));

describe('the triple index journal clears a row only after its write', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: SUITE, spaces: [{ id: J, meta: rdfMeta(J) }, { id: R6, meta: rdfMeta(R6) }] });
    stream = await import('../../server/dist/sync/record-position-stream.js');
    clock = await import('../../server/dist/util/position-clock.js');
    follow = await import('../../server/dist/rdf/triple-index/follow.js');
    const mongo = await import('../../server/dist/db/mongo.js');
    raw = mongo.getMongo().db(`ythril_harness_${SUITE}`);
    journal = await import('../../server/dist/rdf/triple-index/journal.js').catch(() => ({}));
    // The follower applies to an index a rebuild built (pre-ship finding P2): build each space's, as the upkeep does.
    await buildIndexes([J, R6]);
  });
  after(async () => { await d?.close(); });

  it('R2: two overlapping unpositioned writes to one record both land in the index', async () => {
    await landed(J, 'entities', { ...common(J, 'both'), name: 'Both', type: 'thing' });
    await Promise.all([
      col(J, 'entities').updateOne({ _id: 'both' }, { $set: { name: 'Both, renamed' } }),
      col(J, 'entities').updateOne({ _id: 'both' }, { $set: { description: 'and described' } }),
    ]);
    await followed(J);
    await assertIndexedAsStored(assert, d, J, 'entity', 'entities', 'both');
    assert.equal(await dirty(J).countDocuments({ key: 'entity:both' }), 0, 'both rows are cleared once both writes are applied');
  });

  it('R2 (F2): a row whose write is still in flight survives a run that re-read the record, and is applied once it is done', async () => {
    await landed(J, 'entities', { ...common(J, 'f2'), name: 'One', type: 'thing' });
    // Write B has journaled its row and not yet written; write A on the same record goes through the door, journals, writes, marks done.
    await dirty(J).insertOne({ _id: 'write-b', key: 'entity:f2', done: false, at: Date.now() });
    await col(J, 'entities').updateOne({ _id: 'f2' }, { $set: { name: 'Two' } });
    await followed(J);
    await assertIndexedAsStored(assert, d, J, 'entity', 'entities', 'f2');
    assert.deepEqual((await dirty(J).find({ key: 'entity:f2' }).toArray()).map(r => r._id), ['write-b'],
      'A\'s row is cleared, B\'s row (not done) is kept');
    assert.equal(await journal.hasOutstandingJournalRows?.(J), true, 'a row that is not done keeps the journal outstanding');

    // B lands (around the door, as its own write does after its row), then marks its row done.
    await rawCol(J, 'entities').updateOne({ _id: 'f2' }, { $set: { name: 'Three' } });
    await followed(J);
    assert.equal(await dirty(J).countDocuments({ _id: 'write-b' }), 1, 'a row that is not done is never cleared');
    await dirty(J).updateOne({ _id: 'write-b' }, { $set: { done: true } });
    await followed(J);
    await assertIndexedAsStored(assert, d, J, 'entity', 'entities', 'f2');
    assert.ok((await indexedStatements(d, J, 'entity', 'f2')).some(s => s.includes('Three')), 'B\'s write is in the index');
    assert.equal(await dirty(J).countDocuments({}), 0, 'every row is cleared');
    assert.equal(await journal.hasOutstandingJournalRows(J), false, 'nothing is outstanding');
  });

  it('a row its writer never marked done is cleared after the write bound, with the record read again', async () => {
    await landed(J, 'entities', { ...common(J, 'crash'), name: 'Before the crash', type: 'thing' });
    await dirty(J).insertOne({ _id: 'crashed', key: 'entity:crash', done: false, at: 0 });
    await rawCol(J, 'entities').updateOne({ _id: 'crash' }, { $set: { name: 'Written, never marked' } });
    await followed(J);
    await assertIndexedAsStored(assert, d, J, 'entity', 'entities', 'crash');
    assert.equal(await dirty(J).countDocuments({ _id: 'crashed' }), 0, 'the abandoned row is cleared');
  });

  it('R6: the retype\'s unstamp of an entity\'s edges names each edge, and the index stays ready', async () => {
    const { unstampEdgesOfRetypedEntity } = await import('../../server/dist/brain/retyped-entity-edges.js');
    const { SCHEMA_FINGERPRINT_FIELD } = await import('../../server/dist/spaces/schema-stamp.js');
    await landed(R6, 'entities', { ...common(R6, 'rt'), name: 'Retyped', type: 'thing' });
    await landed(R6, 'entities', { ...common(R6, 'other'), name: 'Other', type: 'thing' });
    await landed(R6, 'edges', { ...common(R6, 'rt-edge'), from: 'rt', fromKind: 'entity', to: 'other', toKind: 'entity', label: 'knows', [SCHEMA_FINGERPRINT_FIELD]: 'fp-before' });
    assert.ok((await indexedStatements(d, R6, 'edge', 'rt-edge')).some(s => s.includes('conformsTo')), 'the stamped edge states its form');
    assert.equal(await unstampEdgesOfRetypedEntity(R6, 'rt'), 1, 'the unstamp reached the edge');
    await followed(R6);
    await assertIndexedAsStored(assert, d, R6, 'edge', 'edges', 'rt-edge');
    assert.equal((await indexState(d, R6)).status, 'ready', 'the index stays ready');
    assert.equal(await dirty(R6).countDocuments({ key: '*' }), 0, 'no row asks for a rebuild');
  });

  it('R6: a file\'s link removal names each link, and the index stays ready', async () => {
    const { removeFileLinkRowsLocally } = await import('../../server/dist/brain/links.js');
    await landed(R6, 'links', { _id: 'lnk-file', spaceId: R6, from: 'notes/linked.md', fromKind: 'file', to: 'other', toKind: 'entity', seq: 1 });
    assert.ok((await indexedStatements(d, R6, 'link', 'lnk-file'))?.length > 0, 'the landed link is in the index');
    await removeFileLinkRowsLocally(R6, ['notes/linked.md']);
    assert.equal(await col(R6, 'links').countDocuments({ _id: 'lnk-file' }), 0, 'the link row is gone');
    await followed(R6);
    assert.equal(await indexedStatements(d, R6, 'link', 'lnk-file'), null, 'the removed link states nothing');
    assert.equal((await indexState(d, R6)).status, 'ready', 'the index stays ready');
    assert.equal(await dirty(R6).countDocuments({ key: '*' }), 0, 'no row asks for a rebuild');
  });
});
