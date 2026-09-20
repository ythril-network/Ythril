/**
 * Integration: a traversal answers with every edge among the nodes it reached — including a self-loop, and
 * including a second edge between a pair it already joined.
 *
 * ## The defect, reported from outside and confirmed in the source
 *
 * Both walks track **whether a NODE has been reached**, never whether an EDGE has been followed. The first
 * edge into a node wins; every other edge into that same node is discarded. Nothing anywhere says so —
 * `truncated` stays `false`, which the tool's own documentation defines as *"nothing was cut for size
 * reasons"*, so the one signal a caller has for an incomplete answer is actively telling them the answer is
 * complete.
 *
 * It surfaces as two symptoms that look unrelated and are one cause:
 *
 * 1. **A self-loop never comes back.** `A --label--> A` is skipped by the same-level test in `both` mode
 *    (the frontier holds both ends) and by the visited set in `outbound` mode, where the seed is already in
 *    it. Reported against a live space: a status node with two self-loops returned neither, at any depth,
 *    with or without a label filter, while a direct query on the edges collection returned both.
 * 2. **Two edges between one pair collapse to one.** Asked for individually each comes back; asked for
 *    together, one disappears. Reported: an `optional` and a `triggerable` edge to the same node, and only
 *    `optional` survived.
 *
 * ## Why `paths` could not have covered it
 *
 * A path is a chain of record ids, so both edges of a parallel pair produce the *identical* chain and the
 * alternate-route bookkeeping correctly concludes it has already seen that route. A field that cannot
 * express the difference between two relationships is not the place to record one. That is why the answer
 * here is edges rather than more paths.
 *
 * ## BOTH walks, because there are two and they have diverged before
 *
 * `traverseGraph` in `edges.ts` and the seed expansion in `recall-seed-traversal.ts` are separate BFS
 * implementations of one rule, and the reporter reproduced the identical gap through each. That file already
 * carries the scar of the last time: *"One rule, two implementations, and the one reachable from a search
 * had the weaker."* A gate covering one tool would have a title claiming the walk and a body checking half
 * of it.
 *
 * ## The floor, and why every case has a control
 *
 * Every assertion here is about something being PRESENT that used to be absent, and an absent fixture
 * produces exactly the same failure as an absent feature. So the fixtures are asserted on write, the edge
 * count is read back before anything is walked, and each symptom is paired with a single-edge control in
 * the same space and the same call.
 *
 * Run: node --test testing/integration/a-walk-returns-every-edge-among-the-nodes-it-reached.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `traverse-every-edge-${RUN}`;

let tokenA;
const ids = {};
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);
const traverse = (body) => P(`/api/brain/spaces/${SPACE}/traverse`, body);

/** Every fixture write is asserted — a failed setup and a negative result look identical otherwise. */
function must(label, res, pick = (b) => b?._id) {
  const id = pick(res.body);
  assert.ok(res.status < 400 && id, `fixture '${label}' failed: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

/** The labels a walk reported for one ordered pair, sorted so the assertion is about the SET. */
const labelsBetween = (res, from, to) =>
  (res.body?.edges ?? []).filter(e => e.from === from && e.to === to).map(e => e.label).sort();

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Traverse every edge ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);

  const entity = (name, type) => P(`/api/brain/spaces/${SPACE}/entities`, { name: `${name} ${RUN}`, type });
  ids.hub = must('hub', await entity('Hub', 'service'));
  ids.pair = must('pair', await entity('Pair', 'service'));
  ids.solo = must('solo', await entity('Solo', 'service'));

  const edge = (label, from, to) => P(`/api/brain/spaces/${SPACE}/edges`, { from, to, label });

  // Symptom 1: a node that routes on its own state. Two of them, so the case is "self-loops" and not
  // "the one self-loop we happened to write".
  ids.loopA = must('self-loop A', await edge('conditional', ids.hub, ids.hub));
  ids.loopB = must('self-loop B', await edge('optional', ids.hub, ids.hub));

  // Symptom 2: one pair, two different relationships. Different labels, so a caller can tell them apart
  // and so can this test.
  ids.pairY = must('pair edge Y', await edge('optional', ids.hub, ids.pair));
  ids.pairZ = must('pair edge Z', await edge('triggerable', ids.hub, ids.pair));

  // THE CONTROL: one edge, one target, nothing to compete with. If this goes missing the walk is broken
  // rather than incomplete, and every failure below would be misread.
  ids.soloEdge = must('control edge', await edge('contains', ids.hub, ids.solo));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('the floor: the edges exist before anything is asked to walk them', () => {
  it('the space holds all five, read straight from the collection', async () => {
    // Not decoration. Every case below asserts a PRESENCE, and an edge that was never written produces the
    // identical failure to an edge the walk dropped — which is the reading that would turn this whole file
    // into a test of its own fixture.
    const r = await P('/api/filter', { space: SPACE, collection: 'edges', filter: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body?.error ?? r.status));
    const stored = (r.body?.data?.results ?? []).map(e => e._id).sort();
    assert.deepEqual(stored, [ids.loopA, ids.loopB, ids.pairY, ids.pairZ, ids.soloEdge].sort(),
      `the fixture did not land, so nothing below is about the walk — ${stored.length} of 5 stored`);
  });
});

describe('the standalone walk', () => {
  it('the control walks: a lone edge to a lone node comes back', async () => {
    const res = await traverse({ startId: ids.hub, maxDepth: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(labelsBetween(res, ids.hub, ids.solo), ['contains'],
      'the uncontested edge is missing too, so the walk is broken rather than incomplete');
  });

  it('returns BOTH edges between one pair, not whichever was read first', async () => {
    const res = await traverse({ startId: ids.hub, maxDepth: 1 });
    assert.deepEqual(labelsBetween(res, ids.hub, ids.pair), ['optional', 'triggerable'],
      'one of two relationships to the same node was dropped. A caller sees a complete-looking answer and '
      + 'has no way to know a second, differently-labelled edge exists.');
  });

  it('returns a SELF-LOOP, which is an edge at a node like any other', async () => {
    const res = await traverse({ startId: ids.hub, maxDepth: 1 });
    assert.deepEqual(labelsBetween(res, ids.hub, ids.hub), ['conditional', 'optional'],
      'a node that routes on its own state has no representation in the answer at all');
  });

  it('a label filter naming ONLY the self-loop label returns it', async () => {
    // Isolates the symptom from label competition: asked for alone, with nothing else to lose to, the
    // self-loop still came back empty in the report. That rules out "the other edge won" as the cause.
    const res = await traverse({ startId: ids.hub, maxDepth: 1, edgeLabels: ['conditional'] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(labelsBetween(res, ids.hub, ids.hub), ['conditional'],
      'the edge exists and the filter names it, so an empty answer is the walk refusing its own subject');
  });

  it('and says nothing was truncated, because nothing was', async () => {
    // The half that makes this a contract problem rather than a capacity one. `truncated` means "nothing
    // was cut for size reasons" — it was false throughout while three of five edges were missing, so the
    // caller's only signal was pointing the wrong way.
    const res = await traverse({ startId: ids.hub, maxDepth: 1 });
    assert.equal(res.body?.truncated, false, JSON.stringify(res.body));
    assert.equal((res.body?.edges ?? []).length, 5,
      `all five edges of this neighbourhood belong in the answer: ${JSON.stringify(res.body?.edges)}`);
  });

  it('every returned edge is a real one, so completeness is not bought with duplicates', async () => {
    // The opposite failure, and it is the one a fix for the above tends to introduce: emitting an edge once
    // per hop that touches it. A caller counting relationships must get the number that exists.
    const res = await traverse({ startId: ids.hub, maxDepth: 1 });
    const seen = (res.body?.edges ?? []).map(e => e._id);
    assert.deepEqual([...new Set(seen)].sort(), seen.slice().sort(),
      `an edge was reported twice: ${JSON.stringify(seen)}`);
  });
});

describe('the recall expansion, which is the second implementation of the same rule', () => {
  /** One seed, pinned by id, so the case is about the walk and not about what the embedding ranked. */
  const expand = () => post(INSTANCES.a, tokenA, '/api/brain/recall', {
    space: SPACE, query: `Hub ${RUN}`, traverse: 1, topK: 1, filter: { _id: ids.hub },
  });

  /** The `_graph` entry for one reached node, whatever depth it is nested at. */
  const entryFor = (body, id) => (body?.results?.[0]?._graph ?? []).find(g => g.node?._id === id);

  it('the control expands: the lone neighbour is reached and names its edge', async () => {
    const r = await expand();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const entry = entryFor(r.body, ids.solo);
    assert.ok(entry, `the uncontested neighbour was not reached at all: ${JSON.stringify(r.body?.results?.[0]?._graph)}`);
    assert.deepEqual((entry.edges ?? []).map(e => e.label), ['contains'],
      'a reached node carries the edges that reached it, as an array — one edge is an array of one');
  });

  it('carries BOTH edges to a node reached two ways', async () => {
    const r = await expand();
    const entry = entryFor(r.body, ids.pair);
    assert.ok(entry, 'the doubly-connected neighbour was not reached');
    assert.deepEqual((entry.edges ?? []).map(e => e.label).sort(), ['optional', 'triggerable'],
      'the singular `edge` field stood for two relationships and silently named one of them');
  });

  it('carries the self-loop on the node it loops at', async () => {
    const r = await expand();
    const entry = entryFor(r.body, ids.hub);
    assert.ok(entry, 'a node with a self-loop has no entry, so the loop has nowhere to be reported');
    assert.deepEqual((entry.edges ?? []).map(e => e.label).sort(), ['conditional', 'optional'],
      'a self-loop is a relationship the graph holds and the walk must report it');
  });

  it('the edges are whole documents, not three fields', async () => {
    // `recall-graph.ts` records why: reducing the edge to `{label}` threw away its properties and its
    // description, which is what a caller needs to explain WHY two records are connected.
    const r = await expand();
    const edge = (entryFor(r.body, ids.solo)?.edges ?? [])[0];
    assert.ok(edge?._id && edge?.label, `an edge must arrive whole: ${JSON.stringify(edge)}`);
  });

  it('but NOT the two endpoint ids, which the entry already states', async () => {
    // Every edge in one entry joins the same pair — this node and the one it is nested under — so `from`
    // and `to` were two UUIDs per edge restating `node._id` and `paths[0]`. Only the orientation was left,
    // and that is one short word. The far end is `paths[0][paths[0].length - 2]` for anyone who wants it.
    const r = await expand();
    const entry = entryFor(r.body, ids.solo);
    const edge = (entry?.edges ?? [])[0];
    assert.equal('from' in edge, false, `\`from\` is still being repeated: ${JSON.stringify(edge)}`);
    assert.equal('to' in edge, false, '`to` is still being repeated');
    assert.equal(edge.direction, 'outbound', 'the edge runs from the seed to this node');
    assert.equal(entry.paths[0][entry.paths[0].length - 2], ids.hub,
      'and the far end is derivable, which is the whole reason the ids can go');
  });

  it('a self-loop says `self` rather than pointing at a node twice', async () => {
    const r = await expand();
    const dirs = (entryFor(r.body, ids.hub)?.edges ?? []).map(e => e.direction);
    assert.deepEqual(dirs, ['self', 'self'], `a loop has no second end to orient against: ${JSON.stringify(dirs)}`);
  });
});
