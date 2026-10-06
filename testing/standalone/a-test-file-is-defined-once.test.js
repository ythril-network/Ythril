/**
 * What a test file IS, and listing the ones a checkout has, are written once, in `testing/standalone/_sources.mjs`
 * (bundle-56 dedup, `check-i-no-second-copy-written`).
 *
 * ## What this prevents
 *
 * Six sites each decided for themselves what a test file is: a regular expression over the whole repository in the
 * aggregator's scripts, `.test.js` under `testing/` in the body gates, a second regular expression in the
 * "every file reaches a job" test, a third listing in the standalone splitter, a fourth in the flags test, a fifth in
 * the CI-root fixture. The files they disagree about are the ones one check counts and another does not, and a
 * disagreement is invisible until a file falls between them. The suffixes are `TEST_FILE_SUFFIXES`, the question about
 * one path is `isTestFile`, the listing is `trackedTestFiles` / `trackedSources` — floor inside, `root` a parameter.
 *
 * ## The rule, and how it is read
 *
 * No `.mjs` under `scripts/`, `testing/_init/`, `testing/_shared/` or `testing/standalone/` outside `_sources.mjs`
 * BOTH runs `git ls-files` itself AND names a test-file suffix (`.test.js`, `.spec.ts`, ...). Such a file is a listing
 * of test files written by hand: it has its own floor or none, its own idea of the suffixes, its own working
 * directory. A file that names a suffix without listing (a runner's own glob) or lists without naming one (the layout
 * a fixture copies) asks a different question and is not this rule's. Comments are blanked first; the set scanned is
 * the tracked listing, with a floor.
 *
 * Run: node --test testing/standalone/a-test-file-is-defined-once.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import {
  REPO_ROOT, trackedSources, trackedTestFiles, isTestFile, TEST_FILE_SUFFIXES, TRACKED_TEST_FLOOR,
} from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const MODULE = 'testing/standalone/_sources.mjs';

/**
 * A test suffix being TESTED for, as code spells it: `endsWith('.test.js')` or a regular expression ending `\.test\.js$`.
 * Not a path that merely names a test file (`join(ROOT, 'testing/standalone/x.test.js')`), which is a reference, not a
 * definition of what a test file is.
 */
const TEST_SUFFIX = /endsWith\(\s*['"`]\.(?:test|spec)\.(?:[cm]?js|ts)['"`]|\\\.(?:test|spec)\\\.(?:[cm]?js|ts)\$/;

/** A hand-written test-file listing: it shells out to `ls-files` AND names a test suffix. */
function handWrittenListing(text) {
  const code = blankComments(text);
  return /['"`]ls-files['"`]/.test(code) && TEST_SUFFIX.test(code);
}

describe('a test file is defined once', () => {
  const files = trackedSources(['scripts', 'testing/_init', 'testing/_shared', 'testing/standalone'], { ext: ['.mjs'], floor: 80 });

  it('no file outside the module lists tracked files itself and names a test suffix', () => {
    assert.ok(files.length > 80, `only scanned ${files.length} files`);
    const found = files.filter(f => f !== MODULE && handWrittenListing(readFileSync(join(REPO_ROOT, f), 'utf8')));
    assert.deepEqual(found, [], 'list test files with trackedTestFiles / trackedSources (floor inside) and ask isTestFile about one path');
  });

  it('the instrument sees the one module that does both, so a clean tree means something', () => {
    assert.ok(files.includes(MODULE), 'the module is not in the scanned set');
    assert.equal(handWrittenListing(readFileSync(join(REPO_ROOT, MODULE), 'utf8')), true);
  });

  describe('the detector, on snippets', () => {
    const cases = [
      ['the splitter\'s old listing', "execFileSync('git', ['ls-files', 'testing/standalone'])\n.filter(f => f.endsWith('.test.js'))", true],
      ['a NUL-split listing with a suffix filter', "execFileSync('git', ['ls-files', '-z', 'testing']).filter(f => f.endsWith('.test.js'))", true],
      ['a regular expression over a listing', "execFileSync('git', ['ls-files']).filter(f => /\\.test\\.js$/.test(f))", true],
      ['a listing with no suffix (a layout copy)', "execFileSync('git', ['ls-files', '-z'])", false],
      ['a suffix with no listing (a runner glob)', "const glob = 'testing/standalone/*.test.js';", false],
      ['a listing of everything beside a path that names one test file', "execFileSync('git', ['ls-files', '-z']);\nconst GATE = join(ROOT, 'testing/standalone/x.test.js');", false],
      ['a docblock that mentions both', "/** `git ls-files` and *.test.js */\nconst x = 1;", false],
    ];
    for (const [name, text, expected] of cases) {
      it(`${name}: ${expected ? 'a hand-written listing' : 'not one'}`, () => assert.equal(handWrittenListing(text), expected));
    }
  });

  describe('the predicate', () => {
    for (const path of ['a.test.js', 'a/b.test.mjs', 'c.test.cjs', 'd.test.ts', 'e.spec.js', 'client/src/app/f.spec.ts', 'g.spec.mjs', 'h.spec.cjs']) {
      it(`${path} is a test file`, () => assert.equal(isTestFile(path), true));
    }
    for (const path of ['client/tsconfig.spec.json', 'testing/docker-compose.test.yml', 'a.test.js.map', 'helper.mjs', 'test.js', 'a.tests.js', '']) {
      it(`${JSON.stringify(path)} is not`, () => assert.equal(isTestFile(path), false));
    }
    it('the listing and the one-path question cannot disagree: every suffix a listing takes is one the predicate accepts', () => {
      for (const s of TEST_FILE_SUFFIXES) assert.equal(isTestFile(`x${s}`), true, s);
    });
    it('every tracked test file of this repository is found, at or over the floor', () => {
      const found = trackedTestFiles();
      assert.ok(found.length >= TRACKED_TEST_FLOOR);
      assert.ok(found.every(isTestFile));
    });
  });

  describe('a scratch checkout is listed through the same module (the `root` parameter), floor included', () => {
    let root, cleanup;
    before(() => {
      let git;
      ({ dir: root, git, cleanup } = makeScratchRepo({ prefix: 'ythril-test-files-' }));
      for (const f of ['a.test.js', 'sub/b.spec.ts', 'sub/helper.mjs', 'c.test.mjs', 'notes.md', 'types.d.ts']) {
        mkdirSync(dirname(join(root, f)), { recursive: true });
        writeFileSync(join(root, f), 'x\n');
      }
      git('add', '-A');
    });
    after(() => cleanup?.());

    it('lists the scratch checkout\'s test files, sorted, and nothing of this repository', () => {
      assert.deepEqual(trackedTestFiles({ root, floor: 1 }), ['a.test.js', 'c.test.mjs', 'sub/b.spec.ts']);
    });

    it('throws under its floor instead of returning a short list', () => {
      assert.throws(() => trackedTestFiles({ root }), /only 3 file\(s\) found/);
    });

    it('`ext: null` lists every tracked file, the declaration files included', () => {
      assert.deepEqual(trackedSources(['.'], { ext: null, floor: 1, root }),
        ['a.test.js', 'c.test.mjs', 'notes.md', 'sub/b.spec.ts', 'sub/helper.mjs', 'types.d.ts']);
    });
  });
});
