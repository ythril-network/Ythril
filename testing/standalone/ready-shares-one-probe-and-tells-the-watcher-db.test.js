/**
 * `/ready` and the search watcher agree, and concurrent `/ready` requests share one probe (Q-113).
 *
 * ## Two rules, one file, because they are the same module
 *
 * 1. **`/ready` tells the watcher.** `getReadiness` runs its own search probe. When that probe succeeds the
 *    search-readiness state must become `up` (`noteSearchUp()`), or `/ready` would answer 200 while recall stays
 *    empty for up to five more minutes until the watcher's own timer fires: two components answering the same
 *    question differently. The converse is also pinned: a FAILED `/ready` probe never marks the service `down` —
 *    `/ready` is public and unauthenticated, so anyone able to make it fail would otherwise be able to start the
 *    watcher's slow-down and the hourly warn.
 * 2. **One probe for a burst.** `getReadiness` cached its answer only AFTER the probe finished, so N concurrent
 *    unauthenticated requests arriving inside one slow probe ran N probes against the database (each a
 *    `listSearchIndexes` plus an admin ping). The orchestrator's probe interval and a curious client are both
 *    that burst. A single in-flight promise is shared instead.
 *
 * The probe failure is simulated BELOW the server (`_search-outage.mjs`); the database and the driver are real.
 *
 * Needs a MongoDB (mongot for the heal case): `npm run test:up`, or a scratch one pointed at with
 * YTHRIL_TEST_MONGO_PORT / YTHRIL_TEST_MONGO_CREDS= — CI runs it against the test stack.
 *
 * Run: node --test testing/standalone/ready-shares-one-probe-and-tells-the-watcher-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { installSearchOutage } from './_search-outage.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-ready-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ spaces: [], networks: [], tokens: [] }));

/** `getReadiness` caches for 2 s; a case that needs a fresh probe waits it out. */
const CACHE_EXPIRY_MS = 2_300;

let mongo, readiness, ready, outage;

describe('/ready and the search watcher', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('readyshare');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    readiness = await import('../../server/dist/spaces/search-readiness.js');
    ready = await import('../../server/dist/ready.js');
    outage = installSearchOutage(mongo, { instantAnswers: true });
  });

  after(async () => {
    outage?.restore();
    readiness?.resetSearchReadyProbe();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a failed /ready probe never marks the service down — only the watcher decides that', async () => {
    readiness.resetSearchReadyProbe();
    outage.setDown(true);
    const r = await ready.getReadiness();
    assert.equal(r.checks.vectorSearch.status, 'error', 'fixture check: the simulated outage must fail the /ready probe');
    assert.equal(readiness.searchReadinessSnapshot().state, 'unknown', '/ready set the state from a failure');
  });

  it('a successful /ready probe marks the service up at once and calls the waiters, before the watcher would', async () => {
    await sleep(CACHE_EXPIRY_MS);
    // Put the singleton into `down` the way production does: a cold window that ends unanswered.
    assert.equal(await readiness.searchAvailable(), false);
    assert.equal(readiness.searchReadinessSnapshot().state, 'down');
    let called = 0;
    readiness.afterSearchUp('ready-test', () => { called++; });

    await sleep(CACHE_EXPIRY_MS);
    outage.setDown(false);
    const r = await ready.getReadiness();
    assert.equal(r.checks.vectorSearch.status, 'ok');
    // No waiting on the watcher's own timer (its first delay is 2.5 s at the soonest): /ready's answer and the
    // state are the same fact.
    assert.equal(readiness.searchReadinessSnapshot().state, 'up', '/ready said search answers while the readiness state still says down');
    await sleep(50);
    assert.equal(called, 1, 'the waiters were not called by /ready\'s success');
  });

  it('concurrent /ready requests share one probe', async () => {
    await sleep(CACHE_EXPIRY_MS);
    const before = outage.calls('listSearchIndexes', '_ready_probe');
    const answers = await Promise.all(Array.from({ length: 12 }, () => ready.getReadiness()));
    assert.equal(outage.calls('listSearchIndexes', '_ready_probe') - before, 1,
      'twelve concurrent requests ran more than one search probe — each is a listSearchIndexes against the database');
    assert.ok(answers.every(a => a === answers[0] || JSON.stringify(a) === JSON.stringify(answers[0])), 'the sharers got different answers');
  });
});
