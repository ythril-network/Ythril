/**
 * A path a peer supplies is RESOLVED before anything is looked up by it (bundle-71, Q-404).
 *
 * ## The defect
 *
 * A peer-supplied path reaches this instance's file doors as text: the manifest pull's entries and the upload door's
 * `?path=`. The WRITE is made at the sandbox-resolved path (`x/../victim` is the file `victim`), but every LOOKUP — the
 * held tombstones, the local manifest, the file row's key — was made by the raw text. So a peer that still holds a file this
 * instance deleted brought it back by spelling the path differently: `x/../victim` is not `victim` to the tombstone read,
 * and `./victim` is not either. The same spelling overwrote a local `victim` with a different hash instead of landing beside
 * it as a conflict copy (the local manifest has no entry for `x/../victim`), and left file rows keyed `x/../victim`, which
 * nothing ever reads again.
 *
 * ## The rule (design D5)
 *
 * One resolver turns a peer's path into the key everything is looked up by (`peerFileKey`: the sandbox-resolved path,
 * relative to the space's root). Every arrival door asks the held tombstones, the local manifest and the file rows by THAT
 * key, so a path has one identity however it is spelled. It is derived over the whole set of spellings below, and over every
 * row the doors leave, not over one site.
 *
 * ## What is asserted
 *
 *  - the byte door, for a PEER: an upload of erased bytes at a differently spelled path is answered
 *    `200 { tombstoned: true }` and nothing is written — single and chunked;
 *  - the manifest pull: an entry spelled `x/../victim` against a local `victim` with a different hash lands as a CONFLICT
 *    COPY (the local file is untouched); against a held tombstone for `victim` it is skipped, never downloaded;
 *  - no file row key — and no row `path` — holds a `.` or `..` segment after either door has stored arrivals spelled that way,
 *    and each lands at its resolved key.
 *
 * Run: node --test testing/standalone/a-peer-supplied-file-path-is-resolved-before-it-is-looked-up-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { peerToken } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { openByteDoor } from './_byte-door.mjs';
import { postWhole, postInHalves } from './_byte-door-uploads.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'peerkey';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ERASED = 'the content the owner deleted';
const HELD_AT = '2026-09-01T00:00:05.000Z';
/** Spellings of the SAME file `victim`: a parent step, a current-directory step, and a deeper round trip. */
const SPELLINGS = ['x/../victim', './victim', 'a/b/../../victim'];

let door, bytes;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const allRows = () => door.coll(S, 'files').find({}).toArray();
const downloaded = () => door.state.fileDownloads.map(x => x.path).sort();
const stored = (r) => r.code === 201 || r.code === 202;
const onDisk = (p) => door.localFileExists(S, p);
const readLocal = (p) => fsp.readFile(path.join(door.localFilesRoot(S), p), 'utf8');

/** A published tombstone this instance holds for `victim`: what it erased, by version and by content. */
const holdVictim = (contentHash = sha(ERASED)) => door.coll(S, 'file_tombstones').insertOne({
  _id: 'held-victim', spaceId: S, path: 'victim', deletedAt: HELD_AT, positionAt: HELD_AT, rowSeq: 5, contentHash, issuer: PEER,
});

/** The segments of a key, split both ways a path separator is written. */
const segments = (key) => String(key).split(/[\\/]/);

/**
 * THE rule over the whole set of rows: none keys itself, or names its `path`, with a `.` or `..` segment. Returns the keys,
 * after asserting a floor — an empty set passes every loop written over it.
 */
async function assertNoDotSegmentKeys(floor, why) {
  const rows = await allRows();
  assert.ok(rows.length >= floor, `${why}: the doors left ${rows.length} rows, expected at least ${floor} — the case is not reached`);
  for (const r of rows) {
    for (const [field, value] of [['_id', r._id], ['path', r.path]]) {
      assert.ok(!segments(value).some(s => s === '.' || s === '..'),
        `${why}: a file row's ${field} is ${JSON.stringify(value)} — a spelling of a path, not its key; nothing will ever look it up again`);
    }
  }
  return rows.map(r => r._id).sort();
}

describe('a peer-supplied file path is resolved before it is looked up', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'peerkey', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  describe('the byte door', () => {
    const peer = () => peerToken(PEER);

    for (const spelling of SPELLINGS) {
      it(`a PEER's single upload of erased bytes at "${spelling}" is answered 200 { tombstoned: true } and writes nothing`, async () => {
        await holdVictim();
        const res = await postWhole(bytes, { space: S, path: spelling, content: ERASED, token: peer() });
        assert.deepEqual([res.code, res.body], [200, { tombstoned: true }],
          `the tombstone for victim did not recognise "${spelling}": the deleted file came back through a spelling of its path`);
        assert.equal(onDisk('victim'), false, 'the erased bytes were written at the resolved path');
        assert.deepEqual((await allRows()).map(r => r._id), [], 'a row was written for the arrival');
      });
    }

    it('a PEER\'s chunked upload of erased bytes at "x/../victim" is answered 200 { tombstoned: true } and writes nothing', async () => {
      await holdVictim();
      const { first, last } = await postInHalves(bytes, { space: S, path: 'x/../victim', content: ERASED, token: peer() });
      assert.equal(first.code, 202, `the first half: ${JSON.stringify(first)}`);
      assert.deepEqual([last.code, last.body], [200, { tombstoned: true }]);
      assert.equal(onDisk('victim'), false, 'the erased bytes were assembled at the resolved path and kept');
      assert.deepEqual((await allRows()).map(r => r._id), []);
    });

    it('DIFFERENT bytes at a spelling of the path are stored at the resolved path, and keyed by it', async () => {
      await holdVictim();
      const res = await postWhole(bytes, { space: S, path: 'x/../victim', content: 'bytes that were never deleted', token: peer() });
      assert.ok(stored(res) && res.body.tombstoned === undefined, JSON.stringify(res));
      assert.equal(await readLocal('victim'), 'bytes that were never deleted');
      assert.ok(await row('victim'), 'the stored file has no row at its own path');
    });

    it('no file row key holds a "." or ".." segment after uploads spelled that way, single and chunked', async () => {
      await postWhole(bytes, { space: S, path: 'x/../k1.txt', content: 'one', token: peer() });
      await postWhole(bytes, { space: S, path: './k2.txt', content: 'two', token: peer() });
      await postWhole(bytes, { space: S, path: 'd/./k3.txt', content: 'three', token: peer() });
      await postInHalves(bytes, { space: S, path: 'y/../k4.txt', content: 'four', token: peer() });
      const keys = await assertNoDotSegmentKeys(4, 'the byte door');
      assert.deepEqual(keys, ['d/k3.txt', 'k1.txt', 'k2.txt', 'k4.txt'], 'a file did not land at the key of its resolved path');
    });
  });

  describe('the manifest pull', () => {
    /** The fake peer's manifest, scripted: entries spelled as a peer chooses (the real handler lists only real paths). */
    const advertise = (entries) => {
      door.state.manifest = (_req, res) => res.json({
        spaceId: S,
        manifest: entries.map(({ path: p, content }) => ({ path: p, sha256: sha(content), size: Buffer.byteLength(content), modifiedAt: HELD_AT })),
      });
    };

    for (const spelling of SPELLINGS) {
      it(`an entry "${spelling}" against a local victim with a different hash lands as a CONFLICT COPY and leaves victim untouched`, async () => {
        const LOCAL_V = 'the version this instance holds';
        const REMOTE_V = 'the version the peer holds';
        door.writeLocalFile(S, 'victim', LOCAL_V);
        door.seedPeerFile(S, 'victim', REMOTE_V);
        advertise([{ path: spelling, content: REMOTE_V }]);
        await door.sync();
        assert.ok(downloaded().length > 0, 'the entry was never downloaded — the case is not reached');
        assert.equal(await readLocal('victim'), LOCAL_V,
          `"${spelling}" overwrote the local victim: the local manifest has no entry for that spelling, so it looked like a new file`);
        const conflicts = await door.coll(S, 'conflicts').find({}).toArray();
        assert.equal(conflicts.length, 1, `the differing version did not land as a conflict: ${JSON.stringify(conflicts)}`);
        assert.equal(await readLocal(conflicts[0].conflictPath), REMOTE_V, 'the conflict copy does not hold the peer\'s version');
      });

      it(`an entry "${spelling}" against a held tombstone for victim is skipped — never downloaded, nothing written`, async () => {
        door.seedPeerFile(S, 'victim', ERASED);
        await holdVictim();
        advertise([{ path: spelling, content: ERASED }]);
        await door.sync();
        assert.deepEqual(downloaded(), [], `the pull fetched the erased bytes of victim through the spelling "${spelling}"`);
        assert.equal(onDisk('victim'), false, 'the erased bytes were written at the resolved path');
        assert.deepEqual((await allRows()).map(r => r._id), []);
      });
    }

    it('no file row key holds a "." or ".." segment after entries spelled that way are pulled', async () => {
      door.seedPeerFile(S, 'm1.txt', 'pulled one');
      door.seedPeerFile(S, 'm2.txt', 'pulled two');
      door.seedPeerFile(S, 'd/m3.txt', 'pulled three');
      advertise([{ path: 'x/../m1.txt', content: 'pulled one' }, { path: './m2.txt', content: 'pulled two' }, { path: 'd/./m3.txt', content: 'pulled three' }]);
      await door.sync();
      assert.equal(downloaded().length, 3, `the pull did not fetch the three entries: ${downloaded()}`);
      const keys = await assertNoDotSegmentKeys(3, 'the manifest pull');
      assert.deepEqual(keys, ['d/m3.txt', 'm1.txt', 'm2.txt'], 'a pulled file did not land at the key of its resolved path');
    });
  });
});
