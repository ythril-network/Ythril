/**
 * Integration tests: Closed network sync (A <-> B)
 *
 * Run: node --test testing/sync/closed-network.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dockerExec,
  INSTANCES,
  post, get, del, delWithBody, triggerSync, waitFor, makeTriggerProbe,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB;
let networkId;
let instanceIdA, instanceIdB;
let testSpaceId;

function loadTokens() {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
}

/** Read instanceId from a container's config.json */
function getInstanceId(container) {
  return dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(c.instanceId)"`,
  ).toString().trim();
}

/** Write a peer token into a container's secrets.json and reload config. */
function injectPeerToken(container, instanceId, token) {
  const script = `
const fs = require('fs');
const p = '/config/secrets.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.peerTokens = s.peerTokens || {};
s.peerTokens['${instanceId}'] = '${token}';
fs.writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
process.stdout.write('ok');
`.replace(/\n/g, ' ');
  dockerExec(`docker exec ${container} node -e "${script}"`);
}

// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * Wait for a peer to deliver something, RE-TRIGGERING sync while we wait.
 *
 * One test in this file already did this by hand (the A-pulls-from-B case) and the others did not. The tombstone test was
 * one of the two that failed in CI on 2026-08-13 — the wait expires having asked once, because a single up-front trigger
 * races a slow gossip cycle, which is exactly what `makeTriggerProbe`'s docstring warns about.
 *
 * `probe.diagnose` makes a persistently-rejected trigger report itself instead of arriving as a bare timeout.
 */
// 20s, matching the one hand-rolled re-triggered wait this codebase already had rather than inventing a number. The
// MECHANISM is the fix -- re-triggering -- and the budget is deliberately not raised far, so a genuinely hung sync
// still reports in a reasonable time instead of being papered over.
async function waitForSynced(instance, token, networkId, label, check, timeoutMs = 20_000) {
  await triggerSync(instance, token, networkId);
  const probe = makeTriggerProbe(instance, token, networkId, label);
  const retrigger = setInterval(() => { void probe(); }, 3_000);
  try {
    await waitFor(check, timeoutMs, 500, probe.diagnose);
  } finally {
    clearInterval(retrigger);
  }
}

describe('Closed Network (A <-> B)', () => {
  before(async () => {
    loadTokens();
    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    // Create a dedicated space on both instances — avoids syncing thousands
    // of accumulated docs from the shared 'general' space.
    testSpaceId = `closed-test-${Date.now()}`;
    const spLabel = `Closed Test ${Date.now()}`;
    const spA = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: spLabel, folders: [] });
    assert.equal(spA.status, 201, `Create space on A: ${JSON.stringify(spA.body)}`);
    const spB = await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: spLabel, folders: [] });
    assert.equal(spB.status, 201, `Create space on B: ${JSON.stringify(spB.body)}`);

    // Create a closed network on A with the dedicated space
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test Closed Network',
      type: 'closed',
      spaces: [testSpaceId],
      votingDeadlineHours: 24,
    });
    assert.equal(r.status, 201, `Create network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;

    // Create peer tokens: A creates one for B to call A; B creates one for A to call B
    const peerTokenOnB = await post(INSTANCES.b, tokenB, '/api/tokens', { name: 'peer-token-a', peerInstanceId: instanceIdA });
    assert.equal(peerTokenOnB.status, 201);
    const bPeerPlain = peerTokenOnB.body.plaintext;

    const peerTokenOnA = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'peer-token-b', peerInstanceId: instanceIdB });
    assert.equal(peerTokenOnA.status, 201);
    const aPeerPlain = peerTokenOnA.body.plaintext;

    // Add B as a member of the network on A (uses B's real instanceId)
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdB,
      label: 'Instance B',
      url: 'http://ythril-b:3200',
      token: bPeerPlain,
      direction: 'both',
    });
    if (addB.status === 202) {
      const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
      assert(voteR.status === 200 || voteR.status === 201);
    } else {
      assert.equal(addB.status, 201, `Add B: ${JSON.stringify(addB.body)}`);
    }

    // Inject peer tokens into secrets.json so the sync engine can authenticate outbound calls
    injectPeerToken('ythril-a', instanceIdB, bPeerPlain);
    injectPeerToken('ythril-b', instanceIdA, aPeerPlain);

    // Reload config so the in-memory secrets reflect the injected tokens
    await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});
  });

  // ── Memory sync ──────────────────────────────────────────────────────────

  it('A can write a memory and sync pushes it to B', async () => {
    // Write a memory on A
    const write = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, { fact: 'The quick brown fox', tags: ['test'] });
    assert.equal(write.status, 201, `Write: ${JSON.stringify(write.body)}`);
    const memId = write.body._id ?? write.body.id;
    console.log(`  Wrote memory ${memId} on A`);

    // Wait for B to have the memory (lookup by direct ID to avoid pagination), re-triggering while we wait.
    await waitForSynced(INSTANCES.a, tokenA, networkId, 'A', async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts/${memId}`);
      return r.status === 200;
    });

    console.log(`  Memory appeared on B ✓`);
  });

  it('B can write a memory and it syncs back to A', async () => {
    const write = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts`, { fact: 'Jumped over the lazy dog', tags: ['test'] });
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;
    console.log(`  Wrote memory ${memId} on B`);

    // Trigger sync on A (A pulls from B — B doesn't have this network configured).
    // Re-trigger every 3 seconds in case the first async fire was queued behind other work.
    // The probe records failures so a persistently-rejected trigger is reported as itself
    // rather than as a bare timeout (see makeTriggerProbe).
    await triggerSync(INSTANCES.a, tokenA, networkId);
    const triggerA = makeTriggerProbe(INSTANCES.a, tokenA, networkId, 'A');
    const retrigger = setInterval(() => { void triggerA(); }, 3_000);

    try {
      await waitFor(async () => {
        const r = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts/${memId}`);
        return r.status === 200;
      }, 20_000, 500, triggerA.diagnose);
    } finally {
      clearInterval(retrigger);
    }

    console.log(`  Memory appeared on A ✓`);
  });

  it('Deletion tombstone propagates from A to B', async () => {
    // Write and sync a memory
    const write = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, { fact: 'Memory to be deleted', tags: ['delete-test'] });
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;

    // Wait for B to have the memory (direct ID lookup)
    await waitForSynced(INSTANCES.a, tokenA, networkId, 'A', async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts/${memId}`);
      return r.status === 200;
    });

    // Delete on A
    const del_ = await del(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts/${memId}`);
    assert.equal(del_.status, 204, `Delete: ${JSON.stringify(del_.body)}`);
    console.log(`  Deleted memory ${memId} on A`);

    // Wait for the tombstone to arrive on B (memory disappears — direct ID lookup returns 404), re-triggering while we
    // wait. This is the assertion that timed out in CI on 2026-08-13: a tombstone push queued behind other work, asked
    // for once.
    await waitForSynced(INSTANCES.a, tokenA, networkId, 'A', async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts/${memId}`);
      return r.status === 404;
    });

    console.log(`  Memory disappeared from B ✓`);
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    }
    if (testSpaceId) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });
});
