/**
 * A relay chain A -> M -> C on the live test stack, on braintree or on pub/sub, and the two writes orderings Q-278 loses
 * records under — shared by `q278-a-relay-forwards-what-it-pulled` and `q278-a-relay-pushes-what-it-received`.
 *
 * ## What Q-278 is, so a reader of the two tests need not open the ticket
 *
 * A record that lands at a relay keeps its AUTHOR's seq, and a relay's paging marks for the member below it move only
 * with the relay's OWN records. So a record from the root whose seq is at or below what the relay has already delivered
 * downstream is never forwarded — to the instances below the relay, for good. bundle-81 replaces the seq paging by a
 * position the RECEIVER takes at landing, which is what these tests are the proof of.
 *
 * ## The two orderings (Q-278 doneWhen 1), each built from a fresh chain so no mark one leaves reaches the other
 *
 *  - `moreFirst`: M writes MANY records, they reach C, and only then does A write X. X's seq is far below everything M
 *    has delivered (M's counter ran ahead of A's), so a mark that moves with M's own seqs has passed it.
 *  - `pushedBetween`: A writes X1 and it reaches C; M then writes a local record (the arrival moved M's counter to X1's
 *    seq, so it lands on the very next seq) and it reaches C; A writes X2 — which takes the SAME seq as M's local record,
 *    because A never receives anything from M and so its counter never moved. A mark at M's local seq is at X2's.
 *
 * ## Which instance runs a cycle IS the leg under test
 *
 * A record travels A -> M by A's push (the root pushes to its child), and M -> C by one of two legs: C's PULL from M, or
 * M's PUSH to C. `legs.pull` runs cycles on A and C only (M never runs one, so nothing M pushes can carry the record);
 * `legs.push` runs them on A and M only (C never runs one, so nothing C pulls can). A cycle is `?wait=true`, so it has run
 * to its end when it answers: nothing here waits on a timer, and a record asked for is asked for after the cycles that
 * could carry it. The read that follows is the verdict, and `holds` is a read of the instance's own store.
 *
 * The instances are a (A), b (M) and c (C). C has no rate-limit kill switch, so every call TO it rides out a 429.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTANCES, post, postRetry429, get, del, delWithBody, getInstanceId, readRecord, createTestSpace, pubsubNetwork, waitFor,
} from './helpers.js';

const CONFIGS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'configs');
const token = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();

/** How many records M writes ahead of A's X in the `moreFirst` ordering. */
export const MORE_FIRST_COUNT = 50;

export const TOPOLOGIES = Object.freeze(['braintree', 'pubsub']);

/**
 * A fresh chain: its own space, its own network(s), the three instances' tokens and ids. `remove` takes all of it down and
 * never throws, so it is safe in an `after`.
 *
 * @param {'braintree'|'pubsub'} type
 */
export async function buildChain(type) {
  assert.ok(TOPOLOGIES.includes(type), `unknown topology ${type}`);
  const A = { name: 'A', base: INSTANCES.a, token: token('a'), url: 'http://ythril-a:3200', container: 'ythril-a' };
  const M = { name: 'M', base: INSTANCES.b, token: token('b'), url: 'http://ythril-b:3200', container: 'ythril-b' };
  const C = { name: 'C', base: INSTANCES.c, token: token('c'), url: 'http://ythril-c:3200', container: 'ythril-c' };
  for (const n of [A, M, C]) n.id = getInstanceId(n.container);

  // The space exists on the root only; M and C create it when they join, as a joiner does.
  const space = await createTestSpace(`q278-${type}`, [[A.base, A.token]]);
  const networks = []; // [{ id, on: [instances that run it] }]
  const removers = [];

  const must = (r, what, ok = [200, 201]) => {
    assert.ok(ok.includes(r.status), `${what}: ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };

  if (type === 'braintree') {
    const net = must(await post(A.base, A.token, '/api/networks', { label: `q278 braintree ${Date.now()}`, type: 'braintree', spaces: [space.id], votingDeadlineHours: 24 }), 'create the braintree network on A');
    const networkId = net.body.id;
    // `syncSchedule: ''` is manual on purpose: a cycle nobody asked for would carry what a test means to hold back.
    const joinUnder = async (parent, child) => {
      const inv = must(await post(parent.base, parent.token, '/api/invite/generate', { networkId }), `invite from ${parent.name}`);
      const j = must(await postRetry429(child.base, child.token, '/api/networks/join-remote', {
        handshakeId: inv.body.handshakeId, inviteUrl: `${parent.url}/api/invite/apply`, rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
        networkId, myUrl: child.url, syncSchedule: '',
      }), `${child.name} joins under ${parent.name}`);
      return j.body;
    };
    const cycleOn = async (inst) => must(await postRetry429(inst.base, inst.token, `/api/networks/${networkId}/sync?wait=true`, {}), `a cycle on ${inst.name}`);
    const memberOn = async (inst, id) => ((await get(inst.base, inst.token, `/api/networks/${networkId}`)).body?.members ?? []).find(m => m.instanceId === id);
    assert.equal((await joinUnder(A, M)).status, 'joined', 'M is admitted under the root at once');
    assert.equal((await joinUnder(M, C)).status, 'vote_pending', 'C waits for the root\'s vote');
    const roundOnA = async () => ((await get(A.base, A.token, `/api/networks/${networkId}/votes`)).body?.rounds ?? []).find(x => x.type === 'join' && x.subjectInstanceId === C.id);
    // The round reaches A by gossip, A votes yes, and the yes reaches M, which then admits C: each step is a completed
    // cycle of the instance that carries it, and the wait is on the state the next step needs.
    await waitFor(async () => { await cycleOn(M); await cycleOn(A); return !!(await roundOnA()); }, 90_000, 1_000, 'M\'s join round for C never reached the root', { what: 'the join round for C on A' });
    must(await post(A.base, A.token, `/api/networks/${networkId}/votes/${(await roundOnA()).roundId}`, { vote: 'yes' }), 'A votes yes for C');
    await waitFor(async () => { await cycleOn(A); await cycleOn(M); return !!(await memberOn(M, C.id)); }, 90_000, 1_000, 'M never admitted C after the root\'s yes', { what: 'M admitting C' });
    assert.equal((await memberOn(A, M.id))?.direction, 'push', 'the root pushes to M');
    assert.equal((await memberOn(C, M.id))?.direction, 'pull', 'C pulls from M');
    networks.push({ id: networkId, on: [A, M, C] });
    removers.push(async () => {
      for (const n of [C, M, A]) await del(n.base, n.token, `/api/networks/${networkId}`).catch(() => {});
      for (const n of [C, M]) await delWithBody(n.base, n.token, `/api/spaces/${space.id}`, { confirm: true }).catch(() => {});
    });
  } else {
    // Two pub/sub networks over one space: A publishes it to M, and M — which holds it now — publishes it on to C.
    const first = await pubsubNetwork({ label: `q278 pubsub A-M ${Date.now()}`, spaces: [space.id], publisher: [A.base, A.token, A.container], subscriber: [M.base, M.token, M.container] });
    await first.adopted(space.id);
    const second = await pubsubNetwork({ label: `q278 pubsub M-C ${Date.now()}`, spaces: [space.id], publisher: [M.base, M.token, M.container], subscriber: [C.base, C.token, C.container] });
    await second.adopted(space.id);
    networks.push({ id: first.networkId, on: [A, M] }, { id: second.networkId, on: [M, C] });
    removers.push(async () => {
      await first.remove().catch(() => {}); await second.remove().catch(() => {});
      for (const n of [C, M]) await delWithBody(n.base, n.token, `/api/spaces/${space.id}`, { confirm: true }).catch(() => {});
    });
  }

  /** A completed cycle of `inst` on every network of the chain it belongs to (the networks, in the order they were built). */
  const cycle = async (inst) => {
    for (const n of networks) {
      if (!n.on.includes(inst)) continue;
      must(await postRetry429(inst.base, inst.token, `/api/networks/${n.id}/sync?wait=true`, {}), `a cycle of ${inst.name} on network ${n.id}`);
    }
  };

  return {
    type, A, M, C, spaceId: space.id, networks,
    cycle,
    /** One write on `inst`, returned as `{ id, seq }`. */
    async write(inst, label) {
      const r = must(await postRetry429(inst.base, inst.token, `/api/brain/spaces/${space.id}/facts`, { fact: `${label} ${Date.now()}`, tags: ['q278'] }), `write ${label} on ${inst.name}`);
      return { id: r.body._id ?? r.body.id, seq: r.body.seq };
    },
    /** Does `inst` hold the record, by identity? */
    async holds(inst, id) { return (await readRecord(inst.base, inst.token, space.id, 'facts', id)).status === 200; },
    async remove() { for (const r of removers) await r().catch(() => {}); await space.remove().catch(() => {}); },
  };
}

/**
 * The legs a record can take from M to C. `drivers` are the instances that run a cycle, in order, and the leg under test is
 * the one the others cannot carry.
 */
export const LEGS = Object.freeze({
  /** C pulls from M; M runs no cycle, so nothing M pushes can reach C. */
  pull: (chain) => [chain.A, chain.C],
  /** M pushes to C; C runs no cycle, so nothing C pulls can reach it. */
  push: (chain) => [chain.A, chain.M],
});

/** A completed cycle of each driver, in order. */
export async function runLeg(chain, leg) {
  for (const inst of LEGS[leg](chain)) await chain.cycle(inst);
}

/**
 * The state a failure message needs to say WHICH side lost the record: who holds each record, as a plain list.
 */
export async function holdings(chain, ids) {
  const out = {};
  for (const [name, id] of Object.entries(ids)) {
    out[name] = { A: await chain.holds(chain.A, id), M: await chain.holds(chain.M, id), C: await chain.holds(chain.C, id) };
  }
  return out;
}

/**
 * Ordering `moreFirst` on `leg`: M writes MORE_FIRST_COUNT records and they reach C; then A writes X, and X must reach C.
 * Returns what the case asserts on, after asserting its own controls (the chain carries what M wrote; M holds X).
 */
export async function moreFirst(chain, leg) {
  const mine = [];
  for (let i = 0; i < MORE_FIRST_COUNT; i++) mine.push((await chain.write(chain.M, `M own ${i}`)).id);
  // Control 1: the leg carries a record the relay AUTHORED. Run until C holds all of them: a completed cycle each pass.
  const driver = LEGS[leg](chain);
  await waitFor(async () => {
    await runLeg(chain, leg);
    const have = await Promise.all(mine.map(id => chain.holds(chain.C, id)));
    return have.every(Boolean);
  }, 120_000, 500, 'the records M wrote never all reached C, so the chain does not carry even those',
  { what: `C holding the ${MORE_FIRST_COUNT} records M wrote, by ${leg} (drivers ${driver.map(d => d.name).join(',')})` });

  const x = await chain.write(chain.A, 'X from the root');
  assert.ok(x.seq < MORE_FIRST_COUNT, `the premise: A's counter is far behind M's, so X (seq ${x.seq}) lands below what M has delivered`);
  // X reaches M by A's push. One pass is the whole path for a correct relay; a second only absorbs a slow join.
  await runLeg(chain, leg);
  await runLeg(chain, leg);
  assert.equal(await chain.holds(chain.M, x.id), true, 'control 2: X reached M, so what is asked of the relay is only to forward it');
  return { x, mine };
}

/**
 * Ordering `pushedBetween` on `leg`: A writes X1 and it reaches C; M writes a local record L and it reaches C; A writes X2,
 * which takes the seq L took. X2 must reach C.
 */
export async function pushedBetween(chain, leg) {
  const x1 = await chain.write(chain.A, 'X1 from the root');
  await runLeg(chain, leg);
  await runLeg(chain, leg);
  assert.equal(await chain.holds(chain.C, x1.id), true, 'control 1: the first root record reaches C by this leg, so the chain carries a relayed record at all');
  const l = await chain.write(chain.M, 'L, M\'s local write between the two');
  await runLeg(chain, leg);
  assert.equal(await chain.holds(chain.C, l.id), true, 'control 2: the relay\'s own record reaches C by this leg');
  const x2 = await chain.write(chain.A, 'X2 from the root');
  // (Under 5.6 X2 takes the seq L took; whether it does is the version stamp's business and no premise of the assertion below.)
  await runLeg(chain, leg);
  await runLeg(chain, leg);
  assert.equal(await chain.holds(chain.M, x2.id), true, `control 3: X2 (seq ${x2.seq}, L was ${l.seq}) reached M, so what is asked of the relay is only to forward it`);
  return { x1, l, x2 };
}
