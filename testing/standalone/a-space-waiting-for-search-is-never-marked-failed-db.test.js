/**
 * A space whose indexes are waiting for the search service is not `failed`, and finishes when the service
 * returns (Q-113) — boot, runtime creation and deletion, against real mongot.
 *
 * ## The failure this prevents
 *
 * At boot `waitForSpaceIndexesReady` polled every populated collection for up to `INDEX_READY_TIMEOUT_MS` (ten
 * minutes) even when search was not answering at all — a poll that cannot succeed, run against a service that is
 * not there — and then `finalizeSpaceIndexReady` wrote `indexStatus: 'failed'`: a red badge on a space that was
 * perfectly healthy and only early. The canary operator's own words for what that does to an operator apply: a
 * red badge that is wrong trains them to stop reading red badges.
 *
 * ## The contract
 *
 *  - while search is down, `waitForSpaceIndexesReady` returns the verdict `deferred` AT ONCE and asks the
 *    database nothing about the space's indexes (no polling);
 *  - `finalizeSpaceIndexReady` writes NO status for `deferred` — not `ready`, and never `failed`, the optional
 *    face index included; the space stays `building`, which is what it is;
 *  - the boot summary counts `deferred` separately, never as failed and never as "confirmed for all";
 *  - when search returns, the confirmation completes by itself for spaces deferred at boot and for spaces created
 *    at runtime, and a space deleted in the meantime is not resurrected by the late confirmation.
 *
 * The outage is simulated BELOW the server (`_search-outage.mjs`); the database, the driver, mongot and every
 * index are real.
 *
 * Not measured here: the `FINALIZE_CONCURRENCY` bound on the late confirmation. The spaces' own index builds and
 * the presence module's reconcile make the same calls at the same instant, so no count taken from outside can
 * tell the bounded confirmations from the unbounded reconciles; `startup-index-wait.test.js` pins that the late
 * confirmation goes through the same `mapLimit(…, FINALIZE_CONCURRENCY, …)` as the boot one.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`, or a scratch one pointed at with
 * YTHRIL_TEST_MONGO_PORT / YTHRIL_TEST_MONGO_CREDS= — CI runs it against the test stack.
 *
 * Run: node --test testing/standalone/a-space-waiting-for-search-is-never-marked-failed-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder } from './_vector-harness.mjs';
import { installSearchOutage } from './_search-outage.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const WAIT = 'bootwait';
const BOOT = ['bd1', 'bd2', 'bd3', 'bd4', 'bd5'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bootdown-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';
// The optional face gallery is ON: it must be unable to condemn a space that is merely waiting.
process.env['FACE_RECOGNITION_ENABLED'] = 'true';

let mongo, loader, lifecycle, vectorIndex, readiness, outage, stub, unsubscribe;
const lines = [];
const seen = new Map();   // space id -> every indexStatus observed
let sampler;
let seq = 0;
const rec = (spaceId, id, extra = {}) => {
  const now = new Date().toISOString();
  return { _id: id, spaceId, name: id, type: 'thing', tags: [], properties: {}, embedding: unitAt(5, DIMS),
    embeddingModel: 'stub', seq: ++seq, createdAt: now, updatedAt: now, ...extra };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const statusOf = (id) => loader.getConfig().spaces.find(s => s.id === id)?.indexStatus;
const spaceDef = (id) => ({ id, label: id, folders: [], completeLinkage: true });

async function eventually(what, fn, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last === true) return;
    await sleep(300);
  }
  assert.fail(`${what} did not happen within ${timeoutMs} ms (last: ${JSON.stringify(last)})`);
}

describe('a space waiting for search is never marked failed', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'bootdown', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [WAIT, ...BOOT].map(spaceDef),
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('bootdown');
    for (const id of [WAIT, ...BOOT]) {
      await mongo.col(`${id}_facts`).insertOne(rec(id, `${id}-f`));
      await mongo.col(`${id}_facts`).createIndex({ seq: 1 });
    }
    // A file record too, so the optional face poll WOULD run for this space if nothing stopped it.
    await mongo.col(`${WAIT}_files`).insertOne(rec(WAIT, `${WAIT}-file`, { path: 'a.png', mimeType: 'image/png' }));
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    readiness = await import('../../server/dist/spaces/search-readiness.js');
    await mongo.checkVectorSearchAvailability();
    const log = await import('../../server/dist/util/log.js');
    unsubscribe = log.subscribeLogLines(l => lines.push(l));
    outage = installSearchOutage(mongo);
    sampler = setInterval(() => {
      for (const s of loader.getConfig().spaces) {
        if (!seen.has(s.id)) seen.set(s.id, new Set());
        seen.get(s.id).add(s.indexStatus);
      }
    }, 50);
    sampler.unref();
    readiness.resetSearchReadyProbe();
    outage.setDown(true);
    assert.equal(await readiness.searchAvailable(), false, 'fixture check: the simulated outage must read as down');
  });

  after(async () => {
    clearInterval(sampler);
    unsubscribe?.();
    outage?.restore();
    readiness?.resetSearchReadyProbe();
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('waitForSpaceIndexesReady on a down service answers `deferred` at once and polls nothing', async () => {
    const before = ['facts', 'entities', 'edges', 'chrono', 'files'].reduce((n, s) => n + outage.calls('listSearchIndexes', `${WAIT}_${s}`), 0);
    const started = Date.now();
    const verdict = await Promise.race([
      vectorIndex.waitForSpaceIndexesReady(WAIT, { timeoutMs: 600_000 }),
      sleep(20_000).then(() => 'still waiting after 20 s'),
    ]);
    assert.equal(verdict, 'deferred', 'a down search service must be reported as deferred, not as ready, failed or pending');
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms: it polled a service that is not there`);
    const after = ['facts', 'entities', 'edges', 'chrono', 'files'].reduce((n, s) => n + outage.calls('listSearchIndexes', `${WAIT}_${s}`), 0);
    assert.equal(after, before, 'listSearchIndexes was called on the space\'s collections — that is the poll this change removes');
  });

  it('finalizeSpaceIndexReady writes no status for it: the space stays building, and never failed (face index on)', async () => {
    loader.mutateConfig(cfg => { cfg.spaces.find(s => s.id === WAIT).indexStatus = 'building'; });
    const verdict = await vectorIndex.finalizeSpaceIndexReady(WAIT, { timeoutMs: 600_000 });
    assert.notEqual(verdict, true, 'a deferred confirmation reported success');
    assert.notEqual(verdict, false, 'a deferred confirmation reported failure');
    assert.equal(statusOf(WAIT), 'building', `the status became ${statusOf(WAIT)} — a late service must leave the space building`);
    assert.ok(!lines.some(l => new RegExp(`Space '${WAIT}'.*(marked failed|did not reach READY)`).test(l)),
      'the confirmation still logged a failure for a space that is only waiting');
    assert.ok(!lines.some(l => new RegExp(`Space '${WAIT}'.*face gallery index.*not ready`).test(l)),
      'the optional face index was polled (and blamed) although search was not answering');
  });

  it('boot on a down service: every space stays building, the summary counts deferred separately and says nothing false', async () => {
    const from = lines.length;
    await lifecycle.initAllSpaces();
    await eventually('the boot confirmation pass reporting', () => lines.slice(from).some(l => /deferred/i.test(l)), 60_000);
    const mine = lines.slice(from);
    for (const id of [WAIT, ...BOOT]) assert.equal(statusOf(id), 'building', `${id} is ${statusOf(id)} after a boot with search down`);
    const summary = mine.find(l => /deferred/i.test(l) && /\b6\b/.test(l));
    assert.ok(summary, `no summary line counts the 6 deferred spaces:\n${mine.filter(l => /Vector|index/i.test(l)).join('\n')}`);
    assert.ok(!mine.some(l => /confirmed for all/i.test(l)), 'the summary claimed every space was confirmed');
    assert.ok(!mine.some(l => /did not reach ready|marked failed/i.test(l)), 'a space that is only waiting was reported as failed');
  });

  it('a space created at runtime while down, and one created then deleted, are handled when search returns', async () => {
    await mongo.col('bootnew_facts').insertOne(rec('bootnew', 'bootnew-f'));
    await lifecycle.createSpace({ id: 'bootnew', label: 'bootnew' }, { tokenId: null });
    await lifecycle.createSpace({ id: 'bootgone', label: 'bootgone' }, { tokenId: null });
    assert.equal(await lifecycle.removeSpace('bootgone'), true);
    assert.equal(statusOf('bootnew'), 'building');
    await sleep(500);
    assert.equal(statusOf('bootnew'), 'building', 'a runtime-created space was marked something while search was down');
  });

  it('when search returns every space completes by itself, none was ever failed, and the deleted one stays deleted', async () => {
    outage.setDown(false);
    const all = [WAIT, ...BOOT, 'bootnew'];
    await eventually('every waiting space reaching ready', () => all.every(id => statusOf(id) === 'ready') || all.map(id => `${id}:${statusOf(id)}`));
    for (const [id, set] of seen) assert.ok(!set.has('failed'), `${id} was marked failed at some point (saw ${[...set].join(', ')})`);
    await sleep(1_500);
    const names = (await mongo.getDb().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
    assert.deepEqual(names.filter(n => n.startsWith('bootgone_')), [],
      'the late confirmation resurrected a space that was deleted while it waited');
    assert.ok(!loader.getConfig().spaces.some(s => s.id === 'bootgone'));
    assert.ok(!lines.some(l => /bootgone/.test(l) && /(failed|error)/i.test(l) && /ndex/.test(l)),
      'a deleted space\'s confirmation reported a failure');
  });
});
