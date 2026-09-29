/**
 * `recall` takes a projection, it means the same thing as `query`'s, and it reaches `_graph`.
 *
 * ## X-8, and the measurement behind it
 *
 * The canary operator, 2026-08-16T1358Z: with no projection on recall, a board sweep asking for fifteen names,
 * a `from`, a `kind` and a `status` returned **100,547 characters**. The data they wanted was about 1.5 KB.
 * Their client refused the response and spilled it to disk. `includeFileContent: false` reads like the answer and
 * is not — it is scoped to file chunks, so on an entity search it changes nothing, and that gap between what
 * the parameter sounds like and what it covers cost them a call to find out.
 *
 * ## What is gated, and why each one
 *
 * The interesting risk is not that a projection fails to work. It is that there are now TWO appliers — a
 * Mongo projection for `query` and an in-memory one for `recall` — and they can disagree about what a
 * projection MEANS. Both derive from `normaliseProjection`, and these assertions are mostly about that
 * agreement holding.
 *
 * The rules, each with the failure it prevents:
 *
 *  - **The vector can never be projected back in.** An explicit `embedding: 1` is dropped, not honoured. The
 *    claim "the vector is never returned by anything" is stated on both doors and in three guide pages, and
 *    a projection is the one parameter that could make it false.
 *  - **It reaches `_graph`, recursively, on nodes AND edges.** A lever that trims the top-level results while
 *    a traverse answer keeps returning whole documents stops working exactly where the response is largest.
 *    `includeDiagnostics` had to be fixed for this in the same release; the same mistake twice would be
 *    careless rather than unlucky.
 *  - **The envelope survives on REST.** A flat result merges the record and the ranking envelope, so
 *    projecting `{name: 1}` without protection drops the `score` the search was for.
 *  - **Both doors accept it.** One rule, two surfaces.
 *
 * Run: node --test testing/standalone/recall-projection-both-doors.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { routeBody, delegatesCleanly } from './_delegating-routes.mjs';
import { readFileSync } from 'node:fs';
import { MCP_SEARCH_FAMILY, doorSources } from '../_shared/search-doors.mjs';

let normaliseProjection, applyProjection, toMongoProjection, NEVER_PROJECTABLE;
let mapGraphNodes, graphNodeRecord, mergeEmbeddingExclusion;
before(async () => {
  ({ normaliseProjection, applyProjection, toMongoProjection, NEVER_PROJECTABLE } =
    await import('../../server/dist/brain/projection.js'));
  ({ mapGraphNodes, graphNodeRecord } = await import('../../server/dist/brain/recall-graph.js'));
  ({ mergeEmbeddingExclusion } = await import('../../server/dist/brain/query.js'));
});

const record = () => ({
  _id: 'r1', spaceId: 'general', name: 'API', type: 'service', tags: ['infra'],
  description: 'a long prose body, which is the whole point of projecting it away',
  properties: { status: 'open', owner: 'platform' },
  createdAt: 'c', updatedAt: 'u', embedding: [0.1, 0.2], _expireAt: 'someday',
});

describe('the grammar means one thing, whichever door reads it', () => {
  it('an inclusion projection keeps only what was named, plus _id', () => {
    const out = applyProjection(record(), normaliseProjection({ name: 1, 'properties.status': 1 }));
    assert.deepEqual(out, { _id: 'r1', name: 'API', properties: { status: 'open' } });
  });

  it('`_id: 0` drops it, in inclusion mode', () => {
    const out = applyProjection(record(), normaliseProjection({ name: 1, _id: 0 }));
    assert.deepEqual(out, { name: 'API' });
  });

  it('an exclusion projection drops only what was named, dotted paths included', () => {
    const out = applyProjection(record(), normaliseProjection({ description: 0, 'properties.owner': 0 }));
    assert.equal('description' in out, false);
    assert.deepEqual(out.properties, { status: 'open' });
    assert.equal(out.name, 'API', 'everything unnamed survives an exclusion projection');
  });

  it('an absent path is absent, not null — the same as Mongo', () => {
    const out = applyProjection(record(), normaliseProjection({ 'properties.nope': 1 }));
    assert.deepEqual(out, { _id: 'r1' }, 'asking for a field a record lacks is not an error and yields nothing');
  });

  it('and the Mongo form is derived from the same reading', () => {
    // `query` still hands a projection to the driver. If the two forms came from separate parsings they
    // could disagree about the mode or about `_id`, on the same caller input.
    assert.deepEqual(mergeEmbeddingExclusion({ name: 1, 'properties.status': 1 }),
      { name: 1, 'properties.status': 1 });
    assert.deepEqual(mergeEmbeddingExclusion({ description: 0 }), { description: 0, embedding: 0 });
    assert.deepEqual(mergeEmbeddingExclusion(), { embedding: 0 });
    assert.deepEqual(toMongoProjection(normaliseProjection({ name: 1, _id: 0 })), { name: 1, _id: 0 });
  });

  it('an omitted projection is not an empty one', () => {
    // An empty inclusion projection would return records holding only `_id`. That is not what an absent
    // parameter means, and conflating them would make every unprojected recall useless.
    assert.equal(normaliseProjection(undefined), undefined);
    assert.equal(normaliseProjection({}), undefined);
    const out = applyProjection(record(), undefined);
    assert.equal(out.description, record().description, 'no projection returns the record');
  });
});

describe('the vector can never be projected back in', () => {
  it('an explicit `embedding: 1` is dropped rather than honoured', () => {
    const out = applyProjection(record(), normaliseProjection({ name: 1, [NEVER_PROJECTABLE]: 1 }));
    assert.equal(NEVER_PROJECTABLE in out, false,
      'a projection is the one parameter that could falsify "the vector is never returned"');
    assert.deepEqual(out, { _id: 'r1', name: 'API' });
  });

  it('and it goes even when no projection was sent at all', () => {
    assert.equal(NEVER_PROJECTABLE in applyProjection(record(), undefined), false);
  });

  it('the Mongo form strips it from an inclusion projection too', () => {
    assert.equal('embedding' in mergeEmbeddingExclusion({ name: 1, embedding: 1 }), false);
  });
});

describe('it reaches _graph, at every depth, on nodes AND edges', () => {
  const tree = () => {
    const node = { ...record(), _id: 'n1', name: 'Queue' };
    const edge = {
      _id: 'e1', spaceId: 'general', from: 'a', to: 'b', label: 'depends_on',
      description: 'a long edge body', properties: { since: '2026-01' }, embedding: [0.3],
    };
    // Two edges on the outer hop, because `edges` is plural and a projection that only reached the first
    // would be the same defect one level down from the one that made the field plural.
    const second = { ...edge, _id: 'e2', label: 'triggers' };
    return [{ edges: [edge, second], node, paths: [['r1', 'n1']],
      _graph: [{ edges: [edge], node, paths: [['r1', 'n1', 'n2']] }] }];
  };

  it('a projection trims every node and every edge, recursively', () => {
    const norm = normaliseProjection({ name: 1, label: 1 });
    const out = mapGraphNodes(tree(), graphNodeRecord, false, norm);
    const walk = (nodes, seen = []) => {
      for (const n of nodes ?? []) { seen.push(n); walk(n._graph, seen); }
      return seen;
    };
    const all = walk(out);
    assert.ok(all.length >= 2, 'the fixture must nest, or this proves nothing about recursion');
    for (const n of all) {
      assert.deepEqual(Object.keys(n.node).sort(), ['_id', 'name'],
        'a traversed node kept a field the projection did not name');
      for (const e of n.edges) {
        assert.deepEqual(Object.keys(e).sort(), ['_id', 'label'],
          'an EDGE is a whole document and there may be several — it is where a traverse answer gets large');
      }
    }
  });

  it('and the vector is gone from the graph under a projection that asked for it', () => {
    const out = mapGraphNodes(tree(), graphNodeRecord, true, normaliseProjection({ name: 1, embedding: 1 }));
    assert.equal('embedding' in out[0].node, false);
    assert.equal('embedding' in out[0].edges[0], false);
  });

  it('no projection leaves the tree as it was', () => {
    const out = mapGraphNodes(tree(), graphNodeRecord, false, undefined);
    assert.ok(out[0].node.name, 'the walk still returns nodes when nothing was projected');
  });
});

describe('both doors take it, and the REST envelope survives', () => {
  const rest = readFileSync('server/src/api/brain/search.ts', 'utf8');
  // Both MCP sources: `recall` still lives in `search.ts` and `filter` has its own file, and this
  // case is about every door that parses a projection.
  const mcp = doorSources(MCP_SEARCH_FAMILY).join('\n');

  it('no REST search route reads the projection itself: each answers through its tool', () => {
    /*
     * This asked that every route still reading a body parse the projection through one parser, with a floor that
     * shrank as routes collapsed onto `callTool` — `/recall`, then `/filter` at 3c, then `/similar` at Q-89. The
     * floor reaching zero is the rule succeeding: a route that answers through its tool cannot disagree with it
     * about what a projection means, so the claim is now that none builds its own answer.
     */
    const readers = ['/recall', '/similar']
      .filter(p => { const b = routeBody(rest, p); assert.ok(b, `${p} not found in search.ts`); return !delegatesCleanly(b, `POST ${p}`); });
    assert.deepEqual(readers, [], `these REST search routes build their own response instead of the tool's: ${readers.join(', ')}`);
    assert.doesNotMatch(rest, /projectionFromBody\(/, 'a REST route parses a projection itself again');
  });

  it('MCP advertises it on all three tools and reads it in both new handlers', () => {
    // THREE, not two: `query` has advertised a projection since it shipped, and recall and find_similar are
    // the two that gained one. The number is spelled out with its reason because a bare count is the kind of
    // assertion that gets "fixed" by changing the number when a fourth tool legitimately gains one.
    assert.equal((mcp.match(/projection: \{/g) ?? []).length, 3,
      'expected query (long-standing) plus recall and find_similar (new) to each advertise a projection');
    assert.equal((mcp.match(/normaliseProjection\(a\['projection'\]/g) ?? []).length, 2,
      'recall and find_similar must each READ it — query builds a Mongo projection instead, in the route');
  });

  it('no door needs a list of envelope keys, because the envelope is outside `record` on both', () => {
    // REST returned flat hits, so it kept a list of the keys a projection must not drop. Since Q-89 both searches
    // answer REST through their tools, and the hit is `{score, spaceId, type, record}` on both doors.
    // The projection is applied to `toRecallRecord(...)`, and `score`/`spaceId` sit beside it untouched. This asserts the application point rather than the absence of a list. Since Q-90
    // the record-meta rule wraps it, in the one builder every recall and similar row goes through.
    assert.match(mcp, /record: stripRecordMeta\(applyProjection\(toRecallRecord\(/,
      'the projection must apply to the record, not to the result envelope');
  });
});
