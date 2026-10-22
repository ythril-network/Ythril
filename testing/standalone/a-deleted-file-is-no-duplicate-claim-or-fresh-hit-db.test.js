/**
 * A soft-deleted file's row is not a near-duplicate, not a fresh recall hit, and holds no claim (bundle-122, Q-481, lens L3).
 *
 * ## The rule
 *
 * With `softDeleteFileMeta` on, a deleted file's row stays in `<space>_files` flagged `deletedAt`. Three readers fetch rows by id
 * AFTER something else found the id, and each carries `notFlaggedIfFile(type)` so a flagged row is dropped there:
 *
 *  - `checkDuplicates`, the fresh-write half: the collection scan (`matchFreshWrites`) names a flagged row that still holds
 *    its vector, and the hydration that follows must not turn it into a duplicate the writer is shown;
 *  - `hydrateFreshHits` (recall's fresh-write half): a row flagged BETWEEN the scan and the hydration must not be a result;
 *  - `fetchStructuredClaims`: a deleted file's row holds no claim a contradiction judge may compare.
 *
 * ## Why this file exists
 *
 * Only a static gate held those three filters, and it checks that a predicate is NAMED at the site, not that it works: a
 * filter on the wrong variable would pass it. This file asks the database.
 *
 * ## How each reader is reached
 *
 * - `checkDuplicates` and `fetchStructuredClaims` are exported and called directly.
 * - `hydrateFreshHits` is not exported; it is reached through `recall`. The scan's own predicate (`recallPredicate`) already
 *   keeps a row that is flagged BEFORE the scan out, so a row flagged at rest never reaches the hydration. The case that does
 *   is the one the site's comment names, a row flagged since the scan found it, and this file makes it happen: it wraps the
 *   driver's `aggregate` for the files collection so that, once the scan has answered and named the row, the row is flagged
 *   before the answer is handed back. The wrap asserts the scan DID name the row, so the case cannot pass by the scan missing it.
 *
 * No vector index is created: the fresh-write halves read the collection and need none, and without one the index half of a
 * duplicate check or recall answers nothing, so every id asserted below arrives through the fresh-write channel under test.
 * Every case also asserts the LIVE row IS returned, so none can pass by an empty answer.
 *
 * Run: a Mongo the harness accepts (`npm run test:up`), then
 *      node --test testing/standalone/a-deleted-file-is-no-duplicate-claim-or-fresh-hit-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder } from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b122-l3-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

const S = 'l3files';
const COLL = `${S}_files`;
const LIVE = 'live-file.md';
const DELETED = 'deleted-file.md';

let mongo, stub, recallModule, claims;
/** What the files-collection scan named, recorded by the wrap below. */
let scanNamed = [];
/** The id the wrap flags once the scan has named it, or null when the wrap is idle. */
let flagAfterScan = null;
let restoreAggregate = null;

/** Both rows qualify for everything asked below: the query's own vector, written now, with the same claim. */
const fileRow = (id, extra = {}) => ({
  _id: id, spaceId: S, path: id, sizeBytes: 10, tags: [], description: `file ${id}`,
  embedding: unitAt(0, DIMS), embeddingModel: 'stub', matchedText: `text of ${id}`,
  properties: { colour: 'red' },
  seq: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
});

/**
 * Make "flagged since the scan found it" happen: the first files-collection scan (the `$facet` pipeline of `matchFreshWrites`)
 * answers as it would, then `flagAfterScan` is flagged `deletedAt` before the caller sees the answer. Reached through the
 * prototype of the collection the server itself uses, so it is the server's driver that is wrapped.
 */
function armFlagAfterScan(id) {
  const proto = Object.getPrototypeOf(mongo.col(COLL));
  const original = proto.aggregate;
  flagAfterScan = id;
  scanNamed = [];
  proto.aggregate = function wrapped(pipeline, ...rest) {
    const cursor = original.call(this, pipeline, ...rest);
    if (this.collectionName !== COLL || !JSON.stringify(pipeline).includes('$facet')) return cursor;
    const toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async (...a) => {
      const out = await toArray(...a);
      const named = (out[0]?.rows ?? []).map(r => String(r._id));
      if (flagAfterScan && named.includes(flagAfterScan)) {
        scanNamed = named;
        const id = flagAfterScan;
        flagAfterScan = null;
        await this.updateOne({ _id: id }, { $set: { deletedAt: new Date().toISOString() } });
      }
      return out;
    };
    return cursor;
  };
  restoreAggregate = () => { proto.aggregate = original; restoreAggregate = null; };
}

describe('a deleted file row is no duplicate, no fresh recall hit and no claim', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'b122-l3', instanceLabel: 'test', tokens: [], networks: [], softDeleteFileMeta: true,
        spaces: [{ id: S, label: S, folders: [] }] }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('b122l3files');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallModule = await import('../../server/dist/brain/recall.js');
    claims = await import('../../server/dist/brain/structured-claims.js');
    await mongo.getDb().createCollection(COLL);
    await mongo.col(COLL).createIndex({ seq: 1 });
    // `checkDuplicates` answers [] outright unless the backend probe has run; boot does it, a standalone test does not.
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    restoreAggregate?.();
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await mongo.col(COLL).deleteMany({});
    await mongo.col(COLL).insertMany([fileRow(LIVE), fileRow(DELETED, { deletedAt: new Date().toISOString(), seq: 2 })]);
  });

  afterEach(() => { restoreAggregate?.(); flagAfterScan = null; });

  it('fixture check: the deleted row is flagged, holds its vector and would match the same query as the live one', async () => {
    const deleted = await mongo.col(COLL).findOne({ _id: DELETED });
    const live = await mongo.col(COLL).findOne({ _id: LIVE });
    assert.ok(deleted.deletedAt, 'the deleted row carries the flag');
    assert.equal(live.deletedAt, undefined, 'the live row carries none');
    assert.deepEqual(deleted.embedding, live.embedding, 'both rows hold the same vector, so the scan cannot tell them apart');
    const { matchFreshWrites } = await import('../../server/dist/brain/fresh-writes.js');
    const named = (await matchFreshWrites(COLL, queryAxis(DIMS))).map(m => m._id).sort();
    assert.deepEqual(named, [DELETED, LIVE].sort(),
      'the unfiltered fresh-write scan names BOTH rows: the only thing between the deleted one and the answer is the hydration filter');
  });

  it('checkDuplicates: a live file is a near-duplicate, the deleted file with the same vector is not', async () => {
    const hits = await recallModule.checkDuplicates(S, 'file', queryAxis(DIMS), 0.9, 10);
    const ids = hits.map(h => h._id);
    assert.ok(ids.includes(LIVE), `the live file must be named as a duplicate, got [${ids.join(', ')}] (an empty answer would pass the next line)`);
    assert.ok(!ids.includes(DELETED), `the deleted file's audit row was shown to the writer as a near-duplicate: [${ids.join(', ')}]`);
    assert.deepEqual(ids, [LIVE]);
  });

  it('recall (hydrateFreshHits): a file flagged after the fresh-write scan found it is not a result; the live one is', async () => {
    // The row flagged at seed is out already (the scan's own predicate); the case is a row live at scan time and deleted since.
    await mongo.col(COLL).updateOne({ _id: DELETED }, { $unset: { deletedAt: '' } });
    armFlagAfterScan(DELETED);
    const results = await recallModule.recall(S, 'anything', 10, undefined, ['file']);
    const ids = results.map(r => String(r._id));
    assert.deepEqual([...scanNamed].sort(), [DELETED, LIVE].sort(),
      'the scan named both rows and flagged one afterwards: the race this case stands for did not happen');
    assert.equal((await mongo.col(COLL).findOne({ _id: DELETED })).deletedAt !== undefined, true, 'the row is flagged in the collection by now');
    assert.ok(ids.includes(LIVE), `the live file must be a recall result, got [${ids.join(', ')}] (an empty answer would pass the next line)`);
    assert.ok(!ids.includes(DELETED), `a file flagged since the scan found it came back as a recall result: [${ids.join(', ')}]`);
    assert.deepEqual(ids, [LIVE]);
  });

  it('fetchStructuredClaims: a live file row yields its claim, a deleted file row yields none', async () => {
    const got = await claims.fetchStructuredClaims(S, 'file', [LIVE, DELETED]);
    assert.deepEqual(got.get(LIVE), { colour: 'red' }, 'the live file row holds its claim (an empty map would pass the next line)');
    assert.equal(got.has(DELETED), false, `the deleted file's row was read as a claim holder: [${[...got.keys()].join(', ')}]`);
    assert.deepEqual([...got.keys()], [LIVE]);
  });
});
