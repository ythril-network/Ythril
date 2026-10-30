/**
 * Between real instances: one relationship held by two peers converges, however it came to be held (Q-222).
 *
 * A link's id IS its relationship (`linkIdFor`), and the space hash takes a link over that identity. A relationship linked on both peers must therefore
 * leave both holding one row under one id and the same space hash.
 *
 *  - **Case 1, red until the link's leaf left its author and stamps out**: the same link created independently on BOTH peers. The two creations carry their
 *    own author, `createdAt` and `updatedAt` at the one seq 1, an equal-seq link is skipped on arrival (the two rows say one thing), and the leaf hashed
 *    those, so the roots differed for ever. That is the ticket's title. The leaf is now the relationship and its seq (`byRelationship`, `merkle.ts`).
 *    (A link made on A alone and delivered to B never was the defect: ids derive. Case 1b keeps that ordinary path covered.)
 *  - **Case 2, the case that was red**: the harness pushes the relationship to A under an id that does NOT derive from its endpoints (a forged one, or
 *    a collision row an old migration left), while B creates the same relationship locally. Before the fix A stored it under that id, B's derived copy hit
 *    A's unique endpoint index and answered `duplicate` for ever, and the roots differed because a leaf hashed the stored `_id`. Now the planner refuses the
 *    underived id (`rejected`), and after a cycle both hold the one derived row and the roots agree.
 *
 * Seen red on a stack built without the Q-222 change (the 4f8c9e787 behaviour: no `underivedId` refusal, the leaf over the stored `_id`): case 2's roots
 * differ after the cycle.
 *
 * Run:  node --test testing/sync/one-relationship-linked-on-two-peers-converges.test.js
 * Pre-requisite: npm run test:up:rebuild (the A/B stack, built from this tree), which runs testing/sync/setup.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import {
  INSTANCES, post, get, getInstanceId, readCollection, createTestSpace, mirroredNetwork, syncUntil,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, idB, space, net;

const rootOf = async (base, token) => (await get(base, token, `/api/sync/merkle?spaceId=${space.id}`)).body?.root;
const linkIdsOn = async (base, token) => ((await readCollection(base, token, space.id, 'links', { limit: 200 })).results ?? []).map(l => l._id).sort();

/**
 * The two records a link joins, held IDENTICALLY by both instances (the link door refuses a dead endpoint): one fact and one entity, planted through each
 * instance's own sync door with the same body, author and stamps, so they are one record on both and nothing about them diverges.
 */
async function plantEnds(from, to) {
  const at = '2026-10-01T00:00:00.000Z';
  const author = { instanceId: idB, instanceLabel: 'Instance B' };
  for (const [base, token] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    const r = await post(base, token, `/api/sync/batch-upsert?spaceId=${space.id}`, {
      facts: [{ _id: from, spaceId: space.id, fact: `link end ${from}`, tags: [], author, createdAt: at, updatedAt: at, seq: 3 }],
      entities: [{ _id: to, spaceId: space.id, name: `Link end ${to}`, type: 'concept', tags: [], properties: {}, author, createdAt: at, updatedAt: at, seq: 3 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}

/** Create the relationship `from -> to` through an instance's own link door; returns its (derived) id. */
async function createLink(base, token, from, to) {
  const r = await post(base, token, `/api/brain/spaces/${space.id}/links`, { from, fromKind: 'fact', to, toKind: 'entity' });
  assert.ok(r.status === 201 || r.status === 200, `link create answered ${r.status} ${JSON.stringify(r.body)}`);
  return r.body?._id ?? r.body?.id;
}

describe('one relationship linked on two peers converges, between real instances', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    idB = getInstanceId('ythril-b');
    space = await createTestSpace('link-conv', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    net = await mirroredNetwork({ label: `Link conv ${Date.now()}`, spaces: [space.id], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
  });

  after(async () => {
    await net?.remove();
    await space?.remove();
  });

  const agree = async () => (await rootOf(INSTANCES.a, tokenA)) === (await rootOf(INSTANCES.b, tokenB))
    && JSON.stringify(await linkIdsOn(INSTANCES.a, tokenA)) === JSON.stringify(await linkIdsOn(INSTANCES.b, tokenB));

  it('case 1: the same link created independently on both peers: after one cycle the roots agree', async () => {
    const from = randomUUID(), to = randomUUID();
    await plantEnds(from, to);
    const idOnA = await createLink(INSTANCES.a, tokenA, from, to);
    const idOnB = await createLink(INSTANCES.b, tokenB, from, to);
    assert.equal(idOnB, idOnA, 'fixture check: both peers derive one id for one relationship');
    await syncUntil(INSTANCES.a, tokenA, net.networkId, agree, 'both peers to hold the same links and one space hash', {
      timeoutMs: 40_000,
      onTimeout: async () => JSON.stringify({ a: await linkIdsOn(INSTANCES.a, tokenA), b: await linkIdsOn(INSTANCES.b, tokenB), roots: [await rootOf(INSTANCES.a, tokenA), await rootOf(INSTANCES.b, tokenB)] }),
    });
    assert.deepEqual(await linkIdsOn(INSTANCES.b, tokenB), [idOnA]);
    assert.equal(await rootOf(INSTANCES.a, tokenA), await rootOf(INSTANCES.b, tokenB));
  });

  it('case 1b: a link created on A reaches B under the one derived id: after one cycle the roots agree (ids derive)', async () => {
    const from = randomUUID(), to = randomUUID();
    await plantEnds(from, to);
    const idOnA = await createLink(INSTANCES.a, tokenA, from, to);
    await syncUntil(INSTANCES.a, tokenA, net.networkId, agree, 'both peers to hold the same links and one space hash', { timeoutMs: 40_000 });
    assert.deepEqual(await linkIdsOn(INSTANCES.b, tokenB), [idOnA], 'B holds the link under the id its endpoints derive');
    assert.equal(await rootOf(INSTANCES.a, tokenA), await rootOf(INSTANCES.b, tokenB));
  });

  it('case 2: the relationship pushed to A under an id that does not derive, while B creates it locally: after one cycle the roots agree', async () => {
    const from = randomUUID(), to = randomUUID();
    await plantEnds(from, to);
    const now = new Date().toISOString();
    const forged = `underived-${Date.now()}`;
    const pushed = await post(INSTANCES.a, tokenA, `/api/sync/batch-upsert?spaceId=${space.id}`, {
      links: [{ _id: forged, spaceId: space.id, from, fromKind: 'fact', to, toKind: 'entity',
        author: { instanceId: idB, instanceLabel: 'Instance B' }, createdAt: now, updatedAt: now, seq: 7 }],
    });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    const derived = await createLink(INSTANCES.b, tokenB, from, to);
    assert.notEqual(derived, forged, 'fixture check: the id B derives is the one the harness pushed');
    await syncUntil(INSTANCES.a, tokenA, net.networkId, agree, 'both peers to hold the same links and one space hash', {
      timeoutMs: 40_000,
      onTimeout: async () => JSON.stringify({ a: await linkIdsOn(INSTANCES.a, tokenA), b: await linkIdsOn(INSTANCES.b, tokenB), roots: [await rootOf(INSTANCES.a, tokenA), await rootOf(INSTANCES.b, tokenB)] }),
    });
    assert.equal(await rootOf(INSTANCES.a, tokenA), await rootOf(INSTANCES.b, tokenB), 'the space hashes agree');
    assert.ok((await linkIdsOn(INSTANCES.a, tokenA)).includes(derived), 'A holds the derived row');
  });
});
