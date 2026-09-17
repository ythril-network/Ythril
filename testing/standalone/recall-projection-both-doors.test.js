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

let normaliseProjection, applyProjection, toMongoProjection, NEVER_PROJECTABLE;
let mapGraphNodes, graphNodeRecord, RECALL_ENVELOPE_KEYS, mergeEmbeddingExclusion;
before(async () => {
  ({ normaliseProjection, applyProjection, toMongoProjection, NEVER_PROJECTABLE } =
    await import('../../server/dist/brain/projection.js'));
  ({ mapGraphNodes, graphNodeRecord } = await import('../../server/dist/brain/recall-graph.js'));
  ({ RECALL_ENVELOPE_KEYS } = await import('../../server/dist/brain/recall-shape.js'));
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
    return [{ edge, node, paths: [['r1', 'n1']], _graph: [{ edge, node, paths: [['r1', 'n1', 'n2']] }] }];
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
      assert.deepEqual(Object.keys(n.edge).sort(), ['_id', 'label'],
        'the EDGE is the whole document once per hop — it is where a traverse answer gets large');
    }
  });

  it('and the vector is gone from the graph under a projection that asked for it', () => {
    const out = mapGraphNodes(tree(), graphNodeRecord, true, normaliseProjection({ name: 1, embedding: 1 }));
    assert.equal('embedding' in out[0].node, false);
    assert.equal('embedding' in out[0].edge, false);
  });

  it('no projection leaves the tree as it was', () => {
    const out = mapGraphNodes(tree(), graphNodeRecord, false, undefined);
    assert.ok(out[0].node.name, 'the walk still returns nodes when nothing was projected');
  });
});

describe('both doors take it, and the REST envelope survives', () => {
  const rest = readFileSync('server/src/api/brain/search.ts', 'utf8');
  const mcp = readFileSync('server/src/mcp/tools/search.ts', 'utf8');

  it('every REST route that still reads a body parses the projection through one parser', () => {
    /*
     * The count was `>= 3` — recall, find-similar and query — and `POST /api/brain/recall` stopped reading
     * its body at all when it collapsed onto `callTool`. So the floor comes from how many of those routes
     * still build their own response, which is the question the claim was always making.
     *
     * The rule is unchanged and is the point: whoever DOES read a projection reads it through the shared
     * parser. Two doors inlining the same check is how they start disagreeing about what a projection means.
     */
    const readers = ['/recall', '/similar', '/filter']
      .filter(p => { const b = routeBody(rest, p); return b && !delegatesCleanly(b, `POST ${p}`); });
    assert.ok(readers.length >= 2,
      `only ${readers.length} REST read routes still build their own response — the scan is broken, not the code`);
    assert.ok((rest.match(/projectionFromBody\(/g) ?? []).length >= readers.length,
      `${readers.length} route(s) read a body and fewer parse the projection through the shared parser `
      + '— an inlined check is how the two doors start disagreeing about what a projection means');
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

  it('the envelope keys are named, so a projection cannot drop the score', () => {
    // A flat REST result merges the record and the ranking envelope. Without this list, `{name: 1}` would
    // return a record with no score — the one field the search existed to produce.
    for (const k of ['score', 'spaceId', 'type', '_graph']) {
      assert.ok(RECALL_ENVELOPE_KEYS.includes(k), `${k} must survive a projection on the flat REST shape`);
    }
  });

  it('and MCP needs no such list, because its envelope is already outside `record`', () => {
    // Same rule, two shapes: the projection is applied to `toRecallRecord(...)` there, and `score`/`spaceId`
    // sit beside it untouched. This asserts the application point rather than the absence of a list.
    assert.match(mcp, /record: applyProjection\(toRecallRecord\(/,
      'the projection must apply to the record, not to the result envelope');
  });
});
