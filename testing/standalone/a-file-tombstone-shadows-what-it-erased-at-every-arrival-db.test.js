/**
 * A held file tombstone shadows what it ERASED — by version for arriving metadata, by content for arriving bytes — at EVERY
 * door a file's metadata or bytes arrive by, and shadows nothing it did not (bundle-51 Q-229).
 *
 * ## The defect
 *
 * A peer that still held a deleted file's metadata, or its bytes, re-delivered it: the metadata batch wrote the row back, the
 * manifest pull downloaded the bytes, the upload door stored them — and the file the owner deleted was live again, with a
 * tombstone beside it saying it was gone. Only the stray-metadata drain had asked the tombstone anything, and by the path alone.
 *
 * ## The rule (`shadowDecision`, `files/tombstones.ts`; its pure table is `a-file-tombstone-shadows-by-version-then-content`)
 *
 *   metadata:  shadowed when a held tombstone for the path has `rowSeq >= the arriving seq`; a HIGHER seq is a newer version,
 *              is admitted, and removes the held tombstones for its path. No `rowSeq` (a tombstone held from before the
 *              release): shadows no metadata.
 *   bytes:     shadowed when a held tombstone for the path has a `contentHash` equal to the arriving hash and no live row at
 *              the path is newer than it. Identical bytes re-created as a newer version arrive with their metadata first
 *              and pass. No `contentHash` (legacy): shadows no bytes.
 *
 * ## What this file holds that the pure table cannot
 *
 * That the rule is asked at each SITE, and answered the way each site's contract needs:
 *
 *  - the metadata batch (`POST /api/sync/batch-upsert`), the pull of the metadata family, and the stray drain's fill: a shadowed
 *    version is refused (the batch answer counts it as `filemeta.tombstoned`, and nothing is written); a newer version lands and
 *    removes the held tombstone; the drain discards a stray record the tombstone covers and keeps one that is newer, waiting for
 *    its file;
 *  - the manifest pull: it does not DOWNLOAD bytes whose hash equals a held tombstone's `contentHash`, and downloads bytes that
 *    differ, a re-created newer version, and a legacy tombstone's path;
 *  - the byte door, for a PEER's arrival only: single and chunked, answered **200 `{ tombstoned: true }`** and storing nothing —
 *    a 4xx would be read by an older sender as a failure and the whole file re-uploaded every cycle. A person's re-upload of the
 *    same bytes is a new authored version and ALWAYS succeeds.
 *
 * Run: node --test testing/standalone/a-file-tombstone-shadows-what-it-erased-at-every-arrival-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { openByteDoor, USER_TOKEN } from './_byte-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'ftsh';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const DELETED = 'the content the owner deleted';
const HELD_AT = '2026-09-01T00:00:05.000Z';
const STAMPED_AT = '2025-01-01T00:00:00.000Z';

let door, bytes, drainStrayFileMeta, LOCAL;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const heldFor = (p) => door.coll(S, 'file_tombstones').findOne({ path: p });
const stray = (id) => door.coll(S, 'filemeta').findOne({ _id: id });

/** A published file tombstone this instance holds: `rowSeq` and `contentHash` are what it knows of what it erased. */
const hold = (p, { rowSeq, contentHash, issuer } = {}) => door.coll(S, 'file_tombstones').insertOne({
  _id: `held-${p}`, spaceId: S, path: p, deletedAt: HELD_AT, positionAt: HELD_AT,
  ...(rowSeq !== undefined ? { rowSeq } : {}), ...(contentHash !== undefined ? { contentHash } : {}),
  ...(issuer !== undefined ? { issuer } : {}),
});
const meta = (p, seq, extra = {}) => build.filemeta(S, p, seq, { author: PEER_AUTHOR, ...extra });

/** Deliver file metadata as the fake peer: by batch-upsert on the push door, or served to the engine's pull. */
const DOORS = {
  push: { async deliver(docs) { return door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token: peerToken(PEER) }); } },
  pull: { async deliver(docs) { door.state.records[S] = { filemeta: docs }; await door.sync(); return undefined; } },
};

describe('a held file tombstone shadows what it erased, at every arrival', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'ftshadow', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
    ({ drainStrayFileMeta } = await import('../../server/dist/sync/stray-filemeta-drain.js'));
    LOCAL = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await door.coll(S, 'filemeta').deleteMany({});
  });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(`${name}: arriving file metadata`, () => {
      it('is shadowed at or below the held rowSeq and admitted above it; a newer version removes the held tombstone', async () => {
        await hold('m8.txt', { rowSeq: 10 });
        await hold('m10.txt', { rowSeq: 10 });
        await hold('m11.txt', { rowSeq: 10 });
        await hold('mleg.txt');                    // legacy: no rowSeq, no hash
        const answer = await d.deliver([meta('m8.txt', 8), meta('m10.txt', 10), meta('m11.txt', 11), meta('mleg.txt', 1), meta('mnone.txt', 1)]);
        const present = {};
        for (const p of ['m8.txt', 'm10.txt', 'm11.txt', 'mleg.txt', 'mnone.txt']) present[p] = (await row(p)) !== null;
        assert.deepEqual(present, { 'm8.txt': false, 'm10.txt': false, 'm11.txt': true, 'mleg.txt': true, 'mnone.txt': true },
          'metadata of a version the tombstone erased came back (or a newer version, or a legacy tombstone\'s path, was refused)');
        assert.equal(await heldFor('m11.txt'), null, 'the newer version was admitted but the tombstone for its path was left standing');
        assert.ok(await heldFor('m8.txt') && await heldFor('m10.txt'), 'a tombstone was removed by an arrival it shadowed');
        if (name === 'push') {
          assert.equal(answer.body.filemeta.tombstoned, 2, `the batch answer does not count the shadowed versions: ${JSON.stringify(answer.body.filemeta)}`);
          assert.equal(answer.body.filemeta.upserted, 3, JSON.stringify(answer.body.filemeta));
        }
      });

      it('a tombstone another instance planted for the path does not refuse the version its proven author delivers', async () => {
        // The pre-ship finding: a peer stored a deletion of a path nobody held, at a high version, and every later file at
        // that path was refused. The record rule (`heldTombstoneRefuses`) is now asked here too: the deliverer is the author.
        await hold('planted.txt', { rowSeq: 1_000_000, issuer: 'some-other-instance' });
        await hold('own.txt', { rowSeq: 1_000_000, issuer: PEER });
        const answer = await d.deliver([meta('planted.txt', 3), meta('own.txt', 3)]);
        assert.ok(await row('planted.txt'), 'another instance\'s tombstone refused the version its proven author delivered');
        assert.equal(await row('own.txt'), null, 'the author\'s own deletion stopped refusing the version it erased');
        if (name === 'push') assert.equal(answer.body.filemeta.tombstoned, 1, JSON.stringify(answer.body.filemeta));
      });
    });
  }

  describe('the stray drain\'s fill', () => {
    /** A row this instance made by default (authored here, at a seq it stamped): the kind a fill is for. */
    const receiverMade = (p) => build.filemeta(S, p, 900, { author: LOCAL, createdAt: STAMPED_AT, updatedAt: STAMPED_AT });
    const strayOf = (p, seq, extra = {}) => ({ ...build.filemeta(S, p, seq, { author: PEER_AUTHOR }), sizeBytes: 999, sha256: 'sender-hash', ...extra });

    it('does not fill a row from a version the tombstone erased, fills from a newer one, and settles a stray record by version', async () => {
      await door.coll(S, 'files').insertMany([receiverMade('fill-old.txt'), receiverMade('fill-new.txt')]);
      for (const p of ['fill-old.txt', 'fill-new.txt', 'fill-gone.txt', 'fill-wait.txt']) await hold(p, { rowSeq: 9 });
      await hold('fill-legacy.txt');
      await door.coll(S, 'filemeta').insertMany([
        strayOf('fill-old.txt', 5, { description: 'the erased version\'s text' }),
        strayOf('fill-new.txt', 12, { description: 'the newer version\'s text' }),
        strayOf('fill-gone.txt', 5, { description: 'for a file with no row, erased' }),
        strayOf('fill-wait.txt', 12, { description: 'for a file with no row yet, newer' }),
        strayOf('fill-legacy.txt', 3, { description: 'for a file with no row, a legacy tombstone' }),
      ]);
      await drainStrayFileMeta();
      assert.equal((await row('fill-old.txt'))?.description, undefined,
        'the drain filled a row from a metadata version a held tombstone erased');
      assert.equal((await row('fill-new.txt'))?.description, 'the newer version\'s text', 'a NEWER version was refused by the tombstone');
      assert.equal(await stray('fill-gone.txt'), null, 'a stray record for an erased version with no file waits for ever');
      assert.ok(await stray('fill-wait.txt'),
        'a stray record NEWER than the tombstone was discarded as "the file was deleted": its file may still arrive');
      assert.equal(await stray('fill-legacy.txt'), null, 'a legacy tombstone (no rowSeq) no longer discards by path, which is what it did');
      for (const p of ['fill-gone.txt', 'fill-wait.txt']) assert.equal(await row(p), null, `${p}: the drain created a row (it never creates one)`);
    });
  });

  describe('the manifest pull', () => {
    const bytesOf = { held: 'bytes that were deleted', other: 'different bytes at the path', newer: 'bytes re-created later', legacy: 'bytes under a legacy tombstone' };
    beforeEach(() => {
      for (const [k, v] of Object.entries(bytesOf)) door.seedPeerFile(S, `m-${k}.bin`, v);
    });

    it('does not download bytes a held tombstone erased, and downloads different bytes, a newer version\'s and a legacy path', async () => {
      await hold('m-held.bin', { rowSeq: 5, contentHash: sha(bytesOf.held) });
      await hold('m-other.bin', { rowSeq: 5, contentHash: sha('what was deleted was something else') });
      await hold('m-newer.bin', { rowSeq: 5, contentHash: sha(bytesOf.newer) });
      await hold('m-legacy.bin');
      // The newer version's metadata arrived first: a live row at a seq above the tombstone's.
      await door.coll(S, 'files').insertOne(meta('m-newer.bin', 20, { sizeBytes: bytesOf.newer.length, sha256: sha(bytesOf.newer) }));
      await door.sync();
      const downloaded = door.state.fileDownloads.map(x => x.path).sort();
      assert.deepEqual(downloaded, ['m-legacy.bin', 'm-newer.bin', 'm-other.bin'],
        `the manifest pull downloaded [${downloaded}]: bytes a held tombstone erased are fetched again on every cycle`);
      assert.ok(!door.localFileExists(S, 'm-held.bin'), 'the erased bytes are on disk');
      for (const k of ['other', 'newer', 'legacy']) assert.ok(door.localFileExists(S, `m-${k}.bin`), `m-${k}.bin was not stored`);
    });
  });

  describe('the byte door', () => {
    const single = (p, token, content = DELETED) => bytes.post({ space: S, path: p, bytes: Buffer.from(content), token });
    const chunked = async (p, token, content = DELETED) => {
      const b = Buffer.from(content);
      const mid = Math.floor(b.length / 2);
      const first = await bytes.post({ space: S, path: p, bytes: b.subarray(0, mid), token, range: `bytes 0-${mid - 1}/${b.length}` });
      const last = await bytes.post({ space: S, path: p, bytes: b.subarray(mid), token, range: `bytes ${mid}-${b.length - 1}/${b.length}` });
      return { first, last };
    };
    const nothingStored = async (p) => ({ onDisk: door.localFileExists(S, p), row: (await row(p)) !== null });

    it('a PEER\'s single upload of the deleted bytes is answered 200 { tombstoned: true } and stores nothing', async () => {
      await hold('b-single.txt', { rowSeq: 5, contentHash: sha(DELETED) });
      const res = await single('b-single.txt', peerToken(PEER));
      assert.deepEqual([res.code, res.body], [200, { tombstoned: true }],
        'an arrival of deleted bytes is stored, or refused with a status an older sender re-uploads on for ever');
      assert.deepEqual(await nothingStored('b-single.txt'), { onDisk: false, row: false });
    });

    it('a PEER\'s chunked upload of the deleted bytes is answered 200 { tombstoned: true } at assembly, and the assembled blob is removed', async () => {
      await hold('b-chunked.txt', { rowSeq: 5, contentHash: sha(DELETED) });
      const { first, last } = await chunked('b-chunked.txt', peerToken(PEER));
      assert.equal(first.code, 202, `the first chunk: ${JSON.stringify(first)}`);
      assert.deepEqual([last.code, last.body], [200, { tombstoned: true }]);
      assert.deepEqual(await nothingStored('b-chunked.txt'), { onDisk: false, row: false });
    });

    it('a PERSON re-uploading the same bytes always succeeds, single and chunked', async () => {
      await hold('u-single.txt', { rowSeq: 5, contentHash: sha(DELETED) });
      await hold('u-chunked.txt', { rowSeq: 5, contentHash: sha(DELETED) });
      const one = await single('u-single.txt', USER_TOKEN);
      assert.ok([201, 202].includes(one.code) && one.body.tombstoned === undefined, `a person's upload was refused: ${JSON.stringify(one)}`);
      const { last } = await chunked('u-chunked.txt', USER_TOKEN);
      assert.ok([201, 202].includes(last.code) && last.body.tombstoned === undefined, `a person's chunked upload was refused: ${JSON.stringify(last)}`);
      assert.deepEqual([await nothingStored('u-single.txt'), await nothingStored('u-chunked.txt')],
        [{ onDisk: true, row: true }, { onDisk: true, row: true }]);
    });

    it('a PEER\'s upload of DIFFERENT bytes at the path is stored (the control)', async () => {
      await hold('b-other.txt', { rowSeq: 5, contentHash: sha(DELETED) });
      const res = await single('b-other.txt', peerToken(PEER), 'not what was deleted');
      assert.ok([201, 202].includes(res.code) && res.body.tombstoned === undefined, JSON.stringify(res));
      assert.deepEqual(await nothingStored('b-other.txt'), { onDisk: true, row: true });
    });

    it('a legacy tombstone (no rowSeq, no hash) shadows no bytes', async () => {
      await hold('b-legacy.txt');
      const res = await single('b-legacy.txt', peerToken(PEER));
      assert.ok([201, 202].includes(res.code) && res.body.tombstoned === undefined, JSON.stringify(res));
      assert.deepEqual(await nothingStored('b-legacy.txt'), { onDisk: true, row: true });
    });

    it('identical bytes re-created as a NEWER version are admitted: a live row above the tombstone\'s rowSeq', async () => {
      await hold('b-newer.txt', { rowSeq: 5, contentHash: sha(DELETED) });
      await door.coll(S, 'files').insertOne(meta('b-newer.txt', 20, { sizeBytes: DELETED.length, sha256: sha(DELETED) }));
      const res = await single('b-newer.txt', peerToken(PEER));
      assert.ok([201, 202].includes(res.code) && res.body.tombstoned === undefined, `a re-created newer version was refused: ${JSON.stringify(res)}`);
      assert.ok(door.localFileExists(S, 'b-newer.txt'));
    });

    it('identical bytes whose newer metadata arrives FIRST (a higher seq through the batch) are admitted', async () => {
      await hold('b-first.txt', { rowSeq: 5, contentHash: sha(DELETED) });
      const batch = await door.push('/batch-upsert', { filemeta: [meta('b-first.txt', 20)] }, { spaceId: S, token: peerToken(PEER) });
      assert.equal(batch.body.filemeta.upserted, 1, JSON.stringify(batch.body.filemeta));
      const res = await single('b-first.txt', peerToken(PEER));
      assert.ok([201, 202].includes(res.code) && res.body.tombstoned === undefined, `the newer version's bytes were refused: ${JSON.stringify(res)}`);
      assert.ok(door.localFileExists(S, 'b-first.txt'));
    });
  });
});
