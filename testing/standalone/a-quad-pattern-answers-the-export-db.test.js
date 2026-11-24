/**
 * The quad source answers every pattern exactly as the export would: for every record statement the export writes and every one of the 16
 * bound or unbound combinations of its four terms, the source returns that statement (complete) and returns nothing the export does not
 * write (sound), with its narrowing rules on and with them off (bundle-271, Q-756; design §0 and §1.4, r2 R1.1, R4.3).
 *
 * ## Why both runs
 *
 * The walk (every kind of every member, in `_id` order) is correct by construction; each narrowing rule is only an optimisation and must
 * give the walk's answer for the patterns it claims. A rule that drops a statement fails the narrowed run while the walk passes; a source
 * that never narrows passes both, so the narrowed run must also read fewer records than the walk.
 *
 * ## The rights half
 *
 * A token without `files: read` is answered no statement a file row writes: the source is held to the export that token gets, which leaves
 * the file kind out, and the source names the members whose file statements it withheld.
 *
 * ## Seen red
 *
 * On 2bfffd806: `server/src/rdf/quad-source.ts` does not exist. Mutations (seen red once the source exists): dropping the `edges {from}` find
 * of the subject rule (the narrowed run misses the edge statements of a bound subject); dropping the files predicate (file statements reach
 * the knowledge-only token).
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-quad-pattern-answers-the-export-db.test.js (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openQuadSourceFixture, A, B, FILE_PATH, baseOf, quadText, patternOf, drain } from './_quad-source-fixture.mjs';

const skip = await mongoSkipReason();
const MASKS = [...Array(16).keys()];
const YTHRIL_PATH = 'https://w3id.org/ythril/ns#path';

let fx, quadSource;
/** The records each full run read: the narrowed one and the walk. */
const reads = [];
const walks = [];

/** Run every pattern of every statement in `oracle` against a source made by `make`; misses and extras as text, and the records read. */
async function judge(make, oracle) {
  const allowed = new Set(oracle.map(quadText));
  const misses = [];
  const extras = new Set();
  let read = 0;
  for (const q of oracle) {
    for (const mask of MASKS) {
      const source = make();
      const got = await drain(source.match(...patternOf(q, mask)));
      read += source.recordsRead();
      const texts = new Set(got.map(quadText));
      if (!texts.has(quadText(q))) misses.push(`mask ${mask.toString(2).padStart(4, '0')}: ${quadText(q)}`);
      for (const t of texts) if (!allowed.has(t)) extras.add(t);
    }
  }
  return { misses, extras: [...extras], read };
}

describe('a quad pattern answers what the export writes, no more and no less', { skip }, () => {
  before(async () => {
    fx = await openQuadSourceFixture('qsrc-complete');
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
  });
  after(async () => { await fx?.d.close(); });

  it('the fixture exports what the rules can get wrong (a floor, so an empty export cannot pass)', () => {
    const texts = fx.exported.map(quadText);
    assert.ok(fx.exported.length >= 120, `only ${fx.exported.length} record statements exported`);
    for (const [what, needle] of [
      ['a file statement', `<${baseOf(A)}file/docs/plan.txt>`], ['the shared property address', 'q756/nickname'], ['the explicit edge address', 'q756/about'],
      ['the edge property', 'edge/knows#since'], ['an untyped entity', 'w3id.org/ythril/ns#Untyped'], ['the second space', `<${baseOf(B)}>`],
    ]) assert.ok(texts.some(t => t.includes(needle)), `the export holds no ${what} (${needle})`);
    assert.ok(!texts.some(t => t.includes('fork-1') || t.includes('old.txt')), 'the export carries a fork row or a deleted file');
  });

  for (const narrow of [true, false]) {
    it(`with narrowing ${narrow ? 'on' : 'off (the walk)'}: every statement under all 16 patterns, and nothing the export does not write`, async () => {
      const { createQuadSource } = needModule(quadSource, ['createQuadSource'], 'the quad source');
      const make = () => createQuadSource({ members: [A, B], caller: fx.reader }, { deadline: Date.now() + 60_000, narrow });
      const { misses, extras, read } = await judge(make, fx.exported);
      assert.deepEqual(misses.slice(0, 20), [], `${misses.length} of ${fx.exported.length * 16} patterns miss their statement`);
      assert.deepEqual(extras.slice(0, 20), [], `${extras.length} statements answered that the export does not write`);
      (narrow ? reads : walks).push(read);
    });
  }

  it('the narrowed run reads fewer records than the walk (narrowing is on, not a walk that passes alike)', () => {
    assert.equal(reads.length, 1, 'the narrowed run did not finish');
    assert.equal(walks.length, 1, 'the walk did not finish');
    assert.ok(reads[0] * 2 < walks[0], `narrowed ${reads[0]} records read, the walk ${walks[0]}`);
  });

  it('a token without files: read gets the export it gets, and no statement of a file row', async () => {
    const { createQuadSource } = needModule(quadSource, ['createQuadSource'], 'the quad source');
    const make = () => createQuadSource({ members: [A, B], caller: fx.knowledgeOnly }, { deadline: Date.now() + 60_000 });
    assert.ok(!fx.exportedKnowledgeOnly.some(q => q.predicate.value === YTHRIL_PATH), 'the knowledge-only export carries a file statement');
    const { misses, extras } = await judge(make, fx.exportedKnowledgeOnly);
    assert.deepEqual(misses.slice(0, 20), [], `${misses.length} patterns miss their statement`);
    assert.deepEqual(extras.slice(0, 20), [], `${extras.length} statements answered that the knowledge-only export does not write`);
    const file = `${baseOf(A)}file/${FILE_PATH}`;
    const source = make();
    const own = await drain(source.match(undefined, { termType: 'NamedNode', value: YTHRIL_PATH }, undefined, undefined));
    assert.deepEqual(own.map(quadText), [], `the file row ${file} was read for a token without files: read`);
    assert.deepEqual(source.filesWithheld(), [A, B], 'the members whose file statements were withheld');
  });
});
