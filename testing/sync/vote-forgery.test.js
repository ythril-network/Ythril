/**
 * Red-team integration test: vote forgery via the gossip pull path.
 *
 * Threat: a single malicious network member serves a fabricated vote round via
 * GET /api/sync/networks/:id/votes, pre-stuffed with `yes` casts forged on behalf
 * of OTHER members who never voted. Before the fix, the victim merged those
 * forged casts on pull and `concludeRoundIfReady` would conclude the round —
 * ejecting members / deleting spaces without real quorum.
 *
 * The fix (server/src/sync/engine.ts) accepts only a peer's OWN vote during the
 * pull-merge (`peerCast.instanceId === member.instanceId`), so a forged cast
 * attributed to another instance is ignored and the round never concludes.
 *
 * Scenario: closed network with members A and B. B (malicious) injects a
 * `remove` round for subject B, carrying a forged `yes` vote attributed to A.
 * A pulls from B. A must NOT accept the forged A-vote, so the round must not
 * conclude and B must remain in A's member list.
 *
 * Run:  node --test testing/sync/vote-forgery.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, reloadConfig, del, delWithBody, triggerSync, waitFor, dockerExec, readContainerConfig, getInstanceId } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB;
let instanceIdA, instanceIdB;
let peerTokenForA, peerTokenForB;
let networkId, testSpaceId;

function injectPeerToken(container, instanceId, token) {
  const script = [
    `const fs=require('fs');`,
    `const p='/config/secrets.json';`,
    `const s=JSON.parse(fs.readFileSync(p,'utf8'));`,
    `s.peerTokens=s.peerTokens||{};`,
    `s.peerTokens['${instanceId}']='${token}';`,
    `fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600});`,
    `process.stdout.write('ok');`,
  ].join('');
  dockerExec(`docker exec ${container} node -e "${script}"`);
}

/** Inject a fabricated vote round into a container's network config. */
function injectRound(container, netId, round) {
  const payload = Buffer.from(JSON.stringify(round)).toString('base64');
  const script = [
    `const fs=require('fs');`,
    `const p='/config/config.json';`,
    `const c=JSON.parse(fs.readFileSync(p,'utf8'));`,
    `const n=c.networks.find(x=>x.id==='${netId}');`,
    `n.pendingRounds=n.pendingRounds||[];`,
    `n.pendingRounds.push(JSON.parse(Buffer.from('${payload}','base64').toString('utf8')));`,
    `fs.writeFileSync(p,JSON.stringify(c,null,2),{mode:0o600});`,
    `process.stdout.write('ok');`,
  ].join('');
  dockerExec(`docker exec ${container} node -e "${script}"`);
}

describe('Vote forgery via gossip pull is rejected', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    testSpaceId = `vote-forgery-${Date.now()}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Vote Forgery Test Space' });
    await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'Vote Forgery Test Space' });

    const ptForA = await post(INSTANCES.b, tokenB, '/api/tokens', {
      name: `vf-peer-a-${Date.now()}`, peerInstanceId: instanceIdA,
    });
    peerTokenForA = ptForA.body.plaintext;
    const ptForB = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `vf-peer-b-${Date.now()}`, peerInstanceId: instanceIdB,
    });
    peerTokenForB = ptForB.body.plaintext;

    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Vote Forgery ${Date.now()}`,
      type: 'closed',
      spaces: [testSpaceId],
      votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, `Create network: ${JSON.stringify(netR.body)}`);
    networkId = netR.body.id;

    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdB, label: 'Instance B', url: 'http://ythril-b:3200', token: peerTokenForA, direction: 'both',
    });
    if (addB.status === 202) {
      await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
    }

    const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
      id: networkId, label: 'Vote Forgery', type: 'closed', spaces: [testSpaceId], votingDeadlineHours: 1,
    });
    assert.ok(netOnB.status === 201 || netOnB.status === 409, `Create net on B: ${JSON.stringify(netOnB.body)}`);
    const addAonB = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdA, label: 'Instance A', url: 'http://ythril-a:3200', token: peerTokenForB, direction: 'both',
    });
    if (addAonB.status === 202) {
      await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${addAonB.body.roundId}`, { vote: 'yes' });
    }

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

  it('A ignores a forged yes-vote (attributed to A) served by malicious peer B', async () => {
    // Sanity: B is currently a member on A.
    const before = readContainerConfig('ythril-a').networks.find(n => n.id === networkId);
    assert.ok(before.members.some(m => m.instanceId === instanceIdB), 'Precondition: B is a member on A');

    // Malicious B injects a remove round (subject = B) carrying a FORGED yes vote
    // attributed to A. If A trusts relayed casts, this concludes and A removes B.
    const forgedRoundId = `forged-${Date.now()}`;
    injectRound('ythril-b', networkId, {
      roundId: forgedRoundId,
      type: 'remove',
      subjectInstanceId: instanceIdB,
      subjectLabel: 'Instance B',
      subjectUrl: 'http://ythril-b:3200',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      openedAt: new Date().toISOString(),
      votes: [{ instanceId: instanceIdA, vote: 'yes', castAt: new Date().toISOString() }],
    });
    await reloadConfig(INSTANCES.b, tokenB);

    // A pulls from B (gossip). Repeat a couple of times to be sure the round was seen.
    await triggerSync(INSTANCES.a, tokenA, networkId);
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // Give A a moment to persist, then assert the forgery had no effect.
    await waitFor(async () => {
      const netA = readContainerConfig('ythril-a').networks.find(n => n.id === networkId);
      // B must still be a member (round did not conclude and remove it).
      return !!netA && netA.members.some(m => m.instanceId === instanceIdB);
    }, 8_000).catch(() => {});

    const netA = readContainerConfig('ythril-a').networks.find(n => n.id === networkId);
    assert.ok(
      netA.members.some(m => m.instanceId === instanceIdB),
      'VULNERABILITY: forged vote concluded a remove round — B was ejected from A',
    );

    const adopted = netA.pendingRounds?.find(r => r.roundId === forgedRoundId);
    if (adopted) {
      assert.ok(
        !adopted.votes?.some(v => v.instanceId === instanceIdA),
        'VULNERABILITY: A adopted a forged vote attributed to itself',
      );
      assert.ok(!adopted.concluded, 'VULNERABILITY: forged round concluded on A');
    }
  });
});
