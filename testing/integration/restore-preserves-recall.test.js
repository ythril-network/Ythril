/**
 * Integration test: restoring a backup must not silently destroy semantic recall.
 *
 * THE BUG THIS PINS (found 2026-07-21). `restoreDatabase()` drops every collection before reloading
 * it, and dropping a collection destroys its vector search index with it. Nothing rebuilt them, so
 * after a restore:
 *
 *   - `saveFact` kept working and kept storing real vectors;
 *   - `recall` returned an empty result set FOREVER;
 *   - `/ready` still reported `vectorSearch: ok`, because that probes the capability, not whether a
 *     given space's index exists.
 *
 * Every symptom pointed away from the cause. Disaster recovery appeared to succeed while quietly
 * leaving the instance without the feature it exists for. It surfaced only because 19 integration
 * tests had been skipping themselves with a misleading "Embedding server not configured" message
 * ever since a restore ran earlier in the same suite.
 *
 * The invariant is deliberately expressed end-to-end — store, restore, recall — rather than by
 * asserting an index exists. An index that exists but does not answer queries would pass the narrow
 * check and still leave recall broken.
 *
 * Run: node --test testing/integration/restore-preserves-recall.test.js
 * Pre-requisite: the test stack (`npm run test:up`).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';
import { waitForReading } from '../_shared/wait-for.mjs';
import { restoreLeavingOutStrays } from '../_shared/restore-leaving-out-strays.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let tokenA;

/**
 * Poll recall until the fact comes back. Vector indexing is asynchronous, so a single immediate
 * check proves nothing — that assumption is what made the original probe unable to ever succeed.
 */
async function recallEventually(query, { timeoutMs = 120_000, intervalMs = 3_000, what } = {}) {
  // THROWS at the deadline, naming `what` and the last answer recall gave (its status and body).
  return waitForReading(
    () => post(INSTANCES.a, tokenA, '/api/brain/recall', { space: 'general', query, topK: 3 }),
    (r) => r.status === 200 && (r.body?.count ?? r.body?.results?.length ?? 0) > 0,
    timeoutMs, intervalMs, { what });
}

describe('restore preserves semantic recall', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('recall still works after restoring a backup', async () => {
    const fact = `restore-recall-probe-${RUN} pangolin telemetry`;

    // 1. Store something recallable and confirm it is actually recallable BEFORE the restore, so a
    //    failure afterwards cannot be blamed on the fact never having been indexed.
    const stored = await post(INSTANCES.a, tokenA, '/api/brain/spaces/general/facts', { fact, tags: ['restore-test'] });
    assert.equal(stored.status, 201, `store failed: ${JSON.stringify(stored.body)}`);

    await recallEventually(fact, { what: 'PRECONDITION: the fact to be recallable even before restoring' });

    // 2. Take a backup that contains it.
    const backup = await post(INSTANCES.a, tokenA, '/api/admin/data/backup', {});
    assert.equal(backup.status, 200, `backup failed: ${JSON.stringify(backup.body)}`);

    const list = await get(INSTANCES.a, tokenA, '/api/admin/data/backups');
    assert.equal(list.status, 200);
    const latest = (list.body?.backups ?? [])[0];
    assert.ok(latest?.id, `no backup listed: ${JSON.stringify(list.body)}`);

    // 3. Restore it. This is the step that used to destroy every vector index.
    // Since bundle-157 a restore is a set of space acts: answered 202 when they are registered, its outcome read from GET /restore.
    // Another integration file's deleted space is left out of the backup's restore, never 'general', which holds the fact.
    const restored = await restoreLeavingOutStrays(body => post(INSTANCES.a, tokenA, '/api/admin/data/restore', body), latest.id, { mustKeep: ['general'] });
    assert.equal(restored.status, 202, `restore failed: ${JSON.stringify(restored.body)}`);
    const report = await waitForReading(
      () => get(INSTANCES.a, tokenA, '/api/admin/data/restore'),
      (r) => r.status === 200 && r.body?.restoreId === restored.body.restoreId && r.body?.state !== 'running',
      300_000, 2_000, { what: 'the restore to end' });
    assert.equal(report.body.state, 'completed', `the restore did not complete: ${JSON.stringify(report.body)}`);

    // The report should say what it rebuilt — an operator needs to know recall is warming up
    // rather than broken.
    const spaces = report.body.spaces ?? [];
    assert.ok(spaces.length > 0 && spaces.every(s => s.vectorIndexes !== undefined),
      `the restore report must give each space's vector index result, got: ${JSON.stringify(report.body)}`);
    assert.deepEqual(spaces.filter(s => s.vectorIndexes === 'failed').map(s => s.id), [], 'no space may fail to rebuild its indexes');

    // 4. The invariant: recall works again. Generous budget — a rebuild plus indexing is slow, and
    //    the point is that it RECOVERS, not that it is instant.
    await recallEventually(fact, {
      timeoutMs: 180_000,
      what: 'recall to bring the fact back after a restore (it returned nothing: the vector index was destroyed and not rebuilt, '
        + 'which is silent data-feature loss)',
    });
  });
});
