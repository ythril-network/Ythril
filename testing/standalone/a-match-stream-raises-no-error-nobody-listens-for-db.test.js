/**
 * A match stream never raises an error event nobody listens for, so a deadline or an abort that lands on a destroyed stream cannot end the
 * process (bundle-271, Q-756; the 503 diagnosis on a scratch instance, F3).
 *
 * ## What it prevents
 *
 * A `sparql_timeout` refusal was seen emitted as `error` on a match stream with no error listener: an uncaught exception, which the server's
 * handler answers with `process.exit(1)`. It was seen once, only under a tracing hook, so the path is unproven; the rule is held by
 * construction instead: the stream carries an error listener of its own from its construction, so an error it raises, or a cause its
 * consumer destroys it with (the engine's `end(timeoutRefusal())`), reaches the listeners there are and never the process. The deadline's and
 * the abort's ends are told to the caller by the query's refusal, never by an event nobody listens for.
 *
 * ## Seen red
 *
 * On e3ee6803b: a stream whose read failed (the deadline had passed) and a stream destroyed with the timeout refusal, each with no error
 * listener, raised an uncaught exception ("the process raised faults").
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-match-stream-raises-no-error-nobody-listens-for-db.test.js (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';
import { delayFirstBatches, recordProcessFaults } from './_quad-source-faults.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const SPACE = 'qnolisten';
const ROWS = 20;
const BATCH_MS = 400;
const DEADLINE_MS = 150;
const RDF_TYPE = { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' };
const named = (value) => ({ termType: 'NamedNode', value });
const THING_CLASS = named(`${baseOf(SPACE)}vocab/entity/Thing`);

let d, caller, quadSource, refusal, sparql;
const faults = recordProcessFaults();

const source = (opts = {}) => needModule(quadSource, ['createQuadSource'], 'the quad source')
  .createQuadSource({ members: [SPACE], caller }, { deadline: Date.now() + 60_000, ...opts });

describe('a match stream raises no error nobody listens for', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({ suite: 'qnolisten', spaces: [{ id: SPACE, meta: rdfMeta(SPACE, { typeSchemas: { entity: { Thing: {} } } }) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: ROWS }, (_, i) => ({ _id: `t-${String(i).padStart(3, '0')}`, name: `Thing ${i}`, type: 'Thing' })));
    caller = (await d.mint('qnolisten-reader', { [SPACE]: d.row({ knowledge: 'read', files: 'read' }) })).record;
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
    refusal = await loadDistModule('../../server/dist/rdf/sparql-refusal.js', import.meta.url);
    sparql = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url);
  });
  after(async () => { faults.stop(); await d?.close(); });

  it('a stream whose read ends with the deadline, with no error listener, raises nothing and closes', async () => {
    const stream = source({ deadline: Date.now() - 1 }).match(undefined, RDF_TYPE, THING_CLASS, undefined);
    const closed = new Promise((resolve) => stream.once('close', resolve));
    stream.read();
    await closed;
    assert.equal(stream.destroyed, true);
  });

  it('a stream its consumer destroys with the timeout refusal, with no error listener, raises nothing', async () => {
    const { timeoutRefusal } = needModule(refusal, ['timeoutRefusal'], 'the SPARQL refusals');
    const stream = source().match(undefined, RDF_TYPE, THING_CLASS, undefined);
    const closed = new Promise((resolve) => stream.once('close', resolve));
    stream.read();
    await elapse(10, 'pacing: the engine\'s deadline lands while the read is in flight');
    stream.destroy(timeoutRefusal());
    await closed;
  });

  it('a deadline that passes while the engine waits for a find answers sparql_timeout and the process lives', async () => {
    const { checkSparqlAlgebra, runSparql } = needModule(sparql, ['checkSparqlAlgebra', 'runSparql'], 'the SPARQL engine');
    const checked = await checkSparqlAlgebra(`SELECT ?s WHERE { ?s a <${THING_CLASS.value}> }`);
    assert.ok('algebra' in checked, JSON.stringify(checked));
    const restore = delayFirstBatches(BATCH_MS);
    let got;
    try {
      const result = await runSparql(checked.algebra, source({ deadline: Date.now() + DEADLINE_MS }), { deadline: Date.now() + DEADLINE_MS });
      got = await result.rows().then((rows) => ({ rows }), (error) => ({ error }));
      await elapse(BATCH_MS + 100, 'absence window: the find\'s first batch arrives after the deadline has ended the query');
    } finally { restore(); }
    assert.equal(got.error?.code, 'sparql_timeout', `the query answered ${JSON.stringify(got).slice(0, 200)}`);
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
