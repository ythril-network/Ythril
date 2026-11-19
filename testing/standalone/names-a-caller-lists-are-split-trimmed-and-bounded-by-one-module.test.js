/**
 * The names a caller lists (`reason=a,b`, `fps=x,y`, an array on a tool) are split, trimmed and bounded in ONE module, `util/listed-names.ts`
 * (bundle-285, Q-938; found at the second site, as the rule is: the unconverted list's reasons and the schema versions' fingerprints).
 *
 * ## Why this exists
 *
 * `fpsOf` (schema-versions-acts.ts) and `reasonsOf` (unconverted-terms.ts) each turned "a comma text, or an array of them" into a list, and each
 * kept a different half of the rules: one trimmed and the other did not, one stopped reading at a bound and the other read every piece. A third
 * caller would have copied whichever it saw. The module keeps the forgettable parts inside (the trimming, the bound, the refusal of a value that is
 * neither text nor a list of texts), so no caller can drop them.
 *
 * ## What it must hold
 *
 *  - A text is split at commas; an array is each of its texts split the same way; every piece is trimmed and a blank piece is no piece. Order
 *    and repeats are kept (a caller that wants each once says so itself).
 *  - A blank text is a list with no name in it, NOT a refusal: whether that is "no filter" or "nothing named" is the caller's question.
 *  - A value that is neither a text nor an array of only texts (a number, an object, null, undefined, an array holding a number) is `not_text`,
 *    never an empty list: garbage must not read as "no filter".
 *  - The list is bounded: at most `max + 1` names come back and the rest is never read, with `over` saying the caller named more than `max`. A list
 *    of exactly `max` is not over.
 *  - Neither site splits a list by hand any more: no `.split(',')` is left in `server/src/spaces`, and both import the module.
 *
 * Red at the unchanged base because the module does not exist.
 *
 * Run: node --test testing/standalone/names-a-caller-lists-are-split-trimmed-and-bounded-by-one-module.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let listedNames, UnconvertedFilterParams, UNCONVERTED_REASONS;

before(async () => {
  ({ listedNames } = await import('../../server/dist/util/listed-names.js'));
  ({ UnconvertedFilterParams, UNCONVERTED_REASONS } = await import('../../server/dist/spaces/unconverted-terms.js'));
});

const names = (value, max = 10) => { const r = listedNames(value, max); assert.equal(r.kind, 'names', `expected names for ${JSON.stringify(value)}`); return r; };

describe('listedNames', () => {
  it('splits a text at commas, trims each piece and drops the blank ones', () => {
    assert.deepEqual(names(' a, b ,,c ,  ').names, ['a', 'b', 'c']);
    assert.deepEqual(names('one').names, ['one']);
  });

  it('reads an array as each of its texts split the same way, keeping order and repeats', () => {
    assert.deepEqual(names(['a,b', ' c ', 'a']).names, ['a', 'b', 'c', 'a']);
  });

  it('answers a blank text, an empty array and an array of blanks with no name, not with a refusal', () => {
    for (const blank of ['', '   ', ',', ' , ,', [], [''], [' ', ',']]) {
      const r = names(blank);
      assert.deepEqual(r.names, [], JSON.stringify(blank));
      assert.equal(r.over, false);
    }
  });

  it('refuses a value that is neither text nor a list of texts, instead of reading it as an empty list', () => {
    for (const garbage of [5, true, null, undefined, {}, { a: 1 }, ['a', 5], [null], ['a', ['b']], [{}], 0n, () => 'a']) {
      assert.deepEqual(listedNames(garbage, 10), { kind: 'not_text' }, String(garbage));
    }
  });

  it('is not over at exactly `max` names, and over beyond it, giving at most max + 1 names', () => {
    const exactly = names('a,b,c', 3);
    assert.equal(exactly.over, false);
    assert.deepEqual(exactly.names, ['a', 'b', 'c']);
    const beyond = names('a,b,c,d,e,f', 3);
    assert.equal(beyond.over, true);
    assert.equal(beyond.names.length, 4);
    assert.deepEqual(beyond.names, ['a', 'b', 'c', 'd']);
  });

  it('counts pieces, not texts, towards the bound, and stops reading at it', () => {
    assert.equal(names(['a,b', 'c,d'], 3).over, true);
    // A long text and a long array are cut where the bound is passed: the work does not grow with what the caller sent.
    const started = Date.now();
    const r = names('a,'.repeat(3_000_000), 5);
    assert.equal(r.over, true);
    assert.equal(r.names.length, 6);
    const longArray = Array.from({ length: 1_000_000 }, (_, i) => `n${i}`);
    assert.equal(names(longArray, 5).names.length, 6);
    assert.ok(Date.now() - started < 5_000, 'reading a huge list was not cut at the bound');
  });

  it('holds a blank piece out of the count: a long run of commas is not "many names"', () => {
    const r = names(',,,,,,,,,,,,,,,,,,,,a,,,,,,,,,,,,b', 3);
    assert.deepEqual(r.names, ['a', 'b']);
    assert.equal(r.over, false);
  });
});

describe('the unconverted list\'s reasons, through the module', () => {
  const parse = (reason) => UnconvertedFilterParams.safeParse({ reason });
  let first, second;
  before(() => { [first, second] = UNCONVERTED_REASONS; });

  it('reads one reason as itself, a comma text and an array as lists in the order given, each once, and a blank as no filter', () => {
    assert.deepEqual(parse(first).data?.reason, [first]);
    assert.deepEqual(parse(` ${first} , ${second} ,${first}`).data?.reason, [first, second]);
    assert.deepEqual(parse([`${second},${first}`]).data?.reason, [second, first]);
    assert.equal(parse('  ,  ').data?.reason, undefined);
    assert.equal(parse(undefined).data?.reason, undefined);
  });

  it('refuses a value that is not a reason, a non-text value, and a list longer than there are reasons', () => {
    assert.equal(parse('not-a-reason').success, false);
    assert.equal(parse(5).success, false);
    assert.equal(parse([first, 5]).success, false);
    assert.equal(parse(Array.from({ length: UNCONVERTED_REASONS.length + 1 }, () => first)).success, false);
    assert.equal(parse(Array.from({ length: UNCONVERTED_REASONS.length }, () => first)).success, true);
  });
});

describe('no second copy of the split', () => {
  const spaces = join(import.meta.dirname, '../../server/src/spaces');
  const files = readdirSync(spaces).filter(f => f.endsWith('.ts'));

  it('leaves no .split(\',\') in server/src/spaces', () => {
    const hits = files.filter(f => /\.split\(\s*['"],['"]\s*\)/.test(readFileSync(join(spaces, f), 'utf8')));
    assert.deepEqual(hits, [], 'a list is split by util/listed-names.ts, not by hand');
  });

  it('has both known callers ask the module', () => {
    for (const f of ['schema-versions-acts.ts', 'unconverted-terms.ts']) {
      assert.match(readFileSync(join(spaces, f), 'utf8'), /from '\.\.\/util\/listed-names\.js'/, `${f} imports util/listed-names.js`);
    }
  });
});
