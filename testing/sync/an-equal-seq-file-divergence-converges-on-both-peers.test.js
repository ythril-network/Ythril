/**
 * Between real instances: one file's metadata held at ONE version with DIFFERENT content on two peers ends as one row on both, and the instance whose
 * copy lost keeps it as a metadata conflict of its own (Q-426).
 *
 * Before the fix an equal-seq file row with other authored content was `skipped` by the receiver on every door: A kept what A wrote, B kept what B wrote,
 * and the space hashes differed for ever. Now both apply the same tie (`arrivingWinsTie` over `fileContentHash`, the lower hash is the row): the instance
 * whose copy is the higher one replaces it and keeps the displaced metadata as a conflict listed by `GET /api/conflicts`.
 *
 * The two arrival doors are driven SEPARATELY, because one rule with two doors is the defect class this repo makes:
 *
 *  - **the push leg**: each peer's copy is delivered to the other through `POST /api/sync/batch-upsert` with a peer token, as that peer's own push would. A
 *    real engine cannot drive a push alone between two instances that both take writes (its own network would refuse the inbound push), so the door is
 *    called as the peer calls it, in a space no network covers.
 *  - **the pull leg**: a network whose members only PULL from each other (`direction: 'pull'`), cycled until both hold the same row.
 *
 * Each leg asserts: both instances hold one row (the same description, at the planted seq); the space hashes agree (`/api/sync/merkle`); exactly one
 * instance holds a metadata conflict, it is the one whose planted description is not the row, and it names that description.
 *
 * Seen red on a stack built from the base (993447fb6): both legs time out or fail on the first assertion, each instance still holding its own description.
 *
 * Run:  node --test testing/sync/an-equal-seq-file-divergence-converges-on-both-peers.test.js
 * Pre-requisite: npm run test:up:rebuild (the A/B stack, built from this tree), which runs testing/sync/setup.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { INSTANCES, post, get, getInstanceId, createTestSpace, mirroredNetwork, triggerSync, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const SEQ = 4;
const A_TEXT = 'what instance A wrote about this file';
const B_TEXT = 'what instance B wrote about this file';

let tokenA, tokenB, idA, idB;

const rootOf = async (base, token, spaceId) => (await get(base, token, `/api/sync/merkle?spaceId=${spaceId}`)).body?.root;
const conflictsOf = async (base, token, spaceId) => (await get(base, token, `/api/conflicts?spaceId=${spaceId}`)).body?.conflicts ?? [];
const rowOf = async (base, token, spaceId, id) => {
  const r = await get(base, token, `/api/sync/filemeta/${encodeURIComponent(id)}?spaceId=${spaceId}`);
  return r.status === 200 ? r.body : undefined;
};

/** One file row's wire shape: authored by a third party at a fixed stamp, so only the description tells the two copies apart. */
const meta = (spaceId, id, description) => ({
  _id: id, spaceId, path: id, description, tags: ['q426'],
  author: { instanceId: 'third-party-author', instanceLabel: 'Third party' },
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', seq: SEQ,
});

/** Plant A's copy on A and B's copy on B, each through its own instance's sync door: two instances that each hold one of two divergent copies. */
async function plant(spaceId, id) {
  for (const [base, token, text] of [[INSTANCES.a, tokenA, A_TEXT], [INSTANCES.b, tokenB, B_TEXT]]) {
    const r = await post(base, token, `/api/sync/batch-upsert?spaceId=${spaceId}`, { filemeta: [meta(spaceId, id, text)] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}

/** The one-row, one-conflict outcome both legs assert. */
async function assertConverged(spaceId, id) {
  const [rowA, rowB] = [await rowOf(INSTANCES.a, tokenA, spaceId, id), await rowOf(INSTANCES.b, tokenB, spaceId, id)];
  assert.ok(rowA && rowB, `a row is missing: A ${JSON.stringify(rowA)} B ${JSON.stringify(rowB)}`);
  assert.equal(rowA.description, rowB.description, 'the two instances still hold different metadata');
  assert.ok([A_TEXT, B_TEXT].includes(rowA.description));
  assert.equal(rowA.seq, SEQ); assert.equal(rowB.seq, SEQ);
  assert.equal(await rootOf(INSTANCES.a, tokenA, spaceId), await rootOf(INSTANCES.b, tokenB, spaceId), 'the space hashes differ');

  const [onA, onB] = [await conflictsOf(INSTANCES.a, tokenA, spaceId), await conflictsOf(INSTANCES.b, tokenB, spaceId)];
  assert.equal(onA.length + onB.length, 1, `expected one conflict on the instance whose copy lost: A ${JSON.stringify(onA)} B ${JSON.stringify(onB)}`);
  const [loserText, mine] = rowA.description === A_TEXT ? [B_TEXT, onB] : [A_TEXT, onA];
  assert.equal(mine.length, 1, `the conflict is on the wrong instance (the row is ${JSON.stringify(rowA.description)})`);
  assert.equal(mine[0].kind, 'metadata');
  assert.equal(mine[0].originalPath, id);
  assert.equal(mine[0].losing.description, loserText, 'the conflict does not hold the displaced description');
}

describe('an equal-seq file divergence converges on both peers, between real instances', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    idA = getInstanceId('ythril-a');
    idB = getInstanceId('ythril-b');
  });

  it('the push leg: each instance is handed the other\'s copy by its push door', async () => {
    const space = await createTestSpace('file-tie-push', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    try {
      const id = `notes/tie-push-${randomUUID()}.md`;
      await plant(space.id, id);
      // A peer token per direction: the pusher is proven by it, as a real push is.
      const asPeer = async (base, token, peerInstanceId) => (await post(base, token, '/api/tokens', { name: `tie-push-${peerInstanceId}-${Date.now()}`, peerInstanceId })).body.plaintext;
      const aToB = await asPeer(INSTANCES.b, tokenB, idA);
      const bToA = await asPeer(INSTANCES.a, tokenA, idB);
      assert.ok(aToB && bToA, 'the peer tokens were not made');
      const pushed = [
        await post(INSTANCES.b, aToB, `/api/sync/batch-upsert?spaceId=${space.id}`, { filemeta: [meta(space.id, id, A_TEXT)] }),
        await post(INSTANCES.a, bToA, `/api/sync/batch-upsert?spaceId=${space.id}`, { filemeta: [meta(space.id, id, B_TEXT)] }),
      ];
      for (const r of pushed) assert.equal(r.status, 200, JSON.stringify(r.body));
      await assertConverged(space.id, id);
    } finally { await space.remove(); }
  });

  it('the pull leg: each instance pulls the other\'s copy in a cycle of its own', async () => {
    const space = await createTestSpace('file-tie-pull', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    // Created before the rows are planted: a network that exists first makes the plant a local write the next cycle offers.
    const net = await mirroredNetwork({ label: `File tie pull ${Date.now()}`, spaces: [space.id], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB], direction: 'pull' });
    try {
      const id = `notes/tie-pull-${randomUUID()}.md`;
      await plant(space.id, id);
      const agree = async () => (await rowOf(INSTANCES.a, tokenA, space.id, id))?.description === (await rowOf(INSTANCES.b, tokenB, space.id, id))?.description
        && (await rootOf(INSTANCES.a, tokenA, space.id)) === (await rootOf(INSTANCES.b, tokenB, space.id));
      // Both instances cycle: each only pulls, so each decides the other's copy for itself.
      await waitFor(async () => {
        await triggerSync(INSTANCES.a, tokenA, net.networkId);
        await triggerSync(INSTANCES.b, tokenB, net.networkId);
        return agree();
      }, 60_000, 2_000, async () => JSON.stringify({ a: await rowOf(INSTANCES.a, tokenA, space.id, id), b: await rowOf(INSTANCES.b, tokenB, space.id, id) }),
      { what: 'both instances to hold the same row and one space hash' });
      await assertConverged(space.id, id);
    } finally { await net.remove(); await space.remove(); }
  });
});
