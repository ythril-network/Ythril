/**
 * CHARACTERIZATION (bundle-89): what `storeConversionResults` writes today — the chunk rows, the converted-copy row, the
 * extracted-image rows and their queued jobs — field for field, and what it reports and does when it cannot finish. Written against the
 * unmodified base 429e6d25 and green there.
 *
 * ## Why this is pinned
 *
 * `storeConversionResults` (`files/converters/pipeline.ts`) is one of the writers of derived fields on the files collection that
 * bundle-89 moves into one module (`files/derived-fields.ts`, plan rev 3 E2 item 5; `a-files-derived-fields-are-written-by-one-module`
 * names it). It writes content and vectors for rows that hang from a file, in ONE commit fenced on the job's claim, and it does a good
 * deal beside the rows: sidecar bytes, queued image jobs, a cleanup of its own sidecars when the commit is refused. A move that keeps the
 * rows and drops the fence's cleanup, or the job enqueue, passes every type check. Each case below holds one of those to what it does.
 *
 * ## What is NOT pinned
 *
 * A conversion that finishes for a file flagged `deletedAt` (bundle-89 makes the commit refuse for a flagged parent).
 *
 * The model is a stub endpoint behind the real `embed()`; nothing else is faked. The claim is a real job row in a real
 * transaction, so the fence is the production fence.
 *
 * Run: node --test testing/standalone/a-conversion-store-writes-exactly-what-it-writes-db.test.js
 * (requires a prior `npm run build` in server/ and the test MongoDB, which must be a replica set: the commit is a transaction)
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

const OPEN = 'general';
const QUIET = 'quiet';
const DIMS = 4;
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const REFUSED = 'REFUSE-THIS-TEXT';
const T0 = '2026-08-01T00:00:00.000Z';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89c-conv-'));
const CONFIG_PATH = path.join(scratch, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = scratch;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
delete process.env['YTHRIL_MASTER_KEY'];
delete process.env['YTHRIL_MASTER_PASSPHRASE'];

let server, local, mongo, pipeline, lease, sandbox, embedText;
let seen = [];

const files = (space = OPEN) => mongo.col(`${space}_files`);
const jobs = (space = OPEN) => mongo.col(`${space}_media_jobs`);

const parentRow = (id, over = {}) => ({ _id: id, spaceId: OPEN, path: id, tags: ['t'], description: 'mine', createdAt: T0, updatedAt: T0, sizeBytes: 100, author: LOCAL, seq: 5, ...over });
async function seedParent(id, over = {}, space = OPEN) {
  const doc = parentRow(id, { spaceId: space, ...over });
  await files(space).insertOne(doc);
  return doc;
}

/** The claim a conversion commits under: a real job row in `processing` with a token. */
async function claimFor(space, fileId) {
  const claimToken = `run-${fileId}`;
  const now = new Date().toISOString();
  await jobs(space).insertOne({
    _id: fileId, spaceId: space, filePath: fileId, mimeType: 'text/plain', mediaType: 'text', resolvedFormat: 'txt',
    status: 'processing', attempts: 1, maxAttempts: 3, lastError: null, claimedAt: now, progressAt: now, claimToken, claimableAfter: null,
    createdAt: now, updatedAt: now,
  });
  return { jobId: fileId, claimToken };
}

const chunk = (chunkIndex, content, headingText = '') => ({ chunkIndex, content, headingText });
const store = (space, id, chunks, converted = null, images = [], opts) => pipeline.storeConversionResults(space, id, chunks, converted, images, opts);
const abs = (space, rel) => path.join(sandbox.spaceRoot(space), rel);

const CHUNK_KEYS = ['_id', 'spaceId', 'path', 'tags', 'createdAt', 'updatedAt', 'sizeBytes', 'author', 'parentFileId', 'chunkIndex', 'headingText', 'content', 'matchedText'];
const keysOf = (doc) => Object.keys(doc).sort();

describe('storeConversionResults writes exactly what it writes today (real MongoDB, real embed() over a stub)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        seen.push(input);
        if (String(input).includes(REFUSED)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'refused' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      ...LOCAL,
      spaces: [{ id: OPEN, label: 'General' }, { id: QUIET, label: 'Quiet', meta: { suppressEmbeddings: true } }],
      networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('b89c_conv');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    pipeline = await import('../../server/dist/files/converters/pipeline.js');
    lease = await import('../../server/dist/files/media/lease.js');
    sandbox = await import('../../server/dist/files/sandbox.js');
    embedText = await import('../../server/dist/brain/embed-text.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [OPEN, QUIET]) { await files(space).deleteMany({}); await jobs(space).deleteMany({}); }
    fs.rmSync(path.join(scratch, 'files'), { recursive: true, force: true });
    seen = [];
  });

  it('text chunks: one row each with exactly these keys, embedded from heading and body, in the one result shape; the parent row is untouched', async () => {
    const parent = await seedParent('docs/report.txt');
    const claim = await claimFor(OPEN, 'docs/report.txt');

    const result = await store(OPEN, 'docs/report.txt', [chunk(0, 'revenue grew in every region', 'Results'), chunk(1, 'costs fell in the second half')], null, [], { claim });

    assert.deepEqual(result, { chunkCount: 2, convertedFileId: null, embedFailures: 0 });
    const rows = await files().find({ parentFileId: 'docs/report.txt' }).sort({ chunkIndex: 1 }).toArray();
    assert.deepEqual(rows.map(r => r._id), ['docs/report.txt#chunk0', 'docs/report.txt#chunk1']);
    for (const r of rows) {
      assert.deepEqual(keysOf(r), [...CHUNK_KEYS, 'embedding', 'embeddingModel'].sort(), `${r._id}: the row's keys`);
      assert.equal(r.spaceId, OPEN);
      assert.equal(r.path, r._id);
      assert.deepEqual(r.tags, []);
      assert.equal(r.createdAt, r.updatedAt);
      assert.deepEqual(r.author, LOCAL);
      assert.equal(r.embedding.length, DIMS);
      assert.equal(typeof r.embeddingModel, 'string');
      assert.ok(!('seq' in r), 'a chunk row is not a replicated record and takes no seq');
    }
    assert.equal(rows[0].headingText, 'Results');
    assert.equal(rows[0].content, 'revenue grew in every region');
    assert.equal(rows[0].matchedText, embedText.chunkEmbedText('Results', 'revenue grew in every region'), 'matchedText is the exact string that was embedded');
    assert.equal(rows[0].sizeBytes, Buffer.byteLength('revenue grew in every region', 'utf8'));
    assert.equal(rows[1].headingText, '');
    assert.deepEqual([...seen].sort(), [rows[0].matchedText, rows[1].matchedText].sort(), 'each chunk\'s text was embedded once, and nothing else');
    assert.deepEqual(await files().findOne({ _id: 'docs/report.txt' }), parent, 'the parent row was written to');
  });

  it('a chunk\'s id comes from its own chunkIndex, not from its position', async () => {
    await seedParent('docs/report.txt');
    const claim = await claimFor(OPEN, 'docs/report.txt');
    await store(OPEN, 'docs/report.txt', [chunk(7, 'seventh'), chunk(3, 'third')], null, [], { claim });
    const rows = await files().find({ parentFileId: 'docs/report.txt' }).sort({ chunkIndex: 1 }).toArray();
    assert.deepEqual(rows.map(r => [r._id, r.chunkIndex]), [['docs/report.txt#chunk3', 3], ['docs/report.txt#chunk7', 7]]);
  });

  it('a converted copy is a sidecar file AND a bare row (no content, no vector) that hangs from the original; its id is returned', async () => {
    await seedParent('docs/report.pdf');
    const claim = await claimFor(OPEN, 'docs/report.pdf');

    const result = await store(OPEN, 'docs/report.pdf', [chunk(0, 'body')], '# The whole document\n\nbody\n', [], { claim });

    assert.equal(result.chunkCount, 1);
    assert.equal(result.convertedFileId, '_converted/docs/report.pdf.md');
    assert.equal(fs.readFileSync(abs(OPEN, result.convertedFileId), 'utf8'), '# The whole document\n\nbody\n', 'the converted markdown is on disk at that path');
    const converted = await files().findOne({ _id: result.convertedFileId });
    assert.deepEqual(keysOf(converted), ['_id', 'spaceId', 'path', 'tags', 'createdAt', 'updatedAt', 'sizeBytes', 'author', 'parentFileId'].sort());
    assert.equal(converted.parentFileId, 'docs/report.pdf');
    assert.equal(converted.sizeBytes, Buffer.byteLength('# The whole document\n\nbody\n', 'utf8'));
    assert.deepEqual(converted.author, LOCAL);
    assert.ok(!('embedding' in converted) && !('content' in converted) && !('matchedText' in converted));
  });

  it('extracted images: bytes on disk, a bare row each hanging from the document, and ONE queued image job each with the right MIME', async () => {
    await seedParent('docs/report.pdf');
    const claim = await claimFor(OPEN, 'docs/report.pdf');
    const images = [
      { index: 0, ext: 'jpg', base64: Buffer.from('jpeg-bytes').toString('base64') },
      { index: 1, ext: 'png', base64: Buffer.from('png-bytes').toString('base64') },
    ];

    const result = await store(OPEN, 'docs/report.pdf', [chunk(0, 'body')], null, images, { claim });

    assert.equal(result.chunkCount, 1);
    const rows = await files().find({ _id: { $regex: '^_extracted/' } }).sort({ _id: 1 }).toArray();
    assert.deepEqual(rows.map(r => r._id), ['_extracted/docs/report.pdf/image-0.jpg', '_extracted/docs/report.pdf/image-1.png']);
    assert.deepEqual(keysOf(rows[0]), ['_id', 'spaceId', 'path', 'tags', 'createdAt', 'updatedAt', 'sizeBytes', 'author', 'parentFileId'].sort());
    assert.equal(rows[0].parentFileId, 'docs/report.pdf');
    assert.equal(rows[0].sizeBytes, Buffer.byteLength('jpeg-bytes'));
    assert.equal(fs.readFileSync(abs(OPEN, rows[0]._id), 'utf8'), 'jpeg-bytes');
    assert.equal(fs.readFileSync(abs(OPEN, rows[1]._id), 'utf8'), 'png-bytes');
    const queued = await jobs().find({ _id: { $regex: '^_extracted/' } }).sort({ _id: 1 }).toArray();
    assert.deepEqual(queued.map(j => [j._id, j.mediaType, j.mimeType]), [
      ['_extracted/docs/report.pdf/image-0.jpg', 'image', 'image/jpeg'],
      ['_extracted/docs/report.pdf/image-1.png', 'image', 'image/png'],
    ]);
  });

  it('no more than 50 extracted images are stored, the first 50', async () => {
    await seedParent('docs/many.pdf');
    const claim = await claimFor(OPEN, 'docs/many.pdf');
    const images = Array.from({ length: 53 }, (_, index) => ({ index, ext: 'png', base64: Buffer.from(`i${index}`).toString('base64') }));
    await store(OPEN, 'docs/many.pdf', [chunk(0, 'body')], null, images, { claim });
    const rows = await files().find({ _id: { $regex: '^_extracted/' } }).toArray();
    assert.equal(rows.length, 50);
    assert.ok(rows.some(r => r._id.endsWith('image-49.png')) && !rows.some(r => r._id.endsWith('image-50.png')));
  });

  it('a chunk the model refuses is STORED without a vector and without matchedText, and counted; the others are embedded', async () => {
    await seedParent('docs/report.txt');
    const claim = await claimFor(OPEN, 'docs/report.txt');

    const result = await store(OPEN, 'docs/report.txt', [chunk(0, 'fine'), chunk(1, `${REFUSED} here`)], null, [], { claim });

    assert.deepEqual(result, { chunkCount: 2, convertedFileId: null, embedFailures: 1 });
    const [ok, bad] = await files().find({ parentFileId: 'docs/report.txt' }).sort({ chunkIndex: 1 }).toArray();
    assert.equal(ok.embedding.length, DIMS);
    assert.deepEqual(keysOf(bad), CHUNK_KEYS.filter(k => k !== 'matchedText').sort(), 'a failed chunk keeps its text and has no vector, model or matchedText');
    assert.equal(bad.content, `${REFUSED} here`);
  });

  it('a suppressed file: every chunk keeps its text as matchedText, holds no vector, nothing is embedded and nothing is counted failed', async () => {
    await seedParent('docs/report.txt', {}, QUIET);
    const claim = await claimFor(QUIET, 'docs/report.txt');
    const result = await store(QUIET, 'docs/report.txt', [chunk(0, 'revenue', 'Results')], null, [], { claim });
    assert.deepEqual(result, { chunkCount: 1, convertedFileId: null, embedFailures: 0 });
    const row = await files(QUIET).findOne({ _id: 'docs/report.txt#chunk0' });
    assert.deepEqual(keysOf(row), CHUNK_KEYS.sort());
    assert.equal(row.matchedText, embedText.chunkEmbedText('Results', 'revenue'));
    assert.deepEqual(seen, []);
  });

  /*
   * CHANGED ON PURPOSE in bundle-89 (Q-418), and it was the characterization of the old rule: a file with no row used
   * to have its passages stored as text (no vector, because `chunkVectorsFor` reads a missing file as suppressed).
   *
   * They are not stored now. A row is absent for one of two reasons and both say the same thing: the file was deleted
   * outright, or it was never recorded. Storing a document's text under a path that holds no document leaves passages
   * no listing shows, no delete reaches and sync offers for ever — the orphan this item exists to stop. The count is
   * honestly zero, nothing is enqueued for extracted images that have no parent, and it is NOT a failure: the delete
   * already decided this.
   */
  it('a file with NO row stores NOTHING, counts zero, and is not a failure', async () => {
    const claim = await claimFor(OPEN, 'docs/ghost.txt');
    const result = await store(OPEN, 'docs/ghost.txt', [chunk(0, 'text')], null, [], { claim });
    assert.deepEqual(result, { chunkCount: 0, convertedFileId: null, embedFailures: 0 });
    assert.equal(await files().countDocuments({ parentFileId: 'docs/ghost.txt' }), 0,
      'a passage was stored for a file that is not there');
    assert.deepEqual(seen, [], 'the embedder was called for a file that is not there');
  });

  it('a second store replaces rows of the SAME id and leaves other ids alone — pruning stale chunks is the worker\'s job, not this function\'s', async () => {
    await seedParent('docs/report.txt');
    const claim = await claimFor(OPEN, 'docs/report.txt');
    await store(OPEN, 'docs/report.txt', [chunk(0, 'first'), chunk(1, 'second')], null, [], { claim });
    await store(OPEN, 'docs/report.txt', [chunk(0, 'rewritten')], null, [], { claim });
    const rows = await files().find({ parentFileId: 'docs/report.txt' }).sort({ chunkIndex: 1 }).toArray();
    assert.deepEqual(rows.map(r => [r._id, r.content]), [['docs/report.txt#chunk0', 'rewritten'], ['docs/report.txt#chunk1', 'second']]);
  });

  it('nothing to store: no rows, no job, a zero count', async () => {
    await seedParent('docs/empty.txt');
    const claim = await claimFor(OPEN, 'docs/empty.txt');
    assert.deepEqual(await store(OPEN, 'docs/empty.txt', [], null, [], { claim }), { chunkCount: 0, convertedFileId: null, embedFailures: 0 });
    assert.equal(await files().countDocuments({ parentFileId: 'docs/empty.txt' }), 0);
    assert.equal(await jobs().countDocuments({ _id: { $ne: 'docs/empty.txt' } }), 0, 'a job was queued');
  });

  describe('the claim fence', () => {
    it('a claim taken away before the commit: it throws a lease-lost error and NO row is written', async () => {
      await seedParent('docs/report.txt');
      const claim = await claimFor(OPEN, 'docs/report.txt');
      await jobs().updateOne({ _id: 'docs/report.txt' }, { $set: { claimToken: 'someone-else' } });

      await assert.rejects(() => store(OPEN, 'docs/report.txt', [chunk(0, 'body')], null, [], { claim }), (err) => lease.isLeaseLost(err));
      assert.equal(await files().countDocuments({ parentFileId: 'docs/report.txt' }), 0);
    });

    it('a refused commit for a file whose bytes are GONE removes the sidecar bytes this run wrote', async () => {
      // The row exists, the original's bytes do not (moved or deleted mid-run): the converted copy and extracted image written
      // before the commit would otherwise be advertised to peers for ever.
      await seedParent('docs/report.pdf');
      const claim = await claimFor(OPEN, 'docs/report.pdf');
      await jobs().updateOne({ _id: 'docs/report.pdf' }, { $set: { claimToken: 'someone-else' } });

      await assert.rejects(() => store(OPEN, 'docs/report.pdf', [chunk(0, 'body')], '# converted\n', [{ index: 0, ext: 'png', base64: Buffer.from('p').toString('base64') }], { claim }),
        (err) => lease.isLeaseLost(err));

      assert.equal(fs.existsSync(abs(OPEN, '_converted/docs/report.pdf.md')), false, 'the converted copy was left behind');
      assert.equal(fs.existsSync(abs(OPEN, '_extracted/docs/report.pdf/image-0.png')), false, 'the extracted image was left behind');
      assert.equal(await jobs().countDocuments({ _id: { $regex: '^_extracted/' } }), 0, 'a job was queued for an image whose row was never written');
    });

    it('a refused commit for a file whose bytes are STILL THERE keeps the sidecar bytes (they now belong to the run that took the claim)', async () => {
      await seedParent('docs/report.pdf');
      fs.mkdirSync(path.dirname(abs(OPEN, 'docs/report.pdf')), { recursive: true });
      fs.writeFileSync(abs(OPEN, 'docs/report.pdf'), 'pdf-bytes');
      const claim = await claimFor(OPEN, 'docs/report.pdf');
      await jobs().updateOne({ _id: 'docs/report.pdf' }, { $set: { claimToken: 'someone-else' } });

      await assert.rejects(() => store(OPEN, 'docs/report.pdf', [chunk(0, 'body')], '# converted\n', [], { claim }), (err) => lease.isLeaseLost(err));

      assert.equal(fs.existsSync(abs(OPEN, '_converted/docs/report.pdf.md')), true);
      assert.equal(await files().countDocuments({ parentFileId: 'docs/report.pdf' }), 0, 'and still no row');
    });

    it('a lease lost while the chunks embed (shouldStop) throws and writes no row', async () => {
      await seedParent('docs/report.txt');
      const claim = await claimFor(OPEN, 'docs/report.txt');
      await assert.rejects(() => store(OPEN, 'docs/report.txt', [chunk(0, 'a'), chunk(1, 'b')], null, [], { claim, shouldStop: () => true }), (err) => lease.isLeaseLost(err));
      assert.equal(await files().countDocuments({ parentFileId: 'docs/report.txt' }), 0);
    });

    it('a call with no claim writes nothing (the type makes it unwritable; at run time it is a throw, not an unfenced write)', async () => {
      await seedParent('docs/report.txt');
      await assert.rejects(() => store(OPEN, 'docs/report.txt', [chunk(0, 'a')], null, [], undefined));
      assert.equal(await files().countDocuments({ parentFileId: 'docs/report.txt' }), 0);
    });
  });
});
