/**
 * The sync manifest names what it could not look at, and the three readers of it (the hash cache, the wire, the restore check) keep
 * that straight (bundle-70, Q-350 b, slice S2).
 *
 * ## The defect
 *
 * `buildFileManifest` walks a space's files. A directory whose `readdir` failed was returned from as "no files"; a file whose `stat`
 * failed was left out with a log line; a file whose hash read failed with an I/O error threw out of the walk and failed the manifest. So
 * to a peer, to the hash-cache prune and to the restore check an unreadable path looked ABSENT: the cache dropped the hash it had for
 * a file that is still there, a peer pulled "its" copy over (or beside) a file this instance holds, and the restore report called a
 * row whose bytes sit in an unreadable directory `row_without_bytes`.
 *
 * ## The rule (design S2; vet security S3/S4, data-integrity D3, integration I5, testing S10)
 *
 *  1. The build names what it could not look at: `{ entries, unreadable, unreadableTruncated }`. `unreadable` holds I/O look failures only:
 *     a `stat` or a hash read that failed with anything but "cannot exist" (ENOENT, ENOTDIR, ENAMETOOLONG, ELOOP), named by the file's
 *     KEY (NFC), and a directory whose `readdir` failed so, named as ITS prefix (the key and a trailing `/`) and not once per file under it.
 *  2. It passes the filters entries pass: an instance-local path (conflict copy, derived tree, schema snapshot) and a legacy spill are not named.
 *  3. At most 1000 are named; past that the list is cut and `unreadableTruncated` is true (and false at exactly 1000).
 *  4. A content verdict (`StoredFileUnreadable`: a foreign key, altered bytes) is NOT an I/O failure and stays out of `unreadable`,
 *     as before, so a peer's good copy of such a path still arrives (as a conflict copy: `file-sync-leaves-a-path-nobody-could-look-at-alone-db`).
 *  5. The hash-cache prune keeps the entry of an unreadable path, and every entry under an unreadable directory; a path that is gone is pruned as ever.
 *  6. The route answers `unreadable` and `unreadableTruncated` next to `manifest`, filtered like the entries, never narrowed by `since`;
 *     a root that cannot be looked at answers `500 file_system_fault` (no `''` entry), a root that is absent answers an empty manifest.
 *  7. The restore check puts an unreadable path (and every row under an unreadable directory) in no class, never `row_without_bytes`.
 *
 * ## How the failures are made
 *
 * Through the `fs/promises` seam (`_path-look-faults.mjs`), because `chmod` does not make a path unreadable on Windows or as root in Docker.
 * Each case asserts its fault fired.
 *
 * ## Seen red
 *
 * Every case that reads `unreadable` fails on the base because the field does not exist (the build returns an array of entries). The cases that
 * also assert today's wrong answer fail on it too: the hash cache lost the entries of the unreadable paths (5), the manifest THREW for a
 * hash read refused with EACCES or vanished with ENOENT (2, 3), the root readdir failure answered `200` with an empty manifest (6), and the
 * restore report listed rows under unreadable paths as `row_without_bytes` (7). The controls (a genuinely gone path, an absent root, a content
 * verdict) say what must not widen.
 *
 * Run: node --test testing/standalone/the-sync-manifest-names-what-it-could-not-look-at-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { underLookFaults } from './_path-look-faults.mjs';

const skip = await mongoSkipReason();

const S = 'unreadmanifest';
const NFC_NAME = 'Café.txt';
const NFD_NAME = NFC_NAME.normalize('NFD');
const NFC_DIR = 'Dossier été';
const NFD_DIR = NFC_DIR.normalize('NFD');
const MAX_UNREADABLE = 1000;
const CONFLICT_COPY = 'notes/a_2026-01-01T00-00-00-000Z_Peer.txt';
const SPILL = `_tmp/results-${randomUUID()}.json`;

let door, root, rights, manifestRoute, buildFileManifest, stored, readDiskAgainstRows;

const put = (rel, content = `bytes of ${rel}`) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

/** The build's answer in whatever shape: the entries, and what it named as unreadable (`undefined` when the build does not say). */
async function build(since, opts) {
  const r = await buildFileManifest(S, since, opts);
  return {
    entries: Array.isArray(r) ? r : r.entries,
    unreadable: Array.isArray(r) ? undefined : r.unreadable,
    truncated: Array.isArray(r) ? undefined : r.unreadableTruncated,
  };
}
const keysOf = (entries) => entries.map(e => e.path).sort();
const named = (a) => {
  assert.ok(Array.isArray(a.unreadable), `the build does not name what it could not look at: unreadable is ${JSON.stringify(a.unreadable)}`);
  return [...a.unreadable].sort();
};

/** The manifest ROUTE through its own handler: the status and the body. */
async function routeGet(query = {}) {
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() { return this; } };
  await manifestRoute({ query: { spaceId: S, ...query }, authToken: { id: 't', name: 'test', rights, peerInstanceId: undefined }, get: () => undefined, headers: {} }, res);
  return res;
}

const keepsDecomposedNames = () => {
  const probe = path.join(root, `probe-${NFD_NAME}`);
  fs.writeFileSync(probe, 'x');
  const kept = fs.readdirSync(root).includes(`probe-${NFD_NAME}`);
  fs.rmSync(probe, { force: true });
  return kept;
};

describe('the sync manifest names what it could not look at', { skip }, () => {
  let keepsNfd = false;
  before(async () => {
    door = await openPushDoor({ suite: 'unreadmanifest', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    root = path.join(process.env['DATA_ROOT'], 'files', S);
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { syncManifestRouter } = await import('../../server/dist/api/sync/manifest.js');
    const m = syncManifestRouter.stack.find(l => l.route?.path === '/manifest' && l.route.methods['get']);
    assert.ok(m, 'no GET /manifest on the sync manifest router - re-anchor this test');
    manifestRoute = m.route.stack.at(-1).handle;
    ({ buildFileManifest } = await import('../../server/dist/files/manifest.js'));
    stored = await import('../../server/dist/files/stored-bytes.js');
    ({ readDiskAgainstRows } = await import('../../server/dist/files/disk-against-rows.js'));
    fs.mkdirSync(root, { recursive: true });
    keepsNfd = keepsDecomposedNames();
  });
  after(async () => {
    for (const k of ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE']) delete process.env[k];
    stored?.resetStoredKeyCacheForTests();
    await door?.close();
  });
  beforeEach(async () => {
    for (const k of ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE']) delete process.env[k];
    stored.resetStoredKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    await door.coll(S, 'file_hashes').deleteMany({});
    await door.coll(S, 'files').deleteMany({});
  });

  describe('what it names (rule 1)', () => {
    it('a file whose stat is refused is named by its key and left out of the entries, the rest is offered', async () => {
      put('notes/a.txt'); put('notes/locked.txt'); put('top.txt');
      const a = await underLookFaults(root, [{ fn: 'stat', match: rel => rel === 'notes/locked.txt' }], () => build());
      assert.deepEqual(keysOf(a.entries), ['notes/a.txt', 'top.txt'], 'an unreadable file is offered, or a readable one is lost');
      assert.deepEqual(named(a), ['notes/locked.txt'], 'the refused file is not named: to a peer it looks absent');
      assert.notEqual(a.truncated, true);
    });

    it('a file whose hash read is refused (EACCES at the open) is named, and does not fail the manifest', async () => {
      put('notes/a.txt'); put('notes/locked.txt');
      const a = await underLookFaults(root, [{ fn: 'open', match: rel => rel === 'notes/locked.txt' }], () => build());
      assert.deepEqual(keysOf(a.entries), ['notes/a.txt']);
      assert.deepEqual(named(a), ['notes/locked.txt']);
    });

    it('a file that is gone since the listing (ENOENT at the stat or at the hash read) is neither offered nor named, and fails nothing', async () => {
      put('a.txt'); put('vanished-at-stat.txt'); put('vanished-at-read.txt');
      const a = await underLookFaults(root, [
        { fn: 'stat', match: rel => rel === 'vanished-at-stat.txt', code: 'ENOENT' },
        { fn: 'open', match: rel => rel === 'vanished-at-read.txt', code: 'ENOENT' },
      ], () => build());
      assert.deepEqual(keysOf(a.entries), ['a.txt']);
      assert.deepEqual(named(a), [], 'a path that cannot exist is not "unreadable": a peer is right to see it as absent');
    });

    for (const code of ['ENOTDIR', 'ENAMETOOLONG', 'ELOOP']) {
      it(`a stat that answers ${code} (the path cannot exist) is not named`, async () => {
        put('a.txt'); put('odd.txt');
        const a = await underLookFaults(root, [{ fn: 'stat', match: rel => rel === 'odd.txt', code }], () => build());
        assert.deepEqual(keysOf(a.entries), ['a.txt']);
        assert.deepEqual(named(a), []);
      });
    }

    it('a directory whose readdir is refused is named as ITS prefix, once, and not per file under it', async () => {
      put('d/in-d.txt'); put('d/sub/deeper.txt'); put('ok/x.txt'); put('z.txt');
      const a = await underLookFaults(root, [
        { fn: 'readdir', match: rel => rel === 'd' },
        { fn: 'stat', match: rel => rel === 'z.txt' },
      ], () => build());
      assert.deepEqual(keysOf(a.entries), ['ok/x.txt'], 'the readable files of the readable directory are offered, nothing under the refused one is invented');
      assert.deepEqual(named(a), ['d/', 'z.txt'], 'a refused directory is one prefix ending in a slash, beside the refused file');
    });

    it('a refused SUBdirectory is named by its own prefix, not its parent\'s', async () => {
      put('d/in-d.txt'); put('d/sub/deeper.txt');
      const a = await underLookFaults(root, [{ fn: 'readdir', match: rel => rel === 'd/sub' }], () => build());
      assert.deepEqual(keysOf(a.entries), ['d/in-d.txt']);
      assert.deepEqual(named(a), ['d/sub/']);
    });
  });

  describe('what it names in the key spelling (rule 1)', () => {
    it('a file and a directory the disk keeps decomposed are named by their NFC key', async (t) => {
      if (!keepsNfd) { t.skip('this file system normalises a decomposed name on write: the fixture cannot exist here'); return; }
      put(NFD_NAME); put(path.join(NFD_DIR, 'inside.txt')); put('plain.txt');
      const a = await underLookFaults(root, [
        { fn: 'stat', match: rel => rel === NFD_NAME },
        { fn: 'readdir', match: rel => rel === NFD_DIR },
      ], () => build());
      assert.deepEqual(keysOf(a.entries), ['plain.txt']);
      assert.deepEqual(named(a), [NFC_NAME, `${NFC_DIR}/`].sort(), 'a path is named in the spelling the disk keeps, which a peer cannot match against a key');
    });
  });

  describe('what it does not name (rules 2 and 4)', () => {
    it('a legacy spill is not named, as it is not offered', async () => {
      put('a.txt'); put(SPILL, '{"kind":"recall-results"}');
      const a = await underLookFaults(root, [{ fn: 'stat', match: rel => rel === SPILL }], () => build());
      assert.deepEqual(keysOf(a.entries), ['a.txt']);
      assert.deepEqual(named(a), [], 'a spill is one caller\'s search result: naming it tells every peer a path nobody should have');
    });

    it('a content verdict (a file under a foreign key) is not an I/O failure: it stays out of `unreadable`, as before', async () => {
      put('a.txt');
      const keyA = randomBytes(32).toString('base64');
      process.env['YTHRIL_MASTER_KEY'] = keyA;
      stored.resetStoredKeyCacheForTests();
      await stored.writeStored(path.join(root, 'locked.bin'), randomBytes(64));
      assert.equal(await stored.isStoredEncrypted(path.join(root, 'locked.bin')), true, 'fixture: the file is not in the encrypted format');
      process.env['YTHRIL_MASTER_KEY'] = randomBytes(32).toString('base64');
      stored.resetStoredKeyCacheForTests();
      const a = await build();
      assert.ok(!keysOf(a.entries).includes('locked.bin'), 'a file this instance cannot decode is offered');
      assert.deepEqual(named(a), [], 'a content verdict was named unreadable: the peer\'s good copy would then be refused instead of landing beside it');
    });
  });

  describe('the cap (rule 3)', () => {
    const many = (n) => { for (let i = 0; i < n; i++) put(`many/f${String(i).padStart(4, '0')}.txt`, 'x'); };
    const refuseMany = [{ fn: 'stat', match: rel => /^many\/f\d{4}\.txt$/.test(rel) }];

    it('1001 refused files are cut at 1000 and the cut is said', async () => {
      many(MAX_UNREADABLE + 1); put('ok.txt');
      const a = await underLookFaults(root, refuseMany, () => build());
      assert.deepEqual(keysOf(a.entries), ['ok.txt']);
      assert.equal(named(a).length, MAX_UNREADABLE, 'the list is not bounded: one broken mount makes a manifest of every path');
      assert.equal(a.truncated, true, 'a cut list that does not say it is cut reads as the whole list');
    });

    it('exactly 1000 is not a cut', async () => {
      many(MAX_UNREADABLE);
      const a = await underLookFaults(root, refuseMany, () => build());
      assert.equal(named(a).length, MAX_UNREADABLE);
      assert.notEqual(a.truncated, true, 'a list of exactly the cap was reported as cut');
    });
  });

  describe('the hash cache (rule 5)', () => {
    it('a prune keeps the entry of an unreadable path and of everything under an unreadable directory, and drops a path that is gone', async () => {
      put('a.txt'); put('d/b.txt'); put('c.txt'); put('e/f.txt');
      await build();
      const cached = async () => (await door.coll(S, 'file_hashes').find({}).toArray()).map(d => d._id).sort();
      assert.deepEqual(await cached(), ['a.txt', 'c.txt', 'd/b.txt', 'e/f.txt'], 'fixture: the first build did not cache every file');
      fs.rmSync(path.join(root, 'c.txt'));
      await underLookFaults(root, [
        { fn: 'stat', match: rel => rel === 'a.txt' },
        { fn: 'readdir', match: rel => rel === 'd' },
      ], () => build());
      assert.deepEqual(await cached(), ['a.txt', 'd/b.txt', 'e/f.txt'],
        'the prune read a path it could not look at as a path that is gone and dropped its hash (c.txt, really gone, must be the only one dropped)');
    });
  });

  describe('the route (rule 6)', () => {
    it('answers `unreadable` and `unreadableTruncated` beside `manifest`, and the entries keep their four wire keys', async () => {
      put('a.txt'); put('locked.txt');
      const res = await underLookFaults(root, [{ fn: 'stat', match: rel => rel === 'locked.txt' }], () => routeGet());
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.manifest.map(e => e.path), ['a.txt']);
      assert.deepEqual(Object.keys(res.body.manifest[0]).sort(), ['modifiedAt', 'path', 'sha256', 'size']);
      assert.deepEqual(res.body.unreadable, ['locked.txt'], `the answer does not name what it could not look at: ${JSON.stringify(res.body)}`);
      assert.notEqual(res.body.unreadableTruncated, true);
    });

    it('`since` narrows the entries and never the unreadable list', async () => {
      put('a.txt'); put('locked.txt');
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const res = await underLookFaults(root, [{ fn: 'stat', match: rel => rel === 'locked.txt' }], () => routeGet({ since: future }));
      assert.equal(res.code, 200);
      assert.deepEqual(res.body.manifest, [], 'fixture: since did not narrow the entries');
      assert.deepEqual(res.body.unreadable, ['locked.txt'], 'an incremental manifest forgot a path this instance cannot look at: the peer would push to it');
    });

    it('an instance-local path (derived tree, conflict copy) and a spill are not named on the wire', async () => {
      put('a.txt'); put('_converted/a.txt.md'); put(CONFLICT_COPY); put(SPILL, '{}');
      const res = await underLookFaults(root, [{ fn: 'stat', match: rel => rel === '_converted/a.txt.md' || rel === CONFLICT_COPY || rel === SPILL }], () => routeGet());
      assert.equal(res.code, 200);
      assert.deepEqual(res.body.unreadable, [], `the wire names paths no peer is ever offered: ${JSON.stringify(res.body.unreadable)}`);
    });

    it('a space root that cannot be looked at answers 500 file_system_fault, naming no path and no entry', async () => {
      put('a.txt');
      const res = await underLookFaults(root, [{ fn: 'readdir', match: rel => rel === '' }], () => routeGet());
      assert.equal(res.code, 500, `an unreadable space root answered ${res.code} ${JSON.stringify(res.body)}: an empty space to every peer`);
      assert.equal(res.body.code, 'file_system_fault');
      assert.equal(res.body.retryable, false);
      const wire = JSON.stringify(res.body);
      for (const form of [process.env['DATA_ROOT'], process.env['DATA_ROOT'].replaceAll('\\', '\\\\'), process.env['DATA_ROOT'].replaceAll('\\', '/'), 'EACCES']) {
        assert.ok(!wire.includes(form), `the answer carries the data root or the errno: ${wire}`);
      }
    });

    it('a space root that is absent answers an empty manifest and names nothing (control)', async () => {
      fs.rmSync(root, { recursive: true, force: true });
      const res = await routeGet();
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.manifest, []);
      assert.deepEqual(res.body.unreadable, [], 'an absent root was named unreadable');
    });
  });

  describe('the restore check (rule 7)', () => {
    const row = (id, over = {}) => ({
      _id: id, spaceId: S, path: id, description: '', tags: [], sha256: 'a'.repeat(64), sizeBytes: 3,
      author: { instanceId: 'me', instanceLabel: 'Me' }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: 1,
      embeddingStatus: 'done', ...over,
    });
    const classes = () => readDiskAgainstRows(S, (fn) => fn());

    it('a row whose file or directory cannot be looked at is in no class; a row whose file is really gone is row_without_bytes', async () => {
      put('here.txt'); put('d/inside.txt'); put('locked.txt');
      await door.coll(S, 'files').insertMany([row('here.txt'), row('locked.txt'), row('d/inside.txt'), row('gone.txt')]);
      // `here.txt` carries a hash that is not its bytes' (a stale_row), the same answer before and after; what is asserted is where the
      // unreadable ones are NOT, and that the really gone one is still found.
      const c = await underLookFaults(root, [
        { fn: 'stat', match: rel => rel === 'locked.txt' },
        { fn: 'readdir', match: rel => rel === 'd' },
      ], () => classes());
      assert.deepEqual(c.row_without_bytes, ['gone.txt'],
        'the restore report called the rows of an unreadable file and an unreadable directory "no bytes": it would then ask for them to be restored over bytes that are there');
      for (const [cls, paths] of Object.entries(c)) {
        assert.ok(!paths.includes('locked.txt') && !paths.includes('d/inside.txt'), `an unreadable path is in class ${cls}`);
      }
    });
  });
});
