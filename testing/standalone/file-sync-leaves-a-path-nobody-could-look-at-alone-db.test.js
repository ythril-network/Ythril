/**
 * File sync leaves a path alone that this instance could not look at, and one the peer says it could not (bundle-70, Q-350 b, slice S2).
 *
 * ## The defect
 *
 * File sync decides by manifests. This instance's manifest left out a file or a directory it could not read, so to the pull it was
 * "a path this side lacks": the peer's copy was fetched and written beside the file this instance holds (a conflict copy), or over it.
 * The peer's manifest had the same hole, so the push uploaded to a path the peer holds and cannot read; the peer's upload door
 * answered that, a refusal about THE PATH, and the sender read any status that is not about the bytes as "try again next cycle" and sent
 * the whole file again on every cycle for as long as the path stays unreadable.
 *
 * ## The rule (design S2; vet security S3, reliability R7, data-integrity D3, testing S10)
 *
 *  1. PULL: a peer file at a path this instance could not look at (a file it could not stat, or anything under a directory it could not
 *     list, matched by the directory's prefix with its slash) is neither fetched, written nor saved as a conflict copy. A path that only shares
 *     a string prefix with the directory (`dd/` against `d/`) is not covered.
 *  2. A content verdict (a stored file under a foreign key) is not an unreadable path: the peer's copy still arrives as a conflict copy.
 *  3. PUSH: a path the peer names in `unreadable` is not uploaded to, matched by key (an NFD spelling names the NFC key), the directory prefix
 *     covering everything under it. When the peer says its list is cut (`unreadableTruncated`) nothing is uploaded for a path its manifest
 *     does not carry. A field of the wrong shape is ignored, never fatal.
 *  4. SENDER: a `409` carrying `code: 'path_unreadable'` is a refusal: the same file is not sent again until something changes (the
 *     `noteRefusedUpload` skip), and it is said once. A `409` with any other code (a destination blocked by a file) is still retried.
 *
 * ## How
 *
 * The REAL engine (`runSyncForPeer`) against the pull door's fake peer, which serves the real manifest handler over its own disk and canned
 * byte routes (`state.manifest` scripts the peer's manifest, `state.fileUpload` its upload answers). This instance's failures are injected
 * through the `fs/promises` seam for paths under THIS instance's files root only (`_path-look-faults.mjs`: the fake peer's own root is
 * `peer-<space>`, untouched). Each case asserts its fault fired.
 *
 * ## Seen red
 *
 * 1 and 3: the base downloads (or uploads) the path it should leave alone. 4: the base sends the file again on the second cycle. 2 and the
 * controls (`ok.txt` pulled beside a refused path, a `dd/` sibling pulled, a free file pushed, a 409 without the code retried, a malformed
 * `unreadable` ignored) are green on the base: they hold what the rule must not widen.
 *
 * Run: node --test testing/standalone/file-sync-leaves-a-path-nobody-could-look-at-alone-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { underLookFaults } from './_path-look-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'unreadsync';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const NFC_NAME = 'Café.txt';
const NFD_NAME = NFC_NAME.normalize('NFD');

let door, stored;

const downloaded = () => door.state.fileDownloads.map(d => d.path).sort();
const uploaded = () => door.state.fileUploads.map(u => u.path).sort();
const localText = (rel) => fs.readFileSync(path.join(door.localFilesRoot(S), rel), 'utf8');
const localNames = (rel) => fs.readdirSync(path.join(door.localFilesRoot(S), rel)).sort();
const conflicts = () => door.coll(S, 'conflicts').find({}).toArray();

/** The peer's manifest, scripted: what its real handler would answer, plus whatever the case adds (`unreadable`, `unreadableTruncated`). */
function scriptPeerManifest(extra, manifest = []) {
  door.state.manifest = (_req, res) => { res.json({ manifest, spaceId: door.peerSide(S), ...extra }); };
}

describe('file sync leaves a path nobody could look at alone', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'unreadsync', spaces: [S], files: true, direction: 'both', meta: { [S]: { suppressEmbeddings: true } } });
    stored = await import('../../server/dist/files/stored-bytes.js');
  });
  after(async () => {
    for (const k of ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE']) delete process.env[k];
    stored?.resetStoredKeyCacheForTests();
    await door?.close();
  });
  beforeEach(async () => {
    for (const k of ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE']) delete process.env[k];
    stored.resetStoredKeyCacheForTests();
    await door.reset({ direction: 'both' });
  });

  describe('the pull (rule 1)', () => {
    it('a peer file at a file this instance could not stat is not fetched, written or saved beside it; a file next to it is pulled', async () => {
      door.seedPeerFile(S, 'p/a.txt', 'peer version');
      door.seedPeerFile(S, 'ok.txt', 'peer ok');
      door.writeLocalFile(S, 'p/a.txt', 'local version');
      await underLookFaults(door.localFilesRoot(S), [{ fn: 'stat', match: rel => rel === 'p/a.txt' }], () => door.sync());
      assert.ok(downloaded().includes('ok.txt'), `fixture: the cycle never pulled the readable file (${JSON.stringify(downloaded())}): it did not reach the pull`);
      assert.ok(!downloaded().includes('p/a.txt'), 'the peer\'s copy of a path this instance could not look at was fetched: to this side it looked absent');
      assert.equal(localText('p/a.txt'), 'local version', 'the file this instance holds was overwritten');
      assert.deepEqual(localNames('p'), ['a.txt'], 'a conflict copy was written beside a file this instance could not look at');
      assert.deepEqual(await conflicts(), [], 'a conflict was recorded for a path this instance could not look at');
      assert.equal(localText('ok.txt'), 'peer ok');
    });

    it('everything under a directory this instance could not list is left alone, by its prefix, and a sibling that only shares the text is pulled', async () => {
      door.seedPeerFile(S, 'd/new.txt', 'peer new');
      door.seedPeerFile(S, 'd/sub/deeper.txt', 'peer deeper');
      door.seedPeerFile(S, 'dd/other.txt', 'peer other');
      door.writeLocalFile(S, 'd/existing.txt', 'local existing');
      await underLookFaults(door.localFilesRoot(S), [{ fn: 'readdir', match: rel => rel === 'd' }], () => door.sync());
      assert.ok(downloaded().includes('dd/other.txt'), `fixture or prefix boundary: the sibling \`dd/\` was not pulled (${JSON.stringify(downloaded())})`);
      assert.deepEqual(downloaded().filter(p => p.startsWith('d/')), [], 'a file under a directory this instance could not list was fetched: to this side the directory looked empty');
      assert.deepEqual(localNames('d'), ['existing.txt'], 'bytes were written into a directory this instance could not list');
      assert.deepEqual(await conflicts(), []);
    });

  });

  describe('a content verdict is not an unreadable path (rule 2)', () => {
    it('a stored file under a foreign key does not stop the peer\'s copy: it lands as a conflict copy, the local bytes untouched', async () => {
      process.env['YTHRIL_MASTER_KEY'] = randomBytes(32).toString('base64');
      stored.resetStoredKeyCacheForTests();
      const abs = path.join(door.localFilesRoot(S), 'locked.bin');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      await stored.writeStored(abs, randomBytes(64));
      const before = fs.readFileSync(abs);
      process.env['YTHRIL_MASTER_KEY'] = randomBytes(32).toString('base64');
      stored.resetStoredKeyCacheForTests();
      door.seedPeerFile(S, 'locked.bin', 'the peer\'s good copy');
      await door.sync();
      assert.ok(downloaded().includes('locked.bin'), 'the peer\'s copy of a file this instance cannot decode was not fetched');
      assert.equal((await conflicts()).filter(c => c.originalPath === 'locked.bin').length, 1, 'the peer\'s copy did not arrive as a conflict copy');
      assert.ok(fs.readFileSync(abs).equals(before), 'the file this instance cannot decode was overwritten');
    });
  });

  describe('the push (rule 3)', () => {
    const files = () => {
      door.writeLocalFile(S, 'blocked/x.txt', 'bx');
      door.writeLocalFile(S, 'dir/y.txt', 'dy');
      door.writeLocalFile(S, 'dir/deep/z.txt', 'dz');
      door.writeLocalFile(S, 'free.txt', 'fr');
      door.writeLocalFile(S, NFC_NAME, 'cafe');
    };

    it('no upload to a path the peer names, nor under a directory prefix it names; a free path is uploaded', async () => {
      files();
      scriptPeerManifest({ unreadable: ['blocked/x.txt', 'dir/'], unreadableTruncated: false });
      await door.sync();
      assert.ok(uploaded().includes('free.txt'), `fixture: nothing was pushed (${JSON.stringify(uploaded())}): the cycle did not reach the push`);
      assert.deepEqual(uploaded().filter(p => p.startsWith('blocked/') || p.startsWith('dir/')), [],
        'the sender uploaded to paths the peer said it cannot look at: the peer\'s upload door refuses each one, every cycle');
    });

    it('a peer\'s decomposed spelling names our NFC key', async () => {
      files();
      scriptPeerManifest({ unreadable: [NFD_NAME], unreadableTruncated: false });
      await door.sync();
      assert.ok(uploaded().includes('free.txt'), 'fixture: nothing was pushed');
      assert.ok(!uploaded().includes(NFC_NAME), 'the peer\'s NFD spelling of an unreadable path did not match our NFC key: the file was pushed to it');
    });

    it('a peer whose list is cut is sent nothing for a path its manifest does not carry; a path it carries is judged as ever', async () => {
      door.writeLocalFile(S, 'known.txt', 'same on both');
      door.writeLocalFile(S, 'new.txt', 'only here');
      scriptPeerManifest({ unreadable: [], unreadableTruncated: true }, [{ path: 'known.txt', sha256: sha('same on both'), size: 12, modifiedAt: new Date().toISOString() }]);
      await door.sync();
      assert.deepEqual(uploaded(), [], 'a cut list means the peer may be unable to look at a path it does not name: pushing the absent paths is pushing blind');
    });

    it('the same cycle with a complete list uploads the new file (control for the cut-list case)', async () => {
      door.writeLocalFile(S, 'known.txt', 'same on both');
      door.writeLocalFile(S, 'new.txt', 'only here');
      scriptPeerManifest({ unreadable: [], unreadableTruncated: false }, [{ path: 'known.txt', sha256: sha('same on both'), size: 12, modifiedAt: new Date().toISOString() }]);
      await door.sync();
      assert.deepEqual(uploaded(), ['new.txt']);
    });

    it('an `unreadable` field of the wrong shape is ignored and never stops the file leg (control)', async () => {
      files();
      scriptPeerManifest({ unreadable: [1, null, {}, '', 'x'.repeat(100_000)], unreadableTruncated: 'yes' });
      await door.sync();
      assert.ok(uploaded().includes('free.txt'), 'a malformed list stopped the push');
      door.state.fileUploads.length = 0;
      scriptPeerManifest({ unreadable: 'blocked/x.txt' });
      await door.sync();
      assert.ok(uploaded().includes('free.txt'), 'a list that is not an array stopped the push');
    });
  });

  describe('the sender reads 409 path_unreadable as a refusal (rule 4)', () => {
    const answer409 = (code) => (info, res) => {
      if (info.path !== 'u.txt') return false;
      res.status(409).json({ error: 'The path cannot be looked at', ...(code ? { code } : {}) });
      return true;
    };

    it('the file is sent once, not again on the next cycle, and said once', async () => {
      door.writeLocalFile(S, 'u.txt', 'unreadable on the peer');
      scriptPeerManifest({});
      door.state.fileUpload = answer409('path_unreadable');
      const { lines } = await door.logsDuring(async () => { await door.sync(); await door.sync(); });
      const sent = door.state.fileUploads.filter(u => u.path === 'u.txt').length;
      assert.equal(sent, 1, `the refused path was sent ${sent} times over two cycles: the whole file again every cycle`);
      assert.equal(lines.filter(l => l.includes('u.txt')).length, 1, `the refusal was said ${lines.filter(l => l.includes('u.txt')).length} times, not once: ${lines.join(' | ')}`);
    });

    it('a 409 with another code (a destination a file blocks) is tried again on the next cycle (control)', async () => {
      door.writeLocalFile(S, 'u.txt', 'blocked destination');
      scriptPeerManifest({});
      door.state.fileUpload = answer409('path_blocked');
      await door.sync();
      await door.sync();
      assert.equal(door.state.fileUploads.filter(u => u.path === 'u.txt').length, 2, 'a 409 that is not about an unreadable path was remembered as a refusal');
    });
  });
});
