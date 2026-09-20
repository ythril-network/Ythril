/**
 * Traversal nests under the seed that reached it, and `paths` records every route.
 *
 * The flat list this replaces put every neighbour beside the seeds with `score: null`. `nestNeighbours` is the
 * pure half of the rebuild — the BFS is not — so the shape a caller depends on is asserted here without a
 * database, and the database tests are free to be about traversal rather than about shape.
 *
 * ## What each assertion is defending
 *
 * - `count` must mean MATCHES. They asked for `topK: 1` and got `count: 6`.
 * - With two seeds, the tree must say which one reached a node, without the caller intersecting edge ends.
 * - A node reachable two ways must appear ONCE, with both routes, per the owner's ruling — duplicating it
 *   makes a caller counting rows double-count the same record.
 * - `paths[0]` is the nesting route, so `paths[0].length - 1` is the hop count and direction is implicit.
 *
 * Run: node --test testing/standalone/recall-graph-nesting.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { nestNeighbours, mapGraphNodes } = await import('../../server/dist/brain/recall-graph.js');

const edge = (from, to, label = 'depends_on') => ({
  _id: `e-${from}-${to}`, from, to, label, spaceId: 's',
  description: `${from} ${label} ${to}`, tags: ['t'], createdAt: '2026-08-13T00:00:00.000Z',
});

/** A neighbour as `traverseFromSeeds` emits it. */
const hop = (id, parentId, idPath, altPaths = [], truncated = false) => ({
  _id: id, spaceId: 's', hops: idPath.length - 1, path: [], record: { _id: id, name: id, type: 'service' },
  parentId, edges: [edge(parentId, id)], idPath, altPaths, altPathsTruncated: truncated,
});

describe('one seed, one chain', () => {
  const { bySeed, nodes } = nestNeighbours([
    hop('B', 'A', ['A', 'B']),
    hop('C', 'B', ['A', 'B', 'C']),
  ], ['A']);

  it('the chain is a tree, not a list', () => {
    const [b] = bySeed.get('A');
    assert.equal(b.node._id, 'B');
    assert.equal(b._graph.length, 1);
    assert.equal(b._graph[0].node._id, 'C');
  });

  it('hop count is derived from the path rather than carried', () => {
    const [b] = bySeed.get('A');
    assert.equal(b.paths[0].length - 1, 1);
    assert.equal(b._graph[0].paths[0].length - 1, 2);
  });

  it('a leaf has no `_graph` key at all', () => {
    // Absent rather than `[]`: an empty array on every leaf is noise, and a caller checking `if (n._graph)`
    // reads the same either way.
    const c = bySeed.get('A')[0]._graph[0];
    assert.ok(!('_graph' in c), 'a leaf must not carry an empty children array');
  });

  it('the node count is the traversed nodes, and the seed is not one of them', () => {
    assert.equal(nodes, 2);
  });

  it('the edge is the whole document, not {from,label,to}', () => {
    // The reason for a link lives in the edge description on the board this was reported from.
    const [b] = bySeed.get('A');
    assert.equal(b.edges.length, 1, 'one hop, one edge — the list is plural, not always many');
    assert.equal(b.edges[0].description, 'A depends_on B');
    assert.deepEqual(b.edges[0].tags, ['t']);
    assert.ok(b.edges[0].createdAt, 'createdAt was dropped by the three-field reduction too');
  });
});

describe('two seeds', () => {
  const { bySeed } = nestNeighbours([
    hop('X', 'A', ['A', 'X']),
    hop('Y', 'B', ['B', 'Y']),
  ], ['A', 'B']);

  it('each node hangs off the seed that reached it', () => {
    assert.deepEqual(bySeed.get('A').map(n => n.node._id), ['X']);
    assert.deepEqual(bySeed.get('B').map(n => n.node._id), ['Y']);
  });

  it('a seed that reached nothing is absent rather than empty', () => {
    const { bySeed: b2 } = nestNeighbours([hop('X', 'A', ['A', 'X'])], ['A', 'B']);
    assert.ok(!b2.has('B'));
  });
});

describe('a node reachable more than one way', () => {
  // The diamond: A→B→D and A→C→D. D is nested once, under the route that reached it first.
  const { bySeed, nodes } = nestNeighbours([
    hop('B', 'A', ['A', 'B']),
    hop('C', 'A', ['A', 'C']),
    hop('D', 'B', ['A', 'B', 'D'], [['A', 'C', 'D']]),
  ], ['A']);

  it('appears exactly ONCE in the whole tree', () => {
    const seen = [];
    const walk = ns => { for (const n of ns ?? []) { seen.push(n.node._id); walk(n._graph); } };
    walk(bySeed.get('A'));
    assert.deepEqual(seen.filter(id => id === 'D').length, 1, `D appears ${seen.filter(i => i === 'D').length} times`);
    assert.equal(nodes, 3);
  });

  it('records BOTH routes, nesting route first', () => {
    const d = bySeed.get('A').find(n => n.node._id === 'B')._graph[0];
    assert.deepEqual(d.paths, [['A', 'B', 'D'], ['A', 'C', 'D']]);
  });

  it('says so when routes were dropped', () => {
    const { bySeed: b } = nestNeighbours([hop('B', 'A', ['A', 'B'], [], true)], ['A']);
    assert.equal(b.get('A')[0].pathsTruncated, true);
    // And stays quiet when nothing was dropped — a flag present on every node is a flag nobody reads.
    const { bySeed: c } = nestNeighbours([hop('B', 'A', ['A', 'B'])], ['A']);
    assert.ok(!('pathsTruncated' in c.get('A')[0]));
  });
});

describe('the node limit cannot delete a relationship', () => {
  it('a child whose parent was cut still hangs off its seed, with its real route', () => {
    // The limit truncates the flat list, so a deep node can arrive with no parent in it. Discarding it would
    // let a cap silently remove a record the caller can see a route to.
    const { bySeed } = nestNeighbours([hop('D', 'B', ['A', 'B', 'D'])], ['A']);
    const [d] = bySeed.get('A');
    assert.equal(d.node._id, 'D');
    assert.deepEqual(d.paths[0], ['A', 'B', 'D'], 'the route still names the parent that was cut');
  });
});

describe('order does not matter', () => {
  it('a deeper node listed BEFORE its parent still nests', () => {
    // `traverseRecallSeeds` sorts by hops, but this function must not depend on its caller for correctness.
    const { bySeed } = nestNeighbours([
      hop('C', 'B', ['A', 'B', 'C']),
      hop('B', 'A', ['A', 'B']),
    ], ['A']);
    assert.equal(bySeed.get('A')[0].node._id, 'B');
    assert.equal(bySeed.get('A')[0]._graph[0].node._id, 'C');
  });
});

describe('an edge says which way it runs instead of repeating two ids it already stated', () => {
  /*
   * `Q-24`. Every edge in one entry joins the SAME pair — this node and the one it is nested under — so
   * `from` and `to` were two UUIDs per edge restating `node._id` and `paths[0]`. What is left is the
   * orientation.
   *
   * Asserted here rather than only over the wire because this is the pure half: `mapGraphNodes` is the ONE
   * nesting implementation both doors map their tree through, so a case here covers REST and MCP at once
   * and can be mutated without rebuilding an image.
   */
  const through = (flat, seeds) => mapGraphNodes([...nestNeighbours(flat, seeds).bySeed.values()][0], x => x);

  it('drops `from` and `to`, and says `outbound` when the edge runs parent to node', () => {
    const [b] = through([hop('B', 'A', ['A', 'B'])], ['A']);
    assert.equal('from' in b.edges[0], false, 'the endpoint ids are still being repeated per edge');
    assert.equal('to' in b.edges[0], false);
    assert.equal(b.edges[0].direction, 'outbound');
  });

  it('says `inbound` when it runs the other way, which is the bit that is NOT derivable', () => {
    // The whole justification for dropping the ids is that everything except this can be read off the
    // entry. If direction were wrong the saving would be a loss of information rather than of bytes.
    const n = hop('B', 'A', ['A', 'B']);
    n.edges = [edge('B', 'A')];
    const [b] = through([n], ['A']);
    assert.equal(b.edges[0].direction, 'inbound');
  });

  it('says `self` for a record joined to itself, which has no second end', () => {
    const n = hop('A', 'A', ['A', 'A']);
    n.edges = [edge('A', 'A', 'conditional')];
    const [a] = through([n], ['A']);
    assert.equal(a.edges[0].direction, 'self',
      'oriented against the node, a loop would otherwise read as outbound and claim a parent it has not got');
  });

  it('keeps everything else of the document, because that half was never the cost', () => {
    const [b] = through([hop('B', 'A', ['A', 'B'])], ['A']);
    assert.equal(b.edges[0].description, 'A depends_on B');
    assert.deepEqual(b.edges[0].tags, ['t']);
    assert.ok(b.edges[0]._id, 'the id still names both ends for anyone who wants them');
  });

  it('and the far end is where the doc says it is', () => {
    // The promise the ids were dropped on. If this is wrong the field is not a saving, it is a deletion.
    const [b] = through([hop('B', 'A', ['A', 'B'])], ['A']);
    assert.equal(b.paths[0][b.paths[0].length - 2], 'A');
    assert.equal(b.node._id, 'B');
  });
});
