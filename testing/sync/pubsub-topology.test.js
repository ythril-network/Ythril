/**
 * Integration tests: Pub/Sub topology sync (Publisher A -> Subscriber B)
 *
 * Verifies:
 *  1. Publisher writes propagate down to subscribers
 *  2. Subscriber writes do NOT propagate up to the publisher
 *  3. Publisher tombstones only delete publisher-authored docs on subscriber
 *  4. A record the publisher RELAYED (authored by a third instance, reaching the publisher through a club) is
 *     deleted on the subscriber when the publisher deletes it, and the subscriber's own record is not (D-14 C)
 *
 * ## The members carry the instances' REAL ids (bundle-51)
 *
 * This file used to register the members as `instance-a` / `instance-b`, ids no instance has. A subscriber decides who
 * its publisher IS by comparing the instance id of the peer that delivered a page with the member it pulls from, so a
 * test that invents the member id can never see a rule about "the publisher": the peer token was bound to the real id
 * and the member said something else. Both ends now name each other by `getInstanceId`, and every token is bound to
 * the instance that presents it, as the invite flow binds them.
 *
 * Run: node --test testing/sync/pubsub-topology.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, postRetry429, get, del, delWithBody, triggerSync, syncUntil, whichSideLostIt, readRecord, getInstanceId } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB;
let networkId;
let testSpaceId;
let instanceIdA, instanceIdB;

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
    async () => (await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', memId)).status === expectStatus,
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
    instanceIdB = getInstanceId('ythril-b');
    const bPeer = await postRetry429(INSTANCES.b, tokenB, '/api/tokens', { name: 'pubsub-peer-a', peerInstanceId: instanceIdA });
    assert.equal(bPeer.status, 201, `Create peer token on B: ${JSON.stringify(bPeer.body)}`);

    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdB,
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

    // Create a peer token on A for B to use when pulling — bound to B's real id, as the other one is bound to A's
    const aPeer = await postRetry429(INSTANCES.a, tokenA, '/api/tokens', { name: 'pubsub-peer-b', peerInstanceId: instanceIdB });
    assert.equal(aPeer.status, 201, `Create peer token on A: ${JSON.stringify(aPeer.body)}`);

    // Add A as the publisher member on B's side (direction=pull: B pulls from A)
    const addA = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdA,
      label: 'Instance A (Publisher)',
      url: 'http://ythril-a:3200',
      token: aPeer.body.plaintext,
      direction: 'pull',
    });
    assert.equal(addA.status, 201, `Add publisher A on B: ${JSON.stringify(addA.body)}`);

    // Verify direction was preserved as 'pull' (not forced to 'push')
    const netB = await get(INSTANCES.b, tokenB, `/api/networks/${networkId}`);
    const pubMember = netB.body.members?.find(m => m.instanceId === instanceIdA);
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
    const r = await readRecord(INSTANCES.a, tokenA, testSpaceId, 'facts', subMemId);
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
    const subCheck = await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', subMemId);
    assert.equal(subCheck.status, 200, 'Subscriber local fact must survive publisher tombstone');
    console.log(`  Subscriber local fact survived publisher tombstone ✓`);
  });

  /**
   * ## A record the publisher RELAYED is the publisher's to take back (D-14 C, bundle-51)
   *
   * X is a third instance (C) that shares the space with the publisher P (A) through a CLUB network, so X's record
   * reaches P by the club and P relays it to the subscriber S (B) over the pub/sub network. The record on S is X's by
   * authorship and P's by delivery. When P deletes it, P issues the tombstone, and S — whose only upstream is P —
   * must apply it even though X, not P, wrote the record. S's own record, written beside it, is S's and survives.
   *
   * Only the CLUB's cycle is driven until the record reaches P, and only P's pub/sub cycle afterwards: no step runs
   * the club after the deletion, so P cannot re-pull the record from X and the deletion has one path to S.
   *
   * X sits on instance C, which has no SKIP_*_RATE_LIMIT, so every call made TO C rides out a 429 (`postRetry429`);
   * every sync trigger is sent to A, which has them.
   */
  describe('a record the publisher relayed from a third instance', () => {
    let tokenC, idC, clubId;

    before(async () => {
      tokenC = fs.readFileSync(path.join(CONFIGS, 'c', 'token.txt'), 'utf8').trim();
      idC = getInstanceId('ythril-c');
      const club = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `PubSub relay club ${Date.now()}`, type: 'club', spaces: [testSpaceId],
      });
      assert.equal(club.status, 201, `Create club on A: ${JSON.stringify(club.body)}`);
      clubId = club.body.id;
      const inv = await post(INSTANCES.a, tokenA, '/api/invite/generate', { networkId: clubId });
      assert.equal(inv.status, 201, `Invite to the club: ${JSON.stringify(inv.body)}`);
      // The join is the real handshake: A mints a token bound to C's id and C one bound to A's. `syncSchedule: ''` keeps
      // C on manual sync, so nothing here moves unless a step of the test asks it to. C creates the space it lacks.
      const join = await postRetry429(INSTANCES.c, tokenC, '/api/networks/join-remote', {
        handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply',
        rsaPublicKeyPem: inv.body.rsaPublicKeyPem, networkId: clubId, myUrl: 'http://ythril-c:3200', syncSchedule: '',
      });
      assert.equal(join.status, 200, `C joins the club: ${JSON.stringify(join.body)}`);
      const members = (await get(INSTANCES.a, tokenA, `/api/networks/${clubId}`)).body?.members ?? [];
      assert.ok(members.some(m => m.instanceId === idC), `the club on A does not list C by its real id: ${JSON.stringify(members.map(m => m.instanceId))}`);
    });

    after(async () => {
      if (clubId) {
        await del(INSTANCES.c, tokenC, `/api/networks/${clubId}`).catch(() => {});
        await del(INSTANCES.a, tokenA, `/api/networks/${clubId}`).catch(() => {});
      }
      await delWithBody(INSTANCES.c, tokenC, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    });

    it('P deletes a record X authored that P relayed: it is gone on S after a cycle, and S\'s own record survives', async () => {
      // A relay pushes by seq after its own push position, and a relayed record keeps its author's seq, so a record X
      // writes at a seq the publisher has already pushed past is never relayed (the ordering limit bundle-81 owns,
      // Q-278). This test is about who may DELETE a relayed record, not about that ordering, so X's record is written
      // above the publisher's push position for S: X writes fillers until its counter is past it.
      const netA = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      const pushedToS = Math.max(0, ...(netA.body?.members ?? []).map(m => m.lastSeqPushed?.[testSpaceId] ?? 0));
      let xw;
      for (let i = 0; i <= pushedToS + 1; i++) {
        xw = await postRetry429(INSTANCES.c, tokenC, `/api/brain/spaces/${testSpaceId}/facts`, {
          fact: 'Fact authored on X, relayed by the publisher', tags: ['pubsub-relay'],
        });
        assert.equal(xw.status, 201, `write on X: ${JSON.stringify(xw.body)}`);
        if ((xw.body.seq ?? 0) > pushedToS) break;
      }
      assert.ok((xw.body.seq ?? 0) > pushedToS, `X's record must land above the publisher's push position ${pushedToS}, got seq ${xw.body.seq}`);
      const xId = xw.body._id ?? xw.body.id;
      const sw = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts`, {
        fact: 'Subscriber own fact, written beside a relayed one', tags: ['pubsub-relay-survivor'],
      });
      assert.equal(sw.status, 201, `write on S: ${JSON.stringify(sw.body)}`);
      const sId = sw.body._id ?? sw.body.id;

      // X -> P, over the club: the record is on P, and P's copy is X's.
      await syncUntil(INSTANCES.a, tokenA, clubId,
        async () => (await readRecord(INSTANCES.a, tokenA, testSpaceId, 'facts', xId)).status === 200,
        `X's record ${xId} to reach the publisher through the club`, { label: 'A (club)' });
      const onP = await readRecord(INSTANCES.a, tokenA, testSpaceId, 'facts', xId);
      assert.equal(onP.body.author?.instanceId, idC, 'the publisher holds the record under X\'s authorship');

      // P -> S, over the pub/sub network: the record is on S, and it is still X's.
      await awaitOnB(xId, 200, 'the relayed record to reach the subscriber');
      const onS = await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', xId);
      assert.equal(onS.body.author?.instanceId, idC, 'the subscriber holds the relayed record under X\'s authorship, not P\'s');

      // P takes it back. Nothing runs the club from here, so the record cannot return from X.
      const delR = await del(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts/${xId}`);
      assert.equal(delR.status, 204, `Delete on P: expected 204, got ${delR.status}`);
      await awaitOnB(xId, 404, 'the publisher\'s deletion of a record it relayed to reach the subscriber');
      assert.equal((await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', sId)).status, 200,
        'the subscriber\'s own record must survive the publisher\'s deletion of a relayed one');
      console.log(`  Relayed fact deleted on S by its publisher; S's own fact survived ✓`);
    });
  });
});
