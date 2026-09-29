/**
 * A club is a mesh, not a star around whoever admitted each member (`Q-135`).
 *
 * Owner, 2026-09-28: *"on club breituai and home dont see each other - wrong in a club"*. An admission used to land
 * on the admitting instance alone: B and C, both admitted by A, never learned of each other, so every record between
 * them travelled through A and the club stopped when A did.
 *
 * Now each member learns the others from its peers' rosters during gossip, and the two pair directly — the lower
 * instance id opens, the other proves the caller by calling back the address its own peer vouched for.
 *
 * A organises; A admits B, then C. Then: B and C list each other as members, a record written on C reaches B with A
 * stopped, and a removal on A reaches B.
 *
 * Run: node --test testing/sync/a-club-member-pairs-with-every-other-member.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { execSync } from 'node:child_process';
import { INSTANCES, post, get, del, delWithBody, triggerSync, waitFor, getInstanceId } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q135-${RUN}`;

let tokenA, tokenB, tokenC, networkId, idB, idC, aStopped = false;

const tok = (n) => fs.readFileSync(path.join(CONFIGS, n, 'token.txt'), 'utf8').trim();

async function join(base, token, myUrl) {
  const inv = await post(INSTANCES.a, tokenA, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const r = await post(base, token, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply',
    rsaPublicKeyPem: inv.body.rsaPublicKeyPem, networkId, myUrl,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

const networkOn = async (base, token) => (await get(base, token, `/api/networks/${networkId}`)).body ?? {};
const memberIds = async (base, token) => ((await networkOn(base, token)).members ?? []).map(m => m.instanceId);

async function syncAll() {
  for (const [base, token] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB], [INSTANCES.c, tokenC]]) {
    if (aStopped && base === INSTANCES.a) continue;
    await triggerSync(base, token, networkId).catch(() => {});
  }
}

const aIsUp = async () => (await fetch(`${INSTANCES.a}/health`).catch(() => null))?.ok === true;

async function startA() {
  if (!aStopped) return;
  execSync('docker start ythril-a', { stdio: 'ignore' });
  aStopped = false;
  await waitFor(aIsUp, 90_000, 1_000, () => 'ythril-a did not come back after the stop');
}

before(async () => {
  tokenA = tok('a'); tokenB = tok('b'); tokenC = tok('c');
  idB = getInstanceId('ythril-b'); idC = getInstanceId('ythril-c');
  assert.equal((await post(INSTANCES.a, tokenA, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  const net = await post(INSTANCES.a, tokenA, '/api/networks', { label: SPACE, type: 'club', spaces: [SPACE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  await join(INSTANCES.b, tokenB, 'http://ythril-b:3200');
  await join(INSTANCES.c, tokenC, 'http://ythril-c:3200');
});

after(async () => {
  await startA().catch(() => {});
  for (const [base, token] of [[INSTANCES.c, tokenC], [INSTANCES.b, tokenB], [INSTANCES.a, tokenA]]) {
    if (networkId) await del(base, token, `/api/networks/${networkId}`).catch(() => {});
    await delWithBody(base, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  }
});

describe('a club member pairs with every other member', () => {
  it('B and C, both admitted by A, list each other after a sync', async () => {
    await waitFor(async () => {
      await syncAll();
      return (await memberIds(INSTANCES.b, tokenB)).includes(idC) && (await memberIds(INSTANCES.c, tokenC)).includes(idB);
    }, 90_000, 2_000, async () => `B lists ${JSON.stringify(await memberIds(INSTANCES.b, tokenB))}, C lists `
      + `${JSON.stringify(await memberIds(INSTANCES.c, tokenC))}; pending on B ${JSON.stringify((await networkOn(INSTANCES.b, tokenB)).introductions)}`);
  });

  it('and a record written on C reaches B with A stopped', async () => {
    const w = await post(INSTANCES.c, tokenC, `/api/brain/spaces/${SPACE}/facts`, { fact: `written on C ${RUN}` });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    execSync('docker stop ythril-a', { stdio: 'ignore' });
    aStopped = true;
    await waitFor(async () => {
      await syncAll();
      const r = await post(INSTANCES.b, tokenB, '/api/filter', { space: SPACE, collection: 'facts', filter: { _id: w.body._id } });
      return ((r.body?.data ?? r.body)?.results ?? []).some(f => f._id === w.body._id);
    }, 90_000, 2_000, () => 'the record never reached B without the organiser');
  });

  it('a removal on A reaches B', async () => {
    await startA();
    const r = await del(INSTANCES.a, tokenA, `/api/networks/${networkId}/members/${idC}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    await waitFor(async () => {
      await syncAll();
      return !(await memberIds(INSTANCES.b, tokenB)).includes(idC);
    }, 90_000, 2_000, async () => `B still lists ${JSON.stringify(await memberIds(INSTANCES.b, tokenB))}`);
  });
});
