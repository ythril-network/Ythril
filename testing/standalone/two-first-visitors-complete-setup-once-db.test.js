/**
 * Two first visitors posting setup at the same moment complete it ONCE: one is let in, the other is refused, and the identity the first wrote
 * is the one the instance keeps (Q-350 a, bundle-70 S1).
 *
 * ## The rule
 *
 * `POST /api/setup/json` is unauthenticated and writes the instance's identity (its id, its first admin token). Whatever the number of people
 * who reach it while the instance is new, exactly one of them completes setup: the others are answered `409` while it runs and `404 Already
 * configured` once it has, and none writes over the config the first wrote. A second identity written over the first would orphan the first
 * visitor's token, and the instance would belong to whoever posted last.
 *
 * ## What the single-flight is for, and what this file can and cannot show
 *
 * The status check and the config write are one synchronous step today (`saveConfig` writes before it returns), so on the tree that has no
 * single-flight this file PASSES too: the file the first request wrote is what the second request's check finds. This is a pin, not a
 * red-then-green test, and it says so: the claim in `setup/routes.ts` guards the day a step that awaits is put between the check and the write
 * (the check now reads the boot's answer, `isFirstRun`, which flips only when setup says so), and this file is what notices.
 *
 * ## How it runs
 *
 * The real `setupRouter` over HTTP against a real Mongo (setup starts the instance's services and mints the token through it), two POSTs sent
 * together, then a third. The temp config directory starts EMPTY, which is the first run.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/two-first-visitors-complete-setup-once-db.test.js`   (requires a server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-setup-once-'));
const CONFIG = path.join(root, 'config.json');
process.env['CONFIG_PATH'] = CONFIG;
process.env['DATA_ROOT'] = path.join(root, 'data');

/** One request; resolves `{ status, json }`. */
function post(origin, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(origin + urlPath, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('two first visitors complete setup once', { skip }, () => {
  let server;
  before(async () => {
    await openTestMongo('setuponce');
    const { setupRouter } = await import('../../server/dist/setup/routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/setup', setupRouter);
    server = await listenOnLoopback(http.createServer(app));
  });
  after(async () => {
    await server?.close();
    try { await (await import('../../server/dist/schedulers.js')).closeScheduling({ withinMs: 5000 }); } catch { /* never started */ }
    await closeTestMongo();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('two POSTs sent together: one 201, the other refused; a third is refused; the config holds the first identity only', { timeout: 120_000 }, async () => {
    assert.equal(fs.existsSync(CONFIG), false, 'fixture check: the instance must be new');
    const answers = await Promise.all([
      post(server.url, '/api/setup/json', { label: 'first visitor' }),
      post(server.url, '/api/setup/json', { label: 'second visitor' }),
    ]);
    const created = answers.filter(a => a.status === 201);
    assert.equal(created.length, 1, `want exactly one setup to complete, got statuses ${JSON.stringify(answers.map(a => a.status))}`);
    const refused = answers.find(a => a.status !== 201);
    assert.ok([404, 409].includes(refused.status), `the second visitor was answered ${refused.status}, not 404 (configured) or 409 (running)`);
    const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const labelOfWinner = answers[0].status === 201 ? 'first visitor' : 'second visitor';
    assert.equal(config.instanceLabel, labelOfWinner, 'the config holds the identity of the visitor who was not let in');
    assert.equal(config.tokens.length, 1, `the config holds ${config.tokens.length} admin tokens: the second visitor's setup ran over the first's`);
    const later = await post(server.url, '/api/setup/json', { label: 'third visitor' });
    assert.equal(later.status, 404, 'a setup after the first completed was not refused');
    assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).instanceLabel, labelOfWinner, 'a later setup wrote over the identity');
  });
});
