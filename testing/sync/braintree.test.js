/**
 * Integration tests: Braintree topology sync (A root -> B node -> C leaf)
 *
 * Run: node --test testing/sync/braintree.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, postRetry429, get, del, delWithBody, triggerSync, waitFor, getInstanceId, makeTriggerProbe, readRecord } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, tokenC;
let networkId;
let testSpaceId;

/**
 * Wait for a peer to deliver something, RE-TRIGGERING sync while we wait.
 *
 * A single up-front trigger races a slow gossip cycle: the trigger is accepted, the push is queued behind other work, and
 * the wait expires having asked once. That is what `makeTriggerProbe`'s own docstring warns about, and it is what failed
 * in CI on 2026-08-13 — the FIRST propagation of a run, 15.2s against a 15s budget, with no container error and the same
 * assertions passing locally in 2.7s.
 *
 * So the budget is not the fix. Re-triggering is, and the probe makes a persistently-rejected trigger report itself
 * ("429 Too Many Requests") instead of arriving as a bare timeout with nothing to act on.
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

describe('Braintree topology (A -> B -> C)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    tokenC = fs.readFileSync(path.join(CONFIGS, 'c', 'token.txt'), 'utf8').trim();

    testSpaceId = `bt-topology-${Date.now()}`;
    const spA = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Braintree Topology Test Space' });
    assert.equal(spA.status, 201, `Create space on A: ${JSON.stringify(spA.body)}`);
    const spB = await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'Braintree Topology Test Space' });
    assert.equal(spB.status, 201, `Create space on B: ${JSON.stringify(spB.body)}`);
    const spC = await post(INSTANCES.c, tokenC, '/api/spaces', { id: testSpaceId, label: 'Braintree Topology Test Space' });
    assert.equal(spC.status, 201, `Create space on C: ${JSON.stringify(spC.body)}`);

    // Create braintree network on A
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test Braintree',
      type: 'braintree',
      spaces: [testSpaceId],
      votingDeadlineHours: 24,
    });
    assert.equal(r.status, 201, `Create network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;

    // Create peer tokens — peer-bound to the instance that PRESENTS them
    // (sync data writes require a peer or admin token — S10).
    const bPeer = await postRetry429(INSTANCES.b, tokenB, '/api/tokens', {
      name: 'bt-peer-a', peerInstanceId: getInstanceId('ythril-a'),
    });
    const cPeer = await postRetry429(INSTANCES.c, tokenC, '/api/tokens', {
      name: 'bt-peer-b', peerInstanceId: getInstanceId('ythril-b'),
    });
    assert.equal(bPeer.status, 201);
    assert.equal(cPeer.status, 201);

    // Add B as child of A (push direction: A->B)
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b',
      label: 'Instance B',
      url: 'http://ythril-b:3200',
      token: bPeer.body.plaintext,
      direction: 'push',  // A pushes to B; B cannot push back
      parentInstanceId: 'instance-a',
    });
    assert(addB.status === 201 || addB.status === 202, `Add B: ${JSON.stringify(addB.body)}`);

    // Register the same network on B (with the preset networkId) so B can manage its children
    const regB = await post(INSTANCES.b, tokenB, '/api/networks', {
      id: networkId,
      label: 'Test Braintree',
      type: 'braintree',
      spaces: [testSpaceId],
      votingDeadlineHours: 24,
    });
    assert.equal(regB.status, 201, `Register network on B: ${JSON.stringify(regB.body)}`);

    // Add C as child of B (push direction: B->C)
    const addC = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-c',
      label: 'Instance C',
      url: 'http://ythril-c:3200',
      token: cPeer.body.plaintext,
      direction: 'push',
      parentInstanceId: 'instance-b',
    });
    assert(addC.status === 201 || addC.status === 202, `Add C: ${JSON.stringify(addC.body)}`);

    console.log(`Created braintree network: ${networkId}`);
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.c, tokenC, `/api/networks/${networkId}`).catch(() => {});
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.c, tokenC, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });

  it('Root A: write propagates down to B and then to C', async () => {
    const write = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Root fact from A',
      tags: ['braintree-test'],
    });
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;

    // A pushes to B
    await waitForSynced(INSTANCES.a, tokenA, networkId, 'A', async () => {
      const r = await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', memId);
      return r.status === 200;
    });
    console.log(`  Root fact appeared on B ✓`);

    // B pushes to C
    await waitForSynced(INSTANCES.b, tokenB, networkId, 'B', async () => {
      const r = await readRecord(INSTANCES.c, tokenC, testSpaceId, 'facts', memId);
      return r.status === 200;
    });
    console.log(`  Root fact appeared on C ✓`);
  });

  it('Leaf C: write does NOT propagate up to B (push-only)', async () => {
    const write = await post(INSTANCES.c, tokenC, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Leaf-only fact from C',
      tags: ['braintree-leaf'],
    });
    assert.equal(write.status, 201);
    const leafMemId = write.body._id ?? write.body.id;

    // B would try to sync schedule — but C is push-only so B only receives from its parent A
    // Trigger sync on B (B syncs from A, not from C)
    await triggerSync(INSTANCES.b, tokenB, networkId);

    // Wait a short time and verify this specific memory is NOT on B.
    // Negative assertion — a fixed wait is correct here; do NOT convert to waitFor (Q3), which would
    // return instantly on the absent record and prove nothing.
    await new Promise(r => setTimeout(r, 3000));
    const r = await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', leafMemId);
    assert.equal(r.status, 404, 'Leaf fact should NOT have propagated to B');
    console.log(`  Leaf fact correctly absent from B ✓`);
  });

  it('Node B: write does NOT propagate up to A', async () => {
    const write = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Node-only fact from B',
      tags: ['braintree-node'],
    });
    assert.equal(write.status, 201);
    const nodeMemId = write.body._id ?? write.body.id;

    // Trigger sync on A — A only receives from its own parent (none) and pushes to B
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // Negative assertion (see above) — fixed wait is correct; do NOT convert to waitFor (Q3).
    await new Promise(r => setTimeout(r, 3000));
    const r = await readRecord(INSTANCES.a, tokenA, testSpaceId, 'facts', nodeMemId);
    assert.equal(r.status, 404, 'Node fact should NOT have propagated to A');
    console.log(`  Node fact correctly absent from A ✓`);
  });
});
