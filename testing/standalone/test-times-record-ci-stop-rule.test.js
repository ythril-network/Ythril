/**
 * Where `scripts/test-times.mjs --record-ci` stops its walk, and what it writes for a run it can no longer read
 * (bundle-56 round S, R3 — three edges of the rule round R put in place for a PARTLY recorded run).
 *
 * ## The rule, and the three ways it was wrong
 *
 * The walk goes newest run first and stops at the first run that is RECORDED: the instance holds a record of it, and every
 * job whose results artifact the run still lists has one. A run recorded in part is completed (the jobs it lacks are
 * written, the ones it has are left alone) and the walk goes on. Round R decided "recorded" by building every payload of
 * every run it met, which broke three ways:
 *
 * - **Expired artifacts.** A run recorded completely whose artifacts have since aged out (GitHub keeps them 30 days) built a
 *   `workflow` / `ci` row with `measurements: 'none'`, whose key the instance did not hold, so a spurious row was written
 *   for a run that already had real ones, and the walk did not stop. A run with records on the instance and nothing left
 *   to read is recorded.
 * - **A persistently unusable artifact.** A run recorded but for one artifact that cannot be read (a file that is not a
 *   zip, one past the size cap) could never be the stop: every pass walked back to the horizon and exited 1, for ever. Such a
 *   run is the stop; what it could not read is said, and it is not a failure of THIS pass. (A download that fails is not
 *   persistent: that one is tried again.)
 * - **The cost of proving a complete run.** The newest run, already complete, had its jobs, its artifact list and EVERY zip
 *   fetched on every pass to show that nothing was missing. It is decided from the artifact LIST and the keys the instance
 *   holds, and no zip is downloaded for it.
 *
 * The granularity of "every job has a record" is the job: a job whose artifact holds two suites and has one record is
 * taken as recorded (`--rewrite <recordKey>` replaces a record on purpose).
 *
 * Local servers only; nothing here reaches github.com or a real instance.
 *
 * Run: node --test testing/standalone/test-times-record-ci-stop-rule.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRecordingWorld, keysOf, zipRequests, everything, SHA, T, githubRun as run, githubJobs, resultsArtifact as artifact } from '../_shared/test-times-harness.mjs';

const spec = (suite, batch, file) => ({ suite, batch, files: [{ file, ms: 5000, tests: [T('one', 2000), T('two', 3000)] }] });
const NOT_A_ZIP = Buffer.from('this is not a zip archive, whatever its name says');

/** Run 2001 is the newest; 2000 is older. Each has two jobs, each with a results artifact. */
function world({ garbage = false } = {}) {
  const runs = [
    run(2001, { head_sha: SHA('2'), run_started_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:20:00Z' }),
    run(2000, { head_sha: SHA('1'), run_started_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:20:00Z' }),
  ];
  const pure = (id) => artifact(id, 'test-results-standalone-pure-1', ['standalone-pure.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')]);
  const integration = (id) => (garbage
    ? { id, name: 'test-results-integration-1', zip: NOT_A_ZIP }
    : artifact(id, 'test-results-integration-1', ['integration-all.jsonl', spec('integration', 'all', 'testing/integration/i.test.js')]));
  return {
    runs,
    jobsByRun: { 2001: githubJobs('prepare', 'standalone-pure', 'integration'), 2000: githubJobs('prepare', 'standalone-pure', 'integration') },
    artifactsByRun: { 2001: [pure(6001), integration(6002)], 2000: [pure(6003), artifact(6004, 'test-results-integration-1', ['integration-all.jsonl', spec('integration', 'all', 'testing/integration/i.test.js')])] },
  };
}

const withWorld = (opts, body) => withRecordingWorld(world(opts), body);

describe('--record-ci: where the walk stops', () => {
  it('a run recorded completely whose artifacts have EXPIRED is recorded: no `none` row is written for it, and the walk stops there', async () => {
    const w = world();
    await withRecordingWorld(w, async ({ ythril, pass }) => {
      const first = await pass();
      assert.equal(first.code, 0, everything(first));
      const recorded = keysOf(ythril);
      assert.deepEqual(recorded, [
        'ci:2000:1:integration:integration', 'ci:2000:1:standalone-pure:standalone',
        'ci:2001:1:integration:integration', 'ci:2001:1:standalone-pure:standalone',
      ]);
      // GitHub's retention passes: the list still names the artifacts, and they are expired.
      for (const a of w.artifactsByRun[2001]) a.expired = true;
      // The older run's records are gone from the instance, which a walk that stopped at 2001 never notices.
      ythril.store.splice(0, ythril.store.length, ...ythril.store.filter(e => e.properties.runId === '2001'));
      const second = await pass();
      assert.equal(second.code, 0, everything(second));
      assert.deepEqual(keysOf(ythril), ['ci:2001:1:integration:integration', 'ci:2001:1:standalone-pure:standalone'],
        'a record was written for a run that was already recorded (a `workflow` row for its expired artifacts, or one of the run before it)');
      assert.ok(!keysOf(ythril).some(k => k.includes(':workflow:')), 'a measurements-none row was written for a recorded run');
    });
  });

  it('a run with NOTHING recorded and nothing left to read is still written once as `none`, so it is not fetched again', async () => {
    const w = world();
    for (const a of w.artifactsByRun[2001]) a.expired = true;
    await withRecordingWorld(w, async ({ ythril, pass }) => {
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      assert.ok(keysOf(ythril).includes('ci:2001:1:workflow:ci'), `the run that left nothing measurable was not recorded as that: ${keysOf(ythril)}`);
    });
  });

  it('a recorded run with an artifact that can never be read is the stop, and the pass does not fail for it, now or ever', async () => {
    await withWorld({ garbage: true }, async ({ github, ythril, pass }) => {
      const first = await pass();
      // Nothing of run 2001 was recorded when this pass began, so its unreadable artifact is this pass's to report.
      assert.ok(keysOf(ythril).includes('ci:2001:1:standalone-pure:standalone'), 'the readable job of the run was not recorded');
      assert.ok(!keysOf(ythril).includes('ci:2001:1:integration:integration'), 'an unreadable artifact produced a record');
      assert.equal(first.code, 1, 'the first pass has an artifact it cannot read and says so with its exit code');
      // The older run's records are lost from the instance; a walk that has stopped at 2001 does not go back for them.
      ythril.store.splice(0, ythril.store.length, ...ythril.store.filter(e => e.properties.runId === '2001'));
      const before = keysOf(ythril);
      const sent = github.requests.length;
      for (const n of [2, 3]) {
        const again = await pass();
        assert.equal(again.code, 0, `pass ${n} exits ${again.code} for a run recorded but for an artifact that cannot be read: ${everything(again)}`);
        assert.deepEqual(keysOf(ythril), before, `pass ${n} walked past the recorded run (its older run was recorded again)`);
      }
      assert.ok(!github.requests.slice(sent).some(q => /\/actions\/runs\/2000\//.test(q.path)), 'the walk went on to the run before the recorded one');
      assert.match(everything(await pass()), /integration/, 'the unreadable artifact is no longer said anywhere');
    });
  });

  it('a complete newest run is decided from the artifact LIST and the recorded keys: no zip is downloaded for it', async () => {
    await withWorld({}, async ({ github, ythril, pass }) => {
      const first = await pass();
      assert.equal(first.code, 0, everything(first));
      assert.ok(zipRequests(github, 0).length >= 4, 'the first pass downloaded the zips it records from — the counter is not counting');
      const sent = github.requests.length;
      const savesBefore = ythril.callsTo('save_chrono').length;
      const second = await pass();
      assert.equal(second.code, 0, everything(second));
      assert.deepEqual(zipRequests(github, sent).map(q => q.path), [], 'a pass over a complete run downloaded artifacts to prove it complete');
      assert.equal(ythril.callsTo('save_chrono').length, savesBefore, 'a record was written for a complete run');
      assert.ok(github.requests.slice(sent).some(q => /\/actions\/runs\/2001\/artifacts/.test(q.path)), 'the newest run\'s artifact list was not read, so its completeness was decided by nothing');
    });
  });

  it('a run that lacks the record of one job is completed: only that job\'s artifact is downloaded and written', async () => {
    await withWorld({}, async ({ github, ythril, pass }) => {
      await pass();
      const at = ythril.store.findIndex(e => e.properties.recordKey === 'ci:2001:1:integration:integration');
      assert.ok(at >= 0);
      ythril.store.splice(at, 1);
      const sent = github.requests.length;
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      assert.ok(keysOf(ythril).includes('ci:2001:1:integration:integration'), 'the missing job was not written back');
      const fetched = zipRequests(github, sent).map(q => q.path).join(' ');
      assert.ok(!/6001/.test(fetched), 'the artifact of the job that already had its record was downloaded again');
    });
  });
});

// ── a run with more than one attempt (Q-948) ─────────────────────────────────────────────────────────────────────────────
//
// Every attempt of a run is recorded, so "recorded completely" is decided per (attempt, job): the walk stops at a run when every
// non-expired results artifact of every attempt it lists has its record.

describe('--record-ci: attempts and the stop rule', () => {
  const pure = (id, attempt) => artifact(id, `test-results-standalone-pure-${attempt}`, ['standalone-pure.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')]);
  const worldWithAttempts = () => ({
    runs: [
      run(2001, { head_sha: SHA('2'), run_attempt: 2, run_started_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:20:00Z' }),
      run(2000, { head_sha: SHA('1'), run_started_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:20:00Z' }),
    ],
    jobsByRun: { 2001: githubJobs('prepare', 'standalone-pure'), 2000: githubJobs('prepare', 'standalone-pure') },
    artifactsByRun: { 2001: [pure(6101, 1), pure(6102, 2)], 2000: [pure(6103, 1)] },
  });

  it('a run recorded at attempt 2 only is not complete while attempt 1\'s artifact is listed: attempt 1 is written and the walk goes on', async () => {
    await withRecordingWorld(worldWithAttempts(), async ({ ythril, pass }) => {
      assert.equal((await pass()).code, 0);
      // The instance holds the newest attempt of the newest run, as a recorder that kept only the newest attempt left it.
      ythril.store.splice(0, ythril.store.length, ...ythril.store.filter(e => e.properties.recordKey === 'ci:2001:2:standalone-pure:standalone'));
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(keysOf(ythril), ['ci:2000:1:standalone-pure:standalone', 'ci:2001:1:standalone-pure:standalone', 'ci:2001:2:standalone-pure:standalone'],
        'the run holding only its attempt 2 was taken as recorded');
    });
  });

  it('a recorded run that gains an attempt is completed by the next pass: only the new attempt is downloaded and written', async () => {
    const w = worldWithAttempts();
    w.runs[0].run_attempt = 1;
    w.artifactsByRun[9999] = [pure(6102, 2)]; // the fake serves the bytes of every artifact it was given; run 9999 is never listed
    w.artifactsByRun[2001] = [pure(6101, 1)];
    await withRecordingWorld(w, async ({ github, ythril, pass }) => {
      assert.equal((await pass()).code, 0);
      assert.deepEqual(keysOf(ythril), ['ci:2000:1:standalone-pure:standalone', 'ci:2001:1:standalone-pure:standalone']);
      w.runs[0].run_attempt = 2; // the run was re-run
      w.artifactsByRun[2001] = [pure(6101, 1), pure(6102, 2)];
      const sent = github.requests.length;
      const r = await pass();
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(keysOf(ythril), ['ci:2000:1:standalone-pure:standalone', 'ci:2001:1:standalone-pure:standalone', 'ci:2001:2:standalone-pure:standalone']);
      const fetched = zipRequests(github, sent).map(q => q.path).join(' ');
      assert.ok(/6102/.test(fetched) && !/6101/.test(fetched), `only attempt 2's artifact is downloaded: ${fetched}`);
    });
  });

  it('a gained attempt of a run BEHIND a recorded run is not found by the bare pass (it stops at the recorded run) and is by naming the run', async () => {
    const w = worldWithAttempts();
    w.runs[0].run_attempt = 1;
    w.artifactsByRun[9999] = [pure(6104, 2)]; // never listed; the fake serves its bytes once run 2000 lists it
    w.artifactsByRun[2001] = [pure(6101, 1)];
    await withRecordingWorld(w, async ({ ythril, pass }) => {
      assert.equal((await pass()).code, 0);
      w.runs[1].run_attempt = 2; // the OLDER run is re-run
      w.artifactsByRun[2000] = [pure(6103, 1), pure(6104, 2)];
      assert.equal((await pass()).code, 0);
      assert.ok(!keysOf(ythril).includes('ci:2000:2:standalone-pure:standalone'), 'the bare pass walked past a recorded run');
      const named = await pass(['--record-ci', '2000']);
      assert.equal(named.code, 0, everything(named));
      assert.ok(keysOf(ythril).includes('ci:2000:2:standalone-pure:standalone'), 'naming the run did not record its new attempt');
    });
  });
});
