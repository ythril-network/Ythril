/**
 * Bytes that arrive for a file move the row's POSITION, never its version (bundle-255, Q-725; plan `design-final.md` item 5; board answer
 * `a89cd611`: "It moves the row's position, not its version, so it does not outrank the publisher's metadata").
 *
 * ## The defect
 *
 * `recordArrivedFile` (the one writer of a file row's size and hash when a peer's bytes land, `files/file-meta.ts`) wrote its row with no
 * position in either branch: a row it created has no `pos` at all (and never pages to a peer or a client), and a row it updated keeps its
 * old one, so a reader paging by position never learns that the file's size and hash changed. Authored writes take a position; an arrival
 * must too, for a reader that lists changes by position to hear of it.
 *
 * ## The rule
 *
 * A byte arrival is written under the arrival's position stamp (`withLandingStamp(arrivalRow(row.seq))`: a position, the version the
 * position was taken for, nothing else):
 *
 *  1. it takes a NEW `pos` above everything stamped before it, on a row it creates and on a row it updates;
 *  2. it keeps `seq` and `updatedAt` as they were (an arrival is not an authored write, Q-143), and `posAtSeq` equals `seq` (the position
 *     repair re-stamps a row where they differ, so a stamp that left them apart would be re-positioned at every boot);
 *  3. it sets no `writtenHere` (a mesh network pushes only rows this instance wrote, `sync/push-selection.ts`);
 *  4. an IDENTICAL arrival (same `sha256` and `sizeBytes` as the live row) writes nothing and takes no position, so a retried pull emits
 *     nothing and a feed does not repeat the file;
 *  5. different bytes again move the position again;
 *  6. a peer paging this instance by position is re-offered the row after an arrival, with its `seq` unchanged and no `pos` on the wire.
 *
 * Database `ythril_harness_qarrival`.
 *
 * Red on d9e2738d: the created row has no `pos`; the updated row keeps the old one.
 *
 * Not built here, left for implement (reported): a case in `testing/sync` that a second instance pulling the row converges with no extra
 * byte transfer. That suite runs a two-instance stack and has no meter on bytes moved; the proof needs one built.
 *
 * Run: node --test testing/standalone/a-byte-arrival-takes-a-position-not-a-version-db.test.js
 * (requires the harness Mongo and a prior `npm run build -w server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'qarrival';
const PEER = Object.freeze({ instanceId: 'arrival-peer', instanceLabel: 'Arrival peer' });
const SHA = (c) => c.repeat(64);
const PEER_STAMP = Object.freeze({ seq: 7, updatedAt: '2026-09-01T00:00:00.000Z' });

let door, meta;
const rows = () => door.coll(S, 'files');
const rowOf = (id) => rows().findOne({ _id: id });

/** The highest position any row of the space holds. */
async function head() {
  return (await rows().find({ pos: { $type: 'number' } }).sort({ pos: -1 }).limit(1).next())?.pos ?? 0;
}

/** A file as the publisher's metadata left it: version 7, positioned at its landing (version 7), not written here. */
async function peerAuthored(id, extra = {}) {
  await rows().insertOne({ _id: id, spaceId: S, path: id, tags: ['t'], author: PEER, deliveredBy: PEER.instanceId, createdAt: PEER_STAMP.updatedAt,
    ...PEER_STAMP, pos: 7, posAtSeq: 7, sizeBytes: 12, ...extra });
}

describe('a byte arrival takes a position, not a version (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'qarrival', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    meta = await import('../../server/dist/files/file-meta.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await rows().deleteMany({}); });

  it('a row the arrival CREATES carries a position above everything before it, version 0 at position-of-0, and no writtenHere', async () => {
    await meta.upsertFileMeta(S, 'before.md', 5);
    const top = await head();
    await meta.recordArrivedFile(S, 'new/arrived.bin', 40, SHA('a'), PEER);
    const row = await rowOf('new/arrived.bin');
    assert.equal(row.seq, 0);
    assert.equal(typeof row.pos, 'number', `the created row has no position (${JSON.stringify(row)}): it never pages to a peer or a client`);
    assert.ok(row.pos > top, `its position ${row.pos} is not above ${top}`);
    assert.equal(row.posAtSeq, 0, `posAtSeq ${row.posAtSeq} is not the version 0 the position was taken for`);
    assert.notEqual(row.writtenHere, true, 'the arrival marked the row written here');
    assert.equal(row.sizeBytes, 40);
    assert.equal(row.sha256, SHA('a'));
  });

  it('a row the arrival UPDATES moves its position and keeps its version, updatedAt and author; posAtSeq equals seq; no writtenHere', async () => {
    await peerAuthored('known.md');
    await meta.upsertFileMeta(S, 'other.md', 5);
    const top = await head();
    await meta.recordArrivedFile(S, 'known.md', 40, SHA('b'), PEER);
    const row = await rowOf('known.md');
    assert.equal(typeof row.pos, 'number');
    assert.ok(row.pos > top && row.pos > 7, `its position ${row.pos} did not move above ${top} (it was 7): a reader paging by position never hears the file changed`);
    assert.equal(row.seq, PEER_STAMP.seq, `the arrival changed the version to ${row.seq}: the publisher's next edit would be skipped`);
    assert.equal(row.updatedAt, PEER_STAMP.updatedAt);
    assert.deepEqual(row.author, PEER);
    assert.equal(row.posAtSeq, row.seq, `posAtSeq ${row.posAtSeq} is not the version ${row.seq}: the position repair would re-stamp this row at every boot`);
    assert.notEqual(row.writtenHere, true, 'the arrival marked the row written here');
    assert.equal(row.sizeBytes, 40);
    assert.equal(row.sha256, SHA('b'));
  });

  it('a row this instance authored takes the arrival the same way: new position, same version', async () => {
    await meta.upsertFileMeta(S, 'mine.md', 12, { tags: ['local'] });
    const before = await rowOf('mine.md');
    await meta.upsertFileMeta(S, 'other.md', 5);
    const top = await head();
    await meta.recordArrivedFile(S, 'mine.md', 40, SHA('c'), PEER);
    const row = await rowOf('mine.md');
    assert.ok(row.pos > top, `the position ${row.pos} did not move above ${top}`);
    assert.equal(row.seq, before.seq);
    assert.equal(row.updatedAt, before.updatedAt);
    assert.equal(row.posAtSeq, row.seq);
  });

  it('an identical arrival writes nothing and takes no position; different bytes move it again', async () => {
    await peerAuthored('retry.md');
    await meta.recordArrivedFile(S, 'retry.md', 40, SHA('d'), PEER);
    const first = await rowOf('retry.md');
    assert.ok(first.pos > 7, `the first arrival did not move the position (${first.pos}, was 7)`);
    const top = await head();
    await meta.recordArrivedFile(S, 'retry.md', 40, SHA('d'), PEER);
    assert.deepEqual(await rowOf('retry.md'), first, 'an identical arrival rewrote the row: a retried pull emits a change every time');
    assert.equal(await head(), top, 'an identical arrival took a position');
    await meta.recordArrivedFile(S, 'retry.md', 41, SHA('e'), PEER);
    const second = await rowOf('retry.md');
    assert.ok(second.pos > first.pos, 'different bytes did not move the position again');
    assert.equal(second.seq, first.seq);
  });

  it('a peer paging this instance by position is re-offered the row after an arrival: its seq unchanged, no pos on the wire', async () => {
    await peerAuthored('offered.md');
    await meta.recordArrivedFile(S, 'offered.md', 40, SHA('f'), PEER);
    const page = await door.pull('/filemeta', { spaceId: S, afterPos: '7' });
    const offered = Object.values(page ?? {}).flat().filter(x => x && typeof x === 'object').find(x => x._id === 'offered.md');
    assert.ok(offered, `the row was not re-offered to a peer paging from its old position: ${JSON.stringify(page)}`);
    assert.equal(offered.seq, PEER_STAMP.seq);
    assert.equal(offered.pos, undefined, 'a position is local and was sent on the wire');
    assert.equal(offered.posAtSeq, undefined, 'posAtSeq is local and was sent on the wire');
  });
});
