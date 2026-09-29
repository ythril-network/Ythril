/**
 * A traversed answer row is COMPLETE AS REQUESTED — the record and its whole `_graph` — or it is absent and
 * named. Nothing is spilled unless the caller asked for the remainder. Every door, every limit.
 *
 * ## The rule this states (Q-126, owner 2026-09-28)
 *
 * *"a returned row is complete as requested — record + whole _graph — or absent and named; truncation
 * reported; nothing spilled unless remainderDump: true"*. It reverses the 2026-08-13 ruling that an
 * oversized neighbourhood is cut to an inline cap and the whole of it written to a spill on every call.
 *
 * The cut that ruling produced is invisible from inside an answer: a hub row whose neighbourhood passes
 * `topK * (traverse + 1) * 4` comes back with a SHORTER `_graph` and nothing on the row saying so, so a
 * caller cannot tell a record with seven relationships from one whose other thirty were dropped. And the
 * complete copy was written whether or not anybody wanted it.
 *
 * ## Why the reference is the fixture's own edge list
 *
 * `a-traversed-recall-returns-whole-graphs` compares a tight answer with the SAME QUESTION asked without a
 * budget — which is honest only while the unbudgeted answer is itself whole. Past the inline cap it is not,
 * so a comparison against it concludes that a short graph equals a short graph. The oracle here is computed
 * from the edges this file wrote: the node-id SET at each depth, breadth-first, entity-only, both directions
 * (the call's default). It is not a re-implementation of the nesting — only of who is how far away — so it
 * cannot share a defect with the walk it checks.
 *
 * ## The four doors
 *
 * REST `/api/brain/recall`, MCP `recall`, REST `/api/brain/similar`, MCP `similar`. The same assertions run
 * through each, because the defect class this repo produces most is one rule with a weaker second copy.
 *
 * ## Fixture
 *
 * Space A: three EMBEDDED records — a probe P, a hub H, a small match M — and everything else written with
 * `suppressEmbeddings: true`, so it cannot rank and reaches an answer only through the walk. H has
 * `HUB_SPOKES` spokes, each with one leaf: 2·HUB_SPOKES nodes within two hops, past the inline cap of every
 * call below (recall topK 3 → 33, similar topK 2 → 22). M has two spokes and two leaves. Components are
 * disjoint, so no row's neighbourhood depends on which other rows share its page.
 *
 * Space B: a seed Q hanging off a 4-clique by one edge, and a probe Q2 for `similar`. Walked three hops, a
 * clique is where a route doubles back on itself, which `paths` must never contain.
 *
 * A fixture that cannot be seeded FAILS the test; it never skips (a skipped completeness test is a green run
 * that asserted nothing).
 *
 * Run: node --test testing/integration/a-traversed-row-is-whole-or-absent.test.js
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, waitForIndexed, waitForSimilarityIndex } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `whole-or-absent-${RUN}`;
const SPACE_CLIQUE = `whole-or-absent-clique-${RUN}`;
const QUERY = 'orbital quasar telemetry lattice calibration';
const CLIQUE_QUERY = 'glacier sediment core isotope archive';

/** Past every inline cap below: 2 * 20 = 40 nodes within two hops of the hub. */
const HUB_SPOKES = 20;
const DEPTH = 2;
const CLIQUE_DEPTH = 3;
/** Every seed row is larger than the smallest budget a caller may ask for, so the FIRST row is oversized there. */
const MIN_BUDGET = 1_000;
const BIG_BUDGET = 4_000_000;
const LONG = 'calibration notes '.repeat(80);

let token;
let mcp;
/** The fixture's own edges, `[from, to]` — the oracle's only input. */
const edgesA = [];
const edgesB = [];
const ids = {};

const rest = async (route, body) => {
  const r = await post(INSTANCES.a, token, route, body);
  return { status: r.status, body: r.body };
};
const tool = async (name, args) => {
  const r = await mcp.callTool(name, args);
  if (r?.isError) return { status: 400, body: { error: r.content?.[0]?.text } };
  const body = r?.structuredContent ?? JSON.parse(r?.content?.[0]?.text ?? 'null');
  return { status: 200, body };
};

/**
 * The four doors. Each takes the door-neutral half of a request and states its own question: recall ranks
 * by a query, similar by a probe record. `seeds` is who the ranked set is, from the fixture.
 */
const DOORS = [
  { name: 'REST recall', seeds: () => [ids.P, ids.H, ids.M], topK: 3,
    call: (b, q = QUERY, space = SPACE) => rest('/api/brain/recall', { space, query: q, types: ['entity'], ...b }) },
  { name: 'MCP recall', seeds: () => [ids.P, ids.H, ids.M], topK: 3,
    call: (b, q = QUERY, space = SPACE) => tool('recall', { space, query: q, types: ['entity'], ...b }) },
  { name: 'REST similar', seeds: () => [ids.H, ids.M], topK: 2,
    call: (b, probe = ids.P, space = SPACE) => rest('/api/brain/similar',
      { space, entryId: probe, entryType: 'entity', targetTypes: ['entity'], ...b }) },
  { name: 'MCP similar', seeds: () => [ids.H, ids.M], topK: 2,
    call: (b, probe = ids.P, space = SPACE) => tool('similar',
      { space, entryId: probe, entryType: 'entity', targetTypes: ['entity'], ...b }) },
];

const rowId = (r) => r?.record?._id ?? r?._id;

/**
 * THE ORACLE: node ids at each distance 1..depth from `seed`, over `edges` in both directions. The seed
 * itself is at 0 and is not part of its own graph.
 */
function oracle(edges, seed, depth) {
  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  }
  const seen = new Set([seed]);
  const byDepth = [];
  let frontier = [seed];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next = [];
    for (const n of frontier) for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); next.push(m); }
    if (next.length > 0) byDepth.push(next.sort());
    frontier = next;
  }
  return byDepth;
}

/** The node-id set at each nesting level of a returned `_graph`, in the oracle's form. */
function graphSets(graph) {
  const byDepth = [];
  const walk = (nodes, d) => {
    for (const n of nodes ?? []) {
      (byDepth[d] ??= []).push(n.node?._id);
      walk(n._graph, d + 1);
    }
  };
  walk(graph, 0);
  return byDepth.map(xs => xs.sort());
}

/** Every nested entry of a row's `_graph`, at any depth. */
function nestedEntries(graph) {
  const out = [];
  const walk = ns => { for (const n of ns ?? []) { out.push(n); walk(n._graph); } };
  walk(graph);
  return out;
}

const namedIncomplete = (body) => new Set((body.incompleteRows ?? []).map(r => r._id));

/**
 * The owner's rule for ONE row: returned, its graph is the oracle's; else it is named as incomplete.
 */
function assertWholeOrNamed(door, body, edges, seed, depth) {
  const row = (body.results ?? []).find(r => rowId(r) === seed);
  const want = oracle(edges, seed, depth);
  if (row) {
    const got = graphSets(row._graph);
    const wantN = want.flat().length;
    const gotN = got.flat().length;
    assert.deepEqual(got, want,
      `${door}: row ${seed} was returned with ${gotN} of the ${wantN} nodes its neighbourhood holds — a returned `
      + 'row must carry its WHOLE _graph, or be absent and named in incompleteRows');
    return;
  }
  assert.ok(namedIncomplete(body).has(seed),
    `${door}: row ${seed} is neither returned nor named in incompleteRows: ${JSON.stringify(body.incompleteRows)}`);
}

/** No spill of any kind, anywhere in the answer. */
function assertNoSpill(door, body) {
  assert.equal(body.graphComplete, undefined,
    `${door}: graphComplete was sent — the complete-graph spill is gone; nothing is written unless remainderDump: true`);
  assert.equal(body.remainder, undefined, `${door}: a remainder was written without remainderDump`);
  assert.ok(!JSON.stringify(body).includes('"spillId"'),
    `${door}: the answer names a spillId without remainderDump: ${JSON.stringify(body).slice(0, 300)}`);
}

/**
 * THE PAGING INVARIANT: every ranked row considered is accounted for exactly once — returned, named as
 * incomplete, or left past the cut — and `graphTruncated` means exactly "rows are absent", never "a returned
 * graph is short".
 */
function assertAccounted(door, body, skip) {
  const returned = (body.results ?? []).length;
  const incomplete = body.incompleteCount ?? 0;
  const past = body.truncated ? body.count - body.nextSkip : 0;
  assert.equal(returned + incomplete + past, body.count - skip,
    `${door}: returned ${returned} + incomplete ${incomplete} + past the cut ${past} must be count ${body.count} `
    + `- skip ${skip}`);
  assert.equal(body.graphTruncated === true, incomplete > 0,
    `${door}: graphTruncated is ${body.graphTruncated} with incompleteCount ${body.incompleteCount} — it must be `
    + 'true exactly when rows are absent for want of a whole graph');
}

async function seedSpace(space, label) {
  const created = await post(INSTANCES.a, token, '/api/spaces', { id: space, label });
  assert.equal(created.status, 201, `space ${space}: ${JSON.stringify(created.body)}`);
}

async function bulk(space, entities, edges) {
  const r = await post(INSTANCES.a, token, `/api/brain/spaces/${space}/bulk`, {
    entities, edges: edges.map(([from, to], i) => ({ from: `$ref:${from}`, to: `$ref:${to}`, label: `joins_${i % 3}` })),
  });
  assert.ok([200, 201, 207].includes(r.status), `bulk into ${space}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.errors?.length ?? 0, 0, `bulk into ${space} refused items: ${JSON.stringify(r.body.errors)}`);
  const out = {};
  for (const e of entities) {
    out[e.$ref] = r.body.refs?.[e.$ref]?.id;
    assert.ok(out[e.$ref], `bulk into ${space} returned no id for ${e.$ref}: ${JSON.stringify(r.body.refs).slice(0, 300)}`);
  }
  return out;
}

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token, INSTANCES.a, 60_000);

  // ── Space A: probe, hub, small match ──
  await seedSpace(SPACE, `Whole or absent ${RUN}`);
  const ents = [
    { $ref: 'P', name: `quasar-probe-${RUN}`, type: 'instrument',
      description: `Orbital quasar telemetry lattice calibration probe. ${LONG}` },
    { $ref: 'H', name: `quasar-hub-${RUN}`, type: 'instrument',
      description: `Orbital quasar telemetry lattice calibration hub array. ${LONG}` },
    { $ref: 'M', name: `quasar-small-${RUN}`, type: 'instrument',
      description: `Orbital quasar telemetry lattice calibration relay station. ${LONG}` },
  ];
  const refEdges = [];
  const spoke = (ref, name) => ents.push({ $ref: ref, name, type: 'part', description: `part ${name}`, suppressEmbeddings: true });
  for (let i = 0; i < HUB_SPOKES; i++) {
    spoke(`hs${i}`, `hub-spoke-${i}-${RUN}`); spoke(`hl${i}`, `hub-leaf-${i}-${RUN}`);
    refEdges.push(['H', `hs${i}`], [`hs${i}`, `hl${i}`]);
  }
  for (let i = 0; i < 2; i++) {
    spoke(`ms${i}`, `small-spoke-${i}-${RUN}`); spoke(`ml${i}`, `small-leaf-${i}-${RUN}`);
    refEdges.push(['M', `ms${i}`], [`ms${i}`, `ml${i}`]);
  }
  const a = await bulk(SPACE, ents, refEdges);
  Object.assign(ids, { P: a.P, H: a.H, M: a.M });
  for (const [f, t] of refEdges) edgesA.push([a[f], a[t]]);

  // ── Space B: a seed on a 4-clique, and a probe for similar ──
  await seedSpace(SPACE_CLIQUE, `Whole or absent clique ${RUN}`);
  const cEnts = [
    { $ref: 'Q', name: `glacier-core-${RUN}`, type: 'sample', description: 'Glacier sediment core isotope archive, the reference sample.' },
    { $ref: 'Q2', name: `glacier-probe-${RUN}`, type: 'sample', description: 'Glacier sediment core isotope archive, a second sample.' },
    ...['k0', 'k1', 'k2', 'k3'].map(k => ({ $ref: k, name: `clique-${k}-${RUN}`, type: 'part', description: `node ${k}`, suppressEmbeddings: true })),
  ];
  const cEdges = [['Q', 'k0'], ['k0', 'k1'], ['k0', 'k2'], ['k0', 'k3'], ['k1', 'k2'], ['k1', 'k3'], ['k2', 'k3']];
  const b = await bulk(SPACE_CLIQUE, cEnts, cEdges);
  Object.assign(ids, { Q: b.Q, Q2: b.Q2 });
  for (const [f, t] of cEdges) edgesB.push([b[f], b[t]]);

  // Both questions need the INDEX: recall's own poll for recall, and similar's for similar (which has no
  // fresh-write scan). A timeout throws, so an unseedable fixture fails here rather than skipping below.
  await waitForIndexed(INSTANCES.a, token, SPACE, [ids.P, ids.H, ids.M], ['entity']);
  await waitForSimilarityIndex(INSTANCES.a, token, SPACE, ids.P, 'entity', ids.H);
  await waitForSimilarityIndex(INSTANCES.a, token, SPACE, ids.P, 'entity', ids.M);
  await waitForIndexed(INSTANCES.a, token, SPACE_CLIQUE, [ids.Q], ['entity']);
  await waitForSimilarityIndex(INSTANCES.a, token, SPACE_CLIQUE, ids.Q2, 'entity', ids.Q);

  // The fixture is past the cap it is meant to be past, or none of this proves anything.
  assert.equal(oracle(edgesA, ids.H, DEPTH).flat().length, 2 * HUB_SPOKES, 'the hub neighbourhood as written');
  assert.ok(2 * HUB_SPOKES > 3 * (DEPTH + 1) * 4 - 3, 'the hub must be past recall\'s inline cap of topK 3');
});

after(async () => {
  for (const s of [SPACE, SPACE_CLIQUE]) {
    await fetch(`${INSTANCES.a}/api/spaces/${s}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  }
});

/** Every row of a remainder spill, read to its end through the spill route. */
async function remainderRows(remainder) {
  const rows = [];
  let skip = 0;
  for (let guard = 0; guard < 50; guard++) {
    const r = await fetch(`${INSTANCES.a}/api/brain/spills/${remainder.spillId}?skip=${skip}&maxChars=${BIG_BUDGET}`,
      { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, `the remainder ${remainder.spillId} could not be read: ${r.status}`);
    const page = await r.json();
    rows.push(...(page.items ?? []));
    if (!page.truncated) return rows;
    skip = page.nextSkip;
  }
  assert.fail('the remainder did not end within 50 pages');
}

for (const door of DOORS) {
  describe(`${door.name}: a traversed row is whole or absent`, () => {
    const whole = { topK: door.topK, traverse: DEPTH, maxChars: BIG_BUDGET };

    it('every returned row carries exactly the neighbourhood the fixture holds; the hub is whole or named', async () => {
      const r = await door.call(whole);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      const got = new Set((r.body.results ?? []).map(rowId));
      for (const seed of door.seeds()) {
        assert.ok(got.has(seed) || namedIncomplete(r.body).has(seed),
          `seed ${seed} is missing from the answer and not named: ${JSON.stringify([...got])}`);
        assertWholeOrNamed(door.name, r.body, edgesA, seed, DEPTH);
      }
    });

    it('no graph spill is written without remainderDump', async () => {
      const r = await door.call(whole);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assertNoSpill(door.name, r.body);
    });

    it('with remainderDump, the rows past the cut are whole in the remainder too', async () => {
      const r = await door.call({ topK: door.topK, traverse: DEPTH, maxChars: MIN_BUDGET, remainderDump: true });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.truncated, true, `a ${MIN_BUDGET}-char budget must cut this answer`);
      assert.ok(r.body.remainder?.spillId, `remainderDump was asked and no remainder named: ${JSON.stringify(r.body).slice(0, 300)}`);
      const rest = await remainderRows(r.body.remainder);
      const all = { results: [...(r.body.results ?? []), ...rest], incompleteRows: r.body.incompleteRows };
      const seen = all.results.map(rowId);
      assert.equal(new Set(seen).size, seen.length, `a row appears twice across the page and its remainder: ${seen}`);
      for (const seed of door.seeds()) assertWholeOrNamed(`${door.name} (page + remainder)`, all, edgesA, seed, DEPTH);
      assert.equal(r.body.graphComplete, undefined, 'graphComplete is never sent, remainderDump or not');
    });

    describe('the paging truth table', () => {
      const rows = [
        ['no cut', { maxChars: BIG_BUDGET }, 0],
        ['oversized first row', { maxChars: MIN_BUDGET }, 0],
        ['skip > 0', { maxChars: BIG_BUDGET, skip: 1 }, 1],
        ['skip > 0 with an oversized first row', { maxChars: MIN_BUDGET, skip: 1 }, 1],
      ];
      for (const [name, extra, skip] of rows) {
        it(name, async () => {
          const r = await door.call({ topK: door.topK, traverse: DEPTH, ...extra });
          assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
          if (extra.maxChars === MIN_BUDGET) {
            // "a budget must not become a wall": a first row larger than the whole budget is still returned,
            // alone and whole, so every page consumes at least one row.
            assert.equal((r.body.results ?? []).length + (r.body.incompleteCount ?? 0) >= 1, true,
              'every page consumes at least one row');
          }
          assertAccounted(door.name, r.body, skip);
          assertNoSpill(door.name, r.body);
          for (const row of r.body.results ?? []) assertWholeOrNamed(door.name, r.body, edgesA, rowId(row), DEPTH);
        });
      }
    });

    it('no route repeats an id, and the clique row is whole', async () => {
      const r = door.name.includes('recall')
        ? await door.call({ topK: 2, traverse: CLIQUE_DEPTH, maxChars: BIG_BUDGET }, CLIQUE_QUERY, SPACE_CLIQUE)
        : await door.call({ topK: 1, traverse: CLIQUE_DEPTH, maxChars: BIG_BUDGET }, ids.Q2, SPACE_CLIQUE);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      const row = (r.body.results ?? []).find(x => rowId(x) === ids.Q);
      assert.ok(row, `the clique seed must be the match: ${JSON.stringify((r.body.results ?? []).map(rowId))}`);
      assertWholeOrNamed(door.name, r.body, edgesB, ids.Q, CLIQUE_DEPTH);
      const adjacent = new Set(edgesB.flatMap(([a, b]) => [`${a}>${b}`, `${b}>${a}`]));
      for (const n of nestedEntries(row._graph)) {
        for (const route of n.paths ?? []) {
          assert.equal(new Set(route).size, route.length,
            `${door.name}: a route to ${n.node?._id} visits a node twice: ${JSON.stringify(route)}`);
          assert.equal(route[0], ids.Q, 'a route starts at the match');
          assert.equal(route[route.length - 1], n.node?._id, 'a route ends at the node it describes');
          for (let i = 1; i < route.length; i++) {
            assert.ok(adjacent.has(`${route[i - 1]}>${route[i]}`), `a route steps along an edge the fixture does not hold: ${route}`);
          }
        }
      }
    });
  });
}
