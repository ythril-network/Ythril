/**
 * A member that leaves a network before a passed rebase reaches its deadline keeps its base; the member that stays lands it (Q-748, slice A;
 * owner, 2026-11-18: a base change on a shared space is applied at the vote's deadline, and a member that left keeps its base).
 *
 * On a club network A organises with B, both holding RDF on for a shared space at one base, A proposes a `space_rebase`: the proposer's yes
 * passes it at open. B learns the round and leaves the network before the deadline. The deadline is then brought into the past on A (inside
 * A's container, as the relayer tests alter A's rounds) and A's expiry job lands it: A holds the new base at epoch 1 with one
 * `space.rdf_rebase` audit entry; B holds the old base at epoch 0, with no such entry and no conflict, because the network is gone there.
 *
 * Two members, not the design's three: the stayer is the proposer here, which is the member every rebase lands on; a third member that stays
 * lands it by the same expiry pass (`a-passed-rebase-lands-at-its-deadline-db` holds the landing itself).
 *
 * Run: node --test testing/sync/a-member-that-leaves-before-a-rebase-keeps-its-base.test.js (the sync stack up, built from this branch)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, get, patch, post, del, waitFor, mirroredNetwork, delWithBody, patchContainerNetwork, readContainerConfig, reloadConfig } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const SPACE = `rdf-leave-${Date.now()}`;
const OLD = `https://old.example.org/ld/${SPACE}/`;
const NEW = `https://new.example.org/ld/${SPACE}/`;
/** The expiry job runs every minute; a pass after the moved deadline lands within two. */
const LANDS_WITHIN_MS = 150_000;
let tokenA, tokenB, net, roundId;

const metaOf = async (base, token) => ((await get(base, token, `/api/spaces/${SPACE}`)).body?.space ?? {}).meta ?? {};
const rebaseAudits = async (base, token) => ((await get(base, token, `/api/admin/audit-log?operation=space.rdf_rebase&limit=50`)).body?.entries ?? [])
  .filter(e => e.spaceId === SPACE);
const syncBoth = async () => {
  await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
  await post(INSTANCES.a, tokenA, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
};

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    assert.equal((await post(base, t, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
    // Each member switches RDF on while the space is its own, at one base: what a shared space holds once its first enable passed.
    assert.equal((await patch(base, t, `/api/spaces/${SPACE}`, { meta: { rdf: { enabled: true, base: OLD } } })).status, 200);
  }
  net = await mirroredNetwork({ label: SPACE, spaces: [SPACE], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB], type: 'club' });
});

after(async () => {
  await net?.remove();
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a member that leaves before a rebase keeps its base', () => {
  it('A proposes the rebase: a space_rebase round, passed at open, and the base unchanged', async () => {
    const w = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { rdf: { enabled: true, base: NEW, rebase: true } } });
    assert.equal(w.status, 202, JSON.stringify(w.body));
    roundId = w.body?.rounds?.[0]?.roundId;
    assert.ok(roundId, 'a round is opened');
    assert.equal((await metaOf(INSTANCES.a, tokenA)).rdf?.base, OLD, 'the base moved at the pass');
  });

  it('B learns the round, then leaves the network before the deadline', async () => {
    // A club round passes at open, so it is in no list of OPEN rounds: B's own config says whether it holds it.
    await waitFor(async () => {
      await syncBoth();
      const held = readContainerConfig('ythril-b').networks?.find(n => n.id === net.networkId)?.pendingRounds ?? [];
      return held.some(r => r.roundId === roundId && r.type === 'space_rebase');
    }, 60_000, 1_000, () => 'B never learned the rebase round');
    const left = await del(INSTANCES.b, tokenB, `/api/networks/${net.networkId}`);
    assert.ok(left.status < 300, `B could not leave: ${left.status}`);
  });

  it('past the deadline A lands it; B keeps the old base, with no audit entry and no conflict', async () => {
    patchContainerNetwork('ythril-a', net.networkId, `for (const r of n.pendingRounds) if (r.roundId === ${JSON.stringify(roundId)}) r.deadline = new Date(Date.now() - 1000).toISOString();`);
    await reloadConfig(INSTANCES.a, tokenA);
    await waitFor(async () => (await metaOf(INSTANCES.a, tokenA)).rdf?.base === NEW, LANDS_WITHIN_MS, 5_000, () => 'A never landed the passed rebase');
    const a = await metaOf(INSTANCES.a, tokenA);
    assert.deepEqual(a.rdf, { enabled: true, base: NEW, vocab: `${NEW}vocab/`, baseEpoch: 1 });
    assert.equal((await rebaseAudits(INSTANCES.a, tokenA)).length, 1, 'A writes one space.rdf_rebase entry');
    const b = await metaOf(INSTANCES.b, tokenB);
    assert.deepEqual(b.rdf, { enabled: true, base: OLD, vocab: `${OLD}vocab/`, baseEpoch: 0 }, 'the member that left lost its base');
    assert.equal(b.rdfBaseConflict, undefined);
    assert.equal((await rebaseAudits(INSTANCES.b, tokenB)).length, 0);
  });
});
