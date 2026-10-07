/**
 * A moved file or directory leaves nothing at its old path — not even when its conversion finishes afterwards.
 *
 * ## The defect
 *
 * `files.test.js` "Moving a directory updates metadata paths for all files inside it" failed on CI with two records
 * still under the source directory after the move answered 200. Uploading a `.txt` queues a text conversion; the
 * worker read the bytes, the move ran, and then the worker inserted its chunk records under the OLD path —
 * `<src>/x.txt#chunk0` — a directory that no longer existed, with nothing that would ever delete them. The chunk
 * insert was unconditional, and the move had no way to tell the job it had moved.
 *
 * The move also missed records on its own, with no race at all: a single-file rename re-rooted only the file's id,
 * so its chunks (`<path>#chunk<n>`) stayed at the old path; a directory move rewrote the chunks' ids but not their
 * `parentFileId`; and the converted/extracted sidecars moved for neither.
 *
 * ## What is asserted, against a real replica-set MongoDB
 *
 * The fence is a transaction — whether a write inside one is ordered against a concurrent update is the database's
 * answer, not a fixture's — so this runs the real `moveFileCascade` and the real `storeConversionResults` over the
 * real Mongo layer, with a stub embedding endpoint and a scratch data root.
 *
 * Seen red: against `main` before the fix, the late conversion left `src/x.txt#chunk0` under the moved directory
 * (the CI failure, reproduced deterministically). After it, by mutation: dropping the job write from
 * `writeUnderClaim` (leaving only the commit) turns the first case red again.
 *
 * Run: `npm run test:up` (or any replica-set mongod on 127.0.0.1:27117) and `npm run build -w server`, then
 *      node --test testing/standalone/a-moved-file-leaves-nothing-at-its-old-path-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const DIMS = 4;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-move-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = tmpDir;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let server, local, mongo, cascade, pipeline, lease;

const files = () => mongo.col(`${SPACE}_files`);
const jobs = () => mongo.col(`${SPACE}_media_jobs`);
const onDisk = (rel) => path.join(tmpDir, 'files', SPACE, rel);

/** A text file as an upload leaves it: bytes on disk, a metadata record, and a job a worker has claimed. */
async function uploaded(rel, token) {
  fs.mkdirSync(path.dirname(onDisk(rel)), { recursive: true });
  fs.writeFileSync(onDisk(rel), rel);
  await files().insertOne({ _id: rel, spaceId: SPACE, path: rel, tags: [], sizeBytes: rel.length, embeddingStatus: 'processing' });
  await jobs().insertOne({
    _id: rel, spaceId: SPACE, filePath: rel, mimeType: 'text/plain', mediaType: 'text', resolvedFormat: 'txt',
    status: 'processing', attempts: 1, maxAttempts: 3, lastError: null, claimedAt: new Date().toISOString(),
    progressAt: new Date().toISOString(), claimToken: token, claimableAfter: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return { jobId: rel, claimToken: token };
}

/** What the worker's conversion writes at the end of its run, for the path the job was claimed under. */
const convert = (rel, claim, markdown = null) => pipeline.storeConversionResults(
  SPACE, rel, [{ chunkIndex: 0, content: `text of ${rel}`, headingText: '' }], markdown, [], { claim },
);

/** Every file record that still belongs to `dir` — by its own path, or by the file it was derived from. */
async function recordsUnder(dir) {
  const all = await files().find({}).toArray();
  return all.filter(d => d._id === dir || d._id.startsWith(`${dir}/`) || d._id.startsWith(`${dir}#`)
    || d._id.startsWith(`_converted/${dir}`) || d._id.startsWith(`_extracted/${dir}`)
    || (d.parentFileId && (d.parentFileId === dir || d.parentFileId.startsWith(`${dir}/`)))).map(d => d._id).sort();
}

describe('a moved file leaves nothing at its old path (real MongoDB)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => i / DIMS) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('movedfile');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    cascade = await import('../../server/dist/files/move-cascade.js');
    pipeline = await import('../../server/dist/files/converters/pipeline.js');
    lease = await import('../../server/dist/files/media/lease.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
    await jobs().deleteMany({});
    fs.rmSync(path.join(tmpDir, 'files'), { recursive: true, force: true });
  });

  it('a conversion that finishes AFTER its directory moved writes nothing under the old path', async () => {
    // The CI failure, made deterministic: every job is mid-flight when the move lands, and commits afterwards.
    const claims = [
      await uploaded('src/x.txt', 'run-x'), await uploaded('src/y.txt', 'run-y'), await uploaded('src/nested/z.txt', 'run-z'),
    ];

    await cascade.moveFileCascade(SPACE, 'src', 'dst');

    for (const claim of claims) {
      await assert.rejects(convert(claim.jobId, claim), err => lease.isLeaseLost(err),
        `the conversion of ${claim.jobId} committed under a claim the move had taken`);
      assert.equal(await lease.holdsClaim(SPACE, claim), false,
        'a run that then finds its file missing must see its claim gone, or it "reconciles" what the move carried');
    }
    assert.deepEqual(await recordsUnder('src'), [], 'records were written under the directory the files left');
    assert.deepEqual(await recordsUnder('dst'), ['dst/nested/z.txt', 'dst/x.txt', 'dst/y.txt']);

    // The jobs followed the files and are claimable there, so the moved files are processed where they now are.
    const queued = await jobs().find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(queued.map(j => [j._id, j.filePath, j.status, j.claimableAfter, j.claimToken]), [
      ['dst/nested/z.txt', 'dst/nested/z.txt', 'pending', null, null],
      ['dst/x.txt', 'dst/x.txt', 'pending', null, null],
      ['dst/y.txt', 'dst/y.txt', 'pending', null, null],
    ]);
  });

  it('a conversion that finished BEFORE the move is carried with it, parent links and all', async () => {
    const claim = await uploaded('src/x.txt', 'run-x');
    await convert('src/x.txt', claim);

    await cascade.moveFileCascade(SPACE, 'src', 'dst');

    assert.deepEqual(await recordsUnder('src'), []);
    const chunk = await files().findOne({ _id: 'dst/x.txt#chunk0' });
    assert.ok(chunk, 'the chunk did not follow its file');
    assert.equal(chunk.parentFileId, 'dst/x.txt',
      'a chunk still naming the old parent is invisible to the delete of the file it belongs to');
  });

  it('moving a DIRECTORY carries the links of every file in it, as renaming one file does (Q-164)', async () => {
    // A file's `_id` is its path, so every link it holds hangs off that path. The single-file rename re-created them
    // under the new one; the directory move re-rooted the records and left the links naming paths that were gone.
    const links = await import('../../server/dist/brain/links.js');
    const adjacency = await import('../../server/dist/brain/link-adjacency.js');
    await mongo.col(`${SPACE}_entities`).insertOne({ _id: '7f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7', spaceId: SPACE, name: 'Ada', type: 'person', tags: [], properties: {} });
    await uploaded('src/x.txt', 'run-links');
    await links.reconcileLinks(SPACE, 'src/x.txt', 'file', { entity: ['7f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'] }, { instanceId: 'test', instanceLabel: 'test' });
    assert.equal((await adjacency.linksStartingFrom(SPACE, ['src/x.txt'])).length, 1, 'precondition: the file holds a link');

    await cascade.moveFileCascade(SPACE, 'src', 'dst');

    assert.deepEqual(await adjacency.linksStartingFrom(SPACE, ['src/x.txt']), [], 'a link still names the path the file left');
    const carried = await adjacency.linksStartingFrom(SPACE, ['dst/x.txt']);
    assert.deepEqual(carried.map(l => l.to), ['7f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'], 'the moved file lost its link');
    await mongo.col(`${SPACE}_links`).deleteMany({});
    await mongo.col(`${SPACE}_entities`).deleteMany({});
  });

  it('renaming one file carries its chunks and its converted sidecar, on disk and in the metadata', async () => {
    // No race at all: the rename re-rooted only the file's own id, and a chunk id is `<path>#chunk<n>`.
    const claim = await uploaded('notes/a.txt', 'run-a');
    const { convertedFileId } = await convert('notes/a.txt', claim, '# a');
    // The worker writes the parent's pointer to its sidecar after the commit; the move has to re-point it.
    await files().updateOne({ _id: 'notes/a.txt' }, { $set: { convertedFileId, chunkCount: 1 } });
    assert.ok(fs.existsSync(onDisk('_converted/notes/a.txt.md')), 'precondition: the conversion wrote its sidecar');

    await cascade.moveFileCascade(SPACE, 'notes/a.txt', 'notes/b.txt');

    assert.deepEqual(await recordsUnder('notes/a.txt'), []);
    assert.deepEqual(await recordsUnder('notes/b.txt'),
      ['_converted/notes/b.txt.md', 'notes/b.txt', 'notes/b.txt#chunk0']);
    assert.ok(fs.existsSync(onDisk('_converted/notes/b.txt.md')), 'the converted sidecar stayed at the old path on disk');
    assert.ok(!fs.existsSync(onDisk('_converted/notes/a.txt.md')));
    assert.equal((await files().findOne({ _id: 'notes/b.txt' })).convertedFileId, '_converted/notes/b.txt.md');
  });

  it('a refused conversion does not leave its sidecar file behind at the path the file left', async () => {
    // The Markdown is written to disk before the commit, so a refusal alone would strand it — and sync advertises
    // every file on disk, sidecars included.
    const claim = await uploaded('notes/a.txt', 'run-a');
    await cascade.moveFileCascade(SPACE, 'notes/a.txt', 'notes/b.txt');
    await assert.rejects(convert('notes/a.txt', claim, '# a'), err => lease.isLeaseLost(err));
    assert.ok(!fs.existsSync(onDisk('_converted/notes/a.txt.md')), 'the refused run left its sidecar at the old path');
    assert.deepEqual(await recordsUnder('notes/a.txt'), []);
  });

  it('a move that fails leaves the jobs where they were, and claimable', async () => {
    // Held before the bytes move, so a failed move must hand them back rather than park them for the hold's length.
    await jobs().insertOne({
      _id: 'ghost/f.txt', spaceId: SPACE, filePath: 'ghost/f.txt', mimeType: 'text/plain', mediaType: 'text',
      status: 'pending', attempts: 0, maxAttempts: 3, lastError: null, claimedAt: null, claimableAfter: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await assert.rejects(cascade.moveFileCascade(SPACE, 'ghost', 'elsewhere'));
    const job = await jobs().findOne({ _id: 'ghost/f.txt' });
    assert.equal(job.status, 'pending');
    assert.equal(job.claimableAfter, null, 'a failed move left the job held');
  });
});
