/**
 * The quad source's `countQuads` never rejects: a count that cannot be made is the query's failure, recorded once, and the engine is told 1
 * (bundle-271, Q-756; the 503 diagnosis on a scratch instance, F2).
 *
 * ## What it prevents
 *
 * The engine asks `countQuads` for a pattern's cardinality and takes the answer as `.catch(error => it.destroy(error))` on a promise
 * (`actor-query-source-identify-rdfjs`, `QuerySourceRdfJs.setMetadata`). A `countQuads` that rejected with the query's refusal (the
 * memoised store failure, or the deadline) made that handler destroy an iterator nobody listens to for an error: an `unhandledRejection`
 * each, 17 to 43 per query measured, and the server ends the process on one. A count that cannot be made now answers 1 (the answer that
 * skips no pattern) after it recorded why through the query's `failure()`; the refusal then reaches the caller from the reads, as before.
 *
 * ## Seen red
 *
 * On e3ee6803b: `countQuads` rejected with the store refusal ("countQuads rejected"), and the process raised unhandled rejections while the
 * query ran.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-count-that-cannot-be-made-rejects-no-promise-db.test.js (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';
import { failCounts, recordProcessFaults, serverDriver } from './_quad-source-faults.mjs';
import { drainOf } from './_quad-source-fixture.mjs';

const skip = await mongoSkipReason();
const SPACE = 'qcount';
const ROWS = 20;
const RDF_TYPE = { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' };
const named = (value) => ({ termType: 'NamedNode', value });
const THING_CLASS = named(`${baseOf(SPACE)}vocab/entity/Thing`);
/** Two patterns: the engine asks for each one's count to plan the join. */
const JOIN = `SELECT ?s ?n WHERE { ?s a <${THING_CLASS.value}> . ?s <http://www.w3.org/2000/01/rdf-schema#label> ?n }`;

let d, caller, quadSource, sparql;
const faults = recordProcessFaults();

const source = (opts = {}) => needModule(quadSource, ['createQuadSource'], 'the quad source')
  .createQuadSource({ members: [SPACE], caller }, { deadline: Date.now() + 60_000, ...opts });

const storeDown = () => {
  const { MongoServerError } = serverDriver();
  return new MongoServerError({ message: 'the store is shutting down', code: 11600, codeName: 'InterruptedAtShutdown' });
};

describe('a count that cannot be made rejects no promise', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({ suite: 'qcount_noreject', spaces: [{ id: SPACE, meta: rdfMeta(SPACE, { typeSchemas: { entity: { Thing: {} } } }) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: ROWS }, (_, i) => ({ _id: `t-${String(i).padStart(3, '0')}`, name: `Thing ${i}`, type: 'Thing' })));
    caller = (await d.mint('qcount-reader', { [SPACE]: d.row({ knowledge: 'read', files: 'read' }) })).record;
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
    sparql = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url);
  });
  after(async () => { faults.stop(); await d?.close(); });

  it('a count the store fails answers 1 and records the store refusal as the query\'s failure', async () => {
    const s = source();
    const restore = failCounts(storeDown);
    let counted;
    try {
      counted = await s.countQuads(undefined, RDF_TYPE, undefined, undefined).then((n) => ({ n }), (error) => ({ error }));
    } finally { restore(); }
    assert.ok(!counted.error, `countQuads rejected: ${counted.error?.code ?? counted.error?.message}`);
    assert.equal(counted.n, 1, 'a count that could not be made is not told to the engine as anything but 1');
    assert.equal(s.failure()?.code, 'sparql_store_unavailable', 'the failure of the count was not recorded for the query');
  });

  it('a count asked after the deadline answers 1 and records sparql_timeout, and the reads then end with it', async () => {
    const late = source({ deadline: Date.now() - 1 });
    const counted = await late.countQuads(undefined, RDF_TYPE, undefined, undefined).then((n) => ({ n }), (error) => ({ error }));
    assert.ok(!counted.error, `countQuads rejected: ${counted.error?.code}`);
    assert.equal(counted.n, 1);
    assert.equal(late.failure()?.code, 'sparql_timeout');
    await assert.rejects(drainOf(late, late.match(undefined, RDF_TYPE, THING_CLASS, undefined)), (err) => err.code === 'sparql_timeout');
  });

  it('a query over a store whose counts fail answers the store refusal, and the engine\'s count handlers raise nothing', async () => {
    const { checkSparqlAlgebra, runSparql } = needModule(sparql, ['checkSparqlAlgebra', 'runSparql'], 'the SPARQL engine');
    const checked = await checkSparqlAlgebra(JOIN);
    assert.ok('algebra' in checked, JSON.stringify(checked));
    const restore = failCounts(storeDown);
    let got;
    try {
      const result = await runSparql(checked.algebra, source(), { deadline: Date.now() + 60_000 });
      got = await result.rows().then((rows) => ({ rows }), (error) => ({ error }));
    } finally { restore(); }
    assert.equal(got.error?.code, 'sparql_store_unavailable', `the query answered ${JSON.stringify(got).slice(0, 200)}`);
    assert.equal(got.error?.status, 503);
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
