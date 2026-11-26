/**
 * A triple index never answers with statements that differ from the records without falling back to them, around two writes the follower
 * and the journal do not see (bundle-273, Q-764, review findings G2 and G3; design-r2 R2, R4; contract rows 1 and 5).
 *
 * ## The rules
 *
 * 1. **G2: a 5.6 build's writes mark the index not ready.** A 5.6 build changes records without a position and without a journal row.
 *    The re-upgrade detector (`sync/positions-owed.ts` `detectReupgrade`) finds the spaces such a build touched and marks each owing a repair;
 *    it marks that space's triple index `stale` in the same pass, so the query reads the records until a rebuild states what they hold now.
 * 2. **G3: an unpositioned write while RDF is off marks the index not ready.** With RDF off the journal writes no row (the space has no
 *    form), and the index of the time before stays in `rdf_state`. A write no position names (chrono redaction, the retype's unstamp) made
 *    meanwhile changes a record the index states; the form key is the same once RDF is on again, so only a stale mark keeps the old
 *    statements from being read.
 *
 * ## Seen red
 *
 * On d5192c4f6: case 1 fails at its first check, the state is `ready` after the detector ran (a query answers the deleted record); case 2
 * fails at the state after the write (`ready`, not `stale`), and a query answers the title the record had before the write.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-is-held-to-its-records-around-a-write-it-did-not-see-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openFixtureMongo } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b273-tixw-around';
const FIVE = 'tixw-five';
const OFF = 'tixw-off';
const ADMIN = { id: 'tixw-admin', admin: true, rights: { instanceAdmin: true } };
const STAMP = '2026-03-04T05:06:07.000Z';
const EVERY = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';
let d;

/** The answer of `text` over `space`, from its index where it may (`index` true) or from the records alone: the texts and the read paths. */
async function answerOf(space, text, index) {
  const engine = await import('../../server/dist/rdf/sparql-engine.js');
  const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
  const checked = await engine.checkSparqlAlgebra(text);
  const deadline = Date.now() + 60_000;
  const source = createQuadSource({ members: [space], caller: ADMIN }, { deadline, ...(index ? {} : { index: false }) });
  const result = await engine.runSparql(checked.algebra, source, { deadline });
  const rows = await result.rows(100_000, 64 * 1024 * 1024);
  assert.equal(source.failure(), null, `the query read without a refusal: ${source.failure()?.message}`);
  const texts = rows.map(r => `${r.s.value} ${r.p.value} ${r.o.value}`).sort();
  return { texts, paths: source.readPaths() };
}

/** Rebuild `space` and bring its follower up: the index is ready, and one a rebuild wrote. */
async function builtIndex(space) {
  assert.equal((await (await rebuildModule()).rebuildTripleIndex(space)).outcome, 'built');
  return followUntilReady(d, space);
}

const stateOf = (space) => d.col(`${space}_rdf_state`).findOne({ _id: 'state' });

describe('a triple index is held to its records around a write it did not see', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: SUITE, spaces: [{ id: FIVE, meta: rdfMeta(FIVE) }, { id: OFF, meta: rdfMeta(OFF) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: FIVE }, { id: OFF }]);
    const people = (s) => Array.from({ length: 12 }, (_, i) => ['entities', entityDoc(s, `p${i}`, `Person ${String(i).padStart(2, '0')}`, 'person')]);
    await landAll(d, FIVE, people(FIVE));
    await landAll(d, OFF, [...people(OFF), ['chrono', {
      _id: 'c1', spaceId: OFF, seq: 1, title: 'Launch', type: 'event', status: 'upcoming', startsAt: '2026-07-04T10:00:00Z', endsAt: '2026-07-04T11:00:00Z',
      tags: [], createdAt: STAMP, updatedAt: STAMP, author: { instanceId: 'tix-author', instanceLabel: 'Tix' },
    }]]);
  });
  after(async () => { await d?.close(); });

  it('G2: a space a 5.6 build changed has its index marked stale by the re-upgrade detector, and is read from its records', async () => {
    await builtIndex(FIVE);
    const owed = await import('../../server/dist/sync/positions-owed.js');
    // A 5.6 build deletes a record on its own connection (no journal row, no tombstone, no position) and allocates in the space's counter.
    const raw = await openFixtureMongo(SUITE);
    try {
      await raw.col(d.spaceCollection(FIVE, 'entities')).deleteOne({ _id: 'p0' });
      await raw.col('ythril_counters').updateOne({ _id: FIVE }, { $set: { seq: 987654, seqSeenBy6: 1, positionsReadyAt: '2026-10-01T00:00:00.000Z' }, $unset: { positionsOwed: '' } }, { upsert: true });
    } finally { await raw.close(); }
    await d.loader.mutateConfig((cfg) => { cfg.positionsSince ??= '2026-10-01T00:00:00.000Z'; });
    await owed.detectReupgrade();
    assert.equal((await d.col('ythril_counters').findOne({ _id: FIVE })).positionsOwed, 'repair', 'the detector found the space');
    assert.equal((await stateOf(FIVE)).status, 'stale', 'the detector marked the index of the space it marked for repair stale');
    const fromRecords = await answerOf(FIVE, EVERY, false);
    const served = await answerOf(FIVE, EVERY, true);
    assert.deepEqual(served.paths, [{ space: FIVE, path: 'records' }], 'the stale member is read from its records');
    assert.deepEqual(served.texts, fromRecords.texts, 'and answers what the records answer');
    assert.equal(served.texts.some(t => t.includes('/p0 ')), false, 'the deleted record is not stated');
    await builtIndex(FIVE);
    const after_ = await answerOf(FIVE, EVERY, true);
    assert.deepEqual(after_.paths, [{ space: FIVE, path: 'index' }], 'after a rebuild the member is read from its index again');
    assert.deepEqual(after_.texts, fromRecords.texts, 'and it states what the records state');
    await d.col('ythril_counters').updateOne({ _id: FIVE }, { $set: { positionsReadyAt: '2026-10-01T00:00:00.000Z' }, $unset: { positionsOwed: '' }, $max: { seqSeenBy6: 987654 } });
  });

  it('G3: an unpositioned write made while RDF is off marks the index stale, so RDF on again never reads the old statements', async () => {
    await builtIndex(OFF);
    const setEnabled = (on) => d.loader.mutateConfig((cfg) => { cfg.spaces.find(s => s.id === OFF).meta.rdf.enabled = on; });
    await setEnabled(false);
    try {
      // Chrono redaction writes no position: the db door is all that sees it, and with RDF off it journals nothing.
      await d.col(d.spaceCollection(OFF, 'chrono')).updateOne({ _id: 'c1' }, { $set: { title: 'Redacted' } });
    } finally { await setEnabled(true); }
    assert.equal((await stateOf(OFF)).status, 'stale', 'the index the write could not reach is stale');
    const fromRecords = await answerOf(OFF, EVERY, false);
    assert.ok(fromRecords.texts.some(t => t.includes('Redacted')), 'the records state the new title');
    const served = await answerOf(OFF, EVERY, true);
    assert.deepEqual(served.texts, fromRecords.texts, 'a query answers what the records answer, not the statements of the time before');
    assert.deepEqual(served.paths, [{ space: OFF, path: 'records' }], 'the stale member is read from its records');
    await builtIndex(OFF);
    const after_ = await answerOf(OFF, EVERY, true);
    assert.deepEqual(after_.paths, [{ space: OFF, path: 'index' }], 'after a rebuild the member is read from its index again');
    assert.deepEqual(after_.texts, fromRecords.texts, 'and it states what the records state');
  });
});
