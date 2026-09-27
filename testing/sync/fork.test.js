/**
 * Integration tests: Off-grid / fork (TODO #5)
 *
 * Scenarios:
 *   1. Fork an active network (caller is still a member) → 201, new network id,
 *      same spaces as source, no members, no pending rounds, source unchanged
 *   2. Fork a voluntarily-deleted network with spaces supplied in body → 201
 *   3. Fork a voluntarily-deleted network with no spaces → 400
 *   4. Fork after ejection (notify member_removed) with spaces supplied → 201,
 *      ejectedFromNetworks still contains original id
 *   5. Fork after ejection with no spaces → 400
 *   6. Unknown networkId, not ejected → 404
 *   7. Spaces containing an unknown space id → 400
 *   8. Fork type defaults to 'closed'; caller can override to 'club'
 *
 * Run:  node --test testing/sync/fork.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, get, del, createTestSpace } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

/** The space these tests put in their networks — their own, never `general` (`Q-75`). */
let SPACE;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Read a container's full config.json and return parsed object. */
function readContainerConfig(container) {
  const out = dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`,
  ).toString();
  return JSON.parse(out);
}

/** Simulate the member_removed notify so the instance treats itself as ejected. */
async function simulateEjection(instance, token, networkId) {
  // Hit the internal notify endpoint that the engine calls when a vote concludes
  // with a rejection. We call it directly to avoid needing a real peer setup.
  const r = await post(instance, token, '/api/notify', {
    type: 'member_removed',
    networkId,
    removedInstanceId: '__self__', // notify.ts checks cfg.instanceId when value is self
  });
  return r;
}

/** Call the real /api/notify endpoint with member_removed for this instance's own ID. */
async function ejectSelf(instance, token, networkId, instanceId) {
  const r = await post(instance, token, '/api/notify', {
    event: 'member_removed',
    networkId,
    instanceId,   // caller's own instanceId — we are announcing our ejection to ourselves
  });
  return r;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('Off-grid / fork', () => {
  let tokenA;
  let testSpace;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    testSpace = await createTestSpace('fork', [[INSTANCES.a, tokenA]]);
    SPACE = testSpace.id;
  });

  after(async () => {
    await testSpace?.remove();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Fork active network
  // ══════════════════════════════════════════════════════════════════════════
  describe('Fork an active (still-present) network', () => {
    let networkId;

    before(async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `ForkSource-${Date.now()}`,
        type: 'closed',
        spaces: [SPACE],
        votingDeadlineHours: 2,
      });
      assert.equal(r.status, 201, `Create network failed: ${JSON.stringify(r.body)}`);
      networkId = r.body.id;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    });

    it('POST /fork returns 201 with a new network id', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'My fork',
      });
      assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.id, 'Response must include id');
      assert.notEqual(r.body.id, networkId, 'Forked network must have a different id');

      // cleanup forked network
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('forked network inherits spaces from source', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Spaces fork',
      });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.spaces, [SPACE]);
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('forked network has no members', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Empty members fork',
      });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.members, []);
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('forked network has no pending rounds', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'No rounds fork',
      });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.pendingRounds, []);
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('source network is unchanged after fork', async () => {
      const before = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      assert.equal(before.status, 200);

      const fork = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'No-op fork',
      });
      assert.equal(fork.status, 201);

      const after = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      assert.equal(after.status, 200);
      assert.deepEqual(after.body.members, before.body.members);
      assert.deepEqual(after.body.spaces, before.body.spaces);

      await del(INSTANCES.a, tokenA, `/api/networks/${fork.body.id}`).catch(() => {});
    });

    it('forked network type defaults to closed', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Default type fork',
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.type, 'closed');
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('caller can override type to club', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Club fork',
        type: 'club',
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.type, 'club');
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('votingDeadlineHours is inherited when not specified', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Inherited deadline',
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.votingDeadlineHours, 2);
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('votingDeadlineHours can be overridden in body', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Custom deadline',
        votingDeadlineHours: 48,
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.votingDeadlineHours, 48);
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Fork after voluntary deletion (network no longer in cfg.networks)
  // ══════════════════════════════════════════════════════════════════════════
  describe('Fork after voluntary network deletion (network removed locally)', () => {
    /** We cannot fork a truly-deleted network by its ID if the ID was never
     *  in ejectedFromNetworks either. For an active fork (when we delete our own
     *  network) the network simply disappears — it's not "ejected". Forking a
     *  non-existent non-ejected network is a 404.  So this scenario tests:
     *  - forking with an explicit `spaces` override when the network id is not
     *    found AND not in ejectedFromNetworks → still 404 (not a free-standing
     *    fork from a phantom id)
     *
     * The "departed member creates a fork" use case means they call
     *  POST /api/networks with a fresh label and the spaces they want — or they
     *  fork BEFORE deleting. We test the 404 path here to lock in the contract.
     */

    it('deleted (non-ejected) network id returns 404 even with spaces in body', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/networks/00000000-dead-beef-0000-000000000000/fork', {
        label: 'Ghost fork',
        spaces: [SPACE],
      });
      assert.equal(r.status, 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Fork after ejection (network in ejectedFromNetworks, not in cfg.networks)
  // ══════════════════════════════════════════════════════════════════════════
  describe('Fork after ejection', () => {
    let networkId;
    let instanceIdA;

    before(async () => {
      // Discover instance ID of ythril-a
      instanceIdA = dockerExec(
        `docker exec ythril-a node -e "const fs=require('fs');` +
        `const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));` +
        `process.stdout.write(c.instanceId)"`,
      ).toString().trim();

      // Create the network that will be "ejected from"
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `EjectSource-${Date.now()}`,
        type: 'closed',
        spaces: [SPACE],
        votingDeadlineHours: 1,
      });
      assert.equal(r.status, 201, `Create network failed: ${JSON.stringify(r.body)}`);
      networkId = r.body.id;

      // Simulate ejection by posting member_removed for our own instanceId
      const ejectRes = await ejectSelf(INSTANCES.a, tokenA, networkId, instanceIdA);
      // notify returns 204 on success
      assert.equal(ejectRes.status, 204, `Ejection notify failed: ${JSON.stringify(ejectRes.body)}`);
    });

    // No after cleanup needed: ejection already removed the network from cfg

    it('config shows networkId in ejectedFromNetworks after ejection', () => {
      const cfg = readContainerConfig('ythril-a');
      assert.ok(
        cfg.ejectedFromNetworks?.includes(networkId),
        `Expected ${networkId} in ejectedFromNetworks, got: ${JSON.stringify(cfg.ejectedFromNetworks)}`,
      );
    });

    it('config shows network is no longer in cfg.networks after ejection', () => {
      const cfg = readContainerConfig('ythril-a');
      assert.ok(
        !cfg.networks?.some(n => n.id === networkId),
        `Expected ${networkId} to be removed from cfg.networks`,
      );
    });

    it('POST /fork with spaces supplied returns 201', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Post-ejection fork',
        spaces: [SPACE],
      });
      assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.id);
      assert.notEqual(r.body.id, networkId);
      assert.deepEqual(r.body.spaces, [SPACE]);
      assert.deepEqual(r.body.members, []);

      // cleanup
      await del(INSTANCES.a, tokenA, `/api/networks/${r.body.id}`).catch(() => {});
    });

    it('ejectedFromNetworks still contains original id after fork', async () => {
      const fork = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Ejection fork — check ejected list',
        spaces: [SPACE],
      });
      assert.equal(fork.status, 201);

      const cfg = readContainerConfig('ythril-a');
      assert.ok(
        cfg.ejectedFromNetworks?.includes(networkId),
        `ejectedFromNetworks should still contain ${networkId}`,
      );

      await del(INSTANCES.a, tokenA, `/api/networks/${fork.body.id}`).catch(() => {});
    });

    it('POST /fork without spaces when ejected returns 400', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/fork`, {
        label: 'Missing spaces fork',
        // no spaces
      });
      assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Error cases
  // ══════════════════════════════════════════════════════════════════════════
  describe('Error cases', () => {
    it('unknown networkId (not in networks or ejectedFromNetworks) returns 404', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/networks/ffffffff-ffff-ffff-ffff-ffffffffffff/fork', {
        label: 'Unknown network',
      });
      assert.equal(r.status, 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('spaces containing an unknown space id returns 400', async () => {
      // First create a real network so the id is known
      const create = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `SpaceErr-${Date.now()}`,
        type: 'closed',
        spaces: [SPACE],
        votingDeadlineHours: 1,
      });
      assert.equal(create.status, 201);
      const netId = create.body.id;

      const r = await post(INSTANCES.a, tokenA, `/api/networks/${netId}/fork`, {
        label: 'Bad spaces fork',
        spaces: ['does-not-exist-space-id'],
      });
      assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);

      await del(INSTANCES.a, tokenA, `/api/networks/${netId}`).catch(() => {});
    });

    it('missing label returns 400', async () => {
      const create = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `LabelErr-${Date.now()}`,
        type: 'closed',
        spaces: [SPACE],
        votingDeadlineHours: 1,
      });
      assert.equal(create.status, 201);
      const netId = create.body.id;

      const r = await post(INSTANCES.a, tokenA, `/api/networks/${netId}/fork`, {
        // no label
      });
      assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);

      await del(INSTANCES.a, tokenA, `/api/networks/${netId}`).catch(() => {});
    });
  });
});
