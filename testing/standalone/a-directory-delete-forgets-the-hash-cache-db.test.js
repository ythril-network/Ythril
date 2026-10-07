/**
 * A directory delete forgets the cached content hash of every file the tree held, as a single file's delete does (bundle-51
 * round 4, the fold of the two "forget the hash cache" steps).
 *
 * ## The defect
 *
 * The manifest keeps a LOCAL cache of each file's hash (`<space>_file_hashes`, `files/manifest.ts`). `deleteFileCascade` ran
 * `forgetFileHashes` for the one path it removed (`removeFileHere`); `deleteDirectoryCascade` removed the tree, the jobs, the
 * sidecars and the rows and never touched the cache, so every file of a deleted tree stayed in it until a full manifest walk
 * happened to prune it — which an incremental one never does. The cache advertised paths nothing holds.
 *
 * ## What is asserted
 *
 *  1. after a directory delete, no cache entry under that directory is left;
 *  2. nothing that is not under it goes: a sibling directory whose name merely starts the same (`dir2/`), a regex-looking
 *     name (`d.r` against `dXr`), and an unrelated file keep their entries — the prefix is the directory and a `/`, escaped;
 *  3. the single-file delete still forgets its own entry (the step both deletes now share a module for).
 *
 * Run: node --test testing/standalone/a-directory-delete-forgets-the-hash-cache-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'hashforget';
const T0 = '2026-09-01T00:00:00.000Z';

let door, files, cascade;

const hashes = () => door.mongo.col(`${S}_file_hashes`);
/** The cache paths that remain, sorted. */
const cached = async () => (await hashes().find({}).toArray()).map(d => d._id).sort();

/** A stored file, its metadata row and the cache entry a manifest walk would have left for it. */
async function seed(p) {
  await files.writeFile(S, p, `content of ${p}`);
  await door.mongo.col(`${S}_files`).insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0 });
  await hashes().insertOne({ _id: p, size: 10, mtimeMs: 1, sha256: `hash-${p}` });
}

describe('a directory delete forgets the hash cache of its tree', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'hashforget', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    files = await import('../../server/dist/files/files.js');
    cascade = await import('../../server/dist/files/delete-cascade.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    for (const part of ['files', 'file_tombstones', 'file_hashes']) await door.mongo.col(`${S}_${part}`).deleteMany({});
    fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true });
  });

  it('no cache entry under the deleted directory is left, at any depth', async () => {
    await seed('dir/one.txt');
    await seed('dir/sub/two.txt');
    assert.deepEqual(await cached(), ['dir/one.txt', 'dir/sub/two.txt'], 'fixture: the cache was not seeded');
    await cascade.deleteDirectoryCascade(S, 'dir');
    assert.deepEqual(await cached(), [], 'the directory delete left the cache advertising paths nothing holds');
  });

  it('nothing outside the directory loses its entry: a same-prefix sibling, a regex-looking name, an unrelated file', async () => {
    for (const p of ['d.r/gone.txt', 'dXr/keep.txt', 'd.r2/keep.txt', 'other/keep.txt']) await seed(p);
    await cascade.deleteDirectoryCascade(S, 'd.r');
    assert.deepEqual(await cached(), ['d.r2/keep.txt', 'dXr/keep.txt', 'other/keep.txt'],
      'a directory delete forgot the hash of a file that is not under it, or kept one that is');
  });

  it('a single file delete still forgets its own entry', async () => {
    await seed('solo.txt');
    await seed('solo.txt2');
    await cascade.deleteFileCascade(S, 'solo.txt');
    assert.deepEqual(await cached(), ['solo.txt2']);
  });
});
