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
 *   ids, the second, with the records seeded under their addressed ids, finds them stored and keeps their text ids, which are dearer), `need` the door counted is at least what the act's index
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
const RESUME = 'rdfmemresume';
const SPACES = [DOOR, ACT, DIFF, RESUME];
const LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';

/** The id of an addressed record of the file: a text id of 124 characters, dearer for the index than a minted one. */
const ownId = (i) => `${'rec-'.padEnd(120, 'x')}-${i}`;

/** Addressed records with long text ids under the space's own base, and two foreign ones with a bare edge between them. */
function addressedTurtle(space) {
  const v = `${baseOf(space)}vocab/`;
  const own = (i) => `<${baseOf(space)}entity/${ownId(i)}>`;
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

  it('a commit resumed under a smaller room finishes: once an import has planned, its second phase is never refused (finding 3)', async () => {
    const runner = await import('../../server/dist/spaces/space-act-runner.js');
    let failures = 0;
    act.setRdfImportKnobsForTest({
      window: 1,
      hooks: { afterCommitWindow: () => { if (failures === 0) { failures += 1; throw new Error('planted: the process stops after the first window'); } } },
    });
    try {
      const first = await d.importRest(writer.key, RESUME, goodTurtle(RESUME));
      assert.equal(first.status, 202, `the failed attempt stays owed: ${first.status} ${first.text.slice(0, 300)}`);
      const [entry] = d.actsOf(RESUME);
      assert.ok(entry, 'the act is owed');
      assert.ok((await d.records(RESUME, 'entities')).length >= 1, 'the first window landed before the failure');
      // The room fell while the act waited (a restart on a smaller instance): a refusal now would end the import with part of it written and its folder gone.
      act.setRdfImportKnobsForTest({ bounds: { memoryBytes: 100 } });
      const settled = await runner.runSpaceAct(entry.id);
      assert.equal(settled.ok, true, settled.error);
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.deepEqual((await d.records(RESUME, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob'], 'the resumed import did not land whole');
    assert.equal((await d.records(RESUME, 'edges')).length, 1);
    assert.deepEqual(d.actsOf(RESUME), []);
  });

  const asked =(body) => ({ bound: body?.bound, limit: body?.limit, need: body?.need });

  it('the door\'s path: the count refuses on REST and on MCP with the bound, the room and the need, registering no act and writing nothing', async () => {
    assert.equal(typeof act.setRdfImportKnobsForTest, 'function', 'the act module exports its test knobs');
    const room = 300;
    let registered = 0;
    act.setRdfImportKnobsForTest({ bounds: { memoryBytes: room }, hooks: { beforeRegister: () => { registered += 1; } } });
    try {
      const r = await d.importRest(writer.key, DOOR, goodTurtle(DOOR));
      assert.equal(r.status, 413, r.text.slice(0, 300));
      assert.equal(r.body?.code, 'rdf_bound_exceeded');
      assert.deepEqual({ bound: r.body?.bound, limit: r.body?.limit }, { bound: 'RDF_IMPORT_MAX_MEMORY', limit: room });
      assert.ok(Number.isInteger(r.body?.need) && r.body.need > room, `need is not a figure above the room: ${r.text.slice(0, 300)}`);
      assert.match(r.body?.error ?? '', /needs .* MiB for what the import holds in memory/);
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
      bounds: { memoryBytes: 1_000_000 },
      hooks: { beforeRegister: () => { act.setRdfImportKnobsForTest({ bounds: { memoryBytes: smaller } }); } },
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
    // The door's figure (`need`) comes first and the act's (`used`) after it, once per import.
    const hooks = { memory: (figure) => { if ('need' in figure) seen.push({ need: figure.need, first: figure.first }); else seen[seen.length - 1].used = figure.used; } };
    act.setRdfImportKnobsForTest({ bounds: { memoryBytes: 10_000_000 }, hooks });
    try {
      // First: the addressed records are not stored, so the act mints an id for each. Second, after the store is cleared and holds the three records
      // under their addressed ids: the act finds them stored and keeps their text ids in its index.
      const first = await d.importRest(writer.key, DIFF, addressedTurtle(DIFF));
      assert.equal(first.status, 200, `first: ${first.text.slice(0, 400)}`);
      await d.clear(DIFF);
      await d.seed(DIFF, 'entity', [0, 1, 2].map(i => ({ _id: ownId(i), name: `Stored ${i}`, type: 'person' })));
      const second = await d.importRest(writer.key, DIFF, addressedTurtle(DIFF));
      assert.equal(second.status, 200, `second: ${second.text.slice(0, 400)}`);
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(seen.length, 2, 'the hooks did not fire once per import');
    // The first phase's figure, not the larger of the two phases: the second is dearer on a file this small whatever the first is charged (finding 4).
    for (const [at, { first, used }] of seen.entries()) {
      assert.ok(Number.isInteger(first) && Number.isInteger(used) && used > 0, `import ${at + 1}: first ${first}, used ${used}`);
      assert.ok(first >= used, `import ${at + 1}: the door counted ${first} bytes for the first phase and the act's index then took ${used}: a file the door lets in could be refused by the act`);
    }
    assert.ok(seen[1].used > seen[0].used, 'the second import found no stored record, so it kept no text id (a probe that charges nothing proves nothing)');
    assert.equal((await d.records(DIFF, 'entities')).length, 5, 'the three stored records converged and the two foreign ones landed once');
  });
});
