/**
 * Between real instances: a peer's tombstone is applied to the space the door ADMITTED, never to the space its body
 * names (`Q-236`, bundle-46). The cross-instance companion of `tombstone-forgery.test.js`, and of the standalone
 * `a-peer-tombstone-is-applied-where-it-was-admitted-db`, which drives the same doors in-process.
 *
 * ## The scenario
 *
 * A holds two spaces: S1, which a network shares with B, and S2, which it shares with nobody. S2 holds a record
 * authored by B (stored on A by A's own admin, so its author is B and nothing else about it is unusual). B is
 * admitted to S1 only.
 *
 *  - **Push**: B, with its own bound peer token, POSTs a tombstone to A's S1 door whose body says `spaceId: S2`.
 *  - **Pull**: B serves, from its own S1 tombstones, a tombstone whose body says `spaceId: S2`, and A pulls S1 from B.
 *
 * Either way the record in S2 must survive, and no tombstone may be stored in S2. On the base both doors apply the
 * tombstone by its own `spaceId`: the record is deleted and the tombstone stored in S2 — a space B was never
 * admitted to.
 *
 * ## How the pull's tombstone is planted on B
 *
 * Directly in B's database (`docker exec ythril-mongo-b mongosh`), because no API on B stores a tombstone in one
 * space with another space's id — on the base B's own POST door would route it to S2, which is the defect. A record
 * then written on B in S1 raises B's settled bound past the tombstone's seq, so B's real GET handler serves it.
 *
 * Run:  node --test testing/sync/a-tombstone-lands-in-the-space-its-door-admitted.test.js
 * Pre-requisite: npm run test:up (the A/B stack), which runs testing/sync/setup.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'url';
import {
  INSTANCES, post, get, getInstanceId, readRecord, createTestSpace, mirroredNetwork, triggerSync, waitFor,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, idA, idB, s1, s2, net, peerTokenForB;

/** A fact on A's S2 authored by B, written by A's admin through the sync door (the one door that keeps an author). */
async function bAuthoredRecordInS2(id) {
  const now = new Date().toISOString();
  const r = await post(INSTANCES.a, tokenA, `/api/sync/batch-upsert?spaceId=${s2.id}`, {
    facts: [{ _id: id, spaceId: s2.id, fact: `B-authored record ${id} in a space B was never admitted to`, tags: [],
      author: { instanceId: idB, instanceLabel: 'Instance B' }, createdAt: now, updatedAt: now, seq: 5 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.facts?.inserted, 1, `the fixture record was not stored: ${JSON.stringify(r.body)}`);
  assert.equal((await readRecord(INSTANCES.a, tokenA, s2.id, 'facts', id)).status, 200, 'fixture record not readable');
}

/** The ids A holds tombstones for in `space`, read through A's own tombstone door. */
async function tombstoneIdsOnA(space) {
  const r = await get(INSTANCES.a, tokenA, `/api/sync/tombstones?spaceId=${space}&sinceSeq=0&limit=5000`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return new Set(Object.values(r.body).flat().map(t => t._id));
}

/** Run mongosh in B's database. */
function mongoB(js) {
  return execFileSync('docker', ['exec', 'ythril-mongo-b', 'mongosh', '-u', 'ythril', '-p', 'ythril-test-pw',
    '--authenticationDatabase', 'admin', '--quiet', 'ythril', '--eval', js], { encoding: 'utf8' });
}

describe('a peer tombstone lands in the space its door admitted, between real instances', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    idA = getInstanceId('ythril-a');
    idB = getInstanceId('ythril-b');
    s1 = await createTestSpace('tomb-admit-s1', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    s2 = await createTestSpace('tomb-admit-s2', [[INSTANCES.a, tokenA]]);
    net = await mirroredNetwork({ label: `Tomb admit ${Date.now()}`, spaces: [s1.id], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
    // A peer token on A bound to B's real instance id — what B presents when it pushes to A.
    const t = await post(INSTANCES.a, tokenA, '/api/tokens', { name: `tomb-admit-b-${Date.now()}`, peerInstanceId: idB });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    peerTokenForB = t.body.plaintext;
  });

  after(async () => {
    await net?.remove();
    await s1?.remove();
    await s2?.remove();
  });

  it('push: B admitted to S1 cannot delete in S2, nor store a tombstone there, by naming S2 in the body', async () => {
    const id = `push-${Date.now()}`;
    await bAuthoredRecordInS2(id);
    const r = await post(INSTANCES.a, peerTokenForB, `/api/sync/tombstones?spaceId=${s1.id}&networkId=${net.networkId}`, {
      tombstones: [{ _id: id, type: 'fact', spaceId: s2.id, deletedAt: new Date().toISOString(), instanceId: idB, seq: 10_000 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await readRecord(INSTANCES.a, tokenA, s2.id, 'facts', id)).status, 200,
      `B, admitted to '${s1.id}' only, deleted a record in '${s2.id}' by naming it in the tombstone's spaceId`);
    assert.ok(!(await tombstoneIdsOnA(s2.id)).has(id), `a tombstone was stored in '${s2.id}', a space B was never admitted to`);
  });

  it('pull: a tombstone B serves for S1 that names S2 neither deletes nor stores in S2 on A', async () => {
    const id = `pull-${Date.now()}`;
    await bAuthoredRecordInS2(id);
    // Planted on B under S1 with S2's id, at seq 1; a write on B in S1 then settles seq 1 so B's GET serves it.
    mongoB(`db.getCollection(${JSON.stringify(`${s1.id}_tombstones`)}).insertOne(${JSON.stringify({
      _id: id, type: 'fact', spaceId: s2.id, deletedAt: new Date().toISOString(), instanceId: idB, seq: 1 })})`);
    const marker = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${s1.id}/facts`, { fact: `marker ${id}`, tags: [] });
    assert.equal(marker.status, 201, JSON.stringify(marker.body));
    const markerId = marker.body._id ?? marker.body.id;
    const served = await get(INSTANCES.b, tokenB, `/api/sync/tombstones?spaceId=${s1.id}&sinceSeq=0`);
    assert.ok(Object.values(served.body).flat().some(t => t._id === id), `B does not serve the planted tombstone: ${JSON.stringify(served.body)}`);

    // A pulls S1 from B; the marker arriving on A is the evidence that the pull (tombstones first) ran.
    await waitFor(async () => {
      await triggerSync(INSTANCES.a, tokenA, net.networkId).catch(() => {});
      return (await readRecord(INSTANCES.a, tokenA, s1.id, 'facts', markerId)).status === 200;
    }, 60_000, 2_000, `A never pulled B's marker in '${s1.id}', so the pull never ran`);

    assert.equal((await readRecord(INSTANCES.a, tokenA, s2.id, 'facts', id)).status, 200,
      `pulling '${s1.id}' from B deleted a record in '${s2.id}' because the tombstone's body named it`);
    assert.ok(!(await tombstoneIdsOnA(s2.id)).has(id), `the pulled tombstone was stored in '${s2.id}'`);
  });
});
