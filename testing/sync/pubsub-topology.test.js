/**
 * Integration tests: Pub/Sub topology sync (Publisher A -> Subscriber B)
 *
 * Verifies:
 *  1. Publisher writes propagate down to subscribers
 *  2. Subscriber writes do NOT propagate up to the publisher
 *  3. Publisher tombstones only delete publisher-authored docs on subscriber
 * Run: node --test testing/sync/pubsub-topology.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dockerExec,
  INSTANCES, post, postRetry429, get, del, delWithBody, triggerSync, syncUntil, whichSideLostIt,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

/** Read a container's real instanceId (a uuid) from its config. */
function getInstanceId(container) {
  return dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(c.instanceId)"`,
  ).toString().trim();
}

let tokenA, tokenB;
let networkId;
let testSpaceId;
let instanceIdA;

/**
 * Wait for a memory to reach (or leave) B, re-triggering A's sync while waiting. See `syncUntil`.
 *
 * ## `onTimeout` is the point, and it is here because of X-20
 *
 * This test's first wait fails intermittently in CI and has survived four rounds of investigation, because
 * `waitFor timed out after 25000ms — sync triggers to A all succeeded (8)` cannot distinguish the only two things
 * it can be: A never sent the record, or B took it and did not store it.
 *
 * Six local reproduction attempts — three isolated, one inside the full sync suite, two against a freshly rebuilt
 * cold stack — all PASSED at ~1.1 s against the 25 s budget. So the failure is not reachable here, and the next CI
 * occurrence is the one that has to answer the question. `whichSideLostIt` makes it do that: it reads whether A
 * still holds the record, at what `seq`, and where each member's watermarks sit.
 *
 * Only on the ARRIVAL wait. On the tombstone wait the record is expected to be gone, so "does the sender have it"
 * has the opposite meaning and the diagnostic would mislead.
 */
const awaitOnB = (memId, expectStatus, what) =>
  syncUntil(INSTANCES.a, tokenA, networkId,
    async () => (await get(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts/${memId}`)).status === expectStatus,
    `${what} (expected ${expectStatus} for ${memId} on B)`,
    {
      label: 'A',
      ...(expectStatus === 200
        ? { onTimeout: () => whichSideLostIt(INSTANCES.a, tokenA, networkId, testSpaceId, memId) }
        : {}),
    });

describe('Pub/Sub topology (A -> B subscriber)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

    testSpaceId = `pubsub-topology-${Date.now()}`;
    const spA = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'PubSub Topology Test Space' });
    assert.equal(spA.status, 201, `Create space on A: ${JSON.stringify(spA.body)}`);
    const spB = await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'PubSub Topology Test Space' });
    assert.equal(spB.status, 201, `Create space on B: ${JSON.stringify(spB.body)}`);

    // Create pubsub network on A (publisher)
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test PubSub',
      type: 'pubsub',
      spaces: [testSpaceId],
    });
    assert.equal(r.status, 201, `Create pubsub network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;

    // Create a peer token on B for A to use when pushing. Bind it to A's real
    // instanceId (peerInstanceId) so it represents a production peer token — the
    // subscriber authorises publisher tombstones by matching this identity against
    // the tombstone issuer.
    instanceIdA = getInstanceId('ythril-a');
    const bPeer = await postRetry429(INSTANCES.b, tokenB, '/api/tokens', { name: 'pubsub-peer-a', peerInstanceId: instanceIdA });
    assert.equal(bPeer.status, 201, `Create peer token on B: ${JSON.stringify(bPeer.body)}`);

    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b',
      label: 'Instance B (Subscriber)',
      url: 'http://ythril-b:3200',
      token: bPeer.body.plaintext,
      direction: 'push',
    });
    assert.equal(addB.status, 201, `Add subscriber B: ${JSON.stringify(addB.body)}`);

    // Register the same network on B (subscriber side)
    const regB = await post(INSTANCES.b, tokenB, '/api/networks', {
      id: networkId,
      label: 'Test PubSub',
      type: 'pubsub',
      spaces: [testSpaceId],
    });
    assert.equal(regB.status, 201, `Register pubsub network on B: ${JSON.stringify(regB.body)}`);

    // Create a peer token on A for B to use when pulling
    const aPeer = await postRetry429(INSTANCES.a, tokenA, '/api/tokens', { name: 'pubsub-peer-b' });
    assert.equal(aPeer.status, 201, `Create peer token on A: ${JSON.stringify(aPeer.body)}`);

    // Add A as the publisher member on B's side (direction=pull: B pulls from A)
    const addA = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-a',
      label: 'Instance A (Publisher)',
      url: 'http://ythril-a:3200',
      token: aPeer.body.plaintext,
      direction: 'pull',
    });
    assert.equal(addA.status, 201, `Add publisher A on B: ${JSON.stringify(addA.body)}`);

    // Verify direction was preserved as 'pull' (not forced to 'push')
    const netB = await get(INSTANCES.b, tokenB, `/api/networks/${networkId}`);
    const pubMember = netB.body.members?.find(m => m.instanceId === 'instance-a');
    assert.equal(pubMember?.direction, 'pull', 'Publisher stored as pull on subscriber side');

    console.log(`Created pubsub network: ${networkId}`);
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });

  it('Publisher A: write propagates down to Subscriber B', async () => {
    const write = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Published fact from A',
      tags: ['pubsub-test'],
    });
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;

    // A pushes to B
    await awaitOnB(memId, 200, 'the published fact to appear on B');
    console.log(`  Published fact appeared on B ✓`);
  });

  it('Subscriber B: write does NOT propagate to Publisher A', async () => {
    const write = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Subscriber-only fact from B',
      tags: ['pubsub-sub-local'],
    });
    assert.equal(write.status, 201);
    const subMemId = write.body._id ?? write.body.id;

    // B syncs — B has A as direction='pull', so B only pulls from A, never pushes
    await triggerSync(INSTANCES.b, tokenB, networkId);

    // A syncs — A pushes to B, never pulls from B
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // Wait and verify the subscriber-local fact is NOT on A.
    // Negative assertion — fixed wait is correct; do NOT convert to waitFor (Q3).
    await new Promise(r => setTimeout(r, 3_000));
    const r = await get(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts/${subMemId}`);
    assert.equal(r.status, 404, 'Subscriber fact should NOT appear on publisher');
    console.log(`  Subscriber fact correctly absent from A ✓`);
  });

  it('Subscriber-local content survives publisher tombstone', async () => {
    // B creates a local memory
    const subWrite = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Subscriber local fact for tombstone test',
      tags: ['pubsub-survivor'],
    });
    assert.equal(subWrite.status, 201);
    const subMemId = subWrite.body._id ?? subWrite.body.id;

    // A creates and then deletes a memory — tombstone should propagate to B
    const pubWrite = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Publisher fact to be deleted',
      tags: ['pubsub-delete-test'],
    });
    assert.equal(pubWrite.status, 201);
    const pubMemId = pubWrite.body._id ?? pubWrite.body.id;

    // Push publisher memory to B, then push the tombstone — both RE-TRIGGERED while waiting.
    //
    // This test failed CI as `waitFor timed out after 15000ms`, with no indication of which of the two waits
    // gave up or why. Both were a single up-front `triggerSync` followed by a bare 15 s poll, which is the
    // shape `makeTriggerProbe` exists to replace: a lone trigger races the gossip cycle, and a bare timeout
    // reports a persistent, actionable failure (a 429, a misconfigured network) identically to a slow one.
    // `closed-network.test.js` already does it this way — see the comment there.
    await awaitOnB(pubMemId, 200, 'the publisher memory to arrive on B');

    // Now delete on A
    const delR = await del(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts/${pubMemId}`);
    assert.equal(delR.status, 204, `Delete on A: expected 204, got ${delR.status}`);

    await awaitOnB(pubMemId, 404, "the publisher's tombstone to reach B");
    console.log(`  Publisher's deleted fact removed from B ✓`);

    // Verify subscriber's own memory still exists
    const subCheck = await get(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts/${subMemId}`);
    assert.equal(subCheck.status, 200, 'Subscriber local fact must survive publisher tombstone');
    console.log(`  Subscriber local fact survived publisher tombstone ✓`);
  });
});
