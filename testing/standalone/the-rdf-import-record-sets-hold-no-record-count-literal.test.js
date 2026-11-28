/**
 * The RDF import's spool, index and count hold no record-count literal: what bounds a record set is the memory room, not a number someone
 * typed (bundle-384, Q-983).
 *
 * ## The defect it prevents
 *
 * `RDF_IMPORT_MAX_SUBJECTS = 1_000_000` and `RDF_IMPORT_MAX_RECORDS` refused a benchmark whose records fit (BSBM at 10 000 products, 1.7 to 2.0
 * million records) and, on a small instance, would have let one import exhaust the heap: the figure was not derived from memory. The bound is
 * now `import-memory.ts`'s answer (`importMemoryRoom`), asked once per import. A count typed back into one of these three modules would be a
 * second bound that nothing keeps in step with it.
 *
 * ## What it reads
 *
 * Every number written with six or more digits (`1_000_000`, `1000000`, `1e6`, `10 ** 6`) in the three modules, comments stripped, and every use
 * of a retired bound name. The bounds that are not a record count are named here, each with its reason and a review date (the 10 000 000-quad
 * bound is the file's, not the index's): the lint tells them apart by the name they are declared under, and fails when an entry names a constant
 * the module no longer declares, so an exception cannot outlive its subject. The proof plants the old literal and a retired name and sees both found.
 *
 * Run: node --test testing/standalone/the-rdf-import-record-sets-hold-no-record-count-literal.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SCANNED = ['server/src/rdf/import-spool.ts', 'server/src/rdf/import-index.ts', 'server/src/rdf/import-count.ts'];
const RETIRED = ['RDF_IMPORT_MAX_SUBJECTS', 'RDF_IMPORT_MAX_RECORDS', 'RDF_IMPORT_EDGE_STATEMENT_MULTIPLE'];
/** Any number as written (separators, an exponent, a power of ten): {@link valueOf} says whether it is a record count's size. */
const NUMBER = /(?<![\w.])(?:10 \*\* \d+|\d[\d_]*(?:e\d+)?)(?![\w.])/g;
const RECORD_COUNT_SIZE = 100_000;
const valueOf = (written) => (written.includes('**') ? 10 ** Number(written.split('**')[1]) : Number(written.replaceAll('_', '')));
/** Bounds that are not a record count, by the constant they are declared under: the lint reads the declaring line, never a figure. */
const ALLOWED = [
  { name: 'RDF_IMPORT_MAX_QUADS', reason: 'the quads of one file (the parser\'s 1 GiB at about 100 bytes a line): a bound on the file, not on the index', reviewBy: '2027-06-30' },
  { name: 'RDF_IMPORT_MAX_SUBJECT_CHARS', reason: 'the characters of one subject\'s quads, a group held whole in memory: a size, not a count of records', reviewBy: '2027-06-30' },
  { name: 'RDF_IMPORT_SORT_RUN_BYTES', reason: 'the characters of line text one sort run holds: what bounds the sort\'s memory, refusing nothing', reviewBy: '2027-06-30' },
];

const read = (file) => stripComments(fs.readFileSync(`${root}/${file}`, 'utf8').replaceAll('\r\n', '\n'));

/**
 * The record-count literals and retired names of `text`, each as `<what> in: <the line>` (the line's own text, not its number: the text is read
 * with its comments stripped, so a number counted in it would not be the file's); a line that declares an allowed constant is spared its figure.
 */
function findings(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const declared = ALLOWED.find(a => new RegExp(`\\bconst ${a.name}\\b`).test(line));
    if (!declared) for (const m of line.matchAll(NUMBER)) if (valueOf(m[0]) >= RECORD_COUNT_SIZE) out.push(`the literal ${m[0]} in: ${line.trim()}`);
    for (const name of RETIRED) if (line.includes(name)) out.push(`the retired bound ${name} in: ${line.trim()}`);
  }
  return out;
}
const whats = (list) => list.map(f => f.split(' in: ')[0]);

describe('the import\'s spool, index and count hold no record-count literal', () => {
  for (const file of SCANNED) {
    it(`${file} holds no number of six digits or more outside the bounds named as not a record count, and no retired bound name`, () => {
      assert.deepEqual(findings(read(file)), [], `${file} types a record count or names a retired bound`);
    });
  }

  it('every exception is explained, in date, and names a constant a scanned module still declares', () => {
    const today = new Date().toISOString().slice(0, 10);
    const declaredIn = SCANNED.map(read).join('\n');
    console.log(`${ALLOWED.length} exceptions`);
    for (const a of ALLOWED) {
      assert.ok(a.reason.length > 20, `${a.name} has no reason`);
      assert.ok(a.reviewBy > today, `${a.name} is past its review date ${a.reviewBy}`);
      assert.match(declaredIn, new RegExp(`\\bconst ${a.name} =`), `${a.name} is named as an exception but no scanned module declares it`);
    }
  });

  it('sees the old literal and a retired name when they are planted, and spares the quad bound (a lint that finds nothing proves nothing)', () => {
    const old = 'export const RDF_IMPORT_MAX_SUBJECTS = 1_000_000;';
    assert.equal(findings(old).length, 2, 'the old literal and its name were not both found');
    assert.deepEqual(whats(findings('const limit = 1000000;')), ['the literal 1000000']);
    assert.deepEqual(whats(findings('const limit = 2e6;')), ['the literal 2e6']);
    assert.deepEqual(whats(findings('const limit = 10 ** 6;')), ['the literal 10 ** 6']);
    assert.deepEqual(findings('export const RDF_IMPORT_MAX_QUADS = 10_000_000;'), [], 'the quad bound was taken for a record count');
    assert.equal(findings('export const RDF_IMPORT_MAX_QUADS_X = 10_000_000;').length, 1, 'a constant that only starts with an allowed name was spared');
    assert.deepEqual(findings('const small = 99_999 + 12345;'), [], 'a number under six digits was taken for a record count');
  });

  it('no source of the import speaks of a "record bound": what bounds it is memory (a stale phrase the act kept after the count went)', () => {
    const STALE = /\brecords?[' ]?s? bound\b/i;
    const sources = ['server/src/spaces/rdf-import-act.ts', 'server/src/spaces/rdf-import-schema-step.ts', 'server/src/rdf/import-memory.ts', 'server/src/rdf/import-window.ts',
      'server/src/rdf/import-ends.ts', ...SCANNED];
    for (const file of sources) assert.doesNotMatch(read(file), STALE, `${file} still speaks of a record bound: say the memory bound`);
    assert.match('the index\'s record bound', STALE, 'the lint does not see the phrase it hunts');
    assert.doesNotMatch('the memory bound of the index', STALE);
  });

  it('the quad bound is still declared where the lint says it is, as the one bound of ten million quads', () => {
    assert.match(read('server/src/rdf/import-spool.ts'), /export const RDF_IMPORT_MAX_QUADS = 10_000_000;/, 'the owner\'s answer keeps the quad bound');
  });
});
