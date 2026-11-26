/**
 * A SPARQL view is offered only where it is read, and a read of it says what it left out (bundle-273, Q-762, review S5 findings K3 and K5,
 * and the unproven points W3 and W4).
 *
 * ## The rules
 *
 * 1. **Offered where read (K3).** `tools/list` puts a SPARQL view in the `space` enum of the tools that read one (`export_rdf`,
 *    `sparql_query`) and of no other tool: the other tools that take a view answer it `409 view_is_construct`, and a caller must not be
 *    offered what is refused. A plain view is offered to every tool that takes a view.
 * 2. **A member left out is said (K5).** The Linked Data address of a SPARQL view answers `Ythril-View-Members` and
 *    `Ythril-View-Members-Without-Rdf` as the RDF export of the same view does: a member whose RDF is off is dropped from the CONSTRUCT's
 *    graph and never silently.
 * 3. **An address a space holds is the space's (W3).** A space whose explicit base is `<public url>/ld/@<name>/` is answered at that address
 *    for the owner of a SPARQL view of that name: the view does not shadow it.
 * 4. **HEAD states what GET answers (W4).** The `Content-Type` of a `HEAD` of a SPARQL view's export is the `GET`'s, whatever `edgeDetails`
 *    and format the request names.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-view-is-offered-and-announced-only-as-it-is-read-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const ON = 'q762o-on';
const OFF = 'q762o-off';
const SHADOW = 'q762o-shadow';
const PUBLIC = 'https://rdf.example.org';
const STAMP = '2026-03-04T05:06:07.000Z';
const ENTITY = 'https://w3id.org/ythril/ns#Entity';
const KEEP_ENTITIES = `CONSTRUCT { ?s ?p ?o } WHERE { ?s a <${ENTITY}> ; ?p ?o }`;
const NQUADS = { Accept: 'application/n-quads' };
const previousPublic = process.env['PUBLIC_BASE_URL'];

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
async function view(name, members, query) {
  const r = await d.rest(tok.key, 'POST', '/api/views', { name, members, ...(query ? { sparql: { query } } : {}) });
  assert.equal(r.status, 201, `create ${name}: ${fmt(r)}`);
  return `@${name}`;
}
/** Every enum a schema holds (a tool's `space` is one string with an enum, or a one-of with a list of them). */
function enumsOf(node) {
  if (Array.isArray(node)) return node.flatMap(enumsOf);
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => (k === 'enum' && Array.isArray(v) ? [v] : enumsOf(v)));
}

describe('a SPARQL view is offered and announced only as it is read', { skip }, () => {
  before(async () => {
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
    d = await openSparqlDoors({
      suite: 'q762o-offered',
      spaces: [
        { id: ON }, { id: OFF, meta: { suppressEmbeddings: true } },
        { id: SHADOW, meta: rdfMeta(SHADOW, { rdf: { enabled: true, base: `${PUBLIC}/ld/@q762o-team/`, vocab: `${PUBLIC}/ld/@q762o-team/vocab/`, baseEpoch: 0 } }) },
      ],
    });
    await d.seed(ON, 'entity', [{ _id: 'on-1', name: 'EntityOfOn', type: 'Thing', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(OFF, 'entity', [{ _id: 'off-1', name: 'EntityOfOff', type: 'Thing', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(SHADOW, 'entity', [{ _id: 'sh-1', name: 'EntityOfShadow', type: 'Thing', createdAt: STAMP, updatedAt: STAMP }]);
    const reads = d.row({ knowledge: 'read' });
    tok = await d.mint('q762o-owner', { [ON]: reads, [OFF]: reads, [SHADOW]: reads });
  });
  after(async () => {
    await d?.close();
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
  });

  it('tools/list offers a SPARQL view to the tools that read one and to no other; a plain view to every tool that takes a view (K3)', async () => {
    const construct = await view('q762o-construct', [ON], KEEP_ENTITIES);
    const plain = await view('q762o-plain', [ON]);
    const listed = await d.rpc(tok.key, 'tools/list');
    const tools = listed.result?.result?.tools ?? [];
    assert.ok(tools.length > 0, `no tools listed: ${JSON.stringify(listed.result).slice(0, 300)}`);
    const offering = (id) => tools.filter(t => enumsOf(t.inputSchema?.properties?.space).some(e => e.includes(id))).map(t => t.name).sort();
    assert.deepEqual(offering(construct), ['export_rdf', 'sparql_query'], 'the tools that offer the SPARQL view');
    const takers = offering(plain);
    assert.ok(takers.length > 2 && ['recall', 'filter', 'graph_traverse', 'export_rdf', 'sparql_query'].every(n => takers.includes(n)), `the tools that offer a plain view: ${takers.join(', ')}`);
  });

  it('the Linked Data address of a SPARQL view names the members it read and the ones left out, as the export does (K5)', async () => {
    const id = await view('q762o-announce', [ON, OFF], KEEP_ENTITIES);
    const exp = await d.sparqlRest(tok.key, 'GET', `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf?format=nquads`);
    assert.equal(exp.status, 200, fmt(exp));
    assert.equal(exp.headers['ythril-view-members-without-rdf'], OFF, 'control: the export names the member whose RDF is off');
    const ld = await d.sparqlRest(tok.key, 'GET', `/ld/${id}/`, { headers: NQUADS });
    assert.equal(ld.status, 200, fmt(ld));
    assert.equal(ld.headers['ythril-view-members'], exp.headers['ythril-view-members'], 'Ythril-View-Members');
    assert.equal(ld.headers['ythril-view-members-without-rdf'], OFF, 'Ythril-View-Members-Without-Rdf');
    assert.ok(!ld.text.includes('EntityOfOff'), 'the member whose RDF is off contributes nothing');
    assert.match(ld.headers['access-control-expose-headers'] ?? '', /Ythril-View-Members-Without-Rdf/i, 'a browser may read it');
  });

  it('a space whose base is /ld/@<name>/ is answered at it, not shadowed by the caller\'s SPARQL view of that name (W3)', async () => {
    await view('q762o-team', [ON], 'CONSTRUCT { <urn:q762o:view> <urn:q762o:says> "view" } WHERE { ?s a <' + ENTITY + '> }');
    const at = await d.sparqlRest(tok.key, 'GET', '/ld/@q762o-team/', { headers: NQUADS });
    assert.equal(at.status, 200, fmt(at));
    assert.ok(!at.text.includes('urn:q762o:view'), `the view shadowed the space's address: ${at.text.slice(0, 300)}`);
    assert.ok(at.text.includes('/ld/@q762o-team/'), `the space's own graph is not what answered: ${at.text.slice(0, 300)}`);
  });

  it('a HEAD of a SPARQL view\'s export states the Content-Type its GET answers, whatever edgeDetails and format it names (W4)', async () => {
    const id = await view('q762o-head', [ON], KEEP_ENTITIES);
    const url = (q) => `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf${q}`;
    for (const q of ['', '?format=turtle', '?format=turtle&edgeDetails=rdf12', '?format=turtle&edgeDetails=reification', '?format=nquads&edgeDetails=rdf12', '?format=jsonld']) {
      const got = await d.sparqlRest(tok.key, 'GET', url(q));
      const head = await d.sparqlRest(tok.key, 'HEAD', url(q));
      assert.equal(got.status, 200, `GET ${q}: ${fmt(got)}`);
      assert.equal(head.status, 200, `HEAD ${q}: ${head.status}`);
      assert.equal(head.headers['content-type'], got.headers['content-type'], `${q || '(no query)'}: HEAD and GET disagree on Content-Type`);
    }
  });
});
