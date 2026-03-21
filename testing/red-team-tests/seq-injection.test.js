/**
 * Red-team tests: seq injection and forkOf depth bomb attacks.
 *
 * Attack vectors:
 *
 * 1. seq = Number.MAX_SAFE_INTEGER injection
 *    By submitting a memory/entity/edge with seq = Number.MAX_SAFE_INTEGER (9007199254740991),
 *    an attacker permanently poisons the high-water mark for that space.
 *    All future legitimate writes will have a lower seq and be seen as "older",
 *    causing every subsequent sync to silently ignore real data.
 *
 * 2. forkOf depth bomb
 *    When two peers arrive with equal seq but different content, the engine
 *    creates a "fork" child document.  Without a depth/count limit, an attacker
 *    can repeat this (different content, equal seq, same _id) to produce an
 *    unbounded chain of forkOf-linked documents — a linear chain that grows
 *    the DB unboundedly.
 *
 * Both of these tests are EXPECTED TO FAIL (server returns 200 instead of 400)
 * until the fixes are applied:
 *  - seq injection:  reject if seq > MAX_ALLOWED_SEQ (e.g., Number.MAX_SAFE_INTEGER / 2)
 *  - forkOf bomb:    reject if the forkOf chain for a given _id exceeds MAX_FORK_DEPTH (e.g., 10)
 *
 * Run: node --test testing/red-team-tests/seq-injection.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991

let token;

describe('seq injection — MAX_SAFE_INTEGER poisons the high-water mark', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('Memory with seq = MAX_SAFE_INTEGER must be rejected with 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: `seq-poison-mem-${Date.now()}`,
      spaceId: 'general',
      fact: 'seq poison payload',
      seq: MAX_SAFE,
      embedding: [],
      tags: [],
      entityIds: [],
      author: { instanceId: 'attacker', instanceLabel: 'Attacker' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      embeddingModel: 'none',
    });
    assert.equal(r.status, 400,
      `VULNERABILITY: seq = MAX_SAFE_INTEGER was accepted (got ${r.status} ${JSON.stringify(r.body)}).\n` +
      `Add a seq cap check to the sync POST memories endpoint.`);
  });

  it('Entity with seq = MAX_SAFE_INTEGER must be rejected with 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/entities?spaceId=general', {
      _id: `seq-poison-ent-${Date.now()}`,
      spaceId: 'general',
      name: 'PoisonEntity',
      type: 'concept',
      tags: [],
      seq: MAX_SAFE,
      author: { instanceId: 'attacker', instanceLabel: 'Attacker' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400,
      `VULNERABILITY: Entity seq = MAX_SAFE_INTEGER was accepted (got ${r.status}).`);
  });

  it('Memory with a legitimate high-but-valid seq is accepted', async () => {
    // seq values up to e.g. 2^50 should be fine — only truly extreme values blocked
    const reasonableSeq = Math.floor(MAX_SAFE / 10); // still enormous but not MAX
    const r = await post(INSTANCES.a, token, '/api/sync/memories?spaceId=general', {
      _id: `seq-valid-high-${Date.now()}`,
      spaceId: 'general',
      fact: 'high but valid seq',
      seq: reasonableSeq,
      embedding: [],
      tags: [],
      entityIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      embeddingModel: 'none',
    });
    assert.equal(r.status, 200,
      `False positive: a reasonable-but-large seq was blocked (got ${r.status}).`);
  });

  it('After seq poison attempt, normal write still gets a valid seq', async () => {
    // This validates that even if a poisoned doc slips through, the nextSeq()
    // function does not start returning MAX_SAFE + 1 (which would overflow).
    // After a fix, the poison doc is rejected, so nextSeq should still be healthy.
    const r = await post(INSTANCES.a, token, '/api/brain/general/memories', {
      fact: `seq health check ${Date.now()}`,
    });
    assert.equal(r.status, 201, `Write after poison attempt: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.seq === 'number', 'seq must be a number');
    assert.ok(r.body.seq < MAX_SAFE, `seq overflow: got ${r.body.seq}`);
  });
});

// ── forkOf depth bomb ──────────────────────────────────────────────────────

describe('forkOf depth bomb — fork chain must be capped', () => {
  const TARGET_ID = `fork-bomb-${Date.now()}`;
  const MAX_FORK_DEPTH = 10; // expected cap
  const SAME_SEQ = 5000;

  let token2;

  before(() => {
    token2 = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Seed the original document
  });

  it('Seed the original document (seq=5000)', async () => {
    const r = await post(INSTANCES.a, token2, '/api/sync/memories?spaceId=general', {
      _id: TARGET_ID,
      spaceId: 'general',
      fact: 'fork-bomb original version',
      seq: SAME_SEQ,
      embedding: [],
      tags: [],
      entityIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      embeddingModel: 'none',
    });
    assert.equal(r.status, 200, `Seed: ${JSON.stringify(r.body)}`);
    assert.ok(['inserted', 'updated', 'skipped'].includes(r.body.status),
      `Unexpected status: ${r.body.status}`);
  });

  it(`After ${MAX_FORK_DEPTH + 1} conflicting forks, next one must be rejected with 400`, async () => {
    // Push MAX_FORK_DEPTH conflicting docs (different content, same seq, same _id)
    for (let i = 1; i <= MAX_FORK_DEPTH; i++) {
      const r = await post(INSTANCES.a, token2, '/api/sync/memories?spaceId=general', {
        _id: TARGET_ID,
        spaceId: 'general',
        fact: `fork-bomb variant ${i} — unique content to force fork ${Date.now()}-${i}`,
        seq: SAME_SEQ,
        embedding: [],
        tags: [],
        entityIds: [],
        author: { instanceId: `attacker-${i}`, instanceLabel: `Attacker ${i}` },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        embeddingModel: 'none',
      });
      // These may succeed or start returning 400 before the limit — both are OK
      if (r.status === 400) {
        // Already being blocked — pass the test early
        return;
      }
      assert.equal(r.status, 200, `Fork ${i}: ${JSON.stringify(r.body)}`);
    }

    // The (MAX_FORK_DEPTH + 1)-th fork must now be blocked
    const r = await post(INSTANCES.a, token2, '/api/sync/memories?spaceId=general', {
      _id: TARGET_ID,
      spaceId: 'general',
      fact: `fork-bomb OVER LIMIT — this one must be rejected ${Date.now()}`,
      seq: SAME_SEQ,
      embedding: [],
      tags: [],
      entityIds: [],
      author: { instanceId: 'attacker-bomb', instanceLabel: 'Attacker Bomb' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      embeddingModel: 'none',
    });
    assert.equal(r.status, 400,
      `VULNERABILITY: forkOf depth ${MAX_FORK_DEPTH + 1} was accepted (got ${r.status}).\n` +
      `Add a MAX_FORK_DEPTH check to the upsertMemory/sync POST handler.`);
  });
});
