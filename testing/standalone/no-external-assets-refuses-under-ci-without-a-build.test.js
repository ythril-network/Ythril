/**
 * "A production build ships no remote asset reference" FAILS on CI when there is no build to read.
 *
 * ## The failure this prevents
 *
 * `no-external-assets.test.js` checks the BUILT `client/dist/browser/index.html` for a remote reference, and the
 * case opens with `if (!existsSync(dist)) return;` — "no build present; the source checks above still ran". On a
 * developer's machine that is a kindness. On a CI job that never built the client (and the test jobs of the
 * parallel layout this bundle introduces are exactly that: `standalone-pure` runs after `npm ci` and
 * `build:server`, with no `client/dist`) it makes the one check that reads what actually ships pass for ever,
 * reported as an ordinary pass. "The source is clean" is not "the output is clean" — the file says so in its own
 * words one line above the return.
 *
 * The rule: under `CI`, an absent `client/dist` is a failure naming the build to run; off `CI` it still lets a
 * laptop without a build run the rest (a skip there is fine and is the gate in
 * `a-test-that-finds-its-input-absent-says-so` to police). The job that runs the file builds the client.
 *
 * ## How it is exercised
 *
 * The real file, run as a child process with its working directory set to a scratch root, because the file reads
 * `process.cwd()` and the answer depends on what is under `client/dist` there — not on whether the machine
 * running THIS test happens to have built the client. One case is selected by name so the rest of the file's
 * checks (which read the whole repo) do not run. Four rows: CI and no build (must fail), no CI and no build
 * (must not), CI with a clean build (must pass), CI with a build that references a remote font (must fail).
 *
 * Run: node --test testing/standalone/no-external-assets-refuses-under-ci-without-a-build.test.js
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { CI_ENV_NAMES } from '../_shared/running-under-ci.mjs';

const TARGET = join(REPO_ROOT, 'testing', 'standalone', 'no-external-assets.test.js');
const CASE = 'a production build ships no remote asset reference either';

const CLEAN = '<!doctype html><html><head><link rel="stylesheet" href="styles-abc123.css"></head><body></body></html>';
const REMOTE = '<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"></head></html>';

describe('no-external-assets: the built-output case, by whether CI is set and a build exists', () => {
  /** @type {string[]} */
  const roots = [];

  /** A scratch cwd holding only what the file reads at load (NOTICE) and, optionally, a built index.html. */
  function scratchRoot(builtIndex) {
    const root = mkdtempSync(join(tmpdir(), 'ythril-no-external-assets-'));
    roots.push(root);
    copyFileSync(join(REPO_ROOT, 'NOTICE'), join(root, 'NOTICE'));
    if (builtIndex !== null) {
      mkdirSync(join(root, 'client', 'dist', 'browser'), { recursive: true });
      writeFileSync(join(root, 'client', 'dist', 'browser', 'index.html'), builtIndex);
    }
    return root;
  }

  /** Run the one case; report how the runner saw it. */
  function runCase(root, ci) {
    // Every variable the one CI reading looks at is dropped, not only CI: a real runner also sets GITHUB_ACTIONS, and
    // the "no CI" case would otherwise be CI there. `testChildEnv` drops the runner's wire (NODE_TEST_CONTEXT).
    const inherited = { ...process.env };
    for (const name of CI_ENV_NAMES) delete inherited[name];
    const env = testChildEnv(ci ? { CI: 'true' } : {}, inherited);
    const r = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern', CASE, TARGET],
      { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    const line = out.split('\n').find(l => l.includes(CASE) && /^\s*(not )?ok \d+/.test(l));
    return { status: r.status, line, out };
  }

  after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  it('CI set, no client/dist: the case FAILS — a build nobody made cannot pass for one that is clean', () => {
    const { line, out } = runCase(scratchRoot(null), true);
    assert.ok(line, `the case did not run at all:\n${out.slice(0, 1500)}`);
    assert.match(line, /^\s*not ok/, 'the case passed with no build to read — on CI that is a check that cannot fail');
  });

  it('CI set, no client/dist: the failure says what to run', () => {
    const { out } = runCase(scratchRoot(null), true);
    assert.match(out, /build:client|client\/dist/, 'the failure must name the build or the path so the job can be fixed from the log');
  });

  it('no CI, no client/dist: a laptop without a build is not failed for it', () => {
    const { line, out } = runCase(scratchRoot(null), false);
    assert.ok(line, `the case did not run at all:\n${out.slice(0, 1500)}`);
    assert.doesNotMatch(line, /^\s*not ok/, 'a developer with no build must still be able to run the rest of the file');
  });

  it('CI set, a clean build: passes', () => {
    const { line, out } = runCase(scratchRoot(CLEAN), true);
    assert.ok(line, `the case did not run at all:\n${out.slice(0, 1500)}`);
    assert.match(line, /^\s*ok/, 'a clean build must pass under CI');
  });

  it('CI set, a build that fetches a remote font: still fails (the check itself is unchanged)', () => {
    const { line, out } = runCase(scratchRoot(REMOTE), true);
    assert.ok(line, `the case did not run at all:\n${out.slice(0, 1500)}`);
    assert.match(line, /^\s*not ok/);
  });
});
