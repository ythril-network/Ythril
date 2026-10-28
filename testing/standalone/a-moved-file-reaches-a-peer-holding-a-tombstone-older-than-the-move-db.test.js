/**
 * A file moved away from a path and back reaches a peer that holds the deletion the first move left (bundle-112, Q-460).
 *
 * ## The defect
 *
 * The mover's first move (`a -> b`) tombstones `a` at the version of the row it erased. The second move (`b -> a`) used to re-key the row
 * with the version it already had, so the row that came back to `a` was at the version `a`'s own tombstone names. A peer that held that
 * tombstone refused the arrival (`shadowDecision`: `rowSeq >= seq`), and a peer that then applied the tombstone deleted the row it had
 * just been refused. The moved file never reached it.
 *
 * ## What is asserted
 *
 * The moves are run here, through the cascade, over a row; the row as they leave it at `a`, and the tombstone the first move left there,
 * are then handed to a receiver as a peer sends them (the receiver's own state is emptied first, so it holds the tombstone and none of the
 * mover's rows). The row is pushed through the batch door and is STORED, not shadowed; the tombstone is then delivered through the file
 * tombstone door and the row is KEPT (`recreatedSince`: a newer version by the tombstone's own issuer).
 *
 * ## Seen red
 *
 * On the base (9d5fc992b): the moved row comes back at the tombstone's own version, the push stores nothing, and the delivered tombstone
 * leaves no row.
 *
 * Run: node --test testing/standalone/a-moved-file-reaches-a-peer-holding-a-tombstone-older-than-the-move-db.test.js
 * (requires a prior `npm run build` in server/, a reachable mongod, and a private IPv4 on the host)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken, FAMILIES } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'movedreachespeer';
const KEY = Object.entries(FAMILIES).find(([, f]) => f.coll === 'files')?.[0];
const FIRST_VERSION = 7;

let door, cascade;

const files = () => door.coll(S, 'files');
const row = (id) => files().findOne({ _id: id });

/** Empty the space's records, its tombstones and its files tree: what a receiver that has seen nothing of the mover's rows holds. */
async function emptyTheSpace() {
  for (const part of ['files', 'file_tombstones', 'media_jobs', 'file_hashes']) await door.coll(S, part).deleteMany({});
  fs.rmSync(door.localFilesRoot(S), { recursive: true, force: true });
  fs.mkdirSync(door.localFilesRoot(S), { recursive: true });
}

describe('a moved-back file reaches a peer holding the deletion its first move left (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'movedreachespeer', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    cascade = await import('../../server/dist/files/move-cascade.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); await emptyTheSpace(); });

  it('the row the round trip leaves at a.md is stored by a receiver holding a.md\'s tombstone, and stays when that tombstone is applied', async () => {
    // The mover: a row at a.md at version 7, moved to b.md and back.
    door.writeLocalFile(S, 'a.md', 'the file that goes and comes back');
    await files().insertOne(build.filemeta(S, 'a.md', FIRST_VERSION, { author: PEER_AUTHOR, sizeBytes: 33, tags: ['moved'] }));
    await cascade.moveFileCascade(S, 'a.md', 'b.md');
    await cascade.moveFileCascade(S, 'b.md', 'a.md');
    const sent = await row('a.md');
    assert.ok(sent, 'fixture: the round trip left no row at a.md');
    const tombstone = (await door.coll(S, 'file_tombstones').find({ path: 'a.md', pending: { $exists: false } }).toArray())
      .find(t => t.rowSeq === FIRST_VERSION);
    assert.ok(tombstone, 'fixture: the first move left no published tombstone at a.md naming the erased version');

    // The receiver: it holds that tombstone, as the mover issued it, and none of the mover's rows.
    await emptyTheSpace();
    await door.coll(S, 'file_tombstones').insertOne({
      _id: 'held-a', spaceId: S, path: 'a.md', deletedAt: tombstone.deletedAt, issuer: PEER, rowSeq: tombstone.rowSeq, positionAt: tombstone.deletedAt,
    });

    // What the mover sends: its row at a.md, authored and delivered by itself.
    const arriving = build.filemeta(S, 'a.md', sent.seq, { author: PEER_AUTHOR, sizeBytes: 33, tags: ['moved'], createdAt: sent.createdAt, updatedAt: sent.updatedAt });
    const res = await door.push('/batch-upsert', { [KEY]: [arriving] }, { spaceId: S, token: peerToken(PEER) });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    const stored = await row('a.md');
    assert.ok(stored, `the receiver refused the moved file: it came back at version ${sent.seq}, and the tombstone it holds names ${tombstone.rowSeq}`);
    assert.equal(stored.seq, sent.seq, 'the receiver stored the row at another version than the mover\'s');

    // The tombstone, delivered again by the mover, does not take the row it is older than.
    const tomb = { _id: 'held-a', spaceId: S, path: 'a.md', deletedAt: tombstone.deletedAt, issuer: PEER, rowSeq: tombstone.rowSeq };
    const applied = await door.push('/file-tombstones', { spaceId: S, tombstones: [tomb] }, { spaceId: S, token: peerToken(PEER) });
    assert.equal(applied.code, 200, JSON.stringify(applied.body));
    assert.ok(await row('a.md'), 'applying the tombstone older than the moved file deleted the row it had just stored');
  });
});
