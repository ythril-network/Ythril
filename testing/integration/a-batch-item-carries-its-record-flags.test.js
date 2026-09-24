/**
 * A batch item carries the per-record flags its single-record endpoint takes — on both doors, for all four
 * record kinds.
 *
 * `superseded` and `suppressEmbeddings` are settable on every single create. The batch door's documentation
 * says an item "accepts the same fields as its corresponding individual endpoint", and its loops never read
 * either: REST answered 207 with the flag dropped, and MCP's item schemas did not declare them, so the tool
 * refused a call the REST door accepted. Found building `ingest`, which writes a retired claim and an
 * attributed (unranked) one through this door.
 *
 * Asserted on the STORED record, read back by the id the batch returned — a count of inserts cannot tell a
 * record written with its flag from one written without.
 *
 * Run: node --test testing/integration/a-batch-item-carries-its-record-flags.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, readCollection } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = 'general';

let token;
let mcp;
let targetId;

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token);
  const e = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, { name: `flags-target-${RUN}`, type: 'concept' });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  targetId = e.body._id ?? e.body.id;
});

const viaRest = async (body) => (await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/bulk`, body)).body;
const viaMcp = async (body) => {
  const r = await mcp.callTool('save_bulk', { space: SPACE, ...body });
  return r?.isError ? { refused: r.content?.[0]?.text } : (r?.structuredContent ?? {});
};
const DOORS = [['REST', viaRest], ['MCP', viaMcp]];

const byId = async (collection, id) => {
  const r = await readCollection(INSTANCES.a, token, SPACE, collection, { filter: { _id: id }, limit: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.results[0] ?? null;
};

const FLAGS = { superseded: true, suppressEmbeddings: true };

describe('both flags reach the stored record, for every kind', () => {
  for (const [door, call] of DOORS) {
    it(`${door}: a fact, an entity, a chrono entry and an edge`, async () => {
      const body = await call({
        facts: [{ $ref: 'f', fact: `flags fact ${door} ${RUN}`, ...FLAGS }],
        entities: [{ $ref: 'e', name: `flags-entity-${door}-${RUN}`, type: 'concept', ...FLAGS }],
        chrono: [{ $ref: 'c', title: `flags chrono ${door} ${RUN}`, type: 'event', startsAt: new Date().toISOString(), ...FLAGS }],
        edges: [{ from: '$ref:e', to: targetId, label: `flagged_${door.toLowerCase()}`, ...FLAGS }],
      });
      assert.equal(body.refused, undefined, `the door refused a field its single endpoint takes: ${body.refused}`);
      assert.equal(body.errors?.length ?? 0, 0, JSON.stringify(body));
      for (const [key, collection] of [['f', 'facts'], ['e', 'entities'], ['c', 'chrono']]) {
        const doc = await byId(collection, body.refs[key].id);
        assert.equal(doc?.superseded, true, `${collection}: superseded was dropped`);
        assert.equal(doc?.suppressEmbeddings, true, `${collection}: suppressEmbeddings was dropped`);
      }
      const edges = await readCollection(INSTANCES.a, token, SPACE, 'edges', { filter: { from: body.refs.e.id }, limit: 5 });
      assert.equal(edges.results.length, 1, JSON.stringify(edges.results));
      assert.equal(edges.results[0].superseded, true, 'edge: superseded was dropped');
      assert.equal(edges.results[0].suppressEmbeddings, true, 'edge: suppressEmbeddings was dropped');
    });

    it(`${door}: a non-boolean flag is refused for that item, by the shared rule`, async () => {
      const body = await call({ facts: [{ fact: `flags bad ${door} ${RUN}`, superseded: 'yes' }] });
      // MCP's schema refuses the call before the handler; REST reports the item. Either way nothing is written
      // with a truthy string standing in for a boolean.
      if (body.refused) return;
      assert.equal(body.errors?.length, 1, JSON.stringify(body));
      assert.match(body.errors[0].reason, /superseded/);
      assert.equal(body.inserted.facts, 0);
    });
  }
});
