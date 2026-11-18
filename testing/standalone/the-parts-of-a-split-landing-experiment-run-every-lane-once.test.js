/**
 * The part files of a split landing experiment run every lane of its table exactly once (bundle-348, Q-923).
 *
 * ## The defect this refuses
 *
 * `a-write-the-bound-ended-never-lands-db` and its late variant take longer than a file may, so each is cut into part files, each its
 * own process with its own door (`_landing-parts.mjs`). Every part is green on its own lanes, so a cut that drops a lane, or runs one
 * lane in two parts and another in none, is green everywhere while a holder or door is held nowhere. Asserted here, with no database:
 *
 * - the cut (`lanesOfPart`) is a partition of a table of any length into any count of parts, none empty, and it refuses a count that
 *   would leave a part empty;
 * - `partOf` refuses a stem that is not split and a part outside 0 to count-1;
 * - over the real files: each split experiment has exactly its count of part files, each declares `const PART = <n>;` and asks
 *   `partOf('<its stem>', PART)`, the name agrees with the index, the indexes are 0 to count-1 one file each, and no part file hands
 *   in a lane list of its own (`partProblems`). The lanes themselves are cut inside `landingExperiment` from the table it derives, so
 *   files that pass this run the whole table between them;
 * - a planted set of files proves each of those problems is named.
 *
 * Run: node --test testing/standalone/the-parts-of-a-split-landing-experiment-run-every-lane-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { SPLIT_EXPERIMENTS, partOf, lanesOfPart, partNamed, partProblems } from './_landing-parts.mjs';

describe('the parts of a split landing experiment run every lane once', () => {
  it('the cut is a partition of a table of any length into any count of parts, none empty', () => {
    for (let n = 1; n <= 80; n++) {
      for (const k of [1, 2, 3, 4, 5, 7]) {
        if (k > n) {
          assert.throws(() => lanesOfPart(n, 0, k), /would hold no lane/, `n ${n}, k ${k}: a cut with an empty part was not refused`);
          continue;
        }
        const parts = Array.from({ length: k }, (_, i) => lanesOfPart(n, i, k));
        const flat = parts.flat();
        assert.equal(new Set(flat).size, flat.length, `n ${n}, k ${k}: a lane is in two parts`);
        assert.deepEqual([...flat].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i), `n ${n}, k ${k}: the parts are not the table`);
        parts.forEach((p, i) => assert.ok(p.length > 0, `n ${n}, k ${k}: part ${i} is empty`));
      }
    }
    assert.throws(() => lanesOfPart(10, 2, 2), /is not a part/);
    assert.throws(() => lanesOfPart(10, -1, 2), /is not a part/);
    assert.throws(() => lanesOfPart(10, 0, 0), /is not a part/);
  });

  it('partOf answers a split experiment\'s part and refuses anything else', () => {
    const stems = Object.keys(SPLIT_EXPERIMENTS);
    assert.ok(stems.includes('a-write-the-bound-ended-never-lands') && stems.includes('a-write-the-bound-ended-never-lands-when-the-command-is-late'),
      `the split experiments are ${stems.join(', ')}: the base and the late experiment are not both cut by this module`);
    for (const [stem, count] of Object.entries(SPLIT_EXPERIMENTS)) {
      assert.ok(Number.isInteger(count) && count >= 2, `'${stem}' is cut into ${count} part(s)`);
      assert.deepEqual(partOf(stem, count - 1), { stem, index: count - 1, count });
      assert.throws(() => partOf(stem, count), /is not one of/);
    }
    assert.throws(() => partOf('a-write-the-bound-ended-never-lands-under-a-client-timeout', 0), /not a split experiment/);
  });

  it('a file name says which part it is, and a file of another experiment is no part of this one', () => {
    const stem = 'a-write-the-bound-ended-never-lands';
    assert.equal(partNamed(`testing/standalone/${stem}-db.test.js`, stem), 0);
    assert.equal(partNamed(`testing/standalone/${stem}-part-2-db.test.js`, stem), 1);
    assert.equal(partNamed(`testing/standalone/${stem}-when-the-command-is-late-db.test.js`, stem), undefined);
    assert.equal(partNamed(`testing/standalone/${stem}-on-a-narrow-run-db.test.js`, stem), undefined);
  });

  it('the real part files are each split experiment\'s parts 0 to count-1, one file each, each cut by partOf', () => {
    const files = readTrackedSources('testing/standalone', { ext: ['.test.js'], floor: 100 }).map(({ file, text }) => ({ file, text: stripComments(text) }));
    assert.deepEqual(partProblems(files), []);
  });

  it('names a missing part, a part run twice, a name that disagrees, a lane list of its own and a file that does not ask partOf (a planted set)', () => {
    const split = { 'x-exp': 3 };
    const file = (name, index, extra = '') => ({ file: `testing/standalone/${name}`, text: `const PART = ${index};\nlandingExperiment({ part: partOf('x-exp', PART)${extra} });\n` });
    const good = [file('x-exp-db.test.js', 0), file('x-exp-part-2-db.test.js', 1), file('x-exp-part-3-db.test.js', 2)];
    assert.deepEqual(partProblems(good, split), []);
    const problems = (set) => partProblems(set, split).join('\n');
    assert.match(problems(good.slice(0, 2)), /cut into 3 parts, and 2 file\(s\)[\s\S]*no file runs part 2/);
    assert.match(problems([good[0], good[1], file('x-exp-part-3-db.test.js', 1)]), /not the part its name says[\s\S]*part 1 of 'x-exp' is run by 2 files/);
    assert.match(problems([good[0], good[1], file('x-exp-part-3-db.test.js', 2, ', laneIndexes: [0]')]), /laneIndexes of its own/);
    assert.match(problems([good[0], good[1], { file: 'testing/standalone/x-exp-part-3-db.test.js', text: 'const PART = 2;\nlandingExperiment({ laneIndexes: [2] });\n' }]),
      /does not ask partOf\('x-exp', PART\)/);
    assert.match(problems([good[0], good[1], { file: 'testing/standalone/x-exp-part-3-db.test.js', text: 'landingExperiment({});\n' }]), /declares no `const PART/);
    assert.match(problems([good[0], good[1], file('x-exp-part-3-db.test.js', 2), file('x-exp-part-4-db.test.js', 3)]), /outside 0 to 2/);
  });
});
