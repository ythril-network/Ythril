/**
 * A graph walk can return the records it reached, not only their names (`F-32`).
 *
 * Owner, 2026-09-23, reading a three-call recipe for fetching one flow from the `flows` space — a traverse,
 * then a `filter` over the ids it returned for the bodies, then another over the edges for their conditions:
 * *"is that not just an includes flag?"* It should have been. `recall`'s own traverse already applies a
 * `projection` to every node and every edge at every depth, so `graph_traverse` lacking one was the second
 * traversal door missing a parameter the first one has.
 *
 * What must hold:
 *  - ABSENT projection → the lean answer, byte for byte. Nobody who does not ask pays for bodies.
 *  - The walk's own envelope survives any projection: `_id`, `depth` and `kind` on a node; `_id`, `from`, `to`
 *    and `label` on an edge. A projection that could remove `from` would make the edge list unreadable.
 *  - The vector never comes back, and the diagnostics stay behind `includeDiagnostics`, as on every read door.
 *  - A link-derived edge has no stored document and is returned as it was.
 *  - Both doors take it — the MCP tool and the REST route — with the same field name.
 *
 * Run: node --test testing/standalone/a-traverse-can-return-bodies.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let shapeTraverseBodies, normaliseProjection;
before(async () => {
  ({ shapeTraverseBodies } = await import('../../server/dist/brain/traverse-bodies.js'));
  ({ normaliseProjection } = await import('../../server/dist/brain/projection.js'));
});

const lean = () => ({
  nodes: [
    { _id: 'e1', name: 'flow-a', type: 'Flow', depth: 0 },
    { _id: 'c1', name: 'an event', type: 'event', depth: 1, kind: 'chrono' },
  ],
  edges: [
    { _id: 'x1', from: 'e1', to: 'c1', label: 'contains' },
    { _id: 'link:chrono:e1:c1', from: 'e1', to: 'c1', label: 'about' },
  ],
  truncated: false,
});

const docs = new Map([
  ['e1', { _id: 'e1', name: 'flow-a', type: 'Flow', description: 'the flow', properties: { a: 1 },
    embedding: [0.1, 0.2], matchedText: 'm', embeddingModel: 'x', seq: 7, createdAt: '2026-01-01' }],
  ['c1', { _id: 'c1', title: 'an event', type: 'event', description: 'what happened', embedding: [0.3] }],
]);
const edgeDocs = new Map([
  ['x1', { _id: 'x1', from: 'e1', to: 'c1', label: 'contains', properties: { parallel: false },
    embedding: [0.4], matchedText: 'e', createdAt: '2026-01-01' }],
]);

describe('graph_traverse projection', () => {
  it('no projection → the lean answer, unchanged', () => {
    const out = shapeTraverseBodies(lean(), docs, edgeDocs, undefined, false);
    assert.deepEqual(out, lean());
  });

  it('an inclusion projection returns the bodies, and keeps the walk envelope', () => {
    const p = normaliseProjection({ description: 1, properties: 1 });
    const out = shapeTraverseBodies(lean(), docs, edgeDocs, p, false);
    assert.deepEqual(out.nodes[0], { _id: 'e1', depth: 0, description: 'the flow', properties: { a: 1 } });
    assert.deepEqual(out.nodes[1], { _id: 'c1', depth: 1, kind: 'chrono', description: 'what happened' });
    assert.deepEqual(out.edges[0], { _id: 'x1', from: 'e1', to: 'c1', label: 'contains', properties: { parallel: false } });
  });

  it('never the vector, and diagnostics only on request', () => {
    const p = normaliseProjection({ createdAt: 0 });
    const out = shapeTraverseBodies(lean(), docs, edgeDocs, p, false);
    for (const r of [...out.nodes, ...out.edges]) {
      assert.equal(r.embedding, undefined, `${r._id} carries the vector`);
      assert.equal(r.matchedText, undefined, `${r._id} carries matchedText without includeDiagnostics`);
      assert.equal(r.createdAt, undefined, `${r._id} ignored the exclusion`);
    }
    const withDiag = shapeTraverseBodies(lean(), docs, edgeDocs, p, true);
    assert.equal(withDiag.nodes[0].matchedText, 'm', 'includeDiagnostics must restore the diagnostics');
    assert.equal(withDiag.nodes[0].embedding, undefined, 'includeDiagnostics must never restore the vector');
  });

  it('a link-derived edge, and a node whose record vanished, come back as they were', () => {
    const p = normaliseProjection({ description: 1 });
    const out = shapeTraverseBodies(lean(), new Map([['e1', docs.get('e1')]]), edgeDocs, p, false);
    assert.deepEqual(out.edges[1], lean().edges[1]);
    assert.deepEqual(out.nodes[1], lean().nodes[1], 'a node with no stored body keeps its lean shape');
  });

  it('the envelope survives a projection that tries to drop it', () => {
    const p = normaliseProjection({ from: 0, to: 0, label: 0, depth: 0 });
    const out = shapeTraverseBodies(lean(), docs, edgeDocs, p, false);
    assert.equal(out.edges[0].from, 'e1');
    assert.equal(out.edges[0].label, 'contains');
    assert.equal(out.nodes[0].depth, 0);
  });
});

describe('both doors take it', () => {
  const tool = stripComments(readFileSync('server/src/mcp/tools/edge.ts', 'utf8'));
  const route = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
  const tIdx = tool.indexOf("name: 'graph_traverse'");
  const toolBody = tool.slice(tIdx, tool.indexOf('export const', tIdx + 10));

  it('the MCP tool declares and uses projection', () => {
    assert.match(toolBody, /projection:\s*\{/, 'graph_traverse must declare `projection` in its inputSchema');
    assert.match(toolBody, /withTraverseBodies\(/, 'graph_traverse must hand its answer to withTraverseBodies');
  });

  it('the REST route accepts and uses projection', () => {
    const r = route.slice(route.indexOf("'/spaces/:spaceId/traverse'"));
    const routeBody = r.slice(0, r.indexOf('\n});'));
    assert.match(routeBody, /withTraverseBodies\(/, 'the REST traverse must hand its answer to withTraverseBodies');
  });
});
