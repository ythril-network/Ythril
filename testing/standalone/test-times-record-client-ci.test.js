/**
 * `scripts/test-times.mjs --record-ci` records the client's run from the client job's own artifact, with the same figures
 * and the same refusals as the local door (bundle-73, Q-378).
 *
 * ## What this prevents
 *
 * CI's client job uploads `test-results/` with ONE file in it, `client.json`, and the recorder read only `*.jsonl`: so the
 * job whose artifact it was left no record, the run could never be "recorded completely" for the walk's stop rule, and every
 * pass downloaded the client artifact again to find nothing. Four rules, each against the artifact CI really makes:
 *
 * - **The artifact is built by the real mask step.** `maskClientReport` (`scripts/mask-client-report.mjs`) runs over a REAL
 *   vitest report, so the recorder reads what the workflow uploads (repo-relative names, masked messages, no stacks) and not
 *   a report shaped for the test. The recorder also masks on its own, so a report that reached it unmasked still stores no
 *   secret: both are held, through the door where masking is somebody else's job too.
 * - **client.json is read from the client job's artifact and nowhere else.** By its exact entry name, in the artifact of the
 *   job `client-tests`. A `client.json` inside another job's artifact (a folder merged by mistake, a stranger's upload on a
 *   run the recorder trusts) is not a client run; neither is `nested/client.json`.
 * - **An artifact that cannot say what the client did is a problem of that job.** No `client.json`, one that does not
 *   parse, one with an epoch no `Date` holds: said once in a line that names the job and the reason and never quotes the
 *   report, persistent (the next pass will find it the same way, so it must not keep the run from being the stop), and the
 *   other jobs' records of the run stand.
 * - **A failure that is not an assertion is one failure.** A file that never collected, a hook that threw, a run in which
 *   every file failed at collection: recorded `failed` with the reason, from the CI artifact exactly as from a local run.
 *
 * ## The interface this pins
 *
 * The record of the client job is keyed `ci:<runId>:<attempt>:client-tests:client` (the job is the artifact's own job id,
 * `test-results-client-tests-<attempt>`), `source: ci`, `scope: full` (the client job always runs the whole suite), its
 * figures those of the report, `wallMs` the report's own span. The run is complete for the stop rule once the client job has
 * its record.
 *
 * Local servers only; nothing here reaches github.com or a real instance.
 *
 * Run: node --test testing/standalone/test-times-record-client-ci.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip } from '../_shared/zip-builder.mjs';
import { withRecordingWorld, keysOf, measurementsOf, zipRequests, everything, SHA, T, jsonlFor, githubRun as run, githubJobs, clientArtifact, clientArtifactFromEntries } from '../_shared/test-times-harness.mjs';
import { clientReport, reportSpan, specPaths, FAILURE_FIXTURES } from '../_shared/client-report-fixtures.mjs';

const CI_ROOT = '/home/runner/work/Ythril/Ythril';
const RUN_START = Date.parse('2026-10-05T10:00:00Z');
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const KEY = 'ci:3001:1:client-tests:client';
const NODE_KEY = 'ci:3001:1:standalone-pure:standalone';

const ciReport = (name) => clientReport(name, { root: CI_ROOT, startMs: RUN_START + 3000 });
const nodeSpec = { suite: 'standalone', batch: 'pure', files: [{ file: 'testing/standalone/a.test.js', ms: 5000, tests: [T('one', 2000), T('two', 3000)] }], startedAt: '2026-10-05T10:00:10.000Z', endedAt: '2026-10-05T10:05:10.000Z' };
const nodeArtifact = (id, extra = []) => ({
  id, name: 'test-results-standalone-pure-1',
  zip: buildZip([{ name: 'standalone-pure.jsonl', data: jsonlFor(nodeSpec) }, ...extra]),
});

/** One trusted run whose jobs are Prepare, Client tests and Standalone; `client` is the client job's artifact (or null: it left none). */
function world({ client, nodeExtra = [] }) {
  const artifacts = [nodeArtifact(7001, nodeExtra)];
  if (client) artifacts.push(client);
  return {
    runs: [run(3001, { head_sha: SHA('3') })],
    jobsByRun: { 3001: githubJobs('prepare', 'client-tests', 'standalone-pure') },
    artifactsByRun: { 3001: artifacts },
  };
}

const withWorld = (opts, body) => withRecordingWorld(world(opts), body);

/** The whole entries (not their properties, as `propertiesByKey` gives) by record key: these tests read `startsAt` and `type` too. */
const byKey = (ythril) => Object.fromEntries(ythril.store.map(e => [e.properties.recordKey, e]));
const withClient = (name, mutate = () => {}, options = {}) => { const r = ciReport(name); mutate(r); return clientArtifact(7002, r, { root: CI_ROOT, ...options }); };

describe('--record-ci records the client job from its own artifact', () => {
  it('writes one record for the client job beside the node job\'s, keyed by the artifact\'s job id, with the report\'s figures', async () => {
    await withWorld({ client: withClient('passed'), nodeExtra: [{ name: 'client.json', data: JSON.stringify(ciReport('failed')) }] }, async ({ ythril, pass }) => {
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(keysOf(ythril), [KEY, NODE_KEY].sort(), 'one record per job: the client.json inside the node job\'s artifact is not a client run');
      const p = byKey(ythril)[KEY].properties;
      assert.deepEqual({ source: p.source, job: p.job, suite: p.suite, runId: p.runId, commit: p.commit, branch: p.branch, dirty: p.dirty, formatVersion: p.formatVersion },
        { source: 'ci', job: 'client-tests', suite: 'client', runId: '3001', commit: SHA('3'), branch: 'main', dirty: false, formatVersion: 1 });
      assert.deepEqual({ files: p.files, tests: p.tests, passed: p.passed, failed: p.failed, skipped: p.skipped, todo: p.todo, outcome: p.outcome, scope: p.scope },
        { files: 2, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, outcome: 'passed', scope: 'full' });
      const span = reportSpan(ciReport('passed'));
      assert.ok(Math.abs(p.wallMs - (span.endMs - span.startMs)) <= 2, `wallMs ${p.wallMs} is the report's own span ${span.endMs - span.startMs}`);
      assert.deepEqual(measurementsOf(byKey(ythril)[KEY]).files.map(f => f.file).sort(), specPaths('passed').sort(), 'the files are named as the masked report names them');
    });
  });

  for (const [name, counts, failures] of FAILURE_FIXTURES) {
    it(`${name}: recorded failed, with the reason, exactly as a local run records it`, async () => {
      await withWorld({ client: withClient(name) }, async ({ ythril, pass }) => {
        const r = await pass();
        assert.equal(r.code, 0, everything(r));
        const entry = byKey(ythril)[KEY];
        assert.ok(entry, `the ${name} run left no client record: ${everything(r)}`);
        const p = entry.properties;
        assert.equal(p.outcome, 'failed');
        assert.deepEqual({ files: p.files, tests: p.tests, passed: p.passed, failed: p.failed, skipped: p.skipped }, counts);
        const listed = measurementsOf(entry).files.flatMap(f => (f.failures ?? []).map(k => ({ file: f.file, ...k })));
        assert.equal(listed.length, counts.failed, JSON.stringify(listed));
        for (const want of failures) {
          const got = listed.find(k => k.file.endsWith(want.file));
          assert.ok(got, `no failure names ${want.file}: ${JSON.stringify(listed)}`);
          assert.match(got.test, want.test);
          if (want.message instanceof RegExp) assert.match(got.message, want.message); else assert.equal(got.message, want.message);
        }
      });
    });
  }

  const STAMPS = [
    ['a runner stamp of `failure` on a report that counts no failure', (r) => { r.runnerOutcome = 'failure'; }, 'incomplete'],
    ['a test still pending', (r) => { r.testResults[0].assertionResults[0].status = 'pending'; }, 'incomplete'],
    ['a runner stamp of `success`', (r) => { r.runnerOutcome = 'success'; }, 'passed'],
  ];
  for (const [what, mutate, outcome] of STAMPS) {
    it(`${what} (the stamp survives the real mask step) → ${outcome}`, async () => {
      await withWorld({ client: withClient('passed', mutate) }, async ({ ythril, pass }) => {
        const r = await pass();
        assert.equal(r.code, 0, everything(r));
        assert.ok(byKey(ythril)[KEY], `no client record: ${everything(r)}`);
        assert.equal(byKey(ythril)[KEY].properties.outcome, outcome);
      });
    });
  }

  it('spec files named after Object.prototype members are four files in the record', async () => {
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const client = withClient('passed', (r) => { r.testResults = names.map((name, i) => ({ ...structuredClone(r.testResults[i % 2]), name })); });
    await withWorld({ client }, async ({ ythril, pass }) => {
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      const entry = byKey(ythril)[KEY];
      assert.ok(entry, `no client record: ${everything(r)}`);
      assert.equal(entry.properties.files, 4);
      assert.deepEqual(measurementsOf(entry).files.map(f => f.file).sort(), [...names].sort());
    });
  });
});

describe('masking is held through this door as well: the same secrets, masked in title, message and path', () => {
  const SECRETS = [TOKEN, 'ythril_abcdef0123456789ABCDEF', 'opaque-credential-0123456789'];
  const outsidePath = (r) => { r.testResults[0].name = `C:\\Users\\Menne\\secret-project\\${TOKEN}.spec.ts`; };
  const cases = [
    ['an artifact the real mask step made', { masked: true }],
    ['an artifact that reached the recorder unmasked (the recorder masks for itself)', { masked: false }],
  ];
  for (const [what, options] of cases) {
    it(`${what}: no secret, no stack, no home path is written, and the failure is still recorded`, async () => {
      await withWorld({ client: withClient('secret', outsidePath, options) }, async ({ ythril, pass }) => {
        const r = await pass();
        assert.equal(r.code, 0, everything(r));
        assert.ok(byKey(ythril)[KEY], `no client record: ${everything(r)}`);
        const sent = JSON.stringify(ythril.calls.map(c => c.args));
        for (const leaked of [...SECRETS, 'Menne', 'secret-project']) assert.ok(!sent.includes(leaked), `${leaked} was written`);
        assert.ok(!sent.includes('chunk-hooks'), 'a stack frame was written');
        assert.ok(sent.includes('title leaks'), 'the failure is recorded with its (masked) title');
        assert.ok(!everything(r).includes(TOKEN));
      });
    });
  }
});

describe('an artifact that cannot say what the client did is a problem of that job, said once, never quoting it', () => {
  const clientArtifactOf = (entries) => clientArtifactFromEntries(7002, entries);
  const PROBLEMS = [
    ['no client.json in it at all', clientArtifactOf([{ name: 'readme.txt', data: 'nothing here' }])],
    ['client.json under a folder, not at the top (an exact entry name is read)', clientArtifactOf([{ name: 'nested/client.json', data: JSON.stringify(ciReport('passed')) }])],
    ['a client.json that does not parse, with a token in it', clientArtifactOf([{ name: 'client.json', data: `{"testResults": [ ${TOKEN} ` }])],
    ['a client.json that is not a report', clientArtifactOf([{ name: 'client.json', data: JSON.stringify({ secret: TOKEN }) }])],
    ['a report whose start no Date holds', clientArtifactOf([{ name: 'client.json', data: JSON.stringify({ ...ciReport('passed'), startTime: 8.64e15 + 1 }) }])],
  ];
  for (const [what, client] of PROBLEMS) {
    it(`${what}: the job is named with the reason, the node job's record stands, the report is not quoted`, async () => {
      await withWorld({ client }, async ({ ythril, pass }) => {
        const r = await pass();
        assert.deepEqual(keysOf(ythril), [NODE_KEY], 'the node job\'s record was lost with the client\'s, or a record was invented for the client');
        const said = everything(r).split(/\r?\n/).filter(l => /client-tests/.test(l));
        assert.ok(said.length >= 1, `no line names the client job:\n${everything(r)}`);
        assert.ok(said.some(l => /client\.json|report/i.test(l)), `no line says what was missing or unreadable:\n${said.join('\n')}`);
        assert.equal(r.code, 1, 'a run whose client job left nothing readable is not a clean pass');
        assert.ok(!everything(r).includes(TOKEN), 'the artifact was quoted');
        assert.doesNotMatch(everything(r), /Unexpected token|is not valid JSON|position \d+|RangeError|Invalid time value/);
      });
    });
  }

  it('it is persistent: the next pass says it again without failing, and does not walk past the recorded run', async () => {
    await withWorld({ client: clientArtifactOf([{ name: 'readme.txt', data: 'nothing here' }]) }, async ({ ythril, pass }) => {
      await pass();
      const before = keysOf(ythril);
      const again = await pass();
      assert.equal(again.code, 0, `a run recorded but for an artifact that can never be read fails every pass: ${everything(again)}`);
      assert.deepEqual(keysOf(ythril), before);
      assert.match(everything(again), /client-tests/, 'the unreadable artifact is no longer said anywhere');
    });
  });

  it('a run whose client job left NO artifact at all is recorded without it: that is a job that died, not a report to read', async () => {
    await withWorld({ client: null }, async ({ ythril, pass }) => {
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(keysOf(ythril), [NODE_KEY]);
    });
  });
});

describe('the client job counts for the stop rule: a complete run is not downloaded again', () => {
  it('after one pass records every job, the next downloads no artifact and writes nothing', async () => {
    await withWorld({ client: withClient('passed') }, async ({ github, ythril, pass }) => {
      const first = await pass();
      assert.equal(first.code, 0, everything(first));
      assert.deepEqual(keysOf(ythril), [KEY, NODE_KEY].sort());
      assert.ok(zipRequests(github, 0).length >= 2, 'the first pass downloaded the artifacts it records from — the counter is not counting');
      const sent = github.requests.length;
      const saves = ythril.callsTo('save_chrono').length;
      const second = await pass();
      assert.equal(second.code, 0, everything(second));
      assert.deepEqual(zipRequests(github, sent).map(q => q.path), [], 'a pass over a complete run downloaded artifacts to prove it complete: the client job has no record, so the run never reads as recorded');
      assert.equal(ythril.callsTo('save_chrono').length, saves, 'a record was written for a complete run');
    });
  });

  it('a run lacking only the client record gets that one record, and the node record it has is left alone', async () => {
    await withWorld({ client: withClient('passed') }, async ({ github, ythril, pass }) => {
      await pass();
      const at = ythril.store.findIndex(e => e.properties.recordKey === KEY);
      assert.ok(at >= 0, 'the first pass did not record the client job');
      ythril.store.splice(at, 1);
      const sent = github.requests.length;
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(keysOf(ythril), [KEY, NODE_KEY].sort());
      assert.equal(ythril.callsTo('update_chrono').length, 0, 'a record the run already had was written again');
      assert.ok(!zipRequests(github, sent).some(q => q.path.includes('7001')), 'the node job\'s artifact was downloaded again');
    });
  });

  it('`--rewrite` of the client\'s key records it again from its own artifact', async () => {
    await withWorld({ client: withClient('passed') }, async ({ ythril, pass }) => {
      await pass();
      const entry = byKey(ythril)[KEY];
      assert.ok(entry, 'the first pass did not record the client job');
      entry.properties.ms = 1;
      const r = await pass(['--rewrite', KEY]);
      assert.equal(r.code, 0, everything(r));
      assert.equal(ythril.store.filter(e => e.properties.recordKey === KEY).length, 1);
      assert.notEqual(byKey(ythril)[KEY].properties.ms, 1);
    });
  });
});

describe('the fakes speak the API as it is: a job is named by its display name', () => {
  it('serves `Client tests` and `Prepare`, never the job ids the artifact names carry', () => {
    const names = githubJobs('client-tests', 'prepare', 'standalone-pure').map(j => j.name);
    assert.deepEqual(names, ['Client tests', 'Prepare', 'Standalone (no services)']);
  });
});
