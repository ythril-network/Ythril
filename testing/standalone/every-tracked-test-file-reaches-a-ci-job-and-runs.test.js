/**
 * Every tracked test file is reached by a CI job's selection (Q-283), and every one of them actually RAN.
 *
 * ## The failure this prevents
 *
 * A test file is only a test if something runs it. CI runs the union of what its jobs SELECT — four globs over
 * `testing/<suite>/*.test.js`, the standalone split, and the vitest `include` for the client — and nothing in the
 * repository asked whether that union was every test file there is. A file under `testing/bench/`, a spec outside
 * `client/src`, a test one directory deeper than a glob reaches: each is tracked, each looks like a test, each is
 * green in review because nobody ran it. It is the same defect as a skipped test with a different cause, and
 * "all tests pass" is no evidence about a test that was never started.
 *
 * Two derived sets answer it, and they fail differently:
 *
 *  - **Static: `scripts/unrun-tests.mjs`.** Tracked test files minus what each CI job's selection reaches, the
 *    selections read out of `package.json`'s scripts, the workflow and the vitest config — never listed by hand.
 *    Exits non-zero and names every file nothing reaches. It runs in preflight, so the mistake is found before a
 *    push rather than by a reader of the log.
 *  - **Executed: `scripts/executed-tests.mjs`.** Tracked test files minus the files with at least one test event
 *    in the timing reporter's JSONL files. It catches what a static read cannot — a file a glob DOES match that
 *    loads and registers no test (a top-level return, a `describe` whose callback throws before an `it`, a rename
 *    that lost its `it`). Exits non-zero and names them.
 *
 * Both are FLOORED: a derivation that finds nothing (no selections, no results) is a broken derivation and fails,
 * because an empty set minus an empty set is "nothing unrun" and reports success about a run that never was.
 *
 * ## How they are exercised
 *
 * Against a COPY of the real tracked test layout in a scratch directory with its own git index
 * (`_ci-root-fixture.mjs`), via `--root`: a file outside every selection is ADDED to the copy and must be named;
 * files inside each suite's selection are added beside it and must not be; a selection is NARROWED in the copy
 * (the vitest `include`) and the files it stops reaching must appear — which is what shows the selections are READ
 * rather than remembered. The working tree this runs from is never touched.
 *
 * Interface the scripts are held to (the one thing here that is a choice rather than a consequence):
 * `node scripts/unrun-tests.mjs [--root <dir>]`, `node scripts/executed-tests.mjs [--root <dir>] --results <dir>`;
 * stdout/stderr name the offending files by repo-relative path, exit 0 only when there are none. The results
 * directory holds `*.jsonl` in the timing reporter's own shape (`testing/_shared/timing-reporter.mjs`: `TIMING_SCHEMA`,
 * `readTimingLog`): one JSON object per line, a test as `{ type: 'test', file, status: 'pass' | 'fail', ... }` with `file`
 * repo-relative, a file that merely loaded as `{ type: 'file', file }`, and a closing sentinel `{ type: 'end', events: N, ... }`.
 * A first draft of this file named the events after node's (`test:pass`, `test:summary`); the reporter's `type` is the kind
 * of line, not node's event name, so the script follows the reporter and not the other way round.
 *
 * Run: node --test testing/standalone/every-tracked-test-file-reaches-a-ci-job-and-runs.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { makeCiRoot } from './_ci-root-fixture.mjs';
import { runScript } from './_run-script.mjs';

const script = (name) => join(REPO_ROOT, 'scripts', name);

/** Run one of the scripts; `status` null means it never produced one (a crash or a timeout). */
function run(name, args, cwd = REPO_ROOT) {
  return runScript(script(name), args, { cwd });
}

/** A minimal node test file: it imports the runner and registers one test. */
const TEST_FILE = "import { it } from 'node:test';\nit('registers', () => {});\n";
const SPEC_FILE = "import { it, expect } from 'vitest';\nit('registers', () => { expect(1).toBe(1); });\n";

const ROOT_SUITES = ['testing/integration', 'testing/sync', 'testing/red-team-tests', 'testing/standalone'];

describe('scripts/unrun-tests.mjs — a test file no CI job selection reaches', () => {
  let ci;
  before(() => { ci = makeCiRoot(); });
  after(() => ci.dispose());

  it('the real tree: every tracked test file is reached, so it exits 0 and names none', () => {
    const { status, out } = run('unrun-tests.mjs', []);
    assert.equal(status, 0, `the repository holds a test file no CI selection reaches, or the script failed:\n${out.slice(0, 2000)}`);
    assert.doesNotMatch(out, /[\w-]\.(test\.js|spec\.ts)\b/, 'a clean run must not list test files as unrun');
  });

  it('a file outside every selection is named, and the exit is non-zero', () => {
    ci.with({ add: { 'testing/bench/outside-every-job.test.js': TEST_FILE } }, () => {
      const { status, out } = run('unrun-tests.mjs', ['--root', ci.root]);
      assert.notEqual(status, 0, `a tracked test file that no job runs was reported clean:\n${out.slice(0, 1500)}`);
      assert.ok(out.includes('testing/bench/outside-every-job.test.js'), `the file is not named:\n${out.slice(0, 1500)}`);
    });
  });

  it('a spec outside the client\'s include is named too', () => {
    ci.with({ add: { 'client/tests/outside-vitest.spec.ts': SPEC_FILE } }, () => {
      const { status, out } = run('unrun-tests.mjs', ['--root', ci.root]);
      assert.notEqual(status, 0);
      assert.ok(out.includes('client/tests/outside-vitest.spec.ts'), `the spec is not named:\n${out.slice(0, 1500)}`);
    });
  });

  it('files inside each suite\'s selection, and a new spec under client/src, are not named', () => {
    const add = Object.fromEntries([
      ...ROOT_SUITES.map(d => [`${d}/zz-added-by-the-test.test.js`, TEST_FILE]),
      ['client/src/app/zz-added-by-the-test.spec.ts', SPEC_FILE],
    ]);
    ci.with({ add }, () => {
      const { status, out } = run('unrun-tests.mjs', ['--root', ci.root]);
      assert.equal(status, 0, `a file inside a selection was reported unrun — the script is not reading the selections:\n${out.slice(0, 1500)}`);
    });
  });

  it('the selections are READ: narrowing the vitest include leaves the specs it stops reaching unrun', () => {
    ci.with({
      replace: {
        'client/vitest.config.ts': (t) => t.replace("include: ['src/**/*.spec.ts']", "include: ['src/app/pages/**/*.spec.ts']"),
      },
    }, () => {
      const { status, out } = run('unrun-tests.mjs', ['--root', ci.root]);
      assert.notEqual(status, 0, 'a narrowed include left specs unreached and the script did not notice');
      assert.match(out, /client\/src\/app\/(core|shared)\/[^\s]*\.spec\.ts/, 'a spec outside the narrowed include is not named');
    });
  });

  it('a selection that cannot be derived fails — it does not read as "nothing unrun"', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ythril-empty-root-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: empty });
      writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
      spawnSync('git', ['add', '-A'], { cwd: empty });
      const { status, out } = run('unrun-tests.mjs', ['--root', empty]);
      assert.notEqual(status, 0, `a repository with no selections and no tests was reported clean:\n${out.slice(0, 800)}`);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('scripts/executed-tests.mjs — a tracked test file with no test event', () => {
  let ci;
  let resultsDirs = [];
  before(() => { ci = makeCiRoot(); });
  after(() => { ci.dispose(); for (const d of resultsDirs) rmSync(d, { recursive: true, force: true }); });

  const isTestFile = (f) => (/^testing\/.*\.test\.js$/.test(f)) || (/^client\/src\/.*\.spec\.ts$/.test(f));

  /** One line of the timing reporter's JSONL, with every key its schema has (`TIMING_SCHEMA`), so a reader is held to the real shape. */
  const line = (over) => ({
    suite: 'standalone', batch: '1', nesting: 0, skip: false, todo: false, reason: null, message: null,
    ...over,
  });

  /**
   * Write a results directory for the copy: one passing test event per tracked test file, spread over two JSONL
   * files (the union is what counts), except as `without` and `summaryOnly` say.
   */
  function results({ without = [], summaryOnly = [], failedOnly = [], skip = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ythril-results-'));
    resultsDirs.push(dir);
    if (skip) return dir;
    const files = ci.tracked().filter(isTestFile);
    assert.ok(files.length >= 500, `only ${files.length} test files in the copy — the listing is broken`);
    const halves = [[], []];
    files.forEach((file, i) => {
      if (without.includes(file)) return;
      const lines = halves[i % 2];
      if (summaryOnly.includes(file)) {
        lines.push(line({ type: 'file', file, test: file, ms: 3, status: 'pass' }));
      } else if (failedOnly.includes(file)) {
        lines.push(line({ type: 'test', file, test: 'registers', ms: 2, status: 'fail', message: 'boom' }));
      } else {
        lines.push(line({ type: 'test', file, test: 'registers', ms: 2, status: 'pass' }));
      }
    });
    halves.forEach((lines, i) => {
      mkdirSync(dir, { recursive: true });
      const all = [...lines, { type: 'end', events: lines.length, startedAt: '2026-10-05T00:00:00.000Z', endedAt: '2026-10-05T00:00:01.000Z', scope: 'full' }];
      writeFileSync(join(dir, `standalone-${i}.jsonl`), `${all.map(l => JSON.stringify(l)).join('\n')}\n`);
    });
    return dir;
  }

  const pick = (k) => ci.tracked().filter(isTestFile).filter(f => f.startsWith('testing/standalone/'))[k];

  it('every tracked test file has an event: exits 0', () => {
    const { status, out } = run('executed-tests.mjs', ['--root', ci.root, '--results', results()]);
    assert.equal(status, 0, `a run where every file reported was refused:\n${out.slice(0, 1500)}`);
  });

  it('a file with no event at all is named, and the exit is non-zero', () => {
    const missing = pick(3);
    const { status, out } = run('executed-tests.mjs', ['--root', ci.root, '--results', results({ without: [missing] })]);
    assert.notEqual(status, 0, 'a tracked test file that never ran was reported as executed');
    assert.ok(out.includes(missing), `${missing} is not named:\n${out.slice(0, 1500)}`);
  });

  it('a glob-matched file that loaded and registered NO test (a summary and nothing else) is named', () => {
    const empty = pick(7);
    const { status, out } = run('executed-tests.mjs', ['--root', ci.root, '--results', results({ summaryOnly: [empty] })]);
    assert.notEqual(status, 0, 'a file that registered no test was reported as executed');
    assert.ok(out.includes(empty), `${empty} is not named:\n${out.slice(0, 1500)}`);
  });

  it('a file whose only test FAILED did run — a failure is the run\'s to report, not this check\'s', () => {
    const failing = pick(11);
    const { status, out } = run('executed-tests.mjs', ['--root', ci.root, '--results', results({ failedOnly: [failing] })]);
    assert.equal(status, 0, `a file with a failing test was reported as not executed:\n${out.slice(0, 1500)}`);
  });

  it('only the unexecuted files are named, not their neighbours', () => {
    const a = pick(2);
    const b = pick(5);
    const { out } = run('executed-tests.mjs', ['--root', ci.root, '--results', results({ without: [a, b] })]);
    assert.ok(out.includes(a) && out.includes(b), `the two missing files are not both named:\n${out.slice(0, 1500)}`);
    assert.ok(!out.includes(pick(4)), 'a file that did run is named as unexecuted');
  });

  it('no results at all fails — an empty run is not a clean one', () => {
    const { status, out } = run('executed-tests.mjs', ['--root', ci.root, '--results', results({ skip: true })]);
    assert.notEqual(status, 0, `an empty results directory was reported clean:\n${out.slice(0, 800)}`);
  });
});
