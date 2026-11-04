/**
 * A pull request's required check reuses a Full run only when that run tested the same tree, passed, and left every result it
 * is judged by (bundle-244, Q-710).
 *
 * ## What this prevents
 *
 * `Build & Test` of a pull request will skip the suites and read the results of a green Full run of the same tree, instead of
 * running them again. A wrong reuse is code merged that no suite ran, and every way to be wrong looks like a green check: a Full
 * run of another commit, of a tree that main has since moved under, one that is still running or was cancelled, one whose newest
 * attempt is red while an older one is green, one that another repository or a pull request's own push made, results that expired
 * or were never uploaded, a list of runs cut at its first page, a label that said "run everything" ignored. Each is a row here,
 * and each refuses for ITS OWN named reason, so the step summary says which condition failed and a regression that swallows one
 * reason into another is seen.
 *
 * ## The two halves, and why they fail in opposite directions
 *
 * `decideReuse` (the `reuse` job) FAILS OPEN: anything it cannot establish is "no reuse", the whole graph runs, and the only cost
 * is the saving. `verifyReuse` (the merge gate, after the suites were skipped) FAILS CLOSED: by then nothing ran, so a read error,
 * a mismatch, a half-set value or an artifact gone at download exits non-zero with the one remedy, to re-run the whole PR run,
 * which decides again. An error-class refusal (API error, a page short of its total, the deadline, a malformed id) warns; an
 * ordinary one (no run, red, label, tree) is a notice.
 *
 * ## The interface this file states (the implementation follows it)
 *
 * `scripts/full-run-reuse.mjs` imports node built-ins and `scripts/_shared/gh-call.mjs` and nothing else outside the repository.
 *
 *  - `decideReuse(input)` is pure: `input` is `{ event, labels, headSha, treeMatches, repository, runs, jobs, artifacts, expected,
 *    now, deadline }`, the three reads being the GitHub API's own response bodies (`runs`: workflow runs of full-run.yml for
 *    `head_sha`; `jobs`: the jobs of the newest run's latest attempt; `artifacts`: that run's artifacts), each of which may be
 *    `{ error: '<message>' }` for a read that failed. `labels` is the event payload's (`[{ name }]`, or absent). `expected` is the
 *    list of results stems derived from ci.yml (the part of `test-results-<stem>-<attempt>`). It answers
 *    `{ fullRun, reason, level }`: `fullRun` is `"<run id>.<attempt>"` (two decimals) or `''`, `level` is `notice` or `warning`.
 *  - `verifyReuse({ fullRun, headSha, repository, expected, gh })` is async: it resolves `{ runId, attempt }` (or `null` for an empty
 *    `fullRun`, with no call to `gh`) and rejects, with a message naming the remedy, on anything it cannot confirm. `gh` is the
 *    injected caller of `scripts/_shared/gh-call.mjs`: an argument array in, the parsed JSON out.
 *  - `expectedResultsStems(ciText)` reads the stems out of ci.yml's text (no YAML package may be imported in a job that installs
 *    nothing); `FORCE_LABEL` is the label that forces the whole graph.
 *  - `node scripts/full-run-reuse.mjs decide|verify` is the entry: `decide` never exits non-zero and writes `full_run=` to
 *    `$GITHUB_OUTPUT` and its reason to `$GITHUB_STEP_SUMMARY`; `verify` writes `run_id=` and `attempt=` (this run's own when
 *    `FULL_RUN` is empty) and exits non-zero where `verifyReuse` rejects.
 *
 * Open choices the design leaves, stated so the implementation does not guess: how the entry computes `treeMatches` (a `git`
 * comparison of the merge tree with the head SHA's tree); the env names the entry reads (`EVENT`/`GITHUB_EVENT_NAME`, `HEAD_SHA`,
 * `PR_LABELS`, `FULL_RUN`, `GH_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_OUTPUT`,
 * `GITHUB_STEP_SUMMARY`); that the entry wraps a dynamic import so a load error is also "no reuse" (held by the last block of this file, over a scratch copy of the script).
 *
 * The fixtures are the recorded responses for Full run 41895080392 (bundle-236, head 9e1e19ddc), reduced to the fields the
 * decision reads: `_fixtures/full-run-reuse/{runs,jobs,artifacts}.json`.
 *
 * Run: node --test testing/standalone/a-pull-request-reuses-only-a-green-full-run-of-its-own-tree.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { CI_WORKFLOW, loadCi, jobEntries, stepsUsing } from '../_shared/ci-workflow.mjs';

const SCRIPT = 'scripts/full-run-reuse.mjs';
const FIXTURES = join(REPO_ROOT, 'testing', 'standalone', '_fixtures', 'full-run-reuse');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const RUNS = fixture('runs.json');
const JOBS = fixture('jobs.json');
const ARTIFACTS = fixture('artifacts.json');
const clone = (x) => structuredClone(x);

const HEAD = '9e1e19ddc070ccd07f404ed2f9603e0b00c63c3e';
const REPO = 'ythril-network/Ythril';
const RUN_ID = '41895080392';
const GATE = 'Full run / Build & Test';

/** The module under test, loaded when a case runs, so each case is red on its own and not the whole file at once. */
async function reuse() {
  const mod = await import(pathToFileURL(join(REPO_ROOT, SCRIPT)).href);
  for (const name of ['decideReuse', 'verifyReuse', 'expectedResultsStems']) assert.equal(typeof mod[name], 'function', `${SCRIPT} must export ${name}`);
  return mod;
}

/** The results stems ci.yml's test jobs upload, derived from the PARSED workflow: `test-results-<stem>-<attempt>`, a matrix job once per axis value. */
function expectedStems(ci) {
  const stems = [];
  for (const { id, job } of jobEntries(ci)) {
    for (const u of stepsUsing(job, 'actions/upload-artifact')) {
      const m = /^test-results-(.+)-\$\{\{\s*github\.run_attempt\s*\}\}$/.exec(String(u.with?.name ?? ''));
      if (!m) continue;
      const axes = [...m[1].matchAll(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g)].map((a) => a[1]);
      let names = [m[1]];
      for (const axis of axes) {
        names = names.flatMap((n) => (job.strategy?.matrix?.[axis] ?? []).map((v) => n.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${axis}\\s*\\}\\}`), String(v))));
      }
      stems.push(...names);
      assert.ok(names.length > 0, `${id}: the upload name has a matrix axis the job does not have`);
    }
  }
  return stems.sort();
}
const EXPECTED = expectedStems(loadCi());

/** The conforming input: the recorded Full run, a pull request of its head, no label, a merge tree equal to the head's. */
const input = (mutate = () => {}) => {
  const i = {
    event: 'pull_request', labels: [{ name: 'enhancement' }], headSha: HEAD, treeMatches: true, repository: REPO,
    runs: clone(RUNS), jobs: clone(JOBS), artifacts: clone(ARTIFACTS), expected: clone(EXPECTED), now: 1_000, deadline: 121_000,
  };
  mutate(i);
  return i;
};
const run0 = (i) => i.runs.workflow_runs[0];
const gateJob = (i) => i.jobs.jobs.find((j) => j.name === GATE);
/** A run object beside the recorded one: `over` is merged into a copy of it. */
const another = (over) => ({ ...clone(RUNS.workflow_runs[0]), ...over });

describe('the recorded real responses (Full run 41895080392) are what the decision is shown', () => {
  it('the fixtures are the real run: one run of full-run.yml for the head, 13 jobs, 13 artifacts, every list whole', () => {
    assert.equal(RUNS.total_count, RUNS.workflow_runs.length);
    assert.equal(JOBS.total_count, JOBS.jobs.length);
    assert.equal(ARTIFACTS.total_count, ARTIFACTS.artifacts.length);
    assert.equal(RUNS.workflow_runs[0].id, Number(RUN_ID));
    assert.equal(RUNS.workflow_runs[0].head_sha, HEAD);
    assert.ok(JOBS.jobs.some((j) => j.name === GATE && j.conclusion === 'success'));
  });

  it('the results ci.yml\'s test jobs upload, derived from the parsed workflow, are exactly the results artifacts of the recorded run (attempt 1)', () => {
    const recorded = ARTIFACTS.artifacts.map((a) => a.name).filter((n) => /^test-results-/.test(n)).map((n) => n.replace(/^test-results-/, '').replace(/-1$/, '')).sort();
    assert.ok(EXPECTED.length >= 8, `only ${EXPECTED.length} stem(s) derived: the derivation is broken`);
    assert.deepEqual(EXPECTED, recorded, 'ci.yml uploads results the recorded Full run does not hold (or the other way round): the fixture or the workflow moved');
  });
});

describe('decideReuse — reuse holds on the recorded run', () => {
  it('names the run as "<id>.<attempt>" and says it is reused', async () => {
    const { decideReuse } = await reuse();
    const r = decideReuse(input());
    assert.deepEqual({ fullRun: r.fullRun, reason: r.reason, level: r.level }, { fullRun: `${RUN_ID}.1`, reason: 'reuse', level: 'notice' });
    assert.match(r.fullRun, /^\d+\.\d+$/);
  });

  it('does not change what it is given', async () => {
    const { decideReuse } = await reuse();
    const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
    assert.equal(decideReuse(deepFreeze(input())).fullRun, `${RUN_ID}.1`);
  });

  for (const [what, labels] of [['labels absent', undefined], ['labels null', null], ['no label', []], ['another label', [{ name: 'ci:fullish' }, { name: 'bug' }]]]) {
    it(`reuses with ${what} (an absent payload field counts as no label)`, async () => {
      const { decideReuse } = await reuse();
      const i = input();
      if (labels === undefined) delete i.labels; else i.labels = labels;
      assert.equal(decideReuse(i).fullRun, `${RUN_ID}.1`);
    });
  }

  it('of two Full runs of one SHA, the newest by created_at is the candidate, wherever it stands in the list', async () => {
    const { decideReuse } = await reuse();
    const older = another({ id: 41000000001, conclusion: 'failure', created_at: '2026-11-04T10:00:00Z' });
    const newest = another({ id: 41000000002, created_at: '2026-11-04T11:00:00Z' });
    for (const order of [[older, newest], [newest, older]]) {
      const i = input((x) => { x.runs = { total_count: 2, workflow_runs: order }; });
      assert.equal(decideReuse(i).fullRun, '41000000002.1');
    }
  });

  it('reads the run\'s LATEST attempt: attempt 2 is named, and its own results are the ones expected', async () => {
    const { decideReuse } = await reuse();
    const i = input((x) => {
      run0(x).run_attempt = 2;
      for (const j of x.jobs.jobs) j.run_attempt = 2;
      for (const a of x.artifacts.artifacts) a.name = a.name.replace(/-1$/, '-2');
    });
    assert.equal(decideReuse(i).fullRun, `${RUN_ID}.2`);
  });
});

/** One refusal per row: [what, how the conforming input is broken, the named reason, its level]. Each row changes ONE thing. */
const REFUSALS = [
  ['the event is a push, not a pull_request', (i) => { i.event = 'push'; }, 'not-a-pull-request', 'notice'],
  ['the event is pull_request_target', (i) => { i.event = 'pull_request_target'; }, 'not-a-pull-request', 'notice'],
  ['the pull request carries ci:full (run everything)', (i) => { i.labels = [{ name: 'ci:full' }]; }, 'label-ci-full', 'notice'],
  ['ci:full among other labels', (i) => { i.labels = [{ name: 'bug' }, { name: 'ci:full' }]; }, 'label-ci-full', 'notice'],
  ['the merge tree differs from the head\'s (main moved on)', (i) => { i.treeMatches = false; }, 'tree-differs', 'notice'],
  ['no Full run of the head SHA', (i) => { i.runs = { total_count: 0, workflow_runs: [] }; }, 'no-full-run', 'notice'],
  ['the newest run is red while an older one is green', (i) => {
    i.runs = { total_count: 2, workflow_runs: [another({ id: 1, created_at: '2026-11-04T10:00:00Z' }), another({ id: 2, conclusion: 'failure', created_at: '2026-11-04T11:00:00Z' })] };
  }, 'run-failed', 'notice'],
  ['the run\'s latest attempt is red (attempt 1 was green)', (i) => { Object.assign(run0(i), { run_attempt: 2, conclusion: 'failure' }); }, 'run-failed', 'notice'],
  ['the run was cancelled', (i) => { run0(i).conclusion = 'cancelled'; }, 'run-cancelled', 'notice'],
  ['the run is still in progress', (i) => { Object.assign(run0(i), { status: 'in_progress', conclusion: null }); }, 'run-in-progress', 'notice'],
  ['the run is queued', (i) => { Object.assign(run0(i), { status: 'queued', conclusion: null }); }, 'run-in-progress', 'notice'],
  ['the run is of another SHA', (i) => { run0(i).head_sha = '0'.repeat(40); }, 'other-sha', 'notice'],
  ['the run was not a push (a workflow_dispatch of the same file)', (i) => { run0(i).event = 'workflow_dispatch'; }, 'not-a-push', 'notice'],
  ['the run was a pull_request run', (i) => { run0(i).event = 'pull_request'; }, 'not-a-push', 'notice'],
  ['the run\'s branch is main, not full-run/*', (i) => { run0(i).head_branch = 'main'; }, 'not-a-full-run-branch', 'notice'],
  ['the run\'s branch is full-run with no slash', (i) => { run0(i).head_branch = 'full-run'; }, 'not-a-full-run-branch', 'notice'],
  ['the run\'s branch merely ends in full-run/', (i) => { run0(i).head_branch = 'x/full-run/bundle'; }, 'not-a-full-run-branch', 'notice'],
  ['the run\'s head repository is a fork', (i) => { run0(i).head_repository.full_name = 'someone/Ythril'; }, 'other-repository', 'notice'],
  ['the run belongs to another repository', (i) => { run0(i).repository.full_name = 'someone/Ythril'; }, 'other-repository', 'notice'],
  ['the pull request is of another repository than the run', (i) => { i.repository = 'someone/Ythril'; }, 'other-repository', 'notice'],
  ['"Full run / Build & Test" failed in that attempt', (i) => { gateJob(i).conclusion = 'failure'; }, 'build-and-test-not-success', 'notice'],
  ['"Full run / Build & Test" was skipped', (i) => { gateJob(i).conclusion = 'skipped'; }, 'build-and-test-not-success', 'notice'],
  ['"Full run / Build & Test" is not among the jobs', (i) => { i.jobs.jobs = i.jobs.jobs.filter((j) => j.name !== GATE); i.jobs.total_count = i.jobs.jobs.length; }, 'build-and-test-not-success', 'notice'],
  ['a results artifact was never uploaded', (i) => { i.artifacts.artifacts = i.artifacts.artifacts.filter((a) => a.name !== 'test-results-sync-1'); i.artifacts.total_count = i.artifacts.artifacts.length; }, 'artifact-missing', 'notice'],
  ['one database shard\'s results are missing (the set is derived from ci.yml, so a short list cannot read as whole)', (i) => { i.artifacts.artifacts = i.artifacts.artifacts.filter((a) => a.name !== 'test-results-standalone-db-3-1'); i.artifacts.total_count = i.artifacts.artifacts.length; }, 'artifact-missing', 'notice'],
  ['a results artifact expired', (i) => { i.artifacts.artifacts.find((a) => a.name === 'test-results-redteam-1').expired = true; }, 'artifact-expired', 'notice'],
  ['the runs page holds fewer runs than its total_count', (i) => { i.runs.total_count = 101; }, 'page-short', 'warning'],
  ['the jobs page holds fewer jobs than its total_count', (i) => { i.jobs.total_count = 14; }, 'page-short', 'warning'],
  ['the artifacts page holds fewer artifacts than its total_count', (i) => { i.artifacts.total_count = 14; }, 'page-short', 'warning'],
  ['the runs read failed (an API error)', (i) => { i.runs = { error: 'HTTP 403: Resource not accessible by integration' }; }, 'api-error', 'warning'],
  ['the jobs read failed', (i) => { i.jobs = { error: 'HTTP 502' }; }, 'api-error', 'warning'],
  ['the artifacts read failed', (i) => { i.artifacts = { error: 'HTTP 500' }; }, 'api-error', 'warning'],
  ['the deadline has passed', (i) => { i.now = 121_001; }, 'deadline', 'warning'],
  ['the run id is not a decimal number', (i) => { run0(i).id = '41895080392; echo pwned'; }, 'bad-run-id', 'warning'],
  ['the run id is not a number at all', (i) => { run0(i).id = 'abc'; }, 'bad-run-id', 'warning'],
  ['the attempt is not a positive number', (i) => { run0(i).run_attempt = 0; }, 'bad-run-id', 'warning'],
  ['the attempt is text', (i) => { run0(i).run_attempt = '1 2'; }, 'bad-run-id', 'warning'],
];

describe('decideReuse — each refusal is no reuse, empty, for its own named reason', () => {
  it('has a table worth its name, and every reason of the interface is used', () => {
    assert.ok(REFUSALS.length >= 30, `the table holds ${REFUSALS.length} rows`);
    const reasons = new Set(REFUSALS.map((r) => r[2]));
    for (const reason of ['not-a-pull-request', 'label-ci-full', 'tree-differs', 'no-full-run', 'run-failed', 'run-cancelled', 'run-in-progress', 'other-sha', 'not-a-push',
      'not-a-full-run-branch', 'other-repository', 'build-and-test-not-success', 'artifact-missing', 'artifact-expired', 'page-short', 'api-error', 'deadline', 'bad-run-id']) {
      assert.ok(reasons.has(reason), `no row refuses with ${reason}`);
    }
  });

  for (const [what, mutate, reason, level] of REFUSALS) {
    it(`${reason}: ${what}`, async () => {
      const { decideReuse } = await reuse();
      const r = decideReuse(input(mutate));
      assert.equal(r.fullRun, '', `${what} still reused ${r.fullRun}`);
      assert.equal(r.reason, reason);
      assert.equal(r.level, level, level === 'warning' ? 'an error-class refusal must warn: a fail-open that hides a regression looks healthy' : 'an ordinary refusal is a notice');
    });
  }

  it('the output of a refusal is the empty string and of a reuse exactly "<id>.<attempt>", never anything else', async () => {
    const { decideReuse } = await reuse();
    for (const [, mutate] of REFUSALS) assert.equal(decideReuse(input(mutate)).fullRun, '');
    assert.match(decideReuse(input()).fullRun, /^[0-9]+\.[0-9]+$/);
  });
});

describe('the results the decision expects are derived from ci.yml, never listed', () => {
  const ciText = () => readFileSync(join(REPO_ROOT, CI_WORKFLOW), 'utf8');

  it('the script reads the same stems out of ci.yml\'s text as the parsed workflow gives (a job that installs nothing has no YAML parser)', async () => {
    const { expectedResultsStems } = await reuse();
    assert.deepEqual([...expectedResultsStems(ciText())].sort(), EXPECTED);
  });

  it('follows the workflow: a renamed results upload and a shorter shard matrix change what is expected', async () => {
    const { expectedResultsStems } = await reuse();
    const renamed = ciText().replace('name: test-results-sync-${{ github.run_attempt }}', 'name: test-results-sync-two-${{ github.run_attempt }}');
    assert.notEqual(renamed, ciText(), 'the mutation found nothing to rename: re-anchor this row');
    assert.ok(expectedResultsStems(renamed).includes('sync-two') && !expectedResultsStems(renamed).includes('sync'));
    const shorter = ciText().replace('shard: [0, 1, 2, 3]', 'shard: [0, 1]');
    assert.notEqual(shorter, ciText(), 'the mutation found nothing to shorten: re-anchor this row');
    assert.deepEqual(expectedResultsStems(shorter).filter((s) => s.startsWith('standalone-db-')).sort(), ['standalone-db-0', 'standalone-db-1']);
  });

  it('is the set a decision refuses a missing member of (a stem it does not expect is not required)', async () => {
    const { decideReuse } = await reuse();
    const fewer = input((i) => { i.expected = i.expected.filter((s) => s !== 'sync'); i.artifacts.artifacts = i.artifacts.artifacts.filter((a) => a.name !== 'test-results-sync-1'); i.artifacts.total_count -= 1; });
    assert.equal(decideReuse(fewer).fullRun, `${RUN_ID}.1`);
  });

  it('the force label is named once, by the script', async () => {
    const mod = await import(pathToFileURL(join(REPO_ROOT, SCRIPT)).href);
    assert.equal(mod.FORCE_LABEL, 'ci:full');
  });
});

// ───────────────────────────────────────── verifyReuse: fails closed ─────────────────────────────────────────

/**
 * A `gh` fake for the three reads the merge gate repeats: the run, its latest attempt's jobs, its artifacts. It records every
 * argument array; an endpoint it does not know throws, so a read the contract does not name is seen.
 */
function fakeGh({ run = RUNS.workflow_runs[0], jobs = JOBS, artifacts = ARTIFACTS, failOn } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    assert.ok(Array.isArray(args) && args.every((a) => typeof a === 'string'), 'gh is handed an argument array of strings');
    const endpoint = args.find((a) => /^repos\//.test(a)) ?? '';
    if (failOn?.test(endpoint)) throw new Error('HTTP 500: server error');
    if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs(\?.*)?$/.test(endpoint)) return clone(jobs);
    if (/\/actions\/runs\/\d+\/artifacts(\?.*)?$/.test(endpoint)) return clone(artifacts);
    if (/\/actions\/runs\/\d+(\/attempts\/\d+)?(\?.*)?$/.test(endpoint)) return clone(run);
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  gh.calls = calls;
  return gh;
}
const verify = async (over = {}, ghOver = {}) => {
  const { verifyReuse } = await reuse();
  const gh = over.gh ?? fakeGh(ghOver);
  const promise = verifyReuse({ fullRun: `${RUN_ID}.1`, headSha: HEAD, repository: REPO, expected: clone(EXPECTED), gh, ...over });
  return { promise, gh };
};
const REMEDY = /re-run the whole PR run/;

describe('verifyReuse — the run the reuse job named is read again, and anything it cannot confirm fails the gate with the remedy', () => {
  it('confirms the recorded run and returns what the download reads', async () => {
    const { promise, gh } = await verify();
    assert.deepEqual(await promise, { runId: RUN_ID, attempt: '1' });
    assert.ok(gh.calls.length >= 3, 'it re-reads the run, its jobs and its artifacts');
  });

  it('an empty value (a fresh run, or a push) is not an error and reads nothing', async () => {
    const { promise, gh } = await verify({ fullRun: '' });
    assert.equal(await promise, null);
    assert.equal(gh.calls.length, 0);
  });

  for (const bad of [RUN_ID, `${RUN_ID}.`, '.1', `${RUN_ID}.1.2`, 'x.1', `${RUN_ID}.x`, ` ${RUN_ID}.1`, `${RUN_ID}.0`, `${RUN_ID}.1;id`, '../1.1', '1.1\n2.1']) {
    it(`a half-set or malformed value ${JSON.stringify(bad)} is refused before gh is called, with the remedy`, async () => {
      const { promise, gh } = await verify({ fullRun: bad });
      await assert.rejects(promise, REMEDY);
      assert.equal(gh.calls.length, 0, 'a value that is not exactly two decimals reaches no endpoint path');
    });
  }

  for (const [what, failOn] of [['the run', /\/runs\/\d+(\?.*)?$/], ['its jobs', /\/jobs/], ['its artifacts', /\/artifacts/]]) {
    it(`a read error on ${what} fails, with the remedy (it does not read as "no reuse": the suites are already skipped)`, async () => {
      const { promise } = await verify({}, { failOn });
      await assert.rejects(promise, REMEDY);
    });
  }

  for (const [what, ghOver] of [
    ['the run is of another SHA', { run: { ...RUNS.workflow_runs[0], head_sha: '0'.repeat(40) } }],
    ['a newer attempt exists than the one named', { run: { ...RUNS.workflow_runs[0], run_attempt: 2 } }],
    ['the run is not green', { run: { ...RUNS.workflow_runs[0], conclusion: 'failure' } }],
    ['the run is still in progress', { run: { ...RUNS.workflow_runs[0], status: 'in_progress', conclusion: null } }],
    ['the run was not a push', { run: { ...RUNS.workflow_runs[0], event: 'pull_request' } }],
    ['the run is of a branch that is not full-run/*', { run: { ...RUNS.workflow_runs[0], head_branch: 'main' } }],
    ['the run is of another repository', { run: { ...RUNS.workflow_runs[0], head_repository: { full_name: 'someone/Ythril' } } }],
    ['the run is of another workflow file', { run: { ...RUNS.workflow_runs[0], path: '.github/workflows/ci.yml' } }],
    ['Build & Test of that attempt is not success', { jobs: { ...JOBS, jobs: JOBS.jobs.map((j) => (j.name === GATE ? { ...j, conclusion: 'failure' } : j)) } }],
    ['a results artifact is gone at download', { artifacts: { total_count: 12, artifacts: ARTIFACTS.artifacts.filter((a) => a.name !== 'test-results-integration-1') } }],
    ['a results artifact expired at download', { artifacts: { ...ARTIFACTS, artifacts: ARTIFACTS.artifacts.map((a) => (a.name === 'test-results-sync-1' ? { ...a, expired: true } : a)) } }],
    ['the artifacts page is short of its total', { artifacts: { ...ARTIFACTS, total_count: 99 } }],
  ]) {
    it(`a mismatch fails, with the remedy: ${what}`, async () => {
      const { promise } = await verify({}, ghOver);
      await assert.rejects(promise, REMEDY);
    });
  }

  it('names the remedy completely: re-run the whole run, never --failed, and it decides again', async () => {
    const { promise } = await verify({ fullRun: 'nonsense' });
    await assert.rejects(promise, (e) => REMEDY.test(e.message) && /gh run rerun/.test(e.message) && /never --failed/.test(e.message));
  });

  it('refuses a pull request of another head SHA, or of another repository, than the run it was told to trust', async () => {
    for (const over of [{ headSha: '1'.repeat(40) }, { repository: 'someone/Ythril' }]) {
      const { promise } = await verify(over);
      await assert.rejects(promise, REMEDY);
    }
  });
});

// ───────────────────────────────────────── the entry: a process, its exit status and what it writes ─────────────────────────────────────────

describe('node scripts/full-run-reuse.mjs — decide fails open, verify fails closed (a process, not a function)', () => {
  /** Run the entry with exactly this environment (no `gh`, no token): the process can reach nothing. */
  function entry(args, env) {
    const dir = mkdtempSync(join(tmpdir(), 'full-run-reuse-'));
    const output = join(dir, 'output');
    const summary = join(dir, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    try {
      assert.ok(existsSync(join(REPO_ROOT, SCRIPT)), `${SCRIPT} does not exist yet`);
      const r = spawnSync(process.execPath, [join(REPO_ROOT, SCRIPT), ...args], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
        env: { PATH: '/nonexistent', HOME: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: REPO, ...env },
      });
      return { status: r.status, out: `${r.stdout}\n${r.stderr}`, output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8') };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('decide on a push: exit 0, an empty full_run, and the reason in the step summary', () => {
    const r = entry(['decide'], { GITHUB_EVENT_NAME: 'push' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.output, 'full_run=\n');
    assert.match(r.summary, /not-a-pull-request/);
  });

  it('decide on a pull request that can read nothing (no gh, no token): still exit 0 and an empty full_run, never a failed job', () => {
    const r = entry(['decide'], { GITHUB_EVENT_NAME: 'pull_request', HEAD_SHA: HEAD, PR_LABELS: '[]' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.output, 'full_run=\n');
    assert.ok(r.summary.length > 0, 'the reason it did not reuse is in the summary');
  });

  it('verify with nothing to verify: exit 0, and the outputs name THIS run (the download then reads this run\'s own results)', () => {
    const r = entry(['verify'], { FULL_RUN: '', GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '2' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.output, /^run_id=555$/m);
    assert.match(r.output, /^attempt=2$/m);
  });

  it('verify with half a value: a non-zero exit that names the remedy', () => {
    const r = entry(['verify'], { FULL_RUN: RUN_ID, GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '1', HEAD_SHA: HEAD });
    assert.notEqual(r.status, 0, 'a half-set value passed the gate');
    assert.match(r.out, REMEDY);
  });

  it('verify that cannot read the run it was told to trust: a non-zero exit that names the remedy', () => {
    const r = entry(['verify'], { FULL_RUN: `${RUN_ID}.1`, GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '1', HEAD_SHA: HEAD });
    assert.notEqual(r.status, 0, 'a read error passed the gate');
    assert.match(r.out, REMEDY);
    assert.doesNotMatch(r.output, /run_id=/, 'a failed verification wrote the outputs the download reads');
  });
});

describe('a module the entry cannot load: decide fails open, verify fails closed (the dynamic import is inside the fail-open)', () => {
  /**
   * The script alone in a scratch repository whose `scripts/_shared/gh-call.mjs` is `callCore` (or absent): the entry's own
   * import of it is what is tested, so the copy sits where the script expects its neighbour and nothing of this repository's
   * tree is touched.
   */
  function entryWithCallCore(callCore, args, env) {
    const dir = mkdtempSync(join(tmpdir(), 'full-run-reuse-load-'));
    try {
      mkdirSync(join(dir, 'scripts', '_shared'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'full-run-reuse.mjs'), readFileSync(join(REPO_ROOT, SCRIPT), 'utf8'));
      // The script's STATIC repository imports, read off its source (a list written here would miss tomorrow's); only the call
      // core, which it loads dynamically, is the variable here.
      const statics = [...readFileSync(join(REPO_ROOT, SCRIPT), 'utf8').matchAll(/^import\s[^;]*?from\s+'\.\/(_shared\/[\w.-]+\.mjs)';/gm)].map((m) => m[1]);
      assert.ok(statics.includes('_shared/script-cli.mjs'), `the static imports were not read: ${statics.join(', ') || 'none'}`);
      for (const rel of statics) writeFileSync(join(dir, 'scripts', rel), readFileSync(join(REPO_ROOT, 'scripts', rel), 'utf8'));
      if (callCore !== null) writeFileSync(join(dir, 'scripts', '_shared', 'gh-call.mjs'), callCore);
      const output = join(dir, 'output');
      const summary = join(dir, 'summary');
      writeFileSync(output, '');
      writeFileSync(summary, '');
      const r = spawnSync(process.execPath, [join(dir, 'scripts', 'full-run-reuse.mjs'), ...args], {
        cwd: dir, encoding: 'utf8', timeout: 60_000,
        env: { PATH: '/nonexistent', HOME: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: REPO, ...env },
      });
      return { status: r.status, out: `${r.stdout}\n${r.stderr}`, output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8') };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const PULL_REQUEST = { GITHUB_EVENT_NAME: 'pull_request', HEAD_SHA: HEAD, PR_LABELS: '[]' };

  for (const [what, callCore] of [['is missing', null], ['has a syntax error', 'export const ghJson = ;\n'], ['throws when it is evaluated', 'throw new Error("boom");\n']]) {
    it(`decide: gh-call.mjs ${what}: exit 0, an empty full_run, a warning that names the load, never a failed job`, () => {
      const r = entryWithCallCore(callCore, ['decide'], PULL_REQUEST);
      assert.equal(r.status, 0, r.out);
      assert.equal(r.output, 'full_run=\n');
      assert.match(r.out, /::warning\b[^\n]*load-error/, 'a load error that does not warn hides a broken script behind a healthy-looking job');
      assert.match(r.summary, /load-error/);
    });

    it(`verify: gh-call.mjs ${what}: a non-zero exit that names the remedy, and no outputs for the download`, () => {
      const r = entryWithCallCore(callCore, ['verify'], { FULL_RUN: `${RUN_ID}.1`, GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '1', HEAD_SHA: HEAD });
      assert.notEqual(r.status, 0, 'a module that did not load passed the gate');
      assert.match(r.out, REMEDY);
      assert.doesNotMatch(r.output, /run_id=/);
    });
  }

  it('decide on a push never loads gh-call.mjs: a missing module is no reason to warn when nothing is read', () => {
    const r = entryWithCallCore(null, ['decide'], { GITHUB_EVENT_NAME: 'push' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.output, 'full_run=\n');
    assert.doesNotMatch(r.out, /::warning/);
  });
});

describe('the tree comparison never makes a full clone shallow or partial (bundle-244: a drive on a developer\'s clone did)', () => {
  /** An origin with two commits of different trees, a FULL clone of it, then a third commit the clone has not fetched. */
  function repos() {
    const dir = mkdtempSync(join(tmpdir(), 'full-run-reuse-tree-'));
    const git = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: dir } });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    const commit = (text) => {
      writeFileSync(join(origin, 'f.txt'), text);
      git(origin, 'add', 'f.txt');
      git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', text);
      return git(origin, 'rev-parse', 'HEAD');
    };
    const first = commit('one');
    const second = commit('two');
    const work = join(dir, 'work');
    git(dir, 'clone', '-q', `file://${origin}`, work);
    const third = commit('three');
    const state = () => ({
      shallow: git(work, 'rev-parse', '--is-shallow-repository'),
      partial: spawnSync('git', ['config', '--get-regexp', 'promisor|partialclone'], { cwd: work, encoding: 'utf8' }).stdout.trim(),
    });
    return { dir, work, first, second, third, state };
  }

  for (const [what, pick, expected] of [
    ['the head is the checked-out commit, already present', (r) => r.second, true],
    ['the head is an older commit with another tree, already present', (r) => r.first, false],
    ['the head is a commit the clone has not fetched', (r) => r.third, false],
  ]) {
    it(`${what}: answers ${expected}, and the clone stays full`, async () => {
      const { treeMatchesHead } = await reuse();
      assert.equal(typeof treeMatchesHead, 'function', `${SCRIPT} must export treeMatchesHead`);
      const r = repos();
      try {
        const answer = treeMatchesHead(pick(r), { deadline: Date.now() + 60_000, env: process.env, cwd: r.work });
        assert.equal(answer, expected);
        assert.deepEqual(r.state(), { shallow: 'false', partial: '' }, 'the comparison changed what the clone is');
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });
  }
});
