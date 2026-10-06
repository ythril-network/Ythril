/**
 * The timing reporter writes ONE honest line per test, suite and file — and says when it did not finish
 * (bundle-56, Q-370 part 1, Q-272).
 *
 * ## What it prevents
 *
 * A measurement that is wrong in a way nobody can see. Every rule below is a way `node --test` itself gives a
 * green-looking or empty answer, found by probing it on Node 22 and 24 (scratchpad probe P1):
 *
 *  - **node's `skipped` total misses a skipped SUITE** (`describe.skip`, `describe('x', { skip })`), and the
 *    children of one are never reported at all; a test that prints "SKIPPED" and returns is a plain pass. A skip
 *    gate that reads node's count reads less than the truth. The reporter counts from the events: a pass with
 *    `skip` truthy, suites included.
 *  - **`fail 0` hides a failure.** A suite whose `before` hook throws is `cancelled` in node's tail with `fail 0`
 *    and exit status 1; a file that throws while it LOADS is one failure named after the file, with no per-file
 *    summary. Failure is read from the `test:fail` events, never from a count.
 *  - **Events arrive grouped by file, not in time order** under concurrency, so a figure keyed on arrival order is
 *    someone else's. Every event keeps its own `file`.
 *  - **A run cut off looks like a short run.** The reporter ends its file with a sentinel line carrying the event
 *    count; a file without it, with a different count, or with a torn last line is INCOMPLETE and is never read as
 *    passed.
 *  - **A failure message is the longest, most private text in a run**: a stack, a diff, an `Authorization`
 *    header. Only its first line is stored, capped at 300 characters, with token-shaped strings masked.
 *
 * ## How the subject is found
 *
 * Real child runs of `node --test` over `_fixtures/timing-*.fixture.mjs`, with an independent ORACLE reporter
 * (`event-oracle.mjs`) attached beside the timing reporter in the SAME run. What the timing file must contain is
 * derived from node's own events, not typed out beside the fixtures; a floor on every derived set stops an empty
 * run from agreeing with an empty file.
 *
 * ## The contract this gate pins (the implementation did not exist when it was written)
 *
 * `testing/_shared/timing-reporter.mjs` exports: the reporter as `default`; `TIMING_SCHEMA` (field name to
 * `{ type, nullable?, values?, doc }`, the ONE description of a line); `readTimingLog(text)` -> `{ lines, complete }`.
 * What it masks is `maskSecrets` of `testing/_shared/secret-masking.mjs`, the one list (its floors are pinned by
 * `a-secret-is-masked-by-one-list.test.js`). `testing/_shared/timing-reporter-flags.mjs` exports
 * `timingReporterFlags({ suite, batch, dir, stdoutIsTTY })` -> `{ args, env, destination }`; the reporter reads
 * the destination, suite and batch from the `env` the helper returns and appends to the destination itself.
 *
 * Run: node --test testing/standalone/timing-reporter-lines.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as reporterModule from '../_shared/timing-reporter.mjs';
import { maskSecrets } from '../_shared/secret-masking.mjs';
import {
  ROOT, SECRETS, LONG_FIRST_LINE, READY, fixture, runTimed, runPlain, readJsonl, startTimed,
} from './_timing-runs.mjs';

const { TIMING_SCHEMA, readTimingLog } = reporterModule;

const MAIN = ['timing-pass', 'timing-skips', 'timing-hook-fail', 'timing-load-throw', 'timing-failure-messages'];
const mainFiles = MAIN.map(fixture);
const CONCURRENT = ['timing-concurrent-a', 'timing-concurrent-b'].map(fixture);

/** Fields a line must carry whatever else the schema adds — the ones every reader of the file depends on. */
const REQUIRED_FIELDS = ['suite', 'batch', 'file', 'test', 'nesting', 'type', 'ms', 'status', 'skip', 'todo', 'reason', 'message'];

const rel = (abs) => relative(ROOT, abs).replaceAll('\\', '/');
const keyOf = (file, test, nesting) => `${file}\u0000${test}\u0000${nesting}`;
const isDataLine = (l) => l.type !== 'end';

let tmp;
let main;       // the five fixtures, node's default width, with the oracle beside the reporter
let mainLines;  // data lines of main's timing file
let mainText;
let conc;       // the concurrent pair at width 4
let concLines;

/** An oracle event that is node's report of the FILE itself (a load failure), not of a test inside it. */
const isFileEvent = (ev) => ev.nesting === 0 && resolve(ROOT, ev.name) === resolve(ev.file);

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'timing-lines-'));
  main = runTimed(mainFiles, { dir: tmp, suite: 'lines', batch: 'main', oracle: true });
  mainText = readFileSync(main.destination, 'utf8');
  mainLines = readJsonl(main.destination).filter(isDataLine);
  conc = runTimed(CONCURRENT, { dir: tmp, suite: 'lines', batch: 'conc', extraArgs: ['--test-concurrency=4'] });
  concLines = readJsonl(conc.destination).filter(isDataLine);
});
after(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('the exported schema is the one description of a line', () => {
  it('names every field a reader depends on, each with a type', () => {
    assert.ok(TIMING_SCHEMA && typeof TIMING_SCHEMA === 'object', 'timing-reporter.mjs must export TIMING_SCHEMA');
    for (const f of REQUIRED_FIELDS) {
      assert.ok(TIMING_SCHEMA[f], `TIMING_SCHEMA has no \`${f}\``);
      assert.ok(['string', 'number', 'boolean'].includes(TIMING_SCHEMA[f].type), `\`${f}\` declares no usable type`);
      assert.equal(typeof TIMING_SCHEMA[f].doc, 'string', `\`${f}\` is undocumented: the schema is the reference`);
    }
  });

  it('enumerates the line types and statuses', () => {
    assert.deepEqual([...TIMING_SCHEMA.type.values].sort(), ['file', 'suite', 'test']);
    for (const s of ['pass', 'fail', 'cancelled']) assert.ok(TIMING_SCHEMA.status.values.includes(s), `status has no \`${s}\``);
  });

  it('every line of a real run has exactly the schema fields, each of its declared type', () => {
    const floor = 20;
    assert.ok(mainLines.length >= floor, `only ${mainLines.length} lines for the five fixtures — the run wrote next to nothing`);
    const names = Object.keys(TIMING_SCHEMA).sort();
    for (const line of mainLines) {
      assert.deepEqual(Object.keys(line).sort(), names, `line for "${line.test}" has other keys than the schema`);
      for (const [name, spec] of Object.entries(TIMING_SCHEMA)) {
        const v = line[name];
        if (v === null) { assert.ok(spec.nullable, `\`${name}\` is null on "${line.test}" but the schema does not allow it`); continue; }
        assert.equal(typeof v, spec.type, `\`${name}\` on "${line.test}" is ${typeof v}, the schema says ${spec.type}`);
        if (spec.values) assert.ok(spec.values.includes(v), `\`${name}\` = ${v} is not one of ${spec.values}`);
      }
    }
  });

  it('records the file repo-relative with forward slashes, whatever cwd or platform', () => {
    for (const line of mainLines) {
      assert.ok(!/^([a-zA-Z]:|[\\/])/.test(line.file) && !line.file.includes('\\'), `file is not repo-relative: ${line.file}`);
      assert.ok(existsSync(resolve(ROOT, line.file)), `file does not name a file of the repo: ${line.file}`);
    }
  });

  it('stamps the suite and batch the helper was given', () => {
    for (const line of mainLines) {
      assert.equal(line.suite, 'lines');
      assert.equal(line.batch, 'main');
    }
  });
});

describe('one line per test, suite and file — exactly the events node reported', () => {
  const expectedKeys = () => {
    const keys = new Map();
    for (const ev of main.oracle) {
      const file = rel(ev.file);
      if (isFileEvent(ev)) continue;               // reported as the file's own line below
      keys.set(keyOf(file, maskSecrets(ev.name), ev.nesting), ev.kind);
    }
    return keys;
  };

  it('has a line for every node pass and fail event, and for nothing else', () => {
    assert.ok(main.oracle.length >= 25, `the oracle saw only ${main.oracle.length} events — nothing to compare`);
    const expected = expectedKeys();
    const got = new Map();
    for (const l of mainLines.filter(l => l.type !== 'file')) {
      const k = keyOf(l.file, l.test, l.nesting);
      assert.ok(!got.has(k), `two lines for one test: "${l.test}" in ${l.file}`);
      got.set(k, l.type);
    }
    assert.deepEqual([...got.keys()].sort(), [...expected.keys()].sort(), 'the lines and node\'s events name different tests');
    for (const [k, kind] of expected) assert.equal(got.get(k), kind, `"${k.split('\u0000')[1]}" is a ${kind} to node`);
  });

  it('has exactly one `file` line per file run, including a file that never loaded', () => {
    for (const name of MAIN) {
      const lines = mainLines.filter(l => l.type === 'file' && l.file === fixture(name));
      assert.equal(lines.length, 1, `${name}: ${lines.length} file lines`);
    }
    assert.equal(mainLines.filter(l => l.type === 'file').length, MAIN.length, 'a file line for a file nobody ran');
  });

  it('gives each line the status node gave the event, and a file the verdict of its tests', () => {
    for (const ev of main.oracle.filter(e => !isFileEvent(e))) {
      const line = mainLines.find(l => l.type !== 'file' && l.file === rel(ev.file) && l.test === maskSecrets(ev.name) && l.nesting === ev.nesting);
      if (ev.type === 'test:pass') assert.equal(line.status, 'pass', `"${ev.name}" passed`);
      else assert.ok(['fail', 'cancelled'].includes(line.status), `"${ev.name}" failed to node and reads ${line.status}`);
    }
    const verdict = (name) => mainLines.find(l => l.type === 'file' && l.file === fixture(name)).status;
    assert.equal(verdict('timing-pass'), 'pass');
    assert.equal(verdict('timing-skips'), 'pass');
    assert.equal(verdict('timing-hook-fail'), 'fail');
    assert.equal(verdict('timing-load-throw'), 'fail');
    assert.equal(verdict('timing-failure-messages'), 'fail');
  });

  it('measures a test with node\'s own figure, and a file as the whole file, load included', () => {
    for (const ev of main.oracle.filter(e => !isFileEvent(e))) {
      const line = mainLines.find(l => l.type !== 'file' && l.file === rel(ev.file) && l.test === maskSecrets(ev.name) && l.nesting === ev.nesting);
      assert.ok(Math.abs(line.ms - ev.ms) <= 0.01, `"${ev.name}": ${line.ms} ms, node said ${ev.ms}`);
    }
    const waited = mainLines.find(l => l.test === 'passes after a wait');
    assert.ok(waited.ms >= 50, `a 60 ms wait is recorded as ${waited.ms} ms`);
    for (const name of ['timing-pass', 'timing-skips', 'timing-failure-messages']) {
      const file = mainLines.find(l => l.type === 'file' && l.file === fixture(name));
      const longest = Math.max(...mainLines.filter(l => l.type !== 'file' && l.file === fixture(name)).map(l => l.ms));
      assert.ok(file.ms >= longest, `${name}: the file took ${file.ms} ms but a test in it took ${longest}`);
    }
    assert.ok(mainLines.find(l => l.type === 'file' && l.file === fixture('timing-pass')).ms >= waited.ms);
  });
});

describe('every skip form is counted, skipped suites included', () => {
  const skipEvents = () => main.oracle.filter(e => e.type === 'test:pass' && e.skip && !isFileEvent(e));
  const lineOf = (ev) => mainLines.find(l => l.type !== 'file' && l.file === rel(ev.file) && l.test === maskSecrets(ev.name) && l.nesting === ev.nesting);

  it('flags `skip` on exactly the events node marked skipped, with a floor over a derived set', () => {
    const events = skipEvents();
    assert.ok(events.length >= 7, `only ${events.length} skip events — the fixture forms are not being seen`);
    assert.ok(events.filter(e => e.kind === 'suite').length >= 2, 'no skipped SUITES among them — the case node\'s own count misses');
    const flagged = mainLines.filter(l => l.skip);
    assert.deepEqual(flagged.map(l => keyOf(l.file, l.test, l.nesting)).sort(),
      events.map(e => keyOf(rel(e.file), maskSecrets(e.name), e.nesting)).sort());
    for (const ev of events) assert.equal(lineOf(ev).skip, true, `"${ev.name}" is skipped`);
  });

  it('records the reason when there is one, and null when `skip` was only true', () => {
    for (const ev of skipEvents()) {
      assert.equal(lineOf(ev).reason, typeof ev.skip === 'string' ? maskSecrets(ev.skip) : null, `reason of "${ev.name}"`);
    }
    const bare = skipEvents().filter(e => e.skip === true);
    assert.ok(bare.length >= 2, 'the bare-skip forms (option true, test.skip, t.skip()) are not covered');
  });

  it('leaves every line that was NOT skipped with skip false and no reason', () => {
    const notSkipped = main.oracle.filter(e => !e.skip && !isFileEvent(e) && e.type === 'test:pass');
    assert.ok(notSkipped.length >= 5);
    for (const ev of notSkipped) {
      const l = lineOf(ev);
      assert.equal(l.skip, false, `"${ev.name}" is not skipped`);
      assert.equal(l.reason, null);
    }
  });

  it('marks a todo as a todo and not as a skip', () => {
    const todo = mainLines.find(l => l.test === 'a todo');
    assert.ok(todo, 'the todo test has no line');
    assert.equal(todo.todo, true);
    assert.equal(todo.skip, false);
    assert.equal(mainLines.filter(l => l.todo).length, 1, 'only the one todo may read as a todo');
  });

  it('cannot see a test that prints SKIPPED and returns — it is a plain pass, which is why the source gate exists', () => {
    const l = mainLines.find(l => l.test === 'print and return');
    assert.equal(l.skip, false);
    assert.equal(l.status, 'pass');
  });
});

describe('a failure is read from the events, never from node\'s fail count', () => {
  it('a failing before hook: node\'s own tail says fail 0, the file says it failed', () => {
    const plain = runPlain([fixture('timing-hook-fail')]);
    assert.equal(plain.status, 1, 'the premise: node exits 1');
    assert.match(plain.stdout, /^# fail 0$/m, 'the premise: node\'s own tail counts no failure');
    const suite = mainLines.find(l => l.test === 'hook suite');
    assert.equal(suite.type, 'suite');
    assert.equal(suite.status, 'fail', 'the suite whose hook threw');
    assert.equal(typeof suite.message, 'string');
    assert.ok(suite.message.length > 0, 'a failed suite with no message says nothing');
    for (const name of ['never runs one', 'never runs two']) {
      const l = mainLines.find(l => l.test === name);
      assert.ok(l, `${name} has no line`);
      assert.notEqual(l.status, 'pass', `${name} never ran and must not read as a pass`);
    }
    assert.equal(mainLines.find(l => l.type === 'file' && l.file === fixture('timing-hook-fail')).status, 'fail');
  });

  it('a file that throws while loading is a failed file line, though no test ran', () => {
    const l = mainLines.find(l => l.type === 'file' && l.file === fixture('timing-load-throw'));
    assert.equal(l.status, 'fail');
    assert.ok(typeof l.message === 'string' && l.message.length > 0, 'a failed file with no message says nothing');
    assert.equal(mainLines.filter(l => l.file === fixture('timing-load-throw') && l.type !== 'file').length, 0,
      'a test that never registered has no line');
  });

  it('the run\'s own exit status is the tests\', not the reporter\'s', () => {
    assert.equal(main.status, 1);
    const clean = runTimed([fixture('timing-pass'), fixture('timing-skips')], { dir: tmp, suite: 'lines', batch: 'clean' });
    assert.equal(clean.status, 0);
  });
});

describe('a failure message is its first line, capped, no stack, no secrets', () => {
  const line = (test) => mainLines.find(l => l.test === test);

  it('keeps the first line only, at most 300 characters', () => {
    const m = line('long multi-line failure').message;
    assert.equal(typeof m, 'string');
    assert.ok(m.length <= 300, `${m.length} characters`);
    assert.ok(m.startsWith(LONG_FIRST_LINE.slice(0, 280)), 'the head of the first line is what must survive the cap');
    assert.ok(!/second line|\n|\r/.test(m), 'a later line was stored');
  });

  it('keeps a short first line whole and drops everything after it, the cap or not', () => {
    assert.equal(line('short failure with a second line').message, 'short first line');
  });

  it('stores no stack frame anywhere in the file', () => {
    assert.doesNotMatch(mainText, /\bat [^"\\]+\([^)"\\]*:\d+:\d+\)/, 'a stack frame reached the timing file');
    assert.doesNotMatch(mainText, /frame\.js/);
  });

  it('a passing line has no message', () => {
    for (const l of mainLines.filter(l => l.status === 'pass')) assert.equal(l.message, null, `"${l.test}" passed with a message`);
  });

  it('masks token-shaped strings in the message, the test name and the skip reason, and keeps the rest', () => {
    for (const [what, secret] of Object.entries(SECRETS)) {
      // The unguessable tail, not the prefix: a prefix may be left to say what kind of thing was masked.
      assert.ok(!mainText.includes(secret.slice(-20)), `${what} token reached the timing file`);
    }
    assert.match(line('failure that carries secrets').message, /^request failed with Authorization/);
    const named = mainLines.find(l => l.test.startsWith('a test named after'));
    assert.ok(named, 'the test named after a token is missing: it must be recorded, masked');
    assert.ok(!named.test.includes(SECRETS.githubFine.slice(-20)));
    assert.match(line('a skip whose reason carries a secret').reason, /^no access with /);
  });

  it('survives a failure whose message is not a string', () => {
    const l = line('failure whose message is not a string');
    assert.ok(l, 'the line is missing: the reporter choked on the message');
    assert.equal(l.status, 'fail');
    assert.ok(l.message === null || typeof l.message === 'string');
  });
});

describe('maskSecrets', () => {
  it('masks every token shape and nothing around it', () => {
    assert.equal(typeof maskSecrets, 'function', 'secret-masking.mjs must export maskSecrets');
    for (const [what, secret] of Object.entries(SECRETS)) {
      const out = maskSecrets(`before ${secret} after`);
      assert.ok(!out.includes(secret.slice(-20)), `${what} survived: ${out}`);
      assert.ok(out.startsWith('before ') && out.endsWith(' after'), `${what}: the text around it changed: ${out}`);
    }
  });

  it('leaves what only looks like one', () => {
    for (const text of ['ghp_', 'the Bearers of news', 'ythril_test', 'a plain sentence', '']) {
      assert.equal(maskSecrets(text), text, `"${text}" is not a secret`);
    }
  });

  it('leaves a metric or harness name readable, and masks a Bearer value whatever word it is', () => {
    // A real token is `ythril_` + base62 (auth/tokens.ts): a name whose first run is short is not one, and a timing
    // record must be able to show it.
    assert.equal(maskSecrets('ythril_harness_standalone_recall_filtered'), 'ythril_harness_standalone_recall_filtered');
    assert.equal(maskSecrets('includes ythril_http_requests_total counter'), 'includes ythril_http_requests_total counter');
    assert.equal(maskSecrets('Bearer token missing'), 'Bearer *** missing');
  });

  it('is idempotent', () => {
    const once = maskSecrets(Object.values(SECRETS).join(' | '));
    assert.equal(maskSecrets(once), once);
  });
});

describe('concurrent files keep their own events', () => {
  it('attributes every test to the file that declared it, and every file its own figure', () => {
    assert.ok(concLines.length >= 6, `only ${concLines.length} lines`);
    for (const l of concLines.filter(l => l.type === 'test')) {
      const owner = /^concurrent (a|b) /.exec(l.test)?.[1];
      assert.equal(l.file, fixture(`timing-concurrent-${owner}`), `"${l.test}" recorded under ${l.file}`);
    }
    const fileLine = (n) => concLines.find(l => l.type === 'file' && l.file === fixture(`timing-concurrent-${n}`));
    // A timer may fire a little EARLY by the clock the runner measures with (CI read 149.x ms for a 150 ms sleep), so each
    // floor is the fixture's wait less a few milliseconds. What is asserted is attribution — b carries b's figure, which is
    // far from a's 400 — not the timer's precision.
    const EARLY_MS = 5;
    const testMs = (name) => concLines.find(l => l.test === name).ms;
    assert.ok(fileLine('a').ms >= 400 - EARLY_MS, `a waited 400 ms and its file took ${fileLine('a').ms}`);
    assert.ok(fileLine('b').ms >= 170 - EARLY_MS, `b waited 170 ms and its file took ${fileLine('b').ms}`);
    assert.ok(testMs('concurrent a slow') >= 400 - EARLY_MS, `a's test took ${testMs('concurrent a slow')}`);
    assert.ok(testMs('concurrent b medium') >= 150 - EARLY_MS && testMs('concurrent b medium') < 400,
      `b's test took ${testMs('concurrent b medium')} ms: under its own 150 ms wait, or carrying a's 400`);
  });
});

describe('the sentinel says the file is whole', () => {
  it('ends with one `end` line carrying the count of the lines before it', () => {
    const all = readJsonl(main.destination);
    const { startedAt, endedAt, scope, ...rest } = all.at(-1);
    assert.deepEqual(rest, { type: 'end', events: all.length - 1 });
    assert.deepEqual(Object.keys(all.at(-1)).sort(), ['endedAt', 'events', 'scope', 'startedAt', 'type'], 'the sentinel has exactly these fields');
    assert.equal(all.filter(l => l.type === 'end').length, 1);
    assert.ok(all.length - 1 >= 20);
  });

  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it('says when the run started and ended, in ISO UTC, within the time the run took', () => {
    const before = Date.now();
    const r = runTimed([fixture('timing-pass')], { dir: tmp, suite: 'lines', batch: 'times' });
    const after = Date.now();
    const end = readJsonl(r.destination).at(-1);
    assert.match(end.startedAt, ISO_UTC);
    assert.match(end.endedAt, ISO_UTC);
    const [s, e] = [Date.parse(end.startedAt), Date.parse(end.endedAt)];
    assert.ok(before <= s && s <= e && e <= after, `startedAt ${end.startedAt}, endedAt ${end.endedAt}, run between ${before} and ${after}`);
    assert.ok(e - s >= 50, `a fixture that waits 60 ms is recorded as lasting ${e - s} ms`);
  });

  it('says the scope the helper was given, and a run that was not told is a subset — never full', () => {
    for (const scope of ['full', 'subset', 'files']) {
      const r = runTimed([fixture('timing-pass')], { dir: tmp, suite: 'lines', batch: `scope-${scope}`, scope });
      assert.equal(readJsonl(r.destination).at(-1).scope, scope);
    }
    assert.equal(readJsonl(main.destination).at(-1).scope, 'subset', 'main was run with no scope stated');
  });

  it('is read back with its sentinel, whole', () => {
    const log = readTimingLog(mainText);
    assert.equal(log.complete, true);
    assert.deepEqual(log.end, readJsonl(main.destination).at(-1));
    assert.equal(readTimingLog('').end, null);
  });

  it('is read back as complete, with the data lines', () => {
    assert.equal(typeof readTimingLog, 'function', 'timing-reporter.mjs must export readTimingLog');
    const log = readTimingLog(mainText);
    assert.equal(log.complete, true);
    assert.deepEqual(log.lines, mainLines);
  });

  const good = [{ type: 'test', test: 'a' }, { type: 'file', test: 'b' }];
  const text = (lines) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const END = (n) => ({ type: 'end', events: n });

  it('reads a file without the sentinel as incomplete — and never as an empty pass', () => {
    for (const [name, t] of Object.entries({
      'no sentinel': text(good),
      'empty file': '',
      'a count that does not match': text([...good, END(5)]),
      'a torn last line': text([...good, END(2)]).slice(0, -12),
      'lines after the sentinel': text([...good, END(2), { type: 'test', test: 'late' }]),
      'a line that is not JSON': text(good) + '{"type":"te\n' + JSON.stringify(END(3)) + '\n',
      'two sentinels': text([...good, END(2), END(3)]),
    })) {
      const log = readTimingLog(t);
      assert.equal(log.complete, false, name);
    }
  });

  it('reads the matching sentinel as complete, an empty run included', () => {
    assert.equal(readTimingLog(text([...good, END(2)])).complete, true);
    assert.equal(readTimingLog(text([END(0)])).complete, true);
    assert.deepEqual(readTimingLog(text([...good, END(2)])).lines, good);
  });

  it('a run killed part-way leaves its finished lines and no sentinel', async () => {
    const { child, destination } = startTimed([fixture('timing-slow')], { dir: tmp, suite: 'lines', batch: 'killed' });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});
    const exited = new Promise(res => child.once('exit', res));
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('the slow fixture never announced itself')), 60_000);
      child.stdout.on('data', () => { if (out.includes(READY)) { clearTimeout(t); res(); } });
    });
    child.kill('SIGKILL');
    await exited;
    const text = readFileSync(destination, 'utf8');
    assert.match(text, /finishes before the kill/, 'the finished test was not written before the run ended');
    assert.ok(!text.includes('"end"'), 'a killed run wrote a sentinel');
    assert.equal(readTimingLog(text).complete, false);
  });
});
