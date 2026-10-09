/**
 * Integration test: expired vote rounds are pruned during a sync cycle (P14).
 *
 * `concludeRoundIfReady` marks rounds `concluded` but never removes them from
 * `pendingRounds`, so the array would grow for the life of the network. The sync engine
 * now prunes rounds that are concluded AND past their deadline, once per cycle. This test
 * proves the wiring end-to-end against a running instance: inject three rounds directly
 * into A's config — one concluded+expired (must be pruned), one concluded-but-future (must
 * survive) and one open+expired (the expiry job concludes it, records it, and it is pruned) —
 * run sync cycles, and assert the outcome and the record of how each ended.
 *
 * The prune runs post-member-loop and unconditionally, so a reachable peer is not
 * required; the injected peer only exists so the network has a member to iterate.
 *
 * Run:  node --test testing/sync/vote-round-prune-sync.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, del, delWithBody, waitFor, makeTriggerProbe, patchContainerNetwork } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, instanceIdA, networkId, testSpaceId;

function readConfig(c) {
  return JSON.parse(dockerExec(`docker exec ${c} node -e "const fs=require('fs');process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`).toString());
}
const patch = patchContainerNetwork;

function roundIds(c, netId) {
  const net = readConfig(c).networks.find(n => n.id === netId);
  return new Set((net?.pendingRounds ?? []).map(r => r.roundId));
}

describe('Expired vote rounds are pruned during sync', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    instanceIdA = dockerExec(`docker exec ythril-a node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync('/config/config.json','utf8')).instanceId)"`).toString().trim();

    testSpaceId = `prune-${Date.now()}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Prune Test Space' });

    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Prune ${Date.now()}`, type: 'closed', spaces: [testSpaceId], votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, JSON.stringify(netR.body));
    networkId = netR.body.id;

    // Give the network a member so the cycle has something to iterate. It is virtual and
    // unreachable — irrelevant to the prune, which runs after the member loop regardless.
    patch('ythril-a', networkId, `n.members.push({instanceId:'virt-prune-${Date.now()}',label:'Virtual',url:'http://virtual-prune.internal:3200',tokenHash:'x',direction:'both'});`);
    await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });

  it('prunes concluded+expired rounds, concludes and records open-expired ones, and keeps concluded-future ones', async () => {
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();       // 1 min ago
    const futureDeadline = new Date(Date.now() + 3_600_000).toISOString();  // 1 h ahead
    const mk = (roundId, concluded, deadline) => ({
      roundId, type: 'remove', subjectInstanceId: 'ghost', subjectLabel: 'Ghost',
      subjectUrl: 'http://ghost.internal:3200', deadline,
      openedAt: new Date().toISOString(), concluded, votes: [],
    });

    // Inject three rounds directly into A's pendingRounds and reload.
    patch('ythril-a', networkId,
      `n.pendingRounds=n.pendingRounds||[];` +
      `n.pendingRounds.push(${JSON.stringify(mk('drop-concluded-expired', true, pastDeadline))});` +
      `n.pendingRounds.push(${JSON.stringify(mk('keep-concluded-future', true, futureDeadline))});` +
      `n.pendingRounds.push(${JSON.stringify(mk('keep-open-expired', false, pastDeadline))});`);
    await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});

    const before = roundIds('ythril-a', networkId);
    assert.ok(before.has('drop-concluded-expired'), 'setup: expired round is present before sync');
    assert.ok(before.has('keep-concluded-future'));
    assert.ok(before.has('keep-open-expired'));

    // Trigger sync cycles on A until both expired rounds are gone from its on-disk config. The first is pruned by the sync
    // cycle; the second is open on paper, so the expiry job (a tick a minute) has to conclude it before anything can prune it.
    const triggerA = makeTriggerProbe(INSTANCES.a, tokenA, networkId, 'A');
    await waitFor(async () => {
      await triggerA();
      const held = roundIds('ythril-a', networkId);
      return !held.has('drop-concluded-expired') && !held.has('keep-open-expired');
    }, 120_000, 2_000, triggerA.diagnose);

    const after = roundIds('ythril-a', networkId);
    assert.ok(!after.has('drop-concluded-expired'), 'concluded+expired round must be pruned');
    assert.ok(after.has('keep-concluded-future'), 'concluded-but-within-deadline round must survive (may still need to propagate)');
    // Concluded by the job (not left open until a cast or a peer touches it), recorded, and then pruned like any other.
    assert.ok(!after.has('keep-open-expired'), 'an open round past its deadline is concluded by the expiry job and pruned, not kept as live governance');

    const log = Object.fromEntries((readConfig('ythril-a').networks.find(n => n.id === networkId)?.roundOutcomes ?? []).map(e => [e.roundId, e]));
    assert.equal(log['keep-open-expired']?.outcome, 'expired', 'the round the job ended is recorded as expired — pruning must not lose how it ended');
    assert.ok(log['keep-open-expired']?.concludedAt, 'and dated');
    assert.equal(log['drop-concluded-expired']?.outcome, 'ended', 'a round concluded before the outcome was recorded is kept as ended, reason not recorded');
    assert.equal(log['keep-concluded-future'], undefined, 'a round that is still held has not been recorded as past');
  });
});
