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
import { FAKE_GH_TOKEN } from '../_shared/fake-github-actions.mjs';
import { withRecordingWorld, propertiesByKey as records, runTimes, everything, REPO, SHA, T, githubRun as run, githubJobs, resultsArtifact as artifact } from '../_shared/test-times-harness.mjs';

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
  const jobsByRun = {
    1001: githubJobs('prepare', 'standalone-pure', 'integration', 'test'),
    1002: githubJobs('prepare', 'standalone-pure'), 1003: githubJobs('prepare'), 1004: [{ name: 'release' }], 1005: [{ name: 'Build & Test' }],
    1006: githubJobs('prepare', 'standalone-pure'),
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

const withWorld = (body) => withRecordingWorld(world(), body);

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

// ── `--record-ci <runId>`: the run a caller waits for is NAMED, and a pass that did not list it fails (Q-402) ────────────
//
// What this prevents: a caller that has just seen run N finish asks the recorder to record it. The listing the recorder reads
// is a page of completed pushes, and when that page is older than N (the real defect: its first page held only older runs)
// the pass listed nothing of N, recorded what it found, said "recorded 0 record(s)" and exited 0 — a success that recorded
// nothing of the run asked for. Naming the run turns "not listed" into a failure the caller sees, and the refusal comes
// BEFORE the walk writes anything, so a failed pass leaves no half of a different run behind.

/** A tool of the fake instance that changes what it holds. */
const WRITE_TOOLS = ['save_chrono', 'update_chrono', 'delete_chrono'];
const writesTo = (ythril) => ythril.calls.filter(c => WRITE_TOOLS.includes(c.tool));

/**
 * The bound on how long a pass that names a run reads the listing again, and the pause between two reads, in tens of
 * milliseconds: the script is spawned, so the bound reaches it through its environment, and no test sleeps a real interval.
 * Without these the script waits its default (three minutes) for a run that never comes.
 */
const WAIT_ENV = 'YTHRIL_TEST_RUNS_LISTING_WAIT_MS';
const INTERVAL_ENV = 'YTHRIL_TEST_RUNS_LISTING_INTERVAL_MS';
const WAIT_MS = 400;
const INTERVAL_MS = 40;
const SHORT_WAIT = { [WAIT_ENV]: String(WAIT_MS), [INTERVAL_ENV]: String(INTERVAL_MS) };

/** The ids of the runs `trustedRuns` admits and of the ones it must refuse (1008 is added by {@link worldWithFullRun}). */
const TRUSTED_IDS = ['1001', '1007'];
const UNTRUSTED_IDS = ['1002', '1003', '1004', '1005', '1008'];

/** `world()` plus a full-run run (a push to `full-run/x` from `full-run.yml`: listed by the API, never trusted). */
function worldWithFullRun() {
  const w = world();
  w.runs.push(run(1008, { path: '.github/workflows/full-run.yml', name: 'Full run', head_branch: 'full-run/x', head_sha: SHA('8') }));
  w.artifactsByRun[1008] = [artifact(5009, 'test-results-standalone-pure-1', ['standalone-pure.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')])];
  return w;
}

describe('--record-ci <runId>', () => {
  for (const id of TRUSTED_IDS) {
    it(`run ${id} is listed and trusted: the pass records as it does without a name, and exits 0`, async () => {
      await withRecordingWorld(worldWithFullRun(), async ({ ythril, dir, env }) => {
        const r = await runTimes(['--record-ci', id], { cwd: dir, env });
        assert.equal(r.code, 0, everything(r));
        assert.deepEqual(Object.keys(records(ythril)).sort(), [
          'ci:1001:1:integration:integration',
          'ci:1001:1:standalone-pure:standalone',
          'ci:1007:1:build-and-test:standalone',
        ], 'the named run, and the trusted run the walk records beside it, are recorded; nothing of an untrusted one');
        assert.ok(Object.keys(records(ythril)).some(k => k.startsWith(`ci:${id}:`)), `a record of the named run ${id} exists`);
      });
    });
  }

  it('a run that is NOT in the listing fails the pass (exit 1), says so, and writes no record at all', async () => {
    // The listing holds runs 1001..1008 and no 2000: the shape of the defect, a named run newer than everything the page listed.
    await withRecordingWorld(worldWithFullRun(), async ({ github, ythril, dir, env }) => {
      const r = await runTimes(['--record-ci', '2000'], { cwd: dir, env: { ...env, ...SHORT_WAIT } });
      assert.equal(r.code, 1, everything(r));
      assert.match(everything(r), /not in the listing of completed pushes to main/, 'says the run was not listed');
      assert.match(everything(r), /\b2000\b/, 'names the run it did not find');
      assert.match(everything(r), /stale/i, 'says the listing may be stale');
      assert.match(everything(r), /not (?:a )?trusted/i, 'says the run may not be a trusted one');
      assert.ok(!/recorded 0 record/.test(everything(r)), 'a pass that did not list the run never reports a quiet "recorded 0"');
      assert.deepEqual(writesTo(ythril), [], 'the trusted runs that WERE listed were written anyway: the refusal came after the walk, not before it');
      assert.deepEqual(ythril.store.map(e => e._id), [], 'the instance holds a record from a pass that failed');
      assert.deepEqual(Object.keys(records(ythril)), []);
      assert.ok(github.requests.length > 0, 'the listing was fetched (the run is looked for in it)');
    });
  });

  for (const id of UNTRUSTED_IDS) {
    it(`run ${id} is listed but not trusted: exit 1 with its own message, nothing written, its artifacts never asked for`, async () => {
      await withRecordingWorld(worldWithFullRun(), async ({ github, ythril, dir, env }) => {
        const r = await runTimes(['--record-ci', id], { cwd: dir, env });
        assert.equal(r.code, 1, everything(r));
        assert.match(everything(r), /not a trusted run/, 'says it is not a trusted run');
        assert.match(everything(r), new RegExp(`\\b${id}\\b`), 'names the run');
        assert.ok(!/not in the listing/.test(everything(r)), 'it IS in the listing: "not listed" would send the caller to wait for a page that will never hold it');
        assert.deepEqual(writesTo(ythril), [], 'a pass that refused the named run still wrote');
        assert.deepEqual(ythril.store.map(e => e._id), []);
        assert.ok(!github.askedAbout().has(id), `an untrusted run's artifacts were requested (${[...github.askedAbout()].join(', ')})`);
      });
    });
  }

  // Refused before the listing is fetched: not a request of any kind, to either server. Every one of these is
  // refused by today's argument check too (it takes no extra argument), so the test holds what it SAYS — the
  // reason is the id's, never the usage text — and not the exit code alone.
  for (const bad of ['abc', '0', '12.5', '-5', '1e3', '0x10', '+7', '', ' 12', '99999999999999999999']) {
    it(`the id ${JSON.stringify(bad)} is refused before any request, as not a positive integer`, async () => {
      await withRecordingWorld(worldWithFullRun(), async ({ github, ythril, dir, env }) => {
        const r = await runTimes(['--record-ci', bad], { cwd: dir, env });
        assert.equal(r.code, 1, everything(r));
        assert.match(r.stderr, /positive integer/i, `the refusal names what is wrong with the id:\n${r.stderr}`);
        assert.ok(!r.stderr.includes('usage: node scripts/test-times.mjs'), 'an id that is not valid is not the usage text');
        assert.deepEqual(github.requests, [], 'the Actions API was asked something before the id was validated');
        assert.deepEqual(ythril.calls, [], 'the Ythril instance was asked something before the id was validated');
      });
    });
  }

  it('is still refused under CI before any request, like the bare form', async () => {
    await withRecordingWorld(world(), async ({ github, ythril, dir, env }) => {
      const r = await runTimes(['--record-ci', '1001'], { cwd: dir, env: { ...env, GITHUB_ACTIONS: 'true' } });
      assert.equal(r.code, 1, everything(r));
      assert.match(r.stderr, /GITHUB_ACTIONS|\bCI\b/);
      assert.ok(!r.stderr.includes('usage: node scripts/test-times.mjs'), 'refused for CI, not as an unknown argument');
      assert.deepEqual(github.requests, []);
      assert.deepEqual(ythril.calls, []);
    });
  });
});

// ── A listing that lags behind the run that has just finished (Q-403) ──────────────────────────────────────────────────
//
// What this prevents: a caller that has just seen run N finish asks for it at once, and the listing is a page that GitHub
// builds a little behind the run it lists. Refusing on the first read made a pass fail about a run that was seconds away
// from being listed, and the caller's only recourse was to sleep and try again by hand. A pass that NAMES a run reads the
// listing again, up to a bound, before it refuses; the passes that name nothing read once, as they always did.

/** The run the lagging listing is late with, and the results it left. */
const LATE_RUN = 2000;

/**
 * `worldWithFullRun()` whose listing lacks run {@link LATE_RUN} on its first `staleReads` reads and holds it from the next
 * one on, which is how a listing catches up. `staleReads: Infinity` is a listing that never does.
 */
function laggingWorld(staleReads) {
  const w = worldWithFullRun();
  const stale = w.runs;
  const fresh = [...stale, run(LATE_RUN, { head_sha: SHA('2') })];
  w.artifactsByRun[LATE_RUN] = [artifact(5010, 'test-results-standalone-pure-1', ['standalone-pure.jsonl', spec('standalone', 'pure', 'testing/standalone/a.test.js')])];
  w.listings = staleReads === Infinity ? [stale] : [...Array(staleReads).fill(stale), fresh];
  return w;
}

describe('--record-ci <runId> against a listing that lags', () => {
  it('reads the listing again until the named run is in it, then records it and exits 0', async () => {
    await withRecordingWorld(laggingWorld(2), async ({ github, ythril, dir, env }) => {
      const r = await runTimes(['--record-ci', String(LATE_RUN)], { cwd: dir, env: { ...env, ...SHORT_WAIT } });
      assert.equal(r.code, 0, everything(r));
      assert.equal(github.listingReads(), 3, 'the listing was read once per answer it needed (two stale, then the one that held the run), and not again after it held it');
      assert.ok(Object.keys(records(ythril)).includes(`ci:${LATE_RUN}:1:standalone-pure:standalone`), `the named run was recorded:\n${everything(r)}`);
      assert.ok(github.askedAbout().has(String(LATE_RUN)), 'the named run\'s artifacts were read');
      assert.ok(!/not in the listing/.test(everything(r)), 'a run that arrived in time is not refused');
    });
  });

  it('a listing that is stale on every read refuses after the bound, says it read again for that long, and writes nothing', async () => {
    await withRecordingWorld(laggingWorld(Infinity), async ({ github, ythril, dir, env }) => {
      const started = Date.now();
      const r = await runTimes(['--record-ci', String(LATE_RUN)], { cwd: dir, env: { ...env, ...SHORT_WAIT } });
      const elapsed = Date.now() - started;
      assert.equal(r.code, 1, everything(r));
      assert.ok(elapsed >= WAIT_MS, `the pass refused after ${elapsed}ms, before its ${WAIT_MS}ms bound`);
      assert.match(everything(r), /not in the listing of completed pushes to main/, 'the refusal is the one a pass without a wait gives');
      assert.match(everything(r), new RegExp(`\\b${LATE_RUN}\\b`), 'names the run it did not find');
      assert.match(everything(r), new RegExp(`read again for ${WAIT_MS}ms`), `says how long the listing was read again:\n${everything(r)}`);
      assert.ok(github.listingReads() >= 2, `the listing was read ${github.listingReads()} time(s): not again`);
      assert.ok(github.listingReads() <= WAIT_MS / INTERVAL_MS + 3, `the listing was read ${github.listingReads()} times in ${WAIT_MS}ms: the interval of ${INTERVAL_MS}ms was not kept`);
      assert.deepEqual(writesTo(ythril), [], 'a pass that refused the named run wrote');
      assert.deepEqual(ythril.store.map(e => e._id), [], 'the instance holds a record from a pass that failed');
      assert.ok(!github.askedAbout().has(String(LATE_RUN)));
    });
  });

  it('a run that is listed but not trusted is not waited for: it is refused on the first read, with no mention of a wait', async () => {
    await withRecordingWorld(laggingWorld(Infinity), async ({ github, ythril, dir, env }) => {
      const r = await runTimes(['--record-ci', '1002'], { cwd: dir, env: { ...env, ...SHORT_WAIT } });
      assert.equal(r.code, 1, everything(r));
      assert.match(everything(r), /not a trusted run/);
      assert.equal(github.listingReads(), 1, 'a page that holds the run and will not trust it was read again');
      assert.ok(!/read again/.test(everything(r)));
      assert.deepEqual(writesTo(ythril), []);
    });
  });

  it('a run already listed and trusted is taken on the first read', async () => {
    await withRecordingWorld(laggingWorld(Infinity), async ({ github, dir, env }) => {
      const r = await runTimes(['--record-ci', '1001'], { cwd: dir, env: { ...env, ...SHORT_WAIT } });
      assert.equal(r.code, 0, everything(r));
      assert.equal(github.listingReads(), 1);
    });
  });

  it('a pass that names nothing reads the listing once, whatever the bound says', async () => {
    await withRecordingWorld(laggingWorld(Infinity), async ({ github, dir, env }) => {
      const r = await runTimes(['--record-ci'], { cwd: dir, env: { ...env, ...SHORT_WAIT } });
      assert.equal(r.code, 0, everything(r));
      assert.equal(github.listingReads(), 1);
    });
  });

  it('--rewrite of a run the listing lacks reads the listing once and refuses as it did', async () => {
    await withRecordingWorld(laggingWorld(Infinity), async ({ github, ythril, dir, env }) => {
      const r = await runTimes(['--rewrite', `ci:${LATE_RUN}:1:standalone-pure:standalone`], { cwd: dir, env: { ...env, ...SHORT_WAIT } });
      assert.equal(r.code, 1, everything(r));
      assert.match(everything(r), /not in the listing of completed pushes to main/);
      assert.equal(github.listingReads(), 1, 'a rewrite waited for a run');
      assert.ok(!/read again/.test(everything(r)));
      assert.deepEqual(writesTo(ythril), []);
    });
  });

  for (const [name, bad] of [[WAIT_ENV, 'abc'], [WAIT_ENV, '0'], [WAIT_ENV, '-5'], [WAIT_ENV, '1.5'], [WAIT_ENV, '1e3'], [INTERVAL_ENV, 'abc'], [INTERVAL_ENV, '0'], [INTERVAL_ENV, '-20'], [INTERVAL_ENV, '0x10']]) {
    it(`${name}=${JSON.stringify(bad)} is refused before any request, as not a positive integer`, async () => {
      await withRecordingWorld(laggingWorld(1), async ({ github, ythril, dir, env }) => {
        const r = await runTimes(['--record-ci', String(LATE_RUN)], { cwd: dir, env: { ...env, ...SHORT_WAIT, [name]: bad } });
        assert.equal(r.code, 1, everything(r));
        assert.ok(r.stderr.includes(name), `the refusal names the variable:\n${r.stderr}`);
        assert.match(r.stderr, /positive integer/i);
        assert.ok(!r.stderr.includes('usage: node scripts/test-times.mjs'), 'refused for the value, not as the usage text');
        assert.deepEqual(github.requests, [], 'the Actions API was asked something before the value was validated');
        assert.deepEqual(ythril.calls, [], 'the Ythril instance was asked something before the value was validated');
      });
    });
  }

  it('the help names both variables', async () => {
    await withRecordingWorld(world(), async ({ dir, env }) => {
      const r = await runTimes(['--help'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      for (const name of [WAIT_ENV, INTERVAL_ENV]) assert.ok(r.stdout.includes(name), `--help does not name ${name}`);
    });
  });
});

describe('--record-ci with no name', () => {
  it('still records the trusted runs and prints the newest run it listed, with its id and start, so a stale page shows', async () => {
    const w = world();
    // Distinct starts: run 1007 is the newest trusted run, 1001 the oldest of them. The untrusted runs keep their own start, in between.
    w.runs.find(x => x.id === 1001).run_started_at = '2026-10-04T10:00:00Z';
    w.runs.find(x => x.id === 1007).run_started_at = '2026-10-06T08:30:00Z';
    await withRecordingWorld(w, async ({ ythril, dir, env }) => {
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.equal(Object.keys(records(ythril)).length, 3, 'the bare form records as before');
      const lines = everything(r).split(/\r?\n/);
      assert.ok(lines.some(l => l.includes('1007') && l.includes('2026-10-06T08:30:00')), `no line names the newest listed run (1007) with its start:\n${everything(r)}`);
      assert.ok(!lines.some(l => l.includes('1001') && l.includes('2026-10-04T10:00:00')), 'the OLDEST listed run was named as the newest');
    });
  });
});
