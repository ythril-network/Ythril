/**
 * An RDF import that needs more memory than one import is given is refused 413 `rdf_bound_exceeded`, naming `RDF_IMPORT_MAX_MEMORY` with the room
 * (`limit`) and the need (`need`), on both doors and on both paths of the refusal, with nothing written; and the door's need is never below what
 * the act's index finally takes (bundle-384, Q-983, vet amendments G1, S6).
 *
 * ## What it holds
 *
 * - **The door's path** (the count before an act is registered): `POST .../import/rdf` and MCP `import_rdf` answer 413 with `{ bound, limit, need }`
 *   when the file's records cannot fit; no act is registered, no report kept, no record written.
 * - **The act's path** (an act that finds less room than the door did: a resumed import on a smaller instance): the room falls between the door's
 *   count and the act's translation (the hook between them), so the act ends the import 413 with the same `{ bound, limit, need }`, the space is
 *   released and nothing is written.
 * - **The door's need is never below the act's final use** (G1): for a file of addressed records with long ids, imported twice (the first mints
 *   ids, the second finds the records stored and keeps their text ids, which are dearer), `need` the door counted is at least what the act's index
 *   and sets then held, so a file the door lets in is never refused by the act for want of room.
 *
 * Run: node --test testing/standalone/an-rdf-import-past-its-memory-is-refused-whole-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta, goodTurtle, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const DOOR = 'rdfmemdoor';
const ACT = 'rdfmemact';
const DIFF = 'rdfmemdiff';
const SPACES = [DOOR, ACT, DIFF];
const LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';

/** Addressed records with long text ids under the space's own base, and two foreign ones with a bare edge between them. */
function addressedTurtle(space) {
  const v = `${baseOf(space)}vocab/`;
  const own = (i) => `<${baseOf(space)}entity/${'rec-'.padEnd(120, 'x')}-${i}>`;
  return [
    ...[0, 1, 2].map(i => `${own(i)} a <${v}entity/person> ; ${LABEL} "Person ${i}" .`),
    `${own(0)} <${v}edge/knows> ${own(1)} .`,
    '<http://people.example/zed> a <' + v + 'entity/person> ; ' + LABEL + ' "Zed" .',
    '<http://people.example/zed> <' + v + 'edge/knows> <http://people.example/yan> .',
    '<http://people.example/yan> a <' + v + 'entity/person> ; ' + LABEL + ' "Yan" .',
    '',
  ].join('\n');
}

describe('an RDF import past its memory is refused whole (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_memory', spaces: SPACES.map(id => ({ id, meta: personMeta(id, 'warn') })) });
    writer = await d.mint('rdf-memory-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'read' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js').catch(() => ({}));
  });
  after(async () => { act.setRdfImportKnobsForTest?.(null); await d?.close(); });

  const asked = (body) => ({ bound: body?.bound, limit: body?.limit, need: body?.need });

  it('the door\'s path: the count refuses on REST and on MCP with the bound, the room and the need, registering no act and writing nothing', async () => {
    assert.equal(typeof act.setRdfImportKnobsForTest, 'function', 'the act module exports its test knobs');
    const room = 300;
    let registered = 0;
    act.setRdfImportKnobsForTest({ memoryBytes: room, hooks: { beforeRegister: () => { registered += 1; } } });
    try {
      const r = await d.importRest(writer.key, DOOR, goodTurtle(DOOR));
      assert.equal(r.status, 413, r.text.slice(0, 300));
      assert.equal(r.body?.code, 'rdf_bound_exceeded');
      assert.deepEqual({ bound: r.body?.bound, limit: r.body?.limit }, { bound: 'RDF_IMPORT_MAX_MEMORY', limit: room });
      assert.ok(Number.isInteger(r.body?.need) && r.body.need > room, `need is not a figure above the room: ${r.text.slice(0, 300)}`);
      assert.match(r.body?.error ?? '', /needs at least .* MiB for the import's index and record sets/);
      assert.equal(r.body?.importId, undefined, 'no import was registered, so none is named');
      const m = await d.importMcp(writer.key, { space: DOOR, document: goodTurtle(DOOR), format: 'turtle' });
      assert.equal(m.isError, true, m.text.slice(0, 200));
      assert.deepEqual(asked(m.structured), { bound: 'RDF_IMPORT_MAX_MEMORY', limit: room, need: r.body.need }, `the tool answers the same figures: ${m.text.slice(0, 300)}`);
      assert.equal(registered, 0, 'an act was registered for a file the door refused');
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.deepEqual(d.actsOf(DOOR), []);
    assert.deepEqual(await d.records(DOOR, 'entities'), [], 'something was written');
    assert.deepEqual(await d.records(DOOR, 'edges'), []);
  });

  it('the act\'s path: a room that fell after the door\'s count ends the import 413 with the same figures, on REST and on MCP, the space released and nothing written', async () => {
    const smaller = 100;
    const arm = () => act.setRdfImportKnobsForTest({
      memoryBytes: 1_000_000,
      hooks: { beforeRegister: () => { act.setRdfImportKnobsForTest({ memoryBytes: smaller }); } },
    });
    try {
      arm();
      const r = await d.importRest(writer.key, ACT, goodTurtle(ACT));
      assert.equal(r.status, 413, r.text.slice(0, 400));
      assert.equal(r.body?.code, 'rdf_bound_exceeded');
      assert.deepEqual({ bound: r.body?.bound, limit: r.body?.limit }, { bound: 'RDF_IMPORT_MAX_MEMORY', limit: smaller }, r.text.slice(0, 400));
      assert.ok(Number.isInteger(r.body?.need) && r.body.need > smaller, r.text.slice(0, 400));
      assert.equal(typeof r.body?.importId, 'string', 'the act held the import, so its id is named');
      arm();
      const m = await d.importMcp(writer.key, { space: ACT, document: goodTurtle(ACT), format: 'turtle' });
      assert.equal(m.isError, true, m.text.slice(0, 300));
      assert.deepEqual({ bound: m.structured?.bound, limit: m.structured?.limit }, { bound: 'RDF_IMPORT_MAX_MEMORY', limit: smaller }, m.text.slice(0, 400));
      assert.ok(Number.isInteger(m.structured?.need) && m.structured.need > smaller, m.text.slice(0, 400));
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.deepEqual(d.actsOf(ACT), [], 'the act ended: the space is not held for ever');
    assert.deepEqual(await d.records(ACT, 'entities'), []);
    assert.deepEqual(await d.records(ACT, 'edges'), []);
  });

  it('the door\'s need is never below what the act\'s index finally took, for a first import (ids minted) and a second (records stored, text ids kept)', async () => {
    const seen = [];
    const hooks = { afterCount: (need) => { seen.push({ need }); }, afterTranslation: (used) => { seen[seen.length - 1].used = used; } };
    act.setRdfImportKnobsForTest({ memoryBytes: 10_000_000, hooks });
    try {
      for (const turn of ['first', 'second']) {
        const r = await d.importRest(writer.key, DIFF, addressedTurtle(DIFF));
        assert.equal(r.status, 200, `${turn}: ${r.text.slice(0, 400)}`);
      }
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(seen.length, 2, 'the hooks did not fire once per import');
    for (const [at, { need, used }] of seen.entries()) {
      assert.ok(Number.isInteger(need) && Number.isInteger(used) && used > 0, `import ${at + 1}: need ${need}, used ${used}`);
      assert.ok(need >= used, `import ${at + 1}: the door counted ${need} bytes and the act's index then took ${used}: a file the door lets in could be refused by the act`);
    }
    assert.ok(seen[1].used > seen[0].used, 'the second import found no stored record, so it kept no text id (a probe that charges nothing proves nothing)');
    assert.equal((await d.records(DIFF, 'entities')).length, 5, 'the three addressed records and the two foreign ones landed once');
  });
});
