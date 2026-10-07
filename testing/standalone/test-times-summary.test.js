/**
 * `node scripts/test-times.mjs --summary --results <dir>` — what the advisory job of CI prints about a run (bundle-56,
 * Q-370): per suite totals, the slowest files and tests, every skip with its reason, the failures, and (when it can
 * reach GitHub) the files and suites slower than the last ten runs of main.
 *
 * ## What this prevents
 *
 * The advisory job called `scripts/test-times.mjs` with no command, which prints the help and exits 1: an advisory step
 * that always failed, and a run summary nobody could read. Four things are pinned so it cannot go quiet again:
 *
 * 1. **It reads the results, not the help.** Every figure comes from the timing reporter's JSONL through the one
 *    counting rule the recorder uses (`summariseSuite`): a failure is counted once, a skipped suite is a skip, a file
 *    without its sentinel is `incomplete` and never `passed`. The client's vitest report is one more suite, read by the
 *    recorder's own client rule (bundle-73, Q-378): the same row as a node suite's (files, time, wall, outcome), its failures
 *    listed with their reason, a file that never collected counted once, and a report that cannot be read a line that never
 *    quotes it. Failure messages are text from a test: shown as inline code, so none of it is markdown.
 * 2. **Every skip is shown with its reason, and an unexpected one is marked** (the same list the aggregator reads,
 *    `testing/_shared/expected-in-ci.mjs`), so the page that reports the run says what the gate would say.
 * 3. **The baseline is bounded and never costs the summary.** At most ten trusted successful runs of main are read, the
 *    judged run itself is not one of them, an untrusted run's artifacts are never asked for, and a failure to reach
 *    GitHub (a bad token, a corrupt artifact) is a visible `::warning` while the summary still prints and the exit is 0.
 * 4. **Both outputs.** The markdown goes to `$GITHUB_STEP_SUMMARY` when it is set, and to stdout always (the job log).
 *
 * ## The interface this pins
 *
 * The suite table's columns are `suite | tests | passed | failed | skipped | files | test time | wall | outcome`.
 * Exit 0 whenever a summary was printed; 1 when there was nothing to summarise (no results, or no `--results`).
 *
 * Local servers only; nothing here reaches github.com.
 *
 * Run: node --test testing/standalone/test-times-summary.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeGithub, FAKE_GH_TOKEN } from '../_shared/fake-github-actions.mjs';
import { jsonlFor, makeWorkdir, runTimes, runTimesWithoutPackages, everything, T, githubRun, resultsArtifact, clientArtifact } from '../_shared/test-times-harness.mjs';
import { buildZip } from '../_shared/zip-builder.mjs';
import { clientReport } from '../_shared/client-report-fixtures.mjs';

const LISTED = 'testing/standalone/the-extractor-finds-its-mentions.test.js';
const A = 'testing/standalone/a.test.js';

const STANDALONE = {
  suite: 'standalone', batch: 'pure-1',
  files: [
    { file: A, ms: 60_000, tests: [T('fast one', 10), T('slow one', 40_000), T('broken one', 5, { status: 'fail', message: 'boom: expected 1' })] },
    { file: 'testing/standalone/b.test.js', ms: 2000, tests: [T('skipped without cause', 1, { skip: true, reason: 'no sidecar' })] },
    { file: LISTED, ms: 100, tests: [T('corpus sweep', 1, { skip: true, reason: 'expected-in-ci: corpus not fetched' })] },
  ],
};
const INTEGRATION = { suite: 'integration', batch: '1', files: [{ file: 'testing/integration/i.test.js', ms: 3000, tests: [T('one', 1000), T('two', 2000)] }] };

/** A results folder holding these specs (and optionally a client report), in a scratch work directory. */
function results(work, specs, { client } = {}) {
  const dir = join(work.dir, 'results');
  mkdirSync(dir, { recursive: true });
  for (const s of specs) writeFileSync(join(dir, `${s.suite}-${s.batch}.jsonl`), s.text ?? jsonlFor(s));
  if (client) writeFileSync(join(dir, 'client.json'), JSON.stringify(client));
  return dir;
}
const vitest = (...statuses) => ({
  numTotalTests: statuses.length,
  testResults: [{ name: join(process.cwd(), 'client/src/app/x.spec.ts'), assertionResults: statuses.map((status, i) => ({ title: `case ${i}`, fullName: `x case ${i}`, status })) }],
});

const summary = (args, work, env = {}) => runTimes(['--summary', ...args], { cwd: work.dir, env });
const withWork = async (body) => { const work = makeWorkdir(); try { return await body(work); } finally { work.cleanup(); } };
const rowOf = (out, suite) => out.split('\n').find(l => new RegExp(`^\\|\\s*${suite}\\s*\\|`).test(l));
/** The lines of `out` holding every needle: a fact may be on several lines (a table of the slowest, a list of skips). */
const linesWith = (out, ...needles) => out.split('\n').filter(l => needles.every(n => l.includes(n)));
const cells = (row) => row.split('|').slice(1, -1).map(c => c.trim());

describe('--summary: the results', () => {
  it('prints one row per suite with its counts, from the reporter\'s lines (a failure once, a skip per skipped test)', async () => {
    await withWork(async (work) => {
      const dir = results(work, [STANDALONE, INTEGRATION]);
      const r = await summary(['--results', dir], work);
      assert.equal(r.code, 0, everything(r));
      assert.doesNotMatch(r.stdout, /usage:/, 'the help was printed in place of a summary');
      const standalone = cells(rowOf(r.stdout, 'standalone') ?? '');
      assert.deepEqual(standalone.slice(0, 6), ['standalone', '5', '2', '1', '2', '3'], `standalone row: ${standalone}`);
      assert.equal(standalone.at(-1), 'failed');
      const integration = cells(rowOf(r.stdout, 'integration') ?? '');
      assert.deepEqual(integration.slice(0, 6), ['integration', '2', '2', '0', '0', '1']);
      assert.equal(integration.at(-1), 'passed');
    });
  });

  it('names the slowest files and tests, slowest first', async () => {
    await withWork(async (work) => {
      const r = await summary(['--results', results(work, [STANDALONE, INTEGRATION])], work);
      const out = r.stdout;
      assert.ok(out.indexOf(A) >= 0 && out.indexOf(A) < out.indexOf('testing/standalone/b.test.js'), `the slowest file is not first:\n${out}`);
      assert.ok(out.indexOf('slow one') >= 0 && out.indexOf('slow one') < out.indexOf('fast one'), `the slowest test is not first:\n${out}`);
    });
  });

  it('shows every skip with its reason, and marks the unexpected one — not the one the list expects', async () => {
    await withWork(async (work) => {
      const r = await summary(['--results', results(work, [STANDALONE])], work);
      const noCause = linesWith(r.stdout, 'skipped without cause', 'no sidecar');
      assert.ok(noCause.length >= 1, `the skip and its reason are not on one line:\n${r.stdout}`);
      assert.ok(noCause.some(l => /unexpected/i.test(l)), 'an unexpected skip is not marked');
      const corpus = linesWith(r.stdout, 'corpus sweep', 'expected-in-ci: corpus not fetched');
      assert.ok(corpus.length >= 1, `the expected skip is missing:\n${r.stdout}`);
      assert.ok(corpus.every(l => !/unexpected/i.test(l)), 'an expected skip is marked unexpected');
    });
  });

  it('lists the failures with the first line of their message', async () => {
    await withWork(async (work) => {
      const r = await summary(['--results', results(work, [STANDALONE])], work);
      assert.ok(linesWith(r.stdout, 'broken one', 'boom: expected 1').length >= 1, `the failure is not listed with its message:\n${r.stdout}`);
    });
  });

  it('a file without its sentinel is INCOMPLETE, never passed', async () => {
    await withWork(async (work) => {
      const cut = { ...INTEGRATION, text: jsonlFor({ ...INTEGRATION, sentinel: 'missing' }) };
      const r = await summary(['--results', results(work, [STANDALONE, cut])], work);
      assert.equal(r.code, 0, everything(r));
      assert.equal(cells(rowOf(r.stdout, 'integration') ?? '').at(-1), 'incomplete');
    });
  });

  it('the client\'s vitest report is a row, and any skip in it is listed as unexpected', async () => {
    await withWork(async (work) => {
      const dir = results(work, [STANDALONE], { client: vitest('passed', 'passed', 'skipped', 'failed') });
      const r = await summary(['--results', dir], work);
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(cells(rowOf(r.stdout, 'client') ?? '').slice(0, 5), ['client', '4', '2', '1', '1'], r.stdout);
      assert.ok(linesWith(r.stdout, 'x case 2').some(l => /unexpected/i.test(l)), `the client's skip is not shown as unexpected:\n${r.stdout}`);
    });
  });

  it('writes the same markdown to $GITHUB_STEP_SUMMARY when it is set, and still prints it', async () => {
    await withWork(async (work) => {
      const file = join(work.dir, 'step-summary.md');
      const r = await summary(['--results', results(work, [STANDALONE, INTEGRATION])], work, { GITHUB_STEP_SUMMARY: file });
      assert.equal(r.code, 0, everything(r));
      assert.ok(existsSync(file), 'nothing was written to $GITHUB_STEP_SUMMARY');
      const written = readFileSync(file, 'utf8');
      assert.ok(rowOf(written, 'standalone') && rowOf(written, 'integration'), `the step summary lacks the suite rows:\n${written}`);
      assert.ok(r.stdout.includes(written.trim()), 'stdout is not a superset of the step summary');
    });
  });

  it('nothing to summarise is a message and exit 1 — never the help text', async () => {
    await withWork(async (work) => {
      for (const dir of [join(work.dir, 'never-made'), results(work, [])]) {
        const r = await summary(['--results', dir], work);
        assert.equal(r.code, 1, everything(r));
        assert.doesNotMatch(everything(r), /usage:/);
        assert.match(everything(r), /no results|nothing to summari[sz]e/i);
      }
    });
  });

  it('without --results it is a usage error, not a guess at a folder', async () => {
    await withWork(async (work) => {
      const r = await summary([], work);
      assert.equal(r.code, 1);
      assert.match(everything(r), /usage:/);
    });
  });

  it('--help documents it', async () => {
    await withWork(async (work) => {
      const r = await runTimes(['--help'], { cwd: work.dir });
      assert.match(r.stdout, /--summary --results/);
    });
  });
});

// ── the baseline: the last ten trusted runs of main ──

/** The baseline's runs differ in when they started (a run's id says how many minutes after the first), so "the last ten" is decidable. */
const run = (id, over = {}) => githubRun(id, { run_started_at: new Date(Date.UTC(2026, 9, 1, 0, id - 2000)).toISOString(), ...over });
const artifact = (id, ...specs) => resultsArtifact(id, 'test-results-standalone-pure-1', ...specs.map((s) => [`${s.suite}-${s.batch}.jsonl`, s]));
/** The usual standalone run of main: the file takes 5 s. */
const usual = { suite: 'standalone', batch: 'pure-1', files: [{ file: A, ms: 5000, tests: [T('fast one', 10)] }] };

function world({ corrupt = [] } = {}) {
  const trusted = Array.from({ length: 12 }, (_, i) => run(2001 + i));
  const runs = [
    ...trusted,
    run(2101, { head_repository: { full_name: 'attacker/Ythril' } }),   // a fork's push
    run(2102, { event: 'pull_request' }),                                  // a pull request
    run(2103, { conclusion: 'failure' }),                                  // trusted identity, but red: no baseline
  ];
  const artifactsByRun = Object.fromEntries(runs.map((r, i) => [r.id, [artifact(9000 + i, usual)]]));
  for (const id of corrupt) artifactsByRun[id] = [{ id: 9900 + id, name: 'test-results-standalone-pure-1', zip: Buffer.from('this is not a zip archive at all') }];
  return { runs, jobsByRun: {}, artifactsByRun };
}

async function withGithub(opts, body) {
  const github = await startFakeGithub(world(opts));
  const work = makeWorkdir();
  try { return await body({ github, work, env: { GITHUB_API_URL: github.url, GH_TOKEN: FAKE_GH_TOKEN, GITHUB_RUN_ID: '2012' } }); } finally { await github.close(); work.cleanup(); }
}

describe('--summary: the baseline', () => {
  it('flags a file slower than the last ten runs of main, naming file, suite, time and limit', async () => {
    await withGithub({}, async ({ work, env }) => {
      const r = await summary(['--results', results(work, [STANDALONE])], work, env);
      assert.equal(r.code, 0, everything(r));
      const slow = r.stdout.split('\n').find(l => /slow file/.test(l) && l.includes(A));
      assert.ok(slow && /standalone/.test(slow), `the slow file is not flagged:\n${r.stdout}`);
    });
  });

  it('reads at most ten runs, never the judged run, never an untrusted or red one', async () => {
    await withGithub({}, async ({ github, work, env }) => {
      await summary(['--results', results(work, [STANDALONE])], work, env);
      const asked = github.askedAbout();
      assert.ok(asked.size > 0 && asked.size <= 10, `${asked.size} runs were read: ${[...asked]}`);
      assert.ok(!asked.has('2012'), 'the judged run is part of its own baseline');
      for (const id of ['2101', '2102', '2103']) assert.ok(!asked.has(id), `run ${id} (fork, pull request, red) was read`);
    });
  });

  it('no GH_TOKEN: the baseline is skipped with one visible line, the summary still prints, exit 0', async () => {
    await withWork(async (work) => {
      const r = await summary(['--results', results(work, [STANDALONE])], work);
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /baseline[^\n]*(skipped|not read)[^\n]*GH_TOKEN/i);
      assert.ok(rowOf(r.stdout, 'standalone'));
    });
  });

  it('GitHub refusing the token is a warning, never a failed summary', async () => {
    await withGithub({}, async ({ work, env }) => {
      const r = await summary(['--results', results(work, [STANDALONE])], work, { ...env, GH_TOKEN: 'ghp_wrongTokenwrongTokenwrongTokenwrong0' });
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /::warning[^\n]*baseline/i, `no visible warning:\n${r.stdout}`);
      assert.ok(rowOf(r.stdout, 'standalone'), 'the summary was lost with the baseline');
      assert.doesNotMatch(everything(r), /wrongToken/, 'the token was printed');
    });
  });

  it('one run\'s corrupt artifact is a warning naming the run; the others still judge', async () => {
    await withGithub({ corrupt: [2005] }, async ({ work, env }) => {
      const r = await summary(['--results', results(work, [STANDALONE])], work, env);
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /::warning[^\n]*2005/, `the corrupt run is not named:\n${r.stdout}`);
      assert.ok(r.stdout.split('\n').some(l => /slow file/.test(l) && l.includes(A)), `the remaining runs did not judge:\n${r.stdout}`);
    });
  });

  it('a file as fast as usual is not flagged', async () => {
    await withGithub({}, async ({ work, env }) => {
      const same = { ...STANDALONE, files: [{ file: A, ms: 5200, tests: [T('fast one', 10)] }] };
      const r = await summary(['--results', results(work, [same])], work, env);
      assert.equal(r.code, 0, everything(r));
      assert.doesNotMatch(r.stdout, /slow file/);
      assert.match(r.stdout, /no flags/i);
    });
  });
});

// ── the client, read by the recorder's own rule (bundle-73, Q-378) ──

const CLIENT_START = Date.UTC(2026, 9, 5, 10, 0, 0);
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
/** A REAL vitest report (see `_fixtures/client-reports/README.md`), its specs under this work directory. */
const clientIn = (work, name, mutate = () => {}) => { const r = clientReport(name, { root: work.dir, startMs: CLIENT_START }); mutate(r); return r; };
const setFileMs = (report, ms) => { for (const f of report.testResults) f.endTime = f.startTime + ms; return report; };

describe('--summary: the client is a suite like the others', () => {
  it('has the same row as a node suite — tests, passed, failed, skipped, FILES, test time, wall and outcome', async () => {
    await withWork(async (work) => {
      const r = await summary(['--results', results(work, [STANDALONE], { client: clientIn(work, 'failed') })], work);
      assert.equal(r.code, 0, everything(r));
      const client = cells(rowOf(r.stdout, 'client') ?? '');
      assert.deepEqual(client.slice(0, 6), ['client', '2', '1', '1', '0', '1'], `client row: ${client}`);
      assert.match(client[6], /^\d+\.\d s$/, 'the client row has no test time');
      assert.match(client[7], /^\d+\.\d s$/, 'the client row has no wall');
      assert.equal(client[8], 'failed');
    });
  });

  it('lists the client\'s failures with the first line of their reason, like a node failure', async () => {
    await withWork(async (work) => {
      const r = await summary(['--results', results(work, [STANDALONE], { client: clientIn(work, 'failed') })], work);
      assert.ok(linesWith(r.stdout, 'fail.spec.ts', 'AssertionError: expected 2 to be 3').length >= 1, `the client failure is not listed with its reason:\n${r.stdout}`);
    });
  });

  it('counts a file that never collected once, with its reason, and a run of nothing but such files is failed — not a note that the report holds no test', async () => {
    await withWork(async (work) => {
      const some = await summary(['--results', results(work, [STANDALONE], { client: clientIn(work, 'collection-failure') })], work);
      assert.deepEqual(cells(rowOf(some.stdout, 'client') ?? '').slice(0, 6), ['client', '2', '1', '1', '0', '2'], some.stdout);
      assert.ok(linesWith(some.stdout, 'collection-failure.spec.ts', 'Failed to resolve import').length >= 1, `the failed collection is not listed:\n${some.stdout}`);
      const all = await summary(['--results', results(work, [STANDALONE], { client: clientIn(work, 'all-collection-failure') })], work);
      assert.equal(all.code, 0, everything(all));
      assert.equal(cells(rowOf(all.stdout, 'client') ?? '').at(-1), 'failed', `every file failing at collection is a failed client, not a missing one:\n${all.stdout}`);
      assert.doesNotMatch(all.stdout, /Client results:/);
    });
  });

  it('a hook that threw is one failure with `(no message)`, and its skipped tests are skips', async () => {
    await withWork(async (work) => {
      const r = await summary(['--results', results(work, [STANDALONE], { client: clientIn(work, 'beforeall-failure') })], work);
      assert.deepEqual(cells(rowOf(r.stdout, 'client') ?? '').slice(0, 5), ['client', '3', '0', '1', '2'], r.stdout);
      assert.ok(linesWith(r.stdout, 'beforeall-failure.spec.ts', '(no message)').length >= 1, `the failed hook is not listed:\n${r.stdout}`);
    });
  });

  it('a test still pending, or a runner that stamped failure, makes the client `incomplete`', async () => {
    await withWork(async (work) => {
      for (const mutate of [(r) => { r.testResults[0].assertionResults[0].status = 'pending'; }, (r) => { r.runnerOutcome = 'failure'; }]) {
        const r = await summary(['--results', results(work, [STANDALONE], { client: clientIn(work, 'passed', mutate) })], work);
        assert.equal(cells(rowOf(r.stdout, 'client') ?? '').at(-1), 'incomplete', r.stdout);
      }
    });
  });

  it('a report that cannot be read is one line naming the reason, never the report — and the node suites still print', async () => {
    await withWork(async (work) => {
      for (const body of [`{"testResults": [ ${TOKEN} `, JSON.stringify({ secret: TOKEN })]) {
        const dir = results(work, [STANDALONE]);
        writeFileSync(join(dir, 'client.json'), body);
        const r = await summary(['--results', dir], work);
        assert.equal(r.code, 0, everything(r));
        assert.ok(rowOf(r.stdout, 'standalone'), 'the node rows were lost with the client');
        assert.match(r.stdout, /Client results:/);
        assert.ok(!everything(r).includes(TOKEN), 'the summary quotes the report');
        assert.doesNotMatch(everything(r), /Unexpected token|is not valid JSON|position \d+/);
      }
    });
  });

  it('shows a failure message as inline code with its backticks removed, for a node suite and for the client alike', async () => {
    await withWork(async (work) => {
      const message = 'boom: `rm -rf /` **bold** [link](http://example.invalid) <b>x</b>';
      const loud = { ...STANDALONE, files: [{ file: A, ms: 1000, tests: [T('broken one', 5, { status: 'fail', message })] }] };
      const r = await summary(['--results', results(work, [loud], { client: clientIn(work, 'failed', (c) => { c.testResults[0].assertionResults[1].failureMessages = [message]; }) })], work);
      assert.equal(r.code, 0, everything(r));
      const failures = r.stdout.split('\n').filter(l => /^- /.test(l) && /rm -rf/.test(l));
      assert.equal(failures.length, 2, `one failure line per suite:\n${r.stdout}`);
      for (const line of failures) {
        const shown = /: `([^`]*)`$/.exec(line);
        assert.ok(shown, `the message is not one inline code span at the end of the line: ${line}`);
        assert.ok(shown[1].includes('rm -rf /') && shown[1].includes('**bold**'), `the message is not kept whole inside the span: ${line}`);
      }
    });
  });

  it('runs where nothing is installed, as the advisory job does: no package is imported, and the client row and failures still print', async () => {
    await withWork(async (work) => {
      const dir = results(work, [STANDALONE], { client: clientIn(work, 'failed') });
      const r = await runTimesWithoutPackages(['--summary', '--results', dir], { cwd: work.dir });
      assert.equal(r.code, 0, everything(r));
      assert.doesNotMatch(everything(r), /no-packages:/, `the summary reaches a package: ${everything(r).split('\n').find(l => /no-packages:/.test(l))}`);
      assert.ok(rowOf(r.stdout, 'standalone') && rowOf(r.stdout, 'client'));
      assert.ok(linesWith(r.stdout, 'fail.spec.ts', 'AssertionError: expected 2 to be 3').length >= 1, `the client failure is not listed:\n${r.stdout}`);
    });
  });
});

// ── the baseline reads the client through the same parser, each suite on its own ──

const CI_ROOT = '/home/runner/work/Ythril/Ythril';
const usualClient = () => setFileMs(clientReport('passed', { root: CI_ROOT, startMs: CLIENT_START }), 5000);
const INTEGRATION_USUAL = { suite: 'integration', batch: '1', files: [{ file: 'testing/integration/i.test.js', ms: 5000, tests: [T('one', 10)] }] };

/**
 * Twelve trusted runs of main whose artifacts hold the node jobs' results and (per `client`) the client job's.
 * `client(id)` is the client job's artifact for run `id`, or null; `node(id)` the node artifacts.
 */
function worldOf({ client = (id) => clientArtifact(9500 + id, usualClient(), { root: CI_ROOT }), node = (id) => [artifact(9000 + id, usual)] } = {}) {
  const runs = Array.from({ length: 12 }, (_, i) => run(2001 + i));
  const artifactsByRun = Object.fromEntries(runs.map(r => [r.id, [...node(r.id), ...(client(r.id) ? [client(r.id)] : [])]]));
  return { runs, jobsByRun: {}, artifactsByRun };
}

async function withBaseline(opts, body) {
  const github = await startFakeGithub(worldOf(opts));
  const work = makeWorkdir();
  try { return await body({ github, work, env: { GITHUB_API_URL: github.url, GH_TOKEN: FAKE_GH_TOKEN, GITHUB_RUN_ID: '2012' } }); } finally { await github.close(); work.cleanup(); }
}

describe('--summary: the baseline reads the client like any suite', () => {
  it('flags a client file and suite slower than the last runs of main, naming the suite', async () => {
    await withBaseline({}, async ({ work, env }) => {
      const dir = results(work, [{ ...STANDALONE, files: [{ file: A, ms: 5200, tests: [T('fast one', 10)] }] }], { client: setFileMs(clientIn(work, 'passed'), 60_000) });
      const r = await summary(['--results', dir], work, env);
      assert.equal(r.code, 0, everything(r));
      assert.ok(r.stdout.split('\n').some(l => /slow file/.test(l) && l.includes('pass-one.spec.ts') && /\bclient\b/.test(l)), `the slow client file is not flagged:\n${r.stdout}`);
      assert.ok(r.stdout.split('\n').some(l => /slow suite/.test(l) && /\bclient\b/.test(l)), `the slow client suite is not flagged:\n${r.stdout}`);
    });
  });

  it('a history that never had a client report is not a problem: silent, and the node suites still judge', async () => {
    await withBaseline({ client: () => null }, async ({ work, env }) => {
      const dir = results(work, [STANDALONE], { client: setFileMs(clientIn(work, 'passed'), 60_000) });
      const r = await summary(['--results', dir], work, env);
      assert.equal(r.code, 0, everything(r));
      assert.ok(r.stdout.split('\n').some(l => /slow file/.test(l) && l.includes(A)), `the node baseline was lost:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /::warning[^\n]*client/i, 'a run without a client report is not a warning');
    });
  });

  it('one earlier run\'s unreadable client report costs only the client of THAT run: a fixed line names the run, the node suites of it still count', async () => {
    const unreadable = (id) => (id === 2005
      ? { id: 9900 + id, name: 'test-results-client-tests-1', zip: buildBadClientZip() }
      : clientArtifact(9500 + id, usualClient(), { root: CI_ROOT }));
    await withBaseline({ client: unreadable }, async ({ work, env }) => {
      const dir = results(work, [STANDALONE], { client: setFileMs(clientIn(work, 'passed'), 60_000) });
      const r = await summary(['--results', dir], work, env);
      assert.equal(r.code, 0, everything(r));
      assert.ok(r.stdout.split('\n').some(l => /2005/.test(l) && /client/i.test(l)), `the run whose client report is unreadable is not named:\n${r.stdout}`);
      assert.ok(!everything(r).includes(TOKEN), 'the earlier run\'s report was quoted');
      assert.doesNotMatch(everything(r), /Unexpected token|is not valid JSON|position \d+/);
      assert.match(r.stdout, /compared with 10 run\(s\)/, 'the unreadable client report cost its run\'s node suites too');
      assert.ok(r.stdout.split('\n').some(l => /slow file/.test(l) && l.includes('pass-one.spec.ts')), `the other runs no longer judge the client:\n${r.stdout}`);
    });
  });

  it('a run\'s scope is judged per suite: a node suite that covered a subset in every earlier run does not take the others\' baselines with it', async () => {
    const node = (id) => [
      resultsArtifact(9000 + id, 'test-results-standalone-pure-1', ['standalone-pure-1.jsonl', { ...usual, scope: 'files' }]),
      resultsArtifact(9300 + id, 'test-results-integration-1', ['integration-1.jsonl', INTEGRATION_USUAL]),
    ];
    await withBaseline({ node, client: () => null }, async ({ work, env }) => {
      const slow = { ...INTEGRATION_USUAL, files: [{ file: 'testing/integration/i.test.js', ms: 60_000, tests: [T('one', 10)] }] };
      const r = await summary(['--results', results(work, [{ ...usual }, slow])], work, env);
      assert.equal(r.code, 0, everything(r));
      assert.ok(r.stdout.split('\n').some(l => /slow file/.test(l) && l.includes('testing/integration/i.test.js')), `the integration suite has no baseline because another suite's earlier runs covered a subset:\n${r.stdout}`);
    });
  });
});

/** An artifact whose `client.json` is cut off with a token in it. */
function buildBadClientZip() {
  return buildZip([{ name: 'client.json', data: `{"testResults": [ ${TOKEN} ` }]);
}
