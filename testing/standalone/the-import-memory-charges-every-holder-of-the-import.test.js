/**
 * Every holder that grows with an RDF import's file is charged to the import's one memory room, and a refusal that knows the whole need says it
 * (bundle-384, Q-983, fix round, findings 1 and 2: lens g2 security and g1 code-quality, vet amendment G2; the drive measured 1.47 GiB resident for a
 * file whose index and sets the meter charged at 512 MiB).
 *
 * ## The rule
 *
 * The room (`import-memory.ts`) is what one import may hold, so what an import keeps for the whole file is charged to it, not only the index and the
 * two digest sets:
 *
 * - **The minted ends** (`import-ends.ts`): after the translation the act keeps, for every record the file inserts, its id and kind, and the dry plan
 *   takes a copy it may remove records from. The index and the sets are gone by then (nothing keeps them), so this is the act's second phase: it is
 *   charged to a meter of its own room, the entry and its copy.
 * - **The inference's subject maps** (`schema-from-data.ts`): a schema inferred from the data holds, per subject, its digest in a seen set and its
 *   classes in a map (or its labels, for a label-only subject), and per repeated (subject, predicate) pair a string. The door knows the file's subjects
 *   from the sorted spool, so a file whose subjects the inference cannot hold is refused before it reads a statement, with the whole need.
 * - **The group window**: its own spec (`the-import-group-window-ends-at-its-share-of-room.test.js`).
 *
 * Each charge is pinned on the live heap with the headroom the first spec of this family states (`the-import-memory-charges-what-an-entry-costs`): the
 * measured heap per entry is at most the charge, measured just after a Map doubled (its table half empty, an entry dearest), and at least 0.65 of it.
 *
 * The door's count answers the larger of the act's two phases (the index with the sets and bare edges; the minted ends and their copy), and a refusal
 * that comes where the whole need is known (a phase's figure from the file's counts, the bare edges that end the first phase) says "needs", not "needs at
 * least": only a refusal at the charge that crossed the room, before the rest is read, is "at least".
 *
 * Run: node --test testing/standalone/the-import-memory-charges-every-holder-of-the-import.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { importOrFail } from '../_shared/import-or-fail.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const liveHeap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };

const memory = () => importOrFail('server/dist/rdf/import-memory.js', 'the import\'s memory room and what a holder costs (Q-983)');
const endsModule = () => importOrFail('server/dist/rdf/import-ends.js', 'the act\'s minted ends, charged to a meter (Q-983 fix round)');
const countModule = () => importOrFail('server/dist/rdf/import-count.js', 'the door\'s count (Q-983)');
const reverseModule = () => importOrFail('server/dist/rdf/term-reverse.js', 'the reverse addressing');
const dataModule = () => importOrFail('server/dist/rdf/schema-from-data.js', 'the inference from data (Q-755)');

/** A Map holds up to a power of two entries: the count just past one (a half-empty table, the dearest entry) and one near the next (the cheapest). */
const POWER = 2 ** 15;
const POINTS = [['just past a power of two', POWER + 1], ['near full', POWER - 64]];
const AT_LEAST = 0.65;
const COPY_AT_LEAST = 0.4;
/** Strings the way the spool hands them back: flat, each its own (a template or a UUID from crypto is a rope until something flattens it). */
const flat = (s) => Buffer.from(s, 'utf8').toString('utf8');

const BASE = 'https://rdf.example.org/ld/notes/';
const meta = { rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/` }, typeSchemas: { edge: { knows: {} } } };
const iri = (value) => ({ kind: 'iri', value });
const KNOWS = iri(`${BASE}vocab/edge/knows`);
const asGroups = (list) => async function* () { yield* list; };
const subjectGroup = (i) => {
  const subject = iri(`http://people.example/s${i}`);
  return { key: subject.value, subject, quads: [{ subject, predicate: iri('http://people.example/name'), object: { kind: 'literal', value: `n${i}` } }] };
};

describe('the minted ends and their copy are charged what they cost on the heap', { timeout: 120_000 }, () => {
  for (const kind of ['entity', 'fact']) {
    for (const [at, count] of POINTS) {
      it(`${kind} ends, ${count} entries (${at}): the heap per entry and per copied entry is within the charge and at least ${AT_LEAST} of it`, async () => {
        const { MINTED_END_BYTES, ENDS_COPY_BYTES, ImportMemoryMeter } = await memory();
        const { MintedEnds } = await endsModule();
        // Op lines as the spool hands them back, each parsed into a string and an object of its own; kept alive past both measures.
        const lines = Array.from({ length: count }, (_, i) => flat(JSON.stringify({ op: 'insert', kind, id: crypto.randomUUID(), fields: kind === 'entity' ? { type: `ProductType${i % 400}` } : {} })));
        const meter = new ImportMemoryMeter(Number.MAX_SAFE_INTEGER);
        const before = liveHeap();
        const ends = new MintedEnds(meter);
        for (const line of lines) {
          const op = JSON.parse(line);
          ends.set(op.id, op.kind === 'entity' ? { kind: 'entity', type: op.fields.type ?? null } : { kind: op.kind });
        }
        const afterEnds = liveHeap();
        const copy = ends.copy();
        const afterCopy = liveHeap();
        const perEntry = (afterEnds - before) / count;
        const perCopy = (afterCopy - afterEnds) / count;
        console.log(`ends, ${kind}, ${count} entries: ${perEntry.toFixed(1)} B an entry (charged ${MINTED_END_BYTES}), ${perCopy.toFixed(1)} B a copied entry (charged ${ENDS_COPY_BYTES}); ${lines.length} lines, ${copy.size} copied`);
        assert.equal(ends.size, count);
        assert.equal(meter.used, count * (MINTED_END_BYTES + ENDS_COPY_BYTES), 'the ends and their copy were charged something other than the two figures');
        assert.ok(perEntry <= MINTED_END_BYTES, `an end takes ${perEntry.toFixed(1)} bytes and is charged ${MINTED_END_BYTES}: an import could outgrow its room`);
        assert.ok(perCopy <= ENDS_COPY_BYTES, `a copied end takes ${perCopy.toFixed(1)} bytes and is charged ${ENDS_COPY_BYTES}`);
        if (kind === 'entity') assert.ok(perEntry >= AT_LEAST * MINTED_END_BYTES, `an end takes ${perEntry.toFixed(1)} bytes and is charged ${MINTED_END_BYTES}: too dear`);
        // The copy is a table alone, which a doubling halves the fill of: its entry costs 56 bytes just after one and 28 just before the next.
        assert.ok(perCopy >= COPY_AT_LEAST * ENDS_COPY_BYTES, `a copied end takes ${perCopy.toFixed(1)} bytes and is charged ${ENDS_COPY_BYTES}: too dear`);
      });
    }
  }

  it('an end past the room is refused naming the memory bound and is not kept; a copy that cannot fit is refused before it is made', async () => {
    const { MINTED_END_BYTES, ENDS_COPY_BYTES, ImportMemoryMeter } = await memory();
    const { MintedEnds } = await endsModule();
    const room = 3 * MINTED_END_BYTES + 2 * ENDS_COPY_BYTES;
    const ends = new MintedEnds(new ImportMemoryMeter(room));
    for (let i = 0; i < 3; i += 1) ends.set(`id-${i}`, { kind: 'fact' });
    ends.set('id-0', { kind: 'fact' });
    assert.equal(ends.size, 3, 'an id set again was a second end');
    assert.throws(() => ends.set('id-3', { kind: 'fact' }), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === room);
    assert.equal(ends.has('id-3'), false, 'the refused end was kept');
    assert.throws(() => ends.copy(), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY', 'a copy past the room was made');
  });
});

describe('the inference\'s subject maps are charged what they cost on the heap', { timeout: 120_000 }, () => {
  for (const [at, count] of POINTS) {
    it(`${count} typed subjects (${at}): the live heap of the first pass, seen set and subject map, per subject is within the charge and at least ${AT_LEAST} of it`, async () => {
      const { INFER_SUBJECT_BYTES } = await memory();
      const { gatherClasses } = await dataModule();
      const { addressNames } = await reverseModule();
      const names = addressNames(meta);
      const iris = Array.from({ length: count }, (_, i) => flat(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/dataFromProducer${i % 997}/Product${i}`));
      const klass = iri('http://example.org/vocab/Product');
      let during = 0;
      async function* groups() {
        for (let i = 0; i < count; i += 1) {
          // At the last group the first pass holds every earlier subject in both structures: its peak.
          if (i === count - 1) during = liveHeap();
          const subject = iri(iris[i]);
          yield { key: subject.value, subject, quads: [{ subject, predicate: iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: klass }] };
        }
      }
      const source = { groups, skip: new Set(), namesOf: () => names, blankNodes: 'refuse' };
      const before = liveHeap();
      const first = await gatherClasses(source, { predicates: 1000, classes: 1000 });
      assert.equal(first.kind, 'classes');
      assert.equal(first.subjects.size, count, 'the first pass did not type every subject (a probe that holds nothing proves nothing)');
      const perSubject = (during - before) / (count - 1);
      console.log(`inference, ${count} typed subjects: ${perSubject.toFixed(1)} B a subject at the first pass's peak (charged ${INFER_SUBJECT_BYTES}); ${iris.length} addresses`);
      assert.ok(perSubject <= INFER_SUBJECT_BYTES, `a subject takes ${perSubject.toFixed(1)} bytes in the first pass and is charged ${INFER_SUBJECT_BYTES}`);
      assert.ok(perSubject >= AT_LEAST * INFER_SUBJECT_BYTES, `a subject takes ${perSubject.toFixed(1)} bytes and is charged ${INFER_SUBJECT_BYTES}: too dear`);
    });
  }

  it('a repeated pair the second pass remembers is charged what its string costs', async () => {
    const { INFER_PAIR_BYTES } = await memory();
    const { digestOfKey } = await countModule();
    const iris = Array.from({ length: POWER + 1 }, (_, i) => flat(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/dataFromProducer${i % 997}/Product${i}`));
    const before = liveHeap();
    const pairs = new Set();
    // The pair as the second pass spells it: the subject's digest, a separator, the predicate.
    for (let i = 0; i < iris.length; i += 1) pairs.add(`${digestOfKey(iris[i])}\u0000http://www4.wiwiss.fu-berlin.de/bizer/bsbm/vocab/v01/productFeature${i % 7}`);
    const perPair = (liveHeap() - before) / iris.length;
    console.log(`inference, a repeated pair: ${perPair.toFixed(1)} B (charged ${INFER_PAIR_BYTES}); ${iris.length} addresses, ${pairs.size} pairs`);
    assert.ok(perPair <= INFER_PAIR_BYTES && perPair >= AT_LEAST * INFER_PAIR_BYTES, `a pair takes ${perPair.toFixed(1)} bytes and is charged ${INFER_PAIR_BYTES}`);
    const source = fs.readFileSync(`${REPO_ROOT}/server/src/rdf/schema-from-data.ts`, 'utf8');
    assert.match(stripComments(source), /countedPairs\.add\(counted\)/, 'the pair the second pass remembers is no longer the string this spec measures: measure the new shape');
  });

  it('a file whose subjects the inference cannot hold is refused before it reads a statement, with the whole need', async () => {
    const { INFER_SUBJECT_BYTES, assertInferenceFits } = await memory();
    const room = 1000 * INFER_SUBJECT_BYTES;
    assertInferenceFits(1000, room);
    assert.throws(() => assertInferenceFits(1001, room), (err) => err?.name === 'RdfImportBoundExceeded' && err.bound === 'RDF_IMPORT_MAX_MEMORY'
      && err.limit === room && err.need === 1001 * INFER_SUBJECT_BYTES && !/at least/.test(err.message));
  });

  it('the pairs the second pass may remember are what is left of the room beside the subjects, never more than asked and never below zero', async () => {
    const { INFER_SUBJECT_BYTES, INFER_PAIR_BYTES, inferencePairsRoom } = await memory();
    const room = 1000 * INFER_SUBJECT_BYTES + 50 * INFER_PAIR_BYTES + 3;
    assert.equal(inferencePairsRoom(1000, room, 1_000_000), 50);
    assert.equal(inferencePairsRoom(1000, room, 20), 20, 'the caller\'s own bound is never raised');
    assert.equal(inferencePairsRoom(1000, 1000 * INFER_SUBJECT_BYTES, 500), 0);
  });

  it('the door asks both before it reads the file for a schema from data (source gate)', () => {
    const door = stripComments(fs.readFileSync(`${REPO_ROOT}/server/src/spaces/rdf-import-schema-step.ts`, 'utf8'));
    const at = door.indexOf('gatherClasses(source');
    assert.ok(at > 0, 'the door no longer starts the inference here: update this gate');
    const before = door.slice(0, at);
    assert.match(before, /assertInferenceFits\(/, 'the door starts reading statements for an inference before it asked whether the subjects fit');
    assert.match(before, /new ImportMemoryMeter\(/, 'the first pass reads labels and subjects with no meter of the room');
    assert.ok(door.indexOf('inferencePairsRoom(') > at, 'the pairs the inference remembers are not capped by what the room has left');
  });
});

describe('the door counts the larger of the act\'s two phases and says the whole need where it knows it', () => {
  it('a file whose index fits but whose minted ends and their copy would pass the room is refused before anything is written, with the whole need', async () => {
    const { MINTED_ENTRY_BYTES, MINTED_END_BYTES, ENDS_COPY_BYTES } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    const SUBJECTS = 1000;
    const groups = asGroups(Array.from({ length: SUBJECTS }, (_, i) => subjectGroup(i)));
    const indexNeed = SUBJECTS * MINTED_ENTRY_BYTES;
    const endsNeed = SUBJECTS * (MINTED_END_BYTES + ENDS_COPY_BYTES);
    assert.ok(endsNeed > indexNeed, 'the ends are not dearer than the index: the fixture proves nothing');
    const room = endsNeed - 1;
    assert.ok(room >= indexNeed, 'the index would not fit either');
    await assert.rejects(assertRecordsWithinBound(groups(), () => names, room), (err) => err?.name === 'RdfImportBoundExceeded'
      && err.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === room && err.need === endsNeed && !/at least/.test(err.message),
    'the count did not refuse a file whose ends pass the room, or did not say the whole need');
    assert.equal((await assertRecordsWithinBound(groups(), () => names, endsNeed)).need, endsNeed, 'the need of a file the ends dominate is the ends\' figure');
  });

  it('a file whose first phase dominates has that phase\'s need, and a refusal at the bare edges that end it is the whole need', async () => {
    const { MINTED_ENTRY_BYTES, SET_ENTRY_BYTES, MINTED_END_BYTES, ENDS_COPY_BYTES } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    // 4 subjects each asserting 3 edges to foreign objects, none reified: 12 statements of the asserted set and 12 bare edges.
    const edge = (i) => {
      const subject = iri(`http://people.example/s${i}`);
      return { key: subject.value, subject, quads: [0, 1, 2].map(j => ({ subject, predicate: KNOWS, object: iri(`http://people.example/o${i}-${j}`) })) };
    };
    const groups = asGroups([0, 1, 2, 3].map(edge));
    const first = 4 * MINTED_ENTRY_BYTES + 12 * SET_ENTRY_BYTES + 12 * MINTED_ENTRY_BYTES;
    assert.ok(first > 4 * (MINTED_END_BYTES + ENDS_COPY_BYTES), 'the first phase is not the larger: the fixture proves nothing');
    assert.equal((await assertRecordsWithinBound(groups(), () => names, first)).need, first);
    // The room holds every subject and set entry (4 x 160 + 12 x 78 = 1576) but not the 12 bare edges after them: the whole need is known there.
    const room = 4 * MINTED_ENTRY_BYTES + 12 * SET_ENTRY_BYTES + 5 * MINTED_ENTRY_BYTES;
    await assert.rejects(assertRecordsWithinBound(groups(), () => names, room), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === room
      && err.need === first && !/at least/.test(err.message), 'the refusal at the bare edges did not say the whole need');
  });

  it('a refusal at the charge that crossed the room, before the rest was read, still says at least', async () => {
    const { MINTED_ENTRY_BYTES } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    const groups = asGroups(Array.from({ length: 50 }, (_, i) => subjectGroup(i)));
    await assert.rejects(assertRecordsWithinBound(groups(), () => names, 10 * MINTED_ENTRY_BYTES), (err) => err?.need === 11 * MINTED_ENTRY_BYTES && /needs at least/.test(err.message));
  });

  it('the act charges the ends and their copy to a meter of its own room, and a refusal there ends the act as an input failure (source gate)', () => {
    const act = stripComments(fs.readFileSync(`${REPO_ROOT}/server/src/spaces/rdf-import-act.ts`, 'utf8'));
    assert.match(act, /new MintedEnds\(/, 'the minted ends are held in a plain Map, outside the meter');
    assert.doesNotMatch(act, /new Map\(minted\)/, 'the dry plan copies the ends without charging the copy');
    const body = act.slice(act.indexOf('async function rdfImportBody'));
    const planned = body.indexOf('outcome = await planAndCommit(run)');
    assert.ok(planned > 0, 'the act\'s body no longer plans in this place: update this gate');
    assert.ok(body.indexOf('instanceof RdfImportBoundExceeded', planned) > planned, 'a refusal of the second phase is not answered as an input failure in the act\'s body');
  });
});
