/**
 * Red team: a SPARQL Update cannot be used to write without the write rung, to write through a view, to copy what its caller cannot read,
 * to manage graphs, or to reach the network (bundle-272, Q-761; vet-1 S3, S4, S6, design-r2 "WHERE over file triples").
 *
 * Each probe is sent on REST (`POST /api/brain/spaces/:spaceId/sparql/update`) and on the tool door (`POST /api/sparql_update`, the same
 * `callTool` MCP runs), and each asserts that the record it aims at is unchanged afterwards, not only the status.
 *
 * What it needs up: the test stack (instance A) and `testing/sync/configs/a/token.txt`.
 *
 * Run: node --test testing/red-team-tests/a-sparql-update-needs-the-write-rung-and-stays-in-its-space.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCES, post, patch, del, readRecord } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';
import { ownTokens } from '../_shared/own-token.mjs';

// An Update that deletes pays the heavy-call budget: this file's admin token is its own, not the suite's shared one.
const own = ownTokens();
const RUN = Date.now();
const S = `rt-spu-${RUN}`;
const BASE = `https://${S}.example.org/ld/${S}/`;
const NICK = `${BASE}vocab/entity/person#nick`;
const Y = 'https://w3id.org/ythril/ns#';

let admin, readOnly, noFiles, entityId, viewId;
const tokenIds = [];

async function update(door, token, space, text) {
  const r = door === 'rest'
    ? await fetch(`${INSTANCES.a}/api/brain/spaces/${encodeURIComponent(space)}/sparql/update`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sparql-update' }, body: text,
    })
    : await fetch(`${INSTANCES.a}/api/sparql_update`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ space, update: text }),
    });
  const body = await r.text();
  let json = null; try { json = JSON.parse(body); } catch { /* not JSON */ }
  return { status: r.status, code: json?.code ?? json?.data?.code, text: body };
}
// Read by the filter door (`readRecord`): the by-id GET route was removed, and its 404 would read as `undefined`, never as 'kept'.
const nickOf = async () => {
  const r = await readRecord(INSTANCES.a, admin, S, 'entities', entityId);
  assert.equal(r.status, 200, `the target is not readable: ${JSON.stringify(r.body)}`);
  return r.body.properties?.nick;
};
const fmt = (a) => `${a.status} ${a.code} ${a.text.slice(0, 300)}`;
const mintWith = async (name, rights) => {
  const r = await post(INSTANCES.a, admin, '/api/tokens', { name: `${name}-${RUN}`, rights });
  assert.equal(r.status, 201, `token ${name}: ${JSON.stringify(r.body)}`);
  tokenIds.push(r.body.token?.id);
  return r.body.plaintext;
};

describe('a SPARQL Update needs the write rung and stays in its space', () => {
  before(async () => {
    admin = await own.mint('rt-spu-admin');
    const sp = await post(INSTANCES.a, admin, '/api/spaces', { id: S, label: S });
    assert.equal(sp.status, 201, JSON.stringify(sp.body));
    const on = await patch(INSTANCES.a, admin, `/api/spaces/${S}`, { meta: { rdf: { enabled: true, base: BASE } } });
    assert.ok(on.status < 300, JSON.stringify(on.body));
    const e = await post(INSTANCES.a, admin, `/api/brain/spaces/${S}/entities`, { name: 'Target', type: 'person', properties: { nick: 'kept' } });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    entityId = e.body._id;
    const f = await post(INSTANCES.a, admin, '/api/write_file', { space: S, path: 'secret/plan.txt', content: 'secret' });
    assert.ok(f.status < 300, `write a file: ${f.status} ${JSON.stringify(f.body)}`);
    readOnly = await mintWith('rt-spu-read', legacyRights({ spaces: [S], readOnly: true }));
    noFiles = await mintWith('rt-spu-nofiles', { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none', networks: 'none' } } });
    const v = await post(INSTANCES.a, admin, '/api/views', { name: `rtspu${RUN}`, members: [S] });
    assert.ok(v.status < 300, `view: ${v.status} ${JSON.stringify(v.body)}`);
    viewId = v.body?.view?.id ?? v.body?.id;
    assert.ok(viewId, JSON.stringify(v.body));
  });
  own.after(async () => {
    if (viewId) await del(INSTANCES.a, admin, `/api/views/${encodeURIComponent(viewId)}`).catch(() => {});
    for (const id of tokenIds) if (id) await del(INSTANCES.a, admin, `/api/tokens/${id}`).catch(() => {});
    await del(INSTANCES.a, admin, `/api/spaces/${S}`).catch(() => {});
  });

  const write = () => `DELETE { ?s <${NICK}> ?v } INSERT { ?s <${NICK}> "pwned" } WHERE { ?s <${NICK}> ?v }`;

  for (const door of ['rest', 'tool']) {
    it(`${door}: a token without knowledge write is refused and writes nothing`, async () => {
      const a = await update(door, readOnly, S, write());
      assert.equal(a.status, 403, fmt(a));
      assert.equal(await nickOf(), 'kept');
    });

    it(`${door}: a view id is refused as a missing space and writes nothing`, async () => {
      const a = await update(door, admin, viewId, write());
      assert.equal(a.status, 404, fmt(a));
      assert.equal(await nickOf(), 'kept');
    });

    it(`${door}: a caller without files: read cannot copy a file's statements into a record`, async () => {
      const a = await update(door, noFiles, S, `INSERT { <${BASE}entity/${entityId}> <${NICK}> "copied" } WHERE { ?f a <${Y}File> }`);
      assert.equal(a.status, 200, fmt(a));
      assert.equal(await nickOf(), 'kept', 'a file the caller cannot read was read by the Update');
    });

    for (const [what, text] of [
      ['CLEAR', 'CLEAR ALL'], ['DROP', `DROP GRAPH <${BASE}>`], ['CREATE', 'CREATE GRAPH <http://other.example/g>'],
      ['COPY', `COPY DEFAULT TO <http://other.example/g>`], ['a foreign GRAPH', `INSERT DATA { GRAPH <http://other.example/g> { <${BASE}entity/${entityId}> <${NICK}> "x" } }`],
    ]) {
      it(`${door}: graph management (${what}) is refused`, async () => {
        const a = await update(door, admin, S, text);
        assert.equal(a.status, 400, fmt(a));
        assert.equal(a.code, 'sparql_graph_management_refused', fmt(a));
        assert.equal(await nickOf(), 'kept');
      });
    }

    it(`${door}: SERVICE never leaves the instance`, async () => {
      const a = await update(door, admin, S, `INSERT { <${BASE}entity/${entityId}> <${NICK}> ?x } WHERE { SERVICE <http://127.0.0.1:9/sparql> { ?s ?p ?x } }`);
      assert.equal(a.status, 400, fmt(a));
      assert.equal(a.code, 'sparql_federation_refused', fmt(a));
      assert.equal(await nickOf(), 'kept');
    });

    it(`${door}: LOAD never fetches`, async () => {
      const a = await update(door, admin, S, 'LOAD <http://127.0.0.1:9/x.ttl>');
      assert.equal(a.status, 400, fmt(a));
      assert.ok(['sparql_graph_management_refused', 'sparql_federation_refused'].includes(a.code), fmt(a));
      assert.equal(await nickOf(), 'kept');
    });
  }
});
