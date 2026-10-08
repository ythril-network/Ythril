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
 *    and each lands at its resolved key;
 *  - the METADATA door, pushed and pulled: a file-meta document whose `_id` is not its canonical key is refused as a shape violation
 *    (counted `rejected`, as every shape refusal is), so a spelling of `victim` is neither stored under that spelling nor
 *    looked up by it against the tombstone held for `victim`; a document keyed canonically is stored;
 *  - the other half of that rule: a file a PERSON uploads here under a spelling (a decomposed name, `a//b`, `./c`) is keyed by the
 *    same canonical key, so its metadata, arriving at a receiver by either door, is accepted and never refused for ever.
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
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { openByteDoor, USER_TOKEN } from './_byte-door.mjs';
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

  describe('the metadata door', () => {
    /** File metadata as the fake peer delivers it: pushed to the batch door, or served to the engine's pull. */
    const DOORS = {
      push: async (docs) => door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token: peerToken(PEER) }),
      pull: async (docs) => { door.state.records[S] = { filemeta: docs }; await door.sync(); return undefined; },
    };
    const meta = (p, seq) => build.filemeta(S, p, seq, { author: PEER_AUTHOR });

    for (const [name, deliver] of Object.entries(DOORS)) {
      for (const spelling of SPELLINGS) {
        it(`${name}: a document keyed "${spelling}" against a held tombstone for victim is not stored, under that spelling or the resolved one`, async () => {
          await holdVictim();
          // A version the tombstone does NOT erase (seq 9 > rowSeq 5): shadowed by nothing, so only the key can refuse it.
          const answer = await deliver([meta(spelling, 9)]);
          assert.deepEqual((await allRows()).map(r => r._id), [],
            `the document keyed "${spelling}" was stored: a peer's spelling of a path is a key nothing reads again, and it slipped past the tombstone held for the path`);
          if (name === 'push') assert.equal(answer.body.filemeta.rejected, 1, `the shape refusal is not counted: ${JSON.stringify(answer.body.filemeta)}`);
        });
      }

      it(`${name}: a document keyed by its canonical key is stored beside a refused spelling`, async () => {
        const answer = await deliver([meta('x/../victim', 1), meta('plain.txt', 1)]);
        assert.deepEqual((await allRows()).map(r => r._id), ['plain.txt'], 'the canonical document was not stored, or the spelling was');
        if (name === 'push') assert.deepEqual([answer.body.filemeta.upserted, answer.body.filemeta.rejected], [1, 1], JSON.stringify(answer.body.filemeta));
      });
    }
  });

  describe('a file this instance writes itself is keyed by the same canonical key', () => {
    /*
     * The receiver's refusal is only half the rule. A row this instance keyed by a SPELLING (`a//b`, a decomposed name from a
     * macOS client) is a row every upgraded peer refuses for ever, so its metadata never replicates — and before the refusal
     * existed it was accepted. The local writer and the peer's doors have to agree on the key, so a file is never refused by
     * the instance that holds the other half of the network.
     */
    const LOCAL_SPELLINGS = [
      ['a decomposed (NFD) name', 'café.txt', 'café.txt'],
      ['an NFD name in a folder', 'docs/café.txt', 'docs/café.txt'],
      ['an empty segment', 'a//b.txt', 'a/b.txt'],
      ['a leading current-directory step', './c.txt', 'c.txt'],
      ['an inner current-directory step', 'd/./e.txt', 'd/e.txt'],
      ['a parent step', 'f/x/../g.txt', 'f/g.txt'],
    ];
    const DELIVER = {
      push: async (docs) => door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token: peerToken(PEER) }),
      pull: async (docs) => { door.state.records[S] = { filemeta: docs }; await door.sync(); return undefined; },
    };

    for (const [what, spelling, key] of LOCAL_SPELLINGS) {
      it(`${what}: a person's upload is stored under the canonical id, and nothing under the spelling`, async () => {
        const res = await postWhole(bytes, { space: S, path: spelling, content: `content of ${key}`, token: USER_TOKEN });
        assert.ok(stored(res), JSON.stringify(res));
        assert.deepEqual((await allRows()).map(r => [r._id, r.path]), [[key, key]],
          `the local upload of ${JSON.stringify(spelling)} did not key its row by the key every other door looks it up by`);
      });

      for (const [door_, deliver] of Object.entries(DELIVER)) {
        it(`${what}: the row's metadata, arriving at a receiver by ${door_}, is accepted, not rejected`, async () => {
          const res = await postWhole(bytes, { space: S, path: spelling, content: `content of ${key}`, token: USER_TOKEN });
          assert.ok(stored(res), JSON.stringify(res));
          const [local] = await allRows();
          assert.ok(local, 'the upload left no row');
          await door.reset();
          const answer = await deliver([build.filemeta(S, local._id, 1, { path: local.path, author: PEER_AUTHOR })]);
          assert.deepEqual((await allRows()).map(r => r._id), [key],
            `the id this instance wrote for ${JSON.stringify(spelling)} is refused by the arrival writer: ${JSON.stringify(answer?.body)}`);
          if (door_ === 'push') assert.deepEqual([answer.body.filemeta.upserted, answer.body.filemeta.rejected], [1, 0], JSON.stringify(answer.body.filemeta));
        });
      }
    }

    it('two spellings of one name are one file: the second upload replaces the first and no second row is made', async () => {
      await postWhole(bytes, { space: S, path: 'café.txt', content: 'first', token: USER_TOKEN });
      await postWhole(bytes, { space: S, path: 'café.txt', content: 'second', token: USER_TOKEN });
      assert.deepEqual((await allRows()).map(r => r._id), ['café.txt']);
      assert.equal(await readLocal('café.txt'), 'second');
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
