/**
 * Two holders of an RDF import that grew with its file and were charged to no room are charged now (bundle-384, Q-983, second fix round, findings 1
 * and 2: the adversarial review of the last round).
 *
 * ## The rule
 *
 * - **The dry plan's edge read set** (`import-edge-plan.ts`): every edge window used to plan in one read set kept for the whole file, which grows by each
 *   planned edge (BSBM at 10 000 products makes 822 342 edges), after the index and the sets the door counted were gone. The dry plan now frees the read
 *   set with its window unless the plan needs what an earlier window planned (a functional edge label, a reified edge), and a plan that shares it charges
 *   each edge it plans to the second phase's room; the door's count charges the same, so a file whose second phase passes the room is refused
 *   before anything is written, with the whole need.
 * - **A label-only subject of the inference** (`schema-from-data.ts`): the inference keeps the address, the group key and every label of an address
 *   described by labels alone, in full, however long. They are charged by their characters as the first pass reads them, so a file of such subjects
 *   with long labels is refused naming the memory bound, not a flat figure a subject.
 *
 * The bytes an edge costs in the shared read set are measured by `the-import-memory-charges-the-edge-plan-db.test.js`.
 *
 * Run: node --test testing/standalone/the-import-memory-charges-the-edge-plan-and-the-label-subjects.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { importOrFail } from '../_shared/import-or-fail.mjs';

const memory = () => importOrFail('server/dist/rdf/import-memory.js', 'the import\'s memory room and what a holder costs (Q-983)');
const countModule = () => importOrFail('server/dist/rdf/import-count.js', 'the door\'s count (Q-983)');
const edgePlanModule = () => importOrFail('server/dist/rdf/import-edge-plan.js', 'the dry plan\'s edge read sets (Q-983 second fix round)');
const reverseModule = () => importOrFail('server/dist/rdf/term-reverse.js', 'the reverse addressing');
const dataModule = () => importOrFail('server/dist/rdf/schema-from-data.js', 'the inference from data (Q-755)');

const BASE = 'https://rdf.example.org/ld/notes/';
const typeSchemas = (functional) => ({ edge: { knows: { ...(functional ? { functional: true } : {}) } } });
const metaOf = (functional) => ({ rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/` }, typeSchemas: typeSchemas(functional) });
const iri = (value) => ({ kind: 'iri', value });
const KNOWS = iri(`${BASE}vocab/edge/knows`);
const RDFS_LABEL = iri('http://www.w3.org/2000/01/rdf-schema#label');
const asGroups = (list) => async function* () { yield* list; };

/** `subjects` subjects each asserting `perSubject` edges to foreign objects, none reified: that many statements of the asserted set and bare edges. */
const edgeGroups = (subjects, perSubject) => asGroups(Array.from({ length: subjects }, (_, i) => {
  const subject = iri(`http://people.example/s${i}`);
  return { key: subject.value, subject, quads: Array.from({ length: perSubject }, (_, j) => ({ subject, predicate: KNOWS, object: iri(`http://people.example/o${i}-${j}`) })) };
}));

describe('the door counts the shared read set of the dry plan beside the minted ends, and a file that passes the room with it is refused whole', () => {
  it('a plan that shares its edge read set (a functional label) is refused when the edges it plans pass the room, with the whole need; a plan that frees it is not charged', async () => {
    const { MINTED_ENTRY_BYTES, SET_ENTRY_BYTES, MINTED_END_BYTES, ENDS_COPY_BYTES } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { EDGE_PLAN_BYTES } = await edgePlanModule();
    const { addressNames } = await reverseModule();
    const SUBJECTS = 20;
    const PER = 3;
    const first = SUBJECTS * MINTED_ENTRY_BYTES + SUBJECTS * PER * (SET_ENTRY_BYTES + MINTED_ENTRY_BYTES);
    const ends = SUBJECTS * (MINTED_END_BYTES + ENDS_COPY_BYTES);
    const shared = ends + SUBJECTS * PER * EDGE_PLAN_BYTES;
    assert.ok(first < shared && ends < first, `the fixture has no room between the phases (first ${first}, ends ${ends}, shared ${shared})`);
    const room = first + 1;
    const names = addressNames(metaOf(true));
    await assert.rejects(assertRecordsWithinBound(edgeGroups(SUBJECTS, PER)(), () => names, room, typeSchemas(true)), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY'
      && err.limit === room && err.need === shared && !/at least/.test(err.message), 'a file whose shared edge read set passes the room was not refused with the whole need');
    const freed = await assertRecordsWithinBound(edgeGroups(SUBJECTS, PER)(), () => addressNames(metaOf(false)), room, typeSchemas(false));
    assert.equal(freed.need, first, 'a plan that frees the read set per window was charged for it');
    assert.equal(freed.second, ends, 'the second phase of a plan that frees it is the ends alone');
  });
});

describe('the dry plan plans an edge window in a fresh read set unless the plan needs what an earlier window planned', () => {
  const edgeOp = (correlation) => ({ op: 'insert', kind: 'edge', id: correlation, correlation, graph: null, fields: {} });
  const entityOp = { op: 'insert', kind: 'entity', id: 'e', correlation: 'e', graph: null, fields: {} };

  it('bare edges of non-functional labels: every window its own read set, nothing charged', async () => {
    const { EdgeReadSets } = await edgePlanModule();
    const { ImportMemoryMeter } = await memory();
    const meter = new ImportMemoryMeter(1_000_000);
    const sets = new EdgeReadSets(typeSchemas(false), meter, () => ({}));
    const a = sets.forWindow([edgeOp('["a","knows","b"]')]);
    const b = sets.forWindow([edgeOp('["c","knows","d"]')]);
    assert.notEqual(a, b, 'two windows of bare edges planned in one read set that grows with the file');
    sets.planned(500);
    assert.equal(meter.used, 0, 'a freed read set was charged');
  });

  it('a functional label shares one read set from the first window, and each edge it plans is charged', async () => {
    const { EdgeReadSets, EDGE_PLAN_BYTES } = await edgePlanModule();
    const { ImportMemoryMeter } = await memory();
    const meter = new ImportMemoryMeter(1_000_000);
    const sets = new EdgeReadSets(typeSchemas(true), meter, () => ({}));
    const a = sets.forWindow([edgeOp('["a","knows","b"]')]);
    const b = sets.forWindow([edgeOp('["a","knows","c"]')]);
    assert.equal(a, b, 'the edges of one subject in two windows were not planned in one read set');
    sets.planned(3);
    assert.equal(meter.used, 3 * EDGE_PLAN_BYTES);
  });

  it('a reified edge starts sharing at its window, and a window before it, of bare edges, is not charged', async () => {
    const { EdgeReadSets, EDGE_PLAN_BYTES } = await edgePlanModule();
    const { ImportMemoryMeter } = await memory();
    const meter = new ImportMemoryMeter(1_000_000);
    const sets = new EdgeReadSets(typeSchemas(false), meter, () => ({}));
    sets.forWindow([edgeOp('["a","knows","b"]')]);
    sets.planned(2);
    assert.equal(meter.used, 0);
    const first = sets.forWindow([entityOp, edgeOp('http://people.example/reifier')]);
    const second = sets.forWindow([edgeOp('http://people.example/reifier2')]);
    assert.equal(first, second, 'two windows with reified edges were planned in two read sets');
    sets.planned(4);
    assert.equal(meter.used, 4 * EDGE_PLAN_BYTES);
  });

  it('the act plans its edge windows through it and the meter of a run is a fork of the second phase\'s (source gate)', async () => {
    const fs = await import('node:fs');
    const { REPO_ROOT } = await import('./_sources.mjs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const act = stripComments(fs.readFileSync(`${REPO_ROOT}/server/src/spaces/rdf-import-act.ts`, 'utf8'));
    assert.match(act, /new EdgeReadSets\(/, 'the act plans its edge windows in a read set it made itself');
    assert.doesNotMatch(act, /const edges = importReadSet\(/, 'the dry plan makes one edge read set for the whole file again');
    assert.match(act, /minted\.meter\.resumed\(\)/,'a dry plan run charges the second phase\'s meter for good: a run that is made again is charged twice');
  });
});

describe('an edge the shared read set keeps is charged what it costs on the heap', { timeout: 120_000 }, () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const liveHeap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
  const flat = (s) => Buffer.from(s, 'utf8').toString('utf8');
  const AT_LEAST = 0.65;
  const POWER = 2 ** 15;

  // The planner's own document of an inserted edge (`planEdge`): its ids and times as fresh strings, the stamps a strict space gives it, and the
  // seeds of its two ends (`seedImported`), which the window that planned it leaves in the set.
  for (const [at, count] of [['just past a power of two', POWER + 1], ['near full', POWER - 64]]) {
    it(`${count} planned edges (${at}): the heap per edge in the read set is within the charge and at least ${AT_LEAST} of it`, async () => {
      const { ReadSet } = await importOrFail('server/dist/brain/write-plan/read-set.js', 'the planners\' read set');
      const { EDGE_PLAN_BYTES } = await edgePlanModule();
      const view = new ReadSet('edgeplanspace');
      const doc = (i) => ({
        _id: flat(crypto.randomUUID()), spaceId: 'edgeplanspace', from: flat(crypto.randomUUID()), to: flat(crypto.randomUUID()), label: flat('productFeature'),
        tags: [], properties: {}, author: { kind: 'token', id: flat(`author-${i % 7}`) }, createdAt: flat(new Date().toISOString()), updatedAt: flat(new Date().toISOString()),
        seq: 0, schemaFingerprint: flat('0123456789abcdef'), fromKind: flat('entity'), toKind: flat('entity'),
      });
      const before = liveHeap();
      for (let i = 0; i < count; i += 1) {
        const edge = doc(i);
        // A seed is a record `{ _id, spaceId, type }` held by id and by the set of minted ids; `seed` itself reads the store, so this is its in-memory part.
        view.noteWritten('entity', { _id: edge.from, spaceId: 'edgeplanspace', type: flat('Product') }, true);
        view.noteWritten('entity', { _id: edge.to, spaceId: 'edgeplanspace', type: flat('Feature') }, true);
        view.noteWritten('edge', edge, true);
      }
      const holds = [view];
      const per = (liveHeap() - before) / count;
      assert.equal(holds.length, 1, 'the read set is held while the heap is measured');
      console.log(`edge plan ${count}: ${per.toFixed(0)} bytes an edge (charge ${EDGE_PLAN_BYTES})`);
      assert.ok(per <= EDGE_PLAN_BYTES, `an edge in the shared read set takes ${per.toFixed(0)} bytes, above its charge ${EDGE_PLAN_BYTES}`);
      assert.ok(per >= AT_LEAST * EDGE_PLAN_BYTES, `an edge takes ${per.toFixed(0)} bytes, under ${AT_LEAST} of its charge ${EDGE_PLAN_BYTES}: the charge is a figure nothing measures`);
    });
  }
});

describe('a label-only subject of the inference is charged its characters', () => {
  const labelGroup = (i, chars) => {
    const subject = iri(`http://people.example/l${i}`);
    return { key: subject.value, subject, quads: [{ subject, predicate: RDFS_LABEL, object: { kind: 'literal', value: 'x'.repeat(chars) } }] };
  };
  const sourceOf = async (list) => {
    const { addressNames } = await reverseModule();
    const names = addressNames(metaOf(false));
    return { groups: asGroups(list), skip: new Set(), namesOf: () => names, blankNodes: 'refuse' };
  };

  it('20 subjects with labels of 50 000 characters are refused naming the memory bound, where the flat charge a subject would hold them', async () => {
    const { gatherClasses } = await dataModule();
    const { ImportMemoryMeter, INFER_SUBJECT_BYTES } = await memory();
    const SUBJECTS = 20;
    const room = 4 * SUBJECTS * INFER_SUBJECT_BYTES;
    const source = await sourceOf(Array.from({ length: SUBJECTS }, (_, i) => labelGroup(i, 50_000)));
    const meter = new ImportMemoryMeter(room);
    meter.charge(SUBJECTS * INFER_SUBJECT_BYTES);
    await assert.rejects(gatherClasses(source, { predicates: 100, classes: 100, memory: meter }), (err) => err?.name === 'RdfImportBoundExceeded'
      && err.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === room, 'labels of 50 000 characters were held against the flat charge of a subject');
  });

  it('the same subjects with short labels fit the same room, and what they cost is charged by the characters', async () => {
    const { gatherClasses } = await dataModule();
    const { ImportMemoryMeter, INFER_SUBJECT_BYTES, textBytes } = await memory();
    const SUBJECTS = 20;
    const room = 4 * SUBJECTS * INFER_SUBJECT_BYTES;
    const source = await sourceOf(Array.from({ length: SUBJECTS }, (_, i) => labelGroup(i, 40)));
    const meter = new ImportMemoryMeter(room);
    meter.charge(SUBJECTS * INFER_SUBJECT_BYTES);
    const before = meter.used;
    const classes = await gatherClasses(source, { predicates: 100, classes: 100, memory: meter });
    assert.equal(classes.kind, 'classes');
    const expected = Array.from({ length: SUBJECTS }, (_, i) => textBytes(`http://people.example/l${i}`) * 2 + 40).reduce((n, b) => n + b, 0);
    assert.equal(meter.used - before, expected,'a label-only subject is not charged its address twice (address, group key) and its label once');
  });

  it('the door charges them with the subjects and takes the pairs from what is left (source gate)', async () => {
    const fs = await import('node:fs');
    const { REPO_ROOT } = await import('./_sources.mjs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const door = stripComments(fs.readFileSync(`${REPO_ROOT}/server/src/spaces/rdf-import-schema-step.ts`, 'utf8'));
    const at = door.indexOf('gatherClasses(source');
    assert.ok(at > 0, 'the door no longer starts the inference here: update this gate');
    assert.match(door.slice(at).split('\n', 1)[0], /memory: held/, 'the first pass of the inference reads the labels with no meter');
    assert.ok(door.indexOf('inferencePairsRoom(') > at, 'the pairs are fixed before the labels are known, so the labels spend the room twice');
  });
});
