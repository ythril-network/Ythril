/**
 * The unknown-field cases are declared by two test files, and every case by exactly one of them (bundle-348).
 *
 * ## The defect this refuses
 *
 * The cases of `an-unknown-field-is-answered-alike-on-both-doors-db.test.js` were cut in two so the halves run side by side. A cut by hand can lose a case
 * (the `it` stays in neither file), repeat one (it runs twice, and a fix to one copy leaves the other), or leave a case in the half the other letters moved
 * out of. Every file stays green in each of those, so nothing but a count of the cases over BOTH files notices.
 *
 * ## The rule
 *
 * The two files, read as text, declare per case letter exactly the number of `it(` sites the unsplit file declared (`SPLIT`, read from the file at the
 * commit before the split); the first file holds the letters `a` to `h` and the second `i` to `p`, and no letter is in both. A site inside a loop over
 * the two modes stands for one case per mode, in the file it is in. The reading of the split is the shared one (`testing/_shared/split-cases-held-once.mjs`,
 * bundle-356), proven on planted files in `a-split-test-holds-each-case-in-exactly-one-file.test.js`; this file names the case by its letter.
 *
 * Run: node --test testing/standalone/the-unknown-field-cases-are-held-by-two-files-once-each.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { assertSplitCasesHeldOnce, splitCaseProblems } from '../_shared/split-cases-held-once.mjs';

const FIRST = 'testing/standalone/an-unknown-field-is-answered-alike-on-both-doors-db.test.js';
const SECOND = 'testing/standalone/an-unknown-field-is-answered-alike-on-both-doors-part-2-db.test.js';

/** Each half and its case letters, one entry per `it(` site of the unsplit file; case (o) is another bundle's. */
const SPLIT = {
  [FIRST]: ['a', 'a', 'a', 'b', 'c', 'c', 'd', 'e', 'f', 'g', 'h'],
  [SECOND]: ['i', 'j', 'j', 'k', 'l', 'm', 'm', 'n', 'n', 'n', 'p'],
};

/** The case letters of a file's `it(` titles, one entry per declaration site: a title begins with the case letter in parentheses. */
function letterSites(text) {
  return [...text.matchAll(/^\s*it\(\s*[`'"]\(([a-z])\)/gm)].map(m => m[1]);
}

describe('the unknown-field cases are held by two files, once each', () => {
  it('the two files declare every case of the unsplit file once, each in its own half', () => {
    assertSplitCasesHeldOnce(SPLIT, { namesOf: letterSites });
  });

  it('a case moved out of its half into the other is named, on the real files', () => {
    const first = readFileSync(join(REPO_ROOT, FIRST), 'utf8');
    const second = readFileSync(join(REPO_ROOT, SECOND), 'utf8');
    const site = first.match(/^\s*it\(\s*'\(h\)[^\n]*\n/m);
    assert.ok(site, 'the first half declares no case (h): the reading has stopped matching the file');
    const moved = [{ file: FIRST, text: first.replace(site[0], '') }, { file: SECOND, text: `${second}\n${site[0]}` }];
    assert.deepEqual(splitCaseProblems(moved, SPLIT, letterSites), [`wrong file: "h" is in ${SECOND}, not ${FIRST}`]);
  });
});
