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
import {
  INSTANCES, post, postRetry429, get, del, triggerSync, createMemory, waitFor,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, tokenC;
let networkId;

describe('Braintree topology (A -> B -> C)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    tokenC = fs.readFileSync(path.join(CONFIGS, 'c', 'token.txt'), 'utf8').trim();

    // Create braintree network on A
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test Braintree',
      type: 'braintree',
      spaces: ['general'],
      votingDeadlineHours: 24,
    });
    assert.equal(r.status, 201, `Create network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;

    // Create peer tokens
    const bPeer = await postRetry429(INSTANCES.b, tokenB, '/api/tokens', { name: 'bt-peer-a' });
    const cPeer = await postRetry429(INSTANCES.c, tokenC, '/api/tokens', { name: 'bt-peer-b' });
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
      spaces: ['general'],
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
    }
  });

  it('Root A: write propagates down to B and then to C', async () => {
    const write = await createMemory(INSTANCES.a, tokenA, 'Root fact from A', ['braintree-test']);
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;

    // A pushes to B
    await triggerSync(INSTANCES.a, tokenA, networkId);
    await waitFor(async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/brain/general/memories/${memId}`);
      return r.status === 200;
    }, 15_000);
    console.log(`  Root fact appeared on B ✓`);

    // B pushes to C
    await triggerSync(INSTANCES.b, tokenB, networkId);
    await waitFor(async () => {
      const r = await get(INSTANCES.c, tokenC, `/api/brain/general/memories/${memId}`);
      return r.status === 200;
    }, 15_000);
    console.log(`  Root fact appeared on C ✓`);
  });

  it('Leaf C: write does NOT propagate up to B (push-only)', async () => {
    const write = await createMemory(INSTANCES.c, tokenC, 'Leaf-only fact from C', ['braintree-leaf']);
    assert.equal(write.status, 201);
    const leafMemId = write.body._id ?? write.body.id;

    // B would try to sync schedule — but C is push-only so B only receives from its parent A
    // Trigger sync on B (B syncs from A, not from C)
    await triggerSync(INSTANCES.b, tokenB, networkId);

    // Wait a short time and verify this specific memory is NOT on B
    await new Promise(r => setTimeout(r, 3000));
    const r = await get(INSTANCES.b, tokenB, `/api/brain/general/memories/${leafMemId}`);
    assert.equal(r.status, 404, 'Leaf fact should NOT have propagated to B');
    console.log(`  Leaf fact correctly absent from B ✓`);
  });

  it('Node B: write does NOT propagate up to A', async () => {
    const write = await createMemory(INSTANCES.b, tokenB, 'Node-only fact from B', ['braintree-node']);
    assert.equal(write.status, 201);
    const nodeMemId = write.body._id ?? write.body.id;

    // Trigger sync on A — A only receives from its own parent (none) and pushes to B
    await triggerSync(INSTANCES.a, tokenA, networkId);

    await new Promise(r => setTimeout(r, 3000));
    const r = await get(INSTANCES.a, tokenA, `/api/brain/general/memories/${nodeMemId}`);
    assert.equal(r.status, 404, 'Node fact should NOT have propagated to A');
    console.log(`  Node fact correctly absent from A ✓`);
  });
});
