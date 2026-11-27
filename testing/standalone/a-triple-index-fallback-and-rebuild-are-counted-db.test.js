/**
 * A query that reads a space's records instead of its triple index, and every rebuild of an index, raise a counter (bundle-273, Q-764, pre-ship
 * lens finding O1).
 *
 * ## The rule
 *
 * An operator could not see how often queries fall back from the index to the records (a stale index, a lagging one, one a rebuild has not built
 * yet), nor whether the upkeep's rebuilds succeed. Two counters say it, listed in the guide's metrics table:
 *
 * - `ythril_rdf_index_reads_total{source}`: one per space a query reads, by where the query read it: `index`, or `records` (the index was
 *   not usable, or a rebuild swapped it while the query read it).
 * - `ythril_rdf_index_rebuilds_total{reason,outcome}`: one per rebuild, by why it started (`admin` for the door, the upkeep's reasons
 *   `missing`, `stale`, `journal`, `form`, `verify`, `unused-terms`) and how it ended (`built`, `busy`, `no-form`, `form-changed`, `stopped`,
 *   or `failed` when it threw).
 *
 * ## The cases
 *
 * 1. A query over a space with a built, caught-up index raises `reads{source=index}`; the same query after the index is marked stale raises
 *    `reads{source=records}` and not the first.
 * 2. A rebuild by hand raises `rebuilds{reason=admin,outcome=built}`; the upkeep's tick over a space with no index raises
 *    `rebuilds{reason=missing,outcome=built}`.
 *
 * ## Seen red
 *
 * On a075fa803: `Cannot find module` the metrics module (`server/dist/metrics/rdf-index-metrics.js`): neither counter exists.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-triple-index-fallback-and-rebuild-are-counted-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../_shared/wait-for.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';
import { landAll, followUntilReady, bendState, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule, verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixo-count';
const U = 'tixo-upkeep';
const ADMIN = { id: 'tixo-admin', admin: true, rights: { instanceAdmin: true } };
const NAMES = `SELECT ?n WHERE { ?s a <${baseOf(S)}vocab/entity/person> ; <http://www.w3.org/2000/01/rdf-schema#label> ?n }`;
let d, metrics;

const valueOf = async (counter, labels) => ((await counter.get()).values.find(v => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0);

/** Run NAMES on a fresh quad source over S; the label texts it answered. */
async function ask() {
  const engine = await import('../../server/dist/rdf/sparql-engine.js');
  const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
  const checked = await engine.checkSparqlAlgebra(NAMES);
  const deadline = Date.now() + 60_000;
  const source = createQuadSource({ members: [S], caller: ADMIN }, { deadline });
  const rows = await (await engine.runSparql(checked.algebra, source, { deadline })).rows(1_000, 64 * 1024 * 1024);
  return rows.length;
}

describe('the index fallback and the rebuilds are counted', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixo-count', spaces: [S, U].map(id => ({ id, meta: rdfMeta(id) })) });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([S, U].map(id => ({ id })));
    for (const space of [S, U]) await landAll(d, space, Array.from({ length: 10 }, (_, i) => ['entities', entityDoc(space, `p${i}`, `Person ${i}`, 'person')]));
    metrics = await import('../../server/dist/metrics/rdf-index-metrics.js');
  });
  after(async () => { await d?.close(); });

  it('counts a rebuild by hand and the rebuild the upkeep starts, each by reason and outcome', async () => {
    const before = await valueOf(metrics.rdfIndexRebuildsTotal, { reason: 'admin', outcome: 'built' });
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    assert.equal(await valueOf(metrics.rdfIndexRebuildsTotal, { reason: 'admin', outcome: 'built' }), before + 1, 'a rebuild by hand is counted as admin, built');
    await followUntilReady(d, S);
    // The upkeep rebuilds the other space (its index is missing); it starts the rebuild and does not wait for it.
    const missing = await valueOf(metrics.rdfIndexRebuildsTotal, { reason: 'missing', outcome: 'built' });
    await (await verifyModule()).upkeepTripleIndexes();
    await waitFor(async () => await valueOf(metrics.rdfIndexRebuildsTotal, { reason: 'missing', outcome: 'built' }) === missing + 1, 30_000, 50, undefined,
      { what: 'the upkeep rebuild to be counted' });
  });

  it('counts a space read from its index, and one read from its records', async () => {
    const index = () => valueOf(metrics.rdfIndexReadsTotal, { source: 'index' });
    const records = () => valueOf(metrics.rdfIndexReadsTotal, { source: 'records' });
    const [i0, r0] = [await index(), await records()];
    assert.equal(await ask(), 10);
    assert.deepEqual([await index(), await records()], [i0 + 1, r0], 'a query of a caught-up index is counted as an index read');
    const was = await bendState(d, S, { status: 'stale' });
    assert.equal(await ask(), 10, 'the records answer the same');
    assert.deepEqual([await index(), await records()], [i0 + 1, r0 + 1], 'a query that fell back to the records is counted as a records read');
    await bendState(d, S, { status: was.status });
  });
});
