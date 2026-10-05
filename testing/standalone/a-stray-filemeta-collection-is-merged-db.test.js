/**
 * File metadata a 4.0-5.6.1 pull stored in `<space>_filemeta` is recovered into `<space>_files`, and the stray
 * collection is dropped once nothing in it can still be used — `Q-219`.
 *
 * ## The defect it repairs
 *
 * From P-32 (4.0) to 5.6.1 the pull wrote a peer's file metadata to `${spaceId}_${payloadKey}`, and the payload key
 * of that family is `filemeta`, not `files`. Nothing reads that collection, and the receive watermark had passed the
 * records, so they were never pulled again: a publisher's descriptions and tags never reached its subscribers' files.
 * Live instances hold such collections (counted 2026-10-02), so the rows are recovered rather than discarded.
 *
 * ## Why a seq comparison cannot recover them, and what does
 *
 * Through 5.5.x a receiver that pulled a peer's file BYTES wrote the file row itself, with its OWN fresh seq, its own
 * author, no description and empty tags (v5.5.0 `upsertFileMeta`; stopped by Q-143 in 5.6.0, the rows stayed). A
 * counter is bumped past every seq it has seen, so that row outranks the stray record, and 5.6.2's seq-accepted drain
 * counted almost every stray description as "older than the stored copy" and dropped it.
 *
 * So a row THIS instance made by default (authored here, no author, or seq 0) takes a FILL: each authored key the row
 * lacks, nothing it has — except that a machine-made description gives way to the publisher's human one. Its seq,
 * author and updatedAt are never touched, because a receiver's write must never outrank the publisher. A row a PEER
 * wrote keeps the normal seq accept, so a field the publisher removed by a later, synced edit is never restored.
 *
 * ## The rule, row by row
 *
 *  - a receiver-made row is filled; seq, author and updatedAt stand; its bytes get the file queued for embedding;
 *  - a row's own description and tags stand; empty tags are filled;
 *  - a machine-made description is replaced by a human one, and loses its machine label;
 *  - a soft-deleted receiver-made row is filled and stays deleted;
 *  - a fill that retires the file from search queues the job that removes its vector;
 *  - a peer-written row at a higher seq is NOT filled; at a lower seq it takes the stray's keys (the normal accept);
 *  - no row: nothing is created. With a tombstone the record is discarded; without one it waits, and is filled once
 *    the file's bytes arrive and create the row;
 *  - a file deleted while the drain is writing is not brought back;
 *  - a chunk is never stored as a file;
 *  - the work per cycle is bounded and resumes; the collection is dropped only when empty, with an audit entry;
 *  - a space that fails keeps its collection, is named in the log, and does not stop the spaces after it.
 *
 * Driven through the TTL sweep cycle (`sweepExpired`), the call site that runs it, so a drain nothing calls fails.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stray-filemeta-collection-is-merged-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { within } from './_within.mjs';

const skip = await mongoSkipReason();
const SUITE = 'strayfm';
const LOCAL = { instanceId: `${SUITE}-receiver`, instanceLabel: 'Receiver' };
const PEER = { instanceId: 'stray-peer', instanceLabel: 'Peer' };
const BAD = 'stray-fm-bad';        // first in the config, so a failure there must not stop the spaces after it
const SPACE = 'stray-fm';
const RACE = 'stray-fm-race';
const BUDGET = 'stray-fm-budget';
const LATE = 'stray-fm-late';
const BEHIND = 'stray-fm-behind';  // 5.6.x: a page whose counter bump failed (vet R1)
const REFUSE = 'stray-fm-refuse';  // 5.6.x: a record the store refuses (vet T7)
const STAMPED_AT = '2025-01-01T00:00:00.000Z';

let door, sweepExpired, drainStrayFileMeta, logMod;
const lines = [];

const stored = (space, id) => door.coll(space, 'files').findOne({ _id: id });
const strayCount = (space) => door.coll(space, 'filemeta').countDocuments({});
const strayExists = async (space) =>
  (await door.mongo.getDb().listCollections({ name: `${space}_filemeta` }).toArray()).length > 0;
const embedJob = (space, id) => door.mongo.getDb().collection(`${space}_embed_jobs`).findOne({ _id: `file:${id}` });
/** A pre-5.6.0 receiver's own row for a peer's file: its seq, its author, no description, empty tags. */
const stampedRow = (space, id, seq, extra = {}) =>
  ({ ...build.filemeta(space, id, seq, { author: LOCAL, createdAt: STAMPED_AT, updatedAt: STAMPED_AT }), ...extra });
const stray = (space, id, seq, extra = {}) =>
  ({ ...build.filemeta(space, id, seq, { author: PEER }), sizeBytes: 999, sha256: 'sender-hash', ...extra });
/** What `recordArrivedFile` writes when bytes land before any metadata: a seq-0 row naming no author. */
const arrivedRow = (space, id, extra = {}) => {
  const { author: _none, ...row } = build.filemeta(space, id, 0);
  return { ...row, ...extra };
};

async function auditFor(space, operation) {
  const audit = door.mongo.getDb().collection('audit_log');
  for (let i = 0; i < 50; i++) {        // the audit write is fire-and-forget, so poll rather than sleep once
    const e = await audit.findOne({ spaceId: space, operation });
    if (e) return e;
    await new Promise(r => setTimeout(r, 20));
  }
  return null;
}

describe('file metadata a 4.0-5.6.1 pull left in <space>_filemeta is recovered into the space files', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: [BAD, SPACE, RACE, BUDGET, LATE, BEHIND, REFUSE].map(id => ({ id, label: id, folders: [] })) });
    ({ sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js'));
    ({ drainStrayFileMeta } = await import('../../server/dist/sync/stray-filemeta-drain.js'));
    logMod = await import('../../server/dist/util/log.js');
    for (const level of ['info', 'warn', 'error']) {
      const orig = logMod.log[level];
      logMod.log[level] = (m, ...rest) => { lines.push(String(m)); return orig(m, ...rest); };
    }

    await door.coll(SPACE, 'files').insertMany([
      stampedRow(SPACE, 'stamped.md', 900, { sizeBytes: 11, sha256: 'receiver-hash' }),
      stampedRow(SPACE, 'own.md', 901, { description: 'written here', tags: ['mine'], sizeBytes: 3, sha256: 'h-own' }),
      stampedRow(SPACE, 'machine.md', 902, { description: 'an automatic caption', descriptionSource: 'generated' }),
      stampedRow(SPACE, 'soft.md', 903, { deletedAt: STAMPED_AT }),
      stampedRow(SPACE, 'retire.md', 904, { sizeBytes: 4, sha256: 'h-retire', embedding: [0.1, 0.2] }),
      arrivedRow(SPACE, 'seq-zero.md'),
      // Written by the peer and pulled on 5.6.2+: the publisher's later state, which REMOVED the description.
      { ...build.filemeta(SPACE, 'peer-newer.md', 50, { author: PEER }) },
      { ...build.filemeta(SPACE, 'peer-older.md', 10, { author: PEER }), sizeBytes: 22, sha256: 'receiver-hash-2' },
    ]);
    await door.mongo.getDb().collection(`${SPACE}_file_tombstones`).insertOne(
      { _id: 'tomb-1', spaceId: SPACE, path: 'deleted-since.md', deletedAt: STAMPED_AT });
    await door.coll(SPACE, 'filemeta').insertMany([
      stray(SPACE, 'stamped.md', 20, { description: 'described upstream', tags: ['onboarding'], properties: { owner: 'ops' } }),
      stray(SPACE, 'own.md', 21, { description: 'the publisher\'s text', tags: ['theirs'] }),
      stray(SPACE, 'machine.md', 22, { description: 'written by a person' }),
      stray(SPACE, 'soft.md', 23, { description: 'for a deleted file' }),
      stray(SPACE, 'retire.md', 24, { suppressEmbeddings: true }),
      stray(SPACE, 'seq-zero.md', 25, { description: 'for the seq-zero row' }),
      stray(SPACE, 'peer-newer.md', 40, { description: 'removed upstream since', tags: ['old'] }),
      stray(SPACE, 'peer-older.md', 20, { description: 'described upstream, later than here' }),
      stray(SPACE, 'deleted-since.md', 30, { description: 'a file deleted since' }),
      stray(SPACE, 'stamped.md#chunk-0', 31, { parentFileId: 'stamped.md' }),
    ]);
    await sweepExpired();
  });
  after(async () => { await door?.close(); });

  it('a row this instance made is filled from the stray record, and keeps its own seq, author and updatedAt', async () => {
    const d = await stored(SPACE, 'stamped.md');
    assert.equal(d?.description, 'described upstream', 'the stray description was not recovered');
    assert.deepEqual(d?.tags, ['onboarding']);
    assert.deepEqual(d?.properties, { owner: 'ops' });
    assert.equal(d?.seq, 900, 'a receiver\'s fill must not change the row\'s seq');
    assert.deepEqual(d?.author, LOCAL);
    assert.equal(d?.updatedAt, STAMPED_AT);
    assert.equal(d?.sizeBytes, 11, 'the sender\'s size describes bytes this instance may not hold');
    assert.equal(d?.sha256, 'receiver-hash');
    assert.ok(await embedJob(SPACE, 'stamped.md'), 'a filled file whose bytes are here is not queued for embedding');
    assert.equal((await stored(SPACE, 'seq-zero.md'))?.description, 'for the seq-zero row');
  });

  it('a row\'s own description and tags stand, and the record changes nothing nor queues anything', async () => {
    const d = await stored(SPACE, 'own.md');
    assert.equal(d?.description, 'written here');
    assert.deepEqual(d?.tags, ['mine']);
    assert.equal(await embedJob(SPACE, 'own.md'), null, 'a record that filled nothing was queued for embedding');
    // Red at the base for its sibling: the stamped row beside it must have been filled in the same cycle.
    assert.equal((await stored(SPACE, 'stamped.md'))?.description, 'described upstream');
  });

  it('a machine-made description gives way to the publisher\'s human one, and loses its machine label', async () => {
    const d = await stored(SPACE, 'machine.md');
    assert.equal(d?.description, 'written by a person');
    assert.equal(d?.descriptionSource, undefined, 'a human description kept the machine label');
  });

  it('a soft-deleted row is filled and stays deleted', async () => {
    const d = await stored(SPACE, 'soft.md');
    assert.equal(d?.description, 'for a deleted file');
    assert.equal(d?.deletedAt, STAMPED_AT, 'the fill brought a deleted file back');
  });

  it('a fill that retires a file from search queues the job that removes its vector', async () => {
    assert.equal((await stored(SPACE, 'retire.md'))?.suppressEmbeddings, true);
    assert.ok(await embedJob(SPACE, 'retire.md'), 'the vector of a retired file is never removed');
  });

  it('pin: a row a peer wrote keeps the normal seq accept, so a field the publisher removed is not restored', async () => {
    const newer = await stored(SPACE, 'peer-newer.md');
    assert.equal(newer?.description, undefined, 'a description the publisher removed came back');
    assert.deepEqual(newer?.tags, []);
    assert.equal(newer?.seq, 50);
    const older = await stored(SPACE, 'peer-older.md');
    assert.equal(older?.description, 'described upstream, later than here');
    assert.equal(older?.seq, 20);
    assert.equal(older?.sha256, 'receiver-hash-2');
  });

  it('pin: a stray record with no row creates nothing, a deleted file is discarded, and a chunk is never a file', async () => {
    assert.equal(await stored(SPACE, 'deleted-since.md'), null, 'a deleted file came back as a record with no bytes');
    assert.equal(await stored(SPACE, 'stamped.md#chunk-0'), null);
    assert.equal(await strayExists(SPACE), false, 'the collection is kept although nothing in it can be used');
  });

  it('the cycle logs what it recovered under the canary-pinned line', async () => {
    const line = lines.find(l => l.includes(`Space '${SPACE}': merged`));
    assert.ok(line, 'no recovery line for the space');
    assert.match(line, /merged 6 file metadata record\(s\) a 4\.0-5\.6\.1 pull left in /);
    assert.match(line, /1 already complete here/);
    assert.match(line, /1 newer here/);
    assert.match(line, /and dropped the collection/);
    assert.match(line, /\(Q-219\)/);
  });

  it('the drop is audited as the server\'s own operation, with a request id of its own', async () => {
    const e = await auditFor(SPACE, 'file.stray_filemeta.drain');
    assert.ok(e, 'the drop of the stray collection left no audit entry');
    assert.equal(e.ip, 'internal');
    assert.equal(e.method, 'SWEEP');
    assert.match(String(e.requestId), /^internal-/, 'an internal entry reads as one written before request ids existed');
  });

  it('a record whose file has not arrived waits, and is filled once the bytes create the row', async () => {
    await door.coll(LATE, 'filemeta').insertOne(stray(LATE, 'later.md', 30, { description: 'arrives later' }));
    await sweepExpired();
    assert.equal(await stored(LATE, 'later.md'), null);
    assert.equal(await strayCount(LATE), 1, 'a record whose file may still arrive was thrown away');
    await door.coll(LATE, 'files').insertOne(arrivedRow(LATE, 'later.md', { sizeBytes: 5, sha256: 'late' }));
    await sweepExpired();
    assert.equal((await stored(LATE, 'later.md'))?.description, 'arrives later');
    assert.equal(await strayExists(LATE), false);
  });

  it('a record that has waited longer than its window for its file is discarded', async () => {
    const longAgo = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await door.coll(LATE, 'filemeta').insertMany([
      { ...stray(LATE, 'never-came.md', 40, { description: 'waited too long' }), keptSince: longAgo },
      { ...stray(LATE, 'still-due.md', 41, { description: 'still waiting' }), keptSince: new Date().toISOString() },
    ]);
    await sweepExpired();
    assert.equal(await door.coll(LATE, 'filemeta').findOne({ _id: 'never-came.md' }), null,
      'a record past its wait window was kept for ever');
    assert.ok(await door.coll(LATE, 'filemeta').findOne({ _id: 'still-due.md' }), 'a record inside its window was discarded');
    assert.equal(await stored(LATE, 'never-came.md'), null);
    await door.coll(LATE, 'filemeta').deleteMany({});
  });

  it('the work per cycle is bounded, and the next cycle resumes where it stopped', async () => {
    await door.coll(BUDGET, 'files').insertMany(['b1.md', 'b2.md', 'b3.md'].map((id, i) => stampedRow(BUDGET, id, 800 + i)));
    await door.coll(BUDGET, 'filemeta').insertMany(['b1.md', 'b2.md', 'b3.md'].map((id, i) => stray(BUDGET, id, 10 + i, { description: `d ${id}` })));
    await drainStrayFileMeta({ pageSize: 1, maxPages: 2 });
    assert.equal(await strayCount(BUDGET), 1, 'a bounded cycle did not stop after its pages, or did not consume them');
    assert.equal((await stored(BUDGET, 'b3.md'))?.description, undefined);
    await drainStrayFileMeta({ pageSize: 1, maxPages: 2 });
    assert.equal((await stored(BUDGET, 'b3.md'))?.description, 'd b3.md');
    assert.equal(await strayExists(BUDGET), false);
  });

  it('a file deleted while the drain is writing is not brought back', async () => {
    // a-first.md is written before race.md in the same page; its write is held while race.md is deleted. Both are
    // peer rows below the stray's seq, so the unchanged code writes them too and reaches the hold.
    await door.coll(RACE, 'files').insertMany([
      { ...build.filemeta(RACE, 'a-first.md', 5, { author: PEER }) },
      { ...build.filemeta(RACE, 'race.md', 5, { author: PEER }) },
    ]);
    await door.coll(RACE, 'filemeta').insertMany([
      stray(RACE, 'a-first.md', 30, { description: 'first' }),
      stray(RACE, 'race.md', 31, { description: 'for a file about to be deleted' }),
    ]);
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const original = proto.updateOne;
    let reached, release;
    const atHold = new Promise(r => { reached = r; });
    const held = new Promise(r => { release = r; });
    proto.updateOne = async function holding(filter, ...rest) {
      if (this.collectionName === `${RACE}_files` && filter?._id === 'a-first.md') { reached(); await held; }
      return original.call(this, filter, ...rest);
    };
    try {
      const cycle = sweepExpired();
      await within(atHold, 'the held write');
      await door.coll(RACE, 'files').deleteOne({ _id: 'race.md' });
      release();
      await cycle;
    } finally { proto.updateOne = original; }
    assert.equal(await stored(RACE, 'race.md'), null, 'a file deleted during the drain came back with no bytes');
  });

  it('a space that fails keeps its collection, is named in the log, and does not stop the spaces after it', async () => {
    const db = door.mongo.getDb();
    await db.collection(`${BAD}_files`).drop();
    await db.createCollection(`${BAD}_files`, { viewOn: `${BAD}_files_source`, pipeline: [] });
    await door.coll(BAD, 'filemeta').insertOne(stray(BAD, 'x.md', 10, { description: 'cannot land' }));
    await door.coll(SPACE, 'files').insertOne(stampedRow(SPACE, 'after-bad.md', 950));
    await door.coll(SPACE, 'filemeta').insertOne(stray(SPACE, 'after-bad.md', 10, { description: 'reached despite the bad space' }));
    lines.length = 0;
    await sweepExpired();
    assert.equal((await stored(SPACE, 'after-bad.md'))?.description, 'reached despite the bad space',
      'a failing space stopped the drain of the spaces after it');
    assert.equal(await strayExists(BAD), true, 'the failing space lost its collection');
    assert.ok(lines.some(l => l.includes('Stray file-metadata drain') && l.includes(BAD)), 'the failure line does not name the space');
    assert.equal(await door.mongo.getDb().collection('audit_log').findOne({ spaceId: BAD, operation: 'file.stray_filemeta.drain' }), null);
  });

  /*
   * 5.6.x ONLY (vet R1, T7). The writer there REPORTS a counter it could not move (`counterBehind`) and a document the
   * store refused (`storeRefused`) instead of throwing, so the drain has to read both itself — main's drain never sees
   * either shape.
   */
  it('5.6.x: a page whose counter bump failed keeps its stray records and the collection, and the next cycle retries', async () => {
    const db = door.mongo.getDb();
    // A peer-written row below the stray's seq: the stray is accepted by seq, so landing it moves the counter to 30.
    await door.coll(BEHIND, 'files').insertOne({ ...build.filemeta(BEHIND, 'pb.md', 5, { author: PEER }) });
    await door.coll(BEHIND, 'filemeta').insertOne(stray(BEHIND, 'pb.md', 30, { description: 'behind the counter' }));
    await db.collection('ythril_counters').updateOne({ _id: 'stray-probe' }, { $set: { seq: 1 } }, { upsert: true });
    await db.command({ collMod: 'ythril_counters', validationLevel: 'strict', validationAction: 'error',
      validator: { $or: [{ _id: { $ne: BEHIND } }, { seq: { $lte: 10 } }] } });
    try {
      await drainStrayFileMeta();
    } finally {
      await db.command({ collMod: 'ythril_counters', validator: {} });
    }
    assert.equal((await db.collection('ythril_counters').findOne({ _id: BEHIND }))?.seq ?? 0, 0,
      'the counter moved, so the fault was never installed and this row proves nothing');
    assert.equal(await strayExists(BEHIND), true,
      'the collection was dropped although the counter could not be moved past the records it merged');
    assert.equal(await strayCount(BEHIND), 1, 'a stray record whose page left the counter behind was deleted');
    await drainStrayFileMeta();
    assert.equal(await strayExists(BEHIND), false, 'the next cycle, with the counter free, did not finish the drain');
    assert.equal((await stored(BEHIND, 'pb.md'))?.description, 'behind the counter');
  });

  it('5.6.x: a record the store refuses is counted as refused in the recovery line', async () => {
    const db = door.mongo.getDb();
    // Peer-written rows below the strays' seqs, so both records are written by the normal accept (no fill involved).
    await door.coll(REFUSE, 'files').insertMany(['r.md', 'ok.md'].map(id => ({ ...build.filemeta(REFUSE, id, 5, { author: PEER }) })));
    await door.coll(REFUSE, 'filemeta').insertMany([
      stray(REFUSE, 'r.md', 30, { description: 'refuse-me' }),
      stray(REFUSE, 'ok.md', 31, { description: 'fine' }),
    ]);
    // The store refuses the document itself (a validation failure), which 5.6.x's writer reports as `storeRefused`.
    await db.command({ collMod: `${REFUSE}_files`, validationLevel: 'strict', validationAction: 'error',
      validator: { description: { $ne: 'refuse-me' } } });
    lines.length = 0;
    try {
      await drainStrayFileMeta();
    } finally {
      await db.command({ collMod: `${REFUSE}_files`, validator: {} });
    }
    assert.equal((await stored(REFUSE, 'ok.md'))?.description, 'fine', 'the record beside the refused one was not filled');
    assert.equal((await stored(REFUSE, 'r.md'))?.description, undefined, 'the store stored what it refused');
    const line = lines.find(l => l.includes(`Space '${REFUSE}': merged`));
    assert.ok(line, `no recovery line for the space:\n${lines.join('\n')}`);
    assert.match(line, /merged 1 file metadata record\(s\)/, line);
    assert.match(line, /1 refused\)/, `the store's refusal is not counted as refused: ${line}`);
  });
});
