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
 *
 * Read over the tracked `.mjs` of `scripts/`, `testing/_init/`, `testing/_shared/` and `testing/standalone/` with
 * comments blanked, and a floor on the listing.
 *
 * Run: node --test testing/standalone/a-results-folder-has-one-reader-and-one-name.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const LISTER = 'scripts/_shared/timing-results.mjs';
const NAMER = 'testing/_shared/timing-reporter.mjs';

/** Each rule: what it looks for, who may hold it, and what it says. */
const RULES = [
  { re: /readdirSync\([^;]*\.jsonl/, allowed: LISTER, why: 'lists a directory for *.jsonl itself' },
  { re: /(['"`])test-results\1/, allowed: NAMER, why: "spells the results folder as 'test-results'" },
  { re: /\bendLineOf\b/, allowed: null, why: 're-derives the sentinel readTimingLog returns' },
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
    ];
    for (const [name, text, expected] of cases) {
      it(`${name}: ${expected} break(s)`, () => assert.equal(breaks('scripts/x.mjs', text).length, expected));
    }
  });
});
