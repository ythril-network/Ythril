/**
 * `filter` can ask for records by the NAME of the entity they are attached to — on both doors.
 *
 * ## The gap this closes
 *
 * Records store entity IDs. The nine per-collection list routes accept a NAME and resolve it server-side,
 * per member space, before filtering: `entityName` on facts and chrono, `fromName`/`toName` on edges. The
 * `filter` tool took a Mongo predicate and knew nothing about it — so **an agent could not ask for "facts
 * about Alice" by name**, while a browser could, and the capability map recorded the pair as answered.
 *
 * It is a join, not a predicate, which is why "the client will build predicates" was the wrong plan for
 * retiring those routes: a caller holding a predicate would need a lookup round trip per member space, and
 * would then be filtering on ids it resolved against a space it may not see the same way.
 *
 * ## The assertion that matters most
 *
 * **A name that matches nothing must return nothing, not everything.** The resolution produces an id list
 * and an empty list is a real answer — `$in: []` matches no record. A fallback to "no filter" would turn a
 * typo into a full-collection read that looks like a successful search, which is the failure mode this
 * whole feature is most able to produce.
 *
 * Run: node --test testing/integration/filter-answers-by-entity-name.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `filtername-${RUN}`;
const ALICE = `Alice-${RUN}`;
const BOB = `Bob-${RUN}`;

let tokenA;
let mcp;
let aliceId;
let bobId;

const viaRest = async (tool, args) => {
  const res = await fetch(`${INSTANCES.a}/api/${tool}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(tokenA);
  const created = await post(INSTANCES.a, tokenA, '/api/spaces', { id: SPACE, label: `Filter by name ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const a = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/entities`, { name: ALICE, type: 'person' });
  const b = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/entities`, { name: BOB, type: 'person' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  aliceId = a.body._id;
  bobId = b.body._id;

  const f1 = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/facts`, {
    fact: `Alice signed off the rollout ${RUN}`, linkEntities: [aliceId],
  });
  assert.equal(f1.status, 201, JSON.stringify(f1.body));
  const f2 = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/facts`, {
    fact: `Bob raised the objection ${RUN}`, linkEntities: [bobId],
  });
  assert.equal(f2.status, 201, JSON.stringify(f2.body));

  const e = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/edges`, {
    from: aliceId, to: bobId, label: 'notified',
  });
  assert.equal(e.status, 201, JSON.stringify(e.body));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
  mcp?.close();
});

describe('filter answers by entity name', () => {
  it('facts attached to a named entity, and only those', async () => {
    const r = await viaRest('filter', { space: SPACE, collection: 'facts', filter: {}, entityName: ALICE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = r.body.data.results;
    assert.equal(rows.length, 1, `expected only Alice's fact: ${JSON.stringify(rows.map(x => x.fact))}`);
    assert.match(rows[0].fact, /Alice signed off/);
  });

  it('a name that matches nothing returns NOTHING, not everything', async () => {
    /*
     * The load-bearing case. The resolution yields an id list, and an empty list is an answer: `$in: []`
     * matches no record. A fallback to "no filter" would turn a typo into a full-collection read that
     * reads exactly like a successful search.
     */
    const r = await viaRest('filter', { space: SPACE, collection: 'facts', filter: {}, entityName: `nobody-${RUN}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.results, [],
      'an unmatched name fell back to an unfiltered read — a typo now returns the whole collection');
  });

  it('edges by the name at either end', async () => {
    const from = await viaRest('filter', { space: SPACE, collection: 'edges', filter: {}, fromName: ALICE });
    assert.equal(from.status, 200, JSON.stringify(from.body));
    assert.equal(from.body.data.results.length, 1, 'the edge runs FROM Alice');

    const to = await viaRest('filter', { space: SPACE, collection: 'edges', filter: {}, toName: ALICE });
    assert.equal(to.status, 200, JSON.stringify(to.body));
    assert.equal(to.body.data.results.length, 0, 'nothing runs TO Alice — direction is data, not a guess');
  });

  it('MCP gives the same answer as HTTP, which is the whole point', async () => {
    const r = await mcp.callTool('filter', { space: SPACE, collection: 'facts', filter: {}, entityName: BOB });
    assert.ok(!r.isError, JSON.stringify(r));
    const rows = r.structuredContent?.results ?? [];
    assert.equal(rows.length, 1, `expected only Bob's fact: ${JSON.stringify(rows.map(x => x.fact))}`);
    assert.match(rows[0].fact, /Bob raised the objection/);
  });

  it('a name convenience on a collection it does not apply to is refused', async () => {
    /*
     * Refused rather than ignored. `entityName` on `entities` has no meaning — the predicate for that is
     * `filter: { name: ... }` — and silently dropping it returns every entity in the space to a caller who
     * believes they narrowed the search. The refusal names what to use instead.
     */
    const r = await viaRest('filter', { space: SPACE, collection: 'entities', filter: {}, entityName: ALICE });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /entityName/);

    const e = await viaRest('filter', { space: SPACE, collection: 'facts', filter: {}, fromName: ALICE });
    assert.equal(e.status, 400, JSON.stringify(e.body));
    assert.match(e.body.error, /fromName/);
  });
  /*
   * LAST, deliberately: it WRITES a third fact, and the cases above count rows. Placed first it made
   * 'only Alice's fact' see two and fail — a test that breaks its neighbours by ordering is the kind
   * of flake that gets blamed on the code.
   */
  it('the LEGACY array form is found too, and the fixture proves both are live', async () => {
    /*
     * A record names an entity two ways and both are documented: `linkEntities` writes a link record,
     * `entityIds` writes the array (and mirrors a link). Reading either side alone drops records silently,
     * and a space that has been written to since the upgrade holds both — which is every space that is not
     * brand new. The fixture above uses `linkEntities`; this one adds the array form so the `$or` is
     * exercised from both directions rather than only the one that was broken.
     */
    const legacy = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/facts`, {
      fact: `Alice approved the budget ${RUN}`, entityIds: [aliceId],
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));

    const r = await viaRest('filter', { space: SPACE, collection: 'facts', filter: {}, entityName: ALICE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const facts = r.body.data.results.map(x => x.fact).sort();
    assert.equal(facts.length, 2,
      `both the link-record form and the array form must be found: ${JSON.stringify(facts)}`);
  });
});
