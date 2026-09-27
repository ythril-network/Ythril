/**
 * A network never deletes a member's space (`Q-70`).
 *
 * Deleting a networked space opened a `space_deletion` round, and when it passed every member deleted its own copy
 * — on a club or a pub/sub, on the proposer's yes alone. Owner's ruling, 2026-09-26: *"wipe ok, risky but intended
 * FOR THE NETWORKS' data. space deletion: not okay. in that case that should be a 'remove space from network and
 * delete for self' so everyone else can keep their copy locally or even readd in case it was not intended."*
 *
 * So a passed round takes the space OUT of the network on every member, and deletes only the proposer's copy — the
 * instance whose operator asked for a delete. Every other member keeps its space and its data, as a local space.
 *
 * A and B hold a closed network both ways, so each instance has the network and applies the round itself.
 *
 * Run: node --test testing/sync/a-network-never-deletes-a-members-space.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, get, del, delWithBody, reqJson, triggerSync, waitFor, getInstanceId } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q70-${RUN}`;
let tokenA, tokenB, networkId, idA, idB;

function injectPeerToken(container, instanceId, token) {
  const script = [
    `const fs=require('fs');`, `const p='/config/secrets.json';`,
    `const s=JSON.parse(fs.readFileSync(p,'utf8'));`, `s.peerTokens=s.peerTokens||{};`,
    `s.peerTokens['${instanceId}']='${token}';`, `fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600});`,
  ].join('');
  dockerExec(`docker exec ${container} node -e "${script}"`);
}
const spaceIds = async (base, token) => ((await get(base, token, '/api/spaces')).body?.spaces ?? []).map(s => s.id);
const networkSpaces = async (base, token) => {
  const r = await get(base, token, `/api/networks/${networkId}`);
  return (r.body?.network ?? r.body)?.spaces ?? null;
};
const syncBoth = async () => {
  await triggerSync(INSTANCES.b, tokenB, networkId).catch(() => {});
  await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
};

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  idA = getInstanceId('ythril-a');
  idB = getInstanceId('ythril-b');
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    const s = await post(base, t, '/api/spaces', { id: SPACE, label: SPACE });
    assert.equal(s.status, 201, JSON.stringify(s.body));
  }
  const forA = await post(INSTANCES.b, tokenB, '/api/tokens', { name: `q70-a-${RUN}`, peerInstanceId: idA });
  const forB = await post(INSTANCES.a, tokenA, '/api/tokens', { name: `q70-b-${RUN}`, peerInstanceId: idB });
  assert.equal(forA.status, 201); assert.equal(forB.status, 201);

  const net = await post(INSTANCES.a, tokenA, '/api/networks', { label: `q70-${RUN}`, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1 });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
    instanceId: idB, label: 'Q70 B', url: 'http://ythril-b:3200', token: forA.body.plaintext, direction: 'both',
  });
  if (addB.status === 202) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
  const netB = await post(INSTANCES.b, tokenB, '/api/networks', { id: networkId, label: `q70-${RUN}`, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1 });
  assert.ok(netB.status === 201 || netB.status === 409, JSON.stringify(netB.body));
  const addA = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
    instanceId: idA, label: 'Q70 A', url: 'http://ythril-a:3200', token: forB.body.plaintext, direction: 'both',
  });
  if (addA.status === 202) await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${addA.body.roundId}`, { vote: 'yes' });
  injectPeerToken('ythril-a', idB, forA.body.plaintext);
  injectPeerToken('ythril-b', idA, forB.body.plaintext);
  await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
  await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a passed space deletion round', () => {
  let factId;

  it('A asks to delete the networked space, and B votes yes', async () => {
    const w = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${SPACE}/facts`, { fact: `B's own record ${RUN}` });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    factId = w.body._id;

    const d = await reqJson(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { method: 'DELETE' });
    assert.equal(d.status, 202, JSON.stringify(d.body));
    const roundId = d.body.rounds?.[0]?.roundId;
    assert.ok(roundId, 'a round is opened');

    // B learns the round from A, then casts its own yes, which A learns on the next cycle.
    await waitFor(async () => {
      await syncBoth();
      const v = await get(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes`);
      return (v.body?.rounds ?? []).some(r => r.roundId === roundId);
    }, 60_000, 2_000, () => 'B never learned the deletion round');
    const yes = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
  });

  it('takes the space out of the network on both members', async () => {
    await waitFor(async () => {
      await syncBoth();
      const a = await networkSpaces(INSTANCES.a, tokenA);
      const b = await networkSpaces(INSTANCES.b, tokenB);
      return Array.isArray(a) && Array.isArray(b) && !a.includes(SPACE) && !b.includes(SPACE);
    }, 90_000, 2_000, async () => `A lists ${JSON.stringify(await networkSpaces(INSTANCES.a, tokenA))}, B lists ${JSON.stringify(await networkSpaces(INSTANCES.b, tokenB))}`);
  });

  it('B keeps its copy and its data', async () => {
    assert.ok((await spaceIds(INSTANCES.b, tokenB)).includes(SPACE), 'the round deleted B\'s space');
    const r = await get(INSTANCES.b, tokenB, `/api/brain/spaces/${SPACE}/facts/${factId}`);
    assert.equal(r.status, 200, 'B\'s record is gone');
  });

  it('only the proposer\'s own copy is deleted', async () => {
    await waitFor(async () => !(await spaceIds(INSTANCES.a, tokenA)).includes(SPACE), 30_000, 1_000,
      () => 'A asked for the delete and still holds the space');
  });
});
