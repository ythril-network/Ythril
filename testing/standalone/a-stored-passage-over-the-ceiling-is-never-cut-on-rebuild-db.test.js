/**
 * What the producer embeds and what the rebuild embeds are one text, and a stored passage over the ceiling is never silently cut (Q-699, bundle-237).
 *
 * ## The builder
 *
 * `embedTextFor(heading, content)` (`brain/embed-text.ts`) is the ONE builder of what is embedded: `chunkEmbedText` with the heading capped
 * to a quarter of the budget, then cut to the budget. The conversion's chunk store, the `embed` level, the media embedders and the queue's
 * rebuild (`derivedText`) all call it, and `matchedText` stores exactly its output, so a rebuilt vector describes what the producer's did.
 *
 * ## The three shapes of a stored passage over the ceiling
 *
 *  1. A text-conversion chunk (`#chunkN`, made by the chunkers) stored BEFORE the ceiling existed, whose embed text would be cut: the
 *     rebuild does NOT embed a cut of it (a cut passage ends `complete` with most of its text unfindable, and the failure report was the
 *     only clue). Its job ends `failed` at once (attempts at the maximum) with a `lastError` that names the bytes, the ceiling and the
 *     act that cures it (`retry_embed_file`, which re-converts the file into parts), counted as `over_ceiling`. No stub request is made.
 *  2. A media chunk (`#media-chunkN`: a transcript, a caption, captions with a transcript) has no chunker: its rebuild embeds the cut
 *     text, and `matchedText` is that cut text, `content` whole.
 *  3. The `embed` level (one vector for the whole document): its producer embeds the cut text, stores `matchedText` as that cut text and
 *     `content` whole (the lexical channel reads `content`). It stores `wholeDocument: true`, and that marker is what the rebuild reads
 *     (C13): a `#chunkN` WITH it over the budget takes the same deterministic cut and its job completes; one WITHOUT it (a chunker's
 *     chunk, or an embed-level chunk stored before the marker existed) takes the fail-at-once path of case 1.
 *
 * Also held here, through a real conversion store: a chunk the embedder refuses for another reason is stored without a vector, counted
 * (`ythril_conversion_chunks_unembedded_total`), and does not end the conversion.
 *
 * The embedder is the real `embed()` over a stub endpoint (`EMBEDDING_URL`); the claim is a real job row in a real transaction.
 *
 * Run: `npm run test:up`, then node --test testing/standalone/a-stored-passage-over-the-ceiling-is-never-cut-on-rebuild-db.test.js
 * (requires a prior `npm run build` in server/ and the test MongoDB as a replica set)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { seedClaim } from './_media-claim.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';
const DIMS = 4;
const CEILING = 6_000;
const REFUSED = 'REFUSE-THIS-TEXT';
const T0 = '2026-08-01T00:00:00.000Z';
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b237-stored-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
delete process.env['YTHRIL_MASTER_KEY'];
delete process.env['YTHRIL_MASTER_PASSPHRASE'];

let seen = [];
let server, local, mongo, embedRecord, embedText, queue, worker, pipeline, registry;

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const files = () => mongo.col(`${SPACE}_files`);
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const derivedBase = (id, parent) => ({
  _id: id, spaceId: SPACE, path: id, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 10, author: LOCAL, parentFileId: parent,
});
async function seedParent(id) {
  await files().insertOne({ _id: id, spaceId: SPACE, path: id, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 100, author: LOCAL, seq: 5 });
}

async function counter(name, reason) {
  const text = await registry.register.metrics();
  let total = 0;
  for (const m of text.matchAll(new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, 'gm'))) {
    if (reason === undefined || (m[1] ?? '').includes(`reason="${reason}"`)) total += Number(m[2]);
  }
  return total;
}

async function runQueuedJob(id) {
  await queue.enqueueEmbedJob(SPACE, 'file', id, { priority: queue.EMBED_PRIORITY.rebuild });
  queue.resetEmbedPendingHint();
  assert.equal(await worker.runOneEmbedJob(), true, 'a job was claimed');
}

describe('a stored passage over the ceiling, and the one text the producer and the rebuild share (real MongoDB, real embed() over a stub)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        seen.push(input);
        if (String(input).includes(REFUSED)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'refused for a reason of its own' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((bytes(String(input)) + i) % 10) / 10 + 0.05) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...LOCAL, spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('b237stored');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    embedText = await import('../../server/dist/brain/embed-text.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    pipeline = await import('../../server/dist/files/converters/pipeline.js');
    registry = await import('../../server/dist/metrics/registry.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
    await jobs().deleteMany({});
    await mongo.col(`${SPACE}_media_jobs`).deleteMany({});
    seen = [];
    queue.resetEmbedPendingHint();
  });

  describe('1. a stored text-conversion chunk over the ceiling is never cut on rebuild', () => {
    it('its job ends failed at once, naming the bytes, the ceiling and retry_embed_file; the embedder is never asked', async () => {
      await seedParent('docs/big.md');
      const id = 'docs/big.md#chunk0';
      await files().insertOne({ ...derivedBase(id, 'docs/big.md'), chunkIndex: 0, headingText: 'Big', content: 'k'.repeat(30_000) });
      const over = await counter('ythril_embed_jobs_failed_total', 'over_ceiling');

      await runQueuedJob(id);

      assert.deepEqual(seen, [], 'the oversized passage was sent to the embedder (cut or not)');
      const job = await jobs().findOne({ _id: `file:${id}` });
      assert.ok(job, 'the job was completed and deleted: the passage ended "complete" with a cut vector');
      assert.equal(job.status, 'failed');
      assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
      assert.match(job.lastError, /\b30,?00\d\b/, 'the message must name how many bytes the passage is');
      assert.match(job.lastError, /6,?000/, 'and the ceiling');
      assert.match(job.lastError, /retry_embed_file/, 'and the act that cures it');
      const row = await files().findOne({ _id: id });
      assert.equal(row.embedding, undefined, 'a cut vector was stored for the passage');
      assert.equal(row.content.length, 30_000, 'the stored text is untouched');
      assert.equal(await counter('ythril_embed_jobs_failed_total', 'over_ceiling'), over + 1);
    });

    it('a stored chunk that fits is rebuilt as it always was (the control)', async () => {
      await seedParent('docs/small.md');
      const id = 'docs/small.md#chunk0';
      await files().insertOne({ ...derivedBase(id, 'docs/small.md'), chunkIndex: 0, headingText: 'Small', content: 'a perfectly ordinary passage' });

      await runQueuedJob(id);

      assert.deepEqual(seen, ['Small a perfectly ordinary passage']);
      assert.equal(await jobs().findOne({ _id: `file:${id}` }), null, 'a finished job is deleted');
      assert.ok(Array.isArray((await files().findOne({ _id: id })).embedding));
    });
  });

  describe('2. a media chunk over the ceiling is embedded cut, and says what it embedded', () => {
    it('the stub receives at most the ceiling; matchedText is exactly that text; content stays whole', async () => {
      await seedParent('talks/keynote.mp4');
      const id = 'talks/keynote.mp4#media-chunk0';
      const transcript = 'so the plan is as follows. '.repeat(1_200);
      await files().insertOne({ ...derivedBase(id, 'talks/keynote.mp4'), chunkIndex: 0, content: transcript, chunkOffsetMs: 0, chunkDurationMs: 30_000 });
      const cut = await counter('ythril_embed_input_cut_total');

      const outcome = await embedRecord.embedStoredRecord(SPACE, 'file', id, { rebuild: true });

      assert.equal(outcome, 'embedded');
      assert.equal(seen.length, 1);
      assert.ok(bytes(seen[0]) <= CEILING, `the embedder was sent ${bytes(seen[0])} bytes`);
      const row = await files().findOne({ _id: id });
      assert.equal(row.matchedText, seen[0], 'matchedText must be exactly what was embedded');
      assert.equal(row.content, transcript, 'content keeps the whole transcript for the lexical channel');
      assert.ok(transcript.startsWith(seen[0]));
      assert.equal(await counter('ythril_embed_input_cut_total') - cut, 1, 'the producer cut was counted once');
    });
  });

  describe('3. producer == rebuild, and the embed level', () => {
    const claimFor = (id) => seedClaim(SPACE, id, { mimeType: 'text/markdown', mediaType: 'text', resolvedFormat: 'md' });
    const convert = async (md, opts = {}) => (await pipeline.runConversionPipeline(Buffer.from(md, 'utf8'), 'doc.md', 'md', opts)).chunks;

    it('a section with a 7,000-byte heading is stored with the capped heading, and the rebuild embeds the producer\'s text', async () => {
      const heading = 'H'.repeat(7_000);
      const md = `## ${heading}\n\n` + Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + 'w'.repeat(380)).join('\n\n') + '\n';
      await seedParent('docs/long-heading.md');
      const claim = await claimFor('docs/long-heading.md');
      const result = await pipeline.storeConversionResults(SPACE, 'docs/long-heading.md', await convert(md), null, [], { claim });
      assert.ok(result.chunkCount >= 2 && result.embedFailures === 0, JSON.stringify(result));

      const rows = await files().find({ parentFileId: 'docs/long-heading.md' }).sort({ chunkIndex: 1 }).toArray();
      assert.equal(rows.length, result.chunkCount);
      for (const r of rows) {
        assert.ok(bytes(r.matchedText) <= CEILING, `${r._id} stored matchedText of ${bytes(r.matchedText)} bytes`);
        assert.ok(bytes(r.headingText) <= CEILING / 4, `${r._id} stored a ${bytes(r.headingText)}-byte heading: the rebuild would build from it`);
        assert.equal(r.matchedText, embedText.embedTextFor(r.headingText, r.content), `${r._id}: the producer did not embed what the one builder builds`);
        seen = [];
        assert.equal(await embedRecord.embedStoredRecord(SPACE, 'file', r._id, { rebuild: true }), 'embedded');
        assert.deepEqual(seen, [r.matchedText], `${r._id}: a rebuild embeds what the producer embedded`);
      }
    });

    it('the embed level: one chunk, the embedder is sent the cut text, matchedText is that text, content is the whole document', async () => {
      const doc = 'one line of a long document\n'.repeat(1_500);
      await seedParent('docs/whole.md');
      const claim = await claimFor('docs/whole.md');
      const chunks = await convert(doc, { textLevel: 'embed' });
      assert.equal(chunks.length, 1);
      const cut = await counter('ythril_embed_input_cut_total');

      await pipeline.storeConversionResults(SPACE, 'docs/whole.md', chunks, null, [], { claim });

      assert.equal(seen.length, 1);
      assert.ok(bytes(seen[0]) <= CEILING, `${bytes(seen[0])} bytes sent for the whole document`);
      const row = await files().findOne({ parentFileId: 'docs/whole.md' });
      assert.equal(row.matchedText, seen[0]);
      assert.ok(row.content.length > 40_000, 'the stored content of an embed-level document stays whole');
      assert.equal(await counter('ythril_embed_input_cut_total') - cut, 1);
    });

    it('a fresh embed-level conversion stores its one chunk with wholeDocument: true; a chunker chunk is stored without it', async () => {
      await seedParent('docs/marked.md');
      const claim = await claimFor('docs/marked.md');
      await pipeline.storeConversionResults(SPACE, 'docs/marked.md', await convert('a short note\n'.repeat(1_500), { textLevel: 'embed' }), null, [], { claim });
      const marked = await files().find({ parentFileId: 'docs/marked.md' }).toArray();
      assert.equal(marked.length, 1);
      assert.equal(marked[0].wholeDocument, true, 'the embed level\'s chunk carries no marker, so a rebuild cannot tell it from a chunker chunk');

      await seedParent('docs/sectioned.md');
      const claim2 = await claimFor('docs/sectioned.md');
      const md = '## One\n\n' + 'First section body sentence. '.repeat(20) + '\n\n## Two\n\n' + 'Second section body sentence. '.repeat(20) + '\n';
      await pipeline.storeConversionResults(SPACE, 'docs/sectioned.md', await convert(md), null, [], { claim: claim2 });
      const plain = await files().find({ parentFileId: 'docs/sectioned.md' }).toArray();
      assert.ok(plain.length >= 2);
      for (const r of plain) assert.notEqual(r.wholeDocument, true, `${r._id}: a chunker chunk was marked as a whole document`);
    });
  });

  describe('3b. rebuild of a stored #chunkN over the budget: the marker decides (C13)', () => {
    const whole = 'one line of a long document\n'.repeat(1_500).trimEnd();

    it('with wholeDocument: true it takes the deterministic cut: the embedder gets embedTextFor\'s output, the job completes, content stays whole', async () => {
      await seedParent('docs/whole.md');
      const id = 'docs/whole.md#chunk0';
      await files().insertOne({ ...derivedBase(id, 'docs/whole.md'), chunkIndex: 0, headingText: null, content: whole, wholeDocument: true });

      await runQueuedJob(id);

      assert.equal(seen.length, 1, 'the whole-document chunk was not sent to the embedder');
      assert.ok(bytes(seen[0]) <= CEILING, `${bytes(seen[0])} bytes were sent for the whole-document chunk`);
      assert.equal(seen[0], embedText.embedTextFor(null, whole), 'the vector input is not what the one builder builds');
      assert.equal(await jobs().findOne({ _id: `file:${id}` }), null, 'the job did not complete');
      const row = await files().findOne({ _id: id });
      assert.equal(row.matchedText, seen[0]);
      assert.equal(row.content, whole);
      assert.equal(row.wholeDocument, true, 'a rebuild dropped the marker');
      assert.ok(Array.isArray(row.embedding));
    });

    it('without the marker (an embed-level chunk stored before it existed) it fails at once with the re-conversion message', async () => {
      await seedParent('docs/old-whole.md');
      const id = 'docs/old-whole.md#chunk0';
      await files().insertOne({ ...derivedBase(id, 'docs/old-whole.md'), chunkIndex: 0, headingText: null, content: whole });

      await runQueuedJob(id);

      assert.deepEqual(seen, [], 'an unmarked oversized passage was sent to the embedder');
      const job = await jobs().findOne({ _id: `file:${id}` });
      assert.ok(job, 'the job was completed: an unmarked passage ended with a cut vector');
      assert.equal(job.status, 'failed');
      assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
      assert.match(job.lastError, /\b4\d,?\d{3}\b/, 'the bytes');
      assert.match(job.lastError, /6,?000/, 'the ceiling');
      assert.match(job.lastError, /retry_embed_file/);
    });

    it('with wholeDocument: false it is a chunker chunk and fails at once too', async () => {
      await seedParent('docs/odd.md');
      const id = 'docs/odd.md#chunk0';
      await files().insertOne({ ...derivedBase(id, 'docs/odd.md'), chunkIndex: 0, headingText: 'Odd', content: whole, wholeDocument: false });

      await runQueuedJob(id);

      assert.deepEqual(seen, []);
      assert.equal((await jobs().findOne({ _id: `file:${id}` })).status, 'failed');
    });
  });

  describe('4. a chunk the embedder refuses for its own reasons', () => {
    it('is stored without a vector, counted as unembedded, and the conversion finishes with the rest', async () => {
      await seedParent('docs/mixed.md');
      const claim = await seedClaim(SPACE, 'docs/mixed.md', { mimeType: 'text/markdown', mediaType: 'text', resolvedFormat: 'md' });
      const unembedded = await counter('ythril_conversion_chunks_unembedded_total');
      const chunks = [
        { chunkIndex: 0, headingText: 'Fine', content: 'a passage the embedder takes' },
        { chunkIndex: 1, headingText: 'Refused', content: `${REFUSED} a passage it will not take` },
      ];

      const result = await pipeline.storeConversionResults(SPACE, 'docs/mixed.md', chunks, null, [], { claim });

      assert.equal(result.chunkCount, 2);
      assert.equal(result.embedFailures, 1);
      const rows = await files().find({ parentFileId: 'docs/mixed.md' }).sort({ chunkIndex: 1 }).toArray();
      assert.ok(Array.isArray(rows[0].embedding));
      assert.equal(rows[1].embedding, undefined);
      assert.equal(await counter('ythril_conversion_chunks_unembedded_total') - unembedded, 1,
        'a passage stored without a vector surfaces nowhere unless every chunk failed: it is counted');
    });
  });
});
