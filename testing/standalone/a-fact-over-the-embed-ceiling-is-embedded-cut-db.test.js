/**
 * A fact whose embed text is over the embedder's input ceiling gets a vector: its text is cut to `embedding.maxInputBytes` before it is sent,
 * and the cut is counted (Q-374, bundle-41). A CHARACTERIZATION pin, green on 890cf234b: the behaviour exists since bundle-237.
 *
 * ## Why a pin and not a change
 *
 * Q-374 asked that an embedder's HTTP 400 for a too-long input end the job at once. That reverses a recorded rule (bundle-237: a 400 keeps its
 * budget, because a misconfigured embedder answers 400 for every record, `a-413-from-the-embedder-ends-the-embed-job-at-once-db`), and the
 * status cannot tell a too-long input from a settings fault. What the ticket wanted from it, a record over the model's context getting a
 * vector, is already delivered by the ceiling: every embed input is cut to `embedding.maxInputBytes` (default 6000 bytes, about 1500 tokens,
 * under an 8192-token context). This file pins that, so a change that stops cutting fails here.
 *
 * ## What it holds
 *
 * Through the real queue worker and the real `embed()` over a local stub endpoint: a fact of about 20 000 bytes is saved, its job is run once,
 * the stub received at most the default ceiling of bytes, the fact holds a vector, and `ythril_embed_input_cut_total{producer="http"}` moved
 * by one.
 *
 * Run: node --test testing/standalone/a-fact-over-the-embed-ceiling-is-embedded-cut-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { metricValue } from './_metric-series.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';
const DIMS = 4;
/** The documented default of `embedding.maxInputBytes` (docs/integration-guide/05b): the ceiling this pin is about. */
const DEFAULT_CEILING_BYTES = 6000;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q374-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

const received = [];
let server, local, mongo, fact, worker;

describe('a fact over the embed ceiling is embedded, cut (real MongoDB, real embed() over a stub endpoint)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try { received.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { received.push(null); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => (i + 1) / 10) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('q374ceilingpin');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a 20 000-byte fact holds a vector, the embedder got at most the ceiling, and the cut is counted once', async () => {
    const cutBefore = await metricValue('ythril_embed_input_cut_total', { producer: 'http' });
    const text = Array.from({ length: 4000 }, (_, i) => `word${i % 97}`).join(' ').slice(0, 20_000);
    assert.ok(Buffer.byteLength(text) > 3 * DEFAULT_CEILING_BYTES, 'fixture: the fact is not over the ceiling');
    const saved = await fact.saveFact(SPACE, text, [], []);

    await mongo.col(`${SPACE}_embed_jobs`).updateMany({ status: 'pending' }, { $set: { claimableAfter: null } });
    assert.equal(await worker.runOneEmbedJob(), true, 'fixture: no job was claimed');

    const sent = received.flatMap(b => (b && Array.isArray(b.input) ? b.input : b && typeof b.input === 'string' ? [b.input] : []));
    assert.ok(sent.length >= 1, `fixture: the stub received no input (${JSON.stringify(received).slice(0, 200)})`);
    for (const s of sent) assert.ok(Buffer.byteLength(s) <= DEFAULT_CEILING_BYTES, `the embedder was sent ${Buffer.byteLength(s)} bytes, over the ${DEFAULT_CEILING_BYTES}-byte ceiling`);

    const row = await mongo.col(`${SPACE}_facts`).findOne({ _id: saved._id });
    assert.ok(Array.isArray(row?.embedding) && row.embedding.length === DIMS, `the fact holds no vector (${JSON.stringify(row?.embedding)}): a fact over the ceiling must be embedded as its beginning`);
    assert.equal(await mongo.col(`${SPACE}_embed_jobs`).countDocuments({ recordId: saved._id }), 0, 'the job did not finish');
    assert.equal(await metricValue('ythril_embed_input_cut_total', { producer: 'http' }) - cutBefore, 1, 'the cut was not counted once');
  });
});
