/**
 * A triple index that no rebuild wrote is never read: the query reads the records, which state every record, also those the follower never
 * reads (bundle-273, Q-764, review finding G1; design-r2 R1; contract row 1).
 *
 * ## The rule
 *
 * The follower reads records by `pos` above where it stands, so a record with no `pos` (a pre-4.0 file row the carry cannot position, a row
 * written before the first 6.0 boot's carry) is never in an index the follower started. That index reads as ready: it starts at position 0,
 * its first short batch sets `ready`, and the barrier counts a lag only as `pos > appliedPos`. Only a rebuild reads every row whole, so the
 * read side asks for the one thing the follower cannot give: a build id. An index with none is read from the records, whatever its status.
 *
 * ## The cases
 *
 * 1. A space with positioned records and records without `pos` (written through the driver's own client, as an older build leaves them),
 *    whose index only the follower started: a query answers every record, from the records.
 * 2. The same space after a rebuild: the index is read, and it states the same records, the legacy ones included.
 *
 * ## Seen red
 *
 * On d5192c4f6: case 1 reads the member from its index and answers 60 of 80 names (the 20 records without a position are missing, no error).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-triple-index-no-rebuild-wrote-is-never-read-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openFixtureMongo } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf, rowTexts } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b273-tixg-unbuilt';
const S = 'tixg-unbuilt';
const ADMIN = { id: 'tixg-admin', admin: true, rights: { instanceAdmin: true } };
const NAMES = `SELECT ?n WHERE { ?s a <${baseOf(S)}vocab/entity/person> ; <http://www.w3.org/2000/01/rdf-schema#label> ?n } ORDER BY ?n`;
let d, admin;

/** Run `text` on a fresh quad source over S: the source and the sorted label texts. */
async function runOn(text) {
  const engine = await import('../../server/dist/rdf/sparql-engine.js');
  const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
  const checked = await engine.checkSparqlAlgebra(text);
  const deadline = Date.now() + 60_000;
  const source = createQuadSource({ members: [S], caller: ADMIN }, { deadline });
  const result = await engine.runSparql(checked.algebra, source, { deadline });
  const rows = await result.rows(100_000, 64 * 1024 * 1024);
  assert.equal(source.failure(), null, `the query read without a refusal: ${source.failure()?.message}`);
  return { source, texts: rows.map(r => r.n.value).sort() };
}

describe('a triple index no rebuild wrote is never read', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: SUITE, spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixg-admin', {}, { admin: true });
    const docs = [];
    for (let i = 0; i < 60; i++) docs.push(['entities', entityDoc(S, `p${i}`, `Person ${String(i).padStart(3, '0')}`, 'person')]);
    await landAll(d, S, docs);
    // The records an older build left: no `pos`, written on the driver's own client, so no journal row names them either.
    const raw = await openFixtureMongo(SUITE);
    try {
      const legacy = [];
      for (let i = 0; i < 20; i++) legacy.push(entityDoc(S, `legacy${i}`, `Legacy ${String(i).padStart(3, '0')}`, 'person'));
      await raw.col(d.spaceCollection(S, 'entities')).insertMany(legacy);
    } finally { await raw.close(); }
  });
  after(async () => { await d?.close(); });

  it('an index only the follower started is read from the records, which state every record', async () => {
    // The state a follower that started its own index left (the follower no longer starts one, so an upgrade from such a build plants it).
    await d.col(`${S}_rdf_state`).replaceOne({ _id: 'state' }, { status: 'ready', appliedPos: 0, formKey: 'older-build' }, { upsert: true });
    const state = await d.col(`${S}_rdf_state`).findOne({ _id: 'state' });
    assert.equal(state.buildId, undefined, 'a follower started this index: no rebuild wrote it');
    const viaDoor = await d.sparqlPost(admin.key, S, NAMES);
    assert.equal(viaDoor.status, 200, viaDoor.text);
    assert.equal(rowTexts(viaDoor.body).length, 80, 'the door answers the 60 positioned records and the 20 without a position');
    const ran = await runOn(NAMES);
    assert.deepEqual(ran.source.readPaths(), [{ space: S, path: 'records' }], 'the member is read from its records');
    assert.equal(ran.texts.length, 80);
  });

  it('after a rebuild the index is read and states the same records', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    const state = await followUntilReady(d, S);
    assert.equal(typeof state.buildId, 'string', 'the index names the build that wrote it');
    const ran = await runOn(NAMES);
    assert.deepEqual(ran.source.readPaths(), [{ space: S, path: 'index' }], 'the member is read from its index');
    assert.equal(ran.texts.length, 80, 'the index states the records without a position too');
  });
});
