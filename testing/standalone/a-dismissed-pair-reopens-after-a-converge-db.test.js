/**
 * A dismissed duplicate pair reopens when one of its records is converged to new text, even if the scanner reaches the pair before
 * the embed job has stored the text (bundle-49 review, #3).
 *
 * ## The defect
 *
 * A dismissal is sticky until the pair's CONTENT changes: the scanner hashes both records' stored `matchedText` and compares it with
 * the hash taken at dismissal (`handlePair`, `decideDismissed`). A converge bumps the record's seq but, since bundle-49, leaves the
 * stored `matchedText` of the OLD text beside the old vector until the queued job has rewritten both (a vector is stored only beside
 * the text it was made from). A scan that reaches the pair in that window reads the old text, answers `refresh` (same content, only
 * the seq moved) and stores the NEW seqs. The job then writes the new text WITHOUT a seq bump, so every later scan sees equal seqs
 * and answers `keep`: the pair never reopens, although a record of it was materially edited.
 *
 * ## The rule
 *
 * While a record of a dismissed pair has stored text that is not its current text (it is owed its job), the scanner does not refresh
 * the pair's baseline: the dismissal stays and the seqs it holds stay old, so the first scan after the job sees the new text and
 * reopens the pair. A re-write that leaves the text the same is still a refresh (noise does not resurface it).
 *
 * The scanner's pair step is driven directly (`handlePair`); what it reads is real: the records, their stored text and vectors, and
 * the job the worker runs over a stub embedding endpoint.
 *
 * Run: node --test testing/standalone/a-dismissed-pair-reopens-after-a-converge-db.test.js
 * (requires a prior `npm run build:server`, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-dismissed-converge-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let server, local, mongo, fact, scanner, worker, queue;
const vectorFor = (text) => Array.from({ length: DIMS }, (_, i) => ((text.length + i) % 10) / 10 + 0.05);

const facts = () => mongo.col(`${SPACE}_facts`);
const candidates = () => mongo.col(`${SPACE}_dupe_candidates`);
const asResult = async (id) => {
  const doc = await facts().findOne({ _id: id });
  return { type: 'fact', _id: id, fact: doc.fact, seq: doc.seq, score: 0.99 };
};
async function drain() {
  queue.resetEmbedPendingHint();
  for (let i = 0; i < 20; i++) if (!(await worker.runOneEmbedJob())) return;
  assert.fail('the embed queue did not drain');
}

describe('a dismissed pair reopens after a converge (real MongoDB)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vectorFor(JSON.parse(body).input) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('dismissedconverge');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    scanner = await import('../../server/dist/brain/dupe-scanner.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** Two embedded near-duplicate facts and their pair, found by the scanner and then dismissed with its baseline hash. */
  async function dismissedPair() {
    await Promise.all(['facts', 'dupe_candidates', 'embed_jobs'].map(p => mongo.col(`${SPACE}_${p}`).deleteMany({})));
    const opts = { waitForEmbedding: true };
    const a = await fact.saveFact(SPACE, 'the office is in Paris', [], [], undefined, undefined, undefined, opts);
    const b = await fact.saveFact(SPACE, 'the office is in Paris, France', [], [], undefined, undefined, undefined, opts);
    const [lo, hi] = a._id < b._id ? [a._id, b._id] : [b._id, a._id];
    await scanner.handlePair(SPACE, 'fact', await asResult(lo), await asResult(hi));
    const found = await candidates().findOne({});
    assert.equal(found?.status, 'open', 'fixture: the scanner did not record the pair');
    await candidates().updateOne({ _id: found._id }, {
      $set: { status: 'dismissed', dismissedContentHash: await scanner.pairContentHash(SPACE, 'fact', lo, hi) },
    });
    return { lo, hi };
  }

  it('a converge that the scanner reaches before the job leaves the dismissal waiting, and the job then reopens the pair', async () => {
    const { lo, hi } = await dismissedPair();
    const before = await candidates().findOne({});
    // `lo` is whichever of the two seeds has the lower id, and ids are random: read its text rather than assume which seed it is.
    const oldText = (await facts().findOne({ _id: lo })).matchedText;

    await fact.saveFact(SPACE, 'the office moved to Berlin last spring', [], [], undefined, undefined, undefined,
      undefined, undefined, undefined, lo);
    const stale = await facts().findOne({ _id: lo });
    assert.equal(stale.matchedText, oldText, 'fixture: the converge must leave the old text until the job runs');
    assert.ok(stale.seq > before.aSeq || stale.seq > before.bSeq, 'fixture: the converge did not bump the seq');

    await scanner.handlePair(SPACE, 'fact', await asResult(lo), await asResult(hi));
    const waiting = await candidates().findOne({});
    assert.equal(waiting.status, 'dismissed');
    assert.equal(waiting.aSeq, before.aSeq, 'the scanner stored the new seq against the OLD text, so the job\'s text write can never reopen the pair');
    assert.equal(waiting.dismissedContentHash, before.dismissedContentHash, 'the scanner moved the baseline to the old text');

    await drain();
    assert.equal((await facts().findOne({ _id: lo })).matchedText, 'the office moved to Berlin last spring', 'fixture: the job did not store the new text');
    await scanner.handlePair(SPACE, 'fact', await asResult(lo), await asResult(hi));
    assert.equal((await candidates().findOne({})).status, 'open', 'a converged record of a dismissed pair did not reopen it once its text was stored');
  });

  it('a re-write that leaves the text the same is still a refresh: the pair stays dismissed', async () => {
    const { lo, hi } = await dismissedPair();
    const before = await candidates().findOne({});
    // The same text again: a converge with an identical wording, the worker having settled the text. `lo` is whichever seed has the
    // lower random id, so its own text is read rather than assumed.
    const ownText = (await facts().findOne({ _id: lo })).fact;
    await fact.saveFact(SPACE, ownText, [], [], undefined, undefined, undefined, undefined, undefined, undefined, lo);
    await drain();
    assert.equal((await facts().findOne({ _id: lo })).matchedText, ownText);
    await scanner.handlePair(SPACE, 'fact', await asResult(lo), await asResult(hi));
    const after = await candidates().findOne({});
    assert.equal(after.status, 'dismissed', 'a re-write with the same text resurfaced a dismissed pair');
    assert.ok(after.aSeq > before.aSeq || after.bSeq > before.bSeq, 'the baseline was not advanced for the unchanged text');
  });
});
