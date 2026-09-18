/**
 * Integration: `traverse` returns `startId` itself, at depth 0.
 *
 * ## The promise, and what was actually returned
 *
 * `graph_traverse`'s own schema says it, and a schema description is what a caller reads while
 * constructing arguments:
 *
 * > *"`startId` itself at depth 0, so a walk that finds nothing still comes back with one node rather
 * > than empty — an empty `nodes` means the id resolved to nothing, which is a different answer from
 * > 'it has no neighbours'."*
 *
 * Measured 2026-09-18 with two entities and one edge: the answer was one node, the NEIGHBOUR, at depth 1.
 * No depth-0 node, and an isolated entity came back with `nodes: []` — indistinguishable from a bad id.
 *
 * **The second half is the expensive one.** A caller told that an empty `nodes` means *"the id resolved
 * to nothing"* reads every empty walk as a bad id. That cost four probe iterations on an instance where
 * the id was demonstrably good.
 *
 * ## Why the promise is made true rather than the sentence corrected
 *
 * Both were open. Emitting the node costs one row per answer and gives callers the distinction the
 * description describes; correcting the sentence is cheaper and leaves them with no way to tell a bad id
 * from a lonely one — and that distinction is the whole reason the sentence was written.
 *
 * ## Not `recall`'s expansion
 *
 * There the seed is the MATCH, already in `results` with its own score, and `_graph` is deliberately
 * what the walk reached FROM it. Adding the seed to its own graph would double-count a row the caller
 * already has. One rule, two shapes, and the difference is real rather than drift.
 *
 * Run: node --test testing/integration/a-walk-returns-the-node-it-started-from.test.js
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
const SPACE = `walk-start-${RUN}`;

let tokenA;
const ids = {};
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);
const traverse = (body) => P(`/api/brain/spaces/${SPACE}/traverse`, body);

function must(label, res, pick = (b) => b?._id) {
  const id = pick(res.body);
  assert.ok(res.status < 400 && id, `fixture '${label}' failed: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

const nodes = (res) => res.body?.nodes ?? [];
const idsOf = (res) => nodes(res).map(n => n._id);

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Walk start ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);

  ids.hub = must('hub', await P(`/api/brain/spaces/${SPACE}/entities`, { name: `Hub ${RUN}`, type: 'thing' }));
  ids.spoke = must('spoke', await P(`/api/brain/spaces/${SPACE}/entities`, { name: `Spoke ${RUN}`, type: 'thing' }));
  await P(`/api/brain/spaces/${SPACE}/edges`, { from: ids.hub, to: ids.spoke, label: 'connects' });
  // An entity with NO edges and no links — the case the promise exists for.
  ids.lonely = must('lonely', await P(`/api/brain/spaces/${SPACE}/entities`,
    { name: `Lonely ${RUN}`, type: 'thing' }));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('a walk returns the node it started from', () => {
  it('the start node comes back at depth 0', async () => {
    const res = await traverse({ startId: ids.hub, maxDepth: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const start = nodes(res).find(n => n._id === ids.hub);
    assert.ok(start, `the start node is missing: ${JSON.stringify(idsOf(res))}`);
    assert.equal(start.depth, 0, 'and it must be at depth 0, which is what makes it the start');
    assert.equal(start.name, `Hub ${RUN}`, 'it is the whole node, not a stub with an id');
  });

  it('its neighbours are still there, at the depths they always were', async () => {
    // The start node is ADDED, not substituted. A change that returned only the start would pass the
    // case above and break every caller.
    const res = await traverse({ startId: ids.hub, maxDepth: 1 });
    const spoke = nodes(res).find(n => n._id === ids.spoke);
    assert.ok(spoke, `the neighbour is missing: ${JSON.stringify(idsOf(res))}`);
    assert.equal(spoke.depth, 1, 'a neighbour must not shift depth because the start is now reported');
  });

  it('AN ISOLATED NODE COMES BACK WITH ONE NODE, not empty — the whole point', async () => {
    const res = await traverse({ startId: ids.lonely, maxDepth: 3 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(idsOf(res), [ids.lonely],
      'an entity with no neighbours must answer with itself, or a caller cannot tell "no neighbours" '
      + 'from "no such id" — which is exactly what the schema promises it can');
  });

  it('AND AN ID THAT RESOLVES TO NOTHING IS STILL EMPTY, which is the other half', async () => {
    // Without this the change would make every walk non-empty and destroy the distinction from the
    // other side: a promise that an empty `nodes` means a bad id is only useful if a bad id is empty.
    const res = await traverse({ startId: '00000000-0000-4000-8000-000000000000', maxDepth: 3 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(idsOf(res), [],
      'an id naming nothing must answer with nothing, or "empty means the id resolved to nothing" is false');
  });

  it('the start node counts against `limit`, because it is a node', async () => {
    // A node that does not count is a cap that lies by one. `limit: 1` must therefore answer the start
    // alone — which is also the cheapest possible "does this id exist" call.
    const res = await traverse({ startId: ids.hub, maxDepth: 3, limit: 1 });
    assert.deepEqual(idsOf(res), [ids.hub], `limit: 1 must answer the start alone: ${JSON.stringify(nodes(res))}`);
    assert.equal(res.body?.truncated, true, 'and it must say the walk was cut, because it was');
  });

  it('a non-entity start is returned too, with its kind', async () => {
    // `Q-29` made a walk able to START from a fact. The start node has to be resolved the same way a
    // neighbour is, or the two disagree about what a node looks like depending on where you began.
    const factId = must('fact', await P(`/api/brain/spaces/${SPACE}/facts`, { fact: `a lonely claim ${RUN}` }));
    const res = await traverse({ startId: factId, maxDepth: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const start = nodes(res).find(n => n._id === factId);
    assert.ok(start, `the fact start node is missing: ${JSON.stringify(idsOf(res))}`);
    assert.equal(start.depth, 0);
    assert.equal(start.kind, 'fact', 'a caller following `_id` needs to know which collection to look in');
  });
});
