/**
 * An upload whose RECORD write fails leaves no bytes that nothing names (bundle-48, the orphan found by the end-to-end drive;
 * the upload-door twin of Q-254).
 *
 * ## The defect
 *
 * Every door that stores a file's bytes does it in two steps: the bytes land on disk, then the row that names them is written
 * (`recordStoredFile`). The pull already took the bytes back when its row failed (Q-254). The upload doors did not: a store
 * stall between the two steps answered `503`, left the bytes on disk with NO row, and the next sync's manifest offered them.
 * A peer then recorded them as an authorless seq-0 row delivered by this instance — a file nobody here ever authored, with no
 * description or tags, credited to a sender that never held a record of it.
 *
 * ## The rule, over every door that reaches `recordStoredFile`
 *
 * The doors are derived from the helper that names them (`UPLOAD_DOORS`: a person and a peer, one request and a chunked
 * upload), and the two callers that do not go through HTTP — MCP `write_file` and the conversation ingest — arrive at
 * `storeFile`, which is driven directly here. For each:
 *
 *  1. the record write fails with a real DATABASE error (a collection validator refusing the file's hash, the way
 *     `_pull-door.mjs` `failRecordWrite` does), after the bytes have landed
 *  2. the door answers an error (5xx), never a 2xx
 *  3. for a path that had NO row, no bytes are left on disk, the space's manifest does not list the path, and no row exists
 *  4. for a path that HAD a row (an overwrite), the bytes are KEPT and the row is as it was: removing them would leave a row with
 *     no bytes, and the next upload of the path rewrites the row
 *
 * The controls: the same door without the fault stores the file and the manifest lists it (so the negative cannot pass because
 * the door stores nothing), and a neighbour path with another hash is recorded and kept in the same run.
 *
 * ## Seen red
 *
 * On the base, 3 fails for every door: the bytes stay on disk, the manifest lists them, there is no row. 4 and the controls
 * are green on it: they hold what the fix must not break.
 *
 * Run: node --test testing/standalone/an-upload-whose-record-fails-leaves-no-bytes-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { openByteDoor } from './_byte-door.mjs';
import { UPLOAD_DOORS } from './_byte-door-uploads.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'orphanbytes';
const sha = (s) => createHash('sha256').update(s).digest('hex');

let door, bytes, storeFile, buildFileManifest;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
const onDisk = (rel) => door.localFileExists(S, rel);
const readLocal = (rel) => fs.readFileSync(path.join(door.localFilesRoot(S), rel), 'utf8');
/** The manifest a peer would be offered, hashed afresh (no cache). */
const manifestPaths = async () => (await buildFileManifest(S, undefined, { force: true })).map(e => e.path).sort();

/** A file that was there before the upload: its bytes and the row that names them. */
async function seedHeld(rel, content) {
  door.writeLocalFile(S, rel, content);
  await door.coll(S, 'files').insertOne(build.filemeta(S, rel, 1, {
    author: PEER_AUTHOR, sizeBytes: Buffer.byteLength(content), sha256: sha(content),
  }));
}

/** The record write fails for exactly this content (the collection must exist for the validator to be set on it). */
async function failRecordFor(content) {
  await door.mongo.getDb().createCollection(`${S}_files`).catch(() => undefined);
  await door.failRecordWrite(S, sha(content));
}

describe('an upload whose record write fails leaves no bytes nothing names', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'orphanbytes', spaces: [S], files: true });
    bytes = await openByteDoor();
    ({ storeFile } = await import('../../server/dist/files/store-file.js'));
    ({ buildFileManifest } = await import('../../server/dist/files/manifest.js'));
    assert.ok(UPLOAD_DOORS.length >= 4, 'the upload doors derived from the helper are fewer than a person and a peer, single and chunked');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  for (const upload of UPLOAD_DOORS) {
    describe(upload.name, () => {
      const tag = upload.name.replace(/\W+/g, '-');
      const NEW = `orphan-${tag}.txt`;
      const content = `bytes of ${upload.name} whose record the database refuses`;
      const send = (rel, text) => upload.send(bytes, { space: S, path: rel, content: text });

      it('control: without the fault the bytes are stored, named by a row and offered by the manifest', async () => {
        const r = await send(NEW, content);
        assert.ok([201, 202].includes(r.code), `fixture: the upload was refused: ${JSON.stringify(r)}`);
        assert.equal(onDisk(NEW), true);
        assert.equal((await rowOf(NEW))?.sha256, sha(content));
        assert.ok((await manifestPaths()).includes(NEW), 'the manifest does not offer a stored file');
      });

      it('a path with no row: the door answers an error and the bytes, the row and the manifest entry are all absent', async () => {
        const neighbour = `neighbour-${tag}.txt`;
        const neighbourText = `bytes of a neighbour of ${upload.name}`;
        await failRecordFor(content);

        const r = await send(NEW, content);
        assert.ok(r.code >= 500, `the door answered ${r.code} ${JSON.stringify(r.body)} for a file whose record write failed`);
        assert.equal(await rowOf(NEW), null, 'fixture: the validator did not refuse the record write');
        assert.equal(onDisk(NEW), false, 'the bytes stay on disk with no row naming them: the next manifest offers them and a peer records them authorless');
        assert.ok(!(await manifestPaths()).includes(NEW), 'the manifest offers bytes that nothing here recorded');

        const ok = await send(neighbour, neighbourText);
        assert.ok([201, 202].includes(ok.code), `a neighbour was refused after another path's failure: ${JSON.stringify(ok)}`);
        assert.equal(onDisk(neighbour), true, 'the cleanup of one path took another path\'s bytes');
        assert.ok(await rowOf(neighbour));
      });

      it('a path that had a row: the door answers an error, the bytes are kept and the row is as it was', async () => {
        const held = `held-${tag}.txt`;
        const before = `the version ${upload.name} held before`;
        const after = `the version ${upload.name} tried to store`;
        await seedHeld(held, before);
        await failRecordFor(after);

        const r = await send(held, after);
        assert.ok(r.code >= 500, `the door answered ${r.code} ${JSON.stringify(r.body)} for a file whose record write failed`);
        assert.equal(onDisk(held), true, 'the bytes of an overwrite were removed: a row would name a file that is not there');
        assert.equal(readLocal(held), after, 'fixture: the overwrite did not land before its record failed');
        const row = await rowOf(held);
        assert.equal(row?.sha256, sha(before), 'the row changed although its write was refused');
      });
    });
  }

  describe('storeFile, the entry MCP write_file and the conversation ingest share', () => {
    const asPerson = { actor: { tokenLabel: 'a person' } };

    it('control: without the fault it stores, records and lists', async () => {
      await storeFile(S, 'store-control.txt', Buffer.from('stored by storeFile'), asPerson);
      assert.equal(onDisk('store-control.txt'), true);
      assert.ok(await rowOf('store-control.txt'));
      assert.ok((await manifestPaths()).includes('store-control.txt'));
    });

    it('a path with no row: it throws, and the bytes, the row and the manifest entry are all absent', async () => {
      const text = 'bytes storeFile cannot record';
      await failRecordFor(text);
      await assert.rejects(() => storeFile(S, 'store-new.txt', Buffer.from(text), asPerson), 'storeFile answered success for a file whose record write failed');
      assert.equal(await rowOf('store-new.txt'), null, 'fixture: the validator did not refuse the record write');
      assert.equal(onDisk('store-new.txt'), false, 'the bytes stay on disk with no row naming them');
      assert.ok(!(await manifestPaths()).includes('store-new.txt'));
    });

    it('a path that had a row: it throws, the bytes are kept and the row is as it was', async () => {
      const before = 'the version held before';
      const after = 'the version storeFile tried to store';
      await seedHeld('store-held.txt', before);
      await failRecordFor(after);
      await assert.rejects(() => storeFile(S, 'store-held.txt', Buffer.from(after), asPerson));
      assert.equal(readLocal('store-held.txt'), after, 'the bytes of an overwrite were removed');
      assert.equal((await rowOf('store-held.txt'))?.sha256, sha(before));
    });
  });
});
