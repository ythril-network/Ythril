/**
 * The failure-rate reader (`scripts/test-failure-rates.mjs`, its rules in `scripts/_shared/failure-rates.mjs`) prints each
 * test's failures over the runs that ran it, from the recorded `Test-Run` records, and names every test that failed on a
 * commit that also passed (bundle-356, Q-948, slice S2; the check `check-i-test-failure-rates-read`).
 *
 * ## What this prevents
 *
 * A reader that answers "none" is believed. Four ways it would be wrong, each pinned here:
 *
 * 1. **A pass from nothing.** No records, records that cannot be read, or records that hold no result per test (`none`,
 *    or the old cut-down form without names on a red record) answer exit 2 with the counts, never 0.
 * 2. **Pairs that did not test the same code.** A test is named only when its file ran without it failing in another
 *    attempt of the same run, or in another run of the same commit and kind. A record from uncommitted changes never
 *    pairs; a pull request run pairs only within its own run; a local run never pairs with a CI run.
 * 3. **A wrong count.** A test is its file and its name: one name in two files is two tests. A file that ran in two shards
 *    of one attempt is one run of that file. Attempts are never merged: attempt 1 red and attempt 2 green are "1 of 2".
 * 4. **An answer over less than it says.** The output names the kinds of run it rests on and the kinds absent (a CI record
 *    with no kind is a push to main, a local one local), the records and runs read, the span, and every record left out.
 *
 * The script is driven against the fake tool server (`testing/_shared/fake-ythril-tool-server.mjs`); no real instance.
 *
 * Run: node --test testing/standalone/the-failure-rate-reader-names-a-test-that-failed-on-a-passing-commit.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { cleanEnv, everything } from '../_shared/test-times-harness.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MODULE = pathToFileURL(resolve(ROOT, 'scripts', '_shared', 'failure-rates.mjs')).href;
const SCRIPT = resolve(ROOT, 'scripts', 'test-failure-rates.mjs');
let loaded;
const load = () => (loaded ??= import(MODULE));

const A = 'testing/standalone/a-one.test.js';
const B = 'testing/standalone/b-two.test.js';
const NAME = 'the sweep ends the walk once';
const DAY = 24 * 3600 * 1000;
const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();

/**
 * One `Test-Run` record as the server returns it with `measurements`: `files` is `[[file, [failing test names]]]`.
 * `over` replaces properties; `measurements` replaces the text whole.
 */
function record({ source = 'ci', runId = '100', attempt = 1, job = 'standalone-pure', suite = 'standalone', commit = 'c'.repeat(40),
  dirty = false, outcome, files = [[A, []]], runKind, startsAt = daysAgo(1), measurements, over = {} } = {}) {
  const failed = files.reduce((n, [, f]) => n + f.length, 0);
  const text = measurements ?? JSON.stringify({
    files: files.map(([file, failures]) => ({ file, ms: 1000, tests: 3, ...(failures.length ? { failures: failures.map(test => ({ test, message: 'boom' })) } : {}) })),
    slowest: [],
  });
  return {
    _id: `${source}:${runId}:${attempt}:${job}:${suite}`, type: 'Test-Run', title: suite, startsAt, endsAt: startsAt,
    properties: {
      recordKey: `${source}:${runId}:${attempt}:${job}:${suite}`, formatVersion: 1, source, commit, branch: 'main', runId, attempt, job, suite,
      ms: 1000, files: files.length, tests: 3 * files.length, passed: 3 * files.length - failed, failed, cancelled: 0, skipped: 0, todo: 0,
      outcome: outcome ?? (failed ? 'failed' : 'passed'), scope: 'full', layout: 'ci-parallel-v2', dirty, measurements: text,
      measurementsChars: text.length, ...(runKind ? { runKind } : {}), ...over,
    },
  };
}

const rates = async (rows, opts) => (await load()).failureRates(rows, opts);
const named = (r) => r.flaky.map(t => `${t.file} :: ${t.test} :: ${t.failures} of ${t.runs}`);

describe('a test that failed on a commit that also passed is named, with its failures over the runs that ran its file', () => {
  it('attempt 1 red and attempt 2 green of one run: named as 1 of 2, exit 1', async () => {
    const r = await rates([
      record({ attempt: 1, files: [[A, [NAME]]] }),
      record({ attempt: 2, files: [[A, []]] }),
    ]);
    assert.deepEqual(named(r), [`${A} :: ${NAME} :: 1 of 2`]);
    assert.equal(r.exit, 1);
    const lines = (await load()).failureRateLines(r).join('\n');
    assert.match(lines, new RegExp(`1 of 2\\s+${A.replace(/[.]/g, '\\.')}\\s+${NAME}`));
  });

  it('one name in two files is two tests, and a file that ran in two shards of one attempt is one run of that file', async () => {
    const r = await rates([
      record({ attempt: 1, job: 'standalone-pure-1', files: [[A, [NAME]], [B, []]] }),
      record({ attempt: 1, job: 'standalone-pure-2', files: [[A, []]] }),
      record({ attempt: 2, job: 'standalone-pure-1', files: [[A, []], [B, []]] }),
    ]);
    assert.deepEqual(named(r), [`${A} :: ${NAME} :: 1 of 2`]);
    assert.ok(!r.tests.some(t => t.file === B), 'the same name in another file is another test, which never failed');
  });

  it('another run of the same commit and kind pairs; another commit, or another kind on the same commit, does not', async () => {
    const pair = await rates([
      record({ runId: '1', files: [[A, [NAME]]] }),
      record({ runId: '2', files: [[A, []]] }),
    ]);
    assert.deepEqual(named(pair), [`${A} :: ${NAME} :: 1 of 2`]);

    const otherCommit = await rates([
      record({ runId: '1', commit: 'a'.repeat(40), files: [[A, [NAME]]] }),
      record({ runId: '2', commit: 'b'.repeat(40), files: [[A, []]] }),
    ]);
    assert.deepEqual(named(otherCommit), []);
    assert.equal(otherCommit.exit, 0);
    assert.deepEqual(otherCommit.tests.map(t => `${t.failures} of ${t.runs}`), ['1 of 2'], 'its rate is still counted');
    const printed = (await load()).failureRateLines(otherCommit).join('\n');
    assert.match(printed, new RegExp(`1 of 2\\s+${A.replace(/[.]/g, '\\.')}\\s+${NAME}`), 'and printed, though it names no test');

    const otherKind = await rates([
      record({ source: 'local', runId: 'local-1', job: 'local', files: [[A, [NAME]]] }),
      record({ runId: '2', files: [[A, []]] }),
    ]);
    assert.deepEqual(named(otherKind), []);
  });

  it('a record from uncommitted changes never pairs, red or green', async () => {
    const local = (runId, files, dirty) => record({ source: 'local', runId, job: 'local', files, dirty });
    assert.deepEqual(named(await rates([local('l1', [[A, [NAME]]], false), local('l2', [[A, []]], false)])), [`${A} :: ${NAME} :: 1 of 2`], 'two clean local runs pair');
    assert.deepEqual(named(await rates([local('l1', [[A, [NAME]]], true), local('l2', [[A, []]], false)])), []);
    assert.deepEqual(named(await rates([local('l1', [[A, [NAME]]], false), local('l2', [[A, []]], true)])), []);
  });

  it('a pull request run pairs only with another attempt of the same run', async () => {
    const pr = (runId, attempt, files) => record({ runId, attempt, files, runKind: 'pull-request', over: { branch: 'feature' } });
    assert.deepEqual(named(await rates([pr('7', 1, [[A, [NAME]]]), pr('8', 1, [[A, []]])])), []);
    assert.deepEqual(named(await rates([pr('7', 1, [[A, [NAME]]]), pr('7', 2, [[A, []]])])), [`${A} :: ${NAME} :: 1 of 2`]);
  });

  it('names the highest rate first', async () => {
    const C = 'testing/standalone/c-three.test.js';
    const r = await rates([
      record({ runId: '1', files: [[A, [NAME]], [C, ['low']]] }),
      record({ runId: '2', files: [[A, [NAME]], [C, []]] }),
      record({ runId: '3', files: [[A, []], [C, []]] }),
    ]);
    assert.deepEqual(named(r), [`${A} :: ${NAME} :: 2 of 3`, `${C} :: low :: 1 of 3`]);
  });
});

describe('no answer from nothing: exit 2 when the records hold no result per test', () => {
  it('no rows at all: exit 2, saying 0 records', async () => {
    const r = await rates([]);
    assert.equal(r.exit, 2);
    assert.match((await load()).failureRateLines(r).join('\n'), /0 records/);
  });

  it('only records without file lists or cut down without names: exit 2, each counted and said', async () => {
    const r = await rates([
      record({ runId: '1', measurements: 'none' }),
      record({ runId: '2', files: [[A, [NAME]]], measurements: JSON.stringify({ truncated: true, files: [{ file: A, ms: 1, tests: 3 }] }), over: { failed: 1, outcome: 'failed' } }),
    ]);
    assert.equal(r.exit, 2);
    const lines = (await load()).failureRateLines(r).join('\n');
    assert.match(lines, /2 records/);
    assert.match(lines, /1 without a file list/);
    assert.match(lines, /1 cut down without names/);
  });

  it('a cut-down record of a green run still says which files ran', async () => {
    const r = await rates([
      record({ runId: '1', files: [[A, [NAME]]] }),
      record({ runId: '2', measurements: JSON.stringify({ truncated: true, files: [{ file: A, ms: 1, tests: 3 }] }) }),
    ]);
    assert.deepEqual(named(r), [`${A} :: ${NAME} :: 1 of 2`]);
  });

  it('a record whose results cannot be vouched for, or of a format version it does not know, is left out and said', async () => {
    const r = await rates([
      record({ runId: '1', files: [[A, [NAME]]], outcome: 'incomplete' }),
      record({ runId: '2', files: [[A, []]], over: { formatVersion: 2 } }),
      record({ runId: '3', files: [[A, []]] }),
    ]);
    assert.deepEqual(named(r), []);
    const lines = (await load()).failureRateLines(r).join('\n');
    assert.match(lines, /1 not vouched for/);
    assert.match(lines, /1 of an unknown format version/);
  });

  it('every test green over two runs: exit 0', async () => {
    const r = await rates([record({ runId: '1' }), record({ runId: '2' })]);
    assert.deepEqual(named(r), []);
    assert.equal(r.exit, 0);
  });
});

describe('the answer says what it rests on', () => {
  it('kinds present and absent, records and runs read, the span; a CI record without a kind is a push to main, a local one local', async () => {
    const r = await rates([
      record({ runId: '1', attempt: 1, job: 'j1' }), record({ runId: '1', attempt: 1, job: 'j2' }), record({ runId: '1', attempt: 2, job: 'j1' }),
      record({ source: 'local', runId: 'local-x', job: 'local' }),
    ], { since: daysAgo(30) });
    const lines = (await load()).failureRateLines(r).join('\n');
    assert.match(lines, /4 records of 3 runs/);
    assert.match(lines, /push-main 3 records \/ 2 runs/);
    assert.match(lines, /local 1 records \/ 1 runs/);
    assert.match(lines, /absent: pull-request, full-run, preflight/);
    assert.match(lines, /span \d{4}-\d{2}-\d{2}T[\d:.]+Z to \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  });

  it('a record older than the span is not read, though the server returned it', async () => {
    const r = await rates([
      record({ runId: '1', files: [[A, [NAME]]], startsAt: daysAgo(40) }),
      record({ runId: '2', files: [[A, []]] }),
      record({ runId: '3', files: [[A, []]] }),
    ], { since: daysAgo(30) });
    assert.deepEqual(named(r), []);
    assert.match((await load()).failureRateLines(r).join('\n'), /2 records of 2 runs/);
  });
});

// ── The script, through a stand-in for the records door ──────────────────────────────────────────────────────

function runReader(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the reader did not finish\n${stdout}\n${stderr}`)); }, 60_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

async function withServer(seed, body, opts) {
  const server = await startFakeYthril(opts);
  try {
    for (const r of seed) { const { _id, ...entry } = r; server.seed(entry); }
    return await body(server, { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token });
  } finally { await server.close(); }
}

describe('the script answers by exit code over the recorded runs, reading only', () => {
  it('attempt 1 red, attempt 2 green: exit 1 naming the test as 1 of 2, and every request a read of Test-Run records', async () => {
    await withServer([record({ attempt: 1, files: [[A, [NAME]]] }), record({ attempt: 2, files: [[A, []]] })], async (server, env) => {
      const r = await runReader([], env);
      assert.equal(r.code, 1, everything(r));
      assert.match(r.stdout, new RegExp(`1 of 2\\s+${A.replace(/[.]/g, '\\.')}\\s+${NAME}`));
      assert.ok(server.calls.length > 0);
      for (const c of server.calls) {
        assert.equal(c.tool, 'filter', `only reads: ${c.tool}`);
        assert.equal(c.args.filter?.type, 'Test-Run');
      }
      assert.ok(!everything(r).includes(server.token), 'the token is never printed');
    });
  });

  it('reads the records with their measurements a page at a time, never one request per record', async () => {
    // A request per record met the instance's per-token rate limit (429) on the first read of the real records (Q-948).
    const seed = Array.from({ length: 25 }, (_, i) => record({ runId: String(i + 1) }));
    await withServer(seed, async (server, env) => {
      const r = await runReader([], env);
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /25 records of 25 runs/);
      assert.ok(server.calls.length <= 5, `${server.calls.length} requests for 25 records`);
    });
  });

  it('all green: exit 0', async () => {
    await withServer([record({ runId: '1' }), record({ runId: '2' })], async (_s, env) => {
      const r = await runReader([], env);
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /no test failed on a commit that also passed/);
    });
  });

  it('no records: exit 2, never a pass', async () => {
    await withServer([], async (_s, env) => {
      const r = await runReader([], env);
      assert.equal(r.code, 2, everything(r));
      assert.match(everything(r), /0 records/);
    });
  });

  it('records that cannot be read: exit 2 naming the status, never the token', async () => {
    await withServer([record({ runId: '1' }), record({ runId: '2' })], async (server, env) => {
      const r = await runReader([], env);
      assert.equal(r.code, 2, everything(r));
      assert.match(r.stderr, /500/);
      assert.ok(!everything(r).includes(server.token));
    }, { respond: () => ({ status: 500, body: { ok: false, error: 'down' } }) });
  });

  it('no destination: exit 2 naming the variable', async () => {
    const r = await runReader([], {});
    assert.equal(r.code, 2, everything(r));
    assert.match(r.stderr, /YTHRIL_TEST_RUNS_URL/);
  });

  it('the span is --since <days>, 30 by default; a wrong value is refused with exit 2', async () => {
    const seed = [record({ runId: '1', files: [[A, [NAME]]], startsAt: daysAgo(40) }), record({ runId: '2', files: [[A, []]], startsAt: daysAgo(2) })];
    await withServer(seed, async (_s, env) => {
      const byDefault = await runReader([], env);
      assert.equal(byDefault.code, 2, `one run in the default span is too few to answer\n${everything(byDefault)}`);
      assert.match(byDefault.stdout + byDefault.stderr, /1 records of 1 runs/);
      const wide = await runReader(['--since', '60'], env);
      assert.equal(wide.code, 1, everything(wide));
      assert.match(wide.stdout, /1 of 2/);
      const wrong = await runReader(['--since', 'soon'], env);
      assert.equal(wrong.code, 2, everything(wrong));
    });
  });
});
