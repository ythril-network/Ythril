/**
 * The timing results folder is listed by one function and named in one place (bundle-56 dedup,
 * `check-i-no-second-copy-written`).
 *
 * ## What this prevents
 *
 * `readTimingResults` refused an incomplete folder while `test-times.mjs` listed the same directory itself in two more
 * places, each with its own idea of which files are the run's; `endLineOf` re-derived the sentinel `readTimingLog`
 * already returns; and the folder's name was a literal in the recorder, in the flags helper and twice in the test
 * harness. A rename of the folder, or of what counts as a results file, then reaches some readers and not the others,
 * and the one that is missed reads a different run.
 *
 * ## The rule, and how it is read
 *
 * - Nothing outside `scripts/_shared/timing-results.mjs` lists a directory for `*.jsonl` (`readdirSync(...)` followed
 *   by the `.jsonl` suffix) — `timingResultFiles` is the listing, `readTimingResults` the refusing reader built on it.
 * - Nothing outside `testing/_shared/timing-reporter.mjs` spells the folder as the bare string `'test-results'` —
 *   `TIMING_RESULTS_FOLDER` is the name. (A YAML or prose mention such as `test-results/` is text, not a name.)
 * - Nothing re-derives the sentinel: no `endLineOf`.
 * - Nothing joins or resolves `TIMING_RESULTS_FOLDER` (a NAME) to a root, or takes it as the folder: `timingResultsDir`
 *   is the place, and it honours `YTHRIL_TEST_RESULTS_DIR` (an absolute path; unset, the folder is in the checkout, as CI
 *   has it). Only the namer spells that variable.
 * - Scratch is not inside a checkout: no path made of a checkout's root and `tmp`, and only `scripts/_shared/scratch-root.mjs`
 *   spells `YTHRIL_TEMP_ROOT` (else the OS temporary folder). `tmp/` is also no longer a place `.gitignore` registers.
 *
 * Read over the tracked `.mjs` of `scripts/`, `testing/_init/`, `testing/_shared/` and `testing/standalone/` with
 * comments blanked, and a floor on the listing.
 *
 * Run: node --test testing/standalone/a-results-folder-has-one-reader-and-one-name.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { TIMING_RESULTS_FOLDER, TEST_RESULTS_DIR_ENV, timingResultsDir } from '../_shared/timing-reporter.mjs';
import { SCRATCH_ROOT_ENV, DEFAULT_SCRATCH_FOLDER, scratchRoot } from '../../scripts/_shared/scratch-root.mjs';

const LISTER = 'scripts/_shared/timing-results.mjs';
const NAMER = 'testing/_shared/timing-reporter.mjs';
const SCRATCH_NAMER = 'scripts/_shared/scratch-root.mjs';

/** Each rule: what it looks for, who may hold it, and what it says. */
const RULES = [
  { re: /readdirSync\([^;]*\.jsonl/, allowed: LISTER, why: 'lists a directory for *.jsonl itself' },
  { re: /(['"`])test-results\1/, allowed: NAMER, why: "spells the results folder as 'test-results'" },
  { re: /\bendLineOf\b/, allowed: null, why: 're-derives the sentinel readTimingLog returns' },
  // The folder NAME is not a place: joined to a root or taken as the folder, it ignores YTHRIL_TEST_RESULTS_DIR.
  { re: /\b(?:join|resolve)\([^;\n]*\bTIMING_RESULTS_FOLDER\b|=\s*TIMING_RESULTS_FOLDER\b/, allowed: NAMER, why: 'builds the results folder from its name; ask timingResultsDir' },
  { re: /\bYTHRIL_TEST_RESULTS_DIR\b/, allowed: NAMER, why: 'names the results-folder variable itself; import TEST_RESULTS_DIR_ENV' },
  // Scratch lives outside every checkout: a path made of a checkout's root and `tmp` puts it back inside one.
  { re: /(?:\bREPO_ROOT\b|\bROOT\b|\broot\b|\brepoRoot\b|\bcwd\b|process\.cwd\(\))[^;\n]*(['"`])tmp\1/, allowed: null, why: "builds a scratch folder 'tmp' inside a checkout; ask scratchRoot" },
  { re: /\bYTHRIL_TEMP_ROOT\b/, allowed: SCRATCH_NAMER, why: 'names the scratch-root variable itself; import SCRATCH_ROOT_ENV' },
];

/** `[{ line, why }]` for the rules `text` breaks, `file` excused where a rule names it. */
function breaks(file, text) {
  const code = blankComments(text);
  return RULES.filter(r => r.allowed !== file).flatMap(r => {
    const m = r.re.exec(code);
    return m ? [{ line: code.slice(0, m.index).split('\n').length, why: r.why }] : [];
  });
}

describe('the timing results folder has one reader and one name', () => {
  const files = trackedSources(['scripts', 'testing/_init', 'testing/_shared', 'testing/standalone'], { ext: ['.mjs'], floor: 80 });

  it('no file lists the folder, spells its name or re-derives its sentinel outside the module that owns it', () => {
    assert.ok(files.length > 80, `only scanned ${files.length} files`);
    const found = files.flatMap(f => breaks(f, readFileSync(join(REPO_ROOT, f), 'utf8')).map(b => `${f}:${b.line} ${b.why}`));
    assert.deepEqual(found, [], 'use timingResultFiles / readTimingResults, TIMING_RESULTS_FOLDER and readTimingLog');
  });

  it('the instrument sees each owner holding what it owns, so a clean tree means something', () => {
    assert.ok(files.includes(LISTER) && files.includes(NAMER), 'an owning module is not in the scanned set');
    const lister = blankComments(readFileSync(join(REPO_ROOT, LISTER), 'utf8'));
    const namer = blankComments(readFileSync(join(REPO_ROOT, NAMER), 'utf8'));
    assert.ok(RULES[0].re.test(lister), 'the listing rule does not see the one listing');
    assert.ok(RULES[1].re.test(namer), 'the name rule does not see the one name');
    // The variable rules must see their owners too, or a clean tree says nothing about them.
    assert.ok(files.includes(SCRATCH_NAMER), 'the scratch namer is not in the scanned set');
    const scratch = blankComments(readFileSync(join(REPO_ROOT, SCRATCH_NAMER), 'utf8'));
    const byWhy = (part) => RULES.find(r => r.why.includes(part));
    assert.ok(byWhy('results-folder variable').re.test(namer), 'the results-variable rule does not see the one place it is named');
    assert.ok(byWhy('scratch-root variable').re.test(scratch), 'the scratch-variable rule does not see the one place it is named');
  });

  it('the two namers do what the rules send callers to them for', () => {
    const root = join(REPO_ROOT, 'some-checkout');
    assert.equal(timingResultsDir(root, {}), join(root, TIMING_RESULTS_FOLDER), 'unset: the folder in the checkout (CI keeps this)');
    assert.equal(timingResultsDir(root, { [TEST_RESULTS_DIR_ENV]: '' }), join(root, TIMING_RESULTS_FOLDER), 'empty is unset');
    const elsewhere = join(REPO_ROOT, '..', 'results-elsewhere');
    assert.equal(timingResultsDir(root, { [TEST_RESULTS_DIR_ENV]: elsewhere }), resolve(elsewhere));
    assert.throws(() => timingResultsDir(root, { [TEST_RESULTS_DIR_ENV]: 'relative/dir' }), new RegExp(TEST_RESULTS_DIR_ENV));
    assert.equal(scratchRoot({ [SCRATCH_ROOT_ENV]: elsewhere }), resolve(elsewhere));
    assert.equal(scratchRoot({}), join(tmpdir(), DEFAULT_SCRATCH_FOLDER), 'unset: under the OS temporary folder');
    assert.ok(!resolve(scratchRoot({})).startsWith(resolve(REPO_ROOT)), 'the default scratch is outside this checkout');
    assert.throws(() => scratchRoot({ [SCRATCH_ROOT_ENV]: 'tmp' }), new RegExp(SCRATCH_ROOT_ENV));
  });

  describe('the detector, on snippets', () => {
    const cases = [
      ['the recorder\'s old listing', "const names = existsSync(RESULTS_DIR) ? readdirSync(RESULTS_DIR).filter(n => n.endsWith('.jsonl')).sort() : [];", 1],
      ['a listing split over lines', "readdirSync(dir)\n    .filter(f => f.endsWith('.jsonl'))", 1],
      ['a directory listing for something else', "readdirSync(UNRECORDED_DIR).filter(n => n.endsWith('.json'))", 0],
      ['a zip entry filter', "entries.filter(e => e.name.endsWith('.jsonl'))", 0],
      ['the folder spelled bare', "const RESULTS_DIR = 'test-results';", 1],
      ['the folder in a path with a slash (text, not a name)', "path: 'test-results/'", 0],
      ['a prefix such as the artifact name', "const m = /^test-results-(.+)-(\\d+)$/.exec(name);", 0],
      ['the old sentinel reader', 'function endLineOf(text) { return null; }', 1],
      ['the listing mentioned in a comment', "// readdirSync(dir).filter(f => f.endsWith('.jsonl'))\nconst x = 1;", 0],
      ['the folder name joined to a root', "const out = join(dir, TIMING_RESULTS_FOLDER);", 1],
      ['the folder name taken as the folder', 'const RESULTS_DIR = TIMING_RESULTS_FOLDER;', 1],
      ['the folder name resolved against the repository', "resolve(HERE, '..', '..', TIMING_RESULTS_FOLDER)", 1],
      ['the folder name as a .gitignore line (a name used as a name)', 'writeFileSync(f, `${TIMING_RESULTS_FOLDER}/\\n`);', 0],
      ['the namer asked for the place', 'const out = timingResultsDir(dir, {});', 0],
      ['the results variable spelled by hand', "const d = process.env.YTHRIL_TEST_RESULTS_DIR;", 1],
      ['the results variable by its constant', 'const d = process.env[TEST_RESULTS_DIR_ENV];', 0],
      ['scratch built from the checkout root', "const SCRATCH = join(ROOT, 'tmp', 'run');", 1],
      ['scratch built from the working directory', "const t = path.join(process.cwd(), 'tmp');", 1],
      ['scratch built from a repo root variable', "mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });", 1],
      ['a folder called tmp under a scratch directory that is not a checkout', "const tmpRoot = path.join(scratch, 'tmp');", 0],
      ['scratch asked of the namer', 'const t = join(scratchRoot(), "run");', 0],
      ['the scratch variable spelled by hand', "const t = process.env.YTHRIL_TEMP_ROOT;", 1],
    ];
    for (const [name, text, expected] of cases) {
      it(`${name}: ${expected} break(s)`, () => assert.equal(breaks('scripts/x.mjs', text).length, expected));
    }
  });
});
