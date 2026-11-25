/**
 * A SPARQL query whose read fails while the engine joins two or more patterns answers its refusal and leaves the process running
 * (bundle-271, Q-756; the 503 drive on a scratch instance: BSBM Q4 with `sparql.timeoutMs` 1000 stopped the server in 5 of 5 runs).
 *
 * ## What it prevents
 *
 * A quad source that raised its failure as an `error` event of a match stream. Inside a join the engine's iterators forward that error from
 * one to the next (asynciterator's `destinationEmitError`), and the join that holds no listener makes it an uncaught exception, which the
 * server's handler answers with `process.exit(1)`: a caller who can send a slow query could stop the server. A single pattern never showed it
 * (the stream's own consumer listens), so the earlier specs, which run one pattern, passed. Rules:
 *
 * 1. A join whose later finds are ended by the store's maximum time (code 50) answers `503 sparql_timeout`.
 * 2. A join whose own deadline fires while its finds are on their way answers `503 sparql_timeout`.
 * 3. A join whose later finds fail with a store error answers `503 sparql_store_unavailable`, never a `200` with the rows read so far.
 *
 * Each case asserts both halves: the answer, and that no uncaught exception and no unhandled rejection was raised.
 *
 * ## Seen red
 *
 * On c932747c9 the quad source ended a failed match stream with `destroy(err)`: the error reached a join with no listener.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-sparql-query-whose-deadline-fires-inside-a-join-ends-with-sparql-timeout-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';
import { delayFirstBatches, failFindsAfter, failFindsAt, recordProcessFaults, serverDriver } from './_quad-source-faults.mjs';

const skip = await mongoSkipReason();
const SPACE = 'qjoin';
const ROWS = 600;
const THING_CLASS = `${baseOf(SPACE)}vocab/entity/Thing`;
/**
 * Two joined patterns, as BSBM Q4 joins its own: the first holds a bound object, so the engine counts it as 1 and reads it first, and it
 * reads the second once per row of the first (a nested-loop join, whose inner reads are the match streams that fail).
 */
const JOIN = `SELECT ?s ?n WHERE { ?s <${THING_CLASS}#color> "red" . ?s <${THING_CLASS}#shape> "round" . ?s a <${THING_CLASS}> . ?s <http://www.w3.org/2000/01/rdf-schema#label> ?n }`;
const FIND_MS = 40;
/** A deadline a delayed find cannot meet: the first find answers inside it, the finds it starts do not. */
const DEADLINE_MS = 400;
const FIRST_BATCH_MS = 25;

let d, caller, quadSource, sparql;
const faults = recordProcessFaults();

const source = (opts = {}) => needModule(quadSource, ['createQuadSource'], 'the quad source')
  .createQuadSource({ members: [SPACE], caller }, { deadline: Date.now() + 60_000, ...opts });

/** The answer of `JOIN` over `src`: `{ rows }` or `{ error }`. */
async function answerOf(src, deadline) {
  const { checkSparqlAlgebra, runSparql } = needModule(sparql, ['checkSparqlAlgebra', 'runSparql'], 'the SPARQL engine');
  const checked = await checkSparqlAlgebra(JOIN);
  assert.ok('algebra' in checked, JSON.stringify(checked));
  const result = await runSparql(checked.algebra, src, { deadline });
  return result.rows().then((rows) => ({ rows }), (error) => ({ error }));
}

describe('a SPARQL query whose read fails inside a join answers its refusal and leaves the process running', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({ suite: 'qjoin_deadline', spaces: [{ id: SPACE, meta: rdfMeta(SPACE, { typeSchemas: { entity: { Thing: { propertySchemas: { color: { type: 'string' }, shape: { type: 'string' }, weight: { type: 'number' } } } } } }) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: ROWS }, (_, i) => ({ _id: `t-${String(i).padStart(4, '0')}`, name: `Thing ${i}`, type: 'Thing', properties: { color: 'red', shape: 'round', weight: i } })));
    caller = (await d.mint('qjoin-reader', { [SPACE]: d.row({ knowledge: 'read', files: 'read' }) })).record;
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
    sparql = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url);
  });
  after(async () => { faults.stop(); await d?.close(); });

  it('control: the join answers every row over an undisturbed store', async () => {
    const got = await answerOf(source(), Date.now() + 60_000);
    assert.ok(got.rows, `the control join was refused: ${got.error?.code ?? got.error?.message}`);
    assert.equal(got.rows.length, ROWS);
  });

  it('a join whose later finds are ended by the store\'s maximum time answers 503 sparql_timeout, and raises no fault', async () => {
    const { MongoServerError } = serverDriver();
    const restore = failFindsAfter(0, FIND_MS, () => new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' }));
    let got;
    const src = source();
    try { got = await answerOf(src, Date.now() + 60_000); } finally { restore(); }
    assert.equal(got.error?.code, 'sparql_timeout', `the join answered ${JSON.stringify(got).slice(0, 200)}`);
    assert.equal(got.error?.status, 503);
    assert.equal(src.failure()?.code, 'sparql_timeout');
    await faults.quiet();
  });

  it('a join whose own deadline fires while its finds are on their way answers 503 sparql_timeout, and raises no fault', async () => {
    const restore = delayFirstBatches(FIRST_BATCH_MS);
    let got;
    try { got = await answerOf(source(), Date.now() + DEADLINE_MS); } finally { restore(); }
    assert.equal(got.error?.code, 'sparql_timeout', `the join answered ${JSON.stringify(got).slice(0, 200)}`);
    assert.equal(got.error?.status, 503);
    await faults.quiet();
  });

  it('a join whose deadline falls at any moment of its run, finds still starting and answering, answers 503 sparql_timeout, and raises no fault', async () => {
    // The engine's timer destroys the result stream, which lets go of the iterators below it one after another, while a find that the store
    // ends at that very moment (the maximum time it was given is the time the query had left) raises its failure into whatever is left: the
    // two are moved across each other, so that the store's end lands before, with and after the timer.
    const { MongoServerError } = serverDriver();
    const answers = [];
    let endAt = 0;
    const restore = failFindsAt(() => endAt, () => new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' }));
    try {
      for (let offset = -4; offset <= 4; offset++) {
        for (let again = 0; again < 4; again++) {
          const deadline = Date.now() + 80;
          endAt = deadline + offset;
          answers.push((await answerOf(source(), deadline)).error?.code ?? 'answered');
        }
      }
    } finally { restore(); }
    assert.ok(answers.includes('sparql_timeout'), `no deadline ended the join: ${answers.join(' ')}`);
    assert.deepEqual(answers.filter((a) => a !== 'sparql_timeout' && a !== 'answered'), [], `a deadline was answered otherwise: ${answers.join(' ')}`);
    await faults.quiet();
  });

  it('a join whose source passes its deadline before the engine\'s timer fires answers 503 sparql_timeout, and raises no fault', async () => {
    // The deadline the source holds passes first (a timer that runs late behind a busy loop is the same order): the source's finds then
    // end with the timeout while the engine has not yet destroyed anything.
    const restore = delayFirstBatches(FIRST_BATCH_MS);
    try {
      // Where the reads are when the source's deadline passes differs from query to query, so the case is run at several moments.
      for (const at of [DEADLINE_MS / 2, DEADLINE_MS / 1.5, DEADLINE_MS, DEADLINE_MS * 1.25, DEADLINE_MS * 1.5]) {
        const src = source({ deadline: Date.now() + at });
        const got = await answerOf(src, Date.now() + 60_000);
        assert.equal(got.error?.code, 'sparql_timeout', `the join answered ${JSON.stringify(got).slice(0, 200)}`);
        assert.equal(got.error?.status, 503);
        assert.equal(src.failure()?.code, 'sparql_timeout');
      }
    } finally { restore(); }
    await faults.quiet();
  });

  it('a join whose later finds fail with a store error answers 503 sparql_store_unavailable, never 200, and raises no fault', async () => {
    const { MongoServerError } = serverDriver();
    const restore = failFindsAfter(0, FIND_MS, () => new MongoServerError({ message: 'the store is shutting down', code: 11600, codeName: 'InterruptedAtShutdown' }));
    let got;
    const src = source();
    try { got = await answerOf(src, Date.now() + 60_000); } finally { restore(); }
    assert.ok(!got.rows, `the join answered ${got.rows?.length} rows of a store that failed under it`);
    assert.equal(got.error?.code, 'sparql_store_unavailable', `the join answered ${JSON.stringify(got).slice(0, 200)}`);
    assert.equal(got.error?.status, 503);
    assert.equal(src.failure()?.code, 'sparql_store_unavailable');
    await faults.quiet();
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
