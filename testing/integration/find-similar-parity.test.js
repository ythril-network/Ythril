/**
 * `similar` takes the same parameters through both doors, and they DO something.
 *
 * ## What was wrong
 *
 * The MCP tool has advertised `traverse` and `includeFileContent` since it shipped, and its handler reads both.
 * The REST route read neither. A caller who read the tool schema and switched door got a 400 for a
 * documented parameter — and before the body was made strict, got a 200 with an unexpanded answer, which is
 * worse.
 *
 * Found by a gate comparing every declared surface against the server's allowed sets, not by a report.
 *
 * ## Why these assertions
 *
 * Accepting a parameter and ignoring it is the same defect wearing a 200, so acceptance is not the claim
 * here: the traversed neighbour must actually come back, annotated, with the connecting edge. And the two
 * doors are asked the SAME question in the same fixture, so "parity" is a measured property rather than two
 * schemas that happen to list the same words.
 *
 * ## Seeding
 *
 * Source and match are written through the brain API so they are embedded and `$vectorSearch`-visible. The
 * neighbour is written through the sync endpoint, so it is NOT embedded: it can only be reached structurally,
 * which is what makes its presence proof that traversal ran rather than that similarity was generous.
 *
 * Run: node --test testing/integration/find-similar-parity.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, waitForSimilarityIndex } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `fs-parity-${RUN}`;
const NEIGHBOUR = `fs-neighbour-${RUN}`;

let tokenA;
let sourceId = null;
let matchId = null;
let embeddingAvailable = false;

const token = () => tokenA;

async function syncPostEntity(id, name, seq) {
  const { post: syncPost } = await import('../sync/helpers.js');
  const now = new Date().toISOString();
  await syncPost(INSTANCES.a, token(), `/api/sync/entities?spaceId=${SPACE}`, {
    _id: id, spaceId: SPACE, name, type: 'service', tags: [],
    seq, author: { instanceId: 'test', instanceLabel: 'Test' }, createdAt: now, updatedAt: now,
  });
}

async function syncPostEdge(from, to, label, seq) {
  const { post: syncPost } = await import('../sync/helpers.js');
  const now = new Date().toISOString();
  await syncPost(INSTANCES.a, token(), `/api/sync/edges?spaceId=${SPACE}`, {
    _id: `edge-${from}-${to}-${RUN}`.slice(0, 120), spaceId: SPACE, from, to, label,
    seq, author: { instanceId: 'test', instanceLabel: 'Test' }, createdAt: now, updatedAt: now,
  });
}

const findSimilar = (body) =>
  post(INSTANCES.a, token(), '/api/brain/similar', { space: SPACE, ...(body) });

/** Every nested node in the results' `_graph`, at any depth. */
function allNested(results) {
  const out = [];
  const walk = ns => { for (const n of ns ?? []) { out.push(n); walk(n._graph); } };
  for (const r of results ?? []) walk(r._graph);
  return out;
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

  const created = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `FindSimilar Parity ${RUN}` });
  assert.equal(created.status, 201, `failed to create space: ${JSON.stringify(created.body)}`);

  const { body: statusBody } = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/reindex-status`);
  if (statusBody?.needsReindex) await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/reindex`, {});

  const source = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: `Vault Secret Service ${RUN}`, type: 'service',
    description: 'Vault secret storage service handling authentication token scoping and rotation',
    tags: [], properties: {},
  });
  embeddingAvailable = source.status === 201;
  sourceId = source.body?._id ?? null;

  // Deliberately close in meaning to the source, so it is the similarity match rather than noise.
  const match = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: `Credential Rotation Service ${RUN}`, type: 'service',
    description: 'Secret storage and credential rotation service scoping authentication tokens',
    tags: [], properties: {},
  });
  matchId = match.body?._id ?? null;

  let seq = Date.now();
  await syncPostEntity(NEIGHBOUR, `FS-Neighbour-${RUN}`, seq++);
  // The edge hangs off the MATCH, not the source: traversal expands the results of the similarity search.
  if (matchId) await syncPostEdge(matchId, NEIGHBOUR, 'depends_on', seq++);

  /*
   * `waitForSimilarityIndex`, not `waitForIndexed`. Since 5.0 every recall also scans the newest records
   * straight from the collection, so the recall-based poll returns as soon as the record is WRITTEN —
   * correct for a caller that only needs recall, and a green light that means nothing here, because
   * `find_similar` searches the index and has no such scan. The symptom was an empty `results` in a test
   * whose fixture had "finished waiting".
   */
  if (embeddingAvailable && sourceId && matchId) {
    await waitForSimilarityIndex(INSTANCES.a, token(), SPACE, sourceId, 'entity', matchId);
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('REST find-similar refuses a bad value rather than coercing it', () => {
  it('traverse above the cap is a 400 naming the bound', async () => {
    const r = await findSimilar({ entryId: sourceId, entryType: 'entity', traverse: 6 });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /traverse must be an integer between 0 and \d+/);
  });

  it('a non-integer traverse is a 400', async () => {
    const r = await findSimilar({ entryId: sourceId, entryType: 'entity', traverse: 1.5 });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('a non-boolean includeFileContent is a 400, in recall’s words', async () => {
    // `"false"` is truthy. A flag whose whole purpose is to make a response smaller must not silently do
    // nothing, and the message is recall's verbatim so the two routes cannot disagree about a bad value.
    const r = await findSimilar({ entryId: sourceId, entryType: 'entity', includeFileContent: 'no' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /`includeFileContent` must be a boolean/);
  });
});

describe('REST find-similar traverse actually expands', () => {
  it('traverse: 0 keeps the original response shape', async (t) => {
    if (!embeddingAvailable || !sourceId) return t.skip('embedding unavailable');
    const r = await findSimilar({ entryId: sourceId, entryType: 'entity', topK: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source?._id, sourceId);
    assert.ok(Array.isArray(r.body.results));
    assert.equal(r.body.traverseDepth, undefined, 'an unasked-for traverse must not change the shape');
  });

  it('traverse: 1 nests the unembedded neighbour under the match that reached it', async (t) => {
    if (!embeddingAvailable || !sourceId || !matchId) return t.skip('embedding unavailable');
    const r = await findSimilar({ entryId: sourceId, entryType: 'entity', topK: 5, traverse: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.traverseDepth, 1);
    assert.equal(r.body.count, r.body.results.length, 'count is the matches');

    const match = r.body.results.find(x => x._id === matchId);
    assert.ok(match, `the similarity match must be a result: ${JSON.stringify(r.body.results.map(x => x._id))}`);
    assert.equal(typeof match.score, 'number', 'a match keeps its real similarity score');

    // The neighbour is not embedded, so vector search cannot have found it. Its presence IS the traversal —
    // and it hangs off the match, which is what says WHICH match reached it.
    const n = (match._graph ?? []).find(x => x.node?._id === NEIGHBOUR);
    assert.ok(n, `the neighbour must be nested under the match: ${JSON.stringify((match._graph ?? []).map(x => x.node?._id))}`);
    assert.deepEqual(n.paths[0], [matchId, NEIGHBOUR], 'the route is ids, match first');
    assert.equal(n.paths[0].length - 1, 1, 'hop count is derived from the route');
    assert.equal(n.edge.label, 'depends_on', 'the reaching edge is the whole document, label included');
    assert.ok(!('score' in n), 'a structurally-reached node has no score to report');
    assert.equal(r.body.graphNodes, allNested(r.body.results).length, 'graphNodes counts what came back');
  });
});

describe('both doors answer the same question the same way', () => {
  it('MCP find_similar with traverse reaches the same neighbour', async (t) => {
    if (!embeddingAvailable || !sourceId) return t.skip('embedding unavailable');
    const session = await openMcpSession(token());
    try {
      const res = await session.callTool('similar', {
        space: SPACE, entryId: sourceId, entryType: 'entity', topK: 5, traverse: 1,
      });
      // `callTool` already unwraps the JSON-RPC envelope down to `result`.
      const text = res?.content?.[0]?.text ?? '';
      const parsed = JSON.parse(text);
      assert.equal(parsed.traverseDepth, 1, text.slice(0, 200));
      const nestedIds = allNested(parsed.results).map(x => x.node?._id);
      assert.ok(nestedIds.includes(NEIGHBOUR), `MCP must reach the same neighbour: ${JSON.stringify(nestedIds)}`);
      // The node keys are the contract a caller reads. Both doors ship the same three, from one builder.
      const reached = allNested(parsed.results).find(x => x.node?._id === NEIGHBOUR);
      for (const key of ['edge', 'node', 'paths']) {
        assert.ok(key in reached, `MCP node is missing ${key}, which REST ships`);
      }
      assert.equal(parsed.count, parsed.results.length, 'MCP count is the matches too');
    } finally {
      session.close();
    }
  });
});
