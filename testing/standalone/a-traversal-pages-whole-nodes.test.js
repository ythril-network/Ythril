/**
 * A standalone traversal answers whole nodes in hop order under a byte budget, and `nextSkip` reaches every node
 * (`Q-132`).
 *
 * Owner rule, 2026-09-28, every door. `graph_traverse` and `POST /api/brain/spaces/:id/traverse` cut their node list at
 * `limit` with `truncated` and nothing else — no budget on the size of what came back, no way to continue. Now the
 * walk still stops at `limit` (the caller's cap, reported as `limitReached`), and what it found pages through the same
 * budget every result path uses: whole nodes, each with its edges back to the nodes before it, so every edge arrives
 * exactly once.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-traversal-pages-whole-nodes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageTraversal } from '../../server/dist/brain/traverse-page.js';

// A star of 30 nodes around s, each node carrying a long description so a small budget bites.
const nodes = [{ _id: 's', name: 's', type: 't', depth: 0 },
  ...Array.from({ length: 30 }, (_, i) => ({ _id: `n${i}`, name: `n${i}`, type: 't', depth: 1 + (i % 2), description: 'd'.repeat(300) }))];
const edges = [...nodes.slice(1).map((n, i) => ({ _id: `e${i}`, from: 's', to: n._id, label: 'knows' })),
  { _id: 'loop', from: 's', to: 's', label: 'self' }];
const walk = { nodes, edges, truncated: false };

describe('a traversal pages whole nodes', () => {
  it('a walk that fits comes back whole', async () => {
    const r = await pageTraversal(walk, {}, { budgetChars: 5_000_000 });
    assert.equal(r.ok, true);
    assert.equal(r.body.nodes.length, 31);
    assert.equal(r.body.edges.length, 31);
    assert.equal(r.body.truncated, false);
    assert.equal(r.body.nextSkip, undefined);
  });

  it('nodes come in hop order, and paging reaches every node and every edge exactly once', async () => {
    const seenNodes = []; const seenEdges = [];
    let skip = 0;
    for (let p = 0; p < 50; p++) {
      const r = await pageTraversal(walk, { skip, maxChars: 2_000 }, { budgetChars: 25_000 });
      assert.equal(r.ok, true, r.error);
      seenNodes.push(...r.body.nodes); seenEdges.push(...r.body.edges.map(e => e._id));
      if (!r.body.truncated) break;
      assert.ok(r.body.nextSkip > skip);
      skip = r.body.nextSkip;
    }
    assert.deepEqual(seenNodes.map(n => n._id).sort(), nodes.map(n => n._id).sort(), 'every node, none twice');
    const depths = seenNodes.map(n => n.depth);
    assert.deepEqual(depths, [...depths].sort((a, b) => a - b), 'hop order');
    assert.deepEqual(seenEdges.sort(), edges.map(e => e._id).sort(), 'every edge, exactly once');
  });

  it('the walk cap is reported apart from the page cut', async () => {
    const r = await pageTraversal({ ...walk, truncated: true }, {}, { budgetChars: 5_000_000 });
    assert.equal(r.body.limitReached, true);
    assert.equal(r.body.truncated, true, 'a capped walk is still a partial graph');
    assert.equal(r.body.nextSkip, undefined, 'nothing to page: raise `limit` to walk further');
  });

  it('a bad skip is refused, not floored', async () => {
    const r = await pageTraversal(walk, { skip: -3 }, { budgetChars: 25_000 });
    assert.equal(r.ok, false);
  });
});
