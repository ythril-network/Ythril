/**
 * The import's two digest sets never hold more than a stated multiple of the record bound, and the count refuses by the bound's name as soon as
 * the bound cannot be met (bundle-270, lens finding L5).
 *
 * ## What it holds
 *
 * `assertRecordsWithinBound` (the door's count) and the act's index pass keep the edge statements a file asserts and reifies in two digest sets,
 * and filled them for EVERY statement of the file before any bound was looked at: a file of ten million asserted statements held ten million
 * digests per set (measured: 53 bytes of heap per entry, so 0.5 GB a set, and 150 bytes of resident memory per entry). A file whose records can be
 * met has at most the bound of bare edges plus one reifier per edge with details (a reifier is a subject, and subjects are bounded by the same
 * figure), so at most `RDF_IMPORT_EDGE_STATEMENT_MULTIPLE` times the bound of labelled asserted statements: past that the count refuses
 * `RDF_IMPORT_MAX_RECORDS` before it reads on, with the sets under the multiple at that moment.
 *
 * - the count stops reading the file at the refusal (the groups it was fed are fewer than the file's);
 * - the sets, at the moment of the refusal, hold at most the multiple of the bound each;
 * - a file that stays inside the multiple and the bound is counted as before (the same figure, the same answer);
 * - the act's index pass fills its sets through the same class, so its heap is bounded by the same figure (source gate).
 *
 * Run: node --test testing/standalone/the-rdf-import-count-refuses-as-soon-as-the-record-bound-cannot-be-met.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const count = await import('../../server/dist/rdf/import-count.js');
const { addressNames } = await import('../../server/dist/rdf/term-reverse.js');
const { RdfImportBoundExceeded } = await import('../../server/dist/rdf/import-spool.js');

const BASE = 'https://rdf.example.org/ld/notes/';
const meta = { rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/` }, typeSchemas: { edge: { knows: {} } } };
const names = addressNames(meta);
const iri = (value) => ({ kind: 'iri', value });
const KNOWS = iri(`${BASE}vocab/edge/knows`);
const UNLABELLED = iri('http://elsewhere.example/seeAlso');
const REIFIES = iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies');

/** A subject `s<i>` asserting `per` edges to distinct objects, as one group. */
const groupOf = (i, per, predicate = KNOWS) => {
  const subject = iri(`http://people.example/s${i}`);
  return { key: subject.value, subject, quads: Array.from({ length: per }, (_, j) => ({ subject, predicate, object: iri(`http://people.example/o${i}-${j}`) })) };
};

/** `n` groups of `per` statements, with how many the consumer pulled. */
function file(n, per, predicate) {
  const state = { pulled: 0, total: n };
  async function* groups() { for (let i = 0; i < n; i++) { state.pulled += 1; yield groupOf(i, per, predicate); } }
  return { state, groups };
}

describe('the count refuses by the record bound as soon as it cannot be met', () => {
  const MAX = 50;

  it('stops reading the file once the statements are past the multiple of the bound, and names the record bound', async () => {
    const f = file(400, 10);
    await assert.rejects(
      count.assertRecordsWithinBound(f.groups(), () => names, 400, MAX),
      (err) => err instanceof RdfImportBoundExceeded && err.bound === 'RDF_IMPORT_MAX_RECORDS' && err.limit === MAX,
    );
    const allowed = Math.ceil((count.RDF_IMPORT_EDGE_STATEMENT_MULTIPLE * MAX) / 10) + 1;
    assert.ok(f.state.pulled <= allowed, `the count read ${f.state.pulled} of ${f.state.total} groups: it went on past the point where the bound could not be met (at most ${allowed})`);
  });

  it('holds each set at the multiple of the bound at most, the moment it refuses', () => {
    const sets = new count.TripletSets(MAX);
    let refused = null;
    for (let i = 0; i < 400 && refused === null; i++) {
      try { sets.addGroup(groupOf(i, 10).quads, names); } catch (err) { refused = err; }
    }
    assert.ok(refused instanceof RdfImportBoundExceeded, 'the sets took every statement of the file');
    const cap = count.RDF_IMPORT_EDGE_STATEMENT_MULTIPLE * MAX;
    assert.ok(sets.asserted.size <= cap && sets.reified.size <= cap, `the sets hold ${sets.asserted.size} and ${sets.reified.size} entries, over ${cap}`);
    assert.ok(sets.asserted.size > 0, 'the statements it held were kept (a probe that holds nothing proves nothing)');
  });

  it('keeps no statement whose predicate is no edge label, so a file of other links fills nothing', () => {
    const sets = new count.TripletSets(MAX);
    for (let i = 0; i < 40; i++) sets.addGroup(groupOf(i, 10, UNLABELLED).quads, names);
    assert.equal(sets.asserted.size, 0, 'an address that names no edge label was held in the set');
  });

  it('counts a file inside the bound as before: its subjects plus its bare edges', async () => {
    // 3 subjects each asserting 2 edges, one of them reified by a reifier subject: 3 + 6 - 1 = 8 records at most.
    const edge = groupOf(0, 2);
    const reifier = iri('http://people.example/r0');
    const named = edge.quads[0];
    const reifying = { key: reifier.value, subject: reifier, quads: [{ subject: reifier, predicate: REIFIES, object: { kind: 'triple', subject: named.subject, predicate: named.predicate, object: named.object } }] };
    const groups = async function* () { yield edge; yield groupOf(1, 2); yield groupOf(2, 2); yield reifying; };
    await count.assertRecordsWithinBound(groups(), () => names, 4, 9);
    await assert.rejects(count.assertRecordsWithinBound(groups(), () => names, 4, 8), (err) => err instanceof RdfImportBoundExceeded, 'the figure changed: 4 subjects + 5 bare edges is 9');
  });

  it('the act\'s index pass fills its sets through the same class', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = stripComments(fs.readFileSync(`${root}/server/src/spaces/rdf-import-act.ts`, 'utf8').replaceAll('\r\n', '\n'));
    const pass = src.slice(src.indexOf('async function indexPass'), src.indexOf('function nodesOf'));
    assert.match(pass, /new TripletSets\(/, 'the index pass builds its sets by hand: they grow with the file before any bound is looked at');
    assert.doesNotMatch(pass, /new DigestSet\(/);
  });
});
