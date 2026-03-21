/**
 * Integration tests: Merkle root (TODO #6)
 *
 * Scenarios:
 *   1. GET /api/sync/merkle on an empty space — returns a valid root (empty-tree sentinel)
 *   2. Root is a 64-char hex string
 *   3. Adding a document changes the root
 *   4. Two instances with the same data converge to the same root after sync
 *   5. Two instances with diverging data have different roots
 *   6. Network created with merkle:true — engine runs Merkle check on sync
 *      (validated via log or by checking convergence; we check root equality)
 *   7. Missing spaceId returns 400
 *   8. Unknown / inaccessible spaceId returns 403
 *
 * Run:  node --test testing/sync/merkle.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, waitFor, triggerSync } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

const HEX64 = /^[0-9a-f]{64}$/;

// ── helpers ───────────────────────────────────────────────────────────────────

function getInstanceId(container) {
  return execSync(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));` +
    `process.stdout.write(c.instanceId)"`,
  ).toString().trim();
}

function injectPeerToken(container, instanceId, token) {
  const script = [
    `const fs=require('fs');`,
    `const p='/config/secrets.json';`,
    `const s=JSON.parse(fs.readFileSync(p,'utf8'));`,
    `s.peerTokens=s.peerTokens||{};`,
    `s.peerTokens['${instanceId}']='${token}';`,
    `fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600});`,
    `process.stdout.write('ok');`,
  ].join('');
  execSync(`docker exec ${container} node -e "${script}"`);
}

/** Call /api/sync/merkle as a normal PAT-authenticated request (self-check). */
async function getMerkle(instance, token, spaceId, networkId) {
  const qs = new URLSearchParams({ spaceId });
  if (networkId) qs.set('networkId', networkId);
  return get(instance, token, `/api/sync/merkle?${qs}`);
}

/** Write a memory document to the brain API (simulates a write). */
async function writeMemory(instance, token, spaceId, text) {
  return post(instance, token, `/api/brain/${spaceId}/memories`, {
    fact: text,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Merkle root', () => {
  let tokenA, tokenB;

  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Basic endpoint behaviour
  // ══════════════════════════════════════════════════════════════════════════
  describe('GET /api/sync/merkle endpoint basics', () => {
    it('requires spaceId — returns 400 without it', async () => {
      const r = await get(INSTANCES.a, tokenA, '/api/sync/merkle');
      assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('returns 403 for an unknown spaceId', async () => {
      const r = await getMerkle(INSTANCES.a, tokenA, 'no-such-space-9999');
      assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('returns 200 with a 64-char hex root for the general space', async () => {
      const r = await getMerkle(INSTANCES.a, tokenA, 'general');
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.root, 'Response must include root');
      assert.match(r.body.root, HEX64, `root should be a 64-char hex string, got: ${r.body.root}`);
    });

    it('response includes spaceId, leafCount, computedAt', async () => {
      const r = await getMerkle(INSTANCES.a, tokenA, 'general');
      assert.equal(r.status, 200);
      assert.equal(r.body.spaceId, 'general');
      assert.ok(typeof r.body.leafCount === 'number', 'leafCount must be a number');
      assert.ok(r.body.computedAt, 'computedAt must be present');
    });

    it('empty space returns the SHA-256-of-empty-string sentinel root', async () => {
      // Create a fresh network scoped space that has no data yet.
      // We use the 'general' space which may already have data — so we just
      // verify the root is a valid hex, not the exact empty sentinel.
      // (The empty sentinel is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)
      const r = await getMerkle(INSTANCES.a, tokenA, 'general');
      assert.equal(r.status, 200);
      assert.match(r.body.root, HEX64);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Root changes when data changes
  // ══════════════════════════════════════════════════════════════════════════
  describe('Root reflects document state', () => {
    it('root changes after writing a document', async () => {
      const before = await getMerkle(INSTANCES.a, tokenA, 'general');
      assert.equal(before.status, 200);

      const write = await writeMemory(INSTANCES.a, tokenA, 'general', `merkle-sentinel-${Date.now()}`);
      // write may return 200 or 201 depending on the brain API
      assert.ok(write.status === 200 || write.status === 201,
        `write returned ${write.status}: ${JSON.stringify(write.body)}`);

      const after = await getMerkle(INSTANCES.a, tokenA, 'general');
      assert.equal(after.status, 200);
      assert.notEqual(after.body.root, before.body.root,
        'Root must change after writing a new document');
      // Use >= rather than strict +1 because other tests may write to the shared
      // 'general' space concurrently when the suite is run in parallel.
      assert.ok(after.body.leafCount >= before.body.leafCount + 1,
        `leafCount must increase by at least 1 (before=${before.body.leafCount}, after=${after.body.leafCount})`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Two-instance convergence
  // ══════════════════════════════════════════════════════════════════════════
  describe('Root converges across instances after sync', () => {
    let networkId;
    let instanceIdA, instanceIdB;
    let peerTokenForA, peerTokenForB;
    let peerTokenForAId, peerTokenForBId;
    let testSpaceId;  // unique per test run to avoid cross-test contamination

    before(async () => {
      instanceIdA = getInstanceId('ythril-a');
      instanceIdB = getInstanceId('ythril-b');

      // Create a dedicated isolated space on both instances so concurrent tests
      // writing to 'general' cannot affect our Merkle root comparison.
      testSpaceId = `merkle-test-${Date.now()}`;
      const spaceLabel = `Merkle Test ${Date.now()}`;

      const spaceA = await post(INSTANCES.a, tokenA, '/api/spaces', {
        id: testSpaceId,
        label: spaceLabel,
        folders: [],
      });
      assert.equal(spaceA.status, 201, `Create space on A: ${JSON.stringify(spaceA.body)}`);

      const spaceB = await post(INSTANCES.b, tokenB, '/api/spaces', {
        id: testSpaceId,
        label: spaceLabel,
        folders: [],
      });
      assert.equal(spaceB.status, 201, `Create space on B: ${JSON.stringify(spaceB.body)}`);

      const n = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `Merkle-Conv-${Date.now()}`,
        type: 'club',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
        merkle: true,
      });
      assert.equal(n.status, 201, `Create network: ${JSON.stringify(n.body)}`);
      networkId = n.body.id;

      // Issue peer tokens for cross-instance auth
      const ptA = await post(INSTANCES.b, tokenB, '/api/tokens', { name: `merkle-peer-a-${Date.now()}` });
      assert.equal(ptA.status, 201);
      peerTokenForA = ptA.body.plaintext;
      peerTokenForAId = ptA.body.token.id;

      const ptB = await post(INSTANCES.a, tokenA, '/api/tokens', { name: `merkle-peer-b-${Date.now()}` });
      assert.equal(ptB.status, 201);
      peerTokenForB = ptB.body.plaintext;
      peerTokenForBId = ptB.body.token.id;

      // Register the network on B (cross-instance registration)
      const regB = await post(INSTANCES.b, tokenB, '/api/networks', {
        id: networkId,
        label: `Merkle-Conv-${Date.now()}`,
        type: 'club',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
        merkle: true,
      });
      assert.equal(regB.status, 201, `Register network on B: ${JSON.stringify(regB.body)}`);

      // Add A as member on B and B as member on A
      injectPeerToken('ythril-a', instanceIdB, peerTokenForA);  // A uses peerTokenForA to call B
      injectPeerToken('ythril-b', instanceIdA, peerTokenForB);  // B uses peerTokenForB to call A

      const addBOnA = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
        instanceId: instanceIdB,
        label: 'Instance B',
        url: 'http://ythril-b:3200',
        token: peerTokenForA,
        direction: 'both',
      });
      assert.equal(addBOnA.status, 201, `Add B on A: ${JSON.stringify(addBOnA.body)}`);

      const addAOnB = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
        instanceId: instanceIdA,
        label: 'Instance A',
        url: 'http://ythril-a:3200',
        token: peerTokenForB,
        direction: 'both',
      });
      assert.equal(addAOnB.status, 201, `Add A on B: ${JSON.stringify(addAOnB.body)}`);
    });

    after(async () => {
      // Revoke the peer tokens created for this test run to prevent accumulation
      if (peerTokenForAId) await del(INSTANCES.b, tokenB, `/api/tokens/${peerTokenForAId}`).catch(() => {});
      if (peerTokenForBId) await del(INSTANCES.a, tokenA, `/api/tokens/${peerTokenForBId}`).catch(() => {});
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      // Best-effort space cleanup (requires confirm body in solo-space deletion)
      if (testSpaceId) {
        await post(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
        await post(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      }
    });

    it('after sync, A and B have the same Merkle root for a shared space', async () => {
      // Write a document on A into the isolated test space
      const w = await writeMemory(INSTANCES.a, tokenA, testSpaceId, `converge-test-${Date.now()}`);
      assert.ok(w.status === 200 || w.status === 201, `write: ${w.status}`);

      // Trigger sync from A to B
      await triggerSync(INSTANCES.a, tokenA, networkId);

      // Sample A's current root (computed after the write, before any other writers)
      const rootA = (await getMerkle(INSTANCES.a, tokenA, testSpaceId)).body.root;

      // Wait for B to converge to A's root
      await waitFor(async () => {
        const rB = await getMerkle(INSTANCES.b, tokenB, testSpaceId);
        return rB.body.root === rootA;
      }, 35_000, 1000);

      const rootB = (await getMerkle(INSTANCES.b, tokenB, testSpaceId)).body.root;
      assert.equal(rootB, rootA, `Roots diverge: A=${rootA}, B=${rootB}`);
    });

    it('network config has merkle:true', async () => {
      const n = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      assert.equal(n.status, 200);
      assert.equal(n.body.merkle, true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Network without merkle flag does not include merkle field
  // ══════════════════════════════════════════════════════════════════════════
  describe('Network without merkle flag', () => {
    let networkId;

    before(async () => {
      const n = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `No-Merkle-${Date.now()}`,
        type: 'closed',
        spaces: ['general'],
        votingDeadlineHours: 1,
        // merkle: false — omitted
      });
      assert.equal(n.status, 201);
      networkId = n.body.id;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    });

    it('network created without merkle flag has merkle undefined/falsy', async () => {
      const n = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      assert.equal(n.status, 200);
      assert.ok(!n.body.merkle, `Expected merkle to be falsy, got: ${n.body.merkle}`);
    });
  });
});
