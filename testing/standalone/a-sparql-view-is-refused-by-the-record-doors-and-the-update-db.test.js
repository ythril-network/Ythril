/**
 * A SPARQL view is read by the RDF doors only: the record doors and SPARQL Update refuse it with its reason (bundle-273, Q-762; DEC-3).
 *
 * ## The rules
 *
 * 1. **The record doors refuse it**: `filter`, `recall` and `graph_traverse` on MCP, on the tool door (`POST /api/filter`), and REST
 *    `POST /api/brain/recall` and `POST /api/brain/spaces/@v/traverse` answer `409 view_is_construct` for the caller's own SPARQL view, and
 *    nothing of its members.
 * 2. **SPARQL Update refuses it as a target** (a view of computed statements has nothing to write into): `POST .../sparql/update` on `@v`
 *    and MCP `sparql_update` answer `409 view_is_construct`.
 * 3. **A plain view is answered as before at the same doors**: the filters read its members (`viewMembers`), no record door refuses it
 *    as a construct, and Update answers it exactly as it answered before this change (REST `404` with the view hint, recorded on the
 *    base 9f5d8d295, characterization).
 *
 * ## Seen red on 9f5d8d295
 *
 * Rule 1: `MCP filter: 200 [{"_id":"e1",...,"name":"RecordOfTheMember"...}]` (the view's member read); rule 2: `rest: 404 {"error":"Space
 * '@q762-construct' not found. '@q762-construct' is a view; write to one of its member spaces"}`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-view-is-refused-by-the-record-doors-and-the-update-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { viewMembersOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const S = 'q762-doors';
const STAMP = '2026-03-04T05:06:07.000Z';
const QUERY = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s a <https://w3id.org/ythril/ns#Entity> ; ?p ?o }';
const UPDATE = 'INSERT DATA { <urn:q762:a> <urn:q762:b> "c" }';
const SECRET = 'RecordOfTheMember';

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const codeOf = (a) => a.body?.code ?? a.body?.data?.code ?? a.code ?? /\b(view_is_construct)\b/.exec(a.text ?? '')?.[1];

/** Every record door, each answered as `{status, code, text, body}` (`status` of an MCP refusal: 'refused'). */
function recordDoors(id) {
  const mcp = async (tool, args) => {
    const m = await d.mcp(tok.key, tool, { space: id, ...args });
    return { status: m.isError ? 'refused' : 200, code: /\b(view_is_construct)\b/.exec(m.text)?.[1], text: m.text, body: m.structured };
  };
  return {
    'MCP filter': () => mcp('filter', { collection: 'entities', filter: {} }),
    'MCP recall': () => mcp('recall', { query: 'record' }),
    'MCP graph_traverse': () => mcp('graph_traverse', { startId: 'e1' }),
    'tool door filter': () => d.rest(tok.key, 'POST', '/api/filter', { space: id, collection: 'entities', filter: {} }),
    'REST recall': () => d.rest(tok.key, 'POST', '/api/brain/recall', { space: id, query: 'record' }),
    'REST traverse': () => d.rest(tok.key, 'POST', `/api/brain/spaces/${encodeURIComponent(id)}/traverse`, { startId: 'e1' }),
  };
}

describe('a SPARQL view is refused by the record doors and the Update', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q762-doors', spaces: [{ id: S }] });
    // A traverse reads the space's link records, which a space is marked as having once its links are converted: a space seeded straight into
    // its collections is not, and would refuse every traverse for that, so the plain view's traverse is held to an answer below.
    await d.loader.mutateConfig(cfg => { cfg.spaces.find(s => s.id === S).completeLinkage = true; });
    await d.seed(S, 'entity', [{ _id: 'e1', name: SECRET, type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    tok = await d.mint('q762-doors', { [S]: d.row({ knowledge: 'write' }) });
    const made = await d.rest(tok.key, 'POST', '/api/views', { name: 'q762-construct', members: [S], sparql: { query: QUERY } });
    assert.equal(made.status, 201, fmt(made));
    const plain = await d.rest(tok.key, 'POST', '/api/views', { name: 'q762-plain', members: [S] });
    assert.equal(plain.status, 201, fmt(plain));
  });
  after(async () => { await d?.close(); });

  it('filter, recall and traverse refuse a SPARQL view with 409 view_is_construct on every door, with nothing of its members', async () => {
    for (const [door, call] of Object.entries(recordDoors('@q762-construct'))) {
      const a = await call();
      assert.ok(a.status === 409 || a.status === 'refused', `${door}: ${fmt(a)}`);
      assert.equal(codeOf(a), 'view_is_construct', `${door}: ${fmt(a)}`);
      assert.ok(!a.text.includes(SECRET), `${door}: the refusal carries a record of the member`);
    }
  });

  it('a plain view is still read by the record doors', async () => {
    for (const [door, call] of Object.entries(recordDoors('@q762-plain'))) {
      const a = await call();
      assert.equal(codeOf(a), undefined, `${door}: a plain view refused as a construct one: ${fmt(a)}`);
      // A traverse of a plain view's member is answered: holding it to no construct code alone would pass a 500 as well.
      if (door.endsWith('traverse')) assert.equal(a.status, 200, `${door}: a plain view's traverse: ${fmt(a)}`);
      // The filters read the member; recall needs an embedder this suite has not, so it is held only to not being refused as a construct.
      if (door.endsWith('filter')) {
        assert.deepEqual(viewMembersOf(a), [S], `${door}: ${fmt(a)}`);
      }
    }
  });

  it('SPARQL Update refuses a SPARQL view as its target on REST and MCP, and answers a plain view as before', async () => {
    for (const door of ['rest', 'mcp', 'tool']) {
      const a = await d.sparqlUpdate(door, tok.key, '@q762-construct', UPDATE);
      assert.ok(a.status === 409 || a.status === 'refused', `${door}: ${a.status} ${a.text.slice(0, 300)}`);
      assert.equal(a.code ?? /\b(view_is_construct)\b/.exec(a.text)?.[1], 'view_is_construct', `${door}: ${a.text.slice(0, 300)}`);
      // Recorded on the base (9f5d8d295): a plain view is no target of a write; REST answers it as an unknown space, with the hint.
      const plain = await d.sparqlUpdate(door, tok.key, '@q762-plain', UPDATE);
      assert.notEqual(plain.status, 200, `${door}: a plain view took an update`);
      assert.notEqual(plain.code, 'view_is_construct', `${door}: a plain view answered as a construct one`);
      if (door === 'rest') assert.equal(plain.status, 404, `${door}: ${plain.text.slice(0, 300)}`);
    }
  });
});
