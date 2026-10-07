/**
 * Integration tests: Braintree topology sync (A root -> B node -> C leaf)
 *
 * ## The tree is the REAL one (bundle-51)
 *
 * This file used to register members as `instance-b` / `instance-c`, register B's network without a parent, and never
 * give C a network at all: C only received what B pushed. A rule about "my parent" has nothing to read in that tree,
 * and nothing in it ever pulled from a parent. The tree is now built the way an operator builds one, by the invite
 * handshake: B joins A's network (A is the root, so it admits at once), C joins B's (B is not the root, so A must vote
 * yes before B admits C). Every member carries its instance's REAL id, every token is bound to the instance that
 * presents it, `myParentInstanceId` is set on B (A) and on C (B) by the join, and C lists B as a member it PULLS from.
 *
 * ## A deletion made at the root reaches the whole tree, by each direction
 *
 * What a root deletes, the instances below it must lose, whoever wrote the record. The two directions a deletion
 * travels below the root are driven one at a time, and only that one:
 *
 *  - through the NODE's PUSH: A and B run their cycles, C never does — B hands C the tombstone;
 *  - through the LEAF's PULL: A and C run their cycles, B never does — C fetches the tombstone B holds.
 *
 * Each test deletes a record and a file the root wrote, and asserts the node's and the leaf's own records survive.
 * What each waits on is the end state it asserts, reached by completed cycles (`?wait=true`), so there is no fixed
 * sleep; the existing negative tests below keep theirs on purpose, since an absence cannot be waited for.
 *
 * Instance C has no SKIP_*_RATE_LIMIT, so every call made TO C rides out a 429 (`postRetry429`), and C is read at a
 * two-second interval.
 *
 * Run: node --test testing/sync/braintree.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, postRetry429, get, del, delWithBody, triggerSync, waitFor, getInstanceId, makeTriggerProbe, readRecord, createTestSpace } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();

let tokenA, tokenB, tokenC;
let idA, idB, idC;
let networkId;
let testSpaceId;
let spaceOnA;

/**
 * Wait for a peer to deliver something, RE-TRIGGERING sync while we wait.
 *
 * A single up-front trigger races a slow gossip cycle: the trigger is accepted, the push is queued behind other work, and
 * the wait expires having asked once. That is what `makeTriggerProbe`'s own docstring warns about, and it is what failed
 * in CI on 2026-08-13 — the FIRST propagation of a run, 15.2s against a 15s budget, with no container error and the same
 * assertions passing locally in 2.7s.
 *
 * So the budget is not the fix. Re-triggering is, and the probe makes a persistently-rejected trigger report itself
 * ("429 Too Many Requests") instead of arriving as a bare timeout with nothing to act on.
 */
// 20s, matching the one hand-rolled re-triggered wait this codebase already had rather than inventing a number. The
// MECHANISM is the fix -- re-triggering -- and the budget is deliberately not raised far, so a genuinely hung sync
// still reports in a reasonable time instead of being papered over.
async function waitForSynced(instance, token, networkId, label, check, timeoutMs = 20_000) {
  await triggerSync(instance, token, networkId);
  const probe = makeTriggerProbe(instance, token, networkId, label);
  const retrigger = setInterval(() => { void probe(); }, 3_000);
  try {
    await waitFor(check, timeoutMs, 500, probe.diagnose);
  } finally {
    clearInterval(retrigger);
  }
}

/**
 * Run a COMPLETED sync cycle on each named instance, in the order given, and poll `condition` after each round.
 *
 * `?wait=true` answers when the cycle has run to its end, so a round that returns is a positive signal that every
 * push and pull of that instance's turn happened; the condition is then read against the end state and not against a
 * timer. Which instances are named is the point of the callers: a cycle that is not run cannot carry anything.
 * The trigger rides out a 429 (C has no rate-limit kill-switch). A cycle that answers anything but 200 is kept for the
 * timeout message instead of being thrown, so one slow cycle does not end the wait.
 */
async function cyclesUntil(drivers, condition, what, timeoutMs = 90_000) {
  const last = {};
  await waitFor(async () => {
    for (const [name, base, token] of drivers) {
      const r = await postRetry429(base, token, `/api/networks/${networkId}/sync?wait=true`, {});
      last[name] = `${r.status} ${JSON.stringify(r.body)}`;
    }
    return condition();
  }, timeoutMs, 2_000, async () => `${typeof what === 'function' ? await what() : what}; last cycle answers: ${JSON.stringify(last)}`);
}

/** The invite handshake between a parent and a child, from the child's side: `join-remote` on `child`. */
async function joinUnder(parent, child) {
  const inv = await post(parent.base, parent.token, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, `invite from ${parent.url}: ${JSON.stringify(inv.body)}`);
  // `syncSchedule: ''` is manual on purpose: a joined network syncs every fifteen minutes by default, and a cycle nobody
  // asked for would carry what a test means to hold back.
  const j = await postRetry429(child.base, child.token, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: `${parent.url}/api/invite/apply`, rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: child.url, syncSchedule: '',
  });
  assert.equal(j.status, 200, `${child.url} joins under ${parent.url}: ${JSON.stringify(j.body)}`);
  return j.body;
}

const networkOn = async (base, token) => (await get(base, token, `/api/networks/${networkId}`)).body ?? {};
const memberOn = async (base, token, instanceId) => ((await networkOn(base, token)).members ?? []).find(m => m.instanceId === instanceId);

// ── files, over REST ────────────────────────────────────────────────────────────────────────────────────────────────

const fileUrl = (base, p) => `${base}/api/files/${testSpaceId}?path=${encodeURIComponent(p)}`;

async function writeFile(base, token, p, content) {
  const r = await fetch(fileUrl(base, p), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  return r.status;
}
const fileStatus = async (base, token, p) => (await fetch(fileUrl(base, p), { headers: { Authorization: `Bearer ${token}` } })).status;
const deleteFile = async (base, token, p) => (await fetch(fileUrl(base, p), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status;

describe('Braintree topology (A -> B -> C)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    tokenC = fs.readFileSync(path.join(CONFIGS, 'c', 'token.txt'), 'utf8').trim();
    idA = getInstanceId('ythril-a');
    idB = getInstanceId('ythril-b');
    idC = getInstanceId('ythril-c');

    // The space exists on the root only: B and C create it when they join, as a joiner does.
    spaceOnA = await createTestSpace('bt-topology', [[INSTANCES.a, tokenA]]);
    testSpaceId = spaceOnA.id;

    // Create braintree network on A (the root: no parent)
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test Braintree',
      type: 'braintree',
      spaces: [testSpaceId],
      votingDeadlineHours: 24,
    });
    assert.equal(r.status, 201, `Create network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;

    const A = { base: INSTANCES.a, token: tokenA, url: 'http://ythril-a:3200' };
    const B = { base: INSTANCES.b, token: tokenB, url: 'http://ythril-b:3200' };
    const C = { base: INSTANCES.c, token: tokenC, url: 'http://ythril-c:3200' };

    // B joins under A. The root is the only voter on its own network, so B is admitted at once.
    const joinB = await joinUnder(A, B);
    assert.equal(joinB.status, 'joined', `B under the root: ${JSON.stringify(joinB)}`);

    // C joins under B. B is not the root, so B holds C for the vote of every ancestor: B's own yes is implicit, A's is not.
    const joinC = await joinUnder(B, C);
    assert.equal(joinC.status, 'vote_pending', `C under a node must wait for the root's vote: ${JSON.stringify(joinC)}`);
    const roundOn = async (base, token) => ((await get(base, token, `/api/networks/${networkId}/votes`)).body?.rounds ?? [])
      .find(x => x.type === 'join' && x.subjectInstanceId === idC);
    assert.ok(await roundOn(INSTANCES.b, tokenB), 'B holds a join round for C');
    // The round reaches A by gossip; A casts its yes; the yes reaches B, which then admits C.
    await cyclesUntil([['A', INSTANCES.a, tokenA]], async () => !!(await roundOn(INSTANCES.a, tokenA)),
      `B's join round for C ${idC} never reached the root`, 60_000);
    const vote = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${(await roundOn(INSTANCES.a, tokenA)).roundId}`, { vote: 'yes' });
    assert.equal(vote.status, 200, `A votes yes: ${JSON.stringify(vote.body)}`);
    await cyclesUntil([['A', INSTANCES.a, tokenA], ['B', INSTANCES.b, tokenB]], async () => !!(await memberOn(INSTANCES.b, tokenB, idC)),
      async () => `B never admitted C after the root's yes; B lists ${JSON.stringify(((await networkOn(INSTANCES.b, tokenB)).members ?? []).map(m => m.instanceId))}`, 60_000);

    // The tree is what the tests below say it is: real ids, a parent on each node, the leaf pulls from its parent.
    assert.equal((await memberOn(INSTANCES.a, tokenA, idB))?.direction, 'push', 'the root pushes to B');
    assert.equal((await networkOn(INSTANCES.b, tokenB)).myParentInstanceId, idA, 'B\'s parent is A, by A\'s real id');
    assert.equal((await memberOn(INSTANCES.b, tokenB, idC))?.direction, 'push', 'B pushes to C');
    assert.equal((await networkOn(INSTANCES.c, tokenC)).myParentInstanceId, idB, 'C\'s parent is B, by B\'s real id');
    assert.equal((await memberOn(INSTANCES.c, tokenC, idB))?.direction, 'pull', 'C pulls from B');

    console.log(`Created braintree network: ${networkId}`);
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.c, tokenC, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    }
    await delWithBody(INSTANCES.c, tokenC, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    await spaceOnA?.remove();
  });

  it('Root A: write propagates down to B and then to C', async () => {
    const write = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Root fact from A',
      tags: ['braintree-test'],
    });
    assert.equal(write.status, 201);
    const memId = write.body._id ?? write.body.id;

    // A pushes to B
    await waitForSynced(INSTANCES.a, tokenA, networkId, 'A', async () => {
      const r = await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', memId);
      return r.status === 200;
    });
    console.log(`  Root fact appeared on B ✓`);

    // B pushes to C
    await waitForSynced(INSTANCES.b, tokenB, networkId, 'B', async () => {
      const r = await readRecord(INSTANCES.c, tokenC, testSpaceId, 'facts', memId);
      return r.status === 200;
    });
    console.log(`  Root fact appeared on C ✓`);
  });

  it('Leaf C: write does NOT propagate up to B (push-only)', async () => {
    const write = await post(INSTANCES.c, tokenC, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Leaf-only fact from C',
      tags: ['braintree-leaf'],
    });
    assert.equal(write.status, 201);
    const leafMemId = write.body._id ?? write.body.id;

    // B would try to sync schedule — but C is push-only so B only receives from its parent A
    // Trigger sync on B (B syncs from A, not from C)
    await triggerSync(INSTANCES.b, tokenB, networkId);

    // Wait a short time and verify this specific memory is NOT on B.
    // Negative assertion — a fixed wait is correct here; do NOT convert to waitFor (Q3), which would
    // return instantly on the absent record and prove nothing.
    await new Promise(r => setTimeout(r, 3000));
    const r = await readRecord(INSTANCES.b, tokenB, testSpaceId, 'facts', leafMemId);
    assert.equal(r.status, 404, 'Leaf fact should NOT have propagated to B');
    console.log(`  Leaf fact correctly absent from B ✓`);
  });

  it('Node B: write does NOT propagate up to A', async () => {
    const write = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts`, {
      fact: 'Node-only fact from B',
      tags: ['braintree-node'],
    });
    assert.equal(write.status, 201);
    const nodeMemId = write.body._id ?? write.body.id;

    // Trigger sync on A — A only receives from its own parent (none) and pushes to B
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // Negative assertion (see above) — fixed wait is correct; do NOT convert to waitFor (Q3).
    await new Promise(r => setTimeout(r, 3000));
    const r = await readRecord(INSTANCES.a, tokenA, testSpaceId, 'facts', nodeMemId);
    assert.equal(r.status, 404, 'Node fact should NOT have propagated to A');
    console.log(`  Node fact correctly absent from A ✓`);
  });

  /**
   * One round of the scenario both tests below run, differing only in WHICH instances run their cycles.
   *
   * The root writes a record and a file; the node and the leaf write one record each of their own. The set reaches the
   * node and the leaf by the drivers named, the root deletes the record and the file, and the deletion reaches both
   * below it by the same drivers. The node's and the leaf's own records are read at the end by identity: a record
   * that is still there is the evidence that the deletion took what the root wrote and nothing else.
   */
  async function aRootDeletionReaches(tag, drivers) {
    const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts`, { fact: `Root fact ${tag} ${RUN}, to be deleted`, tags: ['braintree-delete'] });
    assert.equal(w.status, 201, `write on A: ${JSON.stringify(w.body)}`);
    const factId = w.body._id ?? w.body.id;
    const file = `bt-${tag}-${RUN}.md`;
    assert.ok((await writeFile(INSTANCES.a, tokenA, file, `# Root file ${tag} ${RUN}\n`)) < 300, 'write the file on A');
    const nodeOwn = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${testSpaceId}/facts`, { fact: `Node own fact ${tag} ${RUN}`, tags: ['braintree-own'] });
    assert.equal(nodeOwn.status, 201, `write on B: ${JSON.stringify(nodeOwn.body)}`);
    const leafOwn = await postRetry429(INSTANCES.c, tokenC, `/api/brain/spaces/${testSpaceId}/facts`, { fact: `Leaf own fact ${tag} ${RUN}`, tags: ['braintree-own'] });
    assert.equal(leafOwn.status, 201, `write on C: ${JSON.stringify(leafOwn.body)}`);
    const own = [[INSTANCES.b, tokenB, nodeOwn.body._id ?? nodeOwn.body.id, 'node'], [INSTANCES.c, tokenC, leafOwn.body._id ?? leafOwn.body.id, 'leaf']];

    const below = [['B', INSTANCES.b, tokenB], ['C', INSTANCES.c, tokenC]];
    const holdings = async () => Object.fromEntries(await Promise.all(below.map(async ([name, base, token]) => [name, {
      fact: (await readRecord(base, token, testSpaceId, 'facts', factId)).status,
      file: await fileStatus(base, token, file),
    }])));
    const everywhere = (h, status) => Object.values(h).every(x => x.fact === status && x.file === status);

    await cyclesUntil(drivers, async () => everywhere(await holdings(), 200),
      async () => `the root's record and file never reached both the node and the leaf: ${JSON.stringify(await holdings())}`);

    assert.equal((await del(INSTANCES.a, tokenA, `/api/brain/spaces/${testSpaceId}/facts/${factId}`)).status, 204, 'delete the record on A');
    assert.ok((await deleteFile(INSTANCES.a, tokenA, file)) < 300, 'delete the file on A');

    await cyclesUntil(drivers, async () => everywhere(await holdings(), 404),
      async () => `the root's deletion of its record and file never reached both the node and the leaf: ${JSON.stringify(await holdings())}`);

    for (const [base, token, id, who] of own) {
      assert.equal((await readRecord(base, token, testSpaceId, 'facts', id)).status, 200, `the ${who}'s own record must survive the root's deletion`);
    }
  }

  it('a record and a file the root wrote and deleted disappear on the node and the leaf, through the node\'s push', async () => {
    // A pushes to B and B pushes to C. C runs no cycle, so nothing C pulls can carry the deletion.
    await aRootDeletionReaches('push', [['A', INSTANCES.a, tokenA], ['B', INSTANCES.b, tokenB]]);
    console.log(`  Root deletion reached the node and the leaf through the node's push ✓`);
  });

  it('a record and a file the root wrote and deleted disappear on the node and the leaf, through the leaf\'s pull', async () => {
    // A pushes to B; C pulls from B. B runs no cycle, so nothing B pushes can carry the deletion to C.
    await aRootDeletionReaches('pull', [['A', INSTANCES.a, tokenA], ['C', INSTANCES.c, tokenC]]);
    console.log(`  Root deletion reached the node and the leaf through the leaf's pull ✓`);
  });
});
