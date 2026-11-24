/**
 * The first pass of a schema inferred from an RDF data file does work linear in what a subject states, and stops reading as soon as the file's
 * distinct classes pass the bound (bundle-270, Q-755, lens fix round, items I1 and I2).
 *
 * ## The rule
 *
 * - I2: a subject with many types and many predicates costs a number of comparisons that grows with its quads, not with their product. The
 *   work is counted, never timed: every scan of a wide array (a lookup by `includes`, `indexOf`, `lastIndexOf`, `some`, `every`, `find`, `findIndex`,
 *   `findLast` or `findLastIndex`) adds the array's length to a tally, and the
 *   tally of a subject with 600 types and 600 other statements stays far under what one scan per statement would cost (600 times 600).
 * - I1: the classes a file's subjects are typed with are bounded like its predicates: one class past the bound answers `over` naming the bound,
 *   and the reading stops at the group that passed it, so a file of millions of classes never builds its maps.
 *
 * Run: node --test testing/standalone/the-schema-inference-reads-a-subjects-types-in-linear-work-and-stops-at-its-class-bound.test.js (server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { namesAt } from './_rdf-import-spool-doors.mjs';

const BASE = 'https://data.example.org/ld/infer/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const iri = (value) => ({ kind: 'iri', value });
const WIDE = 200;
/** Every array method that looks an element up by walking the array: a scan written with any of them counts, not only `includes`. */
const SEARCHES = ['includes', 'indexOf', 'lastIndexOf', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex'];

/** The quads of one subject: `types` class statements and `others` statements of distinct predicates, each with a plain literal. */
function wideSubject(types, others) {
  const subject = iri('https://people.example/wide');
  const quads = [];
  for (let n = 0; n < types; n++) quads.push({ subject, predicate: iri(RDF_TYPE), object: iri(`https://vocab.example/Class${n}`) });
  for (let n = 0; n < others; n++) quads.push({ subject, predicate: iri(`https://vocab.example/p${n}`), object: { kind: 'literal', value: `v${n}` } });
  return { key: `wide`, subject, quads };
}

describe('the schema inference reads a subject in linear work and stops at its class bound', () => {
  let gatherClasses, names;
  before(async () => {
    ({ gatherClasses } = await import('../../server/dist/rdf/schema-from-data.js'));
    names = await namesAt(BASE);
  });
  const sourceOf = (groups, onRead = () => {}) => ({
    groups: async function* () { for (const g of groups) { onRead(g); yield g; } },
    skip: new Set(), namesOf: () => names, blankNodes: 'refuse',
  });
  const ROOMY = { predicates: 1000, classes: 1000 };

  it('I2: a subject with 600 types and 600 other statements costs far fewer comparisons than one scan per statement', async () => {
    const originals = SEARCHES.map(name => [name, Array.prototype[name]]);
    let scanned = 0;
    for (const [name, original] of originals) {
      Array.prototype[name] = function (...args) {
        if (this.length >= WIDE) scanned += this.length;
        return original.apply(this, args);
      };
    }
    let read;
    try { read = await gatherClasses(sourceOf([wideSubject(600, 600)]), ROOMY); } finally { for (const [name, original] of originals) Array.prototype[name] = original; }
    assert.equal(read.kind, 'classes', JSON.stringify(read).slice(0, 200));
    assert.equal(read.classes.length, 600, 'every class is read');
    assert.equal(read.predicates.size, 600, 'every predicate is read');
    assert.ok(scanned <= 12_000, `${scanned} elements scanned by lookups over wide arrays; one scan per statement is 360000 and more`);
  });

  it('I1: a file typing subjects with one class past the bound is over, naming the bound, and is read no further than that class', async () => {
    const groups = Array.from({ length: 10 }, (_, n) => {
      const subject = iri(`https://people.example/s${n}`);
      return { key: `s${n}`, subject, quads: [{ subject, predicate: iri(RDF_TYPE), object: iri(`https://vocab.example/Class${n}`) }] };
    });
    let reads = 0;
    const read = await gatherClasses(sourceOf(groups, () => { reads += 1; }), { predicates: 1000, classes: 3 });
    assert.deepEqual(read, { kind: 'over', bound: 'classes', limit: 3 });
    assert.equal(reads, 4, 'the fourth class is the one that passed the bound, and nothing after it is read');
  });

  it('I1: a file with exactly as many classes as the bound is read whole', async () => {
    const groups = Array.from({ length: 6 }, (_, n) => {
      const subject = iri(`https://people.example/s${n}`);
      return { key: `s${n}`, subject, quads: [{ subject, predicate: iri(RDF_TYPE), object: iri(`https://vocab.example/Class${n % 3}`) }] };
    });
    const read = await gatherClasses(sourceOf(groups), { predicates: 1000, classes: 3 });
    assert.equal(read.kind, 'classes', JSON.stringify(read).slice(0, 200));
    assert.equal(read.classes.length, 3);
  });

  it('the predicate bound still refuses with its own name', async () => {
    const read = await gatherClasses(sourceOf([wideSubject(1, 5)]), { predicates: 4, classes: 1000 });
    assert.deepEqual(read, { kind: 'over', bound: 'predicates', limit: 4 });
  });
});
