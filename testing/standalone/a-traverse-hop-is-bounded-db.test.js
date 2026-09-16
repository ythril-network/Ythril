/**
 * One traverse hop reads a BOUNDED number of edges, and says so when the bound is spent.
 *
 * ## The defect (W-11)
 *
 * `edges.ts` fetched every edge touching the current frontier with `.find(...).toArray()` and no `.limit()`.
 * One hub entity with a hundred thousand edges therefore pulled a hundred thousand documents into memory, per
 * hop, per member space.
 *
 * **And the cap that looks like it prevents that counts something else.** `limit` bounds NODES EMITTED: a
 * neighbour that is not an entity is skipped without counting against it, and a neighbour already visited is
 * skipped too. So `limit` counts hydrated rows and never documents read — which defeats the invariant
 * `graph-spill.ts` states in its own words, *"one hub with a hundred thousand edges would turn a bounded read
 * into an unbounded one"*, one layer below the ceiling that was supposed to hold it.
 *
 * The same rule was missing in BOTH traversals — the standalone walk and recall's seed expansion — which is the
 * defect class this repo produces most. The link-record scan beside them already had it: `linkedRecordsAtFrontier`
 * takes a budget and returns `scanCapped`, and its docblock is where the reasoning below comes from.
 *
 * ## The case that isolates it
 *
 * A hub whose edges all lead to ALREADY VISITED nodes. The node cap never fills, so every other truncation
 * signal stays quiet, while the read pulls the hub's entire edge set and throws all of it away. Before the fix
 * that returned `truncated: false` — a complete-looking answer that had just read the whole hub.
 *
 * That is also why a capped scan must report even when the result is not full: the budget was spent on
 * documents that were discarded, so "the answer did not fill up" says nothing about whether it is complete.
 *
 * ## Why the read must not simply be truncated in silence
 *
 * Owner's ruling P-25: every returned record carries its COMPLETE graph, and a subtree is never trimmed —
 * *"a cost the caller can see is a different thing from one they cannot"*. So the bound is paired with the
 * `truncated` flag the result already carries, exactly as the link scan pairs its budget with `scanCapped`.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-traverse-hop-is-bounded-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-hop-bound-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const HUB = 'aaaaaaaa-0000-4000-8000-000000000001';
const START = 'aaaaaaaa-0000-4000-8000-000000000002';

let mongo, edgesMod;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const src = (p) => stripComments(fs.readFileSync(p, 'utf8'));

const entity = (id, name) => ({ _id: id, spaceId: SPACE, name, type: 'thing', tags: [], seq: 1 });
const edge = (id, from, to) => ({ _id: id, spaceId: SPACE, from, to, label: 'rel', tags: [], seq: 1 });

describe('a traverse hop is bounded', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('hopbound');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'hop-bound-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    edgesMod = await import('../../server/dist/brain/edges.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'files']) await coll(c).deleteMany({});
  });

  it('the module is the one this gate thinks it is', () => {
    // Floors everything below: a renamed export would make each case throw rather than assert.
    assert.equal(typeof edgesMod.traverseGraph, 'function');
  });

  it('a hub whose edges all lead back to visited nodes REPORTS truncation', async () => {
    /*
     * The isolating case. Depth 1 reaches the hub; depth 2 reads the hub's 200 edges and every one of them
     * points at a node already visited, so nothing new is emitted and the node cap never fills.
     *
     * Before the bound this answered `truncated: false` having read all 200 — a complete-looking result that
     * had just pulled the whole hub into memory. It is the shape that scales: the flag stays quiet precisely
     * when the read is largest, because a hub's edges mostly lead back where you came from.
     */
    await coll('entities').insertMany([entity(START, 'start'), entity(HUB, 'hub')]);
    await coll('edges').insertOne(edge('e-start', START, HUB));
    await coll('edges').insertMany(
      Array.from({ length: 200 }, (_, i) => edge(`e-back-${i}`, HUB, START)),
    );

    const res = await edgesMod.traverseGraph([SPACE], START, 'both', undefined, 2, 5, false, false, false);
    assert.equal(res.truncated, true,
      'the hop read more edges than its budget and reported a complete graph — the bound is not being applied '
      + 'or not being reported');
    assert.ok(res.nodes.length <= 5, `the node cap was exceeded: ${res.nodes.length}`);
  });

  it('a small graph inside the budget is NOT reported as truncated', async () => {
    /*
     * The control, and the one that stops the fix being "always say truncated". A flag that is always set is
     * the same as no flag: `graph-spill.ts` decides whether to spill on it, so a permanently-true flag would
     * make every recall pay for a spill it does not need.
     */
    await coll('entities').insertMany([entity(START, 'start'), entity(HUB, 'hub')]);
    await coll('edges').insertOne(edge('e-only', START, HUB));

    const res = await edgesMod.traverseGraph([SPACE], START, 'both', undefined, 2, 50, false, false, false);
    assert.equal(res.truncated, false, 'a graph well inside every budget was reported as truncated');
    // The START node is NOT in `nodes` — the walk returns what it REACHED, and the caller already has the node
    // it asked from. Measured rather than assumed: the first draft of this case expected two and got one.
    assert.deepEqual(res.nodes.map(n => n._id), [HUB]);
  });

  it('the walk still returns what it found when a hop is capped', async () => {
    // A bound that discards the hop's work would be worse than no bound: the caller pays the read and gets
    // nothing for it. The link scan states the same rule — the records it read belong in the answer.
    await coll('entities').insertMany([
      entity(START, 'start'), entity(HUB, 'hub'),
      ...Array.from({ length: 30 }, (_, i) => entity(`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, `n${i}`)),
    ]);
    await coll('edges').insertOne(edge('e-start', START, HUB));
    await coll('edges').insertMany(Array.from({ length: 30 }, (_, i) =>
      edge(`e-out-${i}`, HUB, `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`)));

    const res = await edgesMod.traverseGraph([SPACE], START, 'both', undefined, 2, 6, false, false, false);
    assert.equal(res.truncated, true);
    assert.ok(res.nodes.length >= 2, 'the hop threw away what it had read');
    assert.ok(res.nodes.some(n => n._id === HUB), 'the hub itself is missing from a walk that reached it');
  });
});

describe('both traversals bound the read, not just one', () => {
  it('neither edge read is an unbounded toArray', () => {
    /*
     * Two implementations of one rule is the defect class this repo produces most, and these two have drifted
     * before: recall's expansion followed every edge both ways while the standalone walk applied the direction,
     * twenty lines apart. `frontierEdgeQuery` was extracted for exactly that reason — and the BOUND is the same
     * kind of rule, so it is asserted on both rather than on whichever one was in hand.
     *
     * Asserted structurally because "documents read" is not observable from outside: the behavioural cases above
     * pin the reporting, and this pins that the other path cannot quietly lack it.
     */
    for (const f of ['server/src/brain/edges.ts', 'server/src/brain/recall-seed-traversal.ts']) {
      const s = src(f);
      const at = s.indexOf('frontierEdgeQuery(');
      assert.ok(at > 0, `${f} no longer builds a frontier edge query — re-anchor this gate`);
      // The window is the statement: from the query builder to the `toArray()` that ends the call chain.
      const stmt = s.slice(at, s.indexOf('toArray()', at));
      assert.match(stmt, /\.limit\(/,
        `${f} reads every edge touching the frontier with no limit — one hub turns a bounded walk into an `
        + 'unbounded read, and the node cap cannot help because it counts hydrated rows');
    }
  });
});
