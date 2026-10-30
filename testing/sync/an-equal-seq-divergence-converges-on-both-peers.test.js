/**
 * Between real instances: two copies of one fact at one seq with different text converge on BOTH peers (Q-324).
 *
 * ## The scenario
 *
 * A holds `X` and B holds `Y` for one fact id, at the same seq (planted through each instance's own sync door, so neither has a reason to have won).
 * A network with `merkle: true` shares the space both ways. Before the rule each instance forked the ARRIVING copy and kept its own text as the parent:
 * A ended `parent X, forks {X, Y}`, B `parent Y, forks {X, Y}`. The fork sets agreed, the parents did not, so the space hash differed for ever.
 *
 * ## What it asserts after the cycle
 *
 *  - the parent text is the same on both instances (the lower body hash, whichever that is: it is read back, never assumed, from what both hold);
 *  - the parent is one of the two planted texts, and the other is held as ONE fork on each (`forkOf` names the parent), so nothing was lost;
 *  - `GET /api/sync/merkle` agrees on both.
 *
 * Seen red on a stack built with the tie rule off (the arriving copy always forks, as at 78fe14af5): the parents differ and the roots differ.
 *
 * Run:  node --test testing/sync/an-equal-seq-divergence-converges-on-both-peers.test.js
 * Pre-requisite: npm run test:up:rebuild (the A/B stack, built from this tree), which runs testing/sync/setup.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
  INSTANCES, post, get, getInstanceId, readRecord, readCollection, createTestSpace, mirroredNetwork, syncUntil,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, idA, idB, space, net;

/** One fact at seq 5 stored through an instance's own sync door: the one door that keeps an author and a seq as sent. */
async function plant(base, token, spaceId, id, text, authorId) {
  const now = new Date().toISOString();
  const r = await post(base, token, `/api/sync/batch-upsert?spaceId=${spaceId}`, {
    facts: [{ _id: id, spaceId, fact: text, tags: [], author: { instanceId: authorId, instanceLabel: authorId }, createdAt: now, updatedAt: now, seq: 5 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.facts?.inserted, 1, `the fixture fact was not stored: ${JSON.stringify(r.body)}`);
}

const rootOf = async (base, token) => (await get(base, token, `/api/sync/merkle?spaceId=${space.id}`)).body?.root;
const parentOf = async (base, token, id) => (await readRecord(base, token, space.id, 'facts', id)).body?.fact;
const forksOf = async (base, token, id) => ((await readCollection(base, token, space.id, 'facts', { filter: { forkOf: id }, limit: 50 })).results ?? []).map(r => r.fact).sort();

describe('an equal-seq divergence converges on both peers, between real instances', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    idA = getInstanceId('ythril-a');
    idB = getInstanceId('ythril-b');
    space = await createTestSpace('eq-seq', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    net = await mirroredNetwork({ label: `Equal seq ${Date.now()}`, spaces: [space.id], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
  });

  after(async () => {
    await net?.remove();
    await space?.remove();
  });

  it('A holds one text, B holds another, at one seq: after the cycle both hold the same parent and the same fork, and the space hashes agree', async () => {
    const id = `eq-seq-${Date.now()}`;
    const textA = `what instance A wrote ${id}`;
    const textB = `what instance B wrote ${id}`;
    await plant(INSTANCES.a, tokenA, space.id, id, textA, idA);
    await plant(INSTANCES.b, tokenB, space.id, id, textB, idB);

    const settled = async () => {
      const [pa, pb] = [await parentOf(INSTANCES.a, tokenA, id), await parentOf(INSTANCES.b, tokenB, id)];
      if (pa === undefined || pa !== pb) return false;
      const [fa, fb] = [await forksOf(INSTANCES.a, tokenA, id), await forksOf(INSTANCES.b, tokenB, id)];
      if (fa.length !== 1 || JSON.stringify(fa) !== JSON.stringify(fb)) return false;
      return (await rootOf(INSTANCES.a, tokenA)) === (await rootOf(INSTANCES.b, tokenB));
    };
    await syncUntil(INSTANCES.a, tokenA, net.networkId, settled, 'both peers to hold one parent, one fork and one space hash', {
      timeoutMs: 40_000,
      onTimeout: async () => JSON.stringify({
        parents: [await parentOf(INSTANCES.a, tokenA, id), await parentOf(INSTANCES.b, tokenB, id)],
        forks: [await forksOf(INSTANCES.a, tokenA, id), await forksOf(INSTANCES.b, tokenB, id)],
        roots: [await rootOf(INSTANCES.a, tokenA), await rootOf(INSTANCES.b, tokenB)],
      }),
    });

    const parent = await parentOf(INSTANCES.a, tokenA, id);
    const forks = await forksOf(INSTANCES.a, tokenA, id);
    assert.deepEqual([parent, ...forks].sort(), [textA, textB].sort(), 'the two planted texts are what the two instances hold between them: nothing lost, nothing made up');
    assert.deepEqual(await forksOf(INSTANCES.b, tokenB, id), forks, 'B holds the same fork as A');
    assert.equal(await parentOf(INSTANCES.b, tokenB, id), parent, 'B holds the same parent as A');
    assert.equal(await rootOf(INSTANCES.a, tokenA), await rootOf(INSTANCES.b, tokenB), 'the space hashes agree');
    // The fork names its parent, as Review reads it.
    const fork = (await readCollection(INSTANCES.b, tokenB, space.id, 'facts', { filter: { forkOf: id }, limit: 5 })).results[0];
    assert.equal(fork.forkOf, id);
  });
});
