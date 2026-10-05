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
 * Run: node --test testing/standalone/ci-workflow-is-sound.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  MERGE_GATE_NAME, loadCi, parseWorkflow, jobEntries, stepsOf, shellOf, usesOf, isCommitPinned, stepsUsing,
  runsNpmCi, expressionOf, transitiveNeeds, isAdvisory, isTrue,
} from '../_shared/ci-workflow.mjs';
import { GOOD_CI } from '../_shared/ci-workflow-fixture.mjs';

const REAL = loadCi();
const GOOD = parseWorkflow(GOOD_CI, 'the conforming fixture');
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
function clientReportViolations(doc) {
  const job = doc.jobs?.['client-tests'];
  if (!job) return ['no client-tests job'];
  const runs = stepsOf(job).filter((s) => /\btest:client\b|\bvitest\b|\bnpm run test\b[^\n]*--workspace[ =]client/.test(shellOf(s)));
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

// ───────────────────────────────────────── the rules, and how each is held ─────────────────────────────────────────

const RULES = {
  'advisory summary': advisorySummaryViolations,
  'gate evidence': gateEvidenceViolations,
  'client report': clientReportViolations,
  'merge gate': mergeGateViolations,
  'job timeouts': timeoutViolations,
  'artifact uploads': uploadViolations,
  'caches': cacheViolations,
  'runtime token': runtimeTokenViolations,
  'permissions': permissionViolations,
  'concurrency': concurrencyViolations,
  'stack jobs': stackJobViolations,
};

const job = (doc, id) => doc.jobs[id];
const stepWhere = (j, pred) => stepsOf(j).find(pred);

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
  ['a stack job is added without the flags', (d) => {
    d.jobs.redteam = clone(job(d, 'sync'));
    stepWhere(job(d, 'redteam'), (x) => /compose/.test(x.run ?? '')).run = 'docker compose -f testing/docker-compose.test.yml up -d --wait';
  }, 'stack jobs', /redteam: .*--no-build/],
];

describe('ci.yml — the rules, held against the real workflow', () => {
  it('the workflow parses to enough jobs for the rules to mean anything', () => {
    assert.ok(jobEntries(REAL).length >= 1, 'ci.yml has no jobs');
    assert.ok(jobEntries(GOOD).length >= NEEDED_FLOOR + 2, 'the conforming fixture lost jobs: the rules below run over too little');
  });

  for (const [name, rule] of Object.entries(RULES)) {
    it(`${name}`, () => {
      const found = rule(REAL);
      assert.equal(found.length, 0, `ci.yml breaks the ${name} rule:\n  ${found.join('\n  ')}`);
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
      assert.deepEqual(rule(GOOD), []);
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
      const doc = clone(GOOD);
      mutate(doc);
      const found = RULES[rule](doc);
      assert.ok(found.some((m) => expected.test(m)),
        `the ${rule} rule did not fire on "${what}" (wanted ${expected}); it returned ${JSON.stringify(found)}`);
    });
  }
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
