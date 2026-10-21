/**
 * A pre-6.0 proxy that was in a network leaves that network space when it becomes personal views, and its peer sees this member as
 * having LEFT it - a permanent, quiet state, not a failure every cycle (Q-531, bundle-100, plan rev 3.1 "Networks", rev 3.2
 * "Migration" and the testing vet: "network 'peers see left' in the sync suite").
 *
 * ## The rule
 *
 * The migration (`migrateProxiesToViews`, run by `reloadConfig` as well as at boot) takes the old proxy id out of every network
 * through the shared network-leave transform. What the PEER then sees is the member having left that network space: the member
 * answers a transfer of it `423 space_declined`, and the peer records the decline on its member record (`declinedSpaces`) and
 * stops asking. The other space of the same network keeps syncing.
 *
 * ## How it is built
 *
 * A closed network of A and B carries two real spaces, `SPACE` and `PX`. A's config is then hand-edited into the 5.x shape - `PX`
 * becomes a proxy over `SPACE` (`proxyFor: [SPACE]`) - and A reloads, which is what an operator restoring a 5.x config onto 6.0
 * does. Cleanup drops the view and the reservation the migration wrote, so the next run starts clean.
 *
 * ## Seen red (by reading, not run: it needs the stack)
 *
 * At 18e8d598 A reloads `PX` as a proxy and keeps it in the network (no migration exists), so A's network still lists `PX` and B
 * never records a decline. Not run in this slice: the sync suite needs the live stack (Docker), which the assignment forbids.
 *
 * Run: npm run test:up (builds and starts the stack, runs setup), then
 *      node --test testing/sync/a-migrated-proxy-leaves-its-network-space-as-its-peers-see-it.test.js
 *      (or npm run test:sync, which runs every file in this folder one at a time)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, waitFor, mirroredNetwork, patchContainerNetwork, readContainerConfig, getInstanceId, readRecord, restoreOrFail } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const STAMP = Date.now();
const SPACE = `q531-kept-${STAMP}`;
const PX = `q531-px-${STAMP}`;
let tokenA, tokenB, net, idA;

const networkOn = async (base, token) => {
  const r = await get(base, token, `/api/networks/${net.networkId}`);
  return r.body?.network ?? r.body;
};
const syncFromB = () => post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  idA = getInstanceId('ythril-a');
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    for (const id of [SPACE, PX]) assert.equal((await post(base, t, '/api/spaces', { id, label: id })).status, 201, `create ${id} on ${base}`);
  }
  net = await mirroredNetwork({ label: `q531-${STAMP}`, spaces: [SPACE, PX], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
  await syncFromB();
});

after(async () => {
  await net?.remove();
  // What the migration wrote on A: this token's view made from PX, and the reservation. Removed through the doors an operator has: a
  // reload keeps a view its file no longer lists (views are their owners' data), so a file edit cannot take it away. A copy the migration
  // gave another admin token leaves with that token.
  const mine = async () => ((await get(INSTANCES.a, tokenA, '/api/views')).body?.views ?? []).filter(v => v.name === PX || v.name?.startsWith(`${PX}-`));
  await restoreOrFail(`ythril-a: the view and the reservation migrated from ${PX}`, async () => {
    for (const v of await mine()) await del(INSTANCES.a, tokenA, `/api/views/${encodeURIComponent(v.id)}`);
    const r = await post(INSTANCES.a, tokenA, `/api/admin/views/retired/${encodeURIComponent(PX)}/purge`, {});
    if (r.status !== 200) throw new Error(`purge on A: ${r.status} ${JSON.stringify(r.body)}`);
  }, async () => (await mine()).length === 0
    && !((await get(INSTANCES.a, tokenA, '/api/spaces')).body?.retiredSpaceIds ?? []).includes(PX));
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    for (const id of [SPACE, PX]) await delWithBody(base, t, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('a migrated proxy leaves its network space, and its peer sees it as left (Q-531)', () => {
  it('control: before the migration both members carry PX in the network', async () => {
    assert.ok((await networkOn(INSTANCES.a, tokenA))?.spaces?.includes(PX), 'A does not carry PX before the migration');
    assert.ok((await networkOn(INSTANCES.b, tokenB))?.spaces?.includes(PX), 'B does not carry PX before the migration');
  });

  it('A reloads a 5.x config in which PX is a proxy: PX leaves A\'s network and A\'s spaces', async () => {
    patchContainerNetwork('ythril-a', net.networkId, `
      const px = cfg.spaces.find(s => s.id === ${JSON.stringify(PX)});
      px.proxyFor = [${JSON.stringify(SPACE)}];`);
    const r = await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    assert.equal(r.status, 200, `reload on A: ${r.status} ${JSON.stringify(r.body)}`);
    const onA = await networkOn(INSTANCES.a, tokenA);
    assert.ok(!onA.spaces.includes(PX), `A's network still carries the migrated proxy: ${JSON.stringify(onA.spaces)}`);
    assert.ok(onA.spaces.includes(SPACE), 'the migration took the other space out of the network too');
    // A reload converts in memory and saves nothing (its contract), so A is asked, not its config.json.
    const listed = await get(INSTANCES.a, tokenA, '/api/spaces');
    assert.ok(!listed.body.spaces.some(s => s.id === PX), 'PX is still a space on A');
    assert.ok((listed.body.retiredSpaceIds ?? []).includes(PX), 'PX is not reserved on A');
  });

  it('B, syncing with A, records that A left PX, and stops treating it as a failure', async () => {
    await waitFor(async () => {
      await syncFromB();
      const member = readContainerConfig('ythril-b').networks.find(n => n.id === net.networkId)?.members.find(m => m.instanceId === idA);
      return (member?.declinedSpaces ?? []).includes(PX);
    }, 60_000, 1_000, () => `B never recorded A as having left ${PX}: ${JSON.stringify(readContainerConfig('ythril-b').networks.find(n => n.id === net.networkId)?.members.find(m => m.instanceId === idA))}`,
    { what: `B recording A's leave of ${PX}` });
  });

  it('the other space of the network keeps syncing', async () => {
    const w = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${SPACE}/facts`, { fact: `kept ${STAMP}` });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    await waitFor(async () => {
      await syncFromB();
      return (await readRecord(INSTANCES.a, tokenA, SPACE, 'facts', w.body._id)).status === 200;
    }, 60_000, 1_000, () => `B's fact in ${SPACE} never reached A after the migration`, { what: `${SPACE} still syncing` });
  });
});
