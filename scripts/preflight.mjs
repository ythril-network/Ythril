/**
 * Pre-push structural gates — one command, so "which check applies to this change?" stops being a
 * judgement call.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * A PR shipped `icon="activity"`, which is not in the ICONS registry. `PhIconComponent` resolves an
 * unknown name to an empty string, so it rendered as a blank space with no error and no build failure.
 * Docs lint passed, every client test passed, the production AOT build passed. The one check that
 * catches it — `icon-registry-coverage` — was the one not run, because remembering which gate matches
 * which change is exactly the kind of thing a person gets wrong at the end of a long task.
 *
 * Every gate below shares that shape: it catches something that produces NO error, NO failed build and
 * NO failed unit test. A blank icon, an undocumented setting, a documented endpoint that 404s, a
 * scheduler nobody starts, a route nobody audits. They are cheap to run and impossible to remember.
 *
 * ── What this is not ────────────────────────────────────────────────────────────────────────────
 *
 * Not a replacement for CI. It deliberately skips everything needing Docker or a live instance
 * (integration, sync, red-team) and every test file that needs the test database, because a gate that
 * takes fifteen minutes is a gate people stop running. This is the fast half: no containers, no
 * database, run it before every push. The database test files are CI's Full run (owner decision,
 * 2026-10-22, Q-588), and `scripts/trade.mjs` measures what that saves and costs.
 *
 * ── The order ───────────────────────────────────────────────────────────────────────────────────
 *
 * Computed, not written here (Q-865): `planStages` (`scripts/_shared/preflight-stages.mjs`) orders the stages by what each reads of
 * another's output (their `needs`, with the kinds `source`, `build`, `test` as barriers) and, among the stages that may run, by the
 * measured cost of finding a failure, from `test-results/stage-costs.json` (`scripts/_shared/stage-costs.mjs`; the run prints where
 * its order came from, and with no usable snapshot it is the stage list's own order). Every stage below is REGISTERED with its body,
 * `stage('<name>', async () => { ... })`, and `runStages` runs the bodies in the plan's order, one at a time, awaited; it refuses a
 * registered set that is not the stage list, so the code and the list cannot drift apart. The first failing stage ends the run (Q-862):
 * a stage that fails finishes (a second failing batch of the same stage is still shown), the next is not started, and the summary names
 * every stage that did not run. A full run took about 35 minutes, 26 of them in test batches that ran BEFORE the sub-minute gates; every
 * failure on 2026-11-16 was one of those gates. The runner times each stage, and after the verdict the run records one `Preflight-Run`
 * (each stage's name, kind, time and outcome, and the runner that measured it; Q-864): spooled to test-results/unrecorded, sent through
 * `scripts/test-times.mjs` within a bound, and a recording that fails is one line and changes neither the verdict nor the exit status.
 * The tests the run ran are recorded the same way (Q-948): one `Test-Run` of kind `preflight` per suite whose results this run's own stages wrote
 * (the node suite `preflight`, the client), spooled beside the stage times and sent by the same drain.
 * `node scripts/test-times.mjs --preflight-trend` prints the stage times of the last runs. No caller asks for the old run-everything
 * behaviour (package.json, the in-container runner and `~/.claude/hooks/preflight-mark.js` all run it bare), so there is no flag for it.
 *
 * Usage:  npm run preflight
 *         npm run preflight:static   (`--static`: every gate that runs no suite of its own - the source and built
 *         gates, the pure half of the offline tests, parse, unrun-tests, surface, docs, todo, changelog and the client
 *         type-check. Both modes run the pure test files only; `--static` also skips the client unit tests, the
 *         production build and its budgets, and it is NEVER a push pass: its verdict says so, Q-584.)
 */
import { execSync, execFileSync, execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';

import { join } from 'node:path';
import { splitStandalone, offlineRuns } from '../testing/_shared/standalone-split.mjs';
import { timingReporterFlags, clearTimingResults } from '../testing/_shared/timing-reporter-flags.mjs';
import { testChildEnv } from '../testing/_shared/test-child-env.mjs';
import { boundedTestArgs, batchTimeoutMs } from '../testing/_shared/test-file-bound.mjs';
import { poolEach } from '../testing/_shared/pool.mjs';
import { runTestUnits } from '../testing/_shared/run-test-units.mjs';
import { workersPerUnit } from '../testing/_shared/offline-test-width.mjs';
import { timingResultsDir } from '../testing/_shared/timing-reporter.mjs';
import { stampRunnerOutcome } from './mask-client-report.mjs';
import { CLIENT_RESULTS, clientCommandWritingTo } from './_shared/client-results.mjs';
import { PREFLIGHT_STAGES, SOURCE_GATES, SOURCE_GATE_FILES, BUILT_GATES, createStageRunner, planStages, runStages } from './_shared/preflight-stages.mjs';
import { readStageCosts, readFileTimes } from './_shared/stage-costs.mjs';
import { slowFirstUnits } from './_shared/slow-first-units.mjs';
import { buildPreflightRunPayload, preflightRunIdentity, recordPreflightRun } from './_shared/preflight-run-record.mjs';
import { changelogBase } from './_shared/changelog-base.mjs';

/**
 * `--static`, and nothing else: an unknown argument is refused rather than ignored, because `--statc` falling through
 * to the full run gives three minutes to someone who asked for one, and a full verdict to someone who asked for a subset.
 */
const STATIC = process.argv.includes('--static');
const unknownArgs = process.argv.slice(2).filter(a => a !== '--static');
if (unknownArgs.length) {
  console.error(`preflight: unknown argument(s) ${unknownArgs.join(' ')}; the only one is --static`);
  process.exit(2);
}

/**
 * The ONE results folder of this run: the checkout the preflight runs in (or the folder `YTHRIL_TEST_RESULTS_DIR` names), never the folder of the
 * repository that holds this script. Every write, clear and read of timing results goes through it (Q-872): a preflight a test plants in a
 * scratch checkout must leave its files, and clear the files, of that checkout only.
 */
const RESULTS_DIR = timingResultsDir(process.cwd());

/**
 * How many units of standalone files run at once, in the text stage and in the test stage alike (Q-863, Q-870): one width, so the two stages cannot
 * disagree, and each unit takes `workersPerUnit(UNIT_WIDTH)` workers, so together they never run more than the 8 offline test files at once
 * (`convention-offline-tests-run-in-parallel`).
 */
const UNIT_WIDTH = 4;

/** Where the client's Vitest JSON report is written; the path ci.yml's client step and the recorder read. */
const CLIENT_REPORT = join(RESULTS_DIR, CLIENT_RESULTS);

// Every child gets `testChildEnv`'s environment, not this process's: the recorder's token and the runner's wire stay out of
// anything a test (or a dependency a test imports) can read. A caller that needs more passes `env` itself.
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', env: testChildEnv(), ...opts });

const failures = [];
const STARTED_AT = new Date().toISOString();

/**
 * The builder of this run's `Test-Run` records, from the recorder script. Loaded here, once, in a try: a script that cannot be loaded
 * (it is the recorder's, not the preflight's) costs the run the test records and a line at its end, never its verdict or its exit status.
 */
const testRunBuilder = await import('./test-times.mjs').then(m => m.preflightTestRunPayloads, (err) => () => { throw err; });

/**
 * The record of this run (Q-864), made after the verdict is printed: the runner's own stage times, written to the spool and sent
 * within a bound. It never throws and its one line is all the run says about it: a recording that fails changes neither the verdict
 * nor the exit status, which are decided before this is called (`_shared/preflight-run-record.mjs`).
 */
function recordRun() {
  try {
    const identity = preflightRunIdentity(process.cwd());
    // The tests this run ran (Q-948): only what its own stages wrote into the results folder, spooled beside the stage times. A builder that
    // cannot be loaded or that throws is a line here and nothing else: the stage times are recorded without them.
    let testRuns = [];
    const said = [];
    try {
      const built = testRunBuilder({ resultsDir: RESULTS_DIR, startedAt: STARTED_AT, root: process.cwd(), ...identity });
      testRuns = built.payloads;
      said.push(...built.problems.map(p => `preflight: test results not recorded: ${p}`));
    } catch (err) { said.push(`preflight: test results not recorded: ${String(err?.message ?? err).split('\n')[0]}`); }
    said.push(recordPreflightRun(buildPreflightRunPayload({
      stages: stages.timings(), mode: STATIC ? 'static' : 'full', startedAt: STARTED_AT, endedAt: new Date().toISOString(), ...identity,
    }), { testRuns }));
    return said.join('\n');
  } catch (err) { return `preflight: stage times not recorded: ${String(err?.message ?? err).split('\n')[0]}`; }
}

/** The one way out of a run: the record first, then the exit with the verdict's code. */
function finish(code) {
  console.log(`\n${recordRun()}`);
  process.exit(code);
}

/**
 * The verdict, and the end of the run: called after the last stage, and by the runner at the first stage boundary that finds
 * a failure, with the stages it did not start.
 */
function conclude(notRun) {
  console.log('\n' + '='.repeat(76));
  // A static run is never a push pass: its verdict never says PASSED, and it says "not a push pass", which
  // ~/.claude/hooks/preflight-mark.js refuses to record even though the run exits 0.
  if (failures.length === 0) {
    console.log(STATIC
      ? 'Preflight STATIC passed - not a push pass. The client unit tests, the production build and the bundle budgets did not run.'
      : 'Preflight PASSED. The database test files and the Docker-dependent suites (integration, sync, red-team) run in CI.');
    finish(0);
  }
  console.log(`Preflight ${STATIC ? 'STATIC FAILED' : 'FAILED'} — ${failures.length} gate(s):\n`);
  for (const f of failures) console.log(`  ${f.name}\n      ${f.why}`);
  if (notRun.length > 0) console.log(`\nNot run (the first failing stage ended the run): ${notRun.join(', ')}`);
  console.log('\nEach of these catches something that produces no error on its own. Fix before pushing.');
  finish(1);
}

// ── the plan: which stage runs when ─────────────────────────────────────────────────────────────────────────────

/**
 * The order's source, in one line: the measured snapshot the host keeps (never fetched here: a down instance would delay the fast
 * failure this run exists for), or the stage list's own order and the reason there is no usable snapshot (missing, garbage, stale).
 */
function orderSource({ costs, why }) {
  if (!costs) return `preflight: stage order is the list order (${why})`;
  const hours = Math.max(0, Math.round((Date.now() - Date.parse(costs.generatedAt)) / 3_600_000));
  const age = hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
  return `preflight: stage order follows the measured costs of ${costs.runs} recorded run(s), snapshot ${age} old`;
}

const snapshot = readStageCosts(RESULTS_DIR);
const plan = planStages(PREFLIGHT_STAGES, snapshot.costs, { static: STATIC });
const stages = createStageRunner({ failures, isStatic: STATIC, stages: plan, onStop: ({ notRun }) => conclude(notRun) });

/** The stage bodies by name; `runStages` runs them in the plan's order. A stage registered twice is a copy that would silently replace its first. */
const bodies = new Map();
function stage(name, body) {
  if (bodies.has(name)) throw new Error(`preflight: stage ${JSON.stringify(name)} is registered twice`);
  bodies.set(name, body);
}

function gate(name, why, file) {
  stage(name, async () => {
    process.stdout.write(`\n── ${name} ──\n`);
    try {
      execFileSync('node', boundedTestArgs(`testing/standalone/${file}.test.js`), { stdio: 'inherit', env: testChildEnv(), timeout: batchTimeoutMs(1) });
    } catch {
      failures.push({ name, why });
    }
  });
}

console.log('Preflight — the checks that catch failures with no error message.\n');
console.log(orderSource(snapshot));

// The old report goes before any stage runs, in BOTH modes, so a run that dies (or stops at an early failure) before writing one
// cannot leave an earlier run's report standing as this run's (the client unit tests stage writes the new one; a static run writes none).
rmSync(CLIENT_REPORT, { force: true });

// Results of an earlier preflight are not this run's, and the clear happens HERE, before any stage: the text stage (a source stage) writes its own
// `preflight-text-N` files long before the test stage, and a clear inside the test stage's body removed them every time the run got that far, so a
// recorded run never held them. The suite is `preflight`, not `standalone`: this is a subset, and it must not clear or overwrite a full run's files
// (the stage-cost snapshot is not a `preflight-*` file, so the clear leaves it).
clearTimingResults('preflight', { dir: RESULTS_DIR });

// ── the `source` stages: nothing here needs a build ─────────────────────────────────────────────────────────────

// A file git does not track that only a catch-all rule (*.log, *.txt) hides is clutter nobody is told about: agent runs left logs,
// a stack dump, test output and stray worktree copies in the checkout this way (Q-626). Scratch goes outside every checkout (scratchRoot), not to a folder in it. The check names a
// place for what stays local. It asks git alone, so it is the cheapest step here, and every other source stage waits for it.
stage('unregistered-local-files', async () => {
  console.log('\n── no untracked file hidden only by a catch-all ignore rule ──');
  try { run('node scripts/unregistered-local-files.mjs'); } catch {
    failures.push({ name: 'unregistered-local-files', why: 'a file git does not track that no rule naming a place registers: clutter the catch-all ignore rules hide' });
  }
});

// CI has run this since it was written; preflight never did. So eleven PRs in a row passed locally with an entry, and
// the twelfth — the only one in that run to change access rules — got as far as a red CI job before anyone noticed the
// CHANGELOG had no line for it. A gate that only exists after the push is a gate that teaches you to push and see.
//
// It works locally for the same reason CI can run it: the comparison is against `origin/main`, which is already
// fetched. Nothing about it needed the runner. It is a git diff, so it is cheap: a missing entry
// was the failure found half an hour late most often (2026-11-16).
stage('check-changelog', async () => {
  console.log('\n── CHANGELOG entry for shipped changes ──');
  // A branch on a release line is compared with that line, never main (scripts/_shared/changelog-base.mjs).
  let trackedUpstream = '';
  try { trackedUpstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no upstream: main */ }
  let changelogAgainst;
  try { changelogAgainst = changelogBase({ upstream: trackedUpstream, override: process.env.PREFLIGHT_CHANGELOG_BASE ?? '' }); } catch (err) {
    console.error(err.message);
    failures.push({ name: 'check-changelog', why: err.message });
    return;
  }
  // The base is an argument of the child, never part of a shell string: a ref name may hold `;` or `$(`.
  try { execFileSync('node', ['./scripts/check-changelog.mjs', changelogAgainst], { stdio: 'inherit', env: testChildEnv() }); } catch {
    failures.push({ name: 'check-changelog', why: 'a file that changes what ships, with no [Unreleased] line' });
  }
});

// The owner reads todo/ directly, and the release cadence is "cut the tag when _TODO-ORDERED.md is empty" — so a
// domain tracker holding an item the ordered list never mentions makes "empty" a claim about one file rather than
// about the work. todo/ is gitignored, so this can only ever run here; the script exits 0 when the folder is
// absent, which is what makes it safe in a clean checkout.
stage('todo:check', async () => {
  console.log('\n── todo/ is open items only, all indexed ──');
  try { run('npm run todo:check'); } catch {
    failures.push({ name: 'todo:check', why: 'a tracker holds closed work, or an open item the ordered list never references' });
  }
});

// Each gate() registers its own stage.
for (const [file, why] of SOURCE_GATES) gate(file, why, file);

/*
 * ── the standalone files that read only tracked text (Q-870) ──
 *
 * A standalone file whose import closure reads no build, no install, no network and no process but git (`testing/_shared/text-only-test.mjs`
 * decides, by computation, so the set grows with the tree and no list holds it) needs nothing a build writes, so it runs here, before both builds, and a
 * failure in one is found in seconds and not after minutes of compiling. The gate files above keep their own stages (each its sentence and its place in
 * the cost order), so they are left out here by `SOURCE_GATE_FILES`; every other text file runs once, here, and `offlineRuns` leaves it out of the pure
 * kind the test stage runs.
 *
 * The units are the pure stage's own shape: `slowFirstUnits` (a slow text file runs alone and first) through `runTestUnits` (the pool, the time bound,
 * the held output, the child environment) at `UNIT_WIDTH` units of `workersPerUnit(UNIT_WIDTH)` workers. The split throws in a checkout whose tree is not
 * whole (a missing folder, too few files), and that is charged to this stage: a listing that found nothing must not read as a pass.
 */
stage('text-only standalone tests', async () => {
  const runs = offlineRuns(splitStandalone(), { ciOnly: false })
    .filter(r => r.kind === 'text')
    .map(r => ({ ...r, files: r.files.filter(f => !SOURCE_GATE_FILES.has(f)) }))
    .filter(r => r.files.length > 0);
  const fileTimes = readFileTimes(RESULTS_DIR);
  const planned = slowFirstUnits(runs, fileTimes.times, { maxSlow: 2 * UNIT_WIDTH });
  const files = planned.reduce((n, u) => n + u.files.length, 0);
  console.log(`\n── ${files} standalone test file(s) that read only tracked text, in ${planned.length} unit(s), ${UNIT_WIDTH} at a time ──`);
  if (files === 0) throw new Error('the split found no standalone file that reads only tracked text: the classification is broken, not the tests, and an empty run would pass about nothing');
  const units = planned.map((r, i) => ({ files: r.files, args: r.args, slow: r.slow, flags: timingReporterFlags({ suite: 'preflight', batch: `text-${i + 1}`, dir: RESULTS_DIR, scope: STATIC ? 'static' : 'subset' }) }));
  const { failed } = await runTestUnits(units.map(u => u.files), {
    width: UNIT_WIDTH,
    args: (batch, i) => [`--test-concurrency=${units[i].slow ? 1 : workersPerUnit(UNIT_WIDTH)}`, ...units[i].args, ...units[i].flags.args],
    envOf: (batch, i) => units[i].flags.env,
    labelOf: (batch, i) => `text-${i + 1}`,
    header: ({ label, code, index, total, files: batch, startedAt, endedAt }) =>
      `  batch ${index + 1}/${total} (${label}) — ${batch.length} text-only file(s), ${((endedAt - startedAt) / 1000).toFixed(0)}s, exit ${code}\n`,
  });
  if (failed > 0) {
    failures.push({ name: 'text-only standalone tests', why: 'a standalone test that reads only tracked text: no build is needed to see it fail, so no reason to learn it after the builds' });
  }
});

/*
 * ── every test file is REACHED by a CI job's selection ──
 *
 * A tracked test file that no job selects is a test nobody runs, and it is green in review because it never ran: a file
 * under `testing/bench/`, a spec outside `client/src`, a test one directory deeper than a glob reaches. CI's aggregator
 * asks the run half of this (which file produced no test event); this is the static half, derived from the workflow, the
 * package scripts and the vitest config, and it needs nothing a developer's machine lacks.
 */
stage('unrun-tests', async () => {
  console.log('\n── every tracked test file is reached by a CI job ──');
  try { run('node scripts/unrun-tests.mjs'); } catch {
    failures.push({ name: 'unrun-tests', why: 'a tracked test file that no CI job selects: it is never run, and "all tests pass" says nothing about it' });
  }
});

stage('lint:docs', async () => {
  console.log('\n── docs lint ──');
  try { run('npm run lint:docs'); } catch { failures.push({ name: 'lint:docs', why: 'markdown that will fail CI' }); }
});

// ── every test file PARSES, including the ones only CI runs ────────────────────────────────────────────────
//
// The pure subset executes its standalone files, so a syntax error in one of those fails loudly in that stage. The
// database-backed files and the Docker-dependent suites — integration, sync, red-team — are not
// RUN locally, so without this step a broken one would be invisible until CI, and it would not fail as an
// assertion: node reports a module-load error at `line 1:1` with an import stack, which reads nothing like
// the test that is actually broken. This step parses every test file, those included.
//
// Paid for on 2026-08-06: an apostrophe lost its backslash on the way through a shell heredoc, the file
// stopped parsing, local preflight was green, and CI spent a full Docker run to say so. `node --check` over
// every test file costs about a second and would have said it immediately.
stage('test files parse', async () => {
  console.log('\n── every test file parses (incl. the Docker-only suites CI runs) ──');
  const testFiles = execSync('git ls-files "testing/**/*.js" "testing/**/*.mjs"', { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);

  // A leading UTF-8 BOM makes `node --check` reject a file that node RUNS perfectly — verified with a
  // fixture rather than assumed, because the first version of this gate flagged `testing/_init/seed-brain.js`
  // and that file is fine. `node --check` chokes on BOM-then-shebang; the runtime strips the BOM first.
  //
  // So the BOM is removed before checking. Do not "simplify" this back into a bare `node --check` — it will
  // fail the whole gate on a working file, which is how a gate gets switched off.
  // One `node --check` per file, spawned with an argument array (no shell: a path is never parsed) and bounded, `availableParallelism()` of them
  // at a time through the shared pool (`testing/_shared/pool.mjs`): 2 367 files took 54 s one after the other and 9 s this way (Q-863).
  const PARSE_BOUND_MS = 60_000;
  const execFileAsync = promisify(execFile);
  const check = async (p) => {
    try { await execFileAsync('node', ['--check', p], { env: testChildEnv(), encoding: 'utf8', timeout: PARSE_BOUND_MS, killSignal: 'SIGKILL' }); return null; }
    catch (e) {
      if (e.killed) return `node --check did not end within ${PARSE_BOUND_MS / 1000} s`;
      return String(e.stderr ?? e).split('\n').find(l => /Error/.test(l)) ?? 'unparseable';
    }
  };

  // One file's verdict: null when it parses, else the message. Never throws, so one broken file does not stop the pool.
  const verdictOf = async (f) => {
    const err = await check(f);
    if (!err) return null;

    // A leading UTF-8 BOM makes `node --check` reject a file node RUNS fine (verified with a fixture: BOM,
    // then shebang, checks as a SyntaxError and executes without complaint). Many files here carry one, so a
    // bare check would fail the gate on working code — which is how a gate gets switched off.
    //
    // The retry copy MUST stay inside the repo. The first version wrote it to the OS temp dir, where no
    // `package.json` applies, so node parsed it under different rules and a genuinely broken file came back
    // clean — a gate with a silent-success path, which is worse than no gate. Caught by planting a syntax
    // error and watching the gate pass. Its name is the file's own, so concurrent checks never share one.
    const src = readFileSync(f, 'utf8');
    if (src.charCodeAt(0) === 0xfeff) {
      const sibling = `${f}.parse-check.tmp.mjs`;
      try {
        writeFileSync(sibling, src.slice(1));
        const retry = await check(sibling);
        return retry ? `${f}\n      ${retry}` : null;
      } finally {
        rmSync(sibling, { force: true });
      }
    }
    return `${f}\n      ${err}`;
  };

  const unparseable = (await poolEach(testFiles, availableParallelism(), verdictOf)).filter(Boolean);

  if (unparseable.length > 0) {
    console.log(`  ${unparseable.length} file(s) do not parse:\n    ${unparseable.join('\n    ')}`);
    failures.push({ name: 'test files parse', why: 'a Docker-only test that does not even load — CI reports it as a module error, not as a failing test' });
  } else {
    console.log(`  ${testFiles.length} test files parse.`);
  }
});

// ── the `build` stages: the server build, what imports it, the client type-check and the production build ────────

// Build UNCONDITIONALLY before anything that imports from server/dist.
//
// This used to build only when `server/dist` was missing, which made every gate below it a check on
// whatever was compiled last — a different branch, a different commit, code that no longer exists. It
// cost a red CI run: a PR changed `toRecallRecord`'s output, preflight reported PASSED, and the
// standalone test that contradicts the change had been run against the PREVIOUS build. A stale pass is
// worse than no check, because it is indistinguishable from a real one. A `tsc` run is cheap; being
// told the wrong answer is not.
stage('build:server', async () => {
  console.log('\n── building server (the gates below import from server/dist) ──');
  try { run('npm run build:server'); } catch { failures.push({ name: 'build:server', why: 'the server does not compile' }); }
});

// Each gate() registers its own stage; the stage list says they need the server build.
for (const [file, why] of BUILT_GATES) gate(file, why, file);

/*
 * ── the route list, checked against what express actually serves ──
 *
 * Every gate that says "every route" reads one module, and that module reads SOURCE. This is the only check
 * in the repository that compares it against the live express router objects — the one thing that cannot be
 * wrong about what is served — so it is the check that catches the module being wrong. It imports the router
 * modules from server/dist, so it needs the build.
 *
 * It is here because nothing ran it. Left as a manual script it rotted into reporting all 46 tools as
 * unmapped (it grepped a file the map had moved out of) and one route as unserved (its own scan could not
 * resolve a router passed as a parameter). Forty-seven false findings is worse than no audit: the next
 * person to run it stops trusting the tooling. A check nobody runs is a claim.
 */
stage('surface-matrix-audit', async () => {
  console.log('\n── the route list agrees with what express serves ──');
  try { run('node scripts/surface-matrix-audit.mjs'); } catch {
    failures.push({ name: 'surface-matrix-audit', why: 'the static route list and the live express routers disagree' });
  }
});

/*
 * ── client type-check, BOTH projects ──
 *
 * Neither gate around this one asks the question. `test:client` runs vitest, which transpiles without
 * type-checking; the production build below compiles `tsconfig.app.json` only. So the SPEC project was never
 * checked, and it had 122 type errors — among them a fixture using a vote status the API cannot return, six
 * fixtures omitting a field whose branch no test therefore covered, an assertion message silently discarded
 * because `toBeNull()` takes no arguments, and three client interfaces missing a field the server always sends.
 *
 * Checking the ROOT `tsconfig.json` is what hid it: that config includes the specs without the vitest types,
 * so it reported 297 errors of which 175 were `Cannot find name 'expect'` — noise a real error hides inside.
 * The two real projects are the question worth asking.
 *
 * The APP project is checked by Angular's compiler (`ngc --noEmit`), not plain `tsc`: `tsc` does not read templates, and the extended
 * template diagnostics `client/tsconfig.json` sets to error (an unused standalone import, a `??` on a value that cannot be null), a
 * `styles` entry the build cannot evaluate and a template type error are the compiler's alone. Every slice of bundle-285 passed all its
 * specs and this stage while `npm run build:client` failed on exactly those; the production build runs only in the full
 * preflight, so a static run never saw it. `ngc` answers it here in seconds, the spec project still goes through `scripts/tsc.mjs`
 * (first, so the install check speaks before any compiler does).
 */
stage('typecheck:client', async () => {
  console.log('\n── client type-check (app + spec projects) ──');
  try { run('npm run typecheck:client'); } catch {
    failures.push({ name: 'typecheck:client', why: 'types the test run transpiles past and the AOT build never sees' });
  }
});

// The production build type-checks TEMPLATES (AOT) and compiles under the app's own tsconfig, neither of
// which the unit-test run does. It caught a `[...NodeList]` spread that every test passed straight over,
// and it is where an unknown element, a bad binding or a broken inline template surfaces. ~7 seconds.
// The build and the budget check read one output (`ctx.buildOut`); the stage list marks both `static: false`, so a static run leaves them out together.
stage('build:prod', async (ctx) => {
  console.log('\n── client production build (AOT template type-check) ──');
  ctx.buildOut = '';
  try {
    // Captured, not inherited, so the chunk table below can be read — then printed, because a build whose
    // output vanishes is a build nobody can debug.
    // `--verbose` because the gate below reads the chunk TABLE, and without it the table stops at the fifteen
    // largest lazy chunks ("…and 158 more"). A budgeted chunk that SHRANK out of that top fifteen — the settings
    // dialog, once its tabs were deferred (Q-112) — then read as "names no emitted chunk" although it was there.
    ctx.buildOut = execSync('npm run build:prod --workspace=client -- --verbose', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(ctx.buildOut);
  } catch (e) {
    ctx.buildOut = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    process.stdout.write(ctx.buildOut);
    failures.push({ name: 'build:prod', why: 'AOT template errors and tsconfig differences the unit tests never see' });
  }
});

// A `bundle`-type budget names a chunk. Angular does NOT complain when that name matches nothing — the
// budget is simply never evaluated, the build stays green, and the chunk it was meant to guard grows
// without limit. That is the same silent no-op the budgets exist to prevent, one level up, and the only
// place it can be checked is against the real chunk table the build just printed.
stage('bundle-budgets', async (ctx) => {
  console.log('\n── bundle budgets bind to real chunks ──');
  try {
    const cfg = JSON.parse(readFileSync('client/angular.json', 'utf8'));
    const project = cfg.projects[Object.keys(cfg.projects)[0]];
    const named = (project.architect.build.configurations.production.budgets ?? [])
      .filter(b => b.type === 'bundle').map(b => b.name);
    const plain = (ctx.buildOut ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    const unmatched = named.filter(n => !new RegExp(`\\|\\s*${n}\\s*\\|`).test(plain));
    if (unmatched.length) {
      console.log(`  budgets naming no emitted chunk: ${unmatched.join(', ')}`);
      failures.push({
        name: 'bundle-budgets',
        why: `${unmatched.join(', ')} — Angular evaluates these against nothing, so the build stays green while the chunk grows`,
      });
    } else {
      console.log(`  ${named.length} bundle budget(s) matched an emitted chunk.`);
    }
  } catch (e) {
    failures.push({ name: 'bundle-budgets', why: `could not verify budget names: ${e}` });
  }
});

// ── the `test` stages: the suites ────────────────────────────────────────────────────────────────────────────────

// The command is ci.yml's client step, character for character (`ci-workflow-is-sound` holds the two equal): this step is
// the local producer of `test-results/client.json`, which `npm run test:client` does not write. The old report was cleared
// before any stage ran (above), so a run that dies before writing one cannot leave an earlier run's report standing as this run's;
// the runner's own verdict is stamped into whatever it wrote, so the recorder can call a run incomplete that counts no failure.
stage('client unit tests', async () => {
  console.log('\n── client unit tests (includes i18n key coverage) ──');
  let clientOutcome = 'success';
  try { run(clientCommandWritingTo('npm run test --workspace=client -- --reporter=default --reporter=json --outputFile.json=../test-results/client.json', CLIENT_REPORT, join(timingResultsDir(process.cwd(), {}), CLIENT_RESULTS))); } catch {
    clientOutcome = 'failure';
    failures.push({ name: 'test:client', why: 'component behaviour, and translation keys missing from de/pl' });
  }
  stampRunnerOutcome(CLIENT_REPORT, clientOutcome);
});

// Every standalone test that needs neither a running instance nor the test database, rather than the curated handful above.
//
// `npm run test:standalone` assumes the Docker stack — a handful of those files drive a live server on
// :3200, and the database-backed ones need the test database. The rest are pure: they import from
// `server/dist` and assert on logic. Those had no reason to wait for CI, and waiting for CI is exactly how
// a PR that changed `toRecallRecord`'s output shipped with the test contradicting it still asserting the old shape.
//
// THE SPLIT AND THE BATCHING MOVED TO `testing/_shared/standalone-split.mjs`, whole, with the
// measurements that produced them. `test:standalone` asks the same question, and two copies of it is two
// places for preflight and the suite to disagree about which gates exist — which is the one divergence
// that makes a green preflight worthless.
stage('test:standalone (offline subset)', async () => {
  const standaloneSplit = splitStandalone();
  const { all: allStandalone, offline, offlinePure: pure, offlineDb, ciOnly } = standaloneSplit;
  console.log(`
── standalone tests that need no running instance and no database (${pure.length} of ${allStandalone.length}; `
    + `${allStandalone.length - offline.length} declare @needs-instance and run in CI) ──`);
  console.log(`  ${offlineDb.length} database test files are not run here; CI's Full run runs them.`);
  console.log(`  ${ciOnly.length} file(s) declare @ci-only (too slow for every push); CI's standalone-pure job runs them.`);

  /*
   * THE PURE BATCHES RUN AS UNITS, a few at a time (Q-863). Each batch of `offlineRuns` is one test-runner child, and `runTestUnits`
   * (`testing/_shared/run-test-units.mjs`, the pool the runner's -db shards use too) keeps UNIT_WIDTH of them alive at once, each with
   * `workersPerUnit(UNIT_WIDTH)` workers (`testing/_shared/offline-test-width.mjs`), so the cores a batch leaves idle while its slowest file
   * finishes are used by the next one, and all units together never run more than 8 offline test files at once
   * (convention-offline-tests-run-in-parallel). One batch at a time with a worker per core took 317.9 s over the 1 227 pure files on 8 cores, a
   * pool of three batches of three workers 214.7 s; the batch holding the slowest file sets the floor in every setting measured, so the cap is
   * spent on more units at once rather than more workers per unit. The runner also gives each unit the time bound (a
   * file that hangs after its tests is ended and named), the held output (units never interleave) and the child environment, so none is
   * written here. The old shape, one synchronous child per batch with node's default width, ran one batch at a time and had no bound.
   *
   * The one-worker setting that is right for a suite sharing ONE live instance does not apply: the files here need no instance, which is
   * what `@needs-instance` declares, and the ones that do are not in this list.
   *
   * The database-backed files are NOT in this run, in either mode (Q-588, owner decision 2026-10-22): they share one MongoDB
   * (`DB_TEST_CONCURRENCY` in the shared split caps them there), a machine without the test stack skipped them silently, and
   * CI's Full run runs them. `offlineRuns` is the plan `test:standalone` runs too; this keeps its pure batches only, and the
   * gate `a-preflight-runs-no-database-batch-and-static-is-never-a-push-pass` holds that for both modes.
   */
  const runs = offlineRuns(standaloneSplit, { ciOnly: false }).filter(r => r.kind === 'pure');
  // The slowest pure files start first and wait behind nothing (Q-869): the recorded per-file times (`test-results/file-times.json`, written by
  // the host, never fetched here) put each file of 15 s or more in a unit of its own, slowest first, at the front; at most 2 x UNIT_WIDTH of
  // them, so the units that run alone do not outnumber the workers. The other files stay in the batches `offlineRuns` cut. With no usable
  // snapshot the units are those batches in list order, and the line says why.
  const fileTimes = readFileTimes(RESULTS_DIR);
  const planned = slowFirstUnits(runs, fileTimes.times, { maxSlow: 2 * UNIT_WIDTH });
  const slowAlone = planned.filter(u => u.slow).length;
  console.log(fileTimes.times
    ? `preflight: units: ${slowAlone} slow file(s) run alone first, from the times of ${fileTimes.times.runs} recorded run(s); ${planned.length - slowAlone} other unit(s) follow`
    : `preflight: units are cut by path length, in list order (${fileTimes.why})`);
  // Timing, through the shared helper: one destination per unit, the flags AFTER the plan's own args so the batch budget stays about the
  // files, and the recorder's credentials out of the children's environment (`runTestUnits` builds it with `testChildEnv`). The label is the
  // unit's place in the list, fixed here before any unit launches, so two units never write one file whatever order they end in.
  // The suite is `preflight`, not `standalone`: this is a subset, and it must not overwrite a full run's files. Earlier results were cleared when the run
  // started (above the stages), so the text stage's own files stand.
  const units = planned.map((r, i) => ({ files: r.files, args: r.args, slow: r.slow, flags: timingReporterFlags({ suite: 'preflight', batch: `pure-${i + 1}`, dir: RESULTS_DIR, scope: STATIC ? 'static' : 'subset' }) }));
  console.log(`  ${units.length} unit(s) of pure files, ${UNIT_WIDTH} at a time`);
  const { failed } = await runTestUnits(units.map(u => u.files), {
    width: UNIT_WIDTH,
    args: (files, i) => [`--test-concurrency=${units[i].slow ? 1 : workersPerUnit(UNIT_WIDTH)}`, ...units[i].args, ...units[i].flags.args],
    envOf: (files, i) => units[i].flags.env,
    labelOf: (files, i) => `pure-${i + 1}`,
    header: ({ label, code, index, total, files, startedAt, endedAt }) =>
      `  batch ${index + 1}/${total} (${label}) — ${files.length} pure file(s), ${((endedAt - startedAt) / 1000).toFixed(0)}s, exit ${code}\n`,
  });
  // Every unit has ended (a failing one lets the others finish, so a second failure is not hidden): the stage fails once.
  if (failed > 0) {
    failures.push({ name: 'test:standalone (offline subset)', why: 'server contracts and pure logic — no Docker needed, so no reason to learn this from CI' });
  }
});

await runStages(plan, bodies, stages);
stages.end();
conclude([]);
