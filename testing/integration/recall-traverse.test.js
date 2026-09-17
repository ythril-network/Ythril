/**
 * Integration tests: Graph-traversal augmented recall (`traverse` parameter)
 *
 * Covers the 011 acceptance criteria:
 *  - traverse: 0 is behaviourally identical to classic recall (backward compat)
 *  - traverse: 1 returns seeds with their directly-connected neighbours NESTED under them (any direction)
 *  - each nested node carries the whole reaching edge and `paths`, every route to it, seed-first
 *  - traverse: 2 nests the two-hop neighbour under the one-hop node, with a 3-id path
 *  - a circular graph (A→B→C→A) does not loop or duplicate records
 *  - an edge to a record absent from the space is silently skipped (the same
 *    hydration guard that makes cross-space edges to inaccessible spaces safe)
 *  - traverse: 6 is rejected with 400 (exceeds the server cap); non-int / negative too
 *  - the traversed NODE total is bounded by the configured cap on a dense graph (`count` is the matches)
 *  - the MCP recall tool accepts traverse and returns annotated results
 *
 * Seeding model: the recall SEED entity is written via the brain API so it is
 * embedded and $vectorSearch-visible; graph NEIGHBOURS are written via the sync
 * endpoint (no embedding) because they are reached structurally, not by vector
 * search — which also guarantees the seed set is deterministic (only the seed is
 * indexed).
 *
 * Run: node --test testing/integration/recall-traverse.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, waitForIndexed as waitForIndexedShared } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `traverse-test-${RUN}`;        // chain + cycle + skip graph
const SPACE_DENSE = `traverse-dense-${RUN}`; // hub-and-spoke graph for the cap test

let tokenA;
let embeddingAvailable = false;
let seedAId = null;   // brain-API-assigned _id of the chain seed entity
let seedHId = null;   // brain-API-assigned _id of the dense hub entity

// Fixed neighbour IDs (written via sync, so we control them)
const entB = `trav-B-${RUN}`;
const entC = `trav-C-${RUN}`;
const entD = `trav-D-${RUN}`;
const ghost = `trav-ghost-${RUN}`; // referenced by an edge but never created as an entity
// A memory ABOUT the chain seed, joined to it by `entityIds` rather than by an edge. Written via sync so it
// is not embedded: it must be reached structurally, never by matching the query itself.
const memLinked = `trav-mem-${RUN}`;
let seedMemId = null;   // an embedded MEMORY seed, whose own entityIds names B
let siblingMemId = null; // a SECOND memory naming the same entity — the far side of the memory→entity→memory walk
const DENSE_LEAVES = Array.from({ length: 30 }, (_, i) => `dense-leaf-${i}-${RUN}`);

function token() { return tokenA; }

/** True if `edge` connects x and y in either orientation (edge iteration order is not deterministic). */
function edgeConnects(edge, x, y) {
  return (edge.from === x && edge.to === y) || (edge.from === y && edge.to === x);
}

/** Every nested node in the results' `_graph`, at any depth, flattened for lookup. */
function allNested(results) {
  const out = [];
  const walk = ns => { for (const n of ns ?? []) { out.push(n); walk(n._graph); } };
  for (const r of results ?? []) walk(r._graph);
  return out;
}

/** The nested node for `id`, or undefined. */
const nested = (results, id) => allNested(results).find(n => n.node?._id === id);
/**
 * The id of a recall hit.
 *
 * `POST /api/brain/recall` returned one FLAT object until 5.0 and now returns `{score, spaceId, type,
 * record}` — the shape the MCP tool has always used — because the route hands its body to the shared tool
 * module instead of holding its own implementation. `_graph` stays on the HIT, beside the record, so a
 * traversal assertion is unaffected.
 */
const hitId = (h) => h?.record?._id;


async function ensureReindexed(baseUrl, tok) {
  const { body: spacesBody } = await get(baseUrl, tok, '/api/spaces');
  for (const space of spacesBody?.spaces ?? []) {
    const { body: statusBody } = await get(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex-status`);
    if (statusBody?.needsReindex) {
      await post(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex`, {});
    }
  }
}

// The MCP client harness lives in ../sync/mcp-session.js. It was copy-pasted into ten files while the
// transport was SSE; 4.0 removed SSE and one shared `POST /mcp` caller replaced every copy.

/**
 * Poll $vectorSearch on `space` until every id in `ids` appears in unfiltered recall.
 *
 * The poll and its deadline are shared — this file used to carry its own copy with a 30 s timeout, under the
 * 150 s index lag seen on CI.
 */
const waitForIndexed = (space, ids, timeoutMs) =>
  waitForIndexedShared(INSTANCES.a, token(), space, ids, ['entity', 'fact'], timeoutMs);

async function syncEntity(space, id, name, seq) {
  const { post: syncPost } = await import('../sync/helpers.js');
  const now = new Date().toISOString();
  await syncPost(INSTANCES.a, token(), `/api/sync/entities?spaceId=${space}`, {
    _id: id, spaceId: space, name, type: 'service', tags: [],
    seq, author: { instanceId: 'test', instanceLabel: 'Test' }, createdAt: now, updatedAt: now,
  });
}

async function syncMemory(space, id, fact, entityIds, seq) {
  const { post: syncPost } = await import('../sync/helpers.js');
  const now = new Date().toISOString();
  await syncPost(INSTANCES.a, token(), `/api/sync/facts?spaceId=${space}`, {
    _id: id, spaceId: space, fact, entityIds, tags: [], embedding: [], embeddingModel: 'none',
    seq, author: { instanceId: 'test', instanceLabel: 'Test' }, createdAt: now, updatedAt: now,
  });
}

async function syncEdge(space, from, to, label, seq) {
  const { post: syncPost } = await import('../sync/helpers.js');
  const now = new Date().toISOString();
  await syncPost(INSTANCES.a, token(), `/api/sync/edges?spaceId=${space}`, {
    _id: `edge-${from}-${to}-${RUN}`, spaceId: space, from, to, label,
    seq, author: { instanceId: 'test', instanceLabel: 'Test' }, createdAt: now, updatedAt: now,
  });
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

  for (const [id, label] of [[SPACE, `Traverse Test ${RUN}`], [SPACE_DENSE, `Traverse Dense ${RUN}`]]) {
    const r = await post(INSTANCES.a, token(), '/api/spaces', { id, label });
    assert.equal(r.status, 201, `Failed to create space ${id}: ${JSON.stringify(r.body)}`);
  }
  await ensureReindexed(INSTANCES.a, token());

  // Chain seed A — written via the brain API so it is embedded + searchable.
  const seedA = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: `Vault Secret Service ${RUN}`, type: 'service',
    description: 'Vault secret storage service handling authentication token scoping and rotation',
    tags: [], properties: {},
  });
  embeddingAvailable = seedA.status === 201;
  seedAId = seedA.body?._id ?? null;

  // Dense hub H — also embedded/searchable, distinct topic so it never co-matches A.
  const seedH = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE_DENSE}/entities`, {
    name: `Telemetry Aggregator ${RUN}`, type: 'service',
    description: 'Telemetry aggregation pipeline collecting metrics from many downstream collectors',
    tags: [], properties: {},
  });
  seedHId = seedH.body?._id ?? null;

  let seq = Date.now();
  // Chain neighbours B, C, D (sync — not embedded, reached structurally only).
  for (const [id, name] of [[entB, 'B'], [entC, 'C'], [entD, 'D']]) {
    await syncEntity(SPACE, id, `TravEnt-${name}-${RUN}`, seq++);
  }
  // Edges (traversal is bidirectional):
  //   A→B (depends_on), B→C (depends_on)  → chain: B at hop 1, C at hop 2
  //   A→D (references)                    → branch: D at hop 1
  //   B→A (cycles_back)                   → the A→B→A cycle from the acceptance criteria
  //   A→ghost (references)                → dangling: ghost is never created, must be skipped
  // The cycle uses B→A (not C→A) so it does not shortcut C to a 1-hop neighbour.
  if (seedAId) {
    await syncEdge(SPACE, seedAId, entB, 'depends_on', seq++);
    await syncEdge(SPACE, entB, entC, 'depends_on', seq++);
    await syncEdge(SPACE, seedAId, entD, 'references', seq++);
    await syncEdge(SPACE, entB, seedAId, 'cycles_back', seq++);
    await syncEdge(SPACE, seedAId, ghost, 'references', seq++);
  }

  // A memory linked to the chain seed by `entityIds`. Not embedded, so it can only arrive through a link.
  if (seedAId) await syncMemory(SPACE, memLinked, `Rotation runbook note ${RUN}`, [seedAId], seq++);

  /*
   * And a memory that is itself SEARCHABLE, naming the chain seed. It is the non-entity seed: it has no edges
   * of its own, so before 3.6 it came back with an empty `_graph` at any depth.
   *
   * It names `seedAId` rather than one of the synced entities because the space is strict-linkage and the
   * route requires every `entityIds` value to be a UUID v4 that resolves to an entity. The synced fixtures
   * are readable ids like `trav-B-…`, which the sync endpoint accepts and this route refuses — so linking to
   * one 400s. The status is asserted for the same reason it went unnoticed: a create whose failure is not
   * checked leaves `seedMemId` null, every later assertion looks for an id that is not there, and the
   * failure reported is about traversal rather than about the fixture.
   */
  if (seedAId) {
    const seedMem = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts`, {
      fact: `Wombat migration checklist ${RUN} covering marsupial burrow relocation`,
      entityIds: [seedAId], tags: [],
    });
    assert.equal(seedMem.status, 201, `memory seed create failed: ${JSON.stringify(seedMem.body)}`);
    seedMemId = seedMem.body?._id ?? null;

    /*
     * A SECOND memory naming the same entity, and the whole point of it is the case below.
     *
     * Every existing case here covers one leg: an entity seed reaching a memory that names it, a memory seed
     * reaching the entity it names, and a memory seed reaching another ENTITY across an edge. Nothing
     * connected two of them — memory to entity to a DIFFERENT memory — which is the shape 4.0 promised when
     * it said a search that matches a memory is no longer a dead end.
     *
     * Deliberately worded not to match the seed's query: if it ranked on its own, its presence in the answer
     * would prove nothing about the walk.
     */
    const sibling = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/facts`, {
      fact: `Quarterly badge inventory ${RUN} for the north annexe`,
      entityIds: [seedAId], tags: [],
    });
    assert.equal(sibling.status, 201, `sibling memory create failed: ${JSON.stringify(sibling.body)}`);
    siblingMemId = sibling.body?._id ?? null;
  }

  // Dense graph: hub H → 30 leaves (all one hop away).
  for (const leaf of DENSE_LEAVES) await syncEntity(SPACE_DENSE, leaf, `Leaf-${leaf}`, seq++);
  if (seedHId) for (const leaf of DENSE_LEAVES) await syncEdge(SPACE_DENSE, seedHId, leaf, 'feeds', seq++);

  if (embeddingAvailable && seedAId) await waitForIndexed(SPACE, [seedAId]);
  if (embeddingAvailable && seedHId) await waitForIndexed(SPACE_DENSE, [seedHId]);
  if (embeddingAvailable && seedMemId) await waitForIndexed(SPACE, [seedMemId]);
});

after(async () => {
  for (const space of [SPACE, SPACE_DENSE]) {
    await fetch(`${INSTANCES.a}/api/spaces/${space}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  }
});

// ── Validation (no embedding required) ───────────────────────────────────────

describe('Recall traverse — input validation', () => {
  it('traverse: 6 (over cap) returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: 'anything', traverse: 6 }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /traverse/);
  });
  it('traverse: -1 (negative) returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: 'anything', traverse: -1 }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
  it('traverse: 2.5 (non-integer) returns 400', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: 'anything', traverse: 2.5 }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

// ── Behaviour (embedding required) ───────────────────────────────────────────

describe('Recall traverse — graph expansion', () => {
  const q = 'authentication token scoping vault';

  it('traverse: 0 is identical to classic recall (backward compat)', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: q, types: ['entity'], traverse: 0 }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.traverseDepth, undefined, 'classic response must not carry traverseDepth');
    assert.ok(Array.isArray(r.body.results));
    const seed = r.body.results.find(x => hitId(x) === seedAId);
    assert.ok(seed, 'seed entity must be recalled');
    assert.equal(seed.source, undefined, 'classic results must not carry a source annotation');
    assert.equal(typeof seed.score, 'number');
  });

  it('traverse: 1 returns the seed plus its direct neighbours, annotated', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: q, types: ['entity'], topK: 10, traverse: 1 }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.traverseDepth, 1);

    // The seed is a RESULT, not an annotated wrapper: `count` is the number of matches, and a traversed node
    // is never in the ranked list to be counted or cut.
    const seed = r.body.results.find(x => hitId(x) === seedAId);
    assert.ok(seed, 'seed present as a match');
    assert.equal(typeof seed.score, 'number', 'a match keeps its real score');
    assert.equal(r.body.count, r.body.results.length, 'count is the matches');

    const b = nested(r.body.results, entB);
    const d = nested(r.body.results, entD);
    assert.ok(b && d, `both direct neighbours nested: ${JSON.stringify(allNested(r.body.results).map(n => n.node?._id))}`);
    for (const [n, id] of [[b, entB], [d, entD]]) {
      assert.deepEqual(n.paths[0], [seedAId, id], 'the route is ids, seed first');
      assert.equal(n.paths[0].length - 1, 1, 'hop count is derived from the path');
      assert.ok(edgeConnects(n.edge, seedAId, id), `the reaching edge connects seed and ${id}`);
      assert.ok('label' in n.edge, 'the WHOLE edge document, not {from,label,to}');
      assert.ok(!('score' in n), 'a traversed node has no score to compete with a match');
    }
    assert.ok(!nested(r.body.results, entC), 'two-hop neighbour C must NOT appear at depth 1');
    assert.ok(!nested(r.body.results, ghost), 'dangling edge target must be skipped');
    assert.equal(r.body.graphNodes, allNested(r.body.results).length, 'graphNodes counts the traversed nodes');
  });

  it('traverse: 2 reaches the two-hop neighbour with a two-edge path', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: q, types: ['entity'], topK: 10, traverse: 2 }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = nested(r.body.results, entB);
    assert.ok(b, 'the one-hop neighbour B is nested under the seed');
    const c = (b._graph ?? []).find(n => n.node?._id === entC);
    assert.ok(c, `C is nested under B, not beside it: ${JSON.stringify((b._graph ?? []).map(n => n.node?._id))}`);
    assert.deepEqual(c.paths[0], [seedAId, entB, entC], 'the route names every id from the seed');
    assert.equal(c.paths[0].length - 1, 2, 'two hops, derived');
    // The labels are not lost with an id-only path: B's own edge is hop 1 and C's is hop 2, so walking the
    // tree yields the chain in order.
    assert.ok(edgeConnects(b.edge, seedAId, entB), 'hop 1 edge is on B');
    assert.ok(edgeConnects(c.edge, entB, entC), 'hop 2 edge is on C');
  });

  it('a cycle does not loop or duplicate records', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // C→A closes a cycle. Depth 3 would revisit A without cycle detection.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: q, types: ['entity'], topK: 10, traverse: 3 }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = [...r.body.results.map(hitId), ...allNested(r.body.results).map(n => n.node?._id)];
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `no duplicate records (got ${JSON.stringify(ids)})`);
    assert.equal(ids.filter(id => id === seedAId).length, 1, 'the seed appears exactly once despite the cycle');
    // A cycle is a second route to a node already nested, so it belongs in `paths` rather than nowhere.
    const b = nested(r.body.results, entB);
    assert.ok(b.paths.length >= 1, 'the nesting route is always recorded');
  });
});

// ── Result cap (embedding required) ──────────────────────────────────────────

describe('Recall traverse — links, which are not edges', () => {
  const q = 'authentication token scoping vault';

  it('with no flag, a linked memory is not reached — this is what every existing caller gets', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    /*
     * The backward-compatibility half, and the reason all three flags default off. A memory that names the
     * seed in `entityIds` is related to it, and an ordinary `traverse: 1` must still not return it: a change
     * that silently widened the walk would spend the caller's byte budget on records they did not ask for.
     */
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: q, types: ['entity'], topK: 10, traverse: 1 }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(nested(r.body.results, memLinked), undefined,
      'a link was followed without being asked for');
  });

  it('includeMemories reaches it, with its kind and a synthetic edge', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: q, types: ['entity'], topK: 10, traverse: { depth: 1, includeMemories: true } }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const mem = nested(r.body.results, memLinked);
    assert.ok(mem, `the linked memory must be reached: ${JSON.stringify(allNested(r.body.results).map(n => n.node?._id))}`);
    // `kind` is what tells a caller which collection to look in. Guessing from the shape does not work: a
    // memory has no `name`, so a consumer that assumed an entity renders an empty title rather than the fact.
    assert.equal(mem.node.kind, 'fact');
    assert.equal(mem.node.fact, `Rotation runbook note ${RUN}`);
    // Synthetic: there is no stored edge record, so it carries what is derived and nothing invented.
    assert.equal(mem.edge.label, 'fact.entityIds');
    assert.equal(mem.edge._id, `fact.entityIds:${seedAId}:${memLinked}`);
    assert.equal(mem.edge.author, undefined, 'a derived edge must not carry a fabricated author');
    assert.equal(mem.edge.createdAt, undefined, 'a derived edge must not carry a fabricated timestamp');
  });

  it('edgeLabels excludes a link like any other label', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // A filter that cannot exclude something is not a filter. Asking for `depends_on` alone must not return
    // memories just because the flag is on.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: q, types: ['entity'], topK: 10,
      traverse: { depth: 1, includeMemories: true, edgeLabels: ['depends_on'] },
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(nested(r.body.results, memLinked), undefined, 'an explicit label filter did not exclude the link');
    assert.ok(nested(r.body.results, entB), 'the named label must still be followed');
  });

  it('a memory SEED is no longer a dead end — the walk starts from what it names', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    /*
     * The reported limit, from the other side. Edge endpoints are entity ids, so a matched memory had nothing
     * to follow and came back with an empty `_graph` at any depth; both doors documented that and told the
     * caller to lift the ids off the match and traverse from one of those by hand.
     */
    const mq = 'wombat marsupial burrow relocation checklist';
    const off = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: mq, types: ['fact'], topK: 5, traverse: 1 }) });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const seedOff = off.body.results.find(x => hitId(x) === seedMemId);
    assert.ok(seedOff, 'the memory must match its own text');
    assert.equal(nested(off.body.results, seedAId), undefined, 'unflagged behaviour must be unchanged');

    const on = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: mq, types: ['fact'], topK: 5, traverse: { depth: 1, includeMemories: true } }) });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const a = nested(on.body.results, seedAId);
    assert.ok(a, `the entity the memory names must be hop 1: ${JSON.stringify(allNested(on.body.results).map(n => n.node?._id))}`);
    assert.equal(a.paths[0].length - 1, 1, 'the named entity is one hop from the match');
    assert.equal(a.edge.label, 'fact.entityIds');
  });

  it('and the walk carries on from there — hop 2 is an ordinary edge', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // Reaching the entity and stopping would be half the fix: the point of starting from it is that
    // everything the graph relates to it is now reachable from the memory that matched.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'wombat marsupial burrow relocation checklist',
      types: ['fact'], topK: 5, traverse: { depth: 2, includeMemories: true },
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = nested(r.body.results, entB);
    assert.ok(b, `A→B must be reached at depth 2: ${JSON.stringify(allNested(r.body.results).map(n => n.node?._id))}`);
    assert.equal(b.paths[0].length - 1, 2, 'the edge neighbour of a linked entity is TWO hops from the match');
  });

  it('a memory seed reaches ANOTHER MEMORY through the entity they share', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    /*
     * The case the other three do not make. Each of them covers one leg — an entity seed reaching a memory
     * that names it, a memory seed reaching the entity it names, a memory seed reaching another entity across
     * an edge — and read together they look like coverage of the whole walk. None joins two legs, which is
     * the shape 4.0 led with: a search that matches a memory is no longer a dead end.
     *
     * `topK: 1` IS THE ASSERTION, not a tidiness. A match is deliberately never repeated as its own graph
     * node, so any memory that ranks for this query cannot appear in the graph however well the walk works.
     * At topK 5 the sibling ranked, the graph held only entities, and that reads exactly like a broken walk —
     * it cost several hours and a wrong bug report before the `topK` was the thing that changed.
     */
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'wombat marsupial burrow relocation checklist',
      types: ['fact'], topK: 1, traverse: { depth: 2, includeMemories: true },
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results?.length, 1, 'more than one match makes this test unable to fail honestly');

    const reached = nested(r.body.results, siblingMemId);
    assert.ok(reached, 'the walk stopped at the entity: a memory naming the same entity was NOT returned. '
      + `Reached: ${JSON.stringify(allNested(r.body.results).map(n => `${n.node?.kind}:${n.node?._id}`))}`);
    assert.equal(reached.node.kind, 'fact');
    assert.equal(reached.paths[0].length - 1, 2, 'the sibling memory is TWO hops from the match');
  });

  it('the echo reports the flags, so a caller can see what the server did', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // A response echoing `traverse: 1` for a call that also asked for memories would describe a walk the
    // server did not do, which is the one thing the echo exists to prevent.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: q, types: ['entity'], topK: 5, traverse: { depth: 1, includeMemories: true } }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.traverse?.includeMemories, true, `echo was: ${JSON.stringify(r.body.traverse)}`);
  });

  it('a non-boolean flag is refused, not coerced', async () => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({ query: 'anything', traverse: { depth: 1, includeChrono: 'yes' } }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /includeChrono/);
  });
});

describe('Recall traverse — result cap', () => {
  it('caps the combined output on a dense graph', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // topK 1, traverse 1 → cap = 1 * (1+1) * 4 = 8. Hub has 30 leaves at hop 1,
    // so truncation MUST engage: exactly 1 seed + 7 neighbours = 8.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE_DENSE, ...({
      query: 'telemetry metrics aggregation collectors', types: ['entity'], topK: 1, traverse: 1,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The cap bounds the traversed NODES exactly as before — `topK * (traverse+1) * 4` minus the seeds — but
    // `count` now describes the matches, so the two numbers are asserted separately rather than conflated.
    assert.equal(r.body.count, 1, 'count is the matches, and topK was 1');
    assert.equal(r.body.results.length, 1, 'exactly one match');
    assert.equal(r.body.graphNodes, 7, `cap 8 minus 1 seed = 7 traversed nodes, got ${r.body.graphNodes}`);
    assert.equal(allNested(r.body.results).length, 7, 'and the tree holds exactly those');
  });
});

// ── Spill: a truncated graph is never silent (B-19) ──────────────────────────

describe('Recall traverse — the complete graph is downloadable when it does not fit', () => {
  // The fixture is deliberately ABOVE the cap: 30 leaves at hop 1 with `topK: 1, traverse: 1` gives a cap of
  // 8, so 7 nodes come back inline and the whole 30 must be somewhere. A fixture INSIDE the cap cannot see
  // this at all, which is exactly how the deep-skip defect shipped behind tests that paged 12 and 25 rows.
  it('a graph past the cap returns a link to the whole of it', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE_DENSE, ...({
      query: 'telemetry metrics aggregation collectors', types: ['entity'], topK: 1, traverse: 1,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.graphTruncated, true, 'the inline graph is short, and the response must say so');
    assert.ok(r.body.graphComplete, 'and must say where the rest is');
    assert.ok(r.body.graphComplete.nodes > r.body.graphNodes,
      `the file must hold more than came back inline: ${r.body.graphComplete.nodes} vs ${r.body.graphNodes}`);
    assert.equal(r.body.graphComplete.nodes, 30, 'the hub has 30 leaves, so the complete graph has 30 nodes');
    assert.match(r.body.graphComplete.path, /^_tmp\/graph-[0-9a-f-]+\.json$/);
    assert.ok(r.body.graphComplete.expiresAt, 'a TTL the caller can see');
    const ttlHours = (new Date(r.body.graphComplete.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(ttlHours > 20 && ttlHours <= 24, `one day, got ${ttlHours.toFixed(1)}h`);
  });

  it('the link needs the caller token, and serves the complete graph', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE_DENSE, ...({
      query: 'telemetry metrics aggregation collectors', types: ['entity'], topK: 1, traverse: 1,
    }) });
    const url = `${INSTANCES.a}${r.body.graphComplete.download}`;

    // Unauthenticated first. A download URL that worked without a token would be a way to read a space's
    // records with no auth, which is the one thing this must not become.
    const anon = await fetch(url);
    assert.ok(anon.status === 401 || anon.status === 403, `expected a refusal, got ${anon.status}`);

    const authed = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    assert.equal(authed.status, 200);
    const body = JSON.parse(await authed.text());
    assert.equal(body.kind, 'graph-traversal');
    assert.equal(body.nodes, 30);
    const nested = body.graph.flatMap(g => g.graph ?? []);
    assert.equal(nested.length, 30, 'the file holds the whole neighbourhood, not the inline slice');
    assert.ok(nested[0].edge && nested[0].node && nested[0].paths, 'and holds it in the same shape');
  });

  it('a graph that FITS gets no link and no flag', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    // The other half of the check, and the one a flag-only implementation would have got wrong: three
    // neighbours at depth 1 in the chain space is well inside the cap.
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, ...({
      query: 'authentication token scoping vault', types: ['entity'], topK: 10, traverse: 1,
    }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.graphTruncated, undefined, 'a complete graph must not be flagged as truncated');
    assert.equal(r.body.graphComplete, undefined, 'and must not write a file nobody needs');
  });

  it('the spill is hidden from file browsing and never queued for embedding', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE_DENSE, ...({
      query: 'telemetry metrics aggregation collectors', types: ['entity'], topK: 1, traverse: 1,
    }) });

    // Hidden: `_tmp` is output, like `_converted/` and `_extracted/`.
    const listing = await get(INSTANCES.a, token(), `/api/files/${SPACE_DENSE}`);
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    const names = (listing.body?.entries ?? []).map(e => e.name);
    assert.ok(!names.includes('_tmp'), `_tmp must not be browsable: ${JSON.stringify(names)}`);

    // Not embedded: embedding a read's own output would let the next recall match the JSON dump of an
    // earlier one, and would spend model time doing it.
    const queue = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE_DENSE}/embedding-queue/media`);
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const jobs = JSON.stringify(queue.body);
    assert.ok(!jobs.includes('_tmp/'), `no spill may be queued: ${jobs.slice(0, 300)}`);
  });
});

// ── MCP surface (embedding required) ─────────────────────────────────────────

describe('Recall traverse — MCP tool', () => {
  it('MCP recall accepts traverse and returns annotated results', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const result = await session.callTool('recall', { space: SPACE, query: 'authentication token scoping vault', types: ['entity'], traverse: 1 });
      const text = result?.content?.[0]?.text;
      assert.ok(text, 'MCP recall returned text content');
      const output = JSON.parse(text);
      assert.equal(output.traverseDepth, 1);
      const seed = output.results.find(x => hitId(x) === seedAId);
      assert.ok(seed, 'the seed is a match, with its record');
      // Same shape as REST, asserted through the other door in the same fixture: one nesting implementation
      // serves both, and this is what says so.
      const neighbour = (seed._graph ?? []).find(n => n.node?._id === entB);
      assert.ok(neighbour, `neighbour B nested under the seed: ${JSON.stringify((seed._graph ?? []).map(n => n.node?._id))}`);
      assert.deepEqual(neighbour.paths[0], [seedAId, entB]);
      assert.ok(edgeConnects(neighbour.edge, seedAId, entB), 'MCP carries the whole reaching edge too');
      assert.equal(output.count, output.results.length, 'MCP count is the matches as well');
    } finally {
      session.close();
    }
  });
});
