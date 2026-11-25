/**
 * A SPARQL query never makes the server open a connection: every form that names a remote source is refused with its named code before the
 * engine runs, a dataset naming an outside graph answers an empty graph, and the engine is built with no HTTP actor at all (bundle-271,
 * Q-756; design §1.3, r2 R2.1-R2.4).
 *
 * ## What it prevents
 *
 * Comunica 5.5.0 ships `actor-http-fetch` and a SERVICE executor in its closure: a `SERVICE <http://...>` clause, a `LOAD`, or a dataset
 * the engine dereferences would make the server fetch an address a caller chose. Three walls stand in the way, and each is held here:
 *
 * 1. the algebra walk (`checkSparqlAlgebra`) refuses SERVICE in any position (plain, SILENT, a variable target bound by VALUES, inside a
 *    subquery, OPTIONAL, MINUS, EXISTS and NOT EXISTS) as `sparql_federation_refused`, and every update form, LOAD included, as
 *    `sparql_update_not_here`;
 * 2. FROM, FROM NAMED and the protocol's `default-graph-uri` / `named-graph-uri` restrict the dataset to the graphs named; an outside graph
 *    holds nothing, so the answer is empty, never a refusal that would tell a caller which spaces exist;
 * 3. the engine (`runSparql`) runs with a fetch that rejects, and its HTTP bus has no actor.
 *
 * The update path (bundle-272, Q-965; vet-1 S4) keeps the same walls: its check (`checkSparqlUpdateAlgebra`) refuses SERVICE as
 * `sparql_federation_refused` and LOAD as `sparql_graph_management_refused`, and an update part that reaches the runner past the check
 * (`runSparqlUpdatePart`, the one runner without `readOnly`) runs on the same engine with the same refusing fetch, so it opens no
 * connection either.
 *
 * A local listener counts connections; every case must leave it at zero.
 *
 * ## Seen red
 *
 * On 2bfffd806: `server/src/rdf/sparql-engine.ts` does not exist. Mutation (seen red once it exists): the algebra walk removed, the SERVICE
 * cases answer an engine error, not their named code. On 3f48206ac (Q-965): the update-path cases fail, `sparql-engine.ts` exports no
 * `checkSparqlUpdateAlgebra` and no `runSparqlUpdatePart`.
 *
 * Run: node --test testing/standalone/a-sparql-query-never-reaches-the-network.test.js (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { Store, DataFactory } from 'n3';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const { namedNode, literal, quad } = DataFactory;
const G = 'https://rdf.example.org/ld/netspace/';
const P = 'https://rdf.example.org/ld/netspace/vocab/entity/Person';
const store = new Store([
  quad(namedNode(`${G}entity/a`), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(P), namedNode(G)),
  quad(namedNode(`${G}entity/a`), namedNode('http://www.w3.org/2000/01/rdf-schema#label'), literal('Ada'), namedNode(G)),
]);

let engine, listener, url, connections = 0;

const FEDERATION = 'sparql_federation_refused';
const UPDATE = 'sparql_update_not_here';
const GRAPH_MANAGEMENT = 'sparql_graph_management_refused';
/** The Update texts that name a remote source, each with the code the update path refuses it with. */
const UPDATE_REFUSED = (u) => [
  ['SERVICE in an update\'s WHERE', `INSERT { ?s ?p ?o } WHERE { SERVICE <${u}> { ?s ?p ?o } }`, FEDERATION],
  ['SERVICE SILENT in a DELETE WHERE', `DELETE { ?s ?p ?o } WHERE { SERVICE SILENT <${u}> { ?s ?p ?o } }`, FEDERATION],
  ['SERVICE in a composite\'s second part', `INSERT DATA { <${G}entity/b> <${G}vocab/k> "x" } ; INSERT { ?s ?p ?o } WHERE { SERVICE <${u}> { ?s ?p ?o } }`, FEDERATION],
  ['LOAD on the update path', `LOAD <${u}>`, GRAPH_MANAGEMENT],
  ['LOAD SILENT INTO GRAPH on the update path', `LOAD SILENT <${u}> INTO GRAPH <${G}>`, GRAPH_MANAGEMENT],
];
const REFUSED = (u) => [
  ['SERVICE', `SELECT * WHERE { SERVICE <${u}> { ?s ?p ?o } }`, FEDERATION],
  ['SERVICE SILENT', `SELECT * WHERE { SERVICE SILENT <${u}> { ?s ?p ?o } }`, FEDERATION],
  ['SERVICE ?v bound by VALUES', `SELECT * WHERE { VALUES ?v { <${u}> } SERVICE ?v { ?s ?p ?o } }`, FEDERATION],
  ['SERVICE in a subquery', `SELECT * WHERE { { SELECT ?s WHERE { SERVICE <${u}> { ?s ?p ?o } } } }`, FEDERATION],
  ['SERVICE in OPTIONAL', `SELECT * WHERE { ?s ?p ?o OPTIONAL { SERVICE <${u}> { ?s ?q ?r } } }`, FEDERATION],
  ['SERVICE in MINUS', `SELECT * WHERE { ?s ?p ?o MINUS { SERVICE <${u}> { ?s ?q ?r } } }`, FEDERATION],
  ['SERVICE in EXISTS', `SELECT * WHERE { ?s ?p ?o FILTER EXISTS { SERVICE <${u}> { ?s ?q ?r } } }`, FEDERATION],
  ['SERVICE in NOT EXISTS', `ASK { ?s ?p ?o FILTER NOT EXISTS { SERVICE <${u}> { ?s ?q ?r } } }`, FEDERATION],
  ['SERVICE in a CONSTRUCT', `CONSTRUCT { ?s ?p ?o } WHERE { SERVICE <${u}> { ?s ?p ?o } }`, FEDERATION],
  ['LOAD', `LOAD <${u}>`, UPDATE],
  ['LOAD SILENT INTO GRAPH', `LOAD SILENT <${u}> INTO GRAPH <${G}>`, UPDATE],
];

/** Run a check and, when it passes, the query; the refusal's code, or the rows. */
async function attempt(text, protocol) {
  const { checkSparqlAlgebra, runSparql } = needModule(engine, ['checkSparqlAlgebra', 'runSparql'], 'the SPARQL engine');
  const checked = await checkSparqlAlgebra(text, protocol);
  if ('refusal' in checked) return { refusal: checked.refusal };
  try {
    const result = await runSparql(checked.algebra, store, { deadline: Date.now() + 20_000 });
    return { rows: await result.rows() };
  } catch (err) {
    return { error: err };
  }
}

describe('a SPARQL query never reaches the network', () => {
  before(async () => {
    engine = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url);
    listener = await listenOnLoopback(net.createServer((socket) => { connections++; socket.destroy(); }));
    url = `http://127.0.0.1:${listener.port}/sparql`;
  });
  after(async () => { await listener?.close(); });

  for (const [what, , code] of REFUSED('http://127.0.0.1:1/')) {
    it(`${what} is refused as ${code}, and no connection is made`, async () => {
      const text = REFUSED(url).find(r => r[0] === what)[1];
      const before = connections;
      const got = await attempt(text);
      assert.equal(connections, before, `${what} opened a connection to the listener`);
      assert.equal(got.refusal?.code, code, `${what} answered ${JSON.stringify(got.refusal ?? got.error?.message ?? got.rows)}`);
      assert.equal(got.refusal.status, 400);
      assert.ok(!got.refusal.error.includes(url) || code === FEDERATION, 'the refusal repeats a query address it need not name');
    });
  }

  for (const [what, text, protocol] of [
    ['FROM an outside graph', () => `SELECT ?s FROM <${url}> WHERE { ?s ?p ?o }`, undefined],
    ['FROM NAMED an outside graph', () => `SELECT ?s FROM NAMED <${url}> WHERE { GRAPH ?g { ?s ?p ?o } }`, undefined],
    ['default-graph-uri naming an outside graph', () => 'SELECT ?s WHERE { ?s ?p ?o }', () => ({ defaultGraphUri: [url] })],
    ['named-graph-uri naming an outside graph', () => 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }', () => ({ namedGraphUri: [url] })],
  ]) {
    it(`${what} answers an empty graph, and no connection is made`, async () => {
      const before = connections;
      const got = await attempt(text(), protocol?.());
      assert.equal(connections, before, `${what} opened a connection to the listener`);
      assert.ok(!got.refusal, `${what} was refused (${got.refusal?.code}): an outside graph is empty, never named`);
      assert.ifError(got.error);
      assert.deepEqual(got.rows, [], `${what} answered rows`);
    });
  }

  it('control: the same query over the member graph answers its rows (so an empty answer above is the dataset, not a broken engine)', async () => {
    const got = await attempt(`SELECT ?s WHERE { ?s ?p ?o }`, { defaultGraphUri: [G] });
    assert.ifError(got.error);
    assert.equal(got.refusal, undefined);
    assert.equal(got.rows.length, 2);
  });

  for (const [what, , code] of UPDATE_REFUSED('http://127.0.0.1:1/')) {
    it(`${what} is refused as ${code}, and no connection is made`, async () => {
      const { checkSparqlUpdateAlgebra } = needModule(engine, ['checkSparqlUpdateAlgebra'], 'the SPARQL engine\'s update check');
      const text = UPDATE_REFUSED(url).find(r => r[0] === what)[1];
      const before = connections;
      const got = await checkSparqlUpdateAlgebra(text, G);
      assert.equal(connections, before, `${what} opened a connection to the listener`);
      assert.equal(got.refusal?.code, code, `${what} answered ${JSON.stringify(got.refusal ?? 'an algebra')}`);
      assert.equal(got.refusal.status, 400);
    });
  }

  it('an update part with SERVICE that reaches the update runner past the check fails, and no connection is made', async () => {
    const { runSparqlUpdatePart } = needModule(engine, ['runSparqlUpdatePart'], 'the SPARQL engine\'s update runner');
    const changeSets = await loadDistModule('../../server/dist/rdf/change-set-store.js', import.meta.url);
    const { ChangeSetStore, ChangeMeter } = needModule(changeSets, ['ChangeSetStore', 'ChangeMeter'], 'the change set store');
    // The algebra the check refuses, parsed by a fresh engine of the same package: a part past the walk, as a defect might hand it over.
    const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
    const { QueryEngine } = serverRequire('@comunica/query-sparql-rdfjs');
    const parsed = await new QueryEngine().explain(`INSERT { ?s ?p ?o } WHERE { SERVICE <${url}> { ?s ?p ?o } }`, { sources: [store] }, 'parsed');
    assert.equal(parsed.data.type, 'deleteinsert', `the parsed part is ${parsed.data.type}`);
    const destination = new ChangeSetStore({ graph: G, meter: new ChangeMeter(100, 1_000_000) });
    const before = connections;
    await assert.rejects(runSparqlUpdatePart(parsed.data, store, destination, { deadline: Date.now() + 20_000 }), 'the SERVICE part ran');
    assert.equal(connections, before, 'the update runner opened a connection to the listener');
    assert.deepEqual(destination.inserted(), [], 'the SERVICE part inserted statements');
  });

  it('the engine has no actor on its HTTP bus, so even a query past the walk cannot fetch', () => {
    const { httpBusActors } = needModule(engine, ['httpBusActors'], 'the SPARQL engine');
    const found = httpBusActors();
    assert.ok(Array.isArray(found.buses) && found.buses.length >= 1, 'no HTTP bus was found in the engine, so this asserts nothing');
    assert.deepEqual(found.actors, [], 'the engine can fetch');
  });
});
