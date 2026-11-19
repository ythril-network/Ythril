/**
 * The schema export answers alike on both doors (Q-751, design r4 §6 doors [N8][O2]; owner 2026-11-19 on formats; parent 2026-11-19).
 *
 * ## What it holds
 *
 * - `GET /api/spaces/:id/schema-rdf` answers Turtle by default, JSON-LD for `format=jsonld` or `Accept: application/ld+json`, each with its
 *   media type (no version: the schema has no triple term), `Vary: Accept` and an attachment `<space>-schema.<ext>`; a format it does not
 *   offer is 400 `rdf_bad_format`, an Accept naming neither is 406 `rdf_format_not_acceptable`.
 * - MCP `space_schema_rdf` answers the same document in its first block, the summary (ontology, version, fingerprint) as JSON in the second
 *   and in `structuredContent`, never the document there.
 * - 409 `rdf_not_enabled` and `rdf_base_conflict` on both doors; the schema read rung (403 without it); a personal view is refused on
 *   both doors (answered as the product answers a view on every schema door).
 * - It says nothing of library groups or namespaces beyond the terms the space's own schema uses.
 *
 * Run: node --test testing/standalone/the-schema-export-answers-alike-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfschemadoors';
const OFF = 'rdfschemaoff';
const CONF = 'rdfschemaconf';
const NET = 'net-schema-conflict';

describe('the schema export answers alike on both doors', { skip }, () => {
  let d, admin, schemaReader, knowledgeOnly;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_schema_doors', spaces: [
      { id: SPACE, meta: rdfMeta(SPACE, { typeSchemas: { entity: { Thing: { propertySchemas: { size: { type: 'number' } } } } } }) },
      { id: OFF, meta: { suppressEmbeddings: true } },
      { id: CONF, meta: rdfMeta(CONF) },
    ] });
    d.loader.mutateConfig(c => {
      c.schemaLibraryNamespaces = { unrelated: { prefix: 'unrelatedgroup', iri: 'https://unrelated.example.org/ns/' } };
      c.networks.push({
        id: NET, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [CONF], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: 'peer-s', label: 'Peer', url: 'https://peer.example', tokenHash: 'h', direction: 'both' }],
        rdfBaseConflicts: { [CONF]: { held: { base: baseOf(CONF), epoch: 0 },
          offered: [{ networkId: NET, memberId: 'peer-s', base: 'https://elsewhere.example.org/ld/c/', epoch: 1 }] } },
      });
    });
    admin = await d.mint('admin', {}, { admin: true });
    schemaReader = await d.mint('schema', { [SPACE]: d.row({ schema: 'read', knowledge: 'read' }), [OFF]: d.row({ schema: 'read' }), [CONF]: d.row({ schema: 'read' }) });
    knowledgeOnly = await d.mint('knowledge', { [SPACE]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('Turtle by default, JSON-LD by parameter or Accept, each with its type, Vary and attachment', async () => {
    const t = await d.schemaRest(schemaReader.key, SPACE);
    assert.equal(t.status, 200, t.text.slice(0, 300));
    assert.equal(t.headers['content-type'], 'text/turtle');
    assert.match(String(t.headers['vary']), /Accept/i);
    assert.match(String(t.headers['content-disposition']), new RegExp(`filename="${SPACE}-schema\\.ttl"`));
    assert.match(t.text, /owl:Ontology/);
    const j = await d.schemaRest(schemaReader.key, SPACE, { format: 'jsonld' });
    assert.equal(j.headers['content-type'], 'application/ld+json');
    const a = await d.schemaRest(schemaReader.key, SPACE, {}, { Accept: 'application/ld+json' });
    assert.equal(a.text, j.text, 'the header gives what the parameter gives');
    const p = await d.schemaRest(schemaReader.key, SPACE, { format: 'turtle' }, { Accept: 'application/ld+json' });
    assert.equal(p.headers['content-type'], 'text/turtle', 'the parameter wins');
    const bad = await d.schemaRest(schemaReader.key, SPACE, { format: 'trig' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body?.code, 'rdf_bad_format');
    const none = await d.schemaRest(schemaReader.key, SPACE, {}, { Accept: 'application/trig' });
    assert.equal(none.status, 406);
    assert.equal(none.body?.code, 'rdf_format_not_acceptable');
  });

  it('MCP answers the same document, the summary beside it', async () => {
    const rest = await d.schemaRest(schemaReader.key, SPACE);
    const mcp = await d.schemaMcp(schemaReader.key, { space: SPACE });
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    assert.equal(mcp.document, rest.text);
    assert.deepEqual(mcp.summary, mcp.structured);
    assert.equal(mcp.structured.ontology, `${baseOf(SPACE)}schema`);
    assert.match(mcp.structured.version, new RegExp(`^${baseOf(SPACE)}schema/[0-9a-f]{64}$`));
    assert.match(mcp.structured.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(mcp.structured).includes('@prefix'));
    const bad = await d.schemaMcp(schemaReader.key, { space: SPACE, format: 'nquads' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /rdf_bad_format/);
  });

  it('409s, the rung and a view are refused alike', async () => {
    for (const [space, code] of [[OFF, 'rdf_not_enabled'], [CONF, 'rdf_base_conflict']]) {
      const r = await d.schemaRest(schemaReader.key, space);
      assert.equal(r.status, 409, r.text.slice(0, 300));
      assert.equal(r.body?.code, code);
      const m = await d.schemaMcp(schemaReader.key, { space });
      assert.equal(m.isError, true);
      assert.match(m.text, new RegExp(code));
    }
    const limited = await d.schemaRest(schemaReader.key, CONF);
    assert.ok(!limited.text.includes(NET), 'the network is named only to who may read it');
    const r = await d.schemaRest(knowledgeOnly.key, SPACE);
    assert.equal(r.status, 403, r.text.slice(0, 200));
    assert.equal((await d.schemaMcp(knowledgeOnly.key, { space: SPACE })).isError, true);
    const v = await d.rest(schemaReader.key, 'POST', '/api/views', { name: 'sv', members: [SPACE] });
    assert.ok(v.status < 300, v.text.slice(0, 200));
    const viewRest = await d.schemaRest(schemaReader.key, '@sv');
    assert.equal(viewRest.status, 404, viewRest.text.slice(0, 200));
    assert.match(viewRest.text, /view/);
    const viewMcp = await d.schemaMcp(schemaReader.key, { space: '@sv' });
    assert.equal(viewMcp.isError, true);
  });

  it('it says nothing of a library namespace the space does not use', async () => {
    for (const format of ['turtle', 'jsonld']) {
      const r = await d.schemaRest(admin.key, SPACE, { format });
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('unrelated'), `${format}: no word of an unused namespace`);
    }
    const e = await d.exportRest(admin.key, SPACE, { format: 'turtle' });
    assert.ok(!e.text.includes('unrelated'), 'nor the records export');
  });
});
