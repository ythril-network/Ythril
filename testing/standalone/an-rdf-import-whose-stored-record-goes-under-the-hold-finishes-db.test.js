/**
 * A stored record the import's dry plan judged goes away under the hold, and the import still finishes (bundle-270, tail find T7).
 *
 * ## What it holds
 *
 * The database's own expiry (the TTL index on `_expireAt`) removes a stored record while the import holds the space: after the dry plan judged
 * a converge onto it, or an edge that ends at it, and before the window that writes them commits. Two rules meet there: once the first window
 * landed nothing ends the act but finishing (second review F4), and nothing is retried for ever. Both hold when the act finishes and says what
 * it did not write:
 *
 * - a converge onto the gone record is NOT written (a supplied id never becomes a new record's identity: writing it would bring the record back
 *   under an id nothing names); an edge that ends at it is not written (an edge to a record that is not there);
 * - every other record of the file lands, once; the act ends (no retry owed), its folder is removed, the space takes writes again;
 * - the report answers it honestly: a recorded reason `stored_record_gone` per record left out, and the counts of what landed (not of what the
 *   dry plan expected).
 *
 * Run: node --test testing/standalone/an-rdf-import-whose-stored-record-goes-under-the-hold-finishes-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const until = (what, fn, ms = 30_000) => waitFor(fn, ms, 50, undefined, { what });
const CONVERGE = 'rdfimpgone1';
const EDGE = 'rdfimpgone2';
const SPACES = [CONVERGE, EDGE];
const ALICE = '44444444-4444-4444-8444-444444444444';
const LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';

describe('a stored record the dry plan judged goes under the hold; the import finishes and says what it left out (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act;
  const at = (space, id) => `${baseOf(space)}entity/${id}`;
  const person = (space) => `${baseOf(space)}vocab/entity/person`;
  const root = () => path.join(d.loader.getDataRoot(), act.RDF_IMPORT_DIR);

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_gone', spaces: SPACES.map(id => ({ id, meta: personMeta(id, 'warn') })) });
    writer = await d.mint('rdf-import-gone-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  /** Import `file` into `space`; the stored Alice is removed the way the expiry removes a record, after the dry plan and before the first window. */
  async function importWithAliceExpiring(space, file) {
    await d.seed(space, 'entity', [{ _id: ALICE, spaceId: space, name: 'Alice', type: 'person', seq: 1 }]);
    let removed = 0;
    act.setRdfImportKnobsForTest({
      window: 1,
      hooks: {
        beforeCommit: async () => { removed += (await d.col(d.spaceCollection(space, 'entities')).deleteOne({ _id: ALICE })).deletedCount; },
      },
    });
    let answer;
    try { answer = await d.importRest(writer.key, space, file, { params: { sourceBase: baseOf(space) } }); } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(removed, 1, 'the stored record went after the dry plan');
    return answer;
  }

  async function finished(space, answer) {
    assert.equal(answer.status, 200, `the act finishes in the request, not owed: ${answer.status} ${answer.text.slice(0, 300)}`);
    assert.equal(answer.body.status, 'completed', answer.text.slice(0, 300));
    assert.deepEqual(d.actsOf(space), [], 'no act is owed: nothing is retried');
    await until('its folder to be removed', () => !fs.existsSync(root()) || fs.readdirSync(root()).length === 0, 10_000);
    const save = await d.rest(writer.key, 'POST', `/api/brain/spaces/${space}/entities`, { name: `After ${space}`, type: 'person' });
    assert.ok(save.status < 300, `the space takes writes again: ${save.status} ${save.text?.slice(0, 200)}`);
    return answer.body;
  }

  it('a converge onto a record that expired is not written, and the rest of the file lands once', async () => {
    const file = [
      `<${at(CONVERGE, ALICE)}> a <${person(CONVERGE)}> ; ${LABEL} "Alice" .`,
      `<http://people.example/bob> a <${person(CONVERGE)}> ; ${LABEL} "Bob" .`,
      `<http://people.example/carol> a <${person(CONVERGE)}> ; ${LABEL} "Carol" .`,
      '',
    ].join('\n');
    const report = await finished(CONVERGE, await importWithAliceExpiring(CONVERGE, file));
    const names = (await d.records(CONVERGE, 'entities')).map(p => p.name).sort();
    assert.deepEqual(names, ['After rdfimpgone1', 'Bob', 'Carol'], 'Bob and Carol landed once; Alice did not come back under a new id');
    assert.deepEqual(report.kinds.entity, { inserted: 2, converged: 0 }, 'the counts are of what landed');
    assert.deepEqual(report.reasonsByCode, { stored_record_gone: 1 });
    assert.equal(report.reasons[0].outcome, 'recorded');
    assert.equal(report.reasons[0].kind, 'entity');
  });

  it('an edge that ends at a record that expired is not written, and the rest of the file lands once', async () => {
    const file = [
      `<http://people.example/bob> a <${person(EDGE)}> ; ${LABEL} "Bob" .`,
      `<http://people.example/carol> a <${person(EDGE)}> ; ${LABEL} "Carol" .`,
      `<http://people.example/bob> <${baseOf(EDGE)}vocab/edge/knows> <${at(EDGE, ALICE)}> .`,
      `<http://people.example/bob> <${baseOf(EDGE)}vocab/edge/knows> <http://people.example/carol> .`,
      '',
    ].join('\n');
    const report = await finished(EDGE, await importWithAliceExpiring(EDGE, file));
    const names = (await d.records(EDGE, 'entities')).map(p => p.name).sort();
    assert.deepEqual(names, ['After rdfimpgone2', 'Bob', 'Carol']);
    const edges = await d.records(EDGE, 'edges');
    assert.equal(edges.length, 1, 'the edge between the two that landed is stored; the one to the gone record is not');
    assert.deepEqual(report.kinds.edge, { inserted: 1, converged: 0 }, 'the counts are of what landed');
    assert.deepEqual(report.reasonsByCode, { stored_record_gone: 1 });
    assert.equal(report.reasons[0].outcome, 'recorded');
    assert.equal(report.reasons[0].kind, 'edge');
  });
});
