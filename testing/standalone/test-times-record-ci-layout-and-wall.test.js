/**
 * A CI record carries the layout of the run it came from and the wall of the job that produced it — read from the run's own
 * results, never from a name (bundle-73, Q-400).
 *
 * ## What this prevents
 *
 * The recorder asked the Actions API for a run's jobs and compared each job's `name` with `prepare` (for the layout) and
 * with the workflow's job id (for the wall: `jobs.find(j => j.name === job)`). The API answers the job's DISPLAY name
 * (`Prepare`, `Client tests`, `Standalone (no services)`), so neither comparison ever matched: every CI record was
 * `ci-serial-v1` and every job's wall was the whole run's. The fakes had answered the job ids as names, so the tests
 * agreed with the bug. Now the fakes answer what GitHub answers (`githubJobs`, display names read from `ci.yml`), and:
 *
 * - **No name is matched at all.** The layout is `ci-parallel-v2` when the run lists results artifacts of more than one test
 *   job (the artifact names carry the job ids), else `ci-serial-v1`; the job list is not needed for either, so a run whose
 *   job list is empty is read the same.
 * - **A job's wall is its own recorded span.** A node job's: the sentinel of its results, `startedAt` to `endedAt`. The
 *   client job's: its report's span. Not the run's, not the API's job entry for it (a different number here on purpose),
 *   and never another job's: a job whose results record no span has NO wall.
 * - **The key does not change.** A record's job is the artifact's job id (`client-tests`, `standalone-pure`), whatever the
 *   API calls the job; records written before this fix keep what they were written with.
 *
 * Local servers only; nothing here reaches github.com or a real instance.
 *
 * Run: node --test testing/standalone/test-times-record-ci-layout-and-wall.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { startFakeGithub, FAKE_GH_TOKEN } from '../_shared/fake-github-actions.mjs';
import { makeWorkdir, runTimes, everything, SHA, T, githubRun as run, githubJobs, resultsArtifact as artifact, clientArtifact } from '../_shared/test-times-harness.mjs';
import { clientReport, reportSpan } from '../_shared/client-report-fixtures.mjs';

const CI_ROOT = '/home/runner/work/Ythril/Ythril';
/** The run is 20 minutes; each API job entry spans 20 minutes less one: a wall taken from either is 1 140 000 or 1 200 000, never the figures below. */
const RUN_WALL = 20 * 60_000;
const API_JOB_WALL = 19 * 60_000;

const at = (hms) => `2026-10-05T${hms}.000Z`;
const spec = (suite, batch, file, startedAt, endedAt, extra = {}) => ({ suite, batch, files: [{ file, ms: 5000, tests: [T('one', 2000), T('two', 3000)] }], startedAt, endedAt, ...extra });
const PURE = spec('standalone', 'pure', 'testing/standalone/a.test.js', at('10:00:10'), at('10:05:10'));          // 300 000 ms
const INTEGRATION = spec('integration', 'all', 'testing/integration/i.test.js', at('10:00:20'), at('10:12:50')); // 750 000 ms
const pure = (id) => artifact(id, 'test-results-standalone-pure-1', ['standalone-pure.jsonl', PURE]);
const integration = (id, s = INTEGRATION) => artifact(id, 'test-results-integration-1', ['integration-all.jsonl', s]);
const client = (id) => clientArtifact(id, clientReport('passed', { root: CI_ROOT, startMs: Date.parse(at('10:00:30')) }), { root: CI_ROOT });
const CLIENT_WALL = (() => { const s = reportSpan(clientReport('passed', { root: CI_ROOT, startMs: 0 })); return s.endMs - s.startMs; })();

function world() {
  const runs = [
    run(4001, { head_sha: SHA('1'), run_started_at: at('10:00:00'), updated_at: at('10:20:00') }),                                   // parallel: three test jobs
    run(4002, { head_sha: SHA('2'), run_started_at: at('09:00:00'), updated_at: at('09:20:00') }),                                   // serial: one job, older workflow
    run(4003, { head_sha: SHA('3'), run_started_at: at('08:00:00'), updated_at: at('08:20:00') }),                                   // parallel, one job's results record no span
    run(4004, { head_sha: SHA('4'), run_started_at: at('07:00:00'), updated_at: at('07:20:00') }),                                   // parallel, the API lists no job at all
  ];
  const apiJobs = (...ids) => githubJobs(...ids.map(id => ({ id, startedAt: at('09:59:00'), completedAt: at('10:18:00') })));
  return {
    runs,
    jobsByRun: {
      4001: apiJobs('prepare', 'client-tests', 'standalone-pure', 'integration', 'test'),
      4002: githubJobs({ name: 'Build & Test', startedAt: at('09:00:30'), completedAt: at('09:19:00') }),
      4003: apiJobs('prepare', 'standalone-pure', 'integration', 'test'),
      4004: [],
    },
    artifactsByRun: {
      4001: [pure(8001), integration(8002), client(8003)],
      4002: [artifact(8004, 'test-results-build-and-test-1', ['standalone-pure.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js', at('09:00:40'), at('09:11:40'))])],
      4003: [pure(8005), integration(8006, { ...INTEGRATION, sentinel: 'missing' })],
      4004: [pure(8007), integration(8008)],
    },
  };
}

async function withWorld(body) {
  const github = await startFakeGithub(world());
  const ythril = await startFakeYthril();
  const work = makeWorkdir();
  const env = { YTHRIL_TEST_RUNS_URL: ythril.url, YTHRIL_TEST_RUNS_TOKEN: ythril.token, GITHUB_API_URL: github.url, GH_TOKEN: FAKE_GH_TOKEN };
  try {
    const r = await runTimes(['--record-ci'], { cwd: work.dir, env });
    const records = Object.fromEntries(ythril.store.map(e => [e.properties.recordKey, e.properties]));
    return await body({ r, records, github, ythril });
  } finally { await github.close(); await ythril.close(); work.cleanup(); }
}

describe('the fakes answer what GitHub answers', () => {
  it('names every job by its display name, never by the id an artifact name carries', () => {
    const ids = ['prepare', 'client-tests', 'standalone-pure', 'integration', 'test'];
    const listed = githubJobs(...ids);
    assert.deepEqual(listed.map(j => j.name), ['Prepare', 'Client tests', 'Standalone (no services)', 'Integration', 'Build & Test']);
    for (const [i, id] of ids.entries()) assert.notEqual(listed[i].name, id, `${id} is served under its own id, which the API never does`);
  });
});

describe('--record-ci: layout is read from the run\'s results, never from a job name', () => {
  it('a run with results of more than one test job is ci-parallel-v2, whatever the API calls its jobs', async () => {
    await withWorld(async ({ r, records }) => {
      assert.equal(r.code, 0, everything(r));
      for (const key of ['ci:4001:1:standalone-pure:standalone', 'ci:4001:1:integration:integration', 'ci:4001:1:client-tests:client']) {
        assert.ok(records[key], `no record ${key}: ${Object.keys(records)}`);
        assert.equal(records[key].layout, 'ci-parallel-v2', `${key}: the run lists results of three test jobs and its jobs are named Prepare, Client tests, ...`);
      }
    });
  });

  it('a run with one test job\'s results stays ci-serial-v1, as the records already written say', async () => {
    await withWorld(async ({ records }) => {
      assert.equal(records['ci:4002:1:build-and-test:standalone']?.layout, 'ci-serial-v1');
    });
  });

  it('a run for which the API lists no job is read the same: the job list is not what decides', async () => {
    await withWorld(async ({ records }) => {
      assert.equal(records['ci:4004:1:standalone-pure:standalone']?.layout, 'ci-parallel-v2');
      assert.equal(records['ci:4004:1:integration:integration']?.layout, 'ci-parallel-v2');
    });
  });

  it('the key\'s job stays the artifact\'s job id, never the display name', async () => {
    await withWorld(async ({ records }) => {
      for (const key of Object.keys(records)) assert.ok(!/Standalone|Prepare|Client tests|Integration|Build & Test/.test(key), `a record is keyed by a display name: ${key}`);
      assert.ok(records['ci:4001:1:client-tests:client'] && records['ci:4001:1:standalone-pure:standalone']);
    });
  });
});

describe('--record-ci: a job\'s wall is the span its own results recorded', () => {
  it('each node job\'s wall is its sentinel\'s startedAt..endedAt — not the run\'s, not the API\'s entry for any job', async () => {
    await withWorld(async ({ records }) => {
      assert.equal(records['ci:4001:1:standalone-pure:standalone']?.wallMs, 300_000);
      assert.equal(records['ci:4001:1:integration:integration']?.wallMs, 750_000);
      for (const [key, p] of Object.entries(records)) {
        assert.notEqual(p.wallMs, RUN_WALL, `${key}: the wall is the whole run's`);
        assert.notEqual(p.wallMs, API_JOB_WALL, `${key}: the wall is the API's job entry, matched by something`);
      }
    });
  });

  it('the client job\'s wall is its report\'s own span', async () => {
    await withWorld(async ({ records }) => {
      const wall = records['ci:4001:1:client-tests:client']?.wallMs;
      assert.ok(Number.isFinite(wall), `no wall on the client record: ${JSON.stringify(records['ci:4001:1:client-tests:client'])}`);
      assert.ok(Math.abs(wall - CLIENT_WALL) <= 2, `wallMs ${wall} is not the report's span ${CLIENT_WALL}`);
    });
  });

  it('a historical serial run\'s job wall is its own recorded span too', async () => {
    await withWorld(async ({ records }) => {
      assert.equal(records['ci:4002:1:build-and-test:standalone']?.wallMs, 11 * 60_000);
    });
  });

  it('a job whose results record no span has NO wall — it is never given another job\'s, or the run\'s', async () => {
    await withWorld(async ({ records }) => {
      const cut = records['ci:4003:1:integration:integration'];
      assert.ok(cut, 'the job with no sentinel was not recorded at all');
      assert.equal(cut.outcome, 'incomplete');
      assert.equal(cut.wallMs, undefined, `wallMs ${cut.wallMs} came from somewhere the job's own results do not say`);
      assert.equal(records['ci:4003:1:standalone-pure:standalone']?.wallMs, 300_000, 'the job beside it keeps its own');
    });
  });
});
