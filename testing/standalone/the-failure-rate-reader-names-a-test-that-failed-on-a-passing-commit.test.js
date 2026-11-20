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
 * Two more lists (slice S5, the check `check-i-never-failed-slow-tests-examined`), asked for with `--list`:
 *
 * 5. **A slow file named as never failed that failed, or was barely seen.** The slowest tenth of the test files (by the
 *    per-file times snapshot) less every file with a failure in the span; a file that ran in fewer than two runs of the span is
 *    left out and COUNTED, never listed.
 * 6. **A group of tests that did not fail together.** Groups of two or more tests that each failed at least twice and failed in
 *    exactly the same runs every time, compared over the runs that ran both tests' files (a file that did not run in a shard is
 *    not a pass there). No per-file times, or fewer than two runs, answer exit 2, never a pass.
 *
 * The script is driven against the fake tool server (`testing/_shared/fake-ythril-tool-server.mjs`); no real instance.
 *
 * Run: node --test testing/standalone/the-failure-rate-reader-names-a-test-that-failed-on-a-passing-commit.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
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

// ── The two more lists: the slowest tenth that never failed, and the tests that only ever failed together ────────

const FILES = Array.from({ length: 20 }, (_, i) => `testing/standalone/f${String(i).padStart(2, '0')}.test.js`);
/** f00 is the slowest file, f19 the fastest: the slowest tenth of twenty is f00 and f01. */
const SLOW = Object.fromEntries(FILES.map((f, i) => [f, (20 - i) * 1000]));
const lists = async (rows, opts) => (await load()).failureLists(rows, opts);
const listed = (r) => r.neverFailed.map(e => e.file);
const groups = (r) => r.together.map(g => g.tests.map(t => `${t.file} :: ${t.test}`));
/** A run of every file of FILES, `failing` naming the tests that failed in it by file. */
const wholeRun = (runId, failing = {}, { without = [] } = {}) => record({
  runId, files: FILES.filter(f => !without.includes(f)).map(f => [f, failing[f] ?? []]),
});
const X = 'x fails';
const Y = 'y fails';

describe('the slowest tenth of the files that never failed', () => {
  it('a slowest-tenth file with a failure in the span is not listed, the others are, with their seconds and runs', async () => {
    const control = await lists([wholeRun('1'), wholeRun('2'), wholeRun('3')], { fileTimes: { files: SLOW }, lists: ['never-failed'] });
    assert.deepEqual(control.neverFailed.map(e => [e.file, e.ms, e.runs]), [[FILES[0], 20000, 3], [FILES[1], 19000, 3]]);
    assert.equal(control.exit, 1);

    const r = await lists([wholeRun('1'), wholeRun('2', { [FILES[0]]: [X] }), wholeRun('3')], { fileTimes: { files: SLOW }, lists: ['never-failed'] });
    assert.deepEqual(listed(r), [FILES[1]], 'the slowest file failed once in the span');
    assert.equal(r.exit, 1);
    const lines = (await load()).failureListLines(r, { lists: ['never-failed'] }).join('\n');
    assert.match(lines, new RegExp(`19000 ms\\s+3 runs\\s+${FILES[1].replace(/[.]/g, '\\.')}`));
  });

  it('a file that ran in one run only is left out and counted, never listed as never failed', async () => {
    const seen = (runId, without) => wholeRun(runId, {}, { without });
    const r = await lists([seen('1', []), seen('2', [FILES[1]]), seen('3', [FILES[1]])], { fileTimes: { files: SLOW }, lists: ['never-failed'] });
    assert.deepEqual(listed(r), [FILES[0]]);
    assert.equal(r.tooFew, 1);
    const lines = (await load()).failureListLines(r, { lists: ['never-failed'] }).join('\n');
    assert.match(lines, /1 left out: ran in fewer than two runs/);
  });

  it('a slow file no record lists at all is left out and counted too', async () => {
    const r = await lists([wholeRun('1', {}, { without: [FILES[0]] }), wholeRun('2', {}, { without: [FILES[0]] })], { fileTimes: { files: SLOW }, lists: ['never-failed'] });
    assert.deepEqual(listed(r), [FILES[1]]);
    assert.equal(r.tooFew, 1);
  });

  it('when every file of the tenth failed, both lists are empty and the exit is 0', async () => {
    const failing = { [FILES[0]]: [X], [FILES[1]]: [X] };
    const r = await lists([wholeRun('1', failing), wholeRun('2', {}), wholeRun('3', {})], { fileTimes: { files: SLOW } });
    assert.deepEqual(listed(r), []);
    assert.deepEqual(groups(r), []);
    assert.equal(r.exit, 0);
  });

  it('client files are ranked among themselves, their times are vitest\'s and not comparable with node files', async () => {
    const node = FILES.slice(0, 10);
    const client = Array.from({ length: 10 }, (_, i) => `client/src/c${i}.spec.ts`);
    const fileTimes = { files: { ...Object.fromEntries(node.map((f, i) => [f, (10 - i) * 10])), ...Object.fromEntries(client.map((f, i) => [f, (10 - i) * 100_000])) } };
    const run = (id) => record({ runId: id, files: [...node, ...client].map(f => [f, []]) });
    const r = await lists([run('1'), run('2')], { fileTimes, lists: ['never-failed'] });
    assert.deepEqual(listed(r).sort(), [client[0], node[0]].sort(), 'the slowest tenth of each, not the client files crowding the node files out');
  });
});

describe('the tests that only ever failed together', () => {
  const A2 = FILES[2];
  const B2 = FILES[3];
  const together = (runId, extra = {}) => wholeRun(runId, { [A2]: [X], [B2]: [Y], ...extra });

  it('two tests failing in exactly the same two runs form one group, exit 1', async () => {
    const r = await lists([together('1'), together('2'), wholeRun('3')], { fileTimes: { files: SLOW }, lists: ['together'] });
    assert.deepEqual(groups(r), [[`${A2} :: ${X}`, `${B2} :: ${Y}`]]);
    assert.equal(r.together[0].failures, 2);
    assert.equal(r.together[0].runs, 3);
    assert.equal(r.exit, 1);
    const lines = (await load()).failureListLines(r, { lists: ['together'] }).join('\n');
    assert.match(lines, /2 of 3/);
  });

  it('a test with one failure is never grouped, not even with another that failed in the same run', async () => {
    const r = await lists([together('1'), wholeRun('2'), wholeRun('3')], { fileTimes: { files: SLOW }, lists: ['together'] });
    assert.deepEqual(groups(r), []);
    const alone = await lists([together('1'), together('2', { [FILES[4]]: [X] }), wholeRun('3')], { fileTimes: { files: SLOW }, lists: ['together'] });
    assert.deepEqual(groups(alone), [[`${A2} :: ${X}`, `${B2} :: ${Y}`]], 'the one-failure test of the second run joins nothing');
  });

  it('two tests that failed together twice and one of them alone a third time are not a group', async () => {
    const r = await lists([together('1'), together('2'), wholeRun('3', { [A2]: [X] })], { fileTimes: { files: SLOW }, lists: ['together'] });
    assert.deepEqual(groups(r), []);
    assert.equal(r.exit, 0);
  });

  it('a file that did not run in a shard is not a pass there: the runs that ran both files decide', async () => {
    const r = await lists([together('1'), together('2'), wholeRun('3', { [A2]: [X] }, { without: [B2] })], { fileTimes: { files: SLOW }, lists: ['together'] });
    assert.deepEqual(groups(r), [[`${A2} :: ${X}`, `${B2} :: ${Y}`]]);
    assert.equal(r.together[0].runs, 2, 'only the two runs that ran both files');
  });

  it('a group holds only tests that all pair with each other; one name in two files is two tests', async () => {
    const C2 = FILES[5];
    const r = await lists([
      together('1', { [C2]: [X] }), together('2', { [C2]: [X] }), wholeRun('3'),
    ], { fileTimes: { files: SLOW }, lists: ['together'] });
    assert.deepEqual(groups(r), [[`${A2} :: ${X}`, `${B2} :: ${Y}`, `${C2} :: ${X}`]]);
  });

  it('attempts are runs: attempt 1 and 2 of one run that both failed are two failures', async () => {
    const attempt = (n) => record({ attempt: n, files: [[A2, [X]], [B2, [Y]]] });
    const r = await lists([attempt(1), attempt(2), record({ runId: '101', files: [[A2, []], [B2, []]] })], { fileTimes: { files: SLOW }, lists: ['together'] });
    assert.equal(r.together.length, 1);
  });
});

describe('the two more lists answer exit 2 when they cannot answer, never a pass', () => {
  it('no per-file times: exit 2 saying why, for the list that needs them', async () => {
    const rows = [wholeRun('1'), wholeRun('2')];
    const r = await lists(rows, { fileTimes: null, fileTimesWhy: 'no file-times-all.json yet', lists: ['never-failed', 'together'] });
    assert.equal(r.exit, 2);
    const lines = (await load()).failureListLines(r, { lists: ['never-failed', 'together'] }).join('\n');
    assert.match(lines, /cannot answer: .*no file-times-all\.json yet/);
    const withoutTheNeed = await lists(rows, { fileTimes: null, lists: ['together'] });
    assert.equal(withoutTheNeed.exit, 0, 'the groups do not need the times');
  });

  it('fewer than two runs hold results: exit 2 with the counts', async () => {
    const r = await lists([wholeRun('1')], { fileTimes: { files: SLOW } });
    assert.equal(r.exit, 2);
    assert.match((await load()).failureListLines(r, { lists: ['never-failed', 'together'] }).join('\n'), /1 records of 1 runs/);
  });

  it('records left out are counted in the lines of the lists, as in the first list', async () => {
    const r = await lists([wholeRun('1'), wholeRun('2'), record({ runId: '3', measurements: 'none' })], { fileTimes: { files: SLOW } });
    const lines = (await load()).failureListLines(r, { lists: ['never-failed', 'together'] }).join('\n');
    assert.match(lines, /3 records of 2 runs/);
    assert.match(lines, /1 without a file list/);
    assert.match(lines, /absent: pull-request, full-run, preflight, local/);
  });
});

describe('the script prints the lists it is asked for, and the first list stays the default', () => {
  const snapshot = (dir, files = SLOW, over = {}) => writeFileSync(join(dir, 'file-times-all.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runs: 5, files, ...over }));
  async function withResults(body) {
    const dir = mkdtempSync(join(tmpdir(), 'failure-rates-'));
    try { return await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const seed = [together3('1'), together3('2'), wholeRun('3')];
  function together3(runId) { return wholeRun(runId, { [FILES[2]]: [X], [FILES[3]]: [Y] }); }

  it('--list never-failed,together prints both lists and exits 1 when one holds an entry', async () => {
    await withResults(dir => withServer(seed, async (_s, env) => {
      snapshot(dir);
      const r = await runReader(['--list', 'never-failed,together'], { ...env, YTHRIL_TEST_RESULTS_DIR: dir });
      assert.equal(r.code, 1, everything(r));
      assert.match(r.stdout, new RegExp(`${FILES[0].replace(/[.]/g, '\\.')}`));
      assert.match(r.stdout, new RegExp(`${FILES[2].replace(/[.]/g, '\\.')} {2}${X}`));
      assert.match(r.stdout, /3 records of 3 runs/);
      assert.ok(!r.stdout.includes('every test that failed in the span'), 'the first list is not asked for');
    }));
  });

  it('--list all prints the first list as well; the default prints the first list only and never reads the snapshot', async () => {
    await withResults(dir => withServer(seed, async (_s, env) => {
      const all = { ...env, YTHRIL_TEST_RESULTS_DIR: dir };
      const byDefault = await runReader([], all);
      assert.equal(byDefault.code, 1, `no snapshot in the folder, and the default does not need one\n${everything(byDefault)}`);
      assert.ok(!byDefault.stdout.includes('never failed'));
      snapshot(dir);
      const both = await runReader(['--list', 'all'], all);
      assert.equal(both.code, 1, everything(both));
      assert.match(both.stdout, /every test that failed in the span/);
      assert.match(both.stdout, /slowest tenth/);
    }));
  });

  it('both lists empty: exit 0', async () => {
    await withResults(dir => withServer([wholeRun('1', { [FILES[0]]: [X], [FILES[1]]: [X] }), wholeRun('2'), wholeRun('3')], async (_s, env) => {
      snapshot(dir);
      const r = await runReader(['--list', 'never-failed,together'], { ...env, YTHRIL_TEST_RESULTS_DIR: dir });
      assert.equal(r.code, 0, everything(r));
    }));
  });

  it('a missing, stale or empty per-file times snapshot: exit 2 naming it, never a pass', async () => {
    await withResults(dir => withServer(seed, async (_s, env) => {
      const asked = { ...env, YTHRIL_TEST_RESULTS_DIR: dir };
      const missing = await runReader(['--list', 'never-failed,together'], asked);
      assert.equal(missing.code, 2, everything(missing));
      assert.match(everything(missing), /file-times-all\.json/);
      snapshot(dir, SLOW, { generatedAt: new Date(Date.now() - 40 * DAY).toISOString() });
      const stale = await runReader(['--list', 'never-failed'], asked);
      assert.equal(stale.code, 2, everything(stale));
      assert.match(everything(stale), /stale/);
      snapshot(dir, {});
      const empty = await runReader(['--list', 'never-failed'], asked);
      assert.equal(empty.code, 2, everything(empty));
    }));
  });

  it('a list name it does not know is refused with exit 2', async () => {
    const r = await runReader(['--list', 'rates,sometimes'], {});
    assert.equal(r.code, 2, everything(r));
    assert.match(r.stderr, /--list/);
  });
});
