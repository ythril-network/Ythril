/**
 * Integration tests: asynchronous space creation (B1).
 *
 * Space creation used to block the HTTP response until all of a space's Atlas
 * $vectorSearch indexes reached READY (up to ~60s each, 5+ of them) — far past the
 * client's 30s timeout, so the space "only appeared after a page reload". Creation
 * now returns immediately with indexStatus='building'; the space is usable at once
 * and a background task flips it to 'ready' when the indexes finish.
 *
 * Asserts: the POST returns promptly with indexStatus='building', the space is
 * immediately listable and writable, and it converges to 'ready'.
 *
 * Run: node --test testing/integration/space-creation-async.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN_ID = Date.now();

let tokenA;
const created = [];

async function spaceFromList(id) {
  const r = await get(INSTANCES.a, tokenA, '/api/spaces');
  if (r.status !== 200) return undefined;
  return r.body.spaces?.find(s => s.id === id);
}

describe('Space creation is asynchronous (B1)', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  after(async () => {
    for (const id of created) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('returns promptly with indexStatus=building and the space is usable immediately', async () => {
    const id = `b1-async-${RUN_ID}`;
    const started = Date.now();
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { id, label: 'B1 Async Create' });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 201, `create should return 201: ${JSON.stringify(r.body)}`);
    created.push(id);

    // The response must not have blocked on the (slow) vector-index READY poll.
    assert.equal(r.body.space?.indexStatus, 'building',
      'a freshly created space must report indexStatus=building, not block until ready');
    assert.ok(elapsed < 20_000, `create should return quickly, took ${elapsed}ms`);

    // Listable right away (with the status surfaced)…
    const listed = await spaceFromList(id);
    assert.ok(listed, 'new space should be listable immediately');
    assert.ok(listed.indexStatus === 'building' || listed.indexStatus === 'ready',
      `listed indexStatus should be building/ready, got ${listed.indexStatus}`);

    // …and writable right away, even while indexes are still building.
    const mem = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${id}/facts`,
      { fact: 'written while indexes were still building', tags: ['b1'] });
    assert.equal(mem.status, 201, `space must accept writes while building: ${JSON.stringify(mem.body)}`);
  });

  it('recall on a just-created space (indexes still building) returns 200, not an error', async () => {
    // Atlas refuses queries against a vector index still in INITIAL_SYNC; recall must
    // treat a building index as "no results yet" (200), not surface a 400 — otherwise
    // recall is broken for the whole window B1 opened.
    const id = `b1-recall-building-${RUN_ID}`;
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { id, label: 'B1 Recall Building' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    created.push(id);

    const rec = await post(INSTANCES.a, tokenA, '/api/brain/recall', { space: id, ...({ query: 'anything', topK: 5 }) });
    assert.equal(rec.status, 200,
      `recall on a still-building space must return 200, got ${rec.status}: ${JSON.stringify(rec.body)}`);
  });

  it('converges to indexStatus=ready once the vector indexes finish', async () => {
    const id = `b1-ready-${RUN_ID}`;
    const r = await post(INSTANCES.a, tokenA, '/api/spaces', { id, label: 'B1 Ready Converge' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    created.push(id);

    const deadline = Date.now() + 120_000;
    let status;
    while (Date.now() < deadline) {
      status = (await spaceFromList(id))?.indexStatus;
      if (status === 'ready' || status === 'failed') break;
      await new Promise(res => setTimeout(res, 2000));
    }
    assert.equal(status, 'ready', `space should reach indexStatus=ready, last: ${status}`);
  });
});
