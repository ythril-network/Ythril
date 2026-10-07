/**
 * `ci.yml` is held to the rules that keep a split pipeline honest — read from the PARSED workflow, every set derived.
 *
 * ## What this prevents
 *
 * One required check (`Build & Test`) stands for the whole pipeline. While the pipeline was one job that was
 * trivially true. Split into parallel jobs it is true only if the gate job waits for every other job, runs when they
 * fail, and fails unless each of them succeeded — and every one of those can be wrong with the workflow still
 * parsing, still green on a pull request and still merging:
 *
 *  - A job added to the file and left out of the gate's `needs` is a suite nobody waits for. Its failure is a red
 *    X on a PR that merges anyway. This is the same defect as a test file no job selects (`Q-283`), one level up.
 *  - A gate without `if: always()` is SKIPPED when a needed job fails, and a skipped required check reads as passing
 *    to the ruleset on a path-filtered or merge-queue setup, and as "pending" on a PR everywhere else.
 *  - A gate that checks `failure` instead of `success` passes a job that was skipped or cancelled.
 *  - A job without `timeout-minutes` can hold the runner for the platform's six hours with no output (PR #1475 sat
 *    in `test:standalone` for an hour before it was cancelled to read the log).
 *  - A cache written from a pull request is a cache a pull request can poison for the main branch, and a cache
 *    written on every run evicts the layers every other run needs (the repository's 10 GB limit is already full).
 *  - A runtime token handed to a job that does not need it, or sitting before a step that does not use it, is a
 *    credential exposed for nothing; an artifact whose path is not on the allowlist is a public download of
 *    whatever that path holds (artifacts of a public repository are public).
 *  - A stack job that lets compose build or pull rebuilds, per job, the image the pipeline built once — or pulls
 *    a different one — and the run measures a different thing from the one that was prepared.
 *  - A gate that only checks job RESULTS passes a job that ran nothing: a file that loaded and registered no test, a
 *    skip nobody expected. After its verdict the gate downloads this attempt's results and runs `executed-tests` and
 *    `unexpected-skips` over them (`gate evidence`), and the client job writes the JSON report the second one reads
 *    (`client report`). Run only when every needed job succeeded, so the checks never speak for a partial set.
 *
 * ## How it is written
 *
 * Each rule is a function over a parsed workflow that returns its violations, and each is run three ways: over the
 * real `ci.yml`; over a miniature of the conforming shape (`ci-workflow-fixture.mjs`), which must come back clean;
 * and over that miniature with ONE thing broken, which must come back naming the breakage. A rule whose breakage
 * does not fire it is a claim, not a gate. Every derived set has a floor, because a rule over an empty set passes.
 *
 * The gate's verdict is not matched as text: the first step that reads `needs` is RUN in a shell with every needed
 * job's result substituted, one job at a time failed, cancelled or skipped, and it has to exit non-zero each time.
 * The other direction (everything succeeded → exit 0) cannot be run here, because the steps after the verdict need
 * the repository and its artifacts, so the verdict step must mention `success` — the word a skip cannot satisfy.
 *
 * ## The full run
 *
 * `full-run.yml` is a two-line caller that runs the whole of `ci.yml` on a push to `full-run/<bundle>`, before the pull
 * request exists. Its rules sit in the same table, over the PAIR (the caller and the workflow it calls), because every one of
 * them is a statement about how the two fit: a caller that is named like the merge gate, that is triggered wider than its
 * prefix, that is handed a credential, or that grants less than a called job asks (GitHub then rejects the whole run) is a
 * second gate, a run nobody asked for, or a run that never starts. The docs rule at the end derives the check's name from the
 * two files, so the guide cannot name a check that does not exist.
 *
 * Run: node --test testing/standalone/ci-workflow-is-sound.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { splitStandalone } from '../_shared/standalone-split.mjs';
import {
  MERGE_GATE_NAME, loadCi, parseWorkflow, jobEntries, stepsOf, shellOf, shellCommands, usesOf, isCommitPinned, stepsUsing,
  runsNpmCi, expressionOf, transitiveNeeds, isAdvisory, isTrue, triggersOf,
  workflowFiles, loadWorkflow, actionFiles, loadAction, parseAction, CI_WORKFLOW,
} from '../_shared/ci-workflow.mjs';
// The full-run names (`FULL_RUN_WORKFLOW`, `FULL_RUN_PREFIX`, `loadFullRun`, `branchesOf`) are read off the namespace, so a
// module that lacks one fails the tests that need it and not the whole file.
import * as CW from '../_shared/ci-workflow.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';
import { GOOD_CI, GOOD_FULL_RUN, GOOD_PREFLIGHT, CLIENT_COMMAND } from '../_shared/ci-workflow-fixture.mjs';

const REAL = loadCi();
const GOOD = parseWorkflow(GOOD_CI, 'the conforming fixture');
const GOOD_FULL = parseWorkflow(GOOD_FULL_RUN, 'the conforming full-run fixture');
const clone = (doc) => structuredClone(doc);

// ───────────────────────────────────────── the merge gate ─────────────────────────────────────────

/** The floor on the jobs the gate waits for: the install-only, the image, and three stack jobs at the least. */
const NEEDED_FLOOR = 5;

/** Where a bash to run the verdict step can be found. A missing one FAILS the gate — a skip here is a silent one. */
function findBash() {
  const candidates = [process.env['BASH_EXE'], 'C:\\Program Files\\Git\\bin\\bash.exe', 'bash'].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('\\') && !existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return c;
  }
  throw new Error('no POSIX bash found to run the merge gate\'s verdict step (set BASH_EXE to one)');
}

/**
 * The verdict step as it would run with the given results, or an Error naming what this gate cannot render.
 * Only two expressions are understood — `needs.<id>.result` and `toJSON(needs)` — and any other is refused,
 * because a verdict the gate cannot read is a verdict the gate cannot hold to the rule.
 */
function renderVerdict(step, results) {
  const render = (text) => String(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, raw) => {
    const e = raw.trim();
    const one = e.match(/^needs\.([\w-]+)\.result$/);
    if (one) return results[one[1]] ?? '';
    if (e === 'toJSON(needs)') {
      return JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { result: r, outputs: {} }])), null, 2);
    }
    throw new Error(`the verdict step reads \`\${{ ${e} }}\`, which this gate cannot render: use needs.<job>.result or toJSON(needs)`);
  });
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, render(v)]));
  return { script: render(shellOf(step)), env };
}

/** The gate job's verdict: every needed job must have succeeded, and anything else must fail the step. */
function verdictViolations(gate, needs) {
  const v = [];
  const steps = stepsOf(gate.job);
  const readsNeeds = (s) => /\bneeds\b/.test(`${s.run ?? ''}\n${JSON.stringify(s.env ?? {})}`);
  const verdict = steps.find((s) => !s.uses && readsNeeds(s));
  if (!verdict) return [`the gate job has no run step that reads \`needs\` — nothing in it can fail on a failed job`];

  for (const s of steps) {
    if (isTrue(s['continue-on-error'])) {
      v.push(`gate step "${s.name ?? s.run}" is continue-on-error: it cannot fail the gate`);
    }
  }
  if (gate.job['continue-on-error'] != null) v.push('the gate job is continue-on-error: it cannot fail the check');
  if (verdict.if != null && !['always()', 'success()'].includes(expressionOf(verdict.if))) {
    v.push(`the verdict step has \`if: ${verdict.if}\`: it must run unconditionally, or a passing path skips it`);
  }
  const text = shellOf(verdict);
  if (!/\bsuccess\b/.test(`${text}\n${JSON.stringify(verdict.env ?? {})}`)) {
    v.push('the verdict never names `success`: a check for `failure` passes a job that was skipped or cancelled');
  }
  if (/\|\|\s*true\b/.test(text)) v.push('the verdict step ends a failing path in `|| true`');

  // The failing half of the truth table, executed. Every needed job in turn: failure, cancelled, skipped.
  const bash = findBash();
  for (const id of needs) {
    for (const bad of ['failure', 'cancelled', 'skipped']) {
      const results = Object.fromEntries(needs.map((n) => [n, n === id ? bad : 'success']));
      let rendered;
      try { rendered = renderVerdict(verdict, results); } catch (e) { return [...v, e.message]; }
      const r = spawnSync(bash, ['-e', '-c', rendered.script], { env: { ...process.env, ...rendered.env }, encoding: 'utf8' });
      if (r.status === 0) v.push(`the gate PASSES when ${id} is ${bad}`);
    }
  }
  return v;
}

function mergeGateViolations(doc) {
  const v = [];
  const jobs = jobEntries(doc);
  const gates = jobs.filter((j) => j.name === MERGE_GATE_NAME);
  if (gates.length !== 1) return [`${gates.length} jobs are named "${MERGE_GATE_NAME}"; the ruleset requires exactly one`];
  const gate = gates[0];

  if (expressionOf(gate.job.if) !== 'always()') {
    v.push(`the gate has \`if: ${gate.job.if ?? '(none)'}\`; it must be \`always()\`, or a failed needed job SKIPS the required check`);
  }
  if (gate.job.strategy?.matrix) v.push('the gate has a matrix: the required check name would be several jobs');

  const advisory = jobs.filter((j) => isAdvisory(j.job));
  if (advisory.includes(gate)) v.push('the gate itself is continue-on-error');
  if (advisory.length > 1) v.push(`${advisory.length} advisory jobs (${advisory.map((a) => a.id)}): which of them may fail without failing the run?`);

  const expected = jobs.filter((j) => j !== gate && !advisory.includes(j)).map((j) => j.id).sort();
  const needs = [].concat(gate.job.needs ?? []).sort();
  if (expected.length < NEEDED_FLOOR) {
    v.push(`only ${expected.length} job(s) besides the gate and the advisory one (floor ${NEEDED_FLOOR}): the pipeline is not split, or the derivation is broken`);
  }
  const missing = expected.filter((id) => !needs.includes(id));
  const extra = needs.filter((id) => !expected.includes(id));
  if (missing.length) v.push(`the gate does not wait for: ${missing.join(', ')} — a failure there merges anyway`);
  if (extra.length) v.push(`the gate waits for ${extra.join(', ')}, which are not jobs of this file or are the advisory one`);

  // Every job the gate's verdict covers must be a job the gate waits for, whatever else the verdict reads.
  const verdictNeeds = needs.filter((id) => expected.includes(id));
  if (verdictNeeds.length) v.push(...verdictViolations(gate, verdictNeeds));
  else v.push('the gate waits for nothing, so its verdict cannot be run');
  return v;
}

// ───────────────────────────────────────── timeouts ─────────────────────────────────────────

/** The ceiling a job may declare: today's single job declared this, and no stage of the split needs more. */
const TIMEOUT_CEILING = 90;

function timeoutViolations(doc) {
  const jobs = jobEntries(doc);
  const v = jobs.length < 6 ? [`only ${jobs.length} job(s) found (floor 6): the derivation is broken`] : [];
  for (const { id, job } of jobs) {
    const t = job['timeout-minutes'];
    if (!Number.isInteger(t) || t < 1 || t > TIMEOUT_CEILING) {
      v.push(`${id}: timeout-minutes is ${JSON.stringify(t)}; a literal 1..${TIMEOUT_CEILING}, or a hung step holds the runner for the platform's six hours`);
    }
  }
  return v;
}

// ───────────────────────────────────────── artifacts ─────────────────────────────────────────

/**
 * What an upload may name. Artifacts of a public repository are public downloads, so the allowlist is the legal
 * question ("what does this ship") answered once: the run's measurements, the Ythril test image (which carries
 * NOTICE and LICENSE exactly as the published image does) and the server build. NOT a sidecar image, NOT a database
 * image: neither carries what its licence requires of a redistribution.
 */
const UPLOAD_PATHS = [
  [/^test-results[\w*./-]*$/, 'the run\'s measurements'],
  [/^timings[\w*./-]*$/, 'the run\'s timings'],
  [/^server\/dist(?:\/\*\*(?:\/\*)?|\/)?$/, 'the server build'],
  [/^(?:_\/)?ythril-test[\w.*-]*\.tar$/, 'the Ythril test image'],
];
/** The two that are a build output rather than a measurement: kept one day. */
const SHORT_LIVED = [UPLOAD_PATHS[2][0], UPLOAD_PATHS[3][0]];

const UPLOAD_FLOOR = 3;

function uploadViolations(doc) {
  const v = [];
  let seen = 0;
  for (const { id, job } of jobEntries(doc)) {
    for (const s of stepsUsing(job, 'actions/upload-artifact')) {
      seen++;
      const w = s.with ?? {};
      const where = `${id} upload "${w.name ?? '?'}"`;
      const entries = String(w.path ?? '').split('\n').map((p) => p.trim().replace(/^\.\//, ''))
        .filter(Boolean).filter((p) => !p.startsWith('!')).map((p) => p.replace(/\$\{\{[^}]*\}\}/g, '_'));
      if (!entries.length) v.push(`${where}: no path`);
      for (const p of entries) {
        // `..` and an absolute path match the character classes below, so they are refused first.
        const escapes = p.startsWith('/') || p.split('/').includes('..');
        if (escapes || !UPLOAD_PATHS.some(([re]) => re.test(p))) {
          v.push(`${where}: path \`${p}\` is not on the allowlist (${UPLOAD_PATHS.map(([, why]) => why).join('; ')})`);
        }
      }
      if (w['if-no-files-found'] !== 'error') v.push(`${where}: if-no-files-found is ${w['if-no-files-found'] ?? '(warn)'}; an empty upload must fail, not pass`);
      const days = w['retention-days'];
      if (!Number.isInteger(days) || days < 1 || days > 30) v.push(`${where}: retention-days is ${JSON.stringify(days)}; a literal 1..30`);
      else if (entries.some((p) => SHORT_LIVED.some((re) => re.test(p))) && days !== 1) {
        v.push(`${where}: a build output is kept ${days} days; it is a public download, so it lives one`);
      }
      if (!/github\.run_attempt/.test(String(w.name ?? ''))) {
        v.push(`${where}: the name does not carry github.run_attempt; a re-run uploads over the first attempt's artifact and fails`);
      }
    }
  }
  if (seen < UPLOAD_FLOOR) v.push(`only ${seen} upload step(s) (floor ${UPLOAD_FLOOR}): the run's measurements and image are not kept, or the derivation is broken`);
  return v;
}

// ───────────────────────────────────────── one suite per results artifact ─────────────────────────────────────────

/**
 * `scripts/test-times.mjs` records a CI run per JOB, by that job's `test-results-<job>` artifact: a job whose artifact is
 * recorded is not downloaded again, so a job whose artifact held TWO suites would be read as recorded after the first and
 * the second would never be written (round S+T, S7). Holding that needs a fact about the workflow, not about the script:
 * each job that uploads results RUNS one suite, by one runner command that is not an aggregate. The runner commands are read
 * out of the steps (`npm run test…`, `npm test` and `npm t`, `node … --test`, a `testing/_init/run-…` script, `vitest`) and the
 * aggregates out of `package.json` (a `test…` script that runs several suites in one command: its body chains two runner
 * commands with `&&` or `;`, or it is one of the two runners that are aggregates by design), so a new aggregate script is
 * refused without being named here. A spelling `RUNNER` does not know (`npx jest`) is the one thing left that counts as no suite.
 */
const RUNNER = /\bnpm run test(?::[\w-]+)*\b|\bnpm (?:test|t)\b|\bnode\s+(?:\.\/)?testing\/_init\/run-[\w-]+\.mjs\b|\bnode\b[^\n;&|]*\s--test\b|\bvitest\b/g;
const RESULTS_JOB_FLOOR = 3;
const runnersIn = (text) => [...String(text).matchAll(new RegExp(RUNNER.source, 'g'))].map((m) => m[0]);

/** The `npm` script a runner command runs: `npm run test:x` is `test:x`, `npm test` and `npm t` are `test`; any other spelling names none. */
const scriptNamed = (runner) => /^npm run (\S+)$/.exec(runner)?.[1] ?? (/^npm (?:test|t)$/.test(runner) ? 'test' : undefined);

const packageScripts = () => JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;

/**
 * The `npm run` names of the scripts that run more than one suite in one command, derived from the script bodies: a body
 * that chains two runner commands (`&&`, `;`, in whatever spelling `RUNNER` reads), the two runners that are aggregates by
 * design, and the standalone runner without `--only`.
 */
function aggregateTestScripts(allScripts = packageScripts()) {
  const scripts = Object.entries(allScripts).filter(([name]) => name.startsWith('test'));
  const chainsTwoRunners = (cmd) => cmd.split(/&&|;/).reduce((n, part) => n + runnersIn(part).length, 0) >= 2;
  const aggregates = new Set(scripts.filter(([, cmd]) => /run-all-core|run-test-all/.test(cmd) || chainsTwoRunners(cmd)
    || (/run-standalone\.mjs/.test(cmd) && !/--only=/.test(cmd))).map(([name]) => name));
  // An alias of an aggregate (`test:all:keep` runs `test:all:core`) is one.
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, cmd] of scripts) {
      const target = /^npm run ([\w:-]+)\s*$/.exec(cmd)?.[1];
      if (target && aggregates.has(target) && !aggregates.has(name)) { aggregates.add(name); grew = true; }
    }
  }
  return [...aggregates];
}

/** The upload steps of one job whose artifact name starts `test-results`: the one filter every rule over the results uploads reads. */
const resultsUploadsOf = (job) => stepsUsing(job, 'actions/upload-artifact').filter((u) => /^test-results/.test(String(u.with?.name ?? '')));

function oneSuitePerResultsArtifactViolations(doc, scripts = packageScripts()) {
  const v = [];
  const aggregates = aggregateTestScripts(scripts);
  let jobsWithResults = 0;
  for (const { id, job } of jobEntries(doc)) {
    const uploads = resultsUploadsOf(job);
    if (uploads.length === 0) continue;
    jobsWithResults++;
    if (uploads.length > 1) v.push(`${id}: ${uploads.length} results artifacts from one job`);
    const runners = stepsOf(job).flatMap((st) => runnersIn(st.run ?? ''));
    if (runners.length !== 1) v.push(`${id}: uploads results and carries ${runners.length} suite runner command(s) (${runners.join('; ') || 'none'}): its artifact must hold exactly one suite`);
    for (const r of runners) {
      const name = scriptNamed(r);
      if (name && aggregates.includes(name)) v.push(`${id}: \`${r}\` runs several suites in one command; its results are one artifact`);
    }
  }
  if (jobsWithResults < RESULTS_JOB_FLOOR) v.push(`only ${jobsWithResults} job(s) upload results (floor ${RESULTS_JOB_FLOOR}): the derivation is broken, or the results are not kept`);
  if (aggregates.length < 1) v.push('no aggregate test script found in package.json: the derivation of "runs several suites" is broken');
  return v;
}

// ───────────────────────────────────────── caches ─────────────────────────────────────────

/** `push` to `main` and nothing wider: both halves present, no `||`, no negation, outside string literals. */
function guardsMainPush(condition) {
  const e = expressionOf(condition);
  if (!/github\.event_name == 'push'/.test(e)) return false;
  if (!/github\.ref == 'refs\/heads\/main'|github\.ref_name == 'main'/.test(e)) return false;
  const bare = e.replace(/'[^']*'/g, "''").replace(/\|\|\s*''\s*$/, '');
  return !/\|\||!/.test(bare);
}

/**
 * Every `cache-to` in a step sits under a main-push guard: the step's, the job's, or its own `${{ … }}`. A step may
 * write the cache in two shapes — a `--cache-to` in its script, or a `cache-to:` input of an action — and both count.
 */
function cacheToIsGuarded(job, step) {
  if (guardsMainPush(step.if) || guardsMainPush(job.if)) return true;
  const inputGuarded = !hasCacheToInput(step) || guardsMainPush(step.with['cache-to']);
  const text = String(step.run ?? '');
  const total = (text.match(/cache-to/g) ?? []).length;
  const guarded = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
    .filter((m) => guardsMainPush(m[1]))
    .reduce((n, m) => n + (m[1].match(/cache-to/g) ?? []).length, 0);
  return inputGuarded && guarded === total;
}

const hasCacheToInput = (step) => Object.prototype.hasOwnProperty.call(step.with ?? {}, 'cache-to');
const writesLayerCache = (step) => hasCacheToInput(step) || /cache-to/.test(String(step.run ?? ''));

function cacheViolations(doc) {
  const v = [];
  let writers = 0;
  for (const { id, job } of jobEntries(doc)) {
    for (const s of stepsOf(job)) {
      const u = usesOf(s);
      const where = `${id} step "${s.name ?? s.uses ?? s.run?.slice(0, 40)}"`;
      if (u?.action === 'actions/cache') {
        v.push(`${where}: \`actions/cache\` saves on every run; use actions/cache/restore, and actions/cache/save under a main-push guard`);
      }
      if (u?.action === 'actions/cache/save') {
        writers++;
        if (!guardsMainPush(s.if) && !guardsMainPush(job.if)) {
          v.push(`${where}: a cache save that is not guarded to push-to-main: a pull request could write the cache the main branch reads`);
        }
      }
      if (u?.action === 'actions/setup-node' && s.with?.cache != null && s.with.cache !== 'npm') {
        v.push(`${where}: setup-node caches \`${s.with.cache}\`; its post-job save runs on pull requests, so only the npm download cache (keyed on the lockfile) is sanctioned`);
      }
      if (writesLayerCache(s)) {
        writers++;
        if (!cacheToIsGuarded(job, s)) v.push(`${where}: \`cache-to\` is not guarded to push-to-main on the step, the job or its own expression`);
      }
    }
  }
  if (/restore-keys/.test(JSON.stringify(doc))) {
    v.push('`restore-keys` is used: a prefix match restores another ref\'s cache; exact keys only');
  }
  if (!writers) v.push('no cache writer found: the layers are rebuilt every run, or the derivation is broken');
  return v;
}

// ───────────────────────────────────────── the runtime token ─────────────────────────────────────────

const RUNTIME_ACTION = 'crazy-max/ghaction-github-runtime';
const RUNTIME_JOB = 'prepare';

function runtimeTokenViolations(doc) {
  const v = [];
  const uses = [];
  for (const { id, job } of jobEntries(doc)) {
    stepsOf(job).forEach((s, i) => { if (usesOf(s)?.action === RUNTIME_ACTION) uses.push({ id, job, i, s }); });
  }
  if (uses.length !== 1) return [`${uses.length} steps use ${RUNTIME_ACTION}; exactly one, in \`${RUNTIME_JOB}\``];
  const { id, job, i, s } = uses[0];
  if (id !== RUNTIME_JOB) v.push(`the runtime token is exposed in \`${id}\`; only \`${RUNTIME_JOB}\` builds the image`);
  if (!isCommitPinned(usesOf(s).ref)) v.push(`${RUNTIME_ACTION} is pinned to \`${usesOf(s).ref}\`: a tag moves, a commit does not`);
  const steps = stepsOf(job);
  const install = steps.findIndex(runsNpmCi);
  if (install < 0 || install > i) v.push('the runtime token is exposed before `npm ci` runs: every install script then holds it');
  const next = steps[i + 1];
  const consumes = next && (usesOf(next)?.action === 'docker/build-push-action' || /docker\s+buildx\s+(build|bake)\b/.test(shellOf(next)));
  if (!consumes) v.push('the step after the runtime token is not the buildx build: the token must sit immediately before the one step that uses it');
  return v;
}

// ───────────────────────────────────────── permissions ─────────────────────────────────────────

function permissionViolations(doc) {
  const v = [];
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: 'read' })) {
    v.push(`top-level permissions are ${JSON.stringify(doc.permissions ?? '(none: the repository default)')}; exactly {contents: read}`);
  }
  for (const { id, job } of jobEntries(doc)) {
    const p = job.permissions;
    if (p == null) continue;
    if (typeof p !== 'object') { v.push(`${id}: permissions are \`${p}\``); continue; }
    for (const [k, val] of Object.entries(p)) {
      if (k === 'contents' && val === 'read') continue;
      if (k === 'actions' && val === 'read' && isAdvisory(job)) continue;
      v.push(`${id}: permission ${k}: ${val} is not granted to this job (actions: read belongs to the advisory job alone)`);
    }
  }
  return v;
}

// ───────────────────────────────────────── concurrency ─────────────────────────────────────────

function concurrencyViolations(doc) {
  const c = doc.concurrency;
  if (!c || typeof c !== 'object') return ['no top-level concurrency: every push of a pull request stacks another full run'];
  const v = [];
  if (!/github\.ref\b/.test(String(c.group ?? ''))) v.push(`the group \`${c.group}\` is not per ref`);
  if (expressionOf(c['cancel-in-progress']) !== "github.event_name == 'pull_request'") {
    v.push(`cancel-in-progress is \`${c['cancel-in-progress']}\`; it cancels pull-request runs only — a main push must always finish and write its caches`);
  }
  return v;
}

// ───────────────────────────────────────── stack jobs ─────────────────────────────────────────

const STACK_FLOOR = 3;
const UP_COMMAND = /\bdocker\s+compose\b[^\n]*?\bup\b[^\n]*/g;
const IMAGE_MAKER = /\bdocker\s+(?:load|pull|build|buildx\s+build)\b/;

function stackJobViolations(doc) {
  const v = [];
  const stackJobs = jobEntries(doc).filter(({ job }) => stepsOf(job).some((s) => /\bdocker\s+compose\b[^\n]*?\bup\b/.test(shellOf(s))));
  if (stackJobs.length < STACK_FLOOR) v.push(`only ${stackJobs.length} job(s) start a compose stack (floor ${STACK_FLOOR}): the stack suites are not split, or the derivation is broken`);
  for (const { id, job } of stackJobs) {
    const steps = stepsOf(job);
    const firstUp = steps.findIndex((s) => /\bdocker\s+compose\b[^\n]*?\bup\b/.test(shellOf(s)));
    for (const s of steps) {
      for (const [cmd] of shellOf(s).matchAll(UP_COMMAND)) {
        if (!/--no-build\b/.test(cmd)) v.push(`${id}: \`${cmd.trim()}\` may build: it needs --no-build`);
        if (!/--pull[ =]never\b/.test(cmd)) v.push(`${id}: \`${cmd.trim()}\` may pull: it needs --pull never`);
        if (!/docker-compose\.test\.yml/.test(cmd)) v.push(`${id}: \`${cmd.trim()}\` does not name the test compose file`);
      }
    }
    const made = steps.findIndex((s) => IMAGE_MAKER.test(shellOf(s)) || usesOf(s)?.action === 'docker/build-push-action');
    if (made < 0 || made > firstUp) v.push(`${id}: no step loads, pulls or builds the images before compose starts — with --pull never the stack cannot start`);
  }
  return v;
}

// ───────────────────────────────────────── what the gate reads after the verdict ─────────────────────────────────────────

/**
 * The two checks that read the run's own results, by script. Derived from nothing: they are the interface the plan names
 * (`scripts/executed-tests.mjs`, `scripts/unexpected-skips.mjs`), and a rule that found them by scanning for "any script"
 * would pass the day both were deleted.
 */
const EVIDENCE_SCRIPTS = ['executed-tests', 'unexpected-skips'];

/** A step runs only when everything before it succeeded: no `if`, or exactly `success()`. */
const runsOnlyOnSuccess = (s) => s.if == null || expressionOf(s.if) === 'success()';

/**
 * Past the verdict, the gate's remaining steps must run ONLY when every needed job succeeded (the default of a step
 * that follows a failed one), read the artifacts of THIS attempt, and fail the job when a check does. A check that can
 * run when a job failed prints a verdict about a partial results set; a check that cannot fail the job is a log line.
 */
function gateEvidenceViolations(doc) {
  const gate = jobEntries(doc).find((j) => j.name === MERGE_GATE_NAME);
  if (!gate) return [`no job is named "${MERGE_GATE_NAME}"`];
  const steps = stepsOf(gate.job);
  const verdictAt = steps.findIndex((s) => !s.uses && /\bneeds\b/.test(`${s.run ?? ''}\n${JSON.stringify(s.env ?? {})}`));
  if (verdictAt < 0) return ['the gate has no verdict step, so there is no "after" for the results checks to follow'];
  const v = [];
  const after = steps.slice(verdictAt + 1);

  const download = after.find((s) => usesOf(s)?.action === 'actions/download-artifact');
  if (!download) return ['the gate downloads no artifacts after its verdict: the results checks have nothing to read'];
  const w = download.with ?? {};
  if (!/^test-results-\*-\$\{\{\s*github\.run_attempt\s*\}\}$/.test(String(w.pattern ?? ''))) {
    v.push(`the download pattern is \`${w.pattern}\`; it must be test-results-*-\${{ github.run_attempt }}, every job's results of THIS attempt and no earlier one's`);
  }
  if (!isTrue(w['merge-multiple'])) v.push('the download does not set merge-multiple: true, so every job lands in a folder of its own and no check reads them as one set');
  const dir = String(w.path ?? '').replace(/^\.\//, '');
  if (!dir) v.push('the download names no path');

  const downloadAt = after.indexOf(download);
  const before = after.slice(0, downloadAt);
  if (!before.some((s) => usesOf(s)?.action === 'actions/checkout')) v.push('no checkout between the verdict and the download: the checks list the repository\'s tracked test files');
  if (!before.some((s) => usesOf(s)?.action === 'actions/setup-node')) v.push('no setup-node between the verdict and the download: the checks are node scripts');
  if (steps.slice(0, verdictAt).some((s) => usesOf(s))) v.push('a checkout or an action sits BEFORE the verdict: a red run would spend its time on setup it does not use');

  for (const s of [download, ...before]) {
    if (!runsOnlyOnSuccess(s)) v.push(`gate step "${s.name ?? s.uses}" has \`if: ${s.if}\`: it must not run when a needed job failed`);
  }
  for (const name of EVIDENCE_SCRIPTS) {
    const runs = after.slice(downloadAt + 1).filter((s) => new RegExp(`\\bnode\\s+scripts/${name}\\.mjs\\b`).test(shellOf(s)));
    if (runs.length !== 1) { v.push(`${runs.length} step(s) run scripts/${name}.mjs after the download; exactly one`); continue; }
    const [s] = runs;
    const text = shellOf(s);
    const arg = text.match(/--results[ =]("[^"]+"|'[^']+'|\S+)/)?.[1]?.replace(/^["']|["']$/g, '').replace(/^\.\//, '');
    if (!arg || arg !== dir) v.push(`${name} reads \`${arg ?? '(no --results)'}\`, not the downloaded folder \`${dir}\``);
    if (isTrue(s['continue-on-error'])) v.push(`${name} is continue-on-error: it cannot fail the gate`);
    if (!runsOnlyOnSuccess(s)) v.push(`${name} has \`if: ${s.if}\`: it must not run when a needed job failed`);
    if (/\|\|\s*(true|:)\b/.test(text) || /;\s*(true|exit\s+0)\b/.test(text)) v.push(`${name} ends a failing path in \`|| true\``);
  }
  return v;
}

/** The client's unit tests write the JSON report the aggregator reads (`client.json`), beside the node ones. */
const CLIENT_REPORT = 'test-results/client.json';

/**
 * What a command that runs the client's unit tests looks like. THE finder: `clientReportViolations` reads the CI job with
 * it and `preflightClientParityViolations` reads `scripts/preflight.mjs` with it, so the two cannot disagree about which
 * line is "the client run" (the parity rule would otherwise hold a command equal to a different one).
 */
const CLIENT_RUN = /\btest:client\b|\bvitest\b|\bnpm run test\b[^\n]*--workspace[ =]client/;

function clientReportViolations(doc) {
  const job = doc.jobs?.['client-tests'];
  if (!job) return ['no client-tests job'];
  const runs = stepsOf(job).filter((s) => CLIENT_RUN.test(shellOf(s)));
  if (runs.length !== 1) return [`${runs.length} step(s) run the client's unit tests; exactly one`];
  const text = shellOf(runs[0]);
  const v = [];
  if (!/--reporter[ =]json\b/.test(text) || !/--outputFile(?:\.json)?[ =]\S*test-results\/client\.json\b/.test(text)) {
    v.push(`the client's unit-test step does not write ${CLIENT_REPORT} (--reporter=json --outputFile.json=...): the aggregator has no client results to check for skips`);
  }
  // `test:client` is itself an `npm run`: flags after one `--` reach the INNER npm, which takes them for its own config.
  if (/\bnpm run test:client\b[^\n]*--(?:reporter|outputFile)/.test(text)) {
    v.push('the client\'s unit-test step passes vitest flags through `npm run test:client`: the inner npm swallows them as unknown config and no report is written; call `npm run test --workspace=client -- ...`');
  }
  if (!/--reporter[ =]default\b/.test(text)) v.push('the client\'s unit-test step names the json reporter without `--reporter=default`: the console log is gone');
  return v;
}

/**
 * The advisory job reads this attempt's results and calls `scripts/test-times.mjs` WITH a command. It called it with none,
 * which prints the help and exits 1: an advisory step that always failed and a summary nobody could read.
 */
function advisorySummaryViolations(doc) {
  const advisory = jobEntries(doc).find((j) => isAdvisory(j.job));
  if (!advisory) return ['no advisory job'];
  const steps = stepsOf(advisory.job);
  const v = [];
  const download = steps.find((s) => usesOf(s)?.action === 'actions/download-artifact');
  if (!download) return ['the advisory job downloads no artifacts: the summary has nothing to read'];
  const w = download.with ?? {};
  if (!/^test-results-\*-\$\{\{\s*github\.run_attempt\s*\}\}$/.test(String(w.pattern ?? ''))) v.push(`the advisory download pattern is \`${w.pattern}\`; it must be test-results-*-\${{ github.run_attempt }}`);
  if (!isTrue(w['merge-multiple'])) v.push('the advisory download does not set merge-multiple: true');
  const dir = String(w.path ?? '').replace(/^\.\//, '');

  const callers = steps.filter((s) => /\btest-times\.mjs\b/.test(shellOf(s)));
  for (const s of callers) {
    // Every mention is followed by a command: a bare call prints the help and exits 1.
    for (const m of shellOf(s).matchAll(/\bscripts\/test-times\.mjs\b(?!\s+--[a-z])/g)) {
      v.push(`a step calls scripts/test-times.mjs with no command (\`${shellOf(s).slice(m.index).split('\n')[0]}\`): it prints the help and exits 1`);
    }
  }
  const summaries = callers.filter((s) => /\btest-times\.mjs\s+--summary\b/.test(shellOf(s)));
  if (summaries.length !== 1) return [...v, `${summaries.length} step(s) run test-times.mjs --summary; exactly one`];
  const [s] = summaries;
  const arg = shellOf(s).match(/--results[ =]("[^"]+"|'[^']+'|\S+)/)?.[1]?.replace(/^["']|["']$/g, '').replace(/^\.\//, '');
  if (!arg || arg !== dir) v.push(`--summary reads \`${arg ?? '(no --results)'}\`, not the downloaded folder \`${dir}\``);
  if (steps.indexOf(s) < steps.indexOf(download)) v.push('the summary runs before the download');
  if (!s.env?.GH_TOKEN) v.push('the summary step has no GH_TOKEN: the baseline against the last runs of main is skipped');
  if (!steps.some((x) => usesOf(x)?.action === 'actions/checkout')) v.push('the advisory job has no checkout: scripts/test-times.mjs is not on the runner');
  return v;
}

/**
 * A job that runs tests checks out the whole history. Tests read it: `no-live-text-names-a-retired-tool` finds the last
 * release of the previous major among the tags, and the source sweeps read `git log`. A shallow clone (the checkout's
 * default, `fetch-depth: 1`, no tags) makes such a test fail, or, written less carefully, find nothing and pass. Before
 * the jobs were split only one job checked out, with `fetch-depth: 0`; the first run of the split failed the retired-tool
 * test in the no-services job for exactly this. The jobs are the ones whose steps run a suite runner (`RUNNER`).
 */
function historyViolations(doc) {
  const v = [];
  for (const { id, job: j } of jobEntries(doc)) {
    const steps = stepsOf(j);
    if (!steps.some((s) => runnersIn(shellOf(s)).length > 0)) continue;
    const checkouts = steps.filter((s) => usesOf(s)?.action === 'actions/checkout');
    if (checkouts.length === 0) { v.push(`${id}: runs tests with no checkout`); continue; }
    for (const c of checkouts) {
      if (String(c.with?.['fetch-depth'] ?? '1') !== '0') v.push(`${id}: runs tests from a shallow checkout (fetch-depth ${c.with?.['fetch-depth'] ?? 'default 1'}); tests read tags and history, so it must be 0`);
    }
  }
  return v;
}

/** A step that runs a suite on the host with node (the client's vitest suite is the one that imports no server code). */
const runsServerSuite = (s) => runnersIn(shellOf(s)).some((r) => !/vitest/.test(r)) && !/--workspace[= ]client\b/.test(shellOf(s));

/**
 * A job that runs a suite on the host builds the server first. The test files import `server/dist` (the shared helpers do:
 * `legacy-token-rights.mjs` imports `server/dist/auth/rights-migration.js`), and the test image a stack job loads carries
 * the server INSIDE a container, not on the runner. The first run of the split jobs failed fifteen red-team files with
 * ERR_MODULE_NOT_FOUND: that job alone had no build step.
 */
function serverBuildViolations(doc) {
  const v = [];
  for (const { id, job: j } of jobEntries(doc)) {
    const steps = stepsOf(j);
    const first = steps.findIndex(runsServerSuite);
    if (first < 0) continue;
    const build = steps.findIndex((s) => /\bnpm run build:server\b/.test(shellOf(s)));
    if (build < 0 || build > first) v.push(`${id}: runs tests that import server/dist with no \`npm run build:server\` before them`);
  }
  return v;
}

/** The instance letters (`INSTANCES.a`…) a set of test files reach, read from their code, comments stripped. */
function instancesReached(files) {
  const found = new Set();
  for (const f of files) {
    for (const m of stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')).matchAll(/\bINSTANCES\.([a-z])\b/g)) found.add(m[1]);
  }
  return found;
}

/** The test files the runner command of a step runs, read from `package.json` and the suite table — or null when it is not a stack suite. */
function suiteFilesOf(runner, scripts) {
  const name = scriptNamed(runner);
  const body = name ? String(scripts[name] ?? '') : runner;
  const suite = /run-suite\.mjs\s+(\w+)/.exec(body)?.[1];
  if (suite) {
    const table = readFileSync(join(REPO_ROOT, 'testing/_init/run-suite.mjs'), 'utf8');
    const dir = new RegExp(`\\b${suite}:\\s*\\{\\s*dir:\\s*'([^']+)'`).exec(table)?.[1];
    if (!dir) throw new Error(`run-suite.mjs has no folder for the suite ${suite}: re-anchor this rule`);
    return trackedSources([dir], { ext: ['.js'], floor: 5 }).filter((f) => f.endsWith('.test.js'));
  }
  if (/run-standalone\.mjs\b.*--only=instance/.test(body)) {
    return splitStandalone({ root: REPO_ROOT }).needsInstance.map((f) => `testing/standalone/${String(f).split(/[\\/]/).pop()}`);
  }
  return null;
}

/**
 * A stack job starts every instance its suite talks to. A job may start a subset of the stack (what its suite needs, so the
 * runner's memory goes where it is used), and the subset is written by hand in the compose command — so a test that reaches
 * an instance the job did not start fails with `fetch failed`, which reads like a flaky network. The first run of the split
 * jobs failed the red-team brute-force cases exactly so: they drive instance C, and the job started A, B and D. The
 * instances a suite reaches are read from its files (`INSTANCES.c`), never listed; a compose up that names no service
 * starts them all.
 */
function stackInstanceViolations(doc, scripts = packageScripts()) {
  const v = [];
  for (const { id, job: j } of jobEntries(doc)) {
    const steps = stepsOf(j);
    const up = steps.map((s) => shellOf(s)).find((sh) => /docker compose\b[\s\S]*\bup\b/.test(sh));
    if (!up) continue;
    const upLine = up.slice(up.search(/\bup\b/));
    const named = [...upLine.matchAll(/\bythril-([a-z])\b/g)].map((m) => m[1]);
    const started = named.length === 0 ? null : new Set(named);
    for (const s of steps) {
      for (const runner of runnersIn(shellOf(s))) {
        const files = suiteFilesOf(runner, scripts);
        if (!files) continue;
        const reached = instancesReached(files);
        if (reached.size === 0) v.push(`${id}: ${runner} reaches no instance — the suite's files were not read`);
        const missing = started ? [...reached].filter((x) => !started.has(x)) : [];
        if (missing.length) v.push(`${id}: ${runner} reaches instance(s) ${missing.join(', ')} that the job does not start (it starts ${[...started].join(', ')})`);
      }
    }
  }
  return v;
}

// ───────────────────────────────────────── the job's name is the record's key ─────────────────────────────────────────

/** `test-results-<X>-${{ github.run_attempt }}` gives `<X>`; any other spelling gives null. */
const resultsNameJob = (name) => /^test-results-(.+?)-\$\{\{\s*github\.run_attempt\s*\}\}$/.exec(String(name))?.[1] ?? null;

/**
 * The recorder (`scripts/test-times.mjs`) reads the JOB of a CI record from its results artifact's name, the
 * `test-results-<X>-` segment, and keys the record by it. An upload named for a display name, a renamed job or another
 * job's id puts a record under a job that does not exist (or over another job's record), and nothing complains: the
 * record is written, the run counts as recorded. So the segment is the id of the job the upload sits in, read from the
 * workflow and not from a table of names kept beside it.
 */
function uploadNameViolations(doc) {
  const v = [];
  let seen = 0;
  for (const { id, job } of jobEntries(doc)) {
    for (const s of resultsUploadsOf(job)) {
      const name = String(s.with?.name ?? '');
      seen++;
      const named = resultsNameJob(name);
      if (named == null) {
        v.push(`${id}: the results artifact "${name}" is not test-results-<job id>-\${{ github.run_attempt }}; the recorder reads the job from that segment`);
      } else if (named !== id) {
        v.push(`${id}: the results artifact "${name}" names \`${named}\`, not \`${id}\`; the recorder keys the job's record by that segment, so the record would carry another name than the job's id`);
      }
    }
  }
  if (seen < RESULTS_JOB_FLOOR) v.push(`only ${seen} results upload(s) (floor ${RESULTS_JOB_FLOOR}): the derivation is broken, or the results are not kept`);
  return v;
}

// ───────────────────────────────────────── no credential reaches repository code ─────────────────────────────────────────

const CHECKOUT = 'actions/checkout';

/**
 * Every step of a parsed document that runs steps: a workflow's jobs, or a composite action's `runs.steps`, each with a
 * label and the job it sits in (null for an action).
 */
function stepEntries(doc) {
  if (doc.jobs && typeof doc.jobs === 'object') {
    return jobEntries(doc).flatMap(({ id, job }) => stepsOf(job).map((step, i) => ({ where: `${id} step ${i + 1}`, job, step })));
  }
  return stepsOf(doc.runs ?? {}).map((step, i) => ({ where: `action step ${i + 1}`, job: null, step }));
}

/**
 * Does the checkout leave its token in `.git/config` for every later step. The action's default is yes, so a missing input
 * persists; only a literal false turns it off, read in the two spellings YAML gives it (the boolean, the string) and any
 * case. An expression, an empty string or anything `isTrue` reads as on persists. `isTrue` is the shared reading of "on".
 */
const persistsCredentials = (step) => {
  const v = step.with?.['persist-credentials'];
  return v === undefined || isTrue(v) || !/^false$/i.test(String(v).trim());
};

/**
 * The persisted token is the credential every step after a checkout can read from disk — the tests, every dependency a
 * test imports, and the job log's `git remote -v`. A job that runs repository code needs none of it (it reads the
 * checkout, it does not push), so each checkout declares `persist-credentials: false`.
 */
function checkoutCredentialViolations(doc) {
  const v = [];
  for (const { where, step } of stepEntries(doc)) {
    if (usesOf(step)?.action !== CHECKOUT || !persistsCredentials(step)) continue;
    const given = step.with?.['persist-credentials'];
    v.push(`${where}: actions/checkout has persist-credentials ${given === undefined ? 'unset (the default keeps the token)' : `\`${given}\``}; set \`persist-credentials: false\`, or the token stays in .git/config for every step after it`);
  }
  return v;
}

/** `'...'` literals out of an expression, so a word inside a string (`contains(body, 'secrets')`) is not read as a context. */
const withoutStrings = (expr) => expr.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

/**
 * What an expression names that is, or holds, a credential — or null. Every spelling of the same credential, because a rule
 * that read only `secrets.X` was satisfied by `github.token`, `github['token']`, `toJSON(github)` and `toJSON(secrets)`.
 */
function credentialIn(expr) {
  if (/\bgithub\s*\[\s*(['"])token\1\s*\]/.test(expr)) return "github['token']";
  const bare = withoutStrings(expr);
  if (/\bsecrets\b/.test(bare)) return 'the secrets context';
  if (/\bgithub\s*\.\s*token\b/.test(bare)) return 'github.token';
  if (/\bgithub\b(?!\s*[.[])/.test(bare)) return 'the whole github context (it holds the token)';
  return null;
}

/** The `${{ … }}` expressions of a string; for an `if:` value the whole string when it carries no braces. */
function* expressionsIn(text, key) {
  let braced = false;
  for (const m of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) { braced = true; yield m[1]; }
  if (!braced && key === 'if') yield text;
}

/**
 * The one credential a job may be handed: `github.token` as the advisory job's `GH_TOKEN` (the baseline read of the last
 * runs of main), at a step of a job `isAdvisory` calls advisory. The runtime cache token (`ACTIONS_RUNTIME_TOKEN`) is set by
 * an action's own code and never appears as an expression; `runtimeTokenViolations` governs where that action sits.
 */
function isAdvisoryGhToken(doc, path, value) {
  const [top, id, steps, , env, name] = path;
  if (top !== 'jobs' || steps !== 'steps' || env !== 'env' || name !== 'GH_TOKEN' || path.length !== 6) return false;
  return isAdvisory(doc.jobs[id]) && /^\$\{\{\s*github\.token\s*\}\}$/.test(String(value).trim());
}

/**
 * No credential expression anywhere in the PARSED document — env, with:, if:, run, a job's `name`, every value — beyond the
 * advisory job's `GH_TOKEN`. The job log is public and the console is not masked, so a credential that reaches repository
 * code reaches the log; the gate holds the cause (nothing is handed over) and not the symptom.
 */
function credentialExpressionViolations(doc) {
  const v = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      for (const expr of expressionsIn(node, path.at(-1))) {
        const what = credentialIn(expr);
        if (what && !isAdvisoryGhToken(doc, path, node)) {
          v.push(`${path.join('.')}: \`${expr.trim()}\` reads ${what}; nothing in this file may hand a credential to a step (only github.token as the advisory job's GH_TOKEN)`);
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, [...path, i]));
    } else if (node && typeof node === 'object') {
      for (const [k, x] of Object.entries(node)) walk(x, [...path, k]);
    }
  };
  walk(doc, []);
  return v;
}

/**
 * The documents the two rules above are NOT run over, each with the reason and a check that the reason still holds. A
 * file added to this table is a decision about a credential reaching a job, so it states why, and the reason is a
 * property of the file that is read back — a reason nobody re-reads is how a "tag-only" workflow gains a pull_request.
 */
const CREDENTIAL_ALLOWLIST = {
  '.github/workflows/publish.yml': {
    reason: 'runs on a version tag or a manual dispatch only, and writes the image and the release, so it holds the registry secrets and a write token on purpose',
    holds(doc) {
      const on = doc.on ?? doc[true];
      const events = [...triggersOf(doc)];
      const v = events.filter((e) => !['push', 'workflow_dispatch'].includes(e)).map((e) => `the \`${e}\` trigger can run it for code nobody released`);
      if (events.includes('push') && (!on.push?.tags?.length || on.push.branches)) v.push('its push trigger is not tags-only');
      return v;
    },
  },
  '.github/workflows/cla.yml': {
    reason: 'runs on pull_request_target with the base repository secrets and executes no repository code: it has no checkout and no local action',
    holds: (doc) => stepEntries(doc)
      .filter(({ step }) => usesOf(step)?.action === CHECKOUT || (typeof step.uses === 'string' && step.uses.startsWith('./')))
      .map(({ where }) => `${where} brings repository code into a job that holds the base repository's secrets`),
  },
};

/** The floor on checkouts the real scan must meet: ci.yml's jobs and image-pin-check's, at the least. */
const CHECKOUT_FLOOR = 8;

/** Every tracked document the rules read, `[{ file, doc }]`: workflows, then local actions. */
const trackedDocuments = () => [
  ...workflowFiles().map((file) => ({ file, doc: loadWorkflow(file) })),
  ...actionFiles().map((file) => ({ file, doc: loadAction(file) })),
];

/** Files that are neither run through the rules nor on the allowlist: a document the rules never read. */
const unaccountedFor = (files, scanned, allowlist) => files.filter((f) => !scanned.includes(f) && !(f in allowlist));

// ───────────────────────────────────────── preflight runs what CI runs ─────────────────────────────────────────

/** The client commands in a script: its simple commands that the finder reads as the client's unit-test run. */
const clientCommandsIn = (script) => shellCommands(script).filter((c) => CLIENT_RUN.test(c));

/** One command, whitespace collapsed: two spellings of the same line are one command. */
const normalised = (c) => c.trim().replace(/\s+/g, ' ');

/**
 * The client commands a source file hands to a call as a string literal (`run('npm run test:client')`). A literal that is
 * not an argument (a gate's name in an object, a heading) is not a command, and a comment is not read at all.
 */
function clientCommandsInSource(file, text) {
  const found = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      for (const a of n.arguments) {
        if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) found.push(...clientCommandsIn(a.text));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(parseSource(file, text));
  return found;
}

/**
 * The local pre-push run must run the client's tests the way CI does, or a green preflight says nothing about the run CI
 * will make (and its report, the one `test-times --record` reads, is a different report): `npm run test:client` runs a
 * different command from the workflow's, which names the reporters and the output file. One command is found on each side,
 * by the same finder, and the two are equal.
 */
function preflightClientParityViolations(doc, preflightText, file = 'scripts/preflight.mjs') {
  const job = doc.jobs?.['client-tests'];
  if (!job) return ['no client-tests job'];
  const inCi = stepsOf(job).flatMap((s) => clientCommandsIn(shellOf(s)));
  const inPreflight = clientCommandsInSource(file, preflightText);
  const v = [];
  if (inCi.length !== 1) v.push(`ci.yml's client-tests job runs the client's unit tests ${inCi.length} time(s); exactly one command`);
  if (inPreflight.length !== 1) {
    v.push(`${file} hands ${inPreflight.length} client unit-test command(s) to a call (${inPreflight.map((c) => `\`${c}\``).join('; ') || 'none'}); exactly one, as one string literal`);
  }
  if (inCi.length === 1 && inPreflight.length === 1 && normalised(inCi[0]) !== normalised(inPreflight[0])) {
    v.push(`preflight runs \`${normalised(inPreflight[0])}\` but ci.yml runs \`${normalised(inCi[0])}\`: run the same command, so the local run makes the report CI makes`);
  }
  return v;
}

// ───────────────────────────────────────── the full run: a caller of ci.yml ─────────────────────────────────────────

/** A workflow's `on:` value, whichever way the parser keyed it (`on` is a string key in YAML 1.2 and `true` in 1.1). */
const onOf = (doc) => doc.on ?? doc[true];

/** The one job of a caller carries these and nothing else of its own; `with` and `secrets` have a rule of their own. */
const CALLER_KEYS = ['name', 'permissions', 'uses'];

/** A permission level's rank, so "more than" and "less than" are comparisons and not string matches. */
const LEVEL = { none: 0, read: 1, write: 2 };
const levelOf = (level) => LEVEL[level] ?? 0;

/**
 * What the jobs of a workflow ask for on their own — `{ permission: highest level any job asks }`, read from the JOB-level
 * `permissions:` mappings. A caller must grant at least this, or GitHub rejects the whole run; it must grant no more, or the
 * called workflow runs with a token wider than any of its jobs wanted. Derived, never listed: the day another job asks for
 * `checks: read` the rule asks the caller for it.
 */
function permissionsAskedBy(doc) {
  const asked = {};
  for (const { job } of jobEntries(doc)) {
    if (!job.permissions || typeof job.permissions !== 'object') continue;
    for (const [k, level] of Object.entries(job.permissions)) {
      if (!(k in asked) || levelOf(level) > levelOf(asked[k])) asked[k] = level;
    }
  }
  return asked;
}

/** Exactly one job, and it only calls `ci.yml`: no other workflow, repository or ref, and nothing a caller job cannot carry. */
function fullRunCallsCiViolations({ fullRun }) {
  const jobs = jobEntries(fullRun);
  if (jobs.length !== 1) return [`${jobs.length} jobs in the full-run workflow; exactly one, the call of ci.yml (any other job is work that runs with no pull request's gate)`];
  const [{ id, job }] = jobs;
  const v = [];
  if (job.uses !== `./${CI_WORKFLOW}`) {
    v.push(`job ${id} uses ${JSON.stringify(job.uses)}; it must be exactly ./${CI_WORKFLOW} — no other workflow, no other repository, no @ref`);
  }
  const extra = Object.keys(job).filter((k) => ![...CALLER_KEYS, 'with', 'secrets'].includes(k));
  if (extra.length) v.push(`job ${id} carries ${extra.join(', ')}; a caller job carries ${CALLER_KEYS.join(', ')} and nothing else`);
  return v;
}

/** The call hands `ci.yml` nothing: ci.yml declares no input and no secret, and a run nobody opened a PR for is given no credential. */
function fullRunHandsNothingViolations({ fullRun }) {
  const jobs = jobEntries(fullRun);
  const v = jobs.length ? [] : ['the full-run workflow has no job: there is no call to read'];
  for (const { id, job } of jobs) {
    for (const key of ['with', 'secrets']) {
      if (key in job) v.push(`job ${id} has \`${key}:\`; ci.yml takes no input and no secret, and a full run is handed nothing`);
    }
  }
  return v;
}

/** One trigger, a push, filtered to exactly the prefix — and the push object holds the filter and nothing that widens or narrows it. */
function fullRunTriggerViolations({ fullRun }) {
  const v = [];
  const events = [...triggersOf(fullRun)];
  if (events.length !== 1 || events[0] !== 'push') v.push(`the full-run triggers are ${events.join(', ') || '(none)'}; exactly push — anything else runs the whole graph for an event nobody asked for`);
  const on = onOf(fullRun);
  const push = on && typeof on === 'object' && !Array.isArray(on) ? on.push : undefined;
  if (push == null || typeof push !== 'object' || Array.isArray(push)) {
    v.push('the push trigger has no object with a `branches` filter: every branch would run the whole graph');
    return v;
  }
  const keys = Object.keys(push).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['branches'])) v.push(`the push object has the keys ${keys.join(', ') || '(none)'}; exactly branches — tags, paths and ignore lists change what the filter admits`);
  const branches = CW.branchesOf(on, 'push');
  const want = `${CW.FULL_RUN_PREFIX}**`;
  if (branches === null) v.push('the push trigger has no branch filter: every branch would run the whole graph');
  else if (branches.length !== 1 || branches[0] !== want) v.push(`the push filter is ${JSON.stringify(branches)}; exactly [${JSON.stringify(want)}]`);
  return v;
}

/** `ci.yml` can be called, and asks its caller for nothing the caller does not pass. */
function ciIsCallableViolations({ ci }) {
  if (!triggersOf(ci).has('workflow_call')) return [`${CI_WORKFLOW} does not declare workflow_call: a job that uses it fails to start`];
  const call = onOf(ci)?.workflow_call;
  const v = [];
  for (const kind of ['inputs', 'secrets']) {
    for (const [name, def] of Object.entries(call?.[kind] ?? {})) {
      if (isTrue(def?.required)) v.push(`workflow_call requires the ${kind.slice(0, -1)} ${name}; the full run passes nothing`);
    }
  }
  return v;
}

/** The full run's check is never named like the merge gate: only the pull request's own job may carry the name the ruleset requires. */
function fullRunNameViolations({ fullRun }) {
  const jobs = jobEntries(fullRun);
  const v = jobs.length ? [] : ['the full-run workflow has no job to name'];
  for (const { id, name } of jobs) {
    if (name === MERGE_GATE_NAME) v.push(`job ${id} is named "${MERGE_GATE_NAME}": its check would carry the name the ruleset requires, and the merge monitor would read it as the gate`);
  }
  return v;
}

/** The caller's token is `contents: read`; its job grants that and exactly what ci.yml's jobs ask for, no more and no less. */
function fullRunPermissionViolations({ fullRun, ci }) {
  const v = [];
  if (JSON.stringify(fullRun.permissions) !== JSON.stringify({ contents: 'read' })) {
    v.push(`top-level permissions are ${JSON.stringify(fullRun.permissions ?? '(none: the repository default)')}; exactly {contents: read}`);
  }
  const asked = permissionsAskedBy(ci);
  if (Object.keys(asked).length < 1) v.push('no job of ci.yml asks for a permission (floor 1): the derivation is broken, or the advisory job lost its `actions: read`');
  const expected = { contents: 'read', ...asked };
  for (const { id, job } of jobEntries(fullRun)) {
    const p = job.permissions ?? fullRun.permissions ?? {};
    if (typeof p !== 'object') { v.push(`${id}: permissions are \`${p}\`; a mapping of what ci.yml's jobs ask for`); continue; }
    for (const [k, level] of Object.entries(p)) {
      if (!(k in expected)) v.push(`${id}: grants ${k}: ${level}, which no job of ci.yml asks for`);
      else if (levelOf(level) > levelOf(expected[k])) v.push(`${id}: grants ${k}: ${level}; the called jobs ask ${expected[k]} at most`);
    }
    for (const [k, level] of Object.entries(expected)) {
      if (levelOf(p[k]) < levelOf(level)) v.push(`${id}: does not grant ${k}: ${level}, which a called job asks for — GitHub rejects the whole run when a called job asks for more than its caller grants`);
    }
  }
  return v;
}

/** A newer full-run push supersedes the older one of its ref, in a group of its own that never queues behind or cancels ci.yml's. */
function fullRunConcurrencyViolations({ fullRun, ci }) {
  const c = fullRun.concurrency;
  if (!c || typeof c !== 'object') return ['no top-level concurrency: every push of the full-run ref stacks another full run'];
  const v = [];
  if (!isTrue(c['cancel-in-progress'])) v.push(`cancel-in-progress is \`${c['cancel-in-progress']}\`; it must be true, so a newer full-run push supersedes the older run`);
  if (!/github\.ref\b/.test(String(c.group ?? ''))) v.push(`the group \`${c.group}\` is not per ref: one bundle's push would cancel another's`);
  if (c.group != null && expressionOf(c.group) === expressionOf(ci.concurrency?.group)) {
    v.push(`the group \`${c.group}\` is ci.yml's own group: the two would queue behind and cancel each other`);
  }
  return v;
}

// ───────────────────────────────────────── the rules, and how each is held ─────────────────────────────────────────

/**
 * The rules over the PAIR `{ fullRun, ci }` — the caller and the workflow it calls — rather than over one workflow. Kept apart
 * so the loops below can tell which subject a rule is run over; they are rules of the one table all the same, so each carries
 * its breakage rows and none is held only by the real file.
 */
const FULL_RUN_RULES = {
  'full run is one job that calls ci.yml': fullRunCallsCiViolations,
  'full run hands ci.yml nothing': fullRunHandsNothingViolations,
  'full run triggers on a push to its prefix and nothing else': fullRunTriggerViolations,
  'ci.yml can be called by the full run': ciIsCallableViolations,
  'full run is not named like the merge gate': fullRunNameViolations,
  'full run permissions are what ci.yml asks for': fullRunPermissionViolations,
  'full run cancels its older run and shares no group with ci.yml': fullRunConcurrencyViolations,
};

/** What a rule is run over: one workflow, or the pair for a full-run rule. The real pair reads the committed `full-run.yml`. */
const realSubject = (name) => (name in FULL_RUN_RULES ? { fullRun: CW.loadFullRun(), ci: REAL } : REAL);
const goodSubject = (name) => (name in FULL_RUN_RULES ? { fullRun: GOOD_FULL, ci: GOOD } : GOOD);

const RULES = {
  ...FULL_RUN_RULES,
  'checkout credentials': checkoutCredentialViolations,
  'credential expressions': credentialExpressionViolations,
  'results upload names': uploadNameViolations,
  'advisory summary': advisorySummaryViolations,
  'gate evidence': gateEvidenceViolations,
  'client report': clientReportViolations,
  'merge gate': mergeGateViolations,
  'job timeouts': timeoutViolations,
  'artifact uploads': uploadViolations,
  'one suite per results artifact': oneSuitePerResultsArtifactViolations,
  'caches': cacheViolations,
  'runtime token': runtimeTokenViolations,
  'permissions': permissionViolations,
  'concurrency': concurrencyViolations,
  'stack jobs': stackJobViolations,
  'test jobs read history': historyViolations,
  'test jobs build the server': serverBuildViolations,
  'stack jobs start what their suite reaches': stackInstanceViolations,
};

const job = (doc, id) => doc.jobs[id];
const stepWhere = (j, pred) => stepsOf(j).find(pred);

/** The full-run rows mutate the PAIR: `p.fullRun` the caller, `p.ci` the workflow it calls. */
const callJob = (p) => p.fullRun.jobs.full;
const pushOf = (p) => onOf(p.fullRun).push;
const setOn = (workflow, value) => { delete workflow[true]; workflow.on = value; };

/** One deliberate breakage per row: [what is broken, how, the rule that must fire, what its message must say]. */
const BREAKAGES = [
  ['the gate loses `if: always()`', (d) => { delete job(d, 'test').if; }, 'merge gate', /always\(\)/],
  ['the gate gets a matrix', (d) => { job(d, 'test').strategy = { matrix: { os: ['a', 'b'] } }; }, 'merge gate', /matrix/],
  ['a second job is named Build & Test', (d) => { job(d, 'sync').name = 'Build & Test'; }, 'merge gate', /exactly one/],
  ['a job is added that the gate does not wait for', (d) => { d.jobs.extra = clone(job(d, 'sync')); }, 'merge gate', /does not wait for: extra/],
  ['the gate stops waiting for one job', (d) => { job(d, 'test').needs = job(d, 'test').needs.filter((n) => n !== 'sync'); }, 'merge gate', /does not wait for: sync/],
  ['the gate waits for the advisory job', (d) => { job(d, 'test').needs.push('ci-advisory'); }, 'merge gate', /advisory one/],
  ['two jobs are advisory', (d) => { job(d, 'sync')['continue-on-error'] = true; }, 'merge gate', /advisory jobs/],
  ['the verdict checks failure, not success (a skip passes)', (d) => {
    stepsOf(job(d, 'test'))[0].run = ['client-tests', 'prepare', 'standalone', 'integration', 'sync']
      .map((id) => `[ "\${{ needs.${id}.result }}" != failure ] || exit 1`).join('\n');
  }, 'merge gate', /never names `success`/],
  ['the verdict forgets one needed job', (d) => {
    stepsOf(job(d, 'test'))[0].run = stepsOf(job(d, 'test'))[0].run.split('\n').filter((l) => !l.includes('needs.integration.')).join('\n');
  }, 'merge gate', /PASSES when integration is failure/],
  ['the verdict step cannot fail the job', (d) => { stepsOf(job(d, 'test'))[0]['continue-on-error'] = true; }, 'merge gate', /continue-on-error/],
  ['the verdict reads an expression the gate cannot render', (d) => {
    stepsOf(job(d, 'test'))[0].run = 'echo "${{ join(needs.*.result, \',\') }}"; exit 1';
  }, 'merge gate', /cannot render/],
  ['the verdict is read from toJSON(needs) and ignores a skip', (d) => {
    const s = stepsOf(job(d, 'test'))[0];
    s.env = { NEEDS: '${{ toJSON(needs) }}' };
    s.run = 'echo "$NEEDS" | grep -q \'"result": "failure"\' && exit 1; exit 0 # success';
  }, 'merge gate', /PASSES when .* is skipped/],
  ['a job loses timeout-minutes', (d) => { delete job(d, 'sync')['timeout-minutes']; }, 'job timeouts', /sync: timeout-minutes/],
  ['a job gets an expression as its timeout', (d) => { job(d, 'sync')['timeout-minutes'] = '${{ vars.T }}'; }, 'job timeouts', /sync: timeout-minutes/],
  ['a job gets a timeout above the ceiling', (d) => { job(d, 'sync')['timeout-minutes'] = 360; }, 'job timeouts', /sync: timeout-minutes/],
  ['an upload names a sidecar image tar', (d) => {
    stepWhere(job(d, 'prepare'), (s) => s.with?.name?.startsWith('ythril-test-image')).with.path += '\ndoc-office.tar';
  }, 'artifact uploads', /not on the allowlist/],
  ['an upload names the whole workspace', (d) => {
    stepWhere(job(d, 'sync'), (s) => usesOf(s)?.action === 'actions/upload-artifact').with.path = '.';
  }, 'artifact uploads', /not on the allowlist/],
  ['an upload names a path outside the workspace', (d) => {
    stepWhere(job(d, 'sync'), (s) => usesOf(s)?.action === 'actions/upload-artifact').with.path = 'test-results/../../etc';
  }, 'artifact uploads', /not on the allowlist/],
  ['an upload may be empty', (d) => {
    delete stepWhere(job(d, 'sync'), (s) => usesOf(s)?.action === 'actions/upload-artifact').with['if-no-files-found'];
  }, 'artifact uploads', /if-no-files-found/],
  ['an upload has no retention', (d) => {
    delete stepWhere(job(d, 'sync'), (s) => usesOf(s)?.action === 'actions/upload-artifact').with['retention-days'];
  }, 'artifact uploads', /retention-days/],
  ['the image is kept thirty days', (d) => {
    stepWhere(job(d, 'prepare'), (s) => s.with?.name?.startsWith('ythril-test-image')).with['retention-days'] = 30;
  }, 'artifact uploads', /lives one/],
  ['an artifact name ignores the run attempt', (d) => {
    stepWhere(job(d, 'sync'), (s) => usesOf(s)?.action === 'actions/upload-artifact').with.name = 'test-results-sync';
  }, 'artifact uploads', /run_attempt/],
  ['the layer cache is written from pull requests', (d) => {
    const s = stepWhere(job(d, 'prepare'), (x) => /cache-to/.test(x.run ?? ''));
    s.run = s.run.replace(/\$\{\{[^}]*\}\}/, '--cache-to type=gha,mode=max,scope=ythril-test');
  }, 'caches', /cache-to` is not guarded/],
  ['the cache guard admits any push', (d) => {
    const s = stepWhere(job(d, 'prepare'), (x) => /cache-to/.test(x.run ?? ''));
    s.run = s.run.replace("github.event_name == 'push' && github.ref == 'refs/heads/main'", "github.event_name == 'push'");
  }, 'caches', /cache-to` is not guarded/],
  ['the cache guard is an `||` away from every event', (d) => {
    const s = stepWhere(job(d, 'prepare'), (x) => /cache-to/.test(x.run ?? ''));
    s.run = s.run.replace("&& github.ref == 'refs/heads/main' &&", "&& github.ref == 'refs/heads/main' || github.event_name == 'pull_request' &&");
  }, 'caches', /cache-to` is not guarded/],
  ['a cache is saved by the combined action', (d) => {
    job(d, 'sync').steps.unshift({ uses: 'actions/cache@v4', with: { path: '~/.x', key: 'k' } });
  }, 'caches', /saves on every run/],
  ['a cache save is unguarded', (d) => {
    job(d, 'sync').steps.unshift({ uses: 'actions/cache/save@v4', with: { path: '~/.x', key: 'k' } });
  }, 'caches', /not guarded to push-to-main/],
  ['a cache restore falls back to a prefix', (d) => {
    job(d, 'sync').steps.unshift({ uses: 'actions/cache/restore@v4', with: { path: '~/.x', key: 'k', 'restore-keys': 'k-' } });
  }, 'caches', /restore-keys/],
  ['setup-node caches something other than npm', (d) => {
    stepWhere(job(d, 'sync'), (s) => usesOf(s)?.action === 'actions/setup-node').with.cache = 'yarn';
  }, 'caches', /sanctioned/],
  ['the runtime token is exposed in a second job', (d) => {
    job(d, 'sync').steps.splice(1, 0, clone(stepWhere(job(d, 'prepare'), (s) => usesOf(s)?.action === 'crazy-max/ghaction-github-runtime')));
  }, 'runtime token', /exactly one/],
  ['the runtime token moves to another job', (d) => {
    const s = stepWhere(job(d, 'prepare'), (x) => usesOf(x)?.action === 'crazy-max/ghaction-github-runtime');
    job(d, 'prepare').steps = job(d, 'prepare').steps.filter((x) => x !== s);
    job(d, 'sync').steps.splice(1, 0, s);
  }, 'runtime token', /only `prepare` builds/],
  ['the runtime token is pinned to a tag', (d) => {
    stepWhere(job(d, 'prepare'), (s) => usesOf(s)?.action === 'crazy-max/ghaction-github-runtime').uses = 'crazy-max/ghaction-github-runtime@v3';
  }, 'runtime token', /a tag moves/],
  ['the runtime token precedes npm ci', (d) => {
    const steps = job(d, 'prepare').steps;
    const at = steps.findIndex((s) => usesOf(s)?.action === 'crazy-max/ghaction-github-runtime');
    const [tok] = steps.splice(at, 1);
    steps.splice(steps.findIndex(runsNpmCi), 0, tok);
  }, 'runtime token', /before `npm ci`|immediately before/],
  ['a step sits between the runtime token and the build', (d) => {
    const steps = job(d, 'prepare').steps;
    steps.splice(steps.findIndex((s) => usesOf(s)?.action === 'crazy-max/ghaction-github-runtime') + 1, 0, { run: 'echo between' });
  }, 'runtime token', /immediately before/],
  ['top-level permissions widen', (d) => { d.permissions = { contents: 'read', 'pull-requests': 'write' }; }, 'permissions', /exactly/],
  ['top-level permissions are absent', (d) => { delete d.permissions; }, 'permissions', /exactly/],
  ['a stack job takes actions: read', (d) => { job(d, 'sync').permissions = { contents: 'read', actions: 'read' }; }, 'permissions', /actions: read belongs/],
  ['a job takes write-all', (d) => { job(d, 'sync').permissions = 'write-all'; }, 'permissions', /write-all/],
  ['concurrency is absent', (d) => { delete d.concurrency; }, 'concurrency', /no top-level concurrency/],
  ['concurrency is not per ref', (d) => { d.concurrency.group = 'ci'; }, 'concurrency', /not per ref/],
  ['concurrency cancels main pushes too', (d) => { d.concurrency['cancel-in-progress'] = true; }, 'concurrency', /cancels pull-request runs only/],
  ['compose may build', (d) => {
    const s = stepWhere(job(d, 'sync'), (x) => /compose/.test(x.run ?? ''));
    s.run = s.run.replace('--no-build', '');
  }, 'stack jobs', /--no-build/],
  ['compose may pull', (d) => {
    const s = stepWhere(job(d, 'sync'), (x) => /compose/.test(x.run ?? ''));
    s.run = s.run.replace('--pull never', '');
  }, 'stack jobs', /--pull never/],
  ['compose starts before the image exists', (d) => {
    job(d, 'sync').steps = job(d, 'sync').steps.filter((s) => !/docker load/.test(s.run ?? ''));
  }, 'stack jobs', /no step loads/],
  ['the advisory job calls test-times with no command', (d) => {
    const s = stepWhere(job(d, 'ci-advisory'), (x) => /test-times/.test(x.run ?? ''));
    s.run = 'node scripts/test-times.mjs';
  }, 'advisory summary', /with no command/],
  ['the advisory job calls test-times with no command, behind a file test', (d) => {
    const s = stepWhere(job(d, 'ci-advisory'), (x) => /test-times/.test(x.run ?? ''));
    s.run = 'if [ -f scripts/test-times.mjs ]; then node scripts/test-times.mjs; fi';
  }, 'advisory summary', /with no command/],
  ['the advisory job downloads nothing', (d) => {
    job(d, 'ci-advisory').steps = stepsOf(job(d, 'ci-advisory')).filter((s) => usesOf(s)?.action !== 'actions/download-artifact');
  }, 'advisory summary', /downloads no artifacts/],
  ['the advisory download reads every attempt', (d) => {
    stepWhere(job(d, 'ci-advisory'), (s) => usesOf(s)?.action === 'actions/download-artifact').with.pattern = 'test-results-*';
  }, 'advisory summary', /pattern/],
  ['the summary reads another folder', (d) => {
    const s = stepWhere(job(d, 'ci-advisory'), (x) => /test-times/.test(x.run ?? ''));
    s.run = s.run.replace('--results test-results', '--results timings');
  }, 'advisory summary', /not the downloaded folder/],
  ['the summary has no token for the baseline', (d) => {
    delete stepWhere(job(d, 'ci-advisory'), (x) => /test-times/.test(x.run ?? '')).env;
  }, 'advisory summary', /no GH_TOKEN/],
  ['the advisory job has no checkout', (d) => {
    job(d, 'ci-advisory').steps = stepsOf(job(d, 'ci-advisory')).filter((s) => usesOf(s)?.action !== 'actions/checkout');
  }, 'advisory summary', /no checkout/],
  ['the gate stops running executed-tests', (d) => {
    job(d, 'test').steps = stepsOf(job(d, 'test')).filter((s) => !/executed-tests/.test(s.run ?? ''));
  }, 'gate evidence', /0 step\(s\) run scripts\/executed-tests\.mjs/],
  ['the gate stops running unexpected-skips', (d) => {
    job(d, 'test').steps = stepsOf(job(d, 'test')).filter((s) => !/unexpected-skips/.test(s.run ?? ''));
  }, 'gate evidence', /0 step\(s\) run scripts\/unexpected-skips\.mjs/],
  ['the gate runs a check twice', (d) => {
    const s = stepWhere(job(d, 'test'), (x) => /unexpected-skips/.test(x.run ?? ''));
    job(d, 'test').steps.push(clone(s));
  }, 'gate evidence', /2 step\(s\) run scripts\/unexpected-skips\.mjs/],
  ['the gate downloads nothing', (d) => {
    job(d, 'test').steps = stepsOf(job(d, 'test')).filter((s) => usesOf(s)?.action !== 'actions/download-artifact');
  }, 'gate evidence', /downloads no artifacts/],
  ['the download reads every attempt', (d) => {
    stepWhere(job(d, 'test'), (s) => usesOf(s)?.action === 'actions/download-artifact').with.pattern = 'test-results-*';
  }, 'gate evidence', /download pattern/],
  ['the download does not merge', (d) => {
    delete stepWhere(job(d, 'test'), (s) => usesOf(s)?.action === 'actions/download-artifact').with['merge-multiple'];
  }, 'gate evidence', /merge-multiple/],
  ['a check reads another folder', (d) => {
    const s = stepWhere(job(d, 'test'), (x) => /unexpected-skips/.test(x.run ?? ''));
    s.run = s.run.replace('--results test-results', '--results timings');
  }, 'gate evidence', /not the downloaded folder/],
  ['a check cannot fail the gate', (d) => {
    stepWhere(job(d, 'test'), (x) => /unexpected-skips/.test(x.run ?? ''))['continue-on-error'] = true;
  }, 'gate evidence', /continue-on-error/],
  ['a check swallows its failure', (d) => {
    const s = stepWhere(job(d, 'test'), (x) => /executed-tests/.test(x.run ?? ''));
    s.run += ' || true';
  }, 'gate evidence', /\|\| true/],
  ['a check runs even when a needed job failed', (d) => {
    stepWhere(job(d, 'test'), (x) => /executed-tests/.test(x.run ?? '')).if = 'always()';
  }, 'gate evidence', /must not run when a needed job failed/],
  ['the download runs even when a needed job failed', (d) => {
    stepWhere(job(d, 'test'), (s) => usesOf(s)?.action === 'actions/download-artifact').if = '${{ always() }}';
  }, 'gate evidence', /must not run when a needed job failed/],
  ['the gate has no checkout for the checks', (d) => {
    job(d, 'test').steps = stepsOf(job(d, 'test')).filter((s) => usesOf(s)?.action !== 'actions/checkout');
  }, 'gate evidence', /no checkout/],
  ['the gate has no node for the checks', (d) => {
    job(d, 'test').steps = stepsOf(job(d, 'test')).filter((s) => usesOf(s)?.action !== 'actions/setup-node');
  }, 'gate evidence', /no setup-node/],
  ['setup moves in front of the verdict', (d) => {
    const steps = stepsOf(job(d, 'test'));
    const at = steps.findIndex((s) => usesOf(s)?.action === 'actions/checkout');
    job(d, 'test').steps = [steps[at], ...steps.filter((_, i) => i !== at)];
  }, 'gate evidence', /BEFORE the verdict/],
  ['the client\'s unit tests stop writing the json report', (d) => {
    const s = stepWhere(job(d, 'client-tests'), (x) => /npm run test/.test(x.run ?? ''));
    s.run = 'npm run test --workspace=client';
  }, 'client report', /does not write test-results\/client\.json/],
  ['the client\'s flags go through the nested npm run (swallowed, no report)', (d) => {
    const s = stepWhere(job(d, 'client-tests'), (x) => /npm run test/.test(x.run ?? ''));
    s.run = s.run.replace('npm run test --workspace=client', 'npm run test:client');
  }, 'client report', /inner npm swallows them/],
  ['the client\'s json report loses the console', (d) => {
    const s = stepWhere(job(d, 'client-tests'), (x) => /npm run test/.test(x.run ?? ''));
    s.run = s.run.replace('--reporter=default ', '');
  }, 'client report', /console log is gone/],
  ['a results job runs a second suite (its artifact would hold two)', (d) => {
    job(d, 'sync').steps.splice(-2, 0, { name: 'Run the red team too', run: 'npm run test:redteam' });
  }, 'one suite per results artifact', /carries 2 suite runner/],
  ['a results job runs an aggregate of suites', (d) => {
    stepWhere(job(d, 'sync'), (x) => /npm run test:sync/.test(x.run ?? '')).run = 'npm run test:all:core';
  }, 'one suite per results artifact', /runs several suites in one command/],
  ['a results job runs the standalone runner without --only (all of its suites)', (d) => {
    stepWhere(job(d, 'sync'), (x) => /npm run test:sync/.test(x.run ?? '')).run = 'npm run test:standalone';
  }, 'one suite per results artifact', /runs several suites in one command/],
  ['a results job runs a second suite spelled `node --test`', (d) => {
    job(d, 'sync').steps.splice(-2, 0, { name: 'Run a file too', run: 'node --test testing/standalone/some.test.js' });
  }, 'one suite per results artifact', /carries 2 suite runner/],
  ['a results job runs a second suite spelled `node --import x --test`', (d) => {
    job(d, 'sync').steps.splice(-2, 0, { name: 'Run a file too', run: 'node --import ./setup.mjs --test testing/standalone/some.test.js' });
  }, 'one suite per results artifact', /carries 2 suite runner/],
  ['a results job runs a second suite spelled `npm test`', (d) => {
    job(d, 'sync').steps.splice(-2, 0, { name: 'Run the tests too', run: 'npm test' });
  }, 'one suite per results artifact', /carries 2 suite runner/],
  ['a results job runs a second suite spelled `npm t`', (d) => {
    job(d, 'sync').steps.splice(-2, 0, { name: 'Run the tests too', run: 'npm t -- --reporter=dot' });
  }, 'one suite per results artifact', /carries 2 suite runner/],
  ['a results job uploads two results artifacts', (d) => {
    const u = stepWhere(job(d, 'sync'), (x) => usesOf(x)?.action === 'actions/upload-artifact');
    const second = clone(u);
    second.with.name = 'test-results-sync-again-@{{ github.run_attempt }}';
    job(d, 'sync').steps.push(second);
  }, 'one suite per results artifact', /2 results artifacts from one job/],
  ['a test job checks out shallow', (d) => {
    delete stepWhere(job(d, 'sync'), (x) => usesOf(x)?.action === 'actions/checkout').with;
  }, 'test jobs read history', /sync: runs tests from a shallow checkout/],
  ['a test job checks out with a depth of one', (d) => {
    stepWhere(job(d, 'sync'), (x) => usesOf(x)?.action === 'actions/checkout').with = { 'fetch-depth': 1 };
  }, 'test jobs read history', /sync: runs tests from a shallow checkout/],
  ['a stack job runs its suite with no server build', (d) => {
    job(d, 'sync').steps = stepsOf(job(d, 'sync')).filter((x) => !/build:server/.test(shellOf(x)));
  }, 'test jobs build the server', /sync: runs tests that import server\/dist/],
  ['a stack job builds the server only after its suite ran', (d) => {
    const steps = stepsOf(job(d, 'sync'));
    const i = steps.findIndex((x) => /build:server/.test(shellOf(x)));
    const [build] = steps.splice(i, 1);
    steps.push(build);
  }, 'test jobs build the server', /sync: runs tests that import server\/dist/],
  ['a stack job starts fewer instances than its suite reaches', (d) => {
    const s = stepWhere(job(d, 'sync'), (x) => /compose[\s\S]*\bup\b/.test(x.run ?? ''));
    s.run = s.run.replace(/--pull never/, '--pull never ythril-a');
  }, 'stack jobs start what their suite reaches', /sync: npm run test:sync reaches instance\(s\) .*b.* that the job does not start/],
  ['a stack job is added without the flags', (d) => {
    d.jobs.redteam = clone(job(d, 'sync'));
    stepWhere(job(d, 'redteam'), (x) => /compose/.test(x.run ?? '')).run = 'docker compose -f testing/docker-compose.test.yml up -d --wait';
  }, 'stack jobs', /redteam: .*--no-build/],

  ...[
    ['loses its persist-credentials input (the default keeps the token)', (s) => { delete s.with['persist-credentials']; }, /unset/],
    ['has no `with` at all', (s) => { delete s.with; }, /unset/],
    ['sets persist-credentials: true', (s) => { s.with['persist-credentials'] = true; }, /`true`/],
    ['sets persist-credentials to the string true', (s) => { s.with['persist-credentials'] = 'true'; }, /`true`/],
    ['leaves persist-credentials to an expression', (s) => { s.with['persist-credentials'] = '${{ vars.PERSIST }}'; }, /vars\.PERSIST/],
    ['sets persist-credentials to an empty string', (s) => { s.with['persist-credentials'] = ''; }, /persist-credentials/],
  ].map(([what, mutate, expected]) => [`a stack job's checkout ${what}`, (d) => {
    mutate(stepWhere(job(d, 'sync'), (x) => usesOf(x)?.action === 'actions/checkout'));
  }, 'checkout credentials', expected]),
  ['the gate job\'s checkout keeps the token', (d) => {
    delete stepWhere(job(d, 'test'), (x) => usesOf(x)?.action === 'actions/checkout').with;
  }, 'checkout credentials', /test step \d+: actions\/checkout/],
  ['the advisory job\'s checkout keeps the token', (d) => {
    delete stepWhere(job(d, 'ci-advisory'), (x) => usesOf(x)?.action === 'actions/checkout').with;
  }, 'checkout credentials', /ci-advisory step \d+: actions\/checkout/],

  ...[
    ['a secret in a step env', (d) => { job(d, 'sync').steps[0].env = { TOKEN: '${{ secrets.NPM_TOKEN }}' }; }, /secrets/],
    ['a secret read by index', (d) => { job(d, 'sync').steps[0].env = { TOKEN: "${{ secrets['NPM_TOKEN'] }}" }; }, /secrets/],
    ['the workflow token as a secret', (d) => {
      job(d, 'sync').steps[0].with = { ...job(d, 'sync').steps[0].with, token: '${{ secrets.GITHUB_TOKEN }}' };
    }, /secrets/],
    ['the workflow token as github.token in a stack job', (d) => { job(d, 'sync').steps[0].env = { GH_TOKEN: '${{ github.token }}' }; }, /github\.token/],
    ['the workflow token as github[\'token\']', (d) => { job(d, 'sync').steps[0].env = { T: "${{ github['token'] }}" }; }, /github\['token'\]/],
    ['the workflow token as github["token"]', (d) => { job(d, 'sync').steps[0].env = { T: '${{ github["token"] }}' }; }, /github\['token'\]/],
    ['the whole github context', (d) => { job(d, 'sync').steps[0].env = { CTX: '${{ toJSON(github) }}' }; }, /whole github context/],
    ['every secret at once', (d) => { job(d, 'sync').steps[0].env = { CTX: '${{ toJSON(secrets) }}' }; }, /secrets/],
    ['a secret in a condition', (d) => { job(d, 'sync').steps[0].if = "secrets.NPM_TOKEN != ''"; }, /secrets/],
    ['a secret in the script text', (d) => { stepWhere(job(d, 'sync'), (x) => /build:server/.test(x.run ?? '')).run = 'echo ${{ secrets.NPM_TOKEN }} | npm login'; }, /secrets/],
    ['the workflow token in the script text', (d) => { stepWhere(job(d, 'sync'), (x) => /build:server/.test(x.run ?? '')).run = 'echo ${{ github.token }}'; }, /github\.token/],
    ['the workflow token in the advisory job under another name', (d) => {
      stepWhere(job(d, 'ci-advisory'), (x) => x.env?.GH_TOKEN).env.OTHER = '${{ github.token }}';
    }, /github\.token/],
    ['the workflow token in the advisory job\'s own env, not a step\'s', (d) => {
      job(d, 'ci-advisory').env = { GH_TOKEN: '${{ github.token }}' };
    }, /jobs\.ci-advisory\.env\.GH_TOKEN/],
    ['the advisory job\'s token once the job is not advisory', (d) => { delete job(d, 'ci-advisory')['continue-on-error']; }, /github\.token/],
    ['the advisory token in the gate', (d) => { stepsOf(job(d, 'test'))[0].env = { GH_TOKEN: '${{ github.token }}' }; }, /jobs\.test\./],
  ].map(([what, mutate, expected]) => [`a credential: ${what}`, mutate, 'credential expressions', expected]),

  ['an upload is named for the job\'s display name', (d) => {
    stepWhere(job(d, 'sync'), (x) => usesOf(x)?.action === 'actions/upload-artifact').with.name = 'test-results-Sync-${{ github.run_attempt }}';
  }, 'results upload names', /names `Sync`, not `sync`/],
  ['an upload is named for another job', (d) => {
    stepWhere(job(d, 'sync'), (x) => usesOf(x)?.action === 'actions/upload-artifact').with.name = 'test-results-integration-${{ github.run_attempt }}';
  }, 'results upload names', /names `integration`, not `sync`/],
  ['a job is renamed and its upload is not', (d) => {
    d.jobs['sync-2'] = d.jobs.sync;
    delete d.jobs.sync;
    d.jobs.test.needs = d.jobs.test.needs.map((n) => (n === 'sync' ? 'sync-2' : n));
  }, 'results upload names', /sync-2: .*names `sync`, not `sync-2`/],
  ['an upload name has no job segment', (d) => {
    stepWhere(job(d, 'sync'), (x) => usesOf(x)?.action === 'actions/upload-artifact').with.name = 'test-results-${{ github.run_attempt }}';
  }, 'results upload names', /is not test-results-<job id>/],

  // ── the full run: one caller, one call, nothing handed over, one trigger, no second gate ──
  ['the caller gets a second job', (p) => { p.fullRun.jobs.extra = clone(callJob(p)); }, 'full run is one job that calls ci.yml', /2 jobs.*exactly one/],
  ['the caller has no job at all', (p) => { p.fullRun.jobs = {}; }, 'full run is one job that calls ci.yml', /0 jobs.*exactly one/],
  ['the call names another workflow of this repository', (p) => { callJob(p).uses = './.github/workflows/publish.yml'; }, 'full run is one job that calls ci.yml', /must be exactly/],
  ['the call pins a ref of ci.yml', (p) => { callJob(p).uses = './.github/workflows/ci.yml@main'; }, 'full run is one job that calls ci.yml', /must be exactly/],
  ['the call names a workflow of another repository', (p) => { callJob(p).uses = 'some-org/some-repo/.github/workflows/ci.yml@main'; }, 'full run is one job that calls ci.yml', /must be exactly/],
  ['the call job runs steps of its own', (p) => { callJob(p)['runs-on'] = 'ubuntu-latest'; callJob(p).steps = [{ run: 'echo hi' }]; }, 'full run is one job that calls ci.yml', /carries runs-on, steps/],
  ['the call job is conditional', (p) => { callJob(p).if = "github.actor == 'someone'"; }, 'full run is one job that calls ci.yml', /carries if/],
  ['the call job waits for another job', (p) => { callJob(p).needs = ['other']; }, 'full run is one job that calls ci.yml', /carries needs/],
  ['the call passes an input', (p) => { callJob(p).with = { anything: 'x' }; }, 'full run hands ci.yml nothing', /`with:`/],
  ['the call inherits the secrets', (p) => { callJob(p).secrets = 'inherit'; }, 'full run hands ci.yml nothing', /`secrets:`/],
  ['the call passes one named secret', (p) => { callJob(p).secrets = { TOKEN: '${{ secrets.TOKEN }}' }; }, 'full run hands ci.yml nothing', /`secrets:`/],
  ['the push filter is widened to every branch', (p) => { pushOf(p).branches = ['**']; }, 'full run triggers on a push to its prefix and nothing else', /the push filter is \["\*\*"\]/],
  ['the push filter drops the slash', (p) => { pushOf(p).branches = ['full-run**']; }, 'full run triggers on a push to its prefix and nothing else', /the push filter is/],
  ['the push filter is one level only', (p) => { pushOf(p).branches = ['full-run/*']; }, 'full run triggers on a push to its prefix and nothing else', /the push filter is/],
  ['the push filter adds main', (p) => { pushOf(p).branches.push('main'); }, 'full run triggers on a push to its prefix and nothing else', /the push filter is/],
  ['the push filter is an empty list (not the same as no filter)', (p) => { pushOf(p).branches = []; }, 'full run triggers on a push to its prefix and nothing else', /the push filter is \[\]/],
  ['the push trigger has no filter at all', (p) => { onOf(p.fullRun).push = null; }, 'full run triggers on a push to its prefix and nothing else', /no object with a `branches` filter/],
  ['the push object is empty', (p) => { onOf(p.fullRun).push = {}; }, 'full run triggers on a push to its prefix and nothing else', /no branch filter/],
  ['the push object filters by tag only', (p) => { onOf(p.fullRun).push = { tags: ['v*'] }; }, 'full run triggers on a push to its prefix and nothing else', /no branch filter/],
  ['the push object also takes tags', (p) => { pushOf(p).tags = ['v*']; }, 'full run triggers on a push to its prefix and nothing else', /the push object has the keys branches, tags/],
  ['the push object also takes paths', (p) => { pushOf(p).paths = ['docs/**']; }, 'full run triggers on a push to its prefix and nothing else', /the push object has the keys branches, paths/],
  ['the push object also ignores branches', (p) => { pushOf(p)['branches-ignore'] = ['full-run/skip']; }, 'full run triggers on a push to its prefix and nothing else', /the push object has the keys branches, branches-ignore/],
  ['the trigger is the bare word push', (p) => { setOn(p.fullRun, 'push'); }, 'full run triggers on a push to its prefix and nothing else', /no object with a `branches` filter/],
  ['the triggers are a list of push', (p) => { setOn(p.fullRun, ['push']); }, 'full run triggers on a push to its prefix and nothing else', /no object with a `branches` filter/],
  ['a pull_request trigger is added', (p) => { onOf(p.fullRun).pull_request = { branches: ['main'] }; }, 'full run triggers on a push to its prefix and nothing else', /triggers are push, pull_request; exactly push/],
  ['a manual dispatch is added', (p) => { onOf(p.fullRun).workflow_dispatch = null; }, 'full run triggers on a push to its prefix and nothing else', /triggers are push, workflow_dispatch; exactly push/],
  ['a schedule is added', (p) => { onOf(p.fullRun).schedule = [{ cron: '0 3 * * *' }]; }, 'full run triggers on a push to its prefix and nothing else', /triggers are push, schedule; exactly push/],
  ['the only trigger is not a push', (p) => { setOn(p.fullRun, { workflow_dispatch: null }); }, 'full run triggers on a push to its prefix and nothing else', /triggers are workflow_dispatch; exactly push/],
  ['ci.yml stops declaring workflow_call', (p) => { delete onOf(p.ci).workflow_call; }, 'ci.yml can be called by the full run', /does not declare workflow_call/],
  ['ci.yml\'s triggers become a plain list without workflow_call', (p) => { setOn(p.ci, ['pull_request', 'push']); }, 'ci.yml can be called by the full run', /does not declare workflow_call/],
  ['workflow_call requires an input the caller does not pass', (p) => { onOf(p.ci).workflow_call = { inputs: { ref: { type: 'string', required: true } } }; }, 'ci.yml can be called by the full run', /requires the input ref/],
  ['workflow_call requires a secret the caller does not pass', (p) => { onOf(p.ci).workflow_call = { secrets: { TOKEN: { required: true } } }; }, 'ci.yml can be called by the full run', /requires the secret TOKEN/],
  ['the caller job is named Build & Test', (p) => { callJob(p).name = 'Build & Test'; }, 'full run is not named like the merge gate', /named "Build & Test"/],
  ['the caller job has no name and is called by the gate\'s name', (p) => {
    delete callJob(p).name;
    p.fullRun.jobs['Build & Test'] = callJob(p);
    delete p.fullRun.jobs.full;
  }, 'full run is not named like the merge gate', /named "Build & Test"/],
  ['the caller\'s top-level permissions widen', (p) => { p.fullRun.permissions = { contents: 'read', 'pull-requests': 'write' }; }, 'full run permissions are what ci.yml asks for', /top-level permissions are .*exactly/],
  ['the caller\'s top-level permissions are absent', (p) => { delete p.fullRun.permissions; }, 'full run permissions are what ci.yml asks for', /top-level permissions are .*exactly/],
  ['the caller\'s top-level permissions are write', (p) => { p.fullRun.permissions = { contents: 'write' }; }, 'full run permissions are what ci.yml asks for', /top-level permissions are .*exactly/],
  ['the call job grants nothing of its own (it inherits contents: read, so the advisory job\'s actions: read is refused)', (p) => { delete callJob(p).permissions; }, 'full run permissions are what ci.yml asks for', /does not grant actions: read/],
  ['the call job drops actions: read', (p) => { callJob(p).permissions = { contents: 'read' }; }, 'full run permissions are what ci.yml asks for', /does not grant actions: read/],
  ['the call job drops contents: read', (p) => { callJob(p).permissions = { actions: 'read' }; }, 'full run permissions are what ci.yml asks for', /does not grant contents: read/],
  ['the call job grants a write ci.yml\'s jobs do not ask for', (p) => { callJob(p).permissions['pull-requests'] = 'write'; }, 'full run permissions are what ci.yml asks for', /grants pull-requests: write, which no job of ci\.yml asks for/],
  ['the call job grants more of a permission than the jobs ask', (p) => { callJob(p).permissions.actions = 'write'; }, 'full run permissions are what ci.yml asks for', /grants actions: write; the called jobs ask read at most/],
  ['the call job takes write-all', (p) => { callJob(p).permissions = 'write-all'; }, 'full run permissions are what ci.yml asks for', /write-all/],
  ['a job of ci.yml starts asking for another permission (the derivation reads ci.yml)', (p) => { job(p.ci, 'sync').permissions = { contents: 'read', checks: 'read' }; }, 'full run permissions are what ci.yml asks for', /does not grant checks: read/],
  ['no job of ci.yml asks for any permission (the derived set is empty)', (p) => { delete job(p.ci, 'ci-advisory').permissions; }, 'full run permissions are what ci.yml asks for', /floor 1/],
  ['the caller has no concurrency', (p) => { delete p.fullRun.concurrency; }, 'full run cancels its older run and shares no group with ci.yml', /no top-level concurrency/],
  ['the caller does not cancel', (p) => { p.fullRun.concurrency['cancel-in-progress'] = false; }, 'full run cancels its older run and shares no group with ci.yml', /cancel-in-progress is `false`/],
  ['the caller leaves cancel-in-progress out', (p) => { delete p.fullRun.concurrency['cancel-in-progress']; }, 'full run cancels its older run and shares no group with ci.yml', /cancel-in-progress is/],
  ['the caller cancels by ci.yml\'s expression (a push never cancels)', (p) => { p.fullRun.concurrency['cancel-in-progress'] = "${{ github.event_name == 'pull_request' }}"; }, 'full run cancels its older run and shares no group with ci.yml', /cancel-in-progress is/],
  ['the caller\'s group is ci.yml\'s', (p) => { p.fullRun.concurrency.group = p.ci.concurrency.group; }, 'full run cancels its older run and shares no group with ci.yml', /ci\.yml's own group/],
  ['the caller\'s group is not per ref', (p) => { p.fullRun.concurrency.group = 'full-run'; }, 'full run cancels its older run and shares no group with ci.yml', /not per ref/],
];

describe('ci.yml — the rules, held against the real workflow', () => {
  it('the workflow parses to enough jobs for the rules to mean anything', () => {
    assert.ok(jobEntries(REAL).length >= 1, 'ci.yml has no jobs');
    assert.ok(jobEntries(GOOD).length >= NEEDED_FLOOR + 2, 'the conforming fixture lost jobs: the rules below run over too little');
  });

  for (const [name, rule] of Object.entries(RULES)) {
    it(`${name}`, () => {
      const found = rule(realSubject(name));
      assert.equal(found.length, 0, `the committed workflows break the ${name} rule:\n  ${found.join('\n  ')}`);
    });
  }

  it('the client job writes the file the skips check reads, and the gate installs nothing the checks do not need', async () => {
    const { CLIENT_RESULTS } = await import('../../scripts/unexpected-skips.mjs');
    assert.equal(`test-results/${CLIENT_RESULTS}`, CLIENT_REPORT, 'ci.yml and scripts/unexpected-skips.mjs name different client report files');
    const gate = jobEntries(REAL).find((j) => j.name === MERGE_GATE_NAME);
    assert.ok(!stepsOf(gate.job).some(runsNpmCi), 'the gate job runs npm ci; the checks import only node built-ins (held by unexpected-skips-fail-the-ci-gate), so it is an install for nothing');
  });

  it('the gate is a job of its own that nothing else waits for (a gate in the middle is not a gate)', () => {
    const gate = jobEntries(REAL).find((j) => j.name === MERGE_GATE_NAME);
    assert.ok(gate, `no job is named "${MERGE_GATE_NAME}"`);
    const waitedFor = jobEntries(REAL).filter((j) => j !== gate && transitiveNeeds(REAL, j.id).has(gate.id)).map((j) => j.id);
    assert.deepEqual(waitedFor, [], 'jobs wait for the gate, so it is not the last thing that runs');
  });
});

describe('ci.yml — the rules, held against a conforming miniature and against each breakage of it', () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(`the conforming shape passes: ${name}`, () => {
      assert.deepEqual(rule(goodSubject(name)), []);
    });
  }

  it('every rule has at least one breakage that fires it (no rule is held only by the real file)', () => {
    for (const name of Object.keys(RULES)) {
      assert.ok(BREAKAGES.some((b) => b[2] === name), `no breakage row for the ${name} rule`);
    }
    assert.ok(BREAKAGES.length >= 40, `the breakage table shrank to ${BREAKAGES.length} rows`);
  });

  for (const [what, mutate, rule, expected] of BREAKAGES) {
    it(`${rule}: ${what}`, () => {
      const doc = clone(goodSubject(rule));
      mutate(doc);
      const found = RULES[rule](doc);
      assert.ok(found.some((m) => expected.test(m)),
        `the ${rule} rule did not fire on "${what}" (wanted ${expected}); it returned ${JSON.stringify(found)}`);
    });
  }
});

describe('ci.yml — which package.json test scripts are aggregates of suites (derived from the script body, not from a name)', () => {
  const scripts = {
    'test:up': 'docker compose up -d && node testing/_init/reset-test-configs.mjs && node testing/sync/setup.js',
    'test:one': 'node testing/_init/run-suite.mjs integration',
    'test:chain-and': 'node --test a.test.js && node --test b.test.js',
    'test:chain-semi': 'npm run test:one; npm run test:two',
    'test:chain-mixed': 'npm run test:one && node testing/_init/run-suite.mjs sync',
    'test:single-then-prune': 'npm run test:one && docker image prune -f',
    'test:alias': 'npm run test:chain-and',
    'test:standalone-all': 'node testing/_init/run-standalone.mjs',
    'test:standalone-some': 'node testing/_init/run-standalone.mjs --only=pure',
    'build': 'tsc && node --test x.js && node --test y.js',
  };

  it('a `test*` script that chains two suite runners with `&&` or `;` is an aggregate, whatever the runners are spelled', () => {
    const found = aggregateTestScripts(scripts);
    for (const name of ['test:chain-and', 'test:chain-semi', 'test:chain-mixed']) assert.ok(found.includes(name), `${name} chains two suites and is not an aggregate`);
  });

  it('one runner beside setup or a prune is not an aggregate; a script that is not a test script is not read', () => {
    const found = aggregateTestScripts(scripts);
    for (const name of ['test:up', 'test:one', 'test:single-then-prune', 'test:standalone-some']) assert.ok(!found.includes(name), `${name} runs one suite and was called an aggregate`);
    assert.ok(!found.includes('build'), 'a script that does not start with test was read');
  });

  it('an alias of an aggregate is one, and the standalone runner without --only is one', () => {
    const found = aggregateTestScripts(scripts);
    assert.ok(found.includes('test:alias'));
    assert.ok(found.includes('test:standalone-all'));
  });

  it('a results job that runs a chained script is refused', () => {
    const d = clone(GOOD);
    stepWhere(job(d, 'sync'), (x) => /npm run test:sync/.test(x.run ?? '')).run = 'npm run test:chain-and';
    const found = oneSuitePerResultsArtifactViolations(d, scripts);
    assert.ok(found.some((m) => /runs several suites in one command/.test(m)), JSON.stringify(found));
  });
});

describe('ci.yml — other ways of writing the same rule are accepted, so the gate holds the property and not the spelling', () => {
  const MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  const buildStep = (d) => stepWhere(job(d, 'prepare'), (x) => /cache-to/.test(x.run ?? ''));

  it('a cache-to under a condition on the STEP, written as a literal', () => {
    const d = clone(GOOD);
    const s = buildStep(d);
    s.run = s.run.replace(/\$\{\{[^}]*\}\}/, '--cache-to type=gha,mode=max,scope=ythril-test');
    s.if = MAIN_PUSH;
    assert.deepEqual(cacheViolations(d), []);
  });

  it('a cache-to input of build-push-action, guarded in its own expression; unguarded it is refused', () => {
    const d = clone(GOOD);
    const steps = job(d, 'prepare').steps;
    steps.splice(steps.indexOf(buildStep(d)), 1, {
      uses: 'docker/build-push-action@v6',
      with: { context: '.', 'cache-from': 'type=gha,scope=ythril-test', 'cache-to': `\${{ ${MAIN_PUSH} && 'type=gha,mode=max,scope=ythril-test' || '' }}` },
    });
    assert.deepEqual(cacheViolations(d), []);
    assert.deepEqual(runtimeTokenViolations(d), [], 'build-push-action is a buildx build for the runtime-token rule');
    stepWhere(job(d, 'prepare'), (x) => x.uses?.startsWith('docker/build-push-action')).with['cache-to'] = 'type=gha,mode=max,scope=ythril-test';
    assert.ok(cacheViolations(d).some((m) => /cache-to` is not guarded/.test(m)));
  });

  it('a cache-to under a condition on the JOB', () => {
    const d = clone(GOOD);
    const s = buildStep(d);
    s.run = s.run.replace(/\$\{\{[^}]*\}\}/, '--cache-to type=gha,mode=max,scope=ythril-test');
    job(d, 'prepare').if = MAIN_PUSH;
    assert.deepEqual(cacheViolations(d), []);
  });

  it('an advisory job is one whose every step is continue-on-error, as well as one that says so on the job', () => {
    const d = clone(GOOD);
    delete job(d, 'ci-advisory')['continue-on-error'];
    for (const s of job(d, 'ci-advisory').steps) s['continue-on-error'] = true;
    assert.deepEqual(mergeGateViolations(d), []);
    assert.deepEqual(permissionViolations(d), []);
  });

  it('a flag is ON when it is the boolean OR the string `true` — one reading for every rule, so none calls a quoted flag off', () => {
    assert.equal(isTrue(true), true);
    assert.equal(isTrue('true'), true);
    for (const off of [false, 'false', undefined, null, 1, 'True', '', 'yes']) assert.equal(isTrue(off), false, `${JSON.stringify(off)} is not on`);
    // The gate step's `continue-on-error: 'true'` is the case the inline `=== true` could not see.
    const d = clone(GOOD);
    const gate = jobEntries(d).find((j) => j.name === MERGE_GATE_NAME);
    assert.ok(gate, 'the merge gate job was not found in the conforming miniature');
    stepsOf(gate.job)[0]['continue-on-error'] = 'true';
    assert.ok(mergeGateViolations(d).some((m) => /continue-on-error/.test(m)), "a step with continue-on-error: 'true' still cannot be allowed on the gate");
  });
});

// ───────────────────────────────────────── every tracked workflow and composite action ─────────────────────────────────────────

describe('every tracked workflow and composite action — no credential reaches repository code', () => {
  /** The documents the rules run over: every tracked one the allowlist does not name. */
  const covered = () => trackedDocuments().filter(({ file }) => !(file in CREDENTIAL_ALLOWLIST));

  it('derives the documents from git: workflows and local actions, ci.yml among them', () => {
    const files = trackedDocuments().map((d) => d.file);
    assert.ok(files.includes('.github/workflows/ci.yml'), 'ci.yml is not among the tracked documents');
    assert.ok(files.some((f) => f.startsWith('.github/actions/')), 'no local action was read: a composite action is a place a checkout or a credential hides');
    assert.ok(files.length >= 4, `only ${files.length} document(s) read: the derivation is broken`);
  });

  it('every checkout of a covered document sets persist-credentials: false', () => {
    const found = covered().flatMap(({ file, doc }) => checkoutCredentialViolations(doc).map((m) => `${file}: ${m}`));
    assert.deepEqual(found, [], `a checkout that keeps its token leaves it on disk for the tests and every dependency they import:\n  ${found.join('\n  ')}`);
  });

  it('no covered document hands a credential to a step, beyond the advisory job\'s GH_TOKEN', () => {
    const found = covered().flatMap(({ file, doc }) => credentialExpressionViolations(doc).map((m) => `${file}: ${m}`));
    assert.deepEqual(found, [], `the job log is public and not masked:\n  ${found.join('\n  ')}`);
  });

  it('the scan sees enough checkouts for "every checkout" to mean something', () => {
    const seen = covered().reduce((n, { doc }) => n + stepEntries(doc).filter(({ step }) => usesOf(step)?.action === CHECKOUT).length, 0);
    assert.ok(seen >= CHECKOUT_FLOOR, `only ${seen} checkout(s) scanned (floor ${CHECKOUT_FLOOR}): the derivation of the documents or of their steps is broken`);
  });

  it('every tracked document is covered by the rules or on the allowlist, and the allowlist names only tracked files', () => {
    const files = trackedDocuments().map((d) => d.file);
    const scanned = covered().map((d) => d.file);
    assert.deepEqual(unaccountedFor(files, scanned, CREDENTIAL_ALLOWLIST), [], 'a document the rules never read');
    assert.deepEqual(Object.keys(CREDENTIAL_ALLOWLIST).filter((f) => !files.includes(f)), [], 'an allowlist entry names a file that is not tracked: remove it, or it excuses a file that returns');
  });

  it('each allowlist entry states its reason, and the reason still holds of the file', () => {
    for (const [file, { reason, holds }] of Object.entries(CREDENTIAL_ALLOWLIST)) {
      assert.ok(reason.split(/\s+/).length >= 8, `${file}: the reason is a label, not a reason`);
      const broken = holds(loadWorkflow(file));
      assert.deepEqual(broken, [], `${file} is allowed because: ${reason}. It no longer holds:\n  ${broken.join('\n  ')}`);
    }
  });
});

describe('the credential rules, held against their own truth tables', () => {
  it('names a credential in every spelling, and none in an expression that only reads the run', () => {
    for (const expr of [
      'secrets.NPM_TOKEN', " secrets['NPM_TOKEN'] ", 'secrets', 'toJSON(secrets)', 'github.token', 'github . token', "github['token']", 'github["token"]',
      'toJSON(github)', "format('{0}', github)", "github.event_name == 'push' && github.token", "inputs.x || secrets.GITHUB_TOKEN",
    ]) assert.ok(credentialIn(expr), `\`${expr}\` holds a credential and was not found`);
    for (const expr of [
      'github.event_name', "github.event_name == 'push' && github.ref == 'refs/heads/main'", 'github.run_attempt', 'github.actor', 'github.token_name',
      'needs.sync.result', 'steps.meta.outputs.tags', "contains(github.event.comment.body, 'secrets')", "github['ref']", 'vars.TOKEN', 'env.GH_TOKEN', 'matrix.os',
    ]) assert.equal(credentialIn(expr), null, `\`${expr}\` names no credential and was refused`);
  });

  it('reads persist-credentials as off only when it is a literal false', () => {
    const checkout = (w) => ({ uses: 'actions/checkout@v4', ...(w === undefined ? {} : { with: w }) });
    for (const [what, step, persists] of [
      ['absent', checkout(), true], ['no value', checkout({ 'fetch-depth': 0 }), true], ['true', checkout({ 'persist-credentials': true }), true],
      ["'true'", checkout({ 'persist-credentials': 'true' }), true], ["'TRUE'", checkout({ 'persist-credentials': 'TRUE' }), true],
      ['an expression', checkout({ 'persist-credentials': '${{ vars.P }}' }), true], ['empty', checkout({ 'persist-credentials': '' }), true],
      ['null', checkout({ 'persist-credentials': null }), true],
      ['false', checkout({ 'persist-credentials': false }), false], ["'false'", checkout({ 'persist-credentials': 'false' }), false],
      ["'False'", checkout({ 'persist-credentials': 'False' }), false],
    ]) assert.equal(persistsCredentials(step), persists, `persist-credentials ${what}`);
  });

  it('reads a composite action as it reads a workflow: a checkout and a credential inside it are found', () => {
    const action = (steps) => parseAction(`name: x\nruns:\n  using: composite\n  steps:\n${steps}\n`, 'a synthetic action');
    const clean = action("    - uses: actions/checkout@v4\n      with:\n        persist-credentials: false\n    - shell: bash\n      run: echo hi");
    assert.deepEqual([...checkoutCredentialViolations(clean), ...credentialExpressionViolations(clean)], []);
    const leaky = action("    - uses: actions/checkout@v4\n    - shell: bash\n      run: echo ${{ github.token }}\n      env:\n        T: ${{ secrets.X }}");
    assert.equal(checkoutCredentialViolations(leaky).length, 1);
    assert.equal(credentialExpressionViolations(leaky).length, 2);
  });

  it('a document the rules neither read nor the allowlist names is found; one of either is not', () => {
    const allow = { 'a.yml': {} };
    assert.deepEqual(unaccountedFor(['a.yml', 'b.yml', 'c.yml'], ['b.yml'], allow), ['c.yml']);
    assert.deepEqual(unaccountedFor(['a.yml', 'b.yml'], ['b.yml'], allow), []);
    assert.deepEqual(unaccountedFor([], [], allow), []);
  });

  it('an allowlist reason that stopped being true is found, and one that holds is not', () => {
    const wf = (text) => parseWorkflow(text, 'a synthetic workflow');
    const job = '\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo hi\n';
    const publish = CREDENTIAL_ALLOWLIST['.github/workflows/publish.yml'].holds;
    assert.deepEqual(publish(wf("on:\n  push:\n    tags: ['v*']\n  workflow_dispatch:" + job)), []);
    assert.ok(publish(wf('on:\n  pull_request:' + job)).some((m) => /pull_request/.test(m)), 'a pull_request trigger on the release workflow was not found');
    assert.ok(publish(wf("on:\n  push:\n    branches: [main]" + job)).some((m) => /tags-only/.test(m)), 'a branch push on the release workflow was not found');
    assert.ok(publish(wf("on:\n  pull_request_target:" + job)).length > 0);
    const cla = CREDENTIAL_ALLOWLIST['.github/workflows/cla.yml'].holds;
    assert.deepEqual(cla(wf('on:\n  pull_request_target:' + job)), []);
    assert.equal(cla(wf('on:\n  pull_request_target:' + job.replace('- run: echo hi', '- uses: actions/checkout@v4'))).length, 1, 'a checkout in the secret-holding workflow was not found');
    assert.equal(cla(wf('on:\n  pull_request_target:' + job.replace('- run: echo hi', '- uses: ./.github/actions/x'))).length, 1, 'a local action in the secret-holding workflow was not found');
  });
});

// ───────────────────────────────────────── preflight runs what CI runs ─────────────────────────────────────────

describe('preflight runs the client\'s unit tests the way ci.yml does', () => {
  const REAL_PREFLIGHT = readFileSync(join(REPO_ROOT, 'scripts/preflight.mjs'), 'utf8');
  const parity = (doc, text) => preflightClientParityViolations(doc, text);
  const withCommand = (command) => GOOD_PREFLIGHT.replace(CLIENT_COMMAND, command);

  it('the real preflight and the real ci.yml run one and the same client command', () => {
    const found = parity(REAL, REAL_PREFLIGHT);
    assert.deepEqual(found, [], `preflight and ci.yml disagree about the client run:\n  ${found.join('\n  ')}`);
  });

  it('the conforming miniatures agree', () => {
    assert.deepEqual(parity(GOOD, GOOD_PREFLIGHT), []);
  });

  for (const [what, make, expected] of [
    ['preflight runs the plain npm script', (d, p) => [d, withCommand('npm run test:client')], /preflight runs `npm run test:client` but ci\.yml runs/],
    ['preflight drops the json reporter', (d, p) => [d, withCommand(CLIENT_COMMAND.replace(' --reporter=json', ''))], /but ci\.yml runs/],
    ['preflight points the report elsewhere', (d, p) => [d, withCommand(CLIENT_COMMAND.replace('../test-results/client.json', '../client.json'))], /but ci\.yml runs/],
    ['ci.yml changes a flag and preflight does not', (d, p) => {
      const s = stepWhere(job(d, 'client-tests'), (x) => /npm run test/.test(x.run ?? ''));
      s.run = s.run.replace('--reporter=default', '--reporter=verbose');
      return [d, p];
    }, /but ci\.yml runs/],
    ['preflight runs no client command', (d, p) => [d, p.replace(`run('${CLIENT_COMMAND}')`, "run('echo skipped')")], /hands 0 client unit-test command/],
    ['preflight runs the client twice', (d, p) => [d, `${p}\ntry { run('npm run test:client'); } catch {}\n`], /hands 2 client unit-test command/],
    ['preflight builds the command with a substitution, which no one reads', (d, p) => [d, p.replace(`run('${CLIENT_COMMAND}')`, 'run(`npm run test --workspace=${"client"}`)')], /hands 0 client unit-test command/],
    ['ci.yml runs the client twice', (d, p) => {
      job(d, 'client-tests').steps.splice(-1, 0, { name: 'Again', run: 'npm run test:client' });
      return [d, p];
    }, /runs the client's unit tests 2 time\(s\)/],
    ['ci.yml has no client job', (d, p) => { delete d.jobs['client-tests']; return [d, p]; }, /no client-tests job/],
  ]) {
    it(`red: ${what}`, () => {
      const [d, p] = make(clone(GOOD), GOOD_PREFLIGHT);
      const found = parity(d, p);
      assert.ok(found.some((m) => expected.test(m)), `wanted ${expected}; the rule returned ${JSON.stringify(found)}`);
    });
  }

  for (const [what, make] of [
    ['a different spacing of the same command', () => withCommand(CLIENT_COMMAND.replace(' -- ', '   --   '))],
    ['the command written as a template without substitution', () => GOOD_PREFLIGHT.replace(`'${CLIENT_COMMAND}'`, `\`${CLIENT_COMMAND}\``)],
    ['a gate named test:client in an object, and a comment naming npm run test:client', () => `${GOOD_PREFLIGHT}\n// npm run test:client is the old spelling\nconst failures = [{ name: 'test:client' }];\n`],
  ]) {
    it(`green: ${what}`, () => assert.deepEqual(parity(GOOD, make()), []));
  }
});

// ───────────────────────────────────────── the full run: what the module names, and what the guide says ─────────────────────────────────────────

describe('the full run — the module names it once, and the rules above read what it names', () => {
  it('names the workflow file and the ref prefix', () => {
    assert.equal(CW.FULL_RUN_WORKFLOW, '.github/workflows/full-run.yml');
    assert.equal(CW.FULL_RUN_PREFIX, 'full-run/');
  });

  it('the workflow is a tracked file, and loadFullRun reads exactly it', () => {
    assert.ok(workflowFiles().includes(CW.FULL_RUN_WORKFLOW), `${CW.FULL_RUN_WORKFLOW} is not among the tracked workflows`);
    assert.deepEqual(CW.loadFullRun(), loadWorkflow(CW.FULL_RUN_WORKFLOW));
  });

  it('a root without the workflow is refused, never read as a workflow that runs nothing', () => {
    assert.throws(() => CW.loadFullRun(join(REPO_ROOT, 'docs')), /does not exist/);
  });

  it('the caller grants what ci.yml\'s jobs ask for, so a job of ci.yml that asks for more is granted by a caller that follows it (the rule is derived, not pinned)', () => {
    const pair = clone({ fullRun: GOOD_FULL, ci: GOOD });
    job(pair.ci, 'sync').permissions = { contents: 'read', checks: 'read' };
    assert.ok(fullRunPermissionViolations(pair).some((m) => /does not grant checks: read/.test(m)), 'a called job asks for checks: read and the caller does not grant it');
    callJob(pair).permissions.checks = 'read';
    assert.deepEqual(fullRunPermissionViolations(pair), []);
  });
});

/**
 * The testing guide's "The CI job graph" section names the full run's check the way GitHub reports it: `<the caller job's name>
 * / <the name the called gate reports>`. Both halves are read from the two workflow files — a sentence that pinned
 * "Full run / Build & Test" would survive a rename of either job and tell an operator to wait for a check that never comes.
 * It lives here, beside the rules over the same two files, so the name is derived by the code that already reads them.
 */
function guideNamesFullRunCheck(guide, fullRun, ci) {
  const callers = jobEntries(fullRun);
  if (callers.length !== 1) return [`${callers.length} jobs in the full-run workflow: its check name is not one name`];
  const gate = jobEntries(ci).find((j) => j.name === MERGE_GATE_NAME);
  if (!gate) return [`no job of ci.yml is named "${MERGE_GATE_NAME}", so the called gate has no name to derive`];
  const want = `${callers[0].name} / ${gate.name}`;
  const heading = /^## The CI job graph\r?$/m.exec(guide);
  if (!heading) return ['the guide has no "The CI job graph" section'];
  const body = guide.slice(heading.index + heading[0].length);
  const next = body.search(/^## /m);
  const section = next < 0 ? body : body.slice(0, next);
  return section.includes(want) ? [] : [`"The CI job graph" does not name the full run's check as \`${want}\``];
}

describe('docs/testing-guide.md names the full run\'s check as the two workflows spell it', () => {
  it('the guide\'s CI job graph section names `<the full-run job\'s name> / <the merge gate\'s name>`', () => {
    const guide = readFileSync(join(REPO_ROOT, 'docs', 'testing-guide.md'), 'utf8');
    const found = guideNamesFullRunCheck(guide, CW.loadFullRun(), REAL);
    assert.deepEqual(found, []);
  });

  const guideWith = (sentence) => `# Guide\n\n## The CI job graph\n\nSome prose.\n\n${sentence}\n\n## What is cached\n\nOther prose.\n`;
  const check = (guide) => guideNamesFullRunCheck(guide, GOOD_FULL, GOOD);

  it('the miniatures derive the name, and a guide that says it passes', () => {
    assert.deepEqual(check(guideWith('The check is `Full run / Build & Test`.')), []);
  });

  for (const [what, guide] of [
    ['the guide names only the merge gate', guideWith('The check is `Build & Test`.')],
    ['the guide names a stale spelling of the full run', guideWith('The check is `Full run / Build and Test`.')],
    ['the guide names another job of the caller', guideWith('The check is `Full / Build & Test`.')],
    ['the name stands in another section only', `${guideWith('Prose only.')}\nThe check is \`Full run / Build & Test\`.\n`],
    ['the section is gone', '# Guide\n\n## What is cached\n\nFull run / Build & Test\n'],
  ]) {
    it(`refuses: ${what}`, () => {
      assert.ok(check(guide).length > 0, `${what} was accepted`);
    });
  }

  it('follows a rename of either workflow (the sentence is derived, not pinned)', () => {
    const renamed = clone(GOOD_FULL);
    callJob({ fullRun: renamed }).name = 'Bundle run';
    assert.ok(guideNamesFullRunCheck(guideWith('The check is `Full run / Build & Test`.'), renamed, GOOD).length > 0);
    assert.deepEqual(guideNamesFullRunCheck(guideWith('The check is `Bundle run / Build & Test`.'), renamed, GOOD), []);
    const gateRenamed = clone(GOOD);
    jobEntries(gateRenamed).find((j) => j.name === MERGE_GATE_NAME).job.name = 'Gate';
    assert.ok(guideNamesFullRunCheck(guideWith('The check is `Full run / Build & Test`.'), GOOD_FULL, gateRenamed).length > 0, 'a gate that is no longer named Build & Test leaves nothing to derive');
  });
});
