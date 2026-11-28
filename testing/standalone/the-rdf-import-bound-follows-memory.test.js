/**
 * An RDF import's record sets are bounded by the memory it is given, not by a count: a file of more than 1 000 000 records passes under a large
 * budget and is refused just past a small one, the door's need is never below what the index will take, and the count stops reading at the
 * refusal (bundle-384, Q-983, vet amendments G1, S3 and S4).
 *
 * ## What it holds
 *
 * - **No fixed count** (S3): a file of 1 000 100 subjects, more than the old bound of one million, goes through the door's own pass
 *   (`sortedSpool`) and its count (`assertRecordsWithinBound`) under `memoryBytes` (the test budget that replaces the old count knob), and passes
 *   at exactly what it needs and is refused by `RDF_IMPORT_MAX_MEMORY` under a budget of a thousand subjects (a refusal one byte under a budget is
 *   held on the small files below). This runs through the spool and the count only, not through the act and the database: those are held by the
 *   -db files beside it, and a million records through the database is not a test's time. Its output states the seconds it took (about 24 s of the
 *   file's 25 on the build machine's container, 14 of them the sort).
 * - **The door charges as the index will** (G1): every subject at least as dear as the index's entry for it, an addressed subject by its text id
 *   when that is dearer than a minted one (`max(minted, text id)`), every bare edge as a minted entry and every statement of the two sets.
 * - **No multiple of a bound** (S4): the sets are not capped at a multiple of a record count; a file whose statements are all reified (no bare
 *   edge) is held by what its entries cost.
 * - **The count stops reading at the refusal**, with the sets at the budget at most.
 * - **The act's index pass fills its sets through the same class** (source gate).
 *
 * Run: node --test testing/standalone/the-rdf-import-bound-follows-memory.test.js (after the server build)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { importOrFail } from '../_shared/import-or-fail.mjs';
import { stripComments } from './_strip-comments.mjs';

const memory = () => importOrFail('server/dist/rdf/import-memory.js', 'the import\'s memory room and what an entry costs (Q-983)');
const countModule = () => importOrFail('server/dist/rdf/import-count.js', 'the door\'s count (Q-983)');
const spoolModule = () => importOrFail('server/dist/rdf/import-spool.js', 'the door\'s sorted spool');
const reverseModule = () => importOrFail('server/dist/rdf/term-reverse.js', 'the reverse addressing');

const BASE = 'https://rdf.example.org/ld/notes/';
const meta = { rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/` }, typeSchemas: { edge: { knows: {} } } };
const iri = (value) => ({ kind: 'iri', value });
const KNOWS = iri(`${BASE}vocab/edge/knows`);
const REIFIES = iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies');
const OLD_FIXED_COUNT = 1_000_000;
const SUBJECTS = OLD_FIXED_COUNT + 100;
const WITH_EDGES = 100;
/** One short quad per subject: the file is as small as a file past a million subjects can be, since its time is the sort's. */
const NAME = iri('http://p.example/n');
const LITERAL = { kind: 'literal', value: 'n' };

const made = [];
after(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function* streamOf(quads) { for (const quad of quads) yield quad; }

/** A subject `s<i>` asserting `per` edges to distinct objects, as one group. */
const groupOf = (i, per, predicate = KNOWS) => {
  const subject = iri(`http://people.example/s${i}`);
  return { key: subject.value, subject, quads: Array.from({ length: per }, (_, j) => ({ subject, predicate, object: iri(`http://people.example/o${i}-${j}`) })) };
};
const asGroups = (list) => async function* () { yield* list; };

describe('a file past the old fixed count is bounded by memory alone', { timeout: 300_000 }, () => {
  it(`${SUBJECTS} subjects: through the door's spool and count, passes at what it needs and is refused under a small budget`, async () => {
    const started = Date.now();
    const { MINTED_ENTRY_BYTES, SET_ENTRY_BYTES } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { sortedSpool, openImportFolder } = await spoolModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b384-big-'));
    made.push(dir);
    const folder = await openImportFolder(dir);
    // The first WITH_EDGES subjects each assert one edge to a foreign object, a bare edge nobody reifies: a record the index mints under its triplet.
    function* quads() {
      for (let i = 0; i < SUBJECTS; i += 1) {
        const subject = iri(`http://people.example/s${i}`);
        yield { subject, predicate: NAME, object: LITERAL };
        if (i < WITH_EDGES) yield { subject, predicate: KNOWS, object: iri(`http://people.example/o${i}`) };
      }
    }
    const huge = Number.MAX_SAFE_INTEGER;
    const spool = await sortedSpool(streamOf(quads()), folder, { names, bounds: { memoryBytes: huge } });
    const sortedAt = Date.now();
    console.log(`${SUBJECTS} subjects sorted on disk: ${((sortedAt - started) / 1000).toFixed(1)} s`);
    assert.equal(spool.subjects, SUBJECTS, 'the door counted a different number of subjects');
    assert.ok(spool.subjects > OLD_FIXED_COUNT, 'the file is not past the old fixed count');
    const need = SUBJECTS * MINTED_ENTRY_BYTES + WITH_EDGES * SET_ENTRY_BYTES + WITH_EDGES * MINTED_ENTRY_BYTES;
    const answer = await assertRecordsWithinBound(spool.groups(), () => names, need);
    assert.equal(answer.need, need, 'the door charged something other than every subject, every set entry and every bare edge');
    console.log(`${SUBJECTS} subjects through the spool and the count: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    // The same file under a budget of a thousand subjects is refused as soon as the count passes it: a small budget refuses a file past it (the
    // refusal one byte past a budget is held on the small files below, which do not cost a million records each).
    const small = 1_000 * MINTED_ENTRY_BYTES;
    await assert.rejects(
      assertRecordsWithinBound(spool.groups(), () => names, small),
      (err) => err?.name === 'RdfImportBoundExceeded' && err.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === small && err.need > small,
    );
  });

  it('the door\'s early refusal in the sort: a budget under what the subjects alone take is refused before the sort ends, naming the memory bound', async () => {
    const { MINTED_ENTRY_BYTES } = await memory();
    const { sortedSpool, openImportFolder } = await spoolModule();
    const { addressNames } = await reverseModule();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b384-early-'));
    made.push(dir);
    const folder = await openImportFolder(dir);
    const quads = Array.from({ length: 50 }, (_, i) => ({ subject: iri(`http://people.example/s${i}`), predicate: iri('http://people.example/name'), object: { kind: 'literal', value: `n${i}` } }));
    const budget = 49 * MINTED_ENTRY_BYTES;
    await assert.rejects(
      sortedSpool(streamOf(quads), folder, { names: addressNames(meta), bounds: { memoryBytes: budget } }),
      (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === budget && err.need === 50 * MINTED_ENTRY_BYTES,
    );
    assert.deepEqual(fs.readdirSync(dir), [], 'the refused pass left files behind');
  });
});

describe('the door charges as the index will', () => {
  it('a subject is charged a minted entry, however short its own address is', async () => {
    const { MINTED_ENTRY_BYTES, indexEntryBytes } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    const subject = iri(`${BASE}entity/e1`);
    const groups = asGroups([{ key: subject.value, subject, quads: [{ subject, predicate: iri('http://x.example/p'), object: iri('http://x.example/o') }] }]);
    assert.ok(indexEntryBytes('e1') < MINTED_ENTRY_BYTES, 'the fixture\'s id is not cheaper than a minted one');
    await assertRecordsWithinBound(groups(), () => names, MINTED_ENTRY_BYTES);
    await assert.rejects(assertRecordsWithinBound(groups(), () => names, MINTED_ENTRY_BYTES - 1), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY');
  });

  it('an addressed subject is charged its text id when that is dearer than a minted one: never below the index\'s own entry', async () => {
    const { MINTED_ENTRY_BYTES, indexEntryBytes } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    const id = `addressed-${'z'.repeat(300)}`;
    const subject = iri(`${BASE}entity/${id}`);
    const groups = asGroups([{ key: subject.value, subject, quads: [{ subject, predicate: iri('http://x.example/p'), object: iri('http://x.example/o') }] }]);
    const dearer = indexEntryBytes(id);
    assert.ok(dearer > MINTED_ENTRY_BYTES, 'the fixture\'s id is not dearer than a minted one');
    await assertRecordsWithinBound(groups(), () => names, dearer);
    await assert.rejects(assertRecordsWithinBound(groups(), () => names, dearer - 1), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY' && err.need === dearer);
  });

  it('counts a file inside the budget as its parts cost: 4 subjects, 7 statements of the two sets and 5 bare edges', async () => {
    const { MINTED_ENTRY_BYTES, SET_ENTRY_BYTES } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    // 3 subjects each asserting 2 edges, one of them reified by a reifier subject: 4 groups, 6 asserted and 1 reified statement, 6 - 1 = 5 bare edges.
    const edge = groupOf(0, 2);
    const reifier = iri('http://people.example/r0');
    const named = edge.quads[0];
    const reifying = { key: reifier.value, subject: reifier, quads: [{ subject: reifier, predicate: REIFIES, object: { kind: 'triple', subject: named.subject, predicate: named.predicate, object: named.object } }] };
    const groups = asGroups([edge, groupOf(1, 2), groupOf(2, 2), reifying]);
    const need = 4 * MINTED_ENTRY_BYTES + 7 * SET_ENTRY_BYTES + 5 * MINTED_ENTRY_BYTES;
    assert.equal((await assertRecordsWithinBound(groups(), () => names, need)).need, need);
    await assert.rejects(assertRecordsWithinBound(groups(), () => names, need - 1), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY', 'the figure changed: 4 subjects, 7 set entries and 5 bare edges');
  });

  it('a file whose every statement is reified has no bare edge, and its sets are held by what they cost, not by a multiple of a record count', async () => {
    const { MINTED_ENTRY_BYTES, SET_ENTRY_BYTES } = await memory();
    const { assertRecordsWithinBound } = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    const STATEMENTS = 300;
    const edges = groupOf(0, STATEMENTS);
    const reifiers = edges.quads.map((named, j) => {
      const reifier = iri(`http://people.example/r${j}`);
      return { key: reifier.value, subject: reifier, quads: [{ subject: reifier, predicate: REIFIES, object: { kind: 'triple', subject: named.subject, predicate: named.predicate, object: named.object } }] };
    });
    const groups = asGroups([edges, ...reifiers]);
    const need = (1 + STATEMENTS) * MINTED_ENTRY_BYTES + 2 * STATEMENTS * SET_ENTRY_BYTES;
    assert.equal((await assertRecordsWithinBound(groups(), () => names, need)).need, need);
    await assert.rejects(assertRecordsWithinBound(groups(), () => names, need - 1), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY');
  });
});

describe('the count refuses as soon as the budget cannot be met', () => {
  it('stops reading the file once the sets pass the budget, with the sets at the budget at most', async () => {
    const { SET_ENTRY_BYTES, MINTED_ENTRY_BYTES } = await memory();
    const count = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    // Each group is a subject (a minted entry) with 10 statements: the budget holds five of them whole, so the sixth group is the one that cannot be met.
    const budget = 5 * (MINTED_ENTRY_BYTES + 10 * SET_ENTRY_BYTES);
    let pulled = 0;
    async function* groups() { for (let i = 0; i < 400; i += 1) { pulled += 1; yield groupOf(i, 10); } }
    await assert.rejects(count.assertRecordsWithinBound(groups(), () => names, budget), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === budget);
    assert.ok(pulled <= 6, `the count read ${pulled} of 400 groups: it went on past the point where the budget could not be met (6)`);
  });

  it('holds each set within the budget the moment it refuses', async () => {
    const { SET_ENTRY_BYTES, ImportMemoryMeter } = await memory();
    const count = await countModule();
    const { addressNames } = await reverseModule();
    const names = addressNames(meta);
    const room = 50 * SET_ENTRY_BYTES;
    const sets = new count.TripletSets(new ImportMemoryMeter(room));
    let refused = null;
    for (let i = 0; i < 400 && refused === null; i += 1) {
      try { sets.addGroup(groupOf(i, 10).quads, names); } catch (err) { refused = err; }
    }
    assert.equal(refused?.bound, 'RDF_IMPORT_MAX_MEMORY', 'the sets took every statement of the file');
    assert.equal(sets.asserted.size, 50, 'the sets held more or fewer than the budget allows (a probe that holds nothing proves nothing)');
  });

  it('keeps no statement whose predicate is no edge label, so a file of other links fills nothing and charges nothing', async () => {
    const { ImportMemoryMeter } = await memory();
    const count = await countModule();
    const { addressNames } = await reverseModule();
    const meter = new ImportMemoryMeter(Number.MAX_SAFE_INTEGER);
    const sets = new count.TripletSets(meter);
    for (let i = 0; i < 40; i += 1) sets.addGroup(groupOf(i, 10, iri('http://elsewhere.example/seeAlso')).quads, addressNames(meta));
    assert.equal(sets.asserted.size, 0, 'an address that names no edge label was held in the set');
    assert.equal(meter.used, 0, 'a statement nobody asks about was charged');
  });

  it('the act\'s index pass fills its sets through the same class, on the one meter of its index', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = stripComments(fs.readFileSync(`${root}/server/src/spaces/rdf-import-act.ts`, 'utf8').replaceAll('\r\n', '\n'));
    const pass = src.slice(src.indexOf('async function indexPass'), src.indexOf('function nodesOf'));
    assert.match(pass, /new TripletSets\(index\.meter\)/, 'the index pass builds its sets by hand or on a meter of their own: they grow with the file before any bound is looked at');
    assert.doesNotMatch(pass, /new DigestSet\(/);
  });
});
