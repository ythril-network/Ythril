/**
 * `scripts/test-times.mjs --record-ci` records the runs `trustedRuns()` admits, with the identity the API gave and
 * nothing the artifact claimed, and does not so much as ask about the others.
 *
 * ## What this prevents
 *
 * `trustedRuns` and `parseArtifact` are tested as functions in `test-times-trusted-runs.test.js`. This is the same
 * rule seen from the outside, because a correct filter that the CLI forgets to call, or calls AFTER it has fetched
 * and parsed an untrusted run's artifact, is the defect that matters: the guard exists to stop a stranger's bytes
 * being read as a record. So the real CLI runs against two local servers — one that speaks the part of the GitHub
 * Actions API it reads (with runs a fork, a pull request, another workflow and another branch would have produced,
 * a run still in progress, and an artifact whose lines claim a different commit, branch and run id) and one that
 * speaks the Ythril tool door — and the tests read what each server was ASKED:
 *
 * - the untrusted runs' jobs, artifacts and bytes were never requested (refused before parsing, not after);
 * - every record's `runId`, `commit` and `branch` are the run object's, whatever the artifact said;
 * - each (job, suite) of a trusted run is one record keyed `ci:<runId>:<attempt>:<job>:<suite>`, with `source: ci`,
 *   `dirty: false` and a `layout` derived from the run's results artifacts (`ci-parallel-v2` when more than one test job
 *   left one, `ci-serial-v1` when one did; the Actions API's job list is not asked, so no job NAME is ever compared with
 *   a job id: `test-times-record-ci-layout-and-wall.test.js` holds that, with the names the API really answers);
 * - a second `--record-ci` adds nothing;
 * - the GitHub token goes only to GitHub and the Ythril token only to Ythril, and the Actions API is read only for
 *   `ythril-network/Ythril`.
 *
 * ## The interface this pins
 *
 * The Actions API base is `GITHUB_API_URL` (default `https://api.github.com`; loopback `http` allowed, like the
 * Ythril URL), authenticated with `GH_TOKEN`. A run's artifacts are named `test-results-<job>-<attempt>` and hold
 * `<suite>-<batch>.jsonl` files (the shape in `testing/_shared/test-times-harness.mjs`); a record is built per
 * (job, suite) from them.
 *
 * Local servers only; nothing here reaches github.com or a real instance.
 *
 * Run: node --test testing/standalone/test-times-record-ci-runs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { startFakeGithub, FAKE_GH_TOKEN } from '../_shared/fake-github-actions.mjs';
import { makeWorkdir, runTimes, everything, REPO, SHA, T, githubRun as run, githubJobs, resultsArtifact as artifact } from '../_shared/test-times-harness.mjs';

const spec = (suite, batch, file, extra = {}) => ({ suite, batch, files: [{ file, ms: 5000, tests: [T('one', 2000), T('two', 3000)] }], ...extra });

/** The lines a lying artifact adds to every line it holds: it claims another run, commit and branch. */
const LIE = { runId: 999, commit: 'e'.repeat(40), branch: 'feature/forged', repository: 'attacker/Ythril', source: 'local', dirty: true };
const lyingSpec = (suite, batch, file) => {
  const s = spec(suite, batch, file);
  s.extra = [{ type: 'test', suite, batch, file, test: 'extra-line', nesting: 1, ms: 1, status: 'pass', ...LIE }];
  return s;
};

function world() {
  const runs = [
    run(1001, { head_sha: SHA('1') }),                                                 // trusted, parallel layout
    run(1002, { head_repository: { full_name: 'attacker/Ythril' } }),                 // a fork's push
    run(1003, { event: 'pull_request' }),                                              // a pull request
    run(1004, { path: '.github/workflows/release.yml' }),                              // another workflow
    run(1005, { head_branch: 'release/5.6.x' }),                                       // another branch
    run(1006, { status: 'in_progress', conclusion: null }),                            // trusted identity, not finished
    run(1007, { head_sha: SHA('7') }),                                                 // trusted, serial layout, artifact lies
  ];
  // The API names a job by its DISPLAY name (`Prepare`, `Standalone (no services)`), never by the workflow's job id; the ids are
  // read from ci.yml and an older run's job (the one job of the serial workflow) is named as it was.
  const jobs = (...ids) => githubJobs(...ids);
  const jobsByRun = {
    1001: jobs('prepare', 'standalone-pure', 'integration', 'test'),
    1002: jobs('prepare', 'standalone-pure'), 1003: jobs('prepare'), 1004: [{ name: 'release' }], 1005: [{ name: 'Build & Test' }],
    1006: jobs('prepare', 'standalone-pure'),
    1007: githubJobs({ name: 'Build & Test' }),
  };
  const artifactsByRun = {
    1001: [
      artifact(5001, 'test-results-standalone-pure-1', ['standalone-pure.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')]),
      artifact(5002, 'test-results-integration-1', ['integration-all.jsonl', spec('integration', 'all', 'testing/integration/i.test.js')]),
    ],
    1002: [artifact(5003, 'test-results-standalone-pure-1', ['standalone-pure.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')])],
    1003: [artifact(5004, 'test-results-prepare-1', ['x.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')])],
    1004: [artifact(5005, 'test-results-release-1', ['x.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')])],
    1005: [artifact(5006, 'test-results-build-and-test-1', ['x.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')])],
    1006: [artifact(5007, 'test-results-standalone-pure-1', ['x.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')])],
    1007: [artifact(5008, 'test-results-build-and-test-1', ['standalone-pure.jsonl', lyingSpec('standalone', 'pure', 'testing/standalone/a.test.js')])],
  };
  return { runs, jobsByRun, artifactsByRun };
}

async function withWorld(body) {
  const github = await startFakeGithub(world());
  const ythril = await startFakeYthril();
  const work = makeWorkdir();
  const env = { YTHRIL_TEST_RUNS_URL: ythril.url, YTHRIL_TEST_RUNS_TOKEN: ythril.token, GITHUB_API_URL: github.url, GH_TOKEN: FAKE_GH_TOKEN };
  try { return await body({ github, ythril, dir: work.dir, env }); } finally { await github.close(); await ythril.close(); work.cleanup(); }
}

const records = (ythril) => Object.fromEntries(ythril.store.map(e => [e.properties.recordKey, e.properties]));

describe('--record-ci', () => {
  it('records each (job, suite) of the trusted runs and nothing of the others', async () => {
    await withWorld(async ({ ythril, dir, env }) => {
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(Object.keys(records(ythril)).sort(), [
        'ci:1001:1:integration:integration',
        'ci:1001:1:standalone-pure:standalone',
        'ci:1007:1:build-and-test:standalone',
      ]);
    });
  });

  it('never asks about an untrusted or unfinished run — it is refused before its artifact is read, not after', async () => {
    await withWorld(async ({ github, dir, env }) => {
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      const asked = github.askedAbout();
      for (const id of ['1002', '1003', '1004', '1005']) assert.ok(!asked.has(id), `run ${id} is not a push to main of ${REPO} from ci.yml and must not be read (asked about: ${[...asked].join(', ')})`);
      assert.ok(asked.has('1001') && asked.has('1007'), 'the trusted runs were read');
      const blobs = github.requests.filter(q => q.path.startsWith('/blob/') || q.path.includes('/artifacts/')).map(q => q.path);
      for (const id of [5003, 5004, 5005, 5006]) assert.ok(!blobs.some(p => p.includes(String(id))), `artifact ${id} belongs to an untrusted run and was fetched`);
    });
  });

  it('reads the Actions API for this repository only', async () => {
    await withWorld(async ({ github, dir, env }) => {
      await runTimes(['--record-ci'], { cwd: dir, env });
      const api = github.requests.filter(q => !q.path.startsWith('/blob/'));
      assert.ok(api.length > 0);
      for (const q of api) assert.ok(q.path.startsWith(`/repos/${REPO}/`), `${q.path} is outside ${REPO}`);
    });
  });

  it('takes runId, commit and branch from the run object — an artifact that claims others is ignored', async () => {
    await withWorld(async ({ ythril, dir, env }) => {
      await runTimes(['--record-ci'], { cwd: dir, env });
      const rec = records(ythril);
      const lied = rec['ci:1007:1:build-and-test:standalone'];
      assert.equal(lied.runId, '1007', 'the run id is the API\'s, and text');
      assert.equal(lied.commit, SHA('7'));
      assert.equal(lied.branch, 'main');
      assert.equal(lied.source, 'ci');
      assert.equal(lied.dirty, false);
      assert.ok(!JSON.stringify(ythril.store).includes('forged'), 'a forged claim does not reach the record');
      assert.ok(!JSON.stringify(ythril.store).includes('attacker'));
      const good = rec['ci:1001:1:standalone-pure:standalone'];
      assert.equal(good.runId, '1001');
      assert.equal(good.commit, SHA('1'));
      assert.equal(good.job, 'standalone-pure');
      assert.equal(good.suite, 'standalone');
      assert.equal(String(good.attempt), '1');
      assert.equal(good.formatVersion, 1);
      assert.equal(good.outcome, 'passed');
      assert.equal(good.scope, 'full');
      assert.equal(good.files, 1);
      assert.equal(good.tests, 2);
      assert.equal(good.ms, 5000);
    });
  });

  it('derives the layout from the run\'s results artifacts: more than one test job means parallel, one means serial', async () => {
    await withWorld(async ({ ythril, dir, env }) => {
      await runTimes(['--record-ci'], { cwd: dir, env });
      const rec = records(ythril);
      assert.equal(rec['ci:1001:1:standalone-pure:standalone'].layout, 'ci-parallel-v2');
      assert.equal(rec['ci:1001:1:integration:integration'].layout, 'ci-parallel-v2');
      assert.equal(rec['ci:1007:1:build-and-test:standalone'].layout, 'ci-serial-v1');
    });
  });

  it('is idempotent: a second pass finds every record and adds none', async () => {
    await withWorld(async ({ ythril, dir, env }) => {
      await runTimes(['--record-ci'], { cwd: dir, env });
      const before = ythril.store.map(e => e._id).sort();
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(ythril.store.map(e => e._id).sort(), before);
      assert.equal(ythril.callsTo('save_chrono').length, 3);
    });
  });

  it('a run recorded only PARTLY is completed by the next pass — the records it has are kept, the ones it lacks are written', async () => {
    await withWorld(async ({ ythril, dir, env }) => {
      await runTimes(['--record-ci'], { cwd: dir, env });
      // The recorder died part-way through its walk (newest run first: 1007, then 1001): run 1007 reached the instance not at
      // all and run 1001 with only one of its two jobs. The walk records newest first, so the partial run is the frontier.
      const drop = (key) => {
        const at = ythril.store.findIndex(e => e.properties.recordKey === key);
        assert.ok(at >= 0, `the fixture lost nothing: the first pass did not record ${key}`);
        ythril.store.splice(at, 1);
      };
      drop('ci:1001:1:integration:integration');
      drop('ci:1007:1:build-and-test:standalone');
      const kept = ythril.store.map(e => e._id);
      assert.equal(kept.length, 1);
      const savesBefore = ythril.callsTo('save_chrono').length;
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(Object.keys(records(ythril)).sort(), [
        'ci:1001:1:integration:integration', 'ci:1001:1:standalone-pure:standalone', 'ci:1007:1:build-and-test:standalone',
      ], 'a record of the partly recorded run 1001 was not written back — a run with one record counts as recorded');
      assert.equal(ythril.callsTo('save_chrono').length, savesBefore + 2, 'exactly the two missing records were written');
      assert.ok(ythril.store.some(e => e._id === kept[0]), 'the record the run already had was removed or replaced');
      assert.equal(ythril.callsTo('update_chrono').length, 0, 'a record the run already had was written again instead of left alone');
      assert.equal(ythril.store.length, 3, 'a record was duplicated');
    });
  });

  it('keeps the two tokens apart and prints neither', async () => {
    await withWorld(async ({ github, ythril, dir, env }) => {
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      for (const q of github.requests.filter(q => q.authorization)) assert.ok(!q.authorization.includes(ythril.token), 'the Ythril token went to GitHub');
      for (const c of ythril.calls) assert.ok(!(c.authorization ?? '').includes(FAKE_GH_TOKEN), 'the GitHub token went to the Ythril instance');
      assert.ok(github.requests.some(q => q.authorization?.includes(FAKE_GH_TOKEN)), 'GitHub was asked with GH_TOKEN');
      for (const secret of [ythril.token, FAKE_GH_TOKEN]) assert.ok(!everything(r).includes(secret), 'neither token is printed');
    });
  });
});
