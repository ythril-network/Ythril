/**
 * A local preflight records the tests it ran, every failed one by name, and no recording problem touches its verdict or its time (Q-948).
 *
 * ## The defect this refuses
 *
 * Most test failures a developer sees happen in a local preflight, and they left no record: the preflight kept only its stage times
 * (`Preflight-Run`), its test results lay in `test-results/` until the next run cleared them, so a failure rate read from the
 * recorded runs missed them. The preflight is also the gate before every push, so the recording is held to the other side too: a step
 * that can fail the run, slow it, or record an earlier run's leftovers is worse than none.
 *
 * ## What it asserts, each from where the answer comes from
 *
 * - The REAL `scripts/preflight.mjs`, run in a planted tree (`_shared/planted-preflight-tree.mjs`) whose `unrun-tests` stage writes what a
 *   test stage writes (a results file with one failing test, the client's report): the spool holds one `Test-Run` per suite the run ran
 *   (its node suite `preflight` and `client`), each of kind `preflight`, with the commit, whether the tree had uncommitted changes, the
 *   scope as the run ran it (`static` under `--static`, `subset` for the pure files of a full run) and the failed test's file, name and
 *   message start.
 * - Only this run's results: a results file of another suite, or a client report, left in the folder by an earlier run is not recorded,
 *   and (at the builder, where the clock is the test's) a file older than the run is not either, whatever its name.
 * - Recording never changes the run: with the instance unset, answering 500 and reachable the exit status and the verdict text are the
 *   same, the payloads stay spooled when they were not sent, and a later drain sends what the earlier one could not. The token is in
 *   no spooled file and in no line the run printed.
 * - A record of a run that cannot say what it tested (no git) says it had uncommitted changes, so a reader never pairs it by commit.
 * - A preflight record never enters a time baseline, and its scope never says `full` for a static run.
 *
 * Run: node --test testing/standalone/a-preflight-records-the-tests-it-ran.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';
import { startFakeYthril, FAKE_TOKEN } from '../_shared/fake-ythril-tool-server.mjs';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import { plantPreflightTree } from '../_shared/planted-preflight-tree.mjs';
import { clientReport } from '../_shared/client-report-fixtures.mjs';
import { jsonlFor, runTimes, everything, cleanEnv } from '../_shared/test-times-harness.mjs';

const url = (p) => pathToFileURL(join(REPO_ROOT, p)).href;
const timesModule = () => import(url('scripts/test-times.mjs'));
const baselineModule = () => import(url('scripts/_shared/all-suite-file-times.mjs'));
const PREFLIGHT = join(REPO_ROOT, 'scripts/preflight.mjs');
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };

const FAILING_TEST = 'the planted test that fails';
const FAILING_FILE = 'testing/standalone/planted-a-failing-one.test.js';
const FAILING_MESSAGE = 'expected 1 to equal 2';
const CLIENT_FAILURE = /fails an assertion/;

/** The text of a results file a test stage of the preflight writes: one file, one failing test, one passing. */
const nodeResults = (scope) => jsonlFor({
  suite: 'preflight', batch: 'pure-1', scope, startedAt: new Date().toISOString(), endedAt: new Date(Date.now() + 5).toISOString(),
  files: [{ file: FAILING_FILE, ms: 40, tests: [{ name: FAILING_TEST, status: 'fail', message: FAILING_MESSAGE, ms: 3 }, { name: 'the planted test that passes', ms: 2 }] }],
});

/**
 * The body of the planted `unrun-tests` stage: it writes, as a stage of this run, the node results and (when given) the client's report
 * into the folder the preflight reads. Run AFTER the preflight cleared the earlier run's files, as a real stage is.
 */
const writesResults = ({ node, client }) => `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('test-results', { recursive: true });
${node === undefined ? '' : `writeFileSync('test-results/preflight-pure-1.jsonl', ${JSON.stringify(node)});`}
${client === undefined ? '' : `writeFileSync('test-results/client.json', ${JSON.stringify(client)});`}
`;

/** The preflight, spawned without blocking this process (the fake instance it may talk to lives here). */
function spawnPreflight(args, { cwd, env }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [PREFLIGHT, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the planted preflight did not finish in 120 s:\n${out.slice(-1500)}`)); }, 120_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (status) => { clearTimeout(timer); resolveRun({ status, out }); });
  });
}

const spoolOf = (dir) => {
  const folder = join(dir, 'test-results', 'unrecorded');
  return existsSync(folder) ? readdirSync(folder).filter(f => f.endsWith('.json')).sort().map(f => ({ file: f, payload: JSON.parse(readFileSync(join(folder, f), 'utf8')) })) : [];
};
const testRunsOf = (dir) => spoolOf(dir).map(s => s.payload).filter(p => p.type === 'Test-Run');
const bySuite = (payloads) => Object.fromEntries(payloads.map(p => [p.properties.suite, p]));

/** The verdict block of a run's output: from the rule line to the closing sentence, which nothing about recording may change. */
const verdictOf = (out) => /={76}[\s\S]*?(?:Fix before pushing\.|Preflight (?:STATIC )?passed[^\n]*)/.exec(out)?.[0] ?? `(no verdict in:\n${out.slice(-800)})`;

/**
 * One real preflight in a planted git tree; `body` gets what it left. The tree is a repository so the run has a commit; `committed: false`
 * leaves the planted files untracked (a tree with uncommitted changes).
 */
async function withPreflight(args, { node, client, committed = true, seed = () => {}, env = {} }, body) {
  const repo = makeScratchRepo({ prefix: 'preflight-tests-' });
  try {
    plantPreflightTree(repo.dir, { changelog: 0, unrunTests: 1, unrunBody: writesResults({ node, client: typeof client === 'function' ? client(repo.dir) : client }) });
    writeFileSync(join(repo.dir, '.gitignore'), 'test-results/\n');
    // A measured snapshot that puts the planted stage right after the first one: without it the run stops at the first stage whose script
    // this tree does not hold, and the planted stage (the one that writes the results) never runs.
    mkdirSync(join(repo.dir, 'test-results'), { recursive: true });
    writeFileSync(join(repo.dir, 'test-results', 'stage-costs.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), window: 20, runner: 'host', runs: 9,
      stages: { 'unregistered-local-files': { ran: 9, failed: 0, medianMs: 40 }, 'unrun-tests': { ran: 9, failed: 8, medianMs: 90 } },
    }));
    seed(repo.dir);
    if (committed) { repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'planted'); }
    const base = cleanEnv(env);
    delete base.RUNNER_HEAD;
    const ran = await spawnPreflight(args, { cwd: repo.dir, env: base });
    return await body({ ...ran, dir: repo.dir, commit: committed ? repo.git('rev-parse', 'HEAD').trim() : null });
  } finally { repo.cleanup(); }
}

describe('the real preflight spools one Test-Run of kind preflight per suite it ran', () => {
  it('a full run with a failing test file and a failing client spec: the node suite and the client, each naming its failed test', async () => {
    const client = (dir) => JSON.stringify(clientReport('failed', { root: dir, startMs: Date.now() }));
    await withPreflight([], { node: nodeResults('subset'), client }, async (r) => {
      assert.equal(r.status, 1, r.out.slice(-1500));
      const runs = bySuite(testRunsOf(r.dir));
      assert.deepEqual(Object.keys(runs).sort(), ['client', 'preflight'], `the spool held ${Object.keys(runs)}:\n${r.out.slice(-1500)}`);
      const node = runs.preflight.properties;
      assert.equal(node.runKind, 'preflight');
      assert.equal(node.source, 'local');
      assert.equal(node.commit, r.commit);
      assert.equal(node.dirty, false);
      assert.equal(node.scope, 'subset', 'a full preflight runs the pure files only: a subset');
      assert.equal(node.outcome, 'failed');
      assert.equal(node.failed, 1);
      const files = JSON.parse(node.measurements).files;
      assert.deepEqual(files.filter(f => f.failures.length).map(f => ({ file: f.file, failures: f.failures })), [
        { file: FAILING_FILE, failures: [{ test: FAILING_TEST, message: FAILING_MESSAGE }] },
      ]);
      const cli = runs.client.properties;
      assert.equal(cli.runKind, 'preflight');
      assert.equal(cli.commit, r.commit);
      assert.equal(cli.failed, 1);
      assert.match(JSON.parse(cli.measurements).files.flatMap(f => f.failures)[0].test, CLIENT_FAILURE);
      // the stage times are still recorded, beside them
      assert.equal(spoolOf(r.dir).filter(s => s.payload.type === 'Preflight-Run').length, 1);
    });
  });

  it('a static run records the node suite with scope static, and no client record (it ran no client)', async () => {
    await withPreflight(['--static'], { node: nodeResults('static') }, async (r) => {
      assert.equal(r.status, 1, r.out.slice(-1500));
      const runs = testRunsOf(r.dir);
      assert.deepEqual(runs.map(p => p.properties.suite), ['preflight'], r.out.slice(-1500));
      assert.equal(runs[0].properties.scope, 'static');
      assert.equal(runs[0].properties.runKind, 'preflight');
    });
  });

  it('a tree with uncommitted changes is recorded as such, so a reader never pairs it by commit', async () => {
    await withPreflight([], { node: nodeResults('subset'), committed: false }, async (r) => {
      const runs = testRunsOf(r.dir);
      assert.equal(runs.length, 1, r.out.slice(-1500));
      assert.equal(runs[0].properties.dirty, true);
    });
  });
});

describe('only the results this run wrote are recorded', () => {
  it('a results file of another suite and a client report an earlier run left are not recorded; this run\'s are', async () => {
    const stale = jsonlFor({
      suite: 'standalone', batch: '0', scope: 'full',
      files: [{ file: 'testing/standalone/an-older-run.test.js', ms: 9, tests: [{ name: 'a leftover failure', status: 'fail', message: 'old' }] }],
    });
    const seed = (dir) => {
      mkdirSync(join(dir, 'test-results'), { recursive: true });
      writeFileSync(join(dir, 'test-results', 'standalone-0.jsonl'), stale);
      writeFileSync(join(dir, 'test-results', 'client.json'), JSON.stringify(clientReport('failed', { root: dir, startMs: Date.now() - 3_600_000 })));
    };
    await withPreflight([], { node: nodeResults('subset'), seed }, async (r) => {
      const runs = testRunsOf(r.dir);
      assert.deepEqual(runs.map(p => p.properties.suite), ['preflight'], `recorded ${runs.map(p => p.properties.suite)}:\n${r.out.slice(-1500)}`);
      const text = JSON.stringify(spoolOf(r.dir));
      assert.equal(text.includes('a leftover failure'), false, 'another run\'s failure is in the spool');
      assert.equal(text.includes(FAILING_TEST), true, 'this run\'s failure is not');
    });
  });

  it('at the builder: a file older than the run is not recorded whatever its name, a fresh one is, and another suite\'s fresh file never is', async () => {
    const { preflightTestRunPayloads } = await timesModule();
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-builder-'));
    try {
      const startedAt = new Date().toISOString();
      const write = (name, text, ageMs) => {
        const path = join(dir, name);
        writeFileSync(path, text);
        const when = new Date(Date.now() - ageMs);
        utimesSync(path, when, when);
      };
      write('preflight-old-1.jsonl', nodeResults('subset'), 3_600_000);
      write('client.json', JSON.stringify(clientReport('failed', { root: dir, startMs: Date.now() - 3_600_000 })), 3_600_000);
      write('standalone-0.jsonl', jsonlFor({ suite: 'standalone', batch: '0', files: [{ file: 'testing/standalone/x.test.js', ms: 1, tests: [{ name: 'x', status: 'fail', message: 'm' }] }] }), 0);
      const identity = { commit: 'a'.repeat(40), branch: 'b', dirty: false };
      const none = preflightTestRunPayloads({ resultsDir: dir, startedAt, root: dir, ...identity });
      assert.deepEqual(none.payloads.map(p => p.properties.suite), [], 'an old file or another suite was recorded');
      write('preflight-pure-1.jsonl', nodeResults('subset'), 0);
      const one = preflightTestRunPayloads({ resultsDir: dir, startedAt, root: dir, ...identity });
      assert.deepEqual(one.payloads.map(p => p.properties.suite), ['preflight']);
      assert.equal(JSON.stringify(one.payloads).includes('an-older-run'), false);
      assert.equal(one.payloads[0].properties.measurements.includes(FAILING_TEST), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a client report that is not a report is one problem and no throw, and the node suite is still recorded', async () => {
    const { preflightTestRunPayloads } = await timesModule();
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-builder-'));
    try {
      const startedAt = new Date(Date.now() - 1000).toISOString();
      writeFileSync(join(dir, 'preflight-pure-1.jsonl'), nodeResults('subset'));
      writeFileSync(join(dir, 'client.json'), 'not json');
      const r = preflightTestRunPayloads({ resultsDir: dir, startedAt, root: dir, commit: 'a'.repeat(40), branch: 'b', dirty: false });
      assert.deepEqual(r.payloads.map(p => p.properties.suite), ['preflight']);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /client/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('recording never changes the preflight', () => {
  const statusAndVerdict = (r) => ({ status: r.status, verdict: verdictOf(r.out) });

  it('with the instance unset, answering 500 and reachable the exit status and the verdict are the same, and what was not sent stays spooled', async () => {
    const down = await startFakeYthril({ respond: () => ({ status: 500, body: { ok: false, error: 'planted' } }) });
    const up = await startFakeYthril();
    try {
      const node = nodeResults('subset');
      const unset = await withPreflight([], { node }, async (r) => ({ ...statusAndVerdict(r), spooled: spoolOf(r.dir).length }));
      const refused = await withPreflight([], { node, env: { YTHRIL_TEST_RUNS_URL: down.url, YTHRIL_TEST_RUNS_TOKEN: down.token } }, async (r) => ({ ...statusAndVerdict(r), spooled: spoolOf(r.dir).length }));
      const sent = await withPreflight([], { node, env: { YTHRIL_TEST_RUNS_URL: up.url, YTHRIL_TEST_RUNS_TOKEN: up.token } }, async (r) => ({ ...statusAndVerdict(r), spooled: spoolOf(r.dir).length }));
      assert.equal(unset.status, 1);
      assert.match(unset.verdict, /Preflight FAILED/, unset.verdict);
      assert.deepEqual(refused, { ...unset, spooled: refused.spooled }, 'a 500 changed the exit status or the verdict');
      assert.deepEqual(sent, { ...unset, spooled: sent.spooled }, 'a reachable instance changed the exit status or the verdict');
      assert.equal(unset.spooled, 2, 'the Test-Run and the Preflight-Run stay spooled with no instance');
      assert.equal(refused.spooled, 2, 'a 500 left something unsent that is not spooled');
      assert.equal(sent.spooled, 0, 'a reachable instance left something spooled');
      assert.deepEqual(up.store.map(e => e.type).sort(), ['Preflight-Run', 'Test-Run']);
      assert.equal(up.store.find(e => e.type === 'Test-Run').properties.runKind, 'preflight');
    } finally { await down.close(); await up.close(); }
  });

  it('a later drain sends what the first could not', async () => {
    let answer = 500;
    const server = await startFakeYthril({ respond: () => (answer === 500 ? { status: 500, body: { ok: false, error: 'planted' } } : undefined) });
    try {
      await withPreflight([], { node: nodeResults('subset') }, async (r) => {
        assert.equal(testRunsOf(r.dir).length, 1, r.out.slice(-1500));
        const env = { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token };
        const first = await runTimes(['--drain-unrecorded'], { cwd: r.dir, env });
        assert.equal(first.code, 0, everything(first));
        assert.equal(spoolOf(r.dir).length, 2, `the first drain, refused, lost something:\n${everything(first)}`);
        answer = 200;
        const second = await runTimes(['--drain-unrecorded'], { cwd: r.dir, env });
        assert.equal(second.code, 0, everything(second));
        assert.deepEqual(spoolOf(r.dir), [], `the second drain left something:\n${everything(second)}`);
        const held = server.store.find(e => e.type === 'Test-Run');
        assert.ok(held, 'the Test-Run never reached the instance');
        assert.equal(held.properties.runKind, 'preflight');
        assert.equal(held.properties.suite, 'preflight');
      });
    } finally { await server.close(); }
  });

  it('the token is in no spooled file and in no line the run printed', async () => {
    const down = await startFakeYthril({ token: `${FAKE_TOKEN}-secret`, respond: () => ({ status: 500, body: { ok: false, error: 'planted' } }) });
    try {
      await withPreflight([], { node: nodeResults('subset'), env: { YTHRIL_TEST_RUNS_URL: down.url, YTHRIL_TEST_RUNS_TOKEN: down.token } }, async (r) => {
        assert.equal(spoolOf(r.dir).length, 2, r.out.slice(-1500));
        assert.equal(JSON.stringify(spoolOf(r.dir)).includes(down.token), false, 'the token is in the spool');
        assert.equal(r.out.includes(down.token), false, 'the token is in what the run printed');
      });
    } finally { await down.close(); }
  });
});

describe('what a preflight record says about itself', () => {
  it('a run with no git to name its commit is recorded as having uncommitted changes (never paired by commit)', async () => {
    const { preflightTestRunPayloads } = await timesModule();
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-builder-'));
    try {
      writeFileSync(join(dir, 'preflight-pure-1.jsonl'), nodeResults('subset'));
      const r = preflightTestRunPayloads({ resultsDir: dir, startedAt: new Date(Date.now() - 1000).toISOString(), root: dir, commit: 'unknown', branch: 'unknown', dirty: false });
      assert.equal(r.payloads.length, 1);
      assert.equal(r.payloads[0].properties.dirty, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is never a time baseline, even dressed as a green full run of main, and a static run\'s scope is static', async () => {
    const { preflightTestRunPayloads } = await timesModule();
    const { isTimeBaselineRun } = await baselineModule();
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-builder-'));
    try {
      writeFileSync(join(dir, 'preflight-pure-1.jsonl'), nodeResults('static'));
      const [payload] = preflightTestRunPayloads({ resultsDir: dir, startedAt: new Date(Date.now() - 1000).toISOString(), root: dir, commit: 'a'.repeat(40), branch: 'main', dirty: false }).payloads;
      assert.equal(payload.properties.scope, 'static');
      assert.notEqual(payload.properties.scope, 'full');
      assert.equal(isTimeBaselineRun(payload.properties), false);
      assert.equal(isTimeBaselineRun({ ...payload.properties, source: 'ci', branch: 'main', scope: 'full', outcome: 'passed' }), false, 'the kind alone must refuse it');
      assert.equal(isTimeBaselineRun({ ...payload.properties, runKind: 'push-main', source: 'ci', branch: 'main', scope: 'full', outcome: 'passed' }), true, 'the control: the same fields as a push to main qualify');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
