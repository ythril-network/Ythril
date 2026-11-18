/**
 * No answer that says a record, a path or a space is not there (or not reachable) quotes the caller's value whole: every such text
 * builds it through `notFoundSentence` (`util/errors.ts`) or the renderer under it, `peerText` (`Q-367`).
 *
 * ## The finding
 *
 * `update_fact` with a 100 000-character `id` answered `Fact '<the id>' not found`: a 100 kB refusal for a 100 kB question, and the same in
 * every tool that names a record, an edge, a file path. The space name in a not-found answer was bounded long ago
 * (`unknownSpaceSentence`); the record id and the path were not, because each site wrote the sentence itself.
 *
 * ## What is derived, and from where
 *
 *  - **The scan**: every tracked `.ts` file of the server's code roots (`SERVER_CODE_ROOTS`), listed by git with its floor.
 *  - **The texts**: found in the syntax tree by `_not-found-answers.mjs` (a `NotFoundError`, a plain `Error` that says "not found",
 *    a `404` answer in each spelling a door has), so a comment that names the old wording neither satisfies nor fails it,
 *    and a new site of any of those shapes is judged without being listed here.
 *  - **The rule**: every value in such a text is a call of `notFoundSentence`, `peerText`, `peerList` or `unknownSpaceSentence`, a
 *    literal, or an UPPER_CASE constant. The one other way in is a row of the allowlist beside this file, with its reason and a review date.
 *
 * ## Proven
 *
 * Planted copies, derived from the repository's own bounded site (the bound is taken off it): the checker flags the planted line, and
 * does not flag the same line left in a comment. On the commit before this change the scan itself reported the sites it lists.
 *
 * Run: node --test testing/standalone/a-not-found-answer-bounds-the-value-it-names.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { unboundedTexts } from './_not-found-answers.mjs';
import { parseSource, ts, walkEveryNode } from '../_shared/syntax-tree.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./a-not-found-answer-bounds-the-value-it-names.allow.json', import.meta.url), 'utf8')).entries;
/** The scan must examine at least this many texts: a listing or a reader that is broken reports clean about nothing. */
const FLOOR_TEXTS = 100;
/** ... and find at least this many sites that already build their sentence through the function. */
const FLOOR_BOUNDED = 15;

const files = trackedSources(SERVER_CODE_ROOTS, { floor: 300 });
const scan = files.map(f => ({ f, ...unboundedTexts(f, readFileSync(join(REPO_ROOT, f), 'utf8')) }));

describe('a not-found answer bounds the value it names', () => {
  it('examines the texts it is about, and finds the sites that use the function', () => {
    const texts = scan.reduce((n, s) => n + s.contexts, 0);
    const bounded = scan.reduce((n, s) => n + s.bounded, 0);
    assert.ok(texts >= FLOOR_TEXTS, `only ${texts} not-found text(s) examined (floor ${FLOOR_TEXTS}): the reader is broken, not the code`);
    assert.ok(bounded >= FLOOR_BOUNDED, `only ${bounded} call(s) of notFoundSentence (floor ${FLOOR_BOUNDED}): the sites were not moved onto it`);
  });

  it('no not-found or out-of-reach text carries a value that is not bounded, except a named exception', () => {
    const findings = scan.flatMap(s => s.findings);
    const excused = (x) => ALLOW.find(e => e.file === x.file && e.expression === x.expression);
    const open = findings.filter(x => !excused(x));
    assert.deepEqual(open.map(x => `${x.file}:${x.line} ${x.context}: ${x.expression}`), [],
      'a caller-chosen value reaches a not-found text whole: build it with notFoundSentence(noun, value), or peerText(value, { max: NAME_QUOTED })');
  });

  it('every exception has a reason and a review date that has not passed, and still excuses something', () => {
    const findings = scan.flatMap(s => s.findings);
    const today = new Date().toISOString().slice(0, 10);
    for (const e of ALLOW) {
      assert.ok(typeof e.reason === 'string' && e.reason.trim().length > 20, `${e.file}: ${e.expression} has no reason`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy ?? '') && e.reviewBy >= today, `${e.file}: ${e.expression} is past its review date (${e.reviewBy})`);
      assert.ok(findings.some(x => x.file === e.file && x.expression === e.expression), `${e.file}: ${e.expression} excuses nothing now; remove the row`);
    }
  });

  describe('planted copies, taken off the repository\'s own bounded site', () => {
    /** The first `new NotFoundError(notFoundSentence('Noun', value))` of the tree, as { file, source, call, noun, value }. */
    function site() {
      for (const { f } of scan) {
        const source = readFileSync(join(REPO_ROOT, f), 'utf8');
        const sf = parseSource(f, source);
        let found = null;
        walkEveryNode(sf, (n) => {
          if (found || !ts.isNewExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'NotFoundError') return;
          const arg = n.arguments?.[0];
          if (!arg || !ts.isCallExpression(arg) || !ts.isIdentifier(arg.expression) || arg.expression.text !== 'notFoundSentence') return;
          const [noun, value] = arg.arguments;
          if (!noun || !value || !ts.isStringLiteral(noun)) return;
          found = { file: f, source, start: arg.getStart(sf), end: arg.getEnd(), noun: noun.text, value: value.getText(sf), call: arg.getText(sf) };
        });
        if (found) return found;
      }
      return null;
    }

    it('the repository has a site to plant from', () => {
      assert.ok(site(), 'no `new NotFoundError(notFoundSentence(\'Noun\', value))` in the server code: the sites were not moved onto the function');
    });

    it('the bound taken off the site is flagged, with the line of the plant', () => {
      const s = site();
      assert.ok(s, 'no site to plant from');
      const planted = `${s.source.slice(0, s.start)}\`${s.noun} '\${${s.value}}' not found\`${s.source.slice(s.end)}`;
      assert.equal(unboundedTexts(s.file, s.source).findings.length, 0, 'the unplanted file is already flagged');
      const { findings } = unboundedTexts(s.file, planted);
      assert.equal(findings.length, 1, `the planted unbounded value was ${findings.length === 0 ? 'not flagged' : 'flagged more than once'}`);
      assert.equal(findings[0].line, s.source.slice(0, s.start).split('\n').length, 'the finding names a line other than the planted one');
    });

    it('the same text left in a comment is not flagged', () => {
      const s = site();
      assert.ok(s, 'no site to plant from');
      const lineStart = s.source.lastIndexOf('\n', s.start) + 1;
      const commented = `${s.source.slice(0, lineStart)}// throw new NotFoundError(\`${s.noun} '\${${s.value}}' not found\`);\n${s.source.slice(lineStart)}`;
      assert.equal(unboundedTexts(s.file, commented).findings.length, 0, 'a comment was read as code');
    });

    it('a noun built from a value is flagged: the noun is the one part that must be a literal', () => {
      const s = site();
      assert.ok(s, 'no site to plant from');
      const planted = `${s.source.slice(0, s.start)}notFoundSentence(String(${s.value}), ${s.value})${s.source.slice(s.end)}`;
      assert.equal(unboundedTexts(s.file, planted).findings.length, 1, 'a noun that is not a literal was accepted');
    });
  });
});
