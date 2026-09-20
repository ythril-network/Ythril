/**
 * REST and MCP return the same recall CONTENT, each in its own transport's shape.
 *
 * ## The rule this gates
 *
 * Owner, 2026-08-16, after being shown both responses side by side: *"can we do 2.3 (recursive on _graph
 * ofc) and from 3#a the fields but not the shape? so both deliver exact same content but in a standard way
 * for their transport?"*
 *
 * So the ENVELOPE is allowed to differ and the FIELD SET is not:
 *
 * - REST returns a flat result — record fields beside `score`.
 * - MCP returns `{score, spaceId, type, record: {…}}`.
 * - The union of keys a caller can read must be identical, at the result and at every depth of `_graph`.
 *
 * ## What it was catching
 *
 * `_graph[].node` was the divergence. MCP mapped the entity through an allowlist; REST attached the Mongo
 * document, so a REST caller saw `_expireAt` and every other stored field. Both now go through
 * `graphNodeRecord`, which is why that function moved out of `mcp/tools/shared.ts`: while it lived on the MCP
 * side, "REST returns the same thing" was a promise rather than a mechanism.
 *
 * `_graph[].edge` also carried a full embedding VECTOR on both doors — the traversal was the one query in the
 * codebase fetching edges with no projection — so "the vector is never returned" was very nearly false.
 *
 * ## Exercised, not grepped
 *
 * Both shapes are built by calling the real functions. A grep could only ever check that two files mention
 * the same words.
 *
 * Run: node --test testing/standalone/both-doors-same-recall-content.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mapGraphNodes, graphNodeRecord, toRecallRecord, withoutDiagnostics;
let RECALL_RECORD_DIAGNOSTICS, RECALL_RANKING_DIAGNOSTICS, rankingFields;
before(async () => {
  ({ mapGraphNodes, graphNodeRecord } = await import('../../server/dist/brain/recall-graph.js'));
  ({ toRecallRecord } = await import('../../server/dist/mcp/tools/shared.js'));
  ({
    withoutDiagnostics, RECALL_RECORD_DIAGNOSTICS, RECALL_RANKING_DIAGNOSTICS, rankingFields,
  } = await import('../../server/dist/brain/recall-shape.js'));
});

/** A stored entity with every field the collection carries, including the ones nobody should receive. */
const entityDoc = () => ({
  _id: 'ent-b', spaceId: 'general', name: 'Queue', type: 'service', tags: ['infra'],
  description: 'the embedding job queue', properties: { tier: 'core' },
  createdAt: 'c', updatedAt: 'u',
  seq: 77, embeddingModel: 'm', matchedText: 'Queue service infra',
  embedding: [0.1, 0.2], _expireAt: 'someday',
});

const edgeDoc = () => ({
  _id: 'e1', spaceId: 'general', from: 'a', to: 'b', label: 'depends_on', type: 'technical',
  weight: 0.8, tags: ['infra'], description: 'why', properties: { since: '2026-01' },
  createdAt: 'c', updatedAt: 'u',
  seq: 412, embeddingModel: 'm', matchedText: 'infra a depends_on b',
  embedding: [0.3, 0.4],
});

/** A recall hit as `recall()` hands it back: flat, with every diagnostic present. */
const seed = () => ({
  _id: 'seed-1', spaceId: 'general', type: 'entity', name: 'API', entityType: 'service',
  tags: ['infra'], description: 'the public API', properties: {},
  createdAt: 'c', updatedAt: 'u', score: 0.81,
  lexicalScore: 0.44, fusedScore: 0.72, rerankScore: 0.91,
  seq: 88, embeddingModel: 'm', matchedText: 'API service infra',
});

const tree = () => [{
  edges: [edgeDoc()],
  node: entityDoc(),
  paths: [['seed-1', 'ent-b']],
  _graph: [{ edges: [edgeDoc()], node: entityDoc(), paths: [['seed-1', 'ent-b', 'ent-c']] }],
}];

/** The REST result: the flat hit, diagnostics applied, graph nested through the one implementation. */
const restResult = (diag) => {
  const [r] = withoutDiagnostics([seed()], diag);
  return { ...r, _graph: mapGraphNodes(tree(), graphNodeRecord, diag) };
};

/** The MCP result: envelope plus `record`, same graph. */
const mcpResult = (diag) => ({
  score: seed().score,
  // Unconditional, mirroring the product: the ranking scores left the `includeDiagnostics` bundle
  // because they are the ORDERING, not payload. `rankingFields` has no flag to pass.
  ...rankingFields(seed()),
  spaceId: seed().spaceId,
  type: seed().type,
  record: toRecallRecord(seed(), { includeDiagnostics: diag }),
  _graph: mapGraphNodes(tree(), graphNodeRecord, diag),
});

/** Every key a caller can read off a result, wherever the transport put it. */
const flatKeys = (o) => {
  const keys = new Set(Object.keys(o).filter(k => k !== '_graph' && k !== 'record'));
  for (const k of Object.keys(o.record ?? {})) keys.add(k);
  return keys;
};

for (const diag of [false, true]) {
  describe(`the two doors carry the same content (includeDiagnostics: ${diag})`, () => {
    it('the result-level field set is identical', () => {
      // MCP calls the entity's own type `record.type` and puts the knowledge type on the envelope; REST
      // spells the second one `entityType` beside a `type` that is also the knowledge type. Same two facts,
      // and both doors carry both — so the comparison is over the flattened key set, which is what a caller
      // can actually read, rather than over a nesting they each chose for their own reasons.
      const rest = flatKeys(restResult(diag));
      const mcp = flatKeys(mcpResult(diag));
      rest.delete('entityType'); mcp.delete('entityType');
      const onlyRest = [...rest].filter(k => !mcp.has(k)).sort();
      const onlyMcp = [...mcp].filter(k => !rest.has(k)).sort();
      assert.deepEqual({ onlyRest, onlyMcp }, { onlyRest: [], onlyMcp: [] },
        'one door carries a field the other does not — the envelope may differ, the content may not');
    });

    it('and so does every node at every depth of _graph', () => {
      const walk = (nodes, out = []) => {
        for (const n of nodes ?? []) {
          out.push({ node: Object.keys(n.node).sort(), edge: Object.keys(n.edges[0]).sort() });
          walk(n._graph, out);
        }
        return out;
      };
      const rest = walk(restResult(diag)._graph);
      const mcp = walk(mcpResult(diag)._graph);
      assert.ok(rest.length >= 2, 'the fixture must nest at least two levels or this proves nothing');
      assert.deepEqual(rest, mcp, 'the graph must be identical on both doors, recursively');
    });
  });
}

describe('the default withholds the system fields, everywhere', () => {
  it('no RECORD diagnostic survives at the result level on either door', () => {
    /*
     * THIS SPLIT IN TWO, deliberately. It used to iterate all six bundled fields and require every one absent.
     *
     * The three RANKING scores left that bundle: `score` is not the number that ordered a result once a
     * reranker runs (`rerankScore > fusedScore > score`), so withholding them meant a caller could threshold on
     * a number that did not order the answer while being unable to see the one that did. They are now
     * unconditional on both doors — so requiring their absence would now be requiring the defect.
     *
     * What still must be withheld is the three RECORD fields, and that half is unchanged.
     */
    for (const [door, r] of [['REST', restResult(false)], ['MCP', mcpResult(false)]]) {
      const keys = flatKeys(r);
      for (const f of RECALL_RECORD_DIAGNOSTICS) {
        assert.equal(keys.has(f), false, `${door} still returns \`${f}\` by default`);
      }
    }
  });

  it('and every RANKING score that ran DOES survive, on both doors, unasked', () => {
    // The other half of the split, and the reason for it. A caller must be able to see the number that ordered
    // the result without setting a flag whose purpose is removing cost — three floats are not a cost.
    for (const [door, r] of [['REST', restResult(false)], ['MCP', mcpResult(false)]]) {
      const keys = flatKeys(r);
      for (const f of RECALL_RANKING_DIAGNOSTICS) {
        assert.equal(keys.has(f), true,
          `${door} withholds \`${f}\` by default — that is the ordering, and it is not a diagnostic`);
      }
    }
  });

  it('nor anywhere in _graph, on the node OR the edge, at any depth', () => {
    // The edge is the one that bites: it is the WHOLE document, once per hop, and it carries a
    // `matchedText` of its own. Honouring the flag on the results and not on their neighbourhood would
    // leave the larger half of the saving unmade on a traversing call.
    const check = (nodes, door) => {
      for (const n of nodes ?? []) {
        for (const f of RECALL_RECORD_DIAGNOSTICS) {
          assert.equal(f in n.node, false, `${door}: _graph node still carries \`${f}\``);
          for (const e of n.edges) assert.equal(f in e, false, `${door}: _graph edge still carries \`${f}\``);
        }
        // A ranking score has no meaning on a traversed node and must not appear even though the scores are
        // now unconditional at the RESULT level. A node was never ranked — it is here because the graph
        // relates it to something that was — so a score on one would be a number with nothing behind it.
        for (const f of RECALL_RANKING_DIAGNOSTICS) {
          assert.equal(f in n.node, false, `${door}: _graph node carries \`${f}\`, but it was never ranked`);
          for (const e of n.edges) assert.equal(f in e, false, `${door}: _graph edge carries \`${f}\`, but it was never ranked`);
        }
        check(n._graph, door);
      }
    };
    check(restResult(false)._graph, 'REST');
    check(mcpResult(false)._graph, 'MCP');
  });
});

describe('the vector is never returned, and includeDiagnostics cannot bring it back', () => {
  it('not on a result, on either door, under either setting', () => {
    for (const diag of [false, true]) {
      for (const [door, r] of [['REST', restResult(diag)], ['MCP', mcpResult(diag)]]) {
        assert.equal(flatKeys(r).has('embedding'), false,
          `${door} returned the vector with includeDiagnostics: ${diag}`);
      }
    }
  });

  it('and not on a graph node or edge, at any depth, under either setting', () => {
    // `_graph[].edge` was a real leak: the traversal fetched edges with NO projection, so a
    // `recall(traverse: n)` shipped a float array per hop on both doors. The query now projects it out and
    // this strips it again — a claim that absolute should not rest on one projection being remembered.
    const check = (nodes, label) => {
      for (const n of nodes ?? []) {
        assert.equal('embedding' in n.node, false, `${label}: a graph node carried the vector`);
        for (const e of n.edges) assert.equal('embedding' in e, false, `${label}: a graph edge carried the vector`);
        check(n._graph, label);
      }
    };
    for (const diag of [false, true]) {
      check(restResult(diag)._graph, `REST diag:${diag}`);
      check(mcpResult(diag)._graph, `MCP diag:${diag}`);
    }
  });

  it('nor any other stored bookkeeping field the document happened to carry', () => {
    // `_expireAt` is the TTL stamp. REST used to return it on a graph node purely because it attached the
    // Mongo document; nobody chose that, and an allowlist is what stops the next such field arriving
    // silently.
    const [first] = restResult(false)._graph;
    assert.equal('_expireAt' in first.node, false, 'a graph node still carries the TTL stamp');
  });
});
