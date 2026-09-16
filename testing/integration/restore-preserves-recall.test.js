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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let tokenA;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Poll recall until the fact comes back. Vector indexing is asynchronous, so a single immediate
 * check proves nothing — that assumption is what made the original probe unable to ever succeed.
 */
async function recallEventually(query, { timeoutMs = 120_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await post(INSTANCES.a, tokenA, '/api/brain/recall', { space: 'general', query, topK: 3 });
    last = r;
    if (r.status === 200 && (r.body?.count ?? r.body?.results?.length ?? 0) > 0) {
      return { ok: true, elapsedMs: timeoutMs - (deadline - Date.now()), body: r.body };
    }
    await sleep(intervalMs);
  }
  return { ok: false, last };
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

    const before = await recallEventually(fact);
    assert.ok(before.ok, `precondition failed — the fact was never recallable even before restoring: ${JSON.stringify(before.last?.body)}`);

    // 2. Take a backup that contains it.
    const backup = await post(INSTANCES.a, tokenA, '/api/admin/data/backup', {});
    assert.equal(backup.status, 200, `backup failed: ${JSON.stringify(backup.body)}`);

    const list = await get(INSTANCES.a, tokenA, '/api/admin/data/backups');
    assert.equal(list.status, 200);
    const latest = (list.body?.backups ?? [])[0];
    assert.ok(latest?.id, `no backup listed: ${JSON.stringify(list.body)}`);

    // 3. Restore it. This is the step that used to destroy every vector index.
    const restored = await post(INSTANCES.a, tokenA, '/api/admin/data/restore', { backupId: latest.id });
    assert.equal(restored.status, 200, `restore failed: ${JSON.stringify(restored.body)}`);

    // The response should say what it rebuilt — an operator needs to know recall is warming up
    // rather than broken.
    assert.ok(
      Array.isArray(restored.body?.vectorIndexes?.rebuilding),
      `restore response must report rebuilt vector indexes, got: ${JSON.stringify(restored.body)}`,
    );
    assert.deepEqual(restored.body.vectorIndexes.failed, [], 'no space may fail to rebuild its indexes');

    // 4. The invariant: recall works again. Generous budget — a rebuild plus indexing is slow, and
    //    the point is that it RECOVERS, not that it is instant.
    const after = await recallEventually(fact, { timeoutMs: 180_000 });
    assert.ok(
      after.ok,
      'recall returned nothing after a restore — the vector index was destroyed and not rebuilt, ' +
      `which is silent data-feature loss: ${JSON.stringify(after.last?.body)}`,
    );
  });
});
