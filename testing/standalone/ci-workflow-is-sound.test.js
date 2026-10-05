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
  runsNpmCi, expressionOf, transitiveNeeds, isAdvisory,
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
    if (s['continue-on-error'] === true || s['continue-on-error'] === 'true') {
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

// ───────────────────────────────────────── the rules, and how each is held ─────────────────────────────────────────

const RULES = {
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
});
