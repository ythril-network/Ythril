/**
 * Every environment variable `scripts/` and `testing/_init/` read is named on the testing page.
 *
 * ## What this prevents
 *
 * `env-var-docs-coverage` holds that every variable the SERVER reads is documented, and it scans `server/src`, the
 * sidecars, the compose files and the Dockerfile — not the maintainer tooling. So `YTHRIL_TEST_MONGO_PORT`,
 * `YTHRIL_TEST_MONGO_HOST`, `BENCH_REPEATS` and `TODO_CHECK_DIR` were read by preflight, the benchmark and the
 * tracker check for as long as they existed with no page naming them, and the gate that exists for exactly that
 * failure was green throughout because it was not looking there. A script that reads a setting nobody can find has
 * no setting: the person who needs another value reads the code, or decides the script cannot do it.
 *
 * The page is `docs/testing-guide.md`, the one a person who runs or writes the suites opens. A variable documented
 * only in the script's own header is documented where the person is already reading the script, which is the one
 * place they do not need it.
 *
 * ## How it is derived
 *
 * The set is read out of the tracked sources of both directories — and the untracked ones, so a script written five
 * minutes ago is held before it is pushed, not after — by `envVarsRead` (`testing/_shared/env-var-reads.mjs`, which
 * owns what counts as a read and what is the machine's rather than ours). A floor on what the scan found stops a
 * broken pattern from turning the whole gate green by finding nothing, and the scanner is itself run over the shapes
 * it must and must not read.
 *
 * Run: node --test testing/standalone/scripts-and-test-runners-document-their-env-vars.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { envVarsRead, sourceKind, isAmbient } from '../_shared/env-var-reads.mjs';

const GUIDE = 'docs/testing-guide.md';

/** `Map<name, string[]>` — every variable the tooling reads, with the files that read it. */
function readsOfTooling() {
  const files = trackedSources(['scripts', 'testing/_init'], {
    ext: ['.mjs', '.js', '.cjs', '.ts', '.ps1'], floor: 10, untracked: true,
  });
  const reads = new Map();
  for (const f of files) {
    const kind = sourceKind(f);
    if (!kind) continue;
    for (const name of envVarsRead(readFileSync(join(REPO_ROOT, f), 'utf8'), kind)) {
      if (!reads.has(name)) reads.set(name, []);
      reads.get(name).push(f);
    }
  }
  return reads;
}

/** Whole-name match: `CI` must not be satisfied by `CI_HOME`, nor `YTHRIL_TEST_MONGO_PORT` by its longer sibling. */
const names = (text, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);

describe('the tooling\'s environment variables are on the testing page', () => {
  const reads = readsOfTooling();
  const ours = [...reads.keys()].filter((n) => !isAmbient(n)).sort();

  it('the scan found the tooling\'s reads (the scanner before the property)', () => {
    assert.ok(reads.size >= 8, `the scan found only ${reads.size} variables (ambient ones included): a read pattern is broken`);
    assert.ok(ours.length >= 4, `the scan found only ${ours.length} of the tooling's own variables (${ours}): a read pattern is broken`);
  });

  it(`${GUIDE} exists`, () => {
    assert.ok(existsSync(join(REPO_ROOT, GUIDE)), `${GUIDE} does not exist: nothing names the settings below`);
  });

  it('every variable the tooling reads that is not the machine\'s is named there', () => {
    const page = existsSync(join(REPO_ROOT, GUIDE)) ? readFileSync(join(REPO_ROOT, GUIDE), 'utf8') : '';
    const missing = ours.filter((n) => !names(page, n))
      .map((n) => `  ${n}  (read in ${reads.get(n).slice(0, 2).join(', ')})`);
    assert.deepEqual(missing, [],
      `these settings are read by the tooling and named nowhere a person who runs it would look:\n${missing.join('\n')}`);
  });
});

describe('what the scanner reads, and what it leaves alone', () => {
  const js = (s) => envVarsRead(s, 'javascript');
  const ps = (s) => envVarsRead(s, 'powershell');

  it('reads every JavaScript form of a read', () => {
    assert.deepEqual(js('const a = process.env.ALPHA_ONE ?? 1; const b = process.env[\'BETA_TWO\']; const c = process.env["GAMMA_3"];'),
      ['ALPHA_ONE', 'BETA_TWO', 'GAMMA_3']);
    assert.deepEqual(js('const { DELTA_4, EPS_5: five, ZETA_6 = 7 } = process.env;'), ['DELTA_4', 'EPS_5', 'ZETA_6']);
    assert.deepEqual(js('if (process.env.ETA_7 === "1") {}'), ['ETA_7']);
  });

  it('an assignment is not a read, and a comparison is', () => {
    assert.deepEqual(js("process.env['CONFIG_PATH'] = CONFIG_PATH; process.env.OTHER_ONE = 'x';"), []);
    assert.deepEqual(js('process.env.THETA_8 == "x"'), ['THETA_8']);
  });

  it('a name in a comment is documentation, not a read', () => {
    assert.deepEqual(js('// process.env.IOTA_9 is read below\n/* process.env.KAPPA_10 */'), []);
    assert.deepEqual(js('/**\n * Reads process.env.MU_12 and process.env[\'NU_13\'].\n */\nconst x = 1;'), []);
  });

  it('the whole environment passed on names nothing', () => {
    assert.deepEqual(js('spawn(cmd, { env: process.env })'), []);
  });

  it('reads the PowerShell forms, case-insensitively, and not an assignment or a comment', () => {
    assert.deepEqual(ps('$x = $env:APPDATA\n$y = [Environment]::GetEnvironmentVariable(\'PATH\', \'User\')'), ['APPDATA', 'PATH']);
    assert.deepEqual(ps('$env:XI_14 = "1"\n# $env:OMICRON_15\n<# $env:PI_16 #>\n$z = "$env:TEMP\\x"'), ['TEMP']);
  });

  it('ambient names are the machine\'s and everything else is ours, GitHub\'s prefix included', () => {
    for (const n of ['PATH', 'APPDATA', 'ProgramData', 'CI', 'GITHUB_STEP_SUMMARY', 'GITHUB_TOKEN', 'RUNNER_TEMP']) {
      assert.ok(isAmbient(n), `${n} was not recognised as ambient`);
    }
    for (const n of ['YTHRIL_TEST_MONGO_PORT', 'BENCH_REPEATS', 'GH_TOKEN', 'YTHRIL_TEST_RUNS_URL', 'TODO_CHECK_DIR']) {
      assert.ok(!isAmbient(n), `${n} was treated as ambient and would escape the documentation rule`);
    }
  });

  it('the page match is by whole name', () => {
    assert.ok(names('set `YTHRIL_TEST_MONGO_PORT` to', 'YTHRIL_TEST_MONGO_PORT'));
    assert.ok(!names('set YTHRIL_TEST_MONGO_PORT_EXTRA to', 'YTHRIL_TEST_MONGO_PORT'));
    assert.ok(!names('', 'YTHRIL_TEST_MONGO_PORT'));
  });
});
