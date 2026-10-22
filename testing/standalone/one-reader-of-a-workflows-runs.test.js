/**
 * One module reads a workflow's runs through `gh`, and it holds the guards a hand-written copy drops (Q-588, Q-584).
 *
 * ## The failure this prevents
 *
 * `scripts/skip-check.mjs` read a CI run through `gh` with three guards of its own: a run id that is not all decimal digits is
 * refused before it reaches a command, the `gh` call is an argument array with a bound, and the workflow step it reads is found
 * by what it RUNS, with a refusal when two steps match. `scripts/trade.mjs` (Q-588) reads the same runs and needs the same three.
 * A second reader that spells them again is the defect this repo produces most (one rule, two implementations, the weaker one
 * wins): trade would read the Full run's step from a name written in its own source, or a run id from the command line unchecked,
 * and nothing would say so until a report was wrong. `scripts/_shared/ci-run-reader.mjs` is the one place; this gate holds it.
 *
 * ## The contract held here, one case per row
 *
 * - `readRun(id, { gh })` refuses an id that is not all decimal digits BEFORE `gh` is called (an id becomes part of an argument
 *   and, in `runAttemptsJobs`, of an endpoint path).
 * - `stepNameRunning(pattern, { ci })` returns the name of the one step of the parsed workflow whose `run` matches `pattern`, and
 *   THROWS when none or two match (and when the one that matches has no name): a guess would read the wrong step.
 * - `runAttemptsJobs(id, attempts, { gh })` asks `repos/ythril-network/Ythril/actions/runs/<id>/attempts/<n>/jobs` for EVERY n
 *   from 1 to `attempts`. `gh run view --json jobs` shows only the latest attempt (run 38605272758: attempt 2), so a database step
 *   that failed in attempt 1 and passed in attempt 2 is invisible to it.
 * - `ghJson(args, { exec })` runs `gh` with an argument array (never a shell string) and a 60 s timeout, and turns a missing
 *   `gh` (ENOENT) and a logged-out one ("gh auth login") into errors that say so, by name, instead of a raw spawn failure.
 * - `skip-check` imports its step finder and its run reader from that module, and no other script in `scripts/` spawns `gh`: the
 *   set of readers is DERIVED from the tracked scripts, with a floor, not listed here.
 *
 * ## The assumption about the injected `gh`
 *
 * `{ gh }` is a function from an argument array to what `gh` printed, already parsed as JSON (what `ghJson` returns); `{ exec }`
 * is `execFileSync`'s shape (`exec('gh', args, options)` returns stdout as a string). The cases hand the module such fakes and
 * assert on the ARGUMENT ARRAYS they receive, never on a shell string.
 *
 * Red at base: `scripts/_shared/ci-run-reader.mjs` does not exist, so every case that loads it fails on the import, and the
 * source cases fail because `skip-check.mjs` still spawns `gh` itself. The module is loaded when a case runs, so each case is red
 * on its own and not the whole file at once.
 *
 * Run: node --test testing/standalone/one-reader-of-a-workflows-runs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { loadCi } from '../_shared/ci-workflow.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

const READER_FILE = 'scripts/_shared/ci-run-reader.mjs';
const SKIP_CHECK_FILE = 'scripts/skip-check.mjs';
const REPO_SLUG = 'ythril-network/Ythril';

/** The module under test, loaded when a case runs. */
async function reader() {
  const mod = await import(new URL(`file:///${join(REPO_ROOT, READER_FILE).replace(/\\/g, '/')}`).href);
  for (const name of ['readRun', 'stepNameRunning', 'runAttemptsJobs', 'ghJson']) {
    assert.equal(typeof mod[name], 'function', `${READER_FILE} must export ${name}`);
  }
  return mod;
}

/** A `gh` fake: records every argument array it is handed and answers `answer(args)`. */
function fakeGh(answer = () => ({})) {
  const calls = [];
  const gh = (args) => { calls.push(args); return answer(args); };
  gh.calls = calls;
  return gh;
}

/** A ci.yml-shaped object: `jobs` as a map, each job with `steps`. */
const ciOf = (jobs) => ({ jobs: Object.fromEntries(Object.entries(jobs).map(([id, steps]) => [id, { name: id, steps }])) });

describe('readRun: a run id is all decimal digits, and is refused before gh is called', () => {
  for (const bad of ['', 'abc', '12x', 'x12', '1 2', '-1', '1.5', '../1', '0x1F', '1;2', '$(id)', '123\n456', ' 123']) {
    it(`refuses ${JSON.stringify(bad)} and never calls gh`, async () => {
      const { readRun } = await reader();
      const gh = fakeGh();
      await assert.rejects(async () => readRun(bad, { gh }), `a run id of ${JSON.stringify(bad)} was accepted`);
      assert.equal(gh.calls.length, 0, `gh was called with ${JSON.stringify(gh.calls)} for the refused id ${JSON.stringify(bad)}`);
    });
  }

  it('reads a decimal id with one gh call whose argument array holds the id as its own element, and returns what gh gave', async () => {
    const { readRun } = await reader();
    const run = { status: 'completed', attempt: 2 };
    const gh = fakeGh(() => run);
    const got = await readRun('39812174362', { gh });
    assert.deepEqual(got, run, 'the run gh answered is what readRun returns');
    assert.equal(gh.calls.length, 1, 'one call reads one run');
    assert.ok(Array.isArray(gh.calls[0]), 'gh is handed an argument array, not a shell string');
    assert.ok(gh.calls[0].every(a => typeof a === 'string'), 'every argument is a string');
    assert.ok(gh.calls[0].includes('39812174362'), 'the id is one argument of its own, never joined into a longer one');
    assert.ok(gh.calls[0].includes('run') && gh.calls[0].includes('view'), `it reads the run with gh run view: ${JSON.stringify(gh.calls[0])}`);
  });
});

describe('stepNameRunning: the one step that runs a command, found by what it runs', () => {
  it('returns the name of the one step whose run matches', async () => {
    const { stepNameRunning } = await reader();
    const ci = ciOf({
      build: [{ name: 'Install', run: 'npm ci' }, { name: 'Unit', run: 'npm run test:standalone:pure' }],
      full: [{ name: 'Database tests', run: 'npm run test:standalone:db' }, { uses: 'actions/checkout@v4' }],
    });
    assert.equal(stepNameRunning(/npm run test:standalone:db/, { ci }), 'Database tests');
  });

  it('is not misled by a step that only has a `uses`, or a run that does not match', async () => {
    const { stepNameRunning } = await reader();
    const ci = ciOf({ a: [{ uses: 'actions/checkout@v4', name: 'npm run test:standalone:db' }, { name: 'Other', run: 'echo hi' }, { name: 'Real', run: 'node scripts/unexpected-skips.mjs --results x' }] });
    assert.equal(stepNameRunning(/scripts\/unexpected-skips\.mjs/, { ci }), 'Real');
  });

  it('throws when no step matches: a guess would read the wrong step', async () => {
    const { stepNameRunning } = await reader();
    assert.throws(() => stepNameRunning(/npm run test:standalone:db/, { ci: ciOf({ a: [{ name: 'Unit', run: 'npm test' }] }) }), /0|no |none|expected one/i);
  });

  it('throws when two steps match, in one job or in two', async () => {
    const { stepNameRunning } = await reader();
    const sameJob = ciOf({ a: [{ name: 'One', run: 'npm run test:standalone:db' }, { name: 'Two', run: 'npm run test:standalone:db -- --x' }] });
    const twoJobs = ciOf({ a: [{ name: 'One', run: 'npm run test:standalone:db' }], b: [{ name: 'Two', run: 'npm run test:standalone:db' }] });
    assert.throws(() => stepNameRunning(/npm run test:standalone:db/, { ci: sameJob }), /2|two|more than one|expected one/i);
    assert.throws(() => stepNameRunning(/npm run test:standalone:db/, { ci: twoJobs }), /2|two|more than one|expected one/i);
  });

  it('throws when the one matching step has no name', async () => {
    const { stepNameRunning } = await reader();
    assert.throws(() => stepNameRunning(/npm run test:standalone:db/, { ci: ciOf({ a: [{ run: 'npm run test:standalone:db' }] }) }));
  });

  for (const pattern of [/npm run test:standalone:db/, /scripts\/unexpected-skips\.mjs/]) {
    it(`finds exactly one named step in the real ci.yml for ${pattern}`, async () => {
      const { stepNameRunning } = await reader();
      const name = stepNameRunning(pattern, { ci: loadCi() });
      assert.equal(typeof name, 'string');
      assert.ok(name.length > 0, 'the step has a name');
    });
  }

  it('finds the skip rule\'s step by the pattern skip-check used, and that step is the one the recorded run holds', async () => {
    const { stepNameRunning } = await reader();
    assert.equal(stepNameRunning(/scripts\/unexpected-skips\.mjs/, { ci: loadCi() }), 'No skip nobody expected');
  });
});

describe('runAttemptsJobs: every attempt\'s jobs, through the attempts endpoint', () => {
  const endpoint = (id, n) => `repos/${REPO_SLUG}/actions/runs/${id}/attempts/${n}/jobs`;
  const asked = (gh) => gh.calls.map(args => args.find(a => typeof a === 'string' && a.includes('/attempts/')));

  for (const attempts of [1, 2, 3]) {
    it(`asks for attempts 1..${attempts}, once each, in order, as one argument of an argument array`, async () => {
      const { runAttemptsJobs } = await reader();
      const gh = fakeGh();
      await runAttemptsJobs('38605272758', attempts, { gh });
      assert.deepEqual(asked(gh), Array.from({ length: attempts }, (_, i) => endpoint('38605272758', i + 1)));
      for (const args of gh.calls) {
        assert.ok(Array.isArray(args) && args.every(a => typeof a === 'string'), `an argument array of strings: ${JSON.stringify(args)}`);
        assert.equal(args[0], 'api', `the attempts endpoint is read with gh api: ${JSON.stringify(args)}`);
      }
    });
  }

  it('returns what each attempt answered, attempt 1 first', async () => {
    const { runAttemptsJobs } = await reader();
    const gh = fakeGh(args => ({ jobs: [{ marker: `answer-${args.find(a => a.includes('/attempts/')).match(/attempts\/(\d+)/)[1]}` }] }));
    const got = JSON.stringify(await runAttemptsJobs('38605272758', 2, { gh }));
    assert.ok(got.includes('answer-1') && got.includes('answer-2'), `both attempts are in the answer: ${got}`);
    assert.ok(got.indexOf('answer-1') < got.indexOf('answer-2'), 'attempt 1 comes before attempt 2');
  });

  it('refuses an id that is not all decimal digits before gh is called (the id is part of an endpoint path)', async () => {
    const { runAttemptsJobs } = await reader();
    for (const bad of ['', '12x', '../../orgs', '1/2', '1?x=2']) {
      const gh = fakeGh();
      await assert.rejects(async () => runAttemptsJobs(bad, 1, { gh }), `${JSON.stringify(bad)} was accepted`);
      assert.equal(gh.calls.length, 0, `gh was called for the refused id ${JSON.stringify(bad)}`);
    }
  });

  it('calls `beforeAttempt(n)` before every attempt\'s gh call, and a throw from it stops the reading before that call (a caller\'s deadline between attempts)', async () => {
    const { runAttemptsJobs } = await reader();
    const order = [];
    const gh = fakeGh(() => { order.push('gh'); return {}; });
    await runAttemptsJobs('38605272758', 2, { gh, beforeAttempt: (n) => order.push(`before-${n}`) });
    assert.deepEqual(order, ['before-1', 'gh', 'before-2', 'gh']);

    const stopped = fakeGh();
    await assert.rejects(
      async () => runAttemptsJobs('38605272758', 3, { gh: stopped, beforeAttempt: (n) => { if (n === 2) throw new Error('deadline'); } }),
      /deadline/,
    );
    assert.equal(stopped.calls.length, 1, 'attempt 2 was never asked for');
  });
});

describe('ghJson: an argument array, a bound, and a named error for a gh that is missing or logged out', () => {
  /** What `fn` throws, whether it throws at once or rejects; null when it does not fail. */
  const thrown = (fn) => Promise.resolve().then(fn).then(() => null, e => e);

  /** An `execFileSync` fake: records `(file, args, options)` and answers `answer()`, a string, or throws what it throws. */
  function fakeExec(answer) {
    const calls = [];
    const exec = (file, args, options) => { calls.push({ file, args, options }); return answer(); };
    exec.calls = calls;
    return exec;
  }

  it('runs gh with the argument array as given and a 60 s timeout, and returns the parsed JSON', async () => {
    const { ghJson } = await reader();
    const exec = fakeExec(() => '{"a":[1,2]}');
    const got = await ghJson(['run', 'list', '--json', 'headSha'], { exec });
    assert.deepEqual(got, { a: [1, 2] });
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].file, 'gh');
    assert.deepEqual(exec.calls[0].args, ['run', 'list', '--json', 'headSha']);
    assert.equal(exec.calls[0].options?.timeout, 60_000, 'the call is bounded at 60 s');
  });

  it('refuses a shell string where an argument array is required, before exec is called', async () => {
    const { ghJson } = await reader();
    const exec = fakeExec(() => '{}');
    await assert.rejects(async () => ghJson('run list --json headSha', { exec }));
    assert.equal(exec.calls.length, 0);
  });

  it('turns a missing gh (ENOENT) into a named error that says gh is not installed', async () => {
    const { ghJson } = await reader();
    const raw = Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT', errno: -4058, syscall: 'spawnSync gh' });
    const err = await thrown(() => ghJson(['run', 'list'], { exec: fakeExec(() => { throw raw; }) }));
    assert.ok(err instanceof Error, 'it throws an Error');
    assert.notEqual(err, raw, 'not the raw spawn failure');
    assert.notEqual(err.name, 'Error', `a named error, not the default one: ${err.name}`);
    assert.match(err.message, /\bgh\b/i, 'the message names gh');
    assert.match(err.message, /not installed|missing|not found|install/i, 'the message says it is missing');
  });

  for (const [how, make] of [
    ['in the message', () => Object.assign(new Error('Command failed: gh run list\nTo get started with GitHub CLI, please run:  gh auth login'), { status: 4 })],
    ['in stderr only', () => Object.assign(new Error('Command failed: gh run list'), { status: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' })],
  ]) {
    it(`turns a logged-out gh (the "gh auth login" text ${how}) into a named error that says to log in`, async () => {
      const { ghJson } = await reader();
      const raw = make();
      const err = await thrown(() => ghJson(['run', 'list'], { exec: fakeExec(() => { throw raw; }) }));
      assert.ok(err instanceof Error, 'it throws an Error');
      assert.notEqual(err, raw, 'not the raw exec failure');
      assert.notEqual(err.name, 'Error', `a named error, not the default one: ${err.name}`);
      assert.match(err.message, /log(ged)? ?in|auth/i, 'the message says gh is not logged in');
    });
  }

  it('the missing-gh error and the logged-out error are different names, so a caller can tell them apart', async () => {
    const { ghJson } = await reader();
    const enoent = await thrown(() => ghJson(['x'], { exec: fakeExec(() => { throw Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }); }) }));
    const auth = await thrown(() => ghJson(['x'], { exec: fakeExec(() => { throw Object.assign(new Error('gh auth login'), { status: 4 }); }) }));
    assert.ok(enoent && auth, 'both throw');
    assert.notEqual(enoent.name, auth.name);
  });

  it('lets any other failure through with its own message (a gh that ran and failed is not "missing")', async () => {
    const { ghJson } = await reader();
    const err = await thrown(() => ghJson(['run', 'view', '1'], { exec: fakeExec(() => { throw Object.assign(new Error('Command failed: gh run view 1\nHTTP 404: Not Found'), { status: 1 }); }) }));
    assert.ok(err, 'it throws');
    assert.match(err.message, /404|Not Found/, 'the cause is kept');
  });
});

describe('skip-check and every other script read runs through the one module', () => {
  const skipCheck = () => stripComments(readFileSync(join(REPO_ROOT, SKIP_CHECK_FILE), 'utf8'));

  it('skip-check imports its step finder and its run reader from scripts/_shared/ci-run-reader.mjs', () => {
    const src = skipCheck();
    const imp = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/_shared\/ci-run-reader\.mjs['"]/.exec(src);
    assert.ok(imp, `${SKIP_CHECK_FILE} imports nothing from ./_shared/ci-run-reader.mjs`);
    const names = imp[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    assert.ok(names.includes('stepNameRunning'), `the step finder is not imported from the shared module: ${names.join(', ')}`);
    assert.ok(names.includes('readRun'), `the run reader is not imported from the shared module: ${names.join(', ')}`);
  });

  it('skip-check no longer finds the step or spawns gh itself, and keeps skipVerdict as its export', () => {
    const src = skipCheck();
    assert.doesNotMatch(src, /\bexecFileSync\b|\bspawnSync\b/, `${SKIP_CHECK_FILE} still spawns a process of its own`);
    assert.doesNotMatch(src, /\bjobEntries\b|\bstepsOf\b|\bloadCi\b/, `${SKIP_CHECK_FILE} still walks ci.yml itself: the step finder is the shared module's`);
    assert.match(src, /export\s+(async\s+)?function\s+skipVerdict\b/, 'skipVerdict is still exported (its tests read it)');
  });

  it('no script but the shared reader spawns gh: the readers are derived from the tracked scripts, not listed', () => {
    // `untracked`: the reader is written before it is committed, and a gate that cannot see it would say it does not exist.
    const scripts = trackedSources(['scripts'], { ext: ['.mjs'], floor: 10, untracked: true });
    assert.ok(scripts.includes(READER_FILE), `${READER_FILE} does not exist: there is no one reader`);
    const spawners = scripts.filter((f) => {
      const src = stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
      return /\b(execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*['"`]gh\b/.test(src);
    });
    assert.deepEqual(spawners, [READER_FILE], `these scripts spawn gh: ${spawners.join(', ') || '(none)'}; only ${READER_FILE} may, so a second reader cannot drop the guards`);
  });

  it('the shared reader spawns gh with an argument array and a 60 s bound, and never builds a shell line', () => {
    const src = stripComments(readFileSync(join(REPO_ROOT, READER_FILE), 'utf8'));
    assert.doesNotMatch(src, /\bexecSync\b|shell\s*:\s*true/, 'a shell line or `shell: true` lets a run id become a command');
    assert.match(src, /timeout\s*:\s*60[_]?000/, 'the call has a 60 s bound');
  });
});

describe('the skip-check cases still pass, unchanged, against the shared reader', () => {
  it('node --test testing/standalone/skip-check-reads-cis-own-verdict.test.js exits 0 (a guard: green before the extraction, and it must stay so)', () => {
    const r = spawnSync(process.execPath, ['--test', join(REPO_ROOT, 'testing', 'standalone', 'skip-check-reads-cis-own-verdict.test.js')], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, env: testChildEnv({}),
    });
    assert.equal(r.status, 0, `the skip-check test failed:\n${String(r.stdout).split('\n').filter(l => /✖|not ok|fail/.test(l)).slice(0, 12).join('\n')}`);
  });
});
