/**
 * Integration tests: Closed network sync (A <-> B)
 *
 * Run: node --test tests/sync/closed-network.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node tests/sync/setup.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  INSTANCES,
  post, get, del, triggerSync, createMemory, listMemories, waitFor,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB;
let networkId;

function loadTokens() {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
}

// ── Setup ────────────────────────────────────────────────────────────────────

describe('Closed Network (A <-> B)', () => {
  before(async () => {
    loadTokens();

    // Create a closed network on A with the general space
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test Closed Network',
      type: 'closed',
      spaces: ['general'],
      votingDeadlineHours: 24,
    });
    assert.equal(r.status, 201, `Create network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;
    console.log(`Created closed network: ${networkId}`);

    // Create a peer token on B that A will use to call B
    const peerTokenOnB = await post(INSTANCES.b, tokenB, '/api/tokens', { name: 'peer-token-a' });
    assert.equal(peerTokenOnB.status, 201);
    const bPeerPlain = peerTokenOnB.body.plaintext;

    // Create a peer token on A that B will use to call A
    const peerTokenOnA = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'peer-token-b' });
    assert.equal(peerTokenOnA.status, 201);
    const aPeerPlain = peerTokenOnA.body.plaintext;

    // Add B as a member of the network on A
    // (Closed networks require a vote — but A is currently the only member, so vote auto-passes)
    // Actually: at creation time there are 0 members. The first member add creates a vote
    // that only the initiating instance needs to pass. Since there are 0 existing voters, it auto-passes.
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b',
      label: 'Instance B',
      url: 'http://ythril-b:3200',  // container-internal name
      token: bPeerPlain,
      direction: 'both',
    });
    // Expect 202 (vote) or 201 (direct add)
    if (addB.status === 202) {
      // Auto-cast a yes vote
      const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
      assert(voteR.status === 200 || voteR.status === 201);
    } else {
      assert.equal(addB.status, 201, `Add B: ${JSON.stringify(addB.body)}`);
    }
    console.log(`Added B to network`);

    // Register A's peer token in A's secrets for outbound calls to B
    // This requires updating secrets.json — for tests we do it via a test-only endpoint
    // or by directly modifying the file.
    // For simplicity: write the peer token file on each container via exec
    // In a real test environment this would be done programmatically via a secrets API.
    // For now, skip — the sync tests use the push mechanism which requires peerTokens.
    console.log('NOTE: peerTokens in secrets.json must be set manually for outbound sync to work.');
    console.log('See tests/sync/README.md for instructions.');
  });

  // ── Memory sync ──────────────────────────────────────────────────────────

  it('A can write a memory and sync pushes it to B', async () => {
    // Write a memory on A
    const write = await createMemory(INSTANCES.a, tokenA, 'The quick brown fox', ['test']);
    assert.equal(write.status, 201, `Write: ${JSON.stringify(write.body)}`);
    const memId = write.body._id ?? write.body.id;
    console.log(`  Wrote memory ${memId} on A`);

    // Trigger sync on A (A pushes to B)
    await triggerSync(INSTANCES.a, tokenA, networkId);
    console.log(`  Triggered sync on A`);

    // Wait for B to have the memory (pull also happens)
    await waitFor(async () => {
      const r = await listMemories(INSTANCES.b, tokenB);
      if (r.status !== 200) return false;
      return r.body.memories?.some(m => m._id === memId || m.fact === 'The quick brown fox');
    }, 15_000);

    console.log(`  Memory appeared on B ✓`);
  });

  it('B can write a memory and it syncs back to A', async () => {
    const write = await createMemory(INSTANCES.b, tokenB, 'Jumped over the lazy dog', ['test']);
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;
    console.log(`  Wrote memory ${memId} on B`);

    // Trigger sync on A (A pulls from B — B doesn't have this network configured)
    await triggerSync(INSTANCES.a, tokenA, networkId);

    await waitFor(async () => {
      const r = await listMemories(INSTANCES.a, tokenA);
      if (r.status !== 200) return false;
      return r.body.memories?.some(m => m.fact === 'Jumped over the lazy dog');
    }, 15_000);

    console.log(`  Memory appeared on A ✓`);
  });

  it('Deletion tombstone propagates from A to B', async () => {
    // Write and sync a memory
    const write = await createMemory(INSTANCES.a, tokenA, 'Memory to be deleted', ['delete-test']);
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;

    await triggerSync(INSTANCES.a, tokenA, networkId);
    await waitFor(async () => {
      const r = await listMemories(INSTANCES.b, tokenB);
      return r.body.memories?.some(m => m._id === memId);
    }, 15_000);

    // Delete on A
    const del_ = await del(INSTANCES.a, tokenA, `/api/brain/general/memories/${memId}`);
    assert.equal(del_.status, 204, `Delete: ${JSON.stringify(del_.body)}`);
    console.log(`  Deleted memory ${memId} on A`);

    // Trigger sync
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // Wait for it to disappear from B
    await waitFor(async () => {
      const r = await listMemories(INSTANCES.b, tokenB);
      return !r.body.memories?.some(m => m._id === memId);
    }, 15_000);

    console.log(`  Memory disappeared from B ✓`);
  });
});
