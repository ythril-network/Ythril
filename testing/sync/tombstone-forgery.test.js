/**
 * Red-team integration test: forged-tombstone cross-instance data deletion.
 *
 * Threat: a member forges a tombstone whose `instanceId` is set to a VICTIM
 * instance and pushes it to a peer. Before the fix, `applyRemoteTombstone`
 * authorised the delete purely on `localDoc.author.instanceId === tombstone.instanceId`
 * — both attacker-controlled — so the forger could delete the victim's authored
 * memories/entities/edges/chrono across the network.
 *
 * The fix binds the deletion to the authenticated peer: a tombstone may delete a
 * document only when its issuer matches the delivering peer's identity
 * (peerInstanceId) or the caller is a trusted local/admin token.
 *
 * Scenario (A <-> B, closed): A authors a memory. Malicious B, using its OWN
 * bound peer token, POSTs a tombstone forged as instance A to delete A's memory.
 * A must refuse the deletion. A control shows a trusted (admin) tombstone still
 * deletes, so the endpoint is not simply broken.
 *
 * Run:  node --test testing/sync/tombstone-forgery.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, getInstanceId, readRecord } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, instanceIdA, instanceIdB, peerTokenForB, networkId, testSpaceId;

describe('Forged tombstone cross-instance deletion is refused', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    testSpaceId = `tomb-forgery-${Date.now()}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Tombstone Forgery Test Space' });

    // A closed network on A with B as a member, holding a peer token BOUND to B's
    // real instanceId — exactly what a production invite handshake issues.
    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Tomb Forgery ${Date.now()}`, type: 'closed', spaces: [testSpaceId], votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, JSON.stringify(netR.body));
    networkId = netR.body.id;

    const bTok = await post(INSTANCES.a, tokenA, '/api/tokens', { name: `tf-peer-b-${Date.now()}`, peerInstanceId: instanceIdB });
    assert.equal(bTok.status, 201, JSON.stringify(bTok.body));
    peerTokenForB = bTok.body.plaintext;

    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdB, label: 'Instance B', url: 'http://ythril-b:3200', token: peerTokenForB, direction: 'both',
    });
    if (addB.status === 202) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    if (testSpaceId) await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
  });

  it('B cannot delete A-authored content by forging a tombstone as A', async () => {
    // A authors a memory (author.instanceId = A).
    const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'A-authored memory that B must not be able to delete', tags: ['victim'],
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const victimId = w.body._id ?? w.body.id;

    // Malicious B pushes a tombstone FORGED as instance A, authenticated with B's
    // own bound peer token (peerInstanceId = B).
    const forged = await post(INSTANCES.a, peerTokenForB, `/api/sync/tombstones?spaceId=${testSpaceId}&networkId=${networkId}`, {
      tombstones: [{
        _id: victimId, type: 'fact', spaceId: testSpaceId,
        deletedAt: new Date().toISOString(), instanceId: instanceIdA, seq: Date.now() + 1_000_000,
      }],
    });
    // The endpoint accepts the tombstone document (records it) but must NOT delete.
    assert.equal(forged.status, 200, JSON.stringify(forged.body));

    // The victim memory must still exist.
    const check = await readRecord(INSTANCES.a, tokenA, testSpaceId, 'facts', victimId);
    assert.equal(check.status, 200, 'VULNERABILITY: forged tombstone deleted A-authored content');
  });

  it('a trusted (admin) tombstone for the same author still deletes — endpoint is not simply broken', async () => {
    const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'A-authored memory deleted via a trusted admin tombstone', tags: ['control'],
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const id = w.body._id ?? w.body.id;

    // A's admin token has no peerInstanceId → trusted relay → deletion authorised.
    const t = await post(INSTANCES.a, tokenA, `/api/sync/tombstones?spaceId=${testSpaceId}&networkId=${networkId}`, {
      tombstones: [{
        _id: id, type: 'fact', spaceId: testSpaceId,
        deletedAt: new Date().toISOString(), instanceId: instanceIdA, seq: Date.now() + 2_000_000,
      }],
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));

    const check = await readRecord(INSTANCES.a, tokenA, testSpaceId, 'facts', id);
    assert.equal(check.status, 404, 'trusted admin tombstone should have deleted the memory');
  });
});
