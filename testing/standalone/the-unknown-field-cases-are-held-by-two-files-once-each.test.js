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
 * The two files, read as text, declare per case letter exactly the number of `it(` sites the unsplit file declared (`CASES`, read from the file at the
 * commit before the split); the first file holds the letters `a` to `h` and the second `i` to `p`, and no letter is in both. A site inside a loop over
 * the two modes stands for one case per mode, in the file it is in. `findings` says what is wrong with a pair of sources as strings, so the planted pairs
 * below prove each way of going wrong is named.
 *
 * Run: node --test testing/standalone/the-unknown-field-cases-are-held-by-two-files-once-each.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const FIRST = 'testing/standalone/an-unknown-field-is-answered-alike-on-both-doors-db.test.js';
const SECOND = 'testing/standalone/an-unknown-field-is-answered-alike-on-both-doors-part-2-db.test.js';

/** `it(` sites per case letter in the unsplit file, case (o) being another bundle's. A letter is the file's own, with the half that declares it. */
const CASES = {
  a: { sites: 3, half: 1 }, b: { sites: 1, half: 1 }, c: { sites: 2, half: 1 }, d: { sites: 1, half: 1 },
  e: { sites: 1, half: 1 }, f: { sites: 1, half: 1 }, g: { sites: 1, half: 1 }, h: { sites: 1, half: 1 },
  i: { sites: 1, half: 2 }, j: { sites: 2, half: 2 }, k: { sites: 1, half: 2 }, l: { sites: 1, half: 2 },
  m: { sites: 2, half: 2 }, n: { sites: 3, half: 2 }, p: { sites: 1, half: 2 },
};

/** The case letters of a file's `it(` titles, one entry per declaration site: a title begins with the case letter in parentheses. */
export function letterSites(text) {
  return [...text.matchAll(/^\s*it\(\s*[`'"]\(([a-z])\)/gm)].map(m => m[1]);
}

/** What is wrong with `first` and `second` (the two sources) as a split of `cases`, as strings; nothing when each case is declared once, in its half. */
export function findings(first, second, cases = CASES) {
  const out = [];
  const seen = [letterSites(first), letterSites(second)];
  for (const [letter, { sites, half }] of Object.entries(cases)) {
    const there = seen.map(s => s.filter(l => l === letter).length);
    const total = there[0] + there[1];
    if (total === 0) out.push(`case (${letter}) is declared in neither file`);
    else if (total > sites) out.push(`case (${letter}) is declared ${total} times, the unsplit file declared it ${sites}`);
    else if (total < sites) out.push(`case (${letter}) is declared ${total} time(s), the unsplit file declared it ${sites}`);
    if (there[2 - half] > 0) out.push(`case (${letter}) belongs to file ${half} and file ${3 - half} declares it ${there[2 - half]} time(s)`);
  }
  for (const [n, s] of seen.entries()) for (const l of new Set(s)) if (!(l in cases)) out.push(`file ${n + 1} declares a case (${l}) the unsplit file did not`);
  return out;
}

describe('the unknown-field cases are held by two files, once each', () => {
  it('the two files declare every case of the unsplit file once, each in its own half', () => {
    const first = readFileSync(join(REPO_ROOT, FIRST), 'utf8');
    const second = readFileSync(join(REPO_ROOT, SECOND), 'utf8');
    assert.ok(letterSites(first).length + letterSites(second).length >= 20, 'the scan reads almost no case: it has stopped reading the files');
    assert.deepEqual(findings(first, second), [], 'the split lost, repeated or misplaced a case');
  });

  const src = (...letters) => letters.map(l => `  it('(${l}) a case', () => {});\n`).join('');
  const whole = { a: { sites: 1, half: 1 }, b: { sites: 1, half: 1 }, i: { sites: 1, half: 2 }, j: { sites: 2, half: 2 } };

  it('a pair that holds every case once is clean', () => {
    assert.deepEqual(findings(src('a', 'b'), src('i', 'j', 'j'), whole), []);
  });

  it('a case in neither file, one declared too often, one declared too seldom and one the unsplit file never had are each named', () => {
    assert.deepEqual(findings(src('a'), src('i', 'j', 'j'), whole), ['case (b) is declared in neither file']);
    assert.deepEqual(findings(src('a', 'b', 'b'), src('i', 'j', 'j'), whole), ['case (b) is declared 2 times, the unsplit file declared it 1']);
    assert.deepEqual(findings(src('a', 'b'), src('i', 'j'), whole), ['case (j) is declared 1 time(s), the unsplit file declared it 2']);
    assert.deepEqual(findings(src('a', 'b', 'x'), src('i', 'j', 'j'), whole), ['file 1 declares a case (x) the unsplit file did not']);
  });

  it('a case moved to the other file is named, and so is one declared in both', () => {
    assert.deepEqual(findings(src('a', 'b', 'i'), src('j', 'j'), whole), ['case (i) belongs to file 2 and file 1 declares it 1 time(s)']);
    assert.deepEqual(findings(src('a', 'b', 'i'), src('i', 'j', 'j'), whole).sort(), [
      'case (i) belongs to file 2 and file 1 declares it 1 time(s)',
      'case (i) is declared 2 times, the unsplit file declared it 1',
    ]);
  });
});
