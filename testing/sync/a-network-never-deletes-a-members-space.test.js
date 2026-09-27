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
 * A and B both hold a closed network, so each instance concludes and applies the round itself.
 *
 * Run: node --test testing/sync/a-network-never-deletes-a-members-space.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody, reqJson, waitFor, readRecord, mirroredNetwork } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const SPACE = `q70-${Date.now()}`;
let tokenA, tokenB, net, factId;

const spaceIds = async (base, token) => ((await get(base, token, '/api/spaces')).body?.spaces ?? []).map(s => s.id);
const networkSpaces = async (base, token) => {
  const r = await get(base, token, `/api/networks/${net.networkId}`);
  return (r.body?.network ?? r.body)?.spaces ?? null;
};
const syncBoth = async () => {
  await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
  await post(INSTANCES.a, tokenA, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
};

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    assert.equal((await post(base, t, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  }
  net = await mirroredNetwork({ label: SPACE, spaces: [SPACE], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
});

after(async () => {
  await net?.remove();
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a passed space deletion round', () => {
  it('A asks to delete the networked space, and B votes yes', async () => {
    const w = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${SPACE}/facts`, { fact: `B's own record ${SPACE}` });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    factId = w.body._id;

    const d = await reqJson(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { method: 'DELETE' });
    assert.equal(d.status, 202, JSON.stringify(d.body));
    const roundId = d.body.rounds?.[0]?.roundId;
    assert.ok(roundId, 'a round is opened');

    await waitFor(async () => {
      await syncBoth();
      const v = await get(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/votes`);
      return (v.body?.rounds ?? []).some(r => r.roundId === roundId);
    }, 60_000, 1_000, () => 'B never learned the deletion round');
    const yes = await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/votes/${roundId}`, { vote: 'yes' });
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
    const r = await readRecord(INSTANCES.b, tokenB, SPACE, 'facts', factId);
    assert.equal(r.status, 200, 'B\'s record is gone');
  });

  it('only the proposer\'s own copy is deleted', async () => {
    await waitFor(async () => !(await spaceIds(INSTANCES.a, tokenA)).includes(SPACE), 30_000, 1_000,
      () => 'A asked for the delete and still holds the space');
  });
});
