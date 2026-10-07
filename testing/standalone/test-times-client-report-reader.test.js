/**
 * The client's vitest JSON report is read by ONE reader, in full, and it says only what it knows (bundle-73, Q-378).
 *
 * ## What this prevents
 *
 * Until now the report was read for two narrow questions (which test did not run to a verdict, which spec ran), so what a
 * report says about a RUN was never asked of it: a file that never collected, a hook that threw, a test still `pending` when
 * the run was cut short. A recorder that counted only assertions would call each of those a clean run, and the first CI run in
 * which every client file fails at collection would have been refused as "holds no test" instead of recorded as failed.
 * Every report here is a REAL one (`testing/standalone/_fixtures/client-reports/`, made by running vitest; see its README), not
 * a shape this file's author wrote down: the status of a file whose `beforeAll` threw, its empty `message` and the empty
 * assertion list of a file that never collected are only known from a run.
 *
 * - **The status truth table.** `passed`, `failed`, `skipped` (vitest also says `disabled`), `todo`, and `pending` (`pending`,
 *   `run`, `queued`, `only`: the test never reached a verdict). A failed FILE with no failed assertion is one test and one
 *   failure; a failed file WITH a failed assertion is that assertion only. `files` is every `testResults` entry, whatever
 *   became of it. A missing duration or file time is 0.
 * - **Hostile numbers.** A timing that is not a finite non-negative number, or an epoch outside what `Date` can hold, is
 *   refused when the caller asks for strict times (the recorder) and ignored, as 0, when it does not (the gate readers: a
 *   timing anomaly must not turn the merge gate red). It is never a `RangeError`, never a negative or infinite figure.
 * - **Names are data.** A spec file called `__proto__`, `constructor` or `toString` is a file, and a report that carries a
 *   `__proto__` key pollutes nothing.
 * - **A refusal never quotes the report.** The report is attacker-shaped text and its refusal reaches a public run summary and
 *   a warning annotation: a fixed sentence naming the reason, never the parser's own message (which quotes the text around
 *   the break).
 *
 * ## The interface this pins (the plan names the behaviour; these are the names this file reads)
 *
 * `parseClientReport(text, { strictTimes })` returns `{ tests, passed, failed, skipped, todo, pending, files }` where `files`
 * is an array with one entry per `testResults` entry, each `{ file, ms }`. `readClientResults(dir)` keeps today's fields
 * (`tests`, `passed`, `failed`, `unexpected`, `executed`) and acceptance, and throws a fixed-text error for a missing,
 * unparseable or empty report.
 *
 * Run: node --test testing/standalone/test-times-client-report-reader.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reader from '../../scripts/_shared/client-results.mjs';
import { clientReport, clientReportNames } from '../_shared/client-report-fixtures.mjs';

const ROOT = '/work/Ythril';
const START = Date.UTC(2026, 9, 7, 12, 0, 0);
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const report = (name) => clientReport(name, { root: ROOT, startMs: START });
const text = (r) => JSON.stringify(r);
const parse = (t, options) => {
  assert.equal(typeof reader.parseClientReport, 'function', 'scripts/_shared/client-results.mjs does not export parseClientReport (Q-378)');
  return reader.parseClientReport(typeof t === 'string' ? t : text(t), options);
};
/** The error `fn` throws, or null; a failed assertion is the TEST failing, never a refusal to read. */
const refusalOf = (fn) => {
  try { fn(); } catch (e) { if (e instanceof assert.AssertionError) throw e; return e; }
  return null;
};
const COUNTS = ['tests', 'passed', 'failed', 'skipped', 'todo', 'pending'];
const countsOf = (r) => Object.fromEntries(COUNTS.map(k => [k, r[k]]));
const zero = Object.fromEntries(COUNTS.map(k => [k, 0]));
const withCounts = (over) => ({ ...zero, ...over });

describe('parseClientReport: what a real run of each shape counts as', () => {
  const ROWS = [
    ['passed', { files: 2, ...withCounts({ tests: 3, passed: 3 }) }],
    ['failed', { files: 1, ...withCounts({ tests: 2, passed: 1, failed: 1 }) }],
    ['skipped', { files: 1, ...withCounts({ tests: 3, passed: 1, skipped: 2 }) }],
    ['todo', { files: 1, ...withCounts({ tests: 2, passed: 1, todo: 1 }) }],
    // The file that never collected has no assertion at all: it is one test and one failure, beside the file that passed.
    ['collection-failure', { files: 2, ...withCounts({ tests: 2, passed: 1, failed: 1 }) }],
    // Its tests are `skipped`, the file is `failed`, `message` is empty and vitest's own `numFailedTests` is 0: the file is the failure.
    ['beforeall-failure', { files: 1, ...withCounts({ tests: 3, skipped: 2, failed: 1 }) }],
    // Zero tests in the whole report, every file failed: a run that failed, not a report to refuse.
    ['all-collection-failure', { files: 2, ...withCounts({ tests: 2, failed: 2 }) }],
    ['secret', { files: 1, ...withCounts({ tests: 1, failed: 1 }) }],
  ];
  for (const [name, want] of ROWS) {
    it(`${name}: ${JSON.stringify(want)}`, () => {
      const got = parse(report(name));
      assert.deepEqual(countsOf(got), countsOf(want), `${name}: the counts`);
      assert.equal(got.files.length, want.files, `${name}: one entry per testResults entry`);
    });
  }

  it('is checked against every fixture, so a report added later cannot be left out of the table', () => {
    const named = new Set(ROWS.map(([name]) => name));
    for (const name of clientReportNames()) assert.ok(named.has(name), `the fixture ${name} has no row in this table`);
  });

  it('reads `files` as one entry per testResults entry in every fixture, however the file ended', () => {
    for (const name of clientReportNames()) {
      const r = report(name);
      const got = parse(r);
      assert.equal(got.files.length, r.testResults.length, name);
      for (const f of got.files) assert.equal(typeof f.file, 'string', `${name}: every file entry names its spec`);
    }
  });

  it('counts a failed assertion once: the file that holds it is not a second failure', () => {
    assert.equal(parse(report('failed')).failed, 1);
    assert.equal(parse(report('secret')).failed, 1);
  });
});

describe('parseClientReport: the status table, a status at a time', () => {
  // Each row turns the first test of the passed report into `status` and says which counter the test moves to.
  const STATUSES = [
    ['passed', 'passed'], ['failed', 'failed'], ['skipped', 'skipped'], ['disabled', 'skipped'], ['todo', 'todo'],
    ['pending', 'pending'], ['run', 'pending'], ['queued', 'pending'], ['only', 'pending'],
  ];
  for (const [status, counter] of STATUSES) {
    it(`status ${status} is counted as ${counter} and as nothing else`, () => {
      const r = report('passed');
      r.testResults[0].assertionResults[0].status = status;
      const want = counter === 'passed' ? withCounts({ tests: 3, passed: 3 }) : withCounts({ tests: 3, passed: 2, [counter]: 1 });
      assert.deepEqual(countsOf(parse(r)), countsOf(want), `a test with status ${status}`);
    });
  }

  it('a failed file whose assertions all passed is one more test and one failure (an afterAll that threw)', () => {
    const r = report('passed');
    r.testResults[0].status = 'failed';
    assert.deepEqual(countsOf(parse(r)), countsOf(withCounts({ tests: 4, passed: 3, failed: 1 })));
  });

  it('a failed file that holds a failed assertion is that assertion alone, whatever its other tests did', () => {
    const r = report('failed');
    assert.equal(r.testResults[0].status, 'failed');
    assert.deepEqual(countsOf(parse(r)), countsOf(withCounts({ tests: 2, passed: 1, failed: 1 })));
  });
});

describe('parseClientReport: a missing time is zero, a hostile one is refused or ignored — never a RangeError, never a bad figure', () => {
  const finiteMs = (got, what) => { for (const f of got.files) assert.ok(Number.isFinite(f.ms) && f.ms >= 0, `${what}: ${f.file} has ms ${f.ms}`); };

  it('a report whose files and tests carry no duration, start or end reads, with every file at 0 ms, strict or not', () => {
    const r = report('passed');
    for (const f of r.testResults) { delete f.startTime; delete f.endTime; for (const t of f.assertionResults) delete t.duration; }
    for (const strictTimes of [false, true]) {
      const got = parse(r, { strictTimes });
      assert.deepEqual(got.files.map(f => f.ms), [0, 0], `strictTimes ${strictTimes}`);
      assert.equal(got.passed, 3);
    }
  });

  it('a null duration is a missing one: 0, strict or not', () => {
    const r = report('passed');
    r.testResults[0].assertionResults[0].duration = null;
    for (const strictTimes of [false, true]) assert.equal(parse(r, { strictTimes }).passed, 3);
  });

  const HOSTILE = [
    ['a negative duration', (r) => { r.testResults[0].assertionResults[0].duration = -5; }],
    ['an infinite duration', (r) => { r.testResults[0].assertionResults[0].duration = '__INFINITY__'; }],
    ['a duration that is a string', (r) => { r.testResults[0].assertionResults[0].duration = '12'; }],
    ['a duration that is not a number', (r) => { r.testResults[0].assertionResults[0].duration = 'NaN'; }],
    ['a duration that is a boolean', (r) => { r.testResults[0].assertionResults[0].duration = true; }],
    ['a duration that is an object', (r) => { r.testResults[0].assertionResults[0].duration = { valueOf: 1 }; }],
    ['a file start past the range of a Date', (r) => { r.testResults[0].startTime = 8.64e15 + 1; }],
    ['a file end before the range of a Date', (r) => { r.testResults[0].endTime = -8.64e15 - 1; }],
    ['an infinite file end', (r) => { r.testResults[0].endTime = '__INFINITY__'; }],
    ['a report start past the range of a Date', (r) => { r.startTime = 8.64e15 + 1; }],
    ['a report start that is a string', (r) => { r.startTime = String(r.startTime); }],
  ];
  // JSON cannot say Infinity; a producer that wrote 1e999 did, and JSON.parse reads it back as Infinity.
  const asText = (r) => text(r).replaceAll('"__INFINITY__"', '1e999');

  for (const [what, mutate] of HOSTILE) {
    it(`${what}: ignored as 0 when times are not strict, refused when they are`, () => {
      const r = report('passed');
      mutate(r);
      const lax = parse(asText(r), { strictTimes: false });
      finiteMs(lax, what);
      assert.deepEqual(countsOf(lax), countsOf(withCounts({ tests: 3, passed: 3 })), `${what}: the counts do not depend on a timing`);
      const refused = refusalOf(() => parse(asText(r), { strictTimes: true }));
      assert.ok(refused, `${what}: a strict read must refuse it`);
      assert.ok(!(refused instanceof RangeError), `${what}: refused as ${refused.name}, not as an out-of-range Date`);
    });
  }

  it('a figure the reader sums stays finite however many huge ones it is given', () => {
    const r = report('passed');
    for (const f of r.testResults) for (const t of f.assertionResults) t.duration = 1e308;
    for (const strictTimes of [false, true]) {
      let got;
      const refused = refusalOf(() => { got = parse(r, { strictTimes }); });
      if (refused) { assert.ok(!(refused instanceof RangeError), `strictTimes ${strictTimes}: ${refused.name}`); continue; }
      finiteMs(got, `strictTimes ${strictTimes}`);
    }
  });
});

describe('parseClientReport: names are data', () => {
  const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

  it('counts a file named after an Object.prototype member as a file, and drops none of them', () => {
    const r = report('passed');
    const extra = structuredClone(r.testResults[0]);
    r.testResults = NAMES.map((n, i) => ({ ...structuredClone(i % 2 ? r.testResults[1] : extra), name: n }));
    const got = parse(r);
    assert.equal(got.files.length, NAMES.length);
    for (const n of NAMES) assert.ok(got.files.some(f => f.file === n || String(f.file).endsWith(`/${n}`)), `no file entry is named ${n}: ${got.files.map(f => f.file)}`);
    assert.equal(got.tests, 2 * 2 + 2 * 1, 'two files of two tests and two of one');
    assert.equal({}.polluted, undefined);
  });

  it('a `__proto__` key in the report changes no prototype', () => {
    const t = text(report('passed')).replace('{"numTotalTestSuites"', '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"numTotalTestSuites"');
    assert.ok(t.includes('"__proto__"'), 'the fixture was not rewritten: the row proves nothing');
    const got = parse(t);
    assert.equal(got.passed, 3);
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted by the report');
  });
});

describe('a refusal names the reason and never quotes the report', () => {
  const NOT_QUOTED = [/Unexpected token/i, /is not valid JSON/i, /in JSON at position/i, /position \d+/i];
  const refusal = (fn) => {
    const e = refusalOf(fn);
    assert.ok(e, 'the report was not refused');
    return String(e.message);
  };
  const clean = (message, what) => {
    assert.ok(!message.includes(TOKEN), `${what}: the refusal quotes the report: ${message}`);
    for (const re of NOT_QUOTED) assert.ok(!re.test(message), `${what}: the refusal carries the parser's own message (${re}): ${message}`);
    assert.ok(message.length < 400, `${what}: the refusal is a sentence, not a dump of the report`);
  };
  const BROKEN = [
    ['JSON cut off mid-way, with a token in it', `{"testResults": [ ${TOKEN} `],
    ['JSON that is a string', JSON.stringify(TOKEN)],
    ['an array', JSON.stringify([TOKEN])],
    ['an object with no testResults', JSON.stringify({ secret: TOKEN })],
    ['testResults that is not an array', JSON.stringify({ testResults: TOKEN })],
  ];
  for (const [what, body] of BROKEN) {
    it(`parseClientReport, ${what}`, () => { clean(refusal(() => parse(body)), what); });
  }

  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'client-reader-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  for (const [what, body] of BROKEN) {
    it(`readClientResults, ${what}`, () => {
      writeFileSync(join(dir, reader.CLIENT_RESULTS), body);
      clean(refusal(() => reader.readClientResults(dir)), what);
    });
  }

  it('a report with no testResults entry at all is still refused (an empty client run is not a clean one)', () => {
    writeFileSync(join(dir, reader.CLIENT_RESULTS), JSON.stringify({ testResults: [] }));
    assert.throws(() => reader.readClientResults(dir));
  });

  it('a missing report is refused, naming the report', () => {
    const empty = mkdtempSync(join(tmpdir(), 'client-reader-empty-'));
    try {
      const message = refusal(() => reader.readClientResults(empty));
      assert.ok(message.includes(reader.CLIENT_RESULTS), message);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('readClientResults keeps the gate readers\' acceptance and fields', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'client-reader-gate-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  const read = (r) => { writeFileSync(join(dir, reader.CLIENT_RESULTS), typeof r === 'string' ? r : text(r)); return reader.readClientResults(dir); };

  it('reads a run in which every file failed at collection: failed, not refused, and no spec counts as executed', () => {
    const got = read(report('all-collection-failure'));
    assert.equal(got.failed, 2);
    assert.ok(got.tests > 0);
    assert.equal(got.executed.size, 0, 'a file that never collected ran no test');
  });

  // The next two pin today's acceptance while the reader is rewritten: they hold on the unchanged code and must keep holding.
  it('a timing anomaly is not a refusal: the merge gate reads the same totals', () => {
    const r = report('passed');
    r.testResults[0].assertionResults[0].duration = -5;
    r.testResults[1].startTime = '1e999';
    const got = read(r);
    assert.deepEqual({ tests: got.tests, passed: got.passed, failed: got.failed }, { tests: 3, passed: 3, failed: 0 });
  });

  it('names each skipped, todo or pending test as one that did not run to a verdict', () => {
    const r = report('skipped');
    r.testResults[0].assertionResults.push({ ...r.testResults[0].assertionResults[0], status: 'pending', fullName: 'a pending one', title: 'a pending one' });
    const got = read(r);
    assert.equal(got.unexpected.length, 3, `two skips and one pending: ${JSON.stringify(got.unexpected)}`);
  });
});
