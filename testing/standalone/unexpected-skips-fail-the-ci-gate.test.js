/**
 * `scripts/unexpected-skips.mjs` — a skip CI did not expect fails the run, and a results set it cannot read is not a
 * clean one (bundle-56, Q-272: nothing skips silently).
 *
 * ## The failure this prevents
 *
 * A skipped test proved nothing, and a run with skips in it still ends green. An unbuilt client, a sidecar that never
 * came up and an embedder that never loaded each read as "passing" for as long as a skip is allowed to stand for a
 * result. The aggregator (`Build & Test`) reads every job's timing JSONL and the client's vitest JSON and fails on a
 * skip unless the skip says it was expected AND sits in a file the committed list allows (`testing/_shared/expected-in-ci.mjs`;
 * `a-skip-that-expects-ci-lives-in-a-listed-file` holds the source half, this holds the run half).
 *
 * ## The truth table, one row each
 *
 * Exit 0 only when the set is whole, holds test events, and every skip is expected; exit 1 names the rest; exit 2 means
 * the set cannot answer the question:
 *
 *   skip reason starts `expected-in-ci:`, file on the list ......................... 0
 *   skip reason starts `expected-in-ci:`, file NOT on the list ..................... 1  (a prefix anywhere buys nothing)
 *   skip reason without the prefix, file on the list ............................... 1  (the file is allowed, the cause is not)
 *   skip without a reason (`t.skip()`, `{ skip: true }`) ........................... 1
 *   the prefix in the middle of a reason, not at its start ......................... 1
 *   a skipped SUITE (its children are never reported) .............................. 1  (node's own count misses it)
 *   a todo, a pass, a fail ......................................................... not skips; 0 for the first two
 *   a vitest assertion that is not `passed` or `failed` ............................ 1  (client: no skip is expected)
 *   a JSONL without its closing sentinel, torn, or with a count that disagrees ..... 2  (a cut-off run is unknown, not clean)
 *   an empty, missing or event-less results directory .............................. 2
 *   no client results beside the node ones, or client results that do not parse .... 2
 *   an unreadable set AND an unexpected skip in the readable part .................. 2  (the unknown wins; it never reports a partial list as the list)
 *
 * The last row matters most: a reader that skips a damaged file and reports on the rest returns 0 or 1 about a run it
 * did not see. Exit codes are the interface (CI keys on them); the text names file, test and reason.
 *
 * Also held here: the scripts the gate runs import only node built-ins (so the gate job needs no `npm ci`), and the real
 * timing reporter's own output, not a hand-written copy of it, is what the script is shown.
 *
 * Run: node --test testing/standalone/unexpected-skips-fail-the-ci-gate.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { bareImports, importClosure } from './_import-closure.mjs';
import { stripComments } from './_strip-comments.mjs';
import { runTimed, fixture } from './_timing-runs.mjs';
import { runScript } from './_run-script.mjs';

const SCRIPT = join(REPO_ROOT, 'scripts', 'unexpected-skips.mjs');
const PREFIX = 'expected-in-ci:';
/** A file the committed list allows, and the cause it allows (read below from the list itself, never typed twice). */
const LISTED = 'testing/standalone/the-extractor-finds-its-mentions.test.js';
const UNLISTED = 'testing/red-team-tests/some-attack.test.js';
const REASON = 'corpus not fetched';

function run(args) {
  return runScript(SCRIPT, args);
}

/** One data line in the timing reporter's shape (`TIMING_SCHEMA`), every key present. */
function line(over) {
  return {
    suite: 'standalone', batch: 'pure-1', file: LISTED, test: 'a test', nesting: 0, type: 'test', ms: 1, status: 'pass',
    skip: false, todo: false, reason: null, message: null, ...over,
  };
}
const skipLine = (over) => line({ skip: true, reason: `${PREFIX} ${REASON}`, ...over });

/** The sentinel the reporter closes a whole file with. */
const endLine = (events) => ({ type: 'end', events, startedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:00:01.000Z', scope: 'full' });

/** A whole JSONL: the data lines and the matching sentinel. */
const whole = (lines) => `${[...lines, endLine(lines.length)].map(o => JSON.stringify(o)).join('\n')}\n`;

/** A vitest JSON report (`--reporter=json`): one file, the given assertion statuses. */
const vitest = (assertions, file = `${REPO_ROOT}/client/src/app/x.spec.ts`) => JSON.stringify({
  numTotalTests: assertions.length,
  testResults: [{
    name: file, status: assertions.some(a => a.status === 'failed') ? 'failed' : 'passed',
    assertionResults: assertions.map(a => ({ ancestorTitles: ['x'], fullName: `x ${a.title}`, title: a.title, status: a.status })),
  }],
});
const CLIENT_OK = vitest([{ title: 'renders', status: 'passed' }]);

describe('scripts/unexpected-skips.mjs — the truth table', () => {
  let root;
  let n = 0;
  before(() => { root = mkdtempSync(join(tmpdir(), 'unexpected-skips-')); });
  after(() => rmSync(root, { recursive: true, force: true }));

  /** A results directory holding these files (name → text); `client` defaults to a clean client report. */
  function results(files, { client = CLIENT_OK } = {}) {
    const dir = join(root, `r${n++}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    if (client !== null) writeFileSync(join(dir, 'client.json'), client);
    return dir;
  }
  const verdict = (files, opts) => run(['--results', results(files, opts)]);

  it('no skip at all: exit 0', () => {
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({}), line({ test: 'b', status: 'fail', message: 'x' })]) });
    assert.equal(status, 0, `a set with no skip was refused:\n${out}`);
  });

  it('a skip carrying the prefix in a file on the list: expected, exit 0', () => {
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({}), skipLine({})]) });
    assert.equal(status, 0, `an expected skip in a listed file failed the run:\n${out}`);
  });

  it('a skip carrying the prefix in a file NOT on the list: exit 1, naming file, test and reason', () => {
    const { status, out } = verdict({ 'redteam-1.jsonl': whole([line({}), skipLine({ file: UNLISTED, test: 'the attack' })]) });
    assert.equal(status, 1, `the prefix excused a skip in an unlisted file:\n${out}`);
    assert.ok(out.includes(UNLISTED), `the file is not named:\n${out}`);
    assert.ok(out.includes('the attack'), `the test is not named:\n${out}`);
    assert.ok(out.includes(`${PREFIX} ${REASON}`), `the reason is not named:\n${out}`);
  });

  it('a skip on a listed file with a reason that lacks the prefix: exit 1', () => {
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({}), skipLine({ reason: REASON, test: 'unprefixed' })]) });
    assert.equal(status, 1, `a skip with no prefix passed because its file is listed:\n${out}`);
    assert.ok(out.includes('unprefixed'), out);
  });

  it('a skip with no reason (t.skip(), { skip: true }): exit 1', () => {
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({}), skipLine({ reason: null, test: 'bare skip' })]) });
    assert.equal(status, 1, `a skip with no reason passed:\n${out}`);
    assert.ok(out.includes(LISTED) && out.includes('bare skip'), out);
  });

  it('the prefix must START the reason: one in the middle is prose, exit 1', () => {
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({}), skipLine({ reason: `waiting for ${PREFIX} ${REASON}`, test: 'mid' })]) });
    assert.equal(status, 1, `a prefix inside a sentence excused a skip:\n${out}`);
  });

  it('a skipped SUITE counts, which node\'s own skipped total does not: exit 1', () => {
    const { status, out } = verdict({
      'standalone-pure-1.jsonl': whole([line({}), line({ type: 'suite', test: 'a skipped suite', skip: true, reason: 'because' })]),
    });
    assert.equal(status, 1, `a skipped suite went unnoticed:\n${out}`);
    assert.ok(out.includes('a skipped suite'), out);
  });

  it('a todo is not a skip', () => {
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({}), line({ test: 'later', todo: true })]) });
    assert.equal(status, 0, `a todo was counted as a skip:\n${out}`);
  });

  it('every skip is named, across every file of the set, not just the first', () => {
    const { status, out } = verdict({
      'standalone-pure-1.jsonl': whole([line({}), skipLine({ reason: 'one', test: 'first skip' })]),
      'integration-1.jsonl': whole([line({ file: 'testing/integration/x.test.js' }), skipLine({ file: 'testing/integration/x.test.js', reason: 'two', test: 'second skip' })]),
      'sync-1.jsonl': whole([line({ file: 'testing/sync/y.test.js' })]),
    });
    assert.equal(status, 1);
    assert.ok(out.includes('first skip') && out.includes('second skip') && out.includes('testing/integration/x.test.js'), `not every skip is named:\n${out}`);
  });

  it('a skip in the client report: exit 1, naming the spec and the test', () => {
    const client = vitest([{ title: 'renders', status: 'passed' }, { title: 'the skipped one', status: 'skipped' }], `${REPO_ROOT}/client/src/app/pages/a.spec.ts`);
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({})]) }, { client });
    assert.equal(status, 1, `a vitest skip passed — none is expected:\n${out}`);
    assert.ok(out.includes('client/src/app/pages/a.spec.ts') && out.includes('the skipped one'), `the spec or the test is not named:\n${out}`);
  });

  it('a client test that neither passed nor failed (todo, pending) did not run to a verdict: exit 1', () => {
    for (const status of ['todo', 'pending', 'disabled']) {
      const client = vitest([{ title: 'renders', status: 'passed' }, { title: `is ${status}`, status }]);
      const r = verdict({ 'standalone-pure-1.jsonl': whole([line({})]) }, { client });
      assert.equal(r.status, 1, `a ${status} client test passed:\n${r.out}`);
    }
  });

  it('a client failure is the job\'s to report, not a skip: exit 0 here', () => {
    const client = vitest([{ title: 'renders', status: 'passed' }, { title: 'breaks', status: 'failed' }]);
    assert.equal(verdict({ 'standalone-pure-1.jsonl': whole([line({})]) }, { client }).status, 0);
  });

  // ── the set cannot answer ──

  it('a JSONL without its sentinel is INCOMPLETE: exit 2, never 0', () => {
    const cut = `${JSON.stringify(line({}))}\n${JSON.stringify(line({ test: 'b' }))}\n`;
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': cut });
    assert.equal(status, 2, `a cut-off run was read as clean:\n${out}`);
    assert.match(out, /standalone-pure-1\.jsonl/, 'the incomplete file is not named');
  });

  it('a torn last line is INCOMPLETE: exit 2', () => {
    const torn = `${whole([line({})])}${JSON.stringify(line({ test: 'c' })).slice(0, 30)}`;
    assert.equal(verdict({ 'standalone-pure-1.jsonl': torn }).status, 2);
  });

  it('a sentinel whose count disagrees with the lines is INCOMPLETE: exit 2', () => {
    const bad = `${[line({}), line({ test: 'b' }), endLine(5)].map(o => JSON.stringify(o)).join('\n')}\n`;
    assert.equal(verdict({ 'standalone-pure-1.jsonl': bad }).status, 2);
  });

  it('one damaged file beside whole ones: exit 2, even when a readable file holds an unexpected skip', () => {
    const { status, out } = verdict({
      'standalone-pure-1.jsonl': whole([line({}), skipLine({ reason: 'unexpected', test: 'visible skip' })]),
      'sync-1.jsonl': `${JSON.stringify(line({ file: 'testing/sync/y.test.js' }))}\n`,
    });
    assert.equal(status, 2, `a partial list was reported as the list:\n${out}`);
  });

  it('an empty results directory: exit 2', () => {
    assert.equal(verdict({}, { client: null }).status, 2);
  });

  it('a results directory with no *.jsonl (only a client report): exit 2', () => {
    assert.equal(verdict({}, { client: CLIENT_OK }).status, 2);
  });

  it('a directory that does not exist: exit 2', () => {
    assert.equal(run(['--results', join(root, 'never-made')]).status, 2);
  });

  it('JSONL files that hold no test event at all: exit 2 — an empty run is not a clean one', () => {
    assert.equal(verdict({ 'standalone-pure-1.jsonl': whole([line({ type: 'file', test: '' })]) }).status, 2);
    assert.equal(verdict({ 'standalone-pure-1.jsonl': whole([]) }).status, 2);
  });

  it('no client report beside the node results: exit 2 (the client job is part of the run)', () => {
    const { status, out } = verdict({ 'standalone-pure-1.jsonl': whole([line({})]) }, { client: null });
    assert.equal(status, 2, `a set without the client's results was read as clean:\n${out}`);
    assert.match(out, /client/);
  });

  it('a client report that does not parse, or that holds no test: exit 2', () => {
    for (const client of ['{ not json', JSON.stringify({ testResults: [] }), JSON.stringify({ numTotalTests: 0, testResults: [{ name: 'a.spec.ts', assertionResults: [] }] }), '[]']) {
      const r = verdict({ 'standalone-pure-1.jsonl': whole([line({})]) }, { client });
      assert.equal(r.status, 2, `client report ${client.slice(0, 40)} was accepted:\n${r.out}`);
    }
  });

  it('no --results, or a flag it does not know: exit 2 with the usage', () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(['--results']).status, 2);
    assert.equal(run(['--results', results({ 'a-1.jsonl': whole([line({})]) }), '--nope']).status, 2);
  });
});

describe('scripts/unexpected-skips.mjs — shown the timing reporter\'s own output', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'unexpected-skips-real-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('every kind of skip node can produce is found, in the file the reporter recorded', () => {
    const resultsDir = join(dir, 'skips');
    const r = runTimed([fixture('timing-skips')], { suite: 'fixture', batch: 'skips', dir: resultsDir, scope: 'files' });
    assert.ok(existsSync(r.destination), `the reporter wrote nothing:\n${r.stderr.slice(0, 400)}`);
    writeFileSync(join(resultsDir, 'client.json'), CLIENT_OK);
    const { status, out } = run(['--results', resultsDir]);
    assert.equal(status, 1, `the fixture's skips went unreported:\n${out}`);
    for (const named of ['timing-skips.fixture.mjs', 'skip via option true', 'skip via t.skip() without a reason', 'skipped suite via describe.skip', 'inner t.skip']) {
      assert.ok(out.includes(named), `${named} is not named:\n${out}`);
    }
  });

  it('a run with no skip, reported by the real reporter, is clean', () => {
    const resultsDir = join(dir, 'clean');
    const r = runTimed([fixture('timing-pass')], { suite: 'fixture', batch: 'pass', dir: resultsDir, scope: 'files' });
    assert.ok(existsSync(r.destination), `the reporter wrote nothing:\n${r.stderr.slice(0, 400)}`);
    writeFileSync(join(resultsDir, 'client.json'), CLIENT_OK);
    const { status, out } = run(['--results', resultsDir]);
    assert.equal(status, 0, `a clean run was refused:\n${out}`);
  });
});

describe('what the aggregator\'s steps import', () => {
  const ENTRIES = ['scripts/executed-tests.mjs', 'scripts/unexpected-skips.mjs'];

  it('only node built-ins, so the gate job installs nothing (a package here is an `npm ci` the gate would owe)', () => {
    for (const entry of ENTRIES) {
      assert.ok(existsSync(join(REPO_ROOT, entry)), `${entry} does not exist yet`);
      const closure = importClosure(entry);
      assert.ok(closure.length >= 2, `${entry}: only ${closure.length} file(s) in its closure — the derivation is broken`);
      const packages = closure.flatMap(f => bareImports(f).map(spec => `${f} imports ${spec}`).filter(s => !/ imports node:/.test(s)));
      assert.deepEqual(packages, [], `${entry} reaches a package the gate job does not install:\n  ${packages.join('\n  ')}`);
    }
  });

  it('the script reads the committed list from the one module that holds it', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    assert.match(src, /from '\.\.\/testing\/_shared\/expected-in-ci\.mjs'/, 'the script keeps its own copy of the list');
    assert.doesNotMatch(stripComments(src), /the-extractor|corpus not fetched/, 'a file or cause is written into the script');
  });
});
