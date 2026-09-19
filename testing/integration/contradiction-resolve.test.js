/**
 * Integration tests: resolving a contradiction by picking a winner (`superseded`).
 *
 * ## What this is for
 *
 * A reviewer's most common actual decision about two disagreeing records is *"this one is right, that one is
 * stale"*, and neither existing resolution said it: `edited` claims a record was corrected, `linked` claims
 * the reviewer went and drew an edge somewhere by hand. `superseded` records the judgement **and acts on it**
 * — naming the loser on the finding, and drawing the `supersedes` edge for an entity pair.
 *
 * **It is not a merge.** A duplicate merge is lossless because the two records are the same thing; a
 * contradiction is not. The loser is a real record that was true, or was believed, and its history is the
 * point — so nothing is deleted or absorbed.
 *
 * ## Why these tests exist rather than unit tests
 *
 * Two of the three things worth pinning are only observable end to end:
 *
 *  - the edge is actually **drawn and findable** (an edge that is stored but not returned by the edges API is
 *    the accepted-dead-edge an integrator reported, and it looks identical to success from the resolve call);
 *  - a **non-entity pair draws no edge and SAYS so** — edges in Ythril connect entities, so a `supersedes`
 *    between two memories would be exactly that dead edge. Recording the resolution while silently not
 *    drawing anything is the failure mode this endpoint exists to avoid.
 *
 * ## Why the candidates are INSERTED rather than scanned for
 *
 * The first version of this test asked `POST /api/contradictions/scan` to produce the pair. It failed in CI
 * with `expected a candidate for the pair: []` — the scan returned 200 and found nothing, and from a green
 * 200 there is no way to tell WHICH precondition was unmet: vector search unavailable, the space's index
 * still building, or the pair not similar enough for the threshold.
 *
 * None of those are what this change touched. The scan's ability to FIND a pair is covered elsewhere; what is
 * new here is what `resolve` does with one. So the candidate is written directly, the way the scanner writes
 * it, and the test exercises only the endpoint — deterministic, and honest about what it proves.
 *
 * Run: node --test testing/integration/contradiction-resolve.test.js
 * Pre-requisite: docker compose -f testing/docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, dockerExec, readRecord, readCollection } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `contra-resolve-${RUN}`;

let tokenA;
let ready = false;
const ids = {};

const token = () => tokenA;

async function raw(method, urlPath, body) {
  const r = await fetch(`${INSTANCES.a}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: parsed };
}

async function ensureReindexed() {
  const { body } = await get(INSTANCES.a, token(), '/api/spaces');
  for (const space of body?.spaces ?? []) {
    const { body: st } = await get(INSTANCES.a, token(), `/api/brain/spaces/${space.id}/reindex-status`);
    if (st?.needsReindex) await post(INSTANCES.a, token(), `/api/brain/spaces/${space.id}/reindex`, {});
  }
}

const createEntity = async (name, description, properties) => {
  const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`,
    { name, type: 'service', description, properties, tags: [], waitForEmbedding: true });
  return r.status === 201 ? r.body._id : null;
};

const listOpen = async () => (await raw('GET', `/api/contradictions?space=${SPACE}&status=open`)).body?.contradictions ?? [];
const findPair = (list, x, y) => list.find(c => [c.aId, c.bId].sort().join() === [x, y].sort().join());

/**
 * Write a candidate exactly as `recordContradiction` would.
 *
 * Reaching into the container's Mongo is the same move `readContainerConfig` makes, and it is the only way to
 * put a KNOWN pair in front of the endpoint: every other route to a candidate runs through vector search.
 */
function insertCandidate(doc) {
  const js = "db.getSiblingDB('ythril').getCollection(" + JSON.stringify(SPACE + '_contradiction_candidates')
    + ").replaceOne({_id:" + JSON.stringify(doc._id) + "}, " + JSON.stringify(doc) + ", {upsert:true})";
  dockerExec('docker exec ythril-mongo-a mongosh --quiet -u ythril -p ythril-test-pw '
    + '--authenticationDatabase admin --eval ' + JSON.stringify(js));
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `Contradiction Resolve ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);
  await ensureReindexed();

  ids.a = await createEntity('Vault Secret Service', 'Vault secret storage handling token rotation', { port: 8080 });
  ids.b = await createEntity('Vault Secrets Service', 'Vault secret storage handling token rotation', { port: 9090 });
  const m1 = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts`, { fact: 'The service listens on 8080', tags: [] });
  const m2 = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts`, { fact: 'The service does not listen on 8080', tags: [] });
  ready = !!(ids.a && ids.b && m1.body?._id && m2.body?._id);
  if (!ready) return;

  // Canonical pair ids are `${lo}:${hi}` — the identity `contradictionPairId` derives.
  [ids.a, ids.b] = [ids.a, ids.b].sort();
  [ids.m1, ids.m2] = [m1.body._id, m2.body._id].sort();
  const now = new Date().toISOString();

  ids.entityPair = `${ids.a}:${ids.b}`;
  insertCandidate({
    _id: ids.entityPair, spaceId: SPACE, type: 'entity',
    aId: ids.a, aSummary: 'Vault Secret Service', aSeq: 1,
    bId: ids.b, bSummary: 'Vault Secrets Service', bSeq: 2,
    basis: 'structured-field', confidence: 1,
    fields: [{ key: 'port', aValue: 8080, bValue: 9090 }],
    status: 'open', detectedAt: now, updatedAt: now,
  });

  ids.memoryPair = `${ids.m1}:${ids.m2}`;
  insertCandidate({
    _id: ids.memoryPair, spaceId: SPACE, type: 'fact',
    aId: ids.m1, aSummary: 'listens on 8080', aSeq: 3,
    bId: ids.m2, bSummary: 'does not listen on 8080', bSeq: 4,
    basis: 'nli', confidence: 0.93,
    status: 'open', detectedAt: now, updatedAt: now,
  });
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('Contradiction resolve — picking a winner', () => {
  it('the API returns the candidate with its evidence intact', async (t) => {
    if (!ready) return t.skip('records could not be created');
    const open = await listOpen();
    const c = findPair(open, ids.a, ids.b);
    assert.ok(c, `expected a candidate for the pair: ${JSON.stringify(open)}`);
    assert.equal(c.basis, 'structured-field');
    // The evidence must describe the side it is stored against — `aValue` belongs to `aId`.
    const f = c.fields?.find(x => x.key === 'port');
    assert.ok(f, `the finding must name the disagreeing key: ${JSON.stringify(c.fields)}`);
    const expected = c.aId === ids.a ? [8080, 9090] : [9090, 8080];
    assert.deepEqual([f.aValue, f.bValue], expected,
      'aValue/bValue must be attributed to aId/bId, not to whichever order the sweep met the pair in');
  });

  it('rejects a winner that was not asked for, and a superseded without one', async (t) => {
    if (!ready) return t.skip('records could not be created');
    const c = findPair(await listOpen(), ids.a, ids.b);
    // Refused rather than defaulted: guessing which record a reviewer meant to keep is the one mistake
    // this endpoint must never make.
    const noWinner = await raw('POST', `/api/contradictions/${c.id}/resolve`, { resolution: 'superseded' });
    assert.equal(noWinner.status, 400, JSON.stringify(noWinner.body));
    assert.match(noWinner.body.error, /winner/);

    const badWinner = await raw('POST', `/api/contradictions/${c.id}/resolve`, { resolution: 'superseded', winner: 'c' });
    assert.equal(badWinner.status, 400, JSON.stringify(badWinner.body));

    const strayWinner = await raw('POST', `/api/contradictions/${c.id}/resolve`, { resolution: 'edited', winner: 'a' });
    assert.equal(strayWinner.status, 400, `a winner without 'superseded' means nothing: ${JSON.stringify(strayWinner.body)}`);
  });

  it('records the loser and who decided, and DRAWS the supersedes edge', async (t) => {
    if (!ready) return t.skip('records could not be created');
    const c = findPair(await listOpen(), ids.a, ids.b);
    const winnerId = c.aId;
    const loserId = c.bId;

    const r = await raw('POST', `/api/contradictions/${c.id}/resolve`, { resolution: 'superseded', winner: 'a' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.resolution, 'superseded');
    assert.equal(r.body.supersededId, loserId, 'the response must name the record judged stale');
    assert.ok(r.body.resolvedBy, `who decided must be recorded: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.edge, `an entity pair must draw the edge: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.edge.from, winnerId, 'the edge reads winner supersedes loser');
    assert.equal(r.body.edge.to, loserId);

    // The edge must be FINDABLE, not merely reported. A stored edge that the edges API does not return is
    // the accepted-dead-edge shape, and it looks identical to success from the resolve response alone.
    const edges = await readCollection(INSTANCES.a, token(), SPACE, 'edges', { filter: { label: 'supersedes' } });
    assert.equal(edges.status, 200);
    const drawn = (edges.results ?? []).find(e => e.from === winnerId && e.to === loserId);
    assert.ok(drawn, `the supersedes edge must be listed: ${JSON.stringify(edges.results)}`);

    // NOTHING is deleted. That is the line between this and a duplicate merge.
    for (const id of [winnerId, loserId]) {
      const still = await readRecord(INSTANCES.a, token(), SPACE, 'entities', id);
      assert.equal(still.status, 200, `${id} must survive — a contradiction is not a merge`);
    }
  });

  it('the resolved finding carries the loser and the decider', async (t) => {
    if (!ready) return t.skip('records could not be created');
    const resolved = (await raw('GET', `/api/contradictions?space=${SPACE}&status=resolved`)).body?.contradictions ?? [];
    const c = findPair(resolved, ids.a, ids.b);
    assert.ok(c, `the pair must appear under resolved: ${JSON.stringify(resolved)}`);
    assert.equal(c.resolution, 'superseded');
    assert.ok(c.supersededId, 'supersededId must survive onto the stored finding');
    assert.ok(c.resolvedBy, 'resolvedBy must survive onto the stored finding');
  });

  it('a FACT pair gets the edge too, and the walk follows it', async (t) => {
    if (!ready) return t.skip('records could not be created');
    /*
     * REWRITTEN BY HAND, not inverted. This case used to assert the opposite — that a fact pair records the
     * decision and explicitly says no edge was drawn — on the ground that *"edges connect entities"* and a
     * `supersedes` between two facts would be stored, returned and point at nothing traversable.
     *
     * That was true when it was written. 5.0 made the walk follow an edge to a fact, chrono entry or file,
     * so the ground the refusal stood on is gone, and re-measured before this was changed: a walk from the
     * winner reached 1 node with no edge stored and 2 with it.
     *
     * A title carrying `no`, `refuses` or a status code is the kind a mechanical inversion silently turns
     * into a test of nothing, which is why this one was replaced rather than edited.
     */
    const r = await raw('POST', `/api/contradictions/${ids.memoryPair}/resolve`, { resolution: 'superseded', winner: 'b' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.supersededId, ids.m1, 'the decision is still recorded');
    assert.ok(r.body.edge, `a fact pair must now get its edge: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.note, undefined, 'there is nothing left to apologise for');

    const walk = await raw('POST', `/api/brain/spaces/${SPACE}/traverse`, { startId: ids.m2, maxDepth: 2, direction: 'both' });
    const reached = (walk.body?.nodes ?? []).map(n => n._id);
    assert.ok(reached.includes(ids.m1),
      `the edge exists so that a reader starting at the winner finds what it replaced — got ${JSON.stringify(reached)}`);
  });

  it('the LOSING RECORD itself is marked, not just the review queue', async (t) => {
    if (!ready) return t.skip('records could not be created');
    /*
     * THE DEFECT THIS CLOSES (`Q-35`). `supersededId` lands on the contradiction CANDIDATE, which is the
     * queue's own bookkeeping — no retrieval path reads it. So a reviewer could settle a contradiction and
     * change nothing about what the next recall answered: both claims came back ranked together with
     * nothing to choose between them.
     *
     * The loser keeps its vector on purpose. Marking is not hiding — hiding it would answer "where does she
     * work?" by making "where DID she work?" unanswerable.
     */
    const facts = await readCollection(INSTANCES.a, token(), SPACE, 'facts', { filter: { _id: ids.m1 } });
    const loser = (facts.results ?? [])[0];
    assert.ok(loser, `the losing fact must still exist — nothing is deleted: ${JSON.stringify(facts)}`);
    assert.equal(loser.superseded, true,
      'the reviewer\'s judgement has to reach the record, or it changes nothing a caller can see');

    const winner = (await readCollection(INSTANCES.a, token(), SPACE, 'facts', { filter: { _id: ids.m2 } })).results?.[0];
    assert.ok(winner.superseded === undefined || winner.superseded === false, 'the winner must NOT be marked');
  });

  it('resolving twice lands on the SAME edge rather than accumulating duplicates', async (t) => {
    if (!ready) return t.skip('records could not be created');
    const resolved = (await raw('GET', `/api/contradictions?space=${SPACE}&status=resolved`)).body?.contradictions ?? [];
    const c = findPair(resolved, ids.a, ids.b);
    const again = await raw('POST', `/api/contradictions/${c.id}/resolve`, { resolution: 'superseded', winner: 'a' });
    assert.equal(again.status, 200, JSON.stringify(again.body));

    const edges = await readCollection(INSTANCES.a, token(), SPACE, 'edges', { filter: { label: 'supersedes' } });
    const matching = (edges.results ?? []).filter(e => e.from === c.aId && e.to === c.bId);
    assert.equal(matching.length, 1,
      `(from, to, label) is an edge's identity, so a second resolve must upsert: ${JSON.stringify(matching)}`);
  });
});
