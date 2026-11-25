/**
 * A read that ends because its consumer destroyed the stream is never a store failure, and never the query's answer (bundle-271, Q-756;
 * the 503 diagnosis on a scratch instance, F1).
 *
 * ## What it prevents
 *
 * The engine stops reading a match the moment it has what it needs (a LIMIT, an ASK's first row, a join that settled), and destroys the
 * stream. A read still on its way to the store then ends with the driver's own error (`MongoExpiredSessionError` was measured: the session
 * its cursor held was ended under the batch in flight). `quadsOf` took that as a failure of the store, `fail` memoised it for the whole
 * query, and the next match of the same query, and the answer, was `503 sparql_store_unavailable` for a store that was well. Measured: the
 * first run of a query that reads two patterns answered 503 in 7 of 7 trials. A read that ended after its consumer left is no failure: the
 * query's `failure()` stays empty and its other matches read on.
 *
 * ## Seen red
 *
 * On a269d878c: `failure()` was the store refusal after the destroy ("a read the consumer ended was recorded as a store failure"), and the
 * next match of the same source ended with it.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-read-its-consumer-ended-is-no-store-failure-db.test.js (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';
import { drain } from './_quad-source-fixture.mjs';
import { failFirstBatches, recordProcessFaults, serverDriver } from './_quad-source-faults.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const SPACE = 'qconsumer';
const ROWS = 30;
/** How long a find's first batch is on its way, and how long into it the consumer leaves. */
const BATCH_MS = 150;
const LEAVES_AFTER_MS = 30;
const RDF_TYPE = { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' };
const named = (value) => ({ termType: 'NamedNode', value });
const THING_CLASS = named(`${baseOf(SPACE)}vocab/entity/Thing`);

let d, caller, quadSource;
const faults = recordProcessFaults();

const source = () => needModule(quadSource, ['createQuadSource'], 'the quad source')
  .createQuadSource({ members: [SPACE], caller }, { deadline: Date.now() + 60_000 });

describe('a read its consumer ended is no store failure', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({ suite: 'qconsumer', spaces: [{ id: SPACE, meta: rdfMeta(SPACE, { typeSchemas: { entity: { Thing: {} } } }) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: ROWS }, (_, i) => ({ _id: `t-${String(i).padStart(3, '0')}`, name: `Thing ${i}`, type: 'Thing' })));
    caller = (await d.mint('qconsumer-reader', { [SPACE]: d.row({ knowledge: 'read', files: 'read' }) })).record;
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
  });
  after(async () => { faults.stop(); await d?.close(); });

  it('a stream destroyed while its find is on its way leaves the query\'s failure empty, and the next match of the query reads on', async () => {
    const { MongoExpiredSessionError } = serverDriver();
    const s = source();
    const restore = failFirstBatches(BATCH_MS, () => new MongoExpiredSessionError());
    try {
      const stream = s.match(undefined, RDF_TYPE, THING_CLASS, undefined);
      const closed = new Promise((resolve) => stream.once('close', resolve));
      stream.read();
      await elapse(LEAVES_AFTER_MS, 'pacing: the consumer leaves this long into the find, while its first batch is on its way');
      stream.destroy();
      await closed;
    } finally { restore(); }
    assert.equal(s.failure(), null, `a read the consumer ended was recorded as the query's failure: ${s.failure()?.code}`);
    const all = await drain(s.match(undefined, RDF_TYPE, THING_CLASS, undefined));
    assert.equal(all.length, ROWS, 'the next match of the same query did not read the records');
  });

  it('a read that fails with the consumer still there is the store\'s failure, and ends the query with it (the control)', async () => {
    const { MongoExpiredSessionError } = serverDriver();
    const s = source();
    const restore = failFirstBatches(0, () => new MongoExpiredSessionError());
    try {
      await assert.rejects(drain(s.match(undefined, RDF_TYPE, THING_CLASS, undefined)), (err) => err.code === 'sparql_store_unavailable' && err.status === 503);
    } finally { restore(); }
    assert.equal(s.failure()?.code, 'sparql_store_unavailable', 'a failed read of a stream still listened to is not recorded');
    await assert.rejects(drain(s.match(undefined, RDF_TYPE, THING_CLASS, undefined)), (err) => err.code === 'sparql_store_unavailable', 'a later match of the query read on past a store failure');
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
