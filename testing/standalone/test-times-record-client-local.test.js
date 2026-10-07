/**
 * `scripts/test-times.mjs --record` records the client's vitest run as a `Test-Run` of suite `client`, like a node suite
 * (bundle-73, Q-378) — from `test-results/client.json`, which `npm run preflight` writes and a person's own
 * `npm run test --workspace=client -- --reporter=json --outputFile.json=...` can.
 *
 * ## What this prevents
 *
 * The client is a third of the run's tests and none of its time was ever recorded: the recorder read only the node
 * reporter's JSONL, and with no `*.jsonl` in `test-results/` it said "nothing to record" about a folder that held a whole
 * client run. Recording it is easy to do wrongly in ways that read as success, so each is pinned against a REAL vitest report
 * (`testing/standalone/_fixtures/client-reports/`, see its README) and not a shape written for the test:
 *
 * - **A failure that is not an assertion.** A file that never collected has no test at all, and a file whose `beforeAll`
 *   threw has tests that are `skipped` and a `message` that is empty. Each is ONE failure, once, with its reason or
 *   `(no message)`; a run in which every file fails at collection is `failed`, not refused as "no test".
 * - **A pass nobody vouched for.** A test still `pending` when the run was cut off, a runner that stamped `failure` on a
 *   report that says nothing failed, a `success: false` with no failure counted: each is `incomplete`, never `passed`.
 * - **A stale report.** `test-results/client.json` outlives the run that wrote it. One that started before the commit being
 *   recorded is not that commit's run: it is a problem named in one line, and the node suites beside it are still recorded.
 * - **One suite's trouble is only that suite's.** A client report that cannot be read must not cost the node records (the
 *   recorder used to be one `try`), and says so without quoting the report; `--rewrite` is the same.
 * - **A leaked secret.** A test title, a failure message and a file path outside the checkout are masked on the way in, the
 *   same as a node suite's; and a hostile number (an epoch no `Date` holds, a negative or infinite time) is never a crash
 *   and never a figure in a record.
 * - **A claim of coverage.** `scope` is `full` only when every `.spec.ts` tracked at the recorded commit is an entry of the
 *   report (a file that failed to collect counts: it is an entry, and the claim is about what was run, not what passed);
 *   baselines are drawn from `full` alone.
 *
 * ## The interface this pins
 *
 * `test-results/client.json` is read by `CLIENT_RESULTS`. One record per run, suite `client`, job `local`, layout `local`,
 * `runId` `local-<start>-<commit7>` with the REPORT's own start (never the file's modification time), `startsAt` that start,
 * `endsAt` the end of its last file, `wallMs` that span, `ms` the sum of the files' own times. `measurements` is the node
 * suites' shape: `{ files: [{ file, ms, tests, skips?, failures?: [{ test, message }] }], slowest: [{ file, test, ms }] }`
 * (or `{ truncated: true, files }` past the ceiling). A report's runner stamp is its top-level `runnerOutcome`
 * (`success`, `failure` or `cancelled`: the runner's own result, written by CI's mask step and by preflight).
 *
 * Local servers only; no real instance.
 *
 * Run: node --test testing/standalone/test-times-record-client-local.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { makeWorkdir, writeResults, writeClientReport, runTimes, everything, T } from '../_shared/test-times-harness.mjs';
import { clientReport, reportSpan, specPaths, FAILURE_FIXTURES } from '../_shared/client-report-fixtures.mjs';

const envFor = (server, extra = {}) => ({ YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token, ...extra });
const PRIMITIVE = new Set(['string', 'number', 'boolean']);
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const A = 'testing/standalone/a.test.js';

/**
 * A scratch repository tracking the spec files of `tracked` fixtures (and any `extra` files), a fake instance, and a way to
 * make the fixture's report as of this checkout: its specs under the repository, its run starting after the commit.
 */
async function withClientRun({ tracked = [], extra = [], git = {} } = {}, body) {
  const server = await startFakeYthril();
  const work = makeWorkdir({ ...git, tracked: [...new Set([...tracked.flatMap(specPaths), ...extra])] });
  const startMs = work.commitMs + 5000;
  const report = (name, at = startMs) => clientReport(name, { root: work.dir, startMs: at });
  try { return await body({ server, work, dir: work.dir, startMs, report, env: envFor(server) }); } finally { await server.close(); work.cleanup(); }
}

const nodeFiles = (dir) => writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('t1', 1)] }] });
const records = (server) => Object.fromEntries(server.store.map(e => [e.properties.suite, e]));
const clientRecord = (server) => records(server).client;
const measurementsOf = (entry) => JSON.parse(entry.properties.measurements);
const clientLines = (r) => everything(r).split(/\r?\n/).filter(l => /client/i.test(l));

/** What the plan says a record's times are, read off the report. */
function spanOf(report) {
  const { startMs, endMs } = reportSpan(report);
  const filesMs = report.testResults.reduce((sum, f) => sum + (Number.isFinite(f.endTime) && Number.isFinite(f.startTime) ? Math.max(0, f.endTime - f.startTime) : 0), 0);
  return { startMs, endMs, wallMs: endMs - startMs, filesMs, files: report.testResults.length };
}

describe('a client report alone is recorded as a Test-Run of suite client', () => {
  it('writes one completed record with the report\'s own figures, clock and files — where the recorder used to say "nothing to record"', async () => {
    await withClientRun({ tracked: ['passed'] }, async ({ server, work, dir, report, env }) => {
      const r0 = report('passed');
      writeClientReport(dir, r0);
      const r = await runTimes(['--record'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.doesNotMatch(everything(r), /nothing to record/, 'a folder holding a whole client run is not nothing');
      assert.equal(server.store.length, 1, everything(r));
      const entry = clientRecord(server);
      assert.ok(entry, `no record of suite client: ${server.store.map(e => e.properties.suite)}`);
      const p = entry.properties;
      for (const [k, v] of Object.entries(p)) assert.ok(PRIMITIVE.has(typeof v), `client.${k} is ${typeof v}; a chrono property is a string, number or boolean`);
      assert.equal(entry.type, 'Test-Run');
      assert.equal(entry.status, 'completed');
      assert.deepEqual({ source: p.source, job: p.job, suite: p.suite, layout: p.layout, formatVersion: p.formatVersion, dirty: p.dirty, commit: p.commit, branch: p.branch },
        { source: 'local', job: 'local', suite: 'client', layout: 'local', formatVersion: 1, dirty: false, commit: work.commit, branch: 'main' });
      assert.deepEqual({ files: p.files, tests: p.tests, passed: p.passed, failed: p.failed, cancelled: p.cancelled, skipped: p.skipped, todo: p.todo, outcome: p.outcome, scope: p.scope },
        { files: 2, tests: 3, passed: 3, failed: 0, cancelled: 0, skipped: 0, todo: 0, outcome: 'passed', scope: 'full' });
      assert.match(p.runId, /^local-/);
      assert.ok(p.runId.endsWith(work.commit.slice(0, 7)), p.runId);
      assert.equal(p.recordKey, `local:${p.runId}:1:local:client`);
      const span = spanOf(r0);
      assert.equal(Date.parse(entry.startsAt), span.startMs, 'startsAt is the report\'s own start, not a file\'s modification time');
      assert.ok(Math.abs(Date.parse(entry.endsAt) - span.endMs) <= 2, `endsAt ${entry.endsAt} is the end of the report's last file`);
      assert.ok(Math.abs(p.wallMs - span.wallMs) <= 2, `wallMs ${p.wallMs} is the report's span ${span.wallMs}`);
      assert.ok(Math.abs(p.ms - span.filesMs) <= span.files + 1, `ms ${p.ms} is the sum of the files' own times ${span.filesMs}`);
      const m = measurementsOf(entry);
      assert.deepEqual(m.files.map(f => f.file).sort(), specPaths('passed').sort(), 'the files are named as the repository names them');
      assert.equal(m.files.reduce((n, f) => n + f.tests, 0), 3);
      assert.ok(m.slowest.length === 3 && m.slowest.every(t => typeof t.test === 'string' && Number.isFinite(t.ms)), `the slowest tests are listed: ${JSON.stringify(m.slowest)}`);
      assert.equal(p.measurementsChars, p.measurements.length);
    });
  });

  it('is recorded beside the node suites, each its own record, and once however often it is run', async () => {
    await withClientRun({ tracked: ['passed'] }, async ({ server, dir, report, env }) => {
      nodeFiles(dir);
      writeClientReport(dir, report('passed'));
      for (let pass = 0; pass < 2; pass++) {
        const r = await runTimes(['--record'], { cwd: dir, env });
        assert.equal(r.code, 0, everything(r));
      }
      assert.deepEqual(server.store.map(e => e.properties.suite).sort(), ['client', 'standalone']);
      assert.equal(server.callsTo('save_chrono').length, 2, 'a second pass wrote a second record of the same run');
    });
  });

  it('keeps the payload when the instance is not configured, under a name that says it is the client\'s', async () => {
    await withClientRun({ tracked: ['passed'] }, async ({ dir, report }) => {
      writeClientReport(dir, report('passed'));
      const r = await runTimes(['--record'], { cwd: dir });
      assert.equal(r.code, 0, everything(r));
      const folder = join(dir, 'test-results', 'unrecorded');
      const kept = existsSync(folder) ? readdirSync(folder).filter(f => f.endsWith('.json')) : [];
      assert.equal(kept.length, 1, everything(r));
      assert.match(kept[0], /client/);
      assert.equal(JSON.parse(readFileSync(join(folder, kept[0]), 'utf8')).properties.suite, 'client');
    });
  });
});

describe('a failure that is not an assertion is one failure, once, and says why', () => {
  for (const [name, counts, failures] of FAILURE_FIXTURES) {
    it(`${name}: outcome failed, ${counts.failed} failure(s) counted, each with its first-line reason`, async () => {
      await withClientRun({ tracked: [name] }, async ({ server, dir, report, env }) => {
        writeClientReport(dir, report(name));
        const r = await runTimes(['--record'], { cwd: dir, env });
        assert.equal(r.code, 0, everything(r));
        const entry = clientRecord(server);
        assert.ok(entry, `a ${name} run was not recorded: ${everything(r)}`);
        const p = entry.properties;
        assert.equal(p.outcome, 'failed', `${name}: a run with a failure is not ${p.outcome}`);
        assert.deepEqual({ files: p.files, tests: p.tests, passed: p.passed, failed: p.failed, skipped: p.skipped }, counts);
        const listed = measurementsOf(entry).files.flatMap(f => (f.failures ?? []).map(k => ({ file: f.file, ...k })));
        assert.equal(listed.length, counts.failed, `${name}: every failure listed once: ${JSON.stringify(listed)}`);
        for (const want of failures) {
          const got = listed.find(k => k.file.endsWith(want.file));
          assert.ok(got, `${name}: no failure names ${want.file}: ${JSON.stringify(listed)}`);
          assert.match(got.test, want.test);
          if (want.message instanceof RegExp) assert.match(got.message, want.message); else assert.equal(got.message, want.message);
        }
        assert.ok(!/\n\s+at /.test(p.measurements), `${name}: a stack was stored`);
      });
    });
  }
});

describe('a pass nobody vouched for is incomplete, never passed', () => {
  const ROWS = [
    ['a test still pending', (r) => { r.testResults[0].assertionResults[0].status = 'pending'; }, 'incomplete'],
    ['a test queued when the run was cut off', (r) => { r.testResults[0].assertionResults[0].status = 'queued'; }, 'incomplete'],
    ['a runner that stamped `failure` on a report that counts no failure', (r) => { r.runnerOutcome = 'failure'; }, 'incomplete'],
    ['a runner that stamped `cancelled`', (r) => { r.runnerOutcome = 'cancelled'; }, 'incomplete'],
    ['`success: false` with no failure counted', (r) => { r.success = false; }, 'incomplete'],
    ['a counted failure under a `failure` stamp: the failure is what it is', (r) => { r.testResults[0].assertionResults[0].status = 'failed'; r.runnerOutcome = 'failure'; }, 'failed'],
    ['a runner that stamped `success`', (r) => { r.runnerOutcome = 'success'; }, 'passed'],
    ['a report from before the stamp existed (the stated limit: it is read as it stands)', () => {}, 'passed'],
  ];
  for (const [what, mutate, outcome] of ROWS) {
    it(`${what} → ${outcome}`, async () => {
      await withClientRun({ tracked: ['passed'] }, async ({ server, dir, report, env }) => {
        const r0 = report('passed');
        mutate(r0);
        writeClientReport(dir, r0);
        const r = await runTimes(['--record'], { cwd: dir, env });
        assert.equal(r.code, 0, everything(r));
        assert.ok(clientRecord(server), `the run was not recorded: ${everything(r)}`);
        assert.equal(clientRecord(server).properties.outcome, outcome);
      });
    });
  }

  it('a pending test is counted as a test (it exists) and not as a pass', async () => {
    await withClientRun({ tracked: ['passed'] }, async ({ server, dir, report, env }) => {
      const r0 = report('passed');
      r0.testResults[0].assertionResults[0].status = 'pending';
      writeClientReport(dir, r0);
      await runTimes(['--record'], { cwd: dir, env });
      assert.ok(clientRecord(server), 'the run was not recorded');
      const p = clientRecord(server).properties;
      assert.equal(p.tests, 3);
      assert.equal(p.passed, 2);
    });
  });
});

describe('scope is full only when every tracked spec is an entry of the report', () => {
  const NOT_RUN = 'client/src/app/never-run.spec.ts';
  const ROWS = [
    ['every tracked spec is an entry', { tracked: ['passed'] }, 'passed', 'full'],
    ['a tracked spec the report does not name', { tracked: ['passed'], extra: [NOT_RUN] }, 'passed', 'subset'],
    ['a file that failed to collect is an entry, so the claim of coverage holds', { tracked: ['collection-failure'] }, 'collection-failure', 'full'],
    ['a tracked file that is not a spec is not asked for', { tracked: ['passed'], extra: ['client/src/app/helper.ts', 'client/src/app/x.spec.ts.md'] }, 'passed', 'full'],
    ['a run of a subset of the specs (one of two tracked fixtures ran)', { tracked: ['passed', 'failed'] }, 'passed', 'subset'],
  ];
  for (const [what, opts, fixture, scope] of ROWS) {
    it(`${what} → ${scope}`, async () => {
      await withClientRun(opts, async ({ server, dir, report, env }) => {
        writeClientReport(dir, report(fixture));
        const r = await runTimes(['--record'], { cwd: dir, env });
        assert.equal(r.code, 0, everything(r));
        assert.ok(clientRecord(server), `the run was not recorded: ${everything(r)}`);
        assert.equal(clientRecord(server).properties.scope, scope);
      });
    });
  }
});

describe('a client report that is not this commit\'s run, or cannot be read, is a problem of its own', () => {
  it('a report that started before the commit is not recorded, says so in one line, and the node records stand', async () => {
    await withClientRun({ tracked: ['passed'] }, async ({ server, work, dir, report, env }) => {
      nodeFiles(dir);
      writeClientReport(dir, report('passed', work.commitMs - 3_600_000));
      const r = await runTimes(['--record'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(server.store.map(e => e.properties.suite), ['standalone'], 'a stale client report was recorded against this commit');
      assert.ok(clientLines(r).some(l => /client report older than this commit/.test(l)), `no line says why the client was not recorded:\n${everything(r)}`);
    });
  });

  it('a stale report alone is a problem, not "nothing to record"', async () => {
    await withClientRun({ tracked: ['passed'] }, async ({ server, work, dir, report, env }) => {
      writeClientReport(dir, report('passed', work.commitMs - 3_600_000));
      const r = await runTimes(['--record'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.store.length, 0);
      assert.match(everything(r), /client report older than this commit/);
    });
  });

  const UNREADABLE = [
    ['JSON cut off mid-way, with a token in it', `{"testResults": [ ${TOKEN} `],
    ['JSON that is not a report', JSON.stringify({ secret: TOKEN })],
    ['an empty file', ''],
  ];
  for (const [what, body] of UNREADABLE) {
    it(`${what}: the node records are written, the client is a named problem, nothing is quoted, exit 0`, async () => {
      await withClientRun({}, async ({ server, dir, env }) => {
        nodeFiles(dir);
        writeClientReport(dir, body);
        const r = await runTimes(['--record'], { cwd: dir, env });
        assert.equal(r.code, 0, everything(r));
        assert.deepEqual(server.store.map(e => e.properties.suite), ['standalone'], 'a bad client report cost the node records');
        assert.ok(clientLines(r).some(l => /not recorded|problem|unreadable|cannot|could not|refused/i.test(l)), `no line says the client was not recorded:\n${everything(r)}`);
        assert.ok(!everything(r).includes(TOKEN), 'the report was quoted');
        assert.doesNotMatch(everything(r), /Unexpected token|is not valid JSON|position \d+/);
      });
    });
  }

  it('`--rewrite` of a node suite is the same: the suite is rewritten whatever the client report is', async () => {
    await withClientRun({}, async ({ server, dir, env }) => {
      nodeFiles(dir);
      await runTimes(['--record'], { cwd: dir, env });
      const key = server.store[0].properties.recordKey;
      writeClientReport(dir, `{"testResults": [ ${TOKEN} `);
      const r = await runTimes(['--rewrite', key], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.store.length, 1);
      assert.ok(server.callsTo('update_chrono').length >= 1, 'the node suite was not rewritten');
      assert.ok(!everything(r).includes(TOKEN));
    });
  });

  it('`--rewrite` of the client\'s own key records it again from the report, in place', async () => {
    await withClientRun({ tracked: ['passed'] }, async ({ server, dir, report, env }) => {
      writeClientReport(dir, report('passed'));
      await runTimes(['--record'], { cwd: dir, env });
      const entry = clientRecord(server);
      assert.ok(entry, 'the first pass did not record the client');
      entry.properties.ms = 1; // a stale earlier write
      const r = await runTimes(['--rewrite', entry.properties.recordKey], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.store.length, 1);
      assert.equal(server.store[0]._id, entry._id, 'a second record was written beside the first');
      assert.notEqual(server.store[0].properties.ms, 1, 'the record was not brought up to date');
    });
  });
});

describe('what the client\'s report says is masked on the way in, and a hostile number is never a crash or a figure', () => {
  const SECRETS = [TOKEN, 'ythril_abcdef0123456789ABCDEF', 'opaque-credential-0123456789'];

  it('a token in a test title and in a failure message, and a stack, are not written', async () => {
    await withClientRun({ tracked: ['secret'] }, async ({ server, dir, report, env }) => {
      writeClientReport(dir, report('secret'));
      const r = await runTimes(['--record'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.ok(clientRecord(server), `the run was not recorded: ${everything(r)}`);
      const sent = JSON.stringify(server.calls.map(c => c.args));
      for (const secret of SECRETS) assert.ok(!sent.includes(secret), `${secret} was written`);
      assert.ok(!sent.includes('chunk-hooks'), 'a stack frame was written');
      assert.ok(sent.includes('title leaks'), 'the failure itself is recorded, with its title (masked) in it');
      assert.ok(!everything(r).includes(TOKEN));
    });
  });

  it('a spec path outside the checkout is masked: no home directory, no token-shaped name', async () => {
    await withClientRun({}, async ({ server, dir, report, env }) => {
      const r0 = report('failed');
      r0.testResults[0].name = `C:\\Users\\Menne\\secret-project\\${TOKEN}.spec.ts`;
      writeClientReport(dir, r0);
      const r = await runTimes(['--record'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.ok(clientRecord(server), `the run was not recorded: ${everything(r)}`);
      const sent = JSON.stringify(server.calls.map(c => c.args));
      for (const leaked of ['Menne', 'secret-project', TOKEN]) assert.ok(!sent.includes(leaked), `${leaked} was written`);
    });
  });

  const HOSTILE = [
    ['a negative duration', (r) => { r.testResults[0].assertionResults[0].duration = -5; }],
    ['an infinite duration', (r) => { r.testResults[0].assertionResults[0].duration = '__INFINITY__'; }],
    ['a duration that is a string', (r) => { r.testResults[0].assertionResults[0].duration = '12'; }],
    ['a file that ends before it starts', (r) => { r.testResults[0].endTime = r.testResults[0].startTime - 10_000; }],
    ['a file start no Date holds', (r) => { r.testResults[0].startTime = 8.64e15 + 1; }],
    ['a report start no Date holds', (r) => { r.startTime = 8.64e15 + 1; }],
    ['a report start that is not a number', (r) => { r.startTime = 'yesterday'; }],
    ['an infinite file end', (r) => { r.testResults[0].endTime = '__INFINITY__'; }],
  ];
  for (const [what, mutate] of HOSTILE) {
    it(`${what}: no crash, and either a record with finite non-negative figures or a named problem`, async () => {
      await withClientRun({ tracked: ['passed'] }, async ({ server, dir, report, env }) => {
        nodeFiles(dir);
        const r0 = report('passed');
        mutate(r0);
        writeClientReport(dir, JSON.stringify(r0).replaceAll('"__INFINITY__"', '1e999'));
        const r = await runTimes(['--record'], { cwd: dir, env });
        assert.equal(r.code, 0, everything(r));
        assert.doesNotMatch(everything(r), /RangeError|Invalid time value|Invalid Date/, `${what}: an out-of-range epoch reached \`Date\``);
        assert.ok(server.store.some(e => e.properties.suite === 'standalone'), `${what}: the node records were lost to the client's`);
        const entry = clientRecord(server);
        if (entry) {
          const p = entry.properties;
          for (const k of ['ms', 'wallMs']) assert.ok(p[k] === undefined || (Number.isFinite(p[k]) && p[k] >= 0), `${what}: ${k} is ${p[k]}`);
          assert.ok(Number.isFinite(Date.parse(entry.startsAt)) && Number.isFinite(Date.parse(entry.endsAt)), `${what}: ${entry.startsAt} .. ${entry.endsAt}`);
          for (const f of measurementsOf(entry).files) assert.ok(Number.isFinite(f.ms) && f.ms >= 0, `${what}: ${f.file} ${f.ms}`);
        } else {
          assert.ok(clientLines(r).length > 0, `${what}: the client report vanished without a word:\n${everything(r)}`);
        }
      });
    });
  }

  it('spec files named after Object.prototype members are four files, each listed under its own name', async () => {
    await withClientRun({}, async ({ server, dir, report, env }) => {
      const r0 = report('passed');
      const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
      r0.testResults = names.map((name, i) => ({ ...structuredClone(r0.testResults[i % 2]), name }));
      writeClientReport(dir, r0);
      const r = await runTimes(['--record'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      const entry = clientRecord(server);
      assert.ok(entry, `the run was not recorded: ${everything(r)}`);
      assert.equal(entry.properties.files, 4);
      assert.deepEqual(measurementsOf(entry).files.map(f => f.file).sort(), [...names].sort());
    });
  });
});

describe('a run with very many failures still records, keeping per-file figures when the detail is too long', () => {
  it('past the ceiling on `measurements` the record carries every file\'s figures and says it was cut', async () => {
    await withClientRun({}, async ({ server, dir, report, env }) => {
      const r0 = report('failed');
      const one = r0.testResults[0];
      const FILES = 1500;
      r0.testResults = Array.from({ length: FILES }, (_, i) => {
        const f = structuredClone(one);
        f.name = f.name.replace('fail.spec.ts', `mass-failure-${String(i).padStart(4, '0')}-${'x'.repeat(60)}.spec.ts`);
        f.assertionResults[1].failureMessages = [`AssertionError: ${'a very long failure message '.repeat(30)}${i}`];
        f.assertionResults[1].title = `fails an assertion ${'and says so at length '.repeat(6)}${i}`;
        return f;
      });
      writeClientReport(dir, r0);
      const r = await runTimes(['--record'], { cwd: dir, env, timeoutMs: 120_000 });
      assert.equal(r.code, 0, everything(r));
      const entry = clientRecord(server);
      assert.ok(entry, `the run was not recorded: ${everything(r)}`);
      const p = entry.properties;
      assert.equal(p.failed, FILES);
      assert.equal(p.outcome, 'failed');
      assert.ok(p.measurementsChars <= 400_000, `measurements is ${p.measurementsChars} characters`);
      const m = measurementsOf(entry);
      assert.equal(m.truncated, true);
      assert.equal(m.files.length, FILES, 'a cut record keeps every file\'s figures');
    });
  });
});
