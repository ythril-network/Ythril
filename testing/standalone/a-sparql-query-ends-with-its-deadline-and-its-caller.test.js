/**
 * A SPARQL query of any form ends when its deadline passes or its caller goes, stops reading its source when it does, and answers one way
 * (bundle-271, Q-756, S1 review M1, M2, m1, m2 and its test on the deadline; design §1.3, r2 R3.6, R4.1, R4.4).
 *
 * ## What it prevents
 *
 * - **An ASK that runs past its deadline.** An ASK was answered by the engine's own promise, which no deadline and no abort could end: a
 *   cross join under a FILTER ran until the source ended. An ASK now runs as a bounded read of one row, ended like a SELECT.
 * - **A SELECT whose deadline was never exercised.** The deadline is set about 250 ms ahead over a source that never ends and never
 *   answers a row: only the deadline can end it, mid-run (the source has been read), with `503 sparql_timeout`.
 * - **A second, unbounded run.** A result offers `rows` only: there is no `serialize` that would run the query again with no cap, no deadline
 *   and no abort, and count its reads twice.
 * - **A planning error that is no refusal.** A source that fails while the engine plans (it asks the source for counts) answers the refusal
 *   the source recorded, a 503 with its code, never the engine's own error.
 * - **A signal that was aborted before the query began.** It ends the query at once and reads nothing.
 *
 * ## Seen red
 *
 * On c647bd24f: the ASK cases run past their deadline and past their caller going (the answer never comes inside the window); `serialize`
 * is a function of the result; the planning error is the engine's own; the aborted signal is ignored and the source is read. The SELECT
 * deadline case passes there (it is the control a SELECT is ended by the same timer), and is seen red once its timer is not armed.
 * On d78b20280 (lens-1 R1): an abort or a deadline that lands while the engine plans rejected `rows()` without closing the stream the engine
 * then opened ("a stream obtained after the query had ended is left open: 2 open").
 *
 * Run: node --test testing/standalone/a-sparql-query-ends-with-its-deadline-and-its-caller.test.js (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DataFactory } from 'n3';
import { elapse } from '../_shared/sleep.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';
import { settleWithin } from './_write-faults.mjs';
import { recordProcessFaults } from './_quad-source-faults.mjs';

const { namedNode, literal, quad } = DataFactory;
const G = namedNode('https://rdf.example.org/ld/deadline/');
const PRED = namedNode('https://rdf.example.org/ld/deadline/vocab/n');
const ROW_EVERY_MS = 2;
/** The deadline of a query that only its deadline can end, ahead of the call. */
const DEADLINE_MS = 250;
/** The longest a query that is ended may take to answer, past its deadline or its caller going. */
const ANSWER_WITHIN_MS = 3_000;
const SETTLE_MS = 50;
/** Every unhandled rejection and uncaught exception of the file's run: the server ends its process on either, so none may be raised. */
const faults = recordProcessFaults();

const NEVER_TRUE = 'FILTER(STRLEN(STR(?o)) < 0)';

let engine, refusal;
/** Every fake source made, so `after` ends what a failing case left running. */
const made = [];

/**
 * A source of an RDF/JS kind that answers one statement every {@link ROW_EVERY_MS} ms, `size` of them (forever when `Infinity`), however it
 * is asked. It counts what it handed over and which of its streams are still open.
 */
function slowSource(size = Infinity, extra = {}) {
  const state = { matches: 0, delivered: 0, open: new Set() };
  const source = {
    state,
    match() {
      state.matches++;
      let i = 0;
      let timer = null;
      const stream = new Readable({
        objectMode: true,
        read() {
          if (i >= size) { this.push(null); return; }
          // Held, never unref'd: the engine's own deadline timer is unref'd (the server's sockets keep its process alive), so a wait on this
          // source is the only thing that keeps a test process alive. Node 22 (CI's) ends a process whose pending promise only unref'd timers
          // could settle ("Promise resolution is still pending but the event loop has already resolved"); Node 24 held it, so only CI saw it.
          // The timer is cleared by the stream's destroy, and `after` destroys every stream a case left open.
          timer = setTimeout(() => { state.delivered++; this.push(quad(namedNode(`${G.value}s/${i++}`), PRED, literal(String(i)), G)); }, ROW_EVERY_MS);
        },
        destroy(err, callback) { if (timer) clearTimeout(timer); state.open.delete(stream); callback(err); },
      });
      state.open.add(stream);
      stream.on('end', () => state.open.delete(stream));
      return stream;
    },
    countQuads: async () => size === Infinity ? 1_000_000 : size,
    ...extra,
  };
  made.push(source);
  return source;
}

/** Run `text` over `source` by `deadline`; the answer's `rows()` promise, never rejected before it is awaited. */
async function run(text, source, opts) {
  const { checkSparqlAlgebra, runSparql } = needModule(engine, ['checkSparqlAlgebra', 'runSparql'], 'the SPARQL engine');
  const checked = await checkSparqlAlgebra(text);
  assert.ok('algebra' in checked, JSON.stringify(checked));
  return runSparql(checked.algebra, source, opts);
}

/** `rows()` of the query, or what it did not answer inside {@link ANSWER_WITHIN_MS}: `{ rows }`, `{ error }` or `{ pending: true }`. */
async function answerOf(result) {
  // `settleWithin` clears its own timer, so the one that loses the race does not keep the process alive.
  const answered = await settleWithin(result.rows(), ANSWER_WITHIN_MS);
  if (!answered.settled) return { pending: true };
  return answered.ok ? { rows: answered.value } : { error: answered.error };
}

const readClosed = (source) => holdsWithin(() => source.state.open.size === 0, ANSWER_WITHIN_MS, SETTLE_MS);

describe('a SPARQL query ends with its deadline and its caller, whatever its form', () => {
  before(async () => {
    engine = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url);
    refusal = await loadDistModule('../../server/dist/rdf/sparql-refusal.js', import.meta.url);
    // The engine's first query builds it: the deadlines below start after that.
    const warm = await run('SELECT ?s WHERE { ?s ?p ?o }', slowSource(1), { deadline: Date.now() + 60_000 });
    await warm.rows();
  });
  after(() => { faults.stop(); for (const s of made) for (const stream of s.state.open) stream.destroy(); });

  it('a SELECT that only its deadline can end is ended by it, mid-run, with 503 sparql_timeout, and its source is no longer read', async () => {
    const source = slowSource();
    const result = await run(`SELECT ?s WHERE { ?s ?p ?o . ${NEVER_TRUE} }`, source, { deadline: Date.now() + DEADLINE_MS });
    const started = Date.now();
    const got = await answerOf(result);
    assert.ok(got.error, `the SELECT was not ended inside ${ANSWER_WITHIN_MS} ms of a ${DEADLINE_MS} ms deadline: ${JSON.stringify(got)}`);
    assert.equal(got.error.code, 'sparql_timeout', String(got.error.message));
    assert.equal(got.error.status, 503);
    assert.ok(Date.now() - started >= DEADLINE_MS / 2, 'it was refused before its deadline');
    assert.ok(source.state.delivered > 0, 'the source was never read: the deadline passed before the query began, so it was never exercised');
    assert.ok(await readClosed(source), `the source is still read after the deadline: ${source.state.open.size} streams open`);
  });

  it('an ASK that only its deadline can end is ended by it with 503 sparql_timeout, and its source is no longer read (S1 review M1)', async () => {
    const source = slowSource();
    const result = await run(`ASK { ?s ?p ?o . ${NEVER_TRUE} }`, source, { deadline: Date.now() + DEADLINE_MS });
    assert.equal(result.kind, 'boolean');
    const got = await answerOf(result);
    assert.ok(got.error, `the ASK ran past its ${DEADLINE_MS} ms deadline and was not ended inside ${ANSWER_WITHIN_MS} ms: ${JSON.stringify(got)}`);
    assert.equal(got.error.code, 'sparql_timeout', String(got.error.message));
    assert.ok(source.state.delivered > 0, 'the source was never read');
    assert.ok(await readClosed(source), `the source is still read after the deadline: ${source.state.open.size} streams open`);
  });

  it('an ASK whose caller goes away is ended and its source is no longer read (S1 review M1)', async () => {
    const source = slowSource();
    const ctl = new AbortController();
    const result = await run(`ASK { ?s ?p ?o . ${NEVER_TRUE} }`, source, { deadline: Date.now() + 60_000, signal: ctl.signal });
    const pending = answerOf(result);
    assert.ok(await holdsWithin(() => source.state.delivered > 0, ANSWER_WITHIN_MS, SETTLE_MS), 'the ASK read nothing while it ran');
    ctl.abort();
    const got = await pending;
    assert.ok(got.error, `the ASK went on after its caller went away: ${JSON.stringify(got)}`);
    assert.ok(await readClosed(source), `the source is still read after the caller went: ${source.state.open.size} streams open`);
  });

  it('an ASK answers a boolean: true at the first row (and reads no more), false over an empty source', async () => {
    const some = slowSource();
    const yes = await answerOf(await run('ASK { ?s ?p ?o }', some, { deadline: Date.now() + 60_000 }));
    assert.deepEqual(yes, { rows: true });
    assert.ok(await readClosed(some), 'the ASK went on reading after its answer was known');
    const none = await answerOf(await run('ASK { ?s ?p ?o }', slowSource(0), { deadline: Date.now() + 60_000 }));
    assert.deepEqual(none, { rows: false });
    const joined = await answerOf(await run('ASK { ?s ?p ?o . ?s ?p ?o2 }', slowSource(3), { deadline: Date.now() + 60_000 }));
    assert.deepEqual(joined, { rows: true });
  });

  it('a result offers rows and destroy only: no second run of the query that no cap, deadline or abort bounds (S1 review M2)', async () => {
    const result = await run('SELECT ?s WHERE { ?s ?p ?o }', slowSource(2), { deadline: Date.now() + 60_000 });
    assert.equal(typeof result.rows, 'function');
    assert.equal(typeof result.destroy, 'function');
    assert.equal('serialize' in result, false, 'a result still offers serialize, which runs the query again');
    await result.rows();
  });

  it('a source that fails while the engine plans answers the refusal it recorded, not the engine\'s own error (S1 review m1)', async () => {
    const { SparqlRefusal } = needModule(refusal, ['SparqlRefusal'], 'the SPARQL refusals');
    const recorded = new SparqlRefusal(503, 'sparql_store_unavailable', 'the store did not answer');
    // A source that throws when the engine first asks it to match (as the planner does, before any row is read).
    const source = slowSource(5, { match: () => { throw new Error('the read could not be started'); }, failure: () => recorded });
    const got = await run('SELECT ?s WHERE { ?s ?p ?o . ?o ?q ?r }', source, { deadline: Date.now() + 60_000 }).then(
      (result) => result.rows().then((rows) => ({ rows }), (error) => ({ error })),
      (error) => ({ error }),
    );
    assert.ok(got.error, `the query answered: ${JSON.stringify(got)}`);
    assert.equal(got.error, recorded, `the error is ${got.error?.name}: ${got.error?.message}, not the source's recorded refusal`);
  });

  it('an abort that lands while the engine plans ends the query when its rows are asked for, and closes the stream it opened (lens-1 R1)', async () => {
    const ctl = new AbortController();
    // The engine asks the source for counts while it plans: the caller goes at that moment, after the run began and before any read.
    const source = slowSource(5, { countQuads: async () => { ctl.abort(); return 5; } });
    const result = await run('SELECT ?s WHERE { ?s ?p ?o . ?o ?q ?r }', source, { deadline: Date.now() + 60_000, signal: ctl.signal });
    const got = await answerOf(result);
    assert.ok(got.error, `the query answered for a caller that went while it planned: ${JSON.stringify(got).slice(0, 200)}`);
    assert.ok(await readClosed(source), `a stream obtained after the query had ended is left open: ${source.state.open.size} open`);
  });

  it('a deadline that passes while the engine plans ends the query with 503 sparql_timeout and closes the stream it opened (lens-1 R1)', async () => {
    const source = slowSource(5, { countQuads: async () => { await elapse(DEADLINE_MS + SETTLE_MS, 'simulated latency: the engine plans for longer than the query\'s deadline'); return 5; } });
    const result = await run('SELECT ?s WHERE { ?s ?p ?o . ?o ?q ?r }', source, { deadline: Date.now() + DEADLINE_MS });
    const got = await answerOf(result);
    assert.equal(got.error?.code, 'sparql_timeout', JSON.stringify(got).slice(0, 200));
    assert.ok(await readClosed(source), `a stream obtained after the deadline is left open: ${source.state.open.size} open`);
  });

  it('a signal aborted before the query begins ends it at once and reads nothing (S1 review m2)', async () => {
    const source = slowSource();
    const ctl = new AbortController();
    ctl.abort();
    const got = await run('SELECT ?s WHERE { ?s ?p ?o }', source, { deadline: Date.now() + 60_000, signal: ctl.signal }).then(
      (result) => answerOf(result),
      (error) => ({ error }),
    );
    assert.ok(got.error, `the query answered for a caller that had already gone: ${JSON.stringify(got).slice(0, 200)}`);
    assert.equal(source.state.matches, 0, 'the source was read for a caller that had already gone');
  });

  it('a source stream that closes with no end and no error leaves no query pending: the read answers, with its deadline as the backstop', async () => {
    const base = slowSource();
    // The first row is handed over, then the stream is destroyed with no error: it emits `close` and never `end`.
    const source = { ...base, match: (...args) => { const stream = base.match(...args); stream.once('data', () => stream.destroy()); return stream; } };
    const result = await run('SELECT ?s WHERE { ?s ?p ?o }', source, { deadline: Date.now() + DEADLINE_MS });
    const got = await answerOf(result);
    assert.ok(!got.pending, `the read never answered, a stream closed with no end under it: ${JSON.stringify(got)}`);
    if (got.error) assert.equal(got.error.code, 'sparql_timeout', String(got.error.message));
    assert.ok(await readClosed(source), `a stream is left open: ${source.state.open.size} open`);
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
