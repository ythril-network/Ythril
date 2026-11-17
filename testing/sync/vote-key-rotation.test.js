/**
 * Integration test: governance signing-key rotation propagates via gossip.
 *
 *  1. A and B form a network; B pins A's original signing key on first sync.
 *  2. A rotates its keypair (POST /api/admin/rotate-signing-key), producing a
 *     continuity proof signed by the old key.
 *  3. On the next sync, B adopts A's NEW key (the proof verifies against the key
 *     B had pinned) — without any manual intervention.
 *  4. Break-glass: the manual re-pin endpoint force-sets a member's key.
 *
 * Run:  node --test testing/sync/vote-key-rotation.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, reloadConfig, get, put, del, delWithBody, triggerSync, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, instanceIdA, instanceIdB, peerTokenForA, peerTokenForB, networkId, testSpaceId;

function getInstanceId(c) {
  return dockerExec(`docker exec ${c} node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(j.instanceId)"`).toString().trim();
}
function injectPeerToken(c, id, tok) {
  const s = `const fs=require('fs');const p='/config/secrets.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));s.peerTokens=s.peerTokens||{};s.peerTokens['${id}']='${tok}';fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600});process.stdout.write('ok');`;
  dockerExec(`docker exec ${c} node -e "${s}"`);
}
async function pinnedKeyForA() {
  const net = await get(INSTANCES.b, tokenB, `/api/networks/${networkId}`);
  return net.body?.members?.find(m => m.instanceId === instanceIdA)?.signingPublicKey;
}

describe('Governance signing-key rotation', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    testSpaceId = `key-rot-${Date.now()}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Key Rotation Test Space' });
    await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'Key Rotation Test Space' });

    // Each PAT is bound to the peer that PRESENTS it, as `invite.ts` and the join flow do. Bare peer
    // credentials only worked while the two governance relays were the `/api/sync` endpoints not
    // applying `isNonPeerSyncWrite`.
    peerTokenForA = (await post(INSTANCES.b, tokenB, '/api/tokens', {
      name: `kr-a-${Date.now()}`, peerInstanceId: instanceIdA,
    })).body.plaintext;
    peerTokenForB = (await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `kr-b-${Date.now()}`, peerInstanceId: instanceIdB,
    })).body.plaintext;

    const netR = await post(INSTANCES.a, tokenA, '/api/networks', { label: `Key Rotation ${Date.now()}`, type: 'closed', spaces: [testSpaceId], votingDeadlineHours: 1 });
    assert.equal(netR.status, 201, JSON.stringify(netR.body));
    networkId = netR.body.id;

    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, { instanceId: instanceIdB, label: 'Instance B', url: 'http://ythril-b:3200', token: peerTokenForA, direction: 'both' });
    if (addB.status === 202) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });

    const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', { id: networkId, label: 'Key Rotation', type: 'closed', spaces: [testSpaceId], votingDeadlineHours: 1 });
    assert.ok(netOnB.status === 201 || netOnB.status === 409, JSON.stringify(netOnB.body));
    const addAonB = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, { instanceId: instanceIdA, label: 'Instance A', url: 'http://ythril-a:3200', token: peerTokenForB, direction: 'both' });
    if (addAonB.status === 202) await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${addAonB.body.roundId}`, { vote: 'yes' });

    injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
    injectPeerToken('ythril-b', instanceIdA, peerTokenForB);
    await reloadConfig(INSTANCES.a, tokenA);
    await reloadConfig(INSTANCES.b, tokenB);
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });

  it('B pins A\'s original signing key on first sync', async () => {
    await triggerSync(INSTANCES.a, tokenA, networkId);
    await triggerSync(INSTANCES.b, tokenB, networkId);
    await waitFor(async () => !!(await pinnedKeyForA()), 12_000);
  });

  it('after A rotates, B adopts the new key via the signed continuity proof', async () => {
    const before = await pinnedKeyForA();
    assert.ok(before, 'precondition: B has pinned A\'s key');

    // A rotates its governance signing keypair.
    const rot = await post(INSTANCES.a, tokenA, '/api/admin/rotate-signing-key', {});
    assert.equal(rot.status, 200, `rotate: ${JSON.stringify(rot.body)}`);
    const newKey = rot.body.signingPublicKey;
    assert.ok(newKey && newKey !== before, 'rotation must produce a different key');

    // Propagate: A pushes its self-record (new key + proof) to B on sync.
    await triggerSync(INSTANCES.a, tokenA, networkId);
    await waitFor(async () => (await pinnedKeyForA()) === newKey, 15_000);

    assert.equal(await pinnedKeyForA(), newKey, 'B must have re-pinned A to the rotated key');
  });

  it('admin can force-set a member\'s signing key (break-glass re-pin)', async () => {
    // Any syntactically-plausible PEM works for the force-set path (no proof).
    const bogus = '-----BEGIN PUBLIC KEY-----\n' + 'A'.repeat(60) + '\n-----END PUBLIC KEY-----\n';
    const r = await put(INSTANCES.b, tokenB, `/api/networks/${networkId}/members/${instanceIdA}/signing-key`, { signingPublicKey: bogus });
    assert.equal(r.status, 200, `force re-pin: ${JSON.stringify(r.body)}`);
    assert.equal(await pinnedKeyForA(), bogus, 'force-set key must be applied');
  });
});
