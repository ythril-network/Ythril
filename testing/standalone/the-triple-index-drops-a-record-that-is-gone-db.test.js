/**
 * The triple index drops the statements of a record that is no longer one: deleted with a tombstone, soft-deleted, or turned into a feed
 * marker (bundle-273, Q-764 slice S1; design-r2 R4 and R7; contract rows 7 and 8).
 *
 * ## The rules
 *
 * 1. **R4: a tombstone drops its record.** The follower reads `tombstones` by position as well as the record collections: a record whose row
 *    is removed and whose tombstone lands has no statements left, though its own row never shows up again to say so.
 * 2. **R7: a row left out is a remove-all.** The follower reads the record collections with no row filter: a file row that becomes a soft
 *    delete (`deletedAt`) or a feed marker (`feedMarkerStages`) is read at its new position, has no form, and its statements are dropped.
 * 3. A statement another record still states keeps its row, counted one lower.
 *
 * ## Seen red
 *
 * On aae46da89 (no index): every case fails at its first read of the index (the record has no row before it is removed).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-drops-a-record-that-is-gone-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { indexedStatements, quadRow, allQuadRows } from './_triple-index.mjs';

const skip = await mongoSkipReason();
const S = 'tix-gone';
const STAMP = '2026-03-04T05:06:07.000Z';
const AUTHOR = { instanceId: 'tix-gone-author', instanceLabel: 'Gone' };

let d, stream, tombs, marker;
const col = (part) => d.col(d.spaceCollection(S, part));

async function landed(collection, doc) {
  await stream.withLandingStamp(S, [stream.localRow(1)], async ([patch]) => {
    await col(collection).replaceOne({ _id: doc._id }, { ...doc, ...patch }, { upsert: true });
  }, 'test.landing');
}

const file = (path) => ({ _id: path, spaceId: S, path, sizeBytes: 5, sha256: 'cd'.repeat(32), createdAt: STAMP, updatedAt: STAMP, tags: [], seq: 1 });

describe('the triple index drops a record that is gone', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tix-gone', spaces: [{ id: S, meta: rdfMeta(S) }] });
    stream = await import('../../server/dist/sync/record-position-stream.js');
    tombs = await import('../../server/dist/brain/tombstones.js');
    marker = await import('../../server/dist/files/feed-marker.js');
  });
  after(async () => { await d?.close(); });

  it('R4: a record removed with its tombstone has no statements left, and a shared statement is counted one lower', async () => {
    const e = (id, name) => ({ _id: id, spaceId: S, name, type: 'thing', seq: 1, tags: [], createdAt: STAMP, updatedAt: STAMP, author: AUTHOR });
    await landed('entities', e('r1', 'Kept'));
    await landed('entities', e('r2', 'Removed'));
    const r2 = await indexedStatements(d, S, 'entity', 'r2');
    assert.ok(r2 !== null, 'the index holds no record row for entity r2');
    const agentType = r2.find(s => s.includes('prov#Agent'));
    assert.equal((await quadRow(d, S, agentType))?.nK, 2, 'both records state the shared agent');

    // The one removal every record delete reaches: the row deleted and its tombstone landed in one held transaction.
    await tombs.removeWithTombstones(S, 'entities', [{ _id: 'r2', type: 'entity' }]);
    assert.equal(await col('entities').countDocuments({ _id: 'r2' }), 0, 'the row is gone');
    assert.equal(await col('tombstones').countDocuments({ _id: 'r2' }), 1, 'and its tombstone landed');

    assert.equal(await indexedStatements(d, S, 'entity', 'r2'), null, 'the removed record keeps no record row');
    assert.equal((await quadRow(d, S, agentType))?.nK, 1, 'the shared agent statement is counted once now');
    const own = (await allQuadRows(d, S)).length;
    assert.ok(own > 0, 'the kept record still has its statements');
  });

  it('R7: a file soft-deleted or turned into a feed marker has its statements dropped', async () => {
    await landed('files', file('a/soft.txt'));
    await landed('files', file('a/marker.txt'));
    for (const id of ['a/soft.txt', 'a/marker.txt']) {
      assert.ok((await indexedStatements(d, S, 'file', id))?.length > 0, `the live file ${id} is in the index`);
    }

    await stream.withLandingStamp(S, [stream.localRow(2)], async ([patch]) => {
      await col('files').updateOne({ _id: 'a/soft.txt' }, { $set: { deletedAt: new Date().toISOString(), pos: patch.pos, posAtSeq: patch.posAtSeq } });
    }, 'test.soft-delete');
    assert.equal(await indexedStatements(d, S, 'file', 'a/soft.txt'), null, 'a soft-deleted file states nothing');

    await stream.withLandingStamp(S, [stream.localRow(2)], async ([patch]) => {
      await col('files').updateOne({ _id: 'a/marker.txt' }, marker.feedMarkerStages(S, patch.pos, new Date().toISOString()));
    }, 'test.feed-marker');
    assert.equal((await col('files').findOne({ _id: 'a/marker.txt' }))?.feedMarker, true, 'the row is a feed marker now');
    assert.equal(await indexedStatements(d, S, 'file', 'a/marker.txt'), null, 'a feed marker states nothing');
    for (const q of await allQuadRows(d, S)) assert.equal(q.nF, 0, 'no statement is counted for a file that is gone');
  });
});
