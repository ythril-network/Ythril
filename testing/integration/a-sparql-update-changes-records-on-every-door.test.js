/**
 * Integration: a SPARQL Update changes records on a LIVE instance through each of its doors, whole or not at all (bundle-272, Q-761).
 *
 * ## What it proves
 *
 * Over `POST /api/brain/spaces/:spaceId/sparql/update`, MCP `sparql_update` and `POST /api/sparql_update`, each in a space of its own made
 * through the ordinary doors (records written by the record doors, so they carry real versions, authors and stamps):
 * - INSERT DATA makes a record; DELETE DATA removes the one value it names; DELETE/INSERT WHERE renames a property across records; an edge's
 *   annotation changes in place.
 * - In a strict space, one statement the schema refuses among valid ones lands nothing, and the refusal names the record and the rule.
 * - An Update deleting an entity an edge still names is refused, naming the edge.
 *
 * What it needs up: the integration stack (`npm run test:up`), with instance A built from this checkout.
 *
 * Run: node --test testing/integration/a-sparql-update-changes-records-on-every-door.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, post, patch, put, del, readCollection, readRecord } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { ownTokens } from '../_shared/own-token.mjs';

const own = ownTokens();
const RUN = Date.now();
const DOORS = ['rest', 'mcp', 'tool'];
const Y = 'https://w3id.org/ythril/ns#';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const baseOf = (space) => `https://${space}.example.org/ld/${space}/`;
const SCHEMA = {
  entity: { person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' }, alias: { type: 'string' } } } },
  edge: { knows: { propertySchemas: { note: { type: 'string' } } } },
};

let token;
let mcp;
const made = [];
/** Per space: the ids of the records the fixture wrote, by name. */
const ids = {};

async function makeSpace(id, mode) {
  const sp = await post(INSTANCES.a, token, '/api/spaces', { id, label: id });
  assert.equal(sp.status, 201, `create space ${id}: ${JSON.stringify(sp.body)}`);
  made.push(id);
  const on = await patch(INSTANCES.a, token, `/api/spaces/${id}`, { meta: { rdf: { enabled: true, base: baseOf(id) }, validationMode: mode } });
  assert.ok(on.status < 300, `switch RDF on for ${id}: ${on.status} ${JSON.stringify(on.body)}`);
  const schema = await put(INSTANCES.a, token, `/api/spaces/${id}/schema`, { typeSchemas: SCHEMA });
  assert.equal(schema.status, 200, `schema of ${id}: ${JSON.stringify(schema.body)}`);
  const at = {};
  for (const [name, properties] of [['Ada', { nick: 'ada' }], ['Bob', { nick: 'bob' }], ['Cy', { nick: 'cy' }]]) {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${id}/entities`, { name, type: 'person', properties });
    assert.equal(r.status, 201, `entity ${name}: ${JSON.stringify(r.body)}`);
    at[name] = r.body._id;
  }
  const k = await post(INSTANCES.a, token, `/api/brain/spaces/${id}/edges`, { from: at.Ada, to: at.Bob, label: 'knows', properties: { note: 'old' } });
  assert.equal(k.status, 201, `edge: ${JSON.stringify(k.body)}`);
  at.knows = k.body._id;
  ids[id] = at;
}

/** One Update on one door: `{status, code, text}`; MCP's status is 200 or `refused`. */
async function update(door, space, text) {
  if (door === 'rest') {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/${space}/sparql/update`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sparql-update' }, body: text,
    });
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch { /* not JSON */ }
    return { status: r.status, code: json?.code, text: body };
  }
  if (door === 'tool') {
    const r = await fetch(`${INSTANCES.a}/api/sparql_update`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ space, update: text }),
    });
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch { /* not JSON */ }
    return { status: r.status, code: json?.data?.code, text: body };
  }
  const m = await mcp.callTool('sparql_update', { space, update: text });
  const t = (m.content ?? []).map(c => c.text).join('\n');
  return { status: m.isError ? 'refused' : 200, code: m.isError ? /\(([a-z_]+)\)\s*$/m.exec(t)?.[1] : undefined, text: t };
}

// A record is read by the filter door (`readRecord`): the by-id GET routes were removed, and answer 404 for every id.
const entity = async (space, id) => (await readRecord(INSTANCES.a, token, space, 'entities', id)).body;
const fmt = (a) => `${a.status} ${a.code} ${String(a.text).slice(0, 400)}`;

describe('a SPARQL Update changes records on every door', () => {
  before(async () => {
    token = await own.mint('sparql-update');
    mcp = await openMcpSession(token, INSTANCES.a, 90_000);
    for (const door of DOORS) await makeSpace(`spu-${door}-${RUN}`, 'warn');
    await makeSpace(`spu-strict-${RUN}`, 'strict');
  });
  own.after(async () => {
    for (const id of made) await del(INSTANCES.a, token, `/api/spaces/${id}`).catch(() => {});
  });
  after(async () => { await mcp?.close?.(); });

  for (const door of DOORS) {
    describe(`through ${door}`, () => {
      const S = `spu-${door}-${RUN}`;
      const at = (kind, name) => `${baseOf(S)}${kind}/${ids[S][name] ?? name}`;
      const p = (prop) => `${baseOf(S)}vocab/entity/person#${prop}`;

      it('INSERT DATA makes a record', async () => {
        const a = await update(door, S, `INSERT DATA { <${baseOf(S)}entity/new-one> a <${Y}Entity>, <${baseOf(S)}vocab/entity/person> ; <${LABEL}> "Newcomer ${door}" }`);
        assert.equal(a.status, 200, fmt(a));
        const found = await readCollection(INSTANCES.a, token, S, 'entities', { filter: { name: `Newcomer ${door}` } });
        assert.equal(found.status, 200, JSON.stringify(found.body));
        assert.equal(found.results.length, 1, 'the inserted record is not stored once');
      });

      it('DELETE DATA removes exactly the value it names', async () => {
        const a = await update(door, S, `DELETE DATA { <${at('entity', 'Ada')}> <${p('nick')}> "ada" }`);
        assert.equal(a.status, 200, fmt(a));
        const ada = await entity(S, ids[S].Ada);
        assert.equal(ada.properties?.nick, undefined, 'the named value is still stored');
        assert.equal(ada.name, 'Ada');
      });

      it('DELETE/INSERT WHERE renames a property across records', async () => {
        const a = await update(door, S, `DELETE { ?s <${p('nick')}> ?v } INSERT { ?s <${p('alias')}> ?v } WHERE { ?s <${p('nick')}> ?v }`);
        assert.equal(a.status, 200, fmt(a));
        for (const [name, v] of [['Bob', 'bob'], ['Cy', 'cy']]) {
          const e = await entity(S, ids[S][name]);
          assert.deepEqual([e.properties?.alias, e.properties?.nick], [v, undefined], `${name} was not renamed`);
        }
      });

      it('an edge annotation is changed in place', async () => {
        const note = `${baseOf(S)}vocab/edge/knows#note`;
        const a = await update(door, S, `DELETE DATA { <${at('edge', 'knows')}> <${note}> "old" } ; INSERT DATA { <${at('edge', 'knows')}> <${note}> "new" }`);
        assert.equal(a.status, 200, fmt(a));
        const k = await readRecord(INSTANCES.a, token, S, 'edges', ids[S].knows);
        assert.equal(k.body?.properties?.note, 'new', JSON.stringify(k.body));
      });

      it('an Update deleting an entity an edge names is refused, naming the edge', async () => {
        const a = await update(door, S, `DELETE WHERE { <${at('entity', 'Bob')}> ?p ?o }`);
        assert.equal(a.code, 'sparql_update_referenced', fmt(a));
        assert.ok(String(a.text).includes(ids[S].knows), `the edge is not named: ${fmt(a)}`);
        assert.equal((await entity(S, ids[S].Bob)).name, 'Bob', 'the referenced entity was deleted');
      });

      it('a strict violation among valid statements lands nothing, naming the statement and the rule', async () => {
        const T = `spu-strict-${RUN}`;
        const a = await update(door, T, `INSERT DATA { <${baseOf(T)}entity/${ids[T].Ada}> <${LABEL}> "Renamed" . <${baseOf(T)}entity/${ids[T].Bob}> <${baseOf(T)}vocab/entity/person#age> "old" }`);
        assert.equal(a.code, 'sparql_update_refused', fmt(a));
        assert.ok(String(a.text).includes(ids[T].Bob), `the statement's record is not named: ${fmt(a)}`);
        assert.ok(String(a.text).includes('age'), `the rule's field is not named: ${fmt(a)}`);
        assert.equal((await entity(T, ids[T].Ada)).name, 'Ada', 'a valid statement of the refused Update landed');
      });
    });
  }
});
