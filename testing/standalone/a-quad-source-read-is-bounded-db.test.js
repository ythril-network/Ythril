/**
 * The quad source's bounds end a read with a named error, never with a short answer that looks whole, and its cardinality estimate never
 * tells the engine a pattern is empty when it may not be (bundle-271, Q-756; design §1.2, §1.3, r2 R3.3, R4.2, R4.4, R6).
 *
 * ## What it holds
 *
 * 1. **The read cap.** One counter of records read per query, shared by every match: a query that reads exactly the cap ends normally, the
 *    read of record cap+1 ends the stream with `sparql_too_much_read` (413). An ORDER BY that must read past the cap gets the same refusal
 *    through the engine.
 * 2. **countQuads.** It answers from estimates, so it must never answer 0 for a pattern whose candidate finds are not provably empty: an
 *    empty collection or a type with no rows still answers at least 1, a bound subject answers 1 without reading, and only a pattern no
 *    record can answer (a subject under no member's base) answers 0. A count that cannot be made (the deadline has passed) answers 1 and
 *    records `sparql_timeout` as the query's failure, which ends every read; it never answers 0 and never rejects.
 * 3. **The deadline.** A match after the deadline ends with `sparql_timeout` (503).
 * 4. **Cursors close on destroy.** A narrowed find holds a server cursor while its stream is read; destroying the stream (the engine stops
 *    reading, the caller goes away) closes it at once, never at the server's ten-minute idle timeout.
 *
 * ## Seen red
 *
 * On 2bfffd806: `server/src/rdf/quad-source.ts` does not exist. Mutations (seen red once it exists): the cap check made `>` the cap+1 read
 * ending normally; countQuads answering the raw estimate; the stream's destroy not closing its cursor.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-quad-source-read-is-bounded-db.test.js (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';
import { drain } from './_quad-source-fixture.mjs';
import { recordProcessFaults } from './_quad-source-faults.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';
import { elapse } from '../_shared/sleep.mjs';

const OPEN_BATCH_MS = 1_500;
const CLOSE_WITHIN_MS = 2_000;
const CLOSE_PROBE_MS = 50;

const skip = await mongoSkipReason();
/** Every unhandled rejection and uncaught exception of the file's run: the server ends its process on either, so none may be raised. */
const faults = recordProcessFaults();
const BULK = 'qbound';
const EMPTY = 'qboundempty';
const ROWS = 300;
const RDF_TYPE = { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' };
const named = (value) => ({ termType: 'NamedNode', value });
const LABEL = named('http://www.w3.org/2000/01/rdf-schema#label');
const BULK_CLASS = named(`${baseOf(BULK)}vocab/entity/Bulk`);

let d, caller, quadSource, sparql;

const source = (opts = {}, members = [BULK]) => needModule(quadSource, ['createQuadSource'], 'the quad source')
  .createQuadSource({ members, caller }, { deadline: Date.now() + 60_000, ...opts });

/** The idle server cursors open on the bulk entities collection: each one's filter and the documents it has handed out. */
async function idleCursors() {
  const { getMongo, getDb } = d.door.mongo;
  const ns = `${getDb().databaseName}.${d.spaceCollection(BULK, 'entities')}`;
  const ops = await getMongo().db('admin').aggregate([{ $currentOp: { idleCursors: true, allUsers: true } }, { $match: { type: 'idleCursor', ns } }]).toArray();
  return ops.map(op => JSON.stringify({ filter: op.cursor?.originatingCommand?.filter, returned: op.cursor?.nDocsReturned, batches: op.cursor?.nBatchesReturned }));
}
const openCursors = async () => (await idleCursors()).length;

describe('the quad source read is bounded and its estimate is never a false empty', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({
      suite: 'qbound',
      spaces: [{ id: BULK, meta: rdfMeta(BULK, { typeSchemas: { entity: { Bulk: {} } } }) }, { id: EMPTY, meta: rdfMeta(EMPTY) }],
    });
    await d.seed(BULK, 'entity', Array.from({ length: ROWS }, (_, i) => ({ _id: `b-${String(i).padStart(4, '0')}`, name: `Bulk ${String(ROWS - i).padStart(4, '0')}`, type: 'Bulk' })));
    caller = (await d.mint('qbound-reader', { [BULK]: d.row({ knowledge: 'read', files: 'read' }), [EMPTY]: d.row({ knowledge: 'read', files: 'read' }) })).record;
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
    sparql = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url);
  });
  after(async () => { faults.stop(); await d?.close(); });

  it('a query that reads exactly the cap ends normally, and records read are counted across matches', async () => {
    const s = source({ maxRecordsRead: ROWS });
    const all = await drain(s.match(undefined, RDF_TYPE, BULK_CLASS, undefined));
    assert.equal(all.length, ROWS);
    assert.equal(s.recordsRead(), ROWS);
    await assert.rejects(drain(s.match(named(`${baseOf(BULK)}entity/b-0000`), undefined, undefined, undefined)), (err) => err.code === 'sparql_too_much_read',
      'a second match of the same query read past the cap without the error');
  });

  it('the read of record cap+1 ends the stream with sparql_too_much_read (413), never a normal end', async () => {
    const s = source({ maxRecordsRead: ROWS - 1 });
    await assert.rejects(drain(s.match(undefined, RDF_TYPE, BULK_CLASS, undefined)), (err) => err.code === 'sparql_too_much_read' && err.status === 413);
    const walk = source({ maxRecordsRead: 10 });
    await assert.rejects(drain(walk.match(undefined, undefined, undefined, undefined)), (err) => err.code === 'sparql_too_much_read', 'the walk ended normally past the cap');
  });

  it('an ORDER BY that must read past the cap is refused through the engine', async () => {
    const { checkSparqlAlgebra, runSparql } = needModule(sparql, ['checkSparqlAlgebra', 'runSparql'], 'the SPARQL engine');
    const checked = await checkSparqlAlgebra('SELECT ?s ?n WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?n } ORDER BY ?n LIMIT 3');
    assert.ok('algebra' in checked, JSON.stringify(checked));
    const run = async (cap) => (await runSparql(checked.algebra, source({ maxRecordsRead: cap }), { deadline: Date.now() + 60_000 })).rows();
    const rows = await run(ROWS * 10);
    assert.equal(rows.length, 3, 'control: under the cap the ORDER BY answers');
    assert.equal(rows[0].n.value, 'Bulk 0001');
    await assert.rejects(run(ROWS - 1), (err) => err.code === 'sparql_too_much_read', 'the ORDER BY at the cap answered rows');
  });

  it('countQuads never answers 0 from an estimate, answers 1 for a bound subject, and 0 only when no record can answer', async () => {
    const s = source({}, [BULK, EMPTY]);
    const empty = source({}, [EMPTY]);
    assert.ok(await empty.countQuads(undefined, undefined, undefined, undefined) >= 1, 'an empty space answered 0 for an unbound pattern');
    assert.ok(await s.countQuads(undefined, RDF_TYPE, named(`${baseOf(BULK)}vocab/entity/Ghost`), undefined) >= 1, 'a type with no rows answered 0');
    assert.ok(await empty.countQuads(undefined, named(`${baseOf(EMPTY)}vocab/entity/Ghost#name`), undefined, undefined) >= 1, 'a property of a type with no rows answered 0');
    assert.ok(await s.countQuads(undefined, LABEL, undefined, undefined) >= ROWS, 'the label count (a walk of the kinds that write it) is not at least the rows');
    const before = s.recordsRead();
    assert.equal(await s.countQuads(named(`${baseOf(BULK)}entity/b-0001`), undefined, undefined, undefined), 1);
    assert.equal(s.recordsRead(), before, 'countQuads read records');
    assert.equal(await s.countQuads(named('https://elsewhere.example.org/x'), undefined, undefined, undefined), 0, 'a subject under no base');
  });

  it('a count or a match after the deadline is sparql_timeout (503), never 0 and never an empty end', async () => {
    const late = source({ deadline: Date.now() - 1 });
    // A count never rejects (the engine's handler for a rejected count raises an unhandled rejection): it answers 1 and the query's failure is the timeout.
    assert.equal(await late.countQuads(undefined, LABEL, undefined, undefined), 1, 'a count after the deadline answered 0, or rejected');
    assert.ok(late.failure()?.code === 'sparql_timeout' && late.failure()?.status === 503, 'the count after the deadline did not record sparql_timeout');
    await assert.rejects(drain(late.match(undefined, RDF_TYPE, BULK_CLASS, undefined)), (err) => err.code === 'sparql_timeout');
  });

  it('a narrowed find holds a cursor while read, and destroying its stream closes it at once', async () => {
    const baseline = await openCursors();
    const stream = source().match(undefined, RDF_TYPE, BULK_CLASS, undefined);
    await new Promise((resolve, reject) => { stream.once('data', resolve); stream.once('error', reject); });
    stream.pause();
    assert.ok(await openCursors() > baseline, 'no cursor was open while the stream was read (the fixture is too small to hold one)');
    stream.destroy();
    // Closed at once: the server's own idle timeout is ten minutes, so two seconds can only pass through the source's close.
    const closed = await holdsWithin(async () => (await openCursors()) <= baseline, CLOSE_WITHIN_MS, CLOSE_PROBE_MS);
    assert.ok(closed, `the cursor stayed open after its stream was destroyed: ${(await idleCursors()).join(' ')}`);
  });

  it('a stream destroyed as its first read starts, before its find has answered, leaves no cursor open (S1 review)', async () => {
    const baseline = await openCursors();
    // The destroy comes in the tick of the first read, and then a little later each round, so that some round lands while the find is on
    // its way to the server: there the cursor has no id to kill yet, and only a close after the first batch has arrived ends it.
    for (const offsetMs of [0, 0, 1, 2, 3, 5, 8, 13, 21]) {
      const stream = source().match(undefined, RDF_TYPE, BULK_CLASS, undefined);
      const closed = new Promise((resolve) => stream.once('close', resolve));
      stream.read();
      if (offsetMs > 0) await elapse(offsetMs, 'pacing: the destroy follows the first read by this long, to land in the find\'s flight');
      stream.destroy();
      await closed;
    }
    // The first batch of each find arrives after its stream is gone; a cursor that was closed too early stays open until the server's own
    // ten-minute idle timeout, so the window is the time the batches need, and the cursors must be back at the baseline at its end.
    await elapse(OPEN_BATCH_MS, 'absence window: the batches of the destroyed finds arrive, and a cursor left open shows idle');
    const back = await holdsWithin(async () => (await openCursors()) <= baseline, CLOSE_WITHIN_MS, CLOSE_PROBE_MS);
    assert.ok(back, `a cursor stayed open after its stream was destroyed with its find in flight: ${(await idleCursors()).join(' ')}`);
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
