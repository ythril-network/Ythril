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
 *    without its sentinel is `incomplete` and never `passed`. The client's vitest report is one more row.
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
import { jsonlFor, makeWorkdir, runTimes, everything, T, githubRun, resultsArtifact } from '../_shared/test-times-harness.mjs';

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
