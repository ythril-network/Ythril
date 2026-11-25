/**
 * An instance that already carries a network and applies another member's invite keeps the layers it holds (`Q-966`, review F5).
 *
 * The join fetch of a voted network's schema ran on every join, including a join into a network this instance already carries (Q-133: the
 * join merges the spaces it resolved into the network). It skipped the guards the heal keeps (only the admitter, only while unseeded, never
 * on the creator), so another member's answer replaced a layer the instance held. The fetch now runs only when the join created the network.
 *
 * A club of A, B and C, no cycle run between them (B is not yet C's peer). B holds A's layer. C's layer is then made to differ (as a member that drifted), and B joins the same network through
 * C's invite: B's layer is what it was.
 *
 * Run: node --test testing/sync/an-instance-that-already-carries-a-network-keeps-its-layers-when-it-joins-again.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, post, patchContainerNetwork, reloadConfig } from './helpers.js';
import { tokenOf, createClub, joinThrough, tearDown, layerOn } from './_q966-club.mjs';

let club;
let before_;

before(async () => {
  club = await createClub('f5');
  await joinThrough(club, 'b');
  await joinThrough(club, 'c');
  before_ = layerOn('b', club.networkId, club.space);
  assert.equal(before_?.validationMode, 'strict', 'B holds the network\'s layer before the second join');
  patchContainerNetwork('ythril-c', club.networkId, `n.schemaLayers[${JSON.stringify(club.space)}] = { validationMode: 'lenient', purpose: 'a layer that drifted on C' };`);
  await reloadConfig(INSTANCES.c, tokenOf('c'));
});

after(() => tearDown([club]));

describe('an instance that joins a network it already carries', () => {
  it('keeps the layer it holds when it applies another member\'s invite', async () => {
    const inv = await post(INSTANCES.c, tokenOf('c'), '/api/invite/generate', { networkId: club.networkId });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const j = await post(INSTANCES.b, tokenOf('b'), '/api/networks/join-remote', {
      handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-c:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
      networkId: club.networkId, myUrl: 'http://ythril-b:3200',
    });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    assert.deepEqual(layerOn('b', club.networkId, club.space), before_, 'the join replaced a layer the instance already held');
  });
});
