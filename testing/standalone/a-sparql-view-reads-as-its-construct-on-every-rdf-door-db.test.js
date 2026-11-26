/**
 * A SPARQL view is read by the RDF doors as its CONSTRUCT over its members, as the caller reads them (bundle-273, Q-762).
 *
 * ## The rules
 *
 * 1. **One type kept.** A view whose CONSTRUCT keeps the statements of entities answers those statements and nothing of the facts beside
 *    them, on every RDF door: the RDF export (`GET /api/brain/spaces/@v/export/rdf`, MCP `export_rdf`), the SPARQL query endpoint (`GET`
 *    `.../sparql` on `@v`, MCP `sparql_query`; a query there reads the CONSTRUCT's statements, not the members), and the view's Linked Data
 *    address (`GET /ld/@v/`).
 * 2. **A member the caller cannot read contributes nothing.** A view over two members, one of which the caller no longer reads, answers on
 *    every door exactly what the same CONSTRUCT over the readable member alone answers: the CONSTRUCT runs over the members as the caller
 *    reads them, never as the view's owner had them, never as the instance.
 * 3. **The cap.** A CONSTRUCT that would produce more than 50 000 statements is refused with `413 view_construct_too_large` on each door,
 *    with no statement of it: never a cut answer.
 *    Exactly 50 000 statements are answered whole (the export and the address; the SPARQL endpoint's own `maxResults` bounds what it answers).
 * 4. **The address is the owner's.** Another token's SPARQL view, and a plain view, have no Linked Data address: `404 ld_not_found`.
 *
 * ## Seen red on 9f5d8d295
 *
 * Rule 1: `export: a statement of no entity: https://rdf.example.org/ld/q762-read-a/ http://purl.org/dc/terms/isPartOf ...` (the members'
 * whole export, the query ignored); rules 2 and 3 failed alike. Rule 4 held already (no view had an address): it guards the new one.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-view-reads-as-its-construct-on-every-rdf-door-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, baseOf } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const A = 'q762-read-a';
const B = 'q762-read-b';
const BIG = 'q762-read-big';
const STAMP = '2026-03-04T05:06:07.000Z';
const ENTITY = 'https://w3id.org/ythril/ns#Entity';
const KEEP_ENTITIES = `CONSTRUCT { ?s ?p ?o } WHERE { ?s a <${ENTITY}> ; ?p ?o }`;
/** Every pair of entities: 260 entities make 67 600 statements, past the cap. */
const EVERY_PAIR = `CONSTRUCT { ?a <urn:q762:pair> ?b } WHERE { ?a a <${ENTITY}> . ?b a <${ENTITY}> }`;
const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';
const PUBLIC = 'https://rdf.example.org';
const previousPublic = process.env['PUBLIC_BASE_URL'];

let d, both, onlyA, other;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const nquads = (text) => new Parser({ format: 'application/n-quads' }).parse(text);
/** A statement as a line without its graph: what the CONSTRUCT made, whichever door wrote it. */
const tripleText = (q) => `${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}`;
const triplesOf = (text) => nquads(text).map(tripleText).sort();
const rowTriples = (body) => (body?.results?.bindings ?? []).map(b => `${b.s.value} ${b.p.value} ${b.o.type === 'uri' ? 'NamedNode' : b.o.type === 'bnode' ? 'BlankNode' : 'Literal'}:${b.o.value}`).sort();

async function view(key, name, members, query) {
  const r = await d.rest(key, 'POST', '/api/views', { name, members, sparql: { query } });
  assert.equal(r.status, 201, `create ${name}: ${fmt(r)}`);
  return `@${name}`;
}

/** What each door answers for `id` read by `key`: the triples, or the refusal's status and code. */
async function doors(key, id) {
  const exp = await d.rest(key, 'GET', `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf?format=nquads`);
  const expMcp = await d.toolCall(key, 'export_rdf', { space: id, format: 'nquads', maxChars: 5_000_000 });
  const spq = await d.sparqlGet(key, id, ALL);
  const spqMcp = await d.sparqlMcp(key, { space: id, query: ALL });
  const ld = await d.sparqlRest(key, 'GET', `/ld/${id}/`, { headers: { Accept: 'application/n-quads' } });
  const out = {};
  out.export = exp.status === 200 ? triplesOf(exp.text) : `${exp.status} ${exp.body?.code}`;
  out.exportMcp = expMcp.isError ? `refused ${/\(([a-z_]+)\)/.exec(expMcp.text)?.[1] ?? expMcp.text.slice(0, 200)}` : triplesOf(expMcp.document);
  out.sparql = spq.status === 200 ? rowTriples(spq.body) : `${spq.status} ${spq.body?.code}`;
  out.sparqlMcp = spqMcp.isError ? `refused ${/\(([a-z_]+)\)/.exec(spqMcp.text)?.[1] ?? spqMcp.text.slice(0, 200)}` : rowTriples(spqMcp.body);
  out.ld = ld.status === 200 ? triplesOf(ld.text) : `${ld.status} ${ld.body?.code}`;
  return out;
}

describe('a SPARQL view reads as its CONSTRUCT on every RDF door', { skip }, () => {
  before(async () => {
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
    d = await openSparqlDoors({ suite: 'q762-read', spaces: [{ id: A }, { id: B }, { id: BIG }] });
    await d.seed(A, 'entity', [{ _id: 'ea', name: 'EntityOfA', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(A, 'fact', [{ _id: 'fa', fact: 'FactOfA', entityIds: ['ea'], createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(B, 'entity', [{ _id: 'eb', name: 'SecretEntityOfB', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(BIG, 'entity', Array.from({ length: 260 }, (_, i) => ({ _id: `big-${i}`, name: `Big ${i}`, type: 'Thing', createdAt: STAMP, updatedAt: STAMP })));
    const reads = d.row({ knowledge: 'read' });
    both = await d.mint('q762-read-both', { [A]: reads, [B]: reads, [BIG]: reads });
    onlyA = await d.mint('q762-read-only-a', { [A]: reads });
    other = await d.mint('q762-read-other', { [A]: reads, [B]: reads });
  });
  after(async () => {
    await d?.close();
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
  });

  it('a view that keeps entities answers only their statements on the export, SPARQL and Linked Data, on REST and MCP', async () => {
    const id = await view(both.key, 'q762-entities', [A], KEEP_ENTITIES);
    const answers = await doors(both.key, id);
    const entity = `${baseOf(A)}entity/ea`;
    for (const [door, triples] of Object.entries(answers)) {
      assert.ok(Array.isArray(triples), `${door}: ${JSON.stringify(triples)}`);
      assert.ok(triples.length > 0, `${door}: an empty answer`);
      assert.ok(triples.every(t => t.startsWith(`${entity} `)), `${door}: a statement of no entity: ${triples.find(t => !t.startsWith(`${entity} `))}`);
      assert.ok(triples.some(t => t.endsWith(`NamedNode:${ENTITY}`)), `${door}: the entity's type is missing`);
      assert.ok(!triples.some(t => t.includes('FactOfA')), `${door}: the fact is in the answer`);
    }
    assert.deepEqual(answers.exportMcp, answers.export, 'MCP export answers what REST export answers');
    assert.deepEqual(answers.sparql, answers.export, 'the SPARQL endpoint reads the CONSTRUCT\'s statements');
    assert.deepEqual(answers.sparqlMcp, answers.export, 'MCP sparql_query reads them too');
    assert.deepEqual(answers.ld, answers.export, 'the view\'s address answers them');
  });

  it('a member the caller cannot read contributes nothing on any door', async () => {
    const reads = d.row({ knowledge: 'read' });
    const narrowed = await d.mint('q762-read-narrowed', { [A]: reads, [B]: reads });
    const id = await view(narrowed.key, 'q762-two', [A, B], KEEP_ENTITIES);
    const withB = await doors(narrowed.key, id);
    assert.ok(withB.export.some(t => t.startsWith(`${baseOf(B)}entity/eb `)), 'while B is read, its entity is in the answer');
    await d.setRights(narrowed.id, (rights) => { delete rights.perSpace[B]; });
    const lost = await doors(narrowed.key, id);
    const alone = await doors(onlyA.key, await view(onlyA.key, 'q762-one', [A], KEEP_ENTITIES));
    for (const door of Object.keys(alone)) {
      assert.ok(Array.isArray(lost[door]), `${door}: ${JSON.stringify(lost[door])}`);
      assert.deepEqual(lost[door], alone[door], `${door}: the view over a member the caller lost answers more than the readable member alone`);
      assert.ok(!JSON.stringify(lost[door]).includes('SecretEntityOfB') && !lost[door].some(t => t.includes(`${baseOf(B)}`)), `${door}: B is in the answer`);
    }
  });

  it('a CONSTRUCT past 50 000 statements is refused with its reason on every door, never cut', async () => {
    const id = await view(both.key, 'q762-pairs', [BIG], EVERY_PAIR);
    const answers = await doors(both.key, id);
    assert.deepEqual(answers, {
      export: '413 view_construct_too_large', exportMcp: 'refused view_construct_too_large', sparql: '413 view_construct_too_large',
      sparqlMcp: 'refused view_construct_too_large', ld: '413 view_construct_too_large',
    });
  });

  it('a CONSTRUCT of exactly 50 000 statements is answered whole and one more is refused, on the export and the address', async () => {
    // 260 entities make 67 600 solutions; the LIMIT cuts them to the number of statements the cap is held against.
    const pairs = (limit) => `CONSTRUCT { ?a <urn:q762:pair> ?b } WHERE { ?a a <${ENTITY}> . ?b a <${ENTITY}> } LIMIT ${limit}`;
    const exact = await view(both.key, 'q762-exact', [BIG], pairs(50_000));
    const over = await view(both.key, 'q762-over', [BIG], pairs(50_001));
    const exportOf = (id) => d.sparqlRest(both.key, 'GET', `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf?format=nquads`);
    const addressOf = (id) => d.sparqlRest(both.key, 'GET', `/ld/${id}/`, { headers: { Accept: 'application/n-quads' } });
    for (const [door, read] of [['export', exportOf], ['address', addressOf]]) {
      const fits = await read(exact);
      assert.equal(fits.status, 200, `${door}, 50 000: ${fmt(fits)}`);
      assert.equal(nquads(fits.text).length, 50_000, `${door}: the statements of the answer`);
      const refused = await read(over);
      assert.equal(refused.status, 413, `${door}, 50 001: ${fmt(refused)}`);
      assert.equal(refused.body?.code, 'view_construct_too_large', `${door}, 50 001`);
    }
  });

  it('another token\'s SPARQL view and a plain view have no Linked Data address', async () => {
    const id = await view(both.key, 'q762-mine', [A], KEEP_ENTITIES);
    const theirs = await d.sparqlRest(other.key, 'GET', `/ld/${id}/`, { headers: { Accept: 'application/n-quads' } });
    assert.equal(theirs.status, 404, fmt(theirs));
    assert.equal(theirs.body?.code, 'ld_not_found');
    const plain = await d.rest(both.key, 'POST', '/api/views', { name: 'q762-plain-ld', members: [A] });
    assert.equal(plain.status, 201, fmt(plain));
    const plainLd = await d.sparqlRest(both.key, 'GET', '/ld/@q762-plain-ld/', { headers: { Accept: 'application/n-quads' } });
    assert.equal(plainLd.status, 404, fmt(plainLd));
    assert.equal(plainLd.body?.code, 'ld_not_found');
  });
});
