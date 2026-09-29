/**
 * A closed network connects every member, on its own votes (`Q-154`).
 *
 * On a voted network only the member holding a newcomer's credentials used to admit it; every other member concluded
 * the join round and connected to nobody. Now a passed join round introduces the newcomer on every member, and a
 * newcomer trusts the list of the member that admitted it.
 *
 * A creates a closed network; B joins (A alone decides); C joins, which needs A's and B's yes; B votes yes. Then B
 * and C must list each other as members — B through the passed round, C through A's list.
 *
 * Run: node --test testing/sync/a-voted-network-member-pairs-with-every-other-member.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, triggerSync, waitFor, getInstanceId } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q154-${RUN}`;

let tokenA, tokenB, tokenC, networkId, idB, idC;
const tok = (n) => fs.readFileSync(path.join(CONFIGS, n, 'token.txt'), 'utf8').trim();

async function join(base, token, myUrl) {
  const inv = await post(INSTANCES.a, tokenA, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const r = await post(base, token, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply',
    rsaPublicKeyPem: inv.body.rsaPublicKeyPem, networkId, myUrl,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const networkOn = async (base, token) => (await get(base, token, `/api/networks/${networkId}`)).body ?? {};
const memberIds = async (base, token) => ((await networkOn(base, token)).members ?? []).map(m => m.instanceId);

async function syncAll() {
  for (const [base, token] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB], [INSTANCES.c, tokenC]]) {
    await triggerSync(base, token, networkId).catch(() => {});
  }
}

before(async () => {
  tokenA = tok('a'); tokenB = tok('b'); tokenC = tok('c');
  idB = getInstanceId('ythril-b'); idC = getInstanceId('ythril-c');
  assert.equal((await post(INSTANCES.a, tokenA, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  const net = await post(INSTANCES.a, tokenA, '/api/networks', { label: SPACE, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1 });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  await join(INSTANCES.b, tokenB, 'http://ythril-b:3200');
  assert.ok((await memberIds(INSTANCES.a, tokenA)).includes(idB), 'B is admitted by A alone');
  await join(INSTANCES.c, tokenC, 'http://ythril-c:3200');
});

after(async () => {
  for (const [base, token] of [[INSTANCES.c, tokenC], [INSTANCES.b, tokenB], [INSTANCES.a, tokenA]]) {
    if (networkId) await del(base, token, `/api/networks/${networkId}`).catch(() => {});
    await delWithBody(base, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  }
});

describe('a voted network member pairs with every other member', () => {
  it('B votes C in', async () => {
    let roundId;
    await waitFor(async () => {
      await syncAll();
      const rounds = (await get(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes`)).body?.rounds ?? [];
      // C's is the only join round still open on this network: B's passed on A's word alone.
      roundId = rounds.find(r => r.type === 'join' && r.status === 'open')?.id;
      return !!roundId;
    }, 90_000, 2_000, () => 'B never learned C\'s join round');
    const yes = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
  });

  it('and then B and C list each other — B through the passed vote, C through its admitter\'s list', async () => {
    await waitFor(async () => {
      await syncAll();
      return (await memberIds(INSTANCES.b, tokenB)).includes(idC) && (await memberIds(INSTANCES.c, tokenC)).includes(idB);
    }, 120_000, 3_000, async () => `B lists ${JSON.stringify(await memberIds(INSTANCES.b, tokenB))}, C lists `
      + `${JSON.stringify(await memberIds(INSTANCES.c, tokenC))}; pending on B ${JSON.stringify((await networkOn(INSTANCES.b, tokenB)).introductions)}, `
      + `on C ${JSON.stringify((await networkOn(INSTANCES.c, tokenC)).introductions)}`);
  });
});
