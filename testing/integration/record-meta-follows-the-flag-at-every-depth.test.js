/**
 * `includeRecordMeta` decides the record's bookkeeping at every depth, on every search door (`Q-90`).
 *
 * `recall-record-meta.ts` promises the rule is recursive: `createdAt`/`updatedAt` and empty `tags`/`properties` are
 * dropped unless asked for, on the match and on every node of its graph. The traversed recall branch never applied it,
 * so with `traverse > 0` every match and every neighbour carried them whatever the flag said; and `similar` took no
 * such flag at all, so its hits always carried them.
 *
 * Run: node --test testing/integration/record-meta-follows-the-flag-at-every-depth.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, delWithBody, waitForSimilarityIndex } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `q90-${RUN}`;

let admin, mcp, adaId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const s = await post(INSTANCES.a, admin, '/api/spaces', { id: SPACE, label: SPACE, meta: { validationMode: 'off', strictLinkage: false } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const ada = await post(INSTANCES.a, admin, `/api/brain/spaces/${SPACE}/entities`, { name: 'Ada Lovelace', type: 'person', waitForEmbedding: true });
  const babbage = await post(INSTANCES.a, admin, `/api/brain/spaces/${SPACE}/entities`, { name: 'Charles Babbage', type: 'person', waitForEmbedding: true });
  adaId = ada.body._id ?? ada.body.entity?._id;
  const babbageId = babbage.body._id ?? babbage.body.entity?._id;
  assert.ok(adaId && babbageId, JSON.stringify({ ada: ada.body, babbage: babbage.body }));
  const e = await post(INSTANCES.a, admin, `/api/brain/spaces/${SPACE}/edges`, { from: adaId, to: babbageId, label: 'worked_with', waitForEmbedding: true });
  assert.ok(e.status === 200 || e.status === 201, JSON.stringify(e.body));
  // `similar` searches the index and nothing else — recall's fresh-write scan does not reach it — so an embedded
  // fixture is not yet a findable one. Wait on the index state the similar cases assert, not on time.
  await waitForSimilarityIndex(INSTANCES.a, admin, SPACE, adaId, 'entity', babbageId);
  mcp = await openMcpSession(admin);
});

after(async () => {
  await mcp?.close?.();
  await delWithBody(INSTANCES.a, admin, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

/** Every record in an answer: each hit's record, and every node of its graph, at any depth. */
function recordsOf(results) {
  const out = [];
  const walk = (graph) => { for (const g of graph ?? []) { if (g.node) out.push(g.node); walk(g._graph); } };
  for (const r of results ?? []) { out.push(r.record ?? r); walk(r._graph ?? r.record?._graph); }
  return out;
}
const rest = (route, body) => post(INSTANCES.a, admin, route, body);
const tool = async (name, args) => {
  const r = await mcp.callTool(name, args);
  assert.ok(!r?.isError, r?.content?.[0]?.text);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
};

const DOORS = [
  ['recall over REST', (extra) => rest('/api/brain/recall', { space: SPACE, query: 'Ada Lovelace', types: ['entity'], topK: 2, ...extra }).then(r => r.body)],
  ['recall over MCP', (extra) => tool('recall', { space: SPACE, query: 'Ada Lovelace', types: ['entity'], topK: 2, ...extra })],
  ['similar over REST', (extra) => rest('/api/brain/similar', { space: SPACE, entryId: adaId, entryType: 'entity', topK: 2, ...extra }).then(r => r.body)],
  ['similar over MCP', (extra) => tool('similar', { space: SPACE, entryId: adaId, entryType: 'entity', topK: 2, ...extra })],
];

for (const [door, call] of DOORS) {
  describe(door, () => {
    for (const traverse of [0, 1]) {
      it(`traverse ${traverse}: no createdAt anywhere by default, and on every record when asked`, async () => {
        const plain = recordsOf((await call({ traverse })).results);
        assert.ok(plain.length > 0, 'the search found nothing, so it proves nothing');
        if (traverse === 1) assert.ok(plain.length > 1, 'the traversal reached no neighbour, so the depth is untested');
        assert.deepEqual(plain.filter(r => 'createdAt' in r).map(r => r._id), [],
          'records carry createdAt although includeRecordMeta was not asked for');

        const withMeta = recordsOf((await call({ traverse, includeRecordMeta: true })).results);
        assert.deepEqual(withMeta.filter(r => !('createdAt' in r)).map(r => r._id), [],
          'includeRecordMeta: true did not add createdAt back to every record');
      });
    }
  });
}
