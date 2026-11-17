/**
 * The preflight reads the recorded time of each pure test file from one untracked snapshot, `test-results/file-times.json`, and the host
 * keeps it fresh (Q-869). The reader never throws and refuses what it cannot trust; the writer never leaves a half-written file; the
 * host writes it from CI's records of the standalone-pure job and nothing else.
 *
 * ## The defect this refuses
 *
 * The preflight runs in a container with no instance address and must never fetch (a down instance would delay the fast failure it exists
 * for), so the per-file times that decide which pure files start first reach it through a file in the results folder. A file a script
 * reads before every push is input from outside the run: a truncated write, another tool's JSON, a time that is a string or negative, a
 * `__proto__` key, a snapshot from last month or one dated next year. Each must end as "no times" with a reason (`{ times: null, why }`),
 * never as a throw that stops the preflight or a plan from numbers nobody measured. The same holds for the stage-costs snapshot beside it,
 * so the reading is one function, `readSnapshot(dir, name, { validate, now })` in `scripts/_shared/stage-costs.mjs`, and both readers are
 * its callers. The writer side has its own ways to go wrong, each closed here: a record from another branch, scope or job (a laptop's run,
 * a files-only run) must never set a time; a record whose measurements do not parse must not count; a record whose measurements were cut
 * for size (`{ truncated: true, files }`) still holds every file's time and must count; and a failed write of the file times must never
 * lose the stage costs, nor change the exit status.
 *
 * ## What it asserts
 *
 * - `readFileTimes(dir, { now })` answers `{ times, why }` and never throws: a missing, truncated, garbage, foreign-shaped, negative-
 *   or non-number-timed, `__proto__`-keyed, older-than-14-days (`stale`, with the day count) or future-dated (`future`) file gives
 *   `times: null` and a `why`; a fresh one reads back whole.
 * - `readSnapshot` refuses each of those once, for any file name and any shape its `validate` accepts; `readStageCosts` keeps its
 *   stale wording and refuses a future date.
 * - `writeFileTimes(dir, snapshot)` leaves the snapshot and no temporary file, and the name survives `clearTimingResults('preflight')`.
 * - `node scripts/test-times.mjs --preflight-costs` writes `file-times.json` from the newest 5 Test-Run records of source ci, job
 *   standalone-pure, branch main, scope full (asked of the server, checked again here), the median per file (the mean of the middle two
 *   for an even count), counting only records whose measurements parse, accepting a truncated row; with none it writes no file, says one
 *   line, writes the stage costs and exits 0; a refused read of the records changes neither.
 * - `--drain-unrecorded` writes it after the stage costs, in its own try, only when it is missing, over a day old or dated in the future.
 *   Local fake instance only.
 *
 * Run: node --test testing/standalone/the-file-times-snapshot-is-read-without-throwing.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { makeWorkdir, runTimes, everything } from '../_shared/test-times-harness.mjs';

const url = (p) => pathToFileURL(join(REPO_ROOT, p)).href;
/** Imported inside each case, so a base without the module fails each case by name and not the whole file at load. */
const costsModule = () => import(url('scripts/_shared/stage-costs.mjs'));
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const DAY = 86_400_000;
const at = (ms) => new Date(ms).toISOString();
const now = () => NOW;
const FILE = 'file-times.json';
const A = 'testing/standalone/alpha.test.js';
const B = 'testing/standalone/beta.test.js';

/** A snapshot as the host writes it, `over` replacing what a case is about. */
const snapshot = (over = {}) => ({
  generatedAt: at(NOW - 3_600_000), newestSourceAt: at(NOW - DAY), runs: 5,
  files: { [A]: 300, [B]: 2500, 'testing/standalone/gamma.test.js': 0 },
  ...over,
});

/** A scratch folder holding `text` under `name`, and what to read it with. */
async function withFile(name, text, fn) {
  const dir = mkdtempSync(join(scratchRoot(), 'file-times-'));
  try {
    if (text !== null) writeFileSync(join(dir, name), text);
    return await fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What a reading must be, for a file it does not trust. */
async function assertRefused(text, label, matches) {
  const { readFileTimes } = await costsModule();
  await withFile(FILE, text, (dir) => {
    let answer;
    assert.doesNotThrow(() => { answer = readFileTimes(dir, { now }); }, `${label}: the reader threw`);
    assert.equal(answer.times, null, `${label}: the file was trusted`);
    assert.equal(typeof answer.why, 'string', `${label}: no reason given`);
    assert.ok(answer.why.length > 0, `${label}: an empty reason`);
    if (matches) assert.match(answer.why, matches, `${label}: the reason does not say what is wrong`);
  });
}

describe('readFileTimes never throws, and trusts only a fresh snapshot of the right shape', () => {
  it('reads a fresh snapshot back whole', async () => {
    const { readFileTimes } = await costsModule();
    await withFile(FILE, JSON.stringify(snapshot()), (dir) => {
      const answer = readFileTimes(dir, { now });
      assert.deepEqual(answer.times, snapshot());
    });
  });

  it('reads one 13 days old and refuses one 15 days old, naming the age', async () => {
    const { readFileTimes } = await costsModule();
    await withFile(FILE, JSON.stringify(snapshot({ generatedAt: at(NOW - 13 * DAY) })), (dir) => {
      assert.notEqual(readFileTimes(dir, { now }).times, null);
    });
    await assertRefused(JSON.stringify(snapshot({ generatedAt: at(NOW - 15 * DAY) })), 'stale', /stale.*15|15.*stale/is);
  });

  it('refuses a date more than a minute in the future, naming it, and reads one half a minute ahead (clock skew)', async () => {
    const { readFileTimes } = await costsModule();
    await assertRefused(JSON.stringify(snapshot({ generatedAt: at(NOW + 2 * 60_000) })), 'future by 2 minutes', /future/i);
    await assertRefused(JSON.stringify(snapshot({ generatedAt: at(NOW + 400 * DAY) })), 'future by a year', /future/i);
    await withFile(FILE, JSON.stringify(snapshot({ generatedAt: at(NOW + 30_000) })), (dir) => {
      assert.notEqual(readFileTimes(dir, { now }).times, null, 'a clock half a minute ahead is not a forged date');
    });
  });

  it('refuses a missing file and a folder that does not exist, with a reason', async () => {
    const { readFileTimes } = await costsModule();
    await assertRefused(null, 'missing');
    const answer = readFileTimes(join(scratchRoot(), 'no-such-folder-for-file-times'), { now });
    assert.equal(answer.times, null, 'a folder that does not exist');
    assert.ok(answer.why.length > 0);
  });

  it('refuses a truncated file, an empty one and plain garbage', async () => {
    const whole = JSON.stringify(snapshot());
    await assertRefused(whole.slice(0, Math.floor(whole.length / 2)), 'truncated');
    await assertRefused('', 'empty');
    await assertRefused('this is not json at all', 'garbage');
    await assertRefused('\u0000\u0000\u0000', 'NUL bytes');
  });

  it('refuses JSON of a foreign shape: a list, another tool\'s object, a stage-costs snapshot, files that are not a map, a date that is no date', async () => {
    await assertRefused('[]', 'a list');
    await assertRefused('null', 'null');
    await assertRefused('"file-times"', 'a string');
    await assertRefused(JSON.stringify({ name: 'some-other-tool', version: 2 }), 'another tool\'s object');
    await assertRefused(JSON.stringify({ generatedAt: at(NOW - 60_000), window: 20, runner: 'container', runs: 7, stages: { alpha: { ran: 7, failed: 1, medianMs: 1500 } } }), 'the stage-costs snapshot');
    await assertRefused(JSON.stringify(snapshot({ files: [] })), 'files as a list');
    await assertRefused(JSON.stringify(snapshot({ files: 'fast' })), 'files as a string');
    await assertRefused(JSON.stringify(snapshot({ runs: 'five' })), 'a run count that is a string');
    await assertRefused(JSON.stringify(snapshot({ generatedAt: 'yesterday' })), 'a date that is no date');
    const { generatedAt: _gone, ...noDate } = snapshot();
    await assertRefused(JSON.stringify(noDate), 'no generatedAt');
    const { files: _none, ...noFiles } = snapshot();
    await assertRefused(JSON.stringify(noFiles), 'no files');
  });

  it('refuses a time that is not a finite non-negative number: a string, a negative, null, an object, one too big for a number', async () => {
    await assertRefused(JSON.stringify(snapshot({ files: { [A]: '300' } })), 'a time that is a string');
    await assertRefused(JSON.stringify(snapshot({ files: { [A]: -1 } })), 'a negative time');
    await assertRefused(JSON.stringify(snapshot({ files: { [A]: null } })), 'a null time');
    await assertRefused(JSON.stringify(snapshot({ files: { [A]: { ms: 300 } } })), 'a time that is a row');
    await assertRefused(`{"generatedAt":"${at(NOW - 60_000)}","newestSourceAt":"${at(NOW - DAY)}","runs":5,"files":{"${A}":1e999}}`, 'a time that parses to Infinity');
    await assertRefused(JSON.stringify(snapshot({ files: { [A]: 300, [B]: 'x' } })), 'one bad time among good ones');
  });

  it('refuses a snapshot with a __proto__ key among its files, and pollutes nothing', async () => {
    const text = `{"generatedAt":"${at(NOW - 60_000)}","newestSourceAt":"${at(NOW - DAY)}","runs":3,"files":{"__proto__":5,"${A}":5}}`;
    await assertRefused(text, '__proto__ key');
    assert.equal(({}).polluted, undefined);
    const { readFileTimes } = await costsModule();
    const ctor = `{"generatedAt":"${at(NOW - 60_000)}","newestSourceAt":"${at(NOW - DAY)}","runs":3,"files":{"constructor":5}}`;
    await withFile(FILE, ctor, (dir) => {
      const { times } = readFileTimes(dir, { now });
      if (times !== null) assert.ok(Object.hasOwn(times.files, 'constructor'), 'a file named constructor read as something else');
    });
  });

  it('is not misled by a file name that exists on every object: a snapshot with no such file gives no time for it', async () => {
    const { readFileTimes } = await costsModule();
    await withFile(FILE, JSON.stringify(snapshot()), (dir) => {
      const { times } = readFileTimes(dir, { now });
      assert.equal(Object.hasOwn(times.files, 'toString'), false);
      assert.equal(Object.hasOwn(times.files, A), true);
    });
  });
});

describe('readSnapshot is the one reading both snapshots go through', () => {
  const whole = (over = {}) => ({ generatedAt: at(NOW - 3_600_000), payload: { a: 1 }, ...over });
  const accept = () => true;
  const refuse = () => false;

  it('reads a whole one back and answers an empty reason', async () => {
    const { readSnapshot } = await costsModule();
    await withFile('any-name.json', JSON.stringify(whole()), (dir) => {
      const answer = readSnapshot(dir, 'any-name.json', { validate: accept, now });
      assert.deepEqual(answer.snapshot, whole());
      assert.equal(answer.why, '');
    });
  });

  it('refuses, never throwing, and says why: missing, unparsable, a shape its validate refuses, __proto__ among the keys (top level or one down), stale, future', async () => {
    const { readSnapshot } = await costsModule();
    const text = JSON.stringify(whole());
    const nested = `{"generatedAt":"${at(NOW - 60_000)}","files":{"__proto__":{"x":1},"a":5}}`;
    const cases = [
      ['missing', null, accept, null],
      ['unparsable', text.slice(0, 20), accept, null],
      ['a foreign shape', text, refuse, null],
      ['a __proto__ key', `{"generatedAt":"${at(NOW - 60_000)}","__proto__":{"x":1}}`, accept, null],
      ['a __proto__ key one level down (among a map\'s keys)', nested, accept, null],
      ['stale', JSON.stringify(whole({ generatedAt: at(NOW - 15 * DAY) })), accept, /stale.*15|15.*stale/is],
      ['future', JSON.stringify(whole({ generatedAt: at(NOW + 5 * 60_000) })), accept, /future/i],
    ];
    for (const [label, body, validate, why] of cases) {
      await withFile('any-name.json', body, (dir) => {
        let answer;
        assert.doesNotThrow(() => { answer = readSnapshot(dir, 'any-name.json', { validate, now }); }, `${label}: threw`);
        assert.equal(answer.snapshot, null, `${label}: trusted`);
        assert.ok(answer.why.length > 0, `${label}: no reason`);
        if (why) assert.match(answer.why, why, label);
      });
    }
  });

  it('readStageCosts still refuses a future date and keeps its stale wording, through it', async () => {
    const { readStageCosts } = await costsModule();
    const stages = { alpha: { ran: 7, failed: 1, medianMs: 1500 } };
    const costs = (over) => JSON.stringify({ generatedAt: at(NOW - 3_600_000), window: 20, runner: 'container', runs: 7, stages, ...over });
    await withFile('stage-costs.json', costs({ generatedAt: at(NOW + 5 * 60_000) }), (dir) => {
      const answer = readStageCosts(dir, { now });
      assert.equal(answer.costs, null);
      assert.match(answer.why, /future/i);
    });
    await withFile('stage-costs.json', costs({ generatedAt: at(NOW - 15 * DAY) }), (dir) => {
      const answer = readStageCosts(dir, { now });
      assert.equal(answer.costs, null);
      assert.match(answer.why, /stale, 15 days old/);
    });
    await withFile('stage-costs.json', costs(), (dir) => assert.notEqual(readStageCosts(dir, { now }).costs, null));
  });
});

describe('writeFileTimes writes the file whole', () => {
  it('leaves the snapshot and no temporary file, and a second write replaces the first', async () => {
    const { writeFileTimes, readFileTimes } = await costsModule();
    const dir = mkdtempSync(join(scratchRoot(), 'file-times-write-'));
    try {
      writeFileTimes(dir, snapshot());
      writeFileTimes(dir, snapshot({ runs: 3, files: { [B]: 41_000 } }));
      assert.deepEqual(readdirSync(dir), [FILE], 'the write left something besides the snapshot');
      assert.deepEqual(readFileTimes(dir, { now }).times, snapshot({ runs: 3, files: { [B]: 41_000 } }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the file name is not one clearTimingResults(\'preflight\') removes, and a preflight-* file beside it is', async () => {
    const { writeFileTimes } = await costsModule();
    const { clearTimingResults } = await import(url('testing/_shared/timing-reporter-flags.mjs'));
    const dir = mkdtempSync(join(scratchRoot(), 'file-times-clear-'));
    try {
      writeFileTimes(dir, snapshot());
      writeFileSync(join(dir, 'preflight-pure-1.jsonl'), '{}\n');
      assert.equal(clearTimingResults('preflight', { dir }), 1);
      assert.deepEqual(readdirSync(dir), [FILE]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('test-times writes the file times from CI\'s records (a fake instance, a scratch repository)', () => {
  const FILTER_CALLS = (server) => server.callsTo('filter').filter(c => JSON.stringify(c.args.filter ?? {}).includes('Test-Run'));
  const day = (n) => `2026-11-${String(10 + n).padStart(2, '0')}T10:00:00.000Z`;
  const measurements = (rows, extra = {}) => JSON.stringify({ files: rows.map(([file, ms]) => ({ file, ms, tests: 3 })), slowest: [], ...extra });

  /** A Test-Run as the instance holds one; `over` replaces properties and `top` the record's own fields. */
  const seedTestRun = (server, n, rows, over = {}, top = {}) => server.seed({
    title: 'standalone', startsAt: day(n), endsAt: day(n),
    properties: {
      recordKey: `ci:${n}:1:standalone-pure:standalone`, source: 'ci', commit: String(n).repeat(40), branch: 'main', runId: String(n), attempt: 1,
      job: 'standalone-pure', suite: 'standalone', outcome: 'passed', scope: 'full', layout: 'ci-parallel-v2', formatVersion: 1,
      ms: 100_000, files: rows.length, tests: 3 * rows.length, passed: 3 * rows.length, failed: 0, cancelled: 0, skipped: 0, todo: 0, dirty: false,
      measurements: measurements(rows), ...over,
    },
    ...top,
  });
  /** A Preflight-Run, so the stage costs beside the file times have something to rest on. */
  const seedPreflightRun = (server, n) => {
    const startsAt = at(Date.parse('2026-11-16T10:00:00.000Z') + n * 60_000);
    return server.seed({
      type: 'Preflight-Run', title: `preflight run ${n}`, startsAt, endsAt: startsAt,
      properties: { recordKey: `local:h:${startsAt}:preflight`, formatVersion: 1, source: 'local', mode: 'full', commit: 'a'.repeat(40), branch: 'main', dirty: false, host: 'h', outcome: 'passed', wallMs: 1000, stageCount: 1, stages: JSON.stringify([{ name: 'alpha', kind: 'source', ms: 1000, outcome: 'passed' }]), runner: 'container' },
    });
  };
  const readJson = (dir, name) => JSON.parse(readFileSync(join(dir, 'test-results', name), 'utf8'));
  const resultsOf = (dir) => (existsSync(join(dir, 'test-results')) ? readdirSync(join(dir, 'test-results')).sort() : []);
  const withInstance = async (fn) => {
    const server = await startFakeYthril();
    const work = makeWorkdir();
    try { return await fn({ server, work, env: { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token, RUNNER_HEAD: 'planted-head' } }); } finally { await server.close(); work.cleanup(); }
  };
  /** The lines a run says about the file times. */
  const aboutFileTimes = (r) => everything(r).split(/\r?\n/).filter(l => /file[- ]?times|per-file/i.test(l));

  /** Five qualifying records: A in all five (100..500), B in four (1000..4000), the third record's measurements cut for size. */
  const seedFive = (server) => {
    for (let n = 1; n <= 5; n++) {
      const rows = [[A, n * 100]];
      if (n !== 5) rows.push([B, n * 1000]);
      seedTestRun(server, n, rows, n === 3 ? { measurements: JSON.stringify({ truncated: true, files: rows.map(([file, ms]) => ({ file, ms, tests: 3 })) }) } : {});
    }
  };

  /**
   * A server that ignores the predicate it is asked and answers every Test-Run, newest first, honouring `_id`, `projection` and nothing
   * else: what a record of another branch, scope or job looks like when it reaches a caller that must check again.
   */
  const answerEveryTestRun = (server) => {
    server.respond = (call, body) => {
      if (call.tool !== 'filter' || !JSON.stringify(body.filter ?? {}).includes('Test-Run')) return undefined;
      const wanted = body.filter?._id;
      let rows = server.store.filter(e => e.type === 'Test-Run' && (wanted === undefined || (typeof wanted === 'string' ? e._id === wanted : (wanted.$in ?? []).includes(e._id))));
      rows = [...rows].sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1)).map(r => structuredClone(r));
      for (const [path, v] of Object.entries(body.projection ?? {})) {
        if (v === 0 && path === 'properties.measurements') rows.forEach(r => { delete r.properties.measurements; });
      }
      if (Object.values(body.projection ?? {}).includes(1)) rows = rows.map(r => ({ _id: r._id, properties: { measurements: r.properties.measurements } }));
      return { status: 200, body: { ok: true, text: 'answer in data', data: { collection: 'chrono', results: rows, count: rows.length, total: rows.length, limit: rows.length, skip: 0, truncated: false } } };
    };
  };

  it('--preflight-costs writes file-times.json: the median per file over the five records, a truncated row counted, the files slimmed to path and ms', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      seedFive(server);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const snap = readJson(work.dir, FILE);
      assert.equal(snap.runs, 5, 'the run count is not the five records');
      // A: 100 200 300 400 500 -> 300. B: 1000 2000 3000 4000 in four records -> the mean of the middle two, 2500.
      assert.deepEqual(snap.files, { [A]: 300, [B]: 2500 });
      assert.ok(Math.abs(Date.parse(snap.generatedAt) - Date.now()) < 120_000, snap.generatedAt);
      assert.equal(snap.newestSourceAt, day(5), 'the snapshot does not say which record is the newest it rests on');
      assert.deepEqual(resultsOf(work.dir), ['file-times.json', 'stage-costs.json'], 'the write left a temporary file, or no stage costs');
    });
  });

  it('asks the server for source ci, job standalone-pure, branch main, scope full', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      seedFive(server);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const asked = FILTER_CALLS(server).map(c => JSON.stringify(c.args.filter));
      assert.ok(asked.length >= 1, 'no filter call asked for Test-Run records');
      const wholeAsk = asked.find(f => /"properties\.source":"ci"/.test(f) && /"properties\.job":"standalone-pure"/.test(f)
        && /"properties\.branch":"main"/.test(f) && /"properties\.scope":"full"/.test(f));
      assert.ok(wholeAsk, `no one filter carries all four of source, job, branch and scope:\n${asked.join('\n')}`);
    });
  });

  it('counts only the newest five of those: an older sixth sets no time', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      seedTestRun(server, 0, [[A, 9_000_000]]);
      seedFive(server);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const snap = readJson(work.dir, FILE);
      assert.equal(snap.runs, 5);
      assert.equal(snap.files[A], 300, 'a sixth, older record moved the median');
    });
  });

  it('checks the records again: another branch, another scope, another job and a laptop\'s run, answered by a server that ignores the filter, are not counted', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      seedFive(server);
      // Newer than every good record, and each wrong in one field only.
      seedTestRun(server, 6, [[A, 8_000_000]], { branch: 'feature/x' });
      seedTestRun(server, 7, [[A, 8_000_000]], { scope: 'files' });
      seedTestRun(server, 8, [[A, 8_000_000]], { job: 'standalone-db' });
      seedTestRun(server, 9, [[A, 8_000_000]], { source: 'local' });
      answerEveryTestRun(server);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const snap = readJson(work.dir, FILE);
      assert.equal(snap.runs, 5, 'a record that is not source ci, job standalone-pure, branch main, scope full was counted');
      assert.deepEqual(snap.files, { [A]: 300, [B]: 2500 });
      assert.equal(snap.newestSourceAt, day(5));
    });
  });

  it('a record whose measurements do not parse is not counted, and the others still are', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      for (let n = 1; n <= 4; n++) seedTestRun(server, n, [[A, n * 100], [B, n * 1000]]);
      seedTestRun(server, 5, [[A, 1]], { measurements: '{"files":[{"file":"testing/standalone/alpha.test.js","ms":' });
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const snap = readJson(work.dir, FILE);
      assert.equal(snap.runs, 4, 'a record that does not parse was counted');
      // 100 200 300 400 -> the mean of the middle two.
      assert.equal(snap.files[A], 250);
      assert.equal(snap.files[B], 2500);
    });
  });

  it('with no usable record it writes no file times, says one line, still writes the stage costs and exits 0', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      seedTestRun(server, 1, [[A, 100]], { branch: 'feature/x' });
      seedTestRun(server, 2, [[A, 100]], { measurements: 'not json' });
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(resultsOf(work.dir), ['stage-costs.json'], 'a file-times.json was written from nothing');
      assert.equal(aboutFileTimes(r).length, 1, `the missing file times are not one line:\n${everything(r)}`);
    });
  });

  it('a refused read of the records is one line naming the file times, and changes neither the stage costs nor the exit status', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      seedFive(server);
      server.respond = (call, body) => (call.tool === 'filter' && JSON.stringify(body.filter ?? {}).includes('Test-Run')
        ? { status: 500, body: { ok: false, error: 'the instance is busy', data: null } } : undefined);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(resultsOf(work.dir), ['stage-costs.json'], 'a snapshot was written from a refused read, or the stage costs were lost');
      assert.equal(aboutFileTimes(r).length, 1, `the failure is not one line about the file times:\n${everything(r)}`);
    });
  });

  describe('--drain-unrecorded', () => {
    const planted = (generatedAt) => ({ generatedAt, newestSourceAt: generatedAt, runs: 99, files: { 'testing/standalone/planted.test.js': 7 } });
    /** A snapshot already in the folder, dated `generatedAt`, its modification time the same, so neither way of reading its age differs. */
    const plant = (dir, generatedAt) => {
      mkdirSync(join(dir, 'test-results'), { recursive: true });
      const file = join(dir, 'test-results', FILE);
      writeFileSync(file, JSON.stringify(planted(generatedAt)));
      utimesSync(file, new Date(generatedAt), new Date(generatedAt));
    };
    const drained = async (leave) => withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server, 1);
      seedFive(server);
      if (leave) leave(work.dir);
      const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      // Read before `withInstance` removes the scratch repository: what the run left is only there until then.
      const saved = Object.fromEntries(['file-times.json', 'stage-costs.json'].map(n => [n, existsSync(join(work.dir, 'test-results', n)) ? readJson(work.dir, n) : null]));
      return { r, saved, server };
    });

    it('writes it when it is missing, after the stage costs (both exist)', async () => {
      const { saved } = await drained();
      assert.deepEqual(saved[FILE]?.files, { [A]: 300, [B]: 2500 });
      assert.equal(saved['stage-costs.json']?.runs, 1);
    });

    it('leaves one a day old or less alone: 23 hours', async () => {
      const when = at(Date.now() - 23 * 3_600_000);
      const { saved } = await drained((d) => plant(d, when));
      assert.deepEqual(saved[FILE], planted(when), 'a snapshot under a day old was written again');
    });

    it('writes it again when it is 25 hours old', async () => {
      const { saved } = await drained((d) => plant(d, at(Date.now() - 25 * 3_600_000)));
      const snap = saved[FILE];
      assert.notEqual(snap.runs, 99, 'a snapshot over a day old stayed');
      assert.deepEqual(snap.files, { [A]: 300, [B]: 2500 });
    });

    it('writes it again when it is dated in the future', async () => {
      const { saved } = await drained((d) => plant(d, at(Date.now() + 2 * DAY)));
      const snap = saved[FILE];
      assert.notEqual(snap.runs, 99, 'a snapshot dated in the future stayed, and would stay for ever');
      assert.ok(Date.parse(snap.generatedAt) < Date.now() + 120_000, snap.generatedAt);
    });

    it('writes the stage costs even when the file times cannot be read: one line, exit 0', async () => {
      await withInstance(async ({ server, work, env }) => {
        seedPreflightRun(server, 1);
        seedFive(server);
        server.respond = (call, body) => (call.tool === 'filter' && JSON.stringify(body.filter ?? {}).includes('Test-Run')
          ? { status: 500, body: { ok: false, error: 'the instance is busy', data: null } } : undefined);
        const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir, env });
        assert.equal(r.code, 0, everything(r));
        assert.deepEqual(resultsOf(work.dir), ['stage-costs.json'], 'the stage costs were lost with the file times, or a file was written from a refused read');
        assert.equal(aboutFileTimes(r).length, 1, `the failure is not one line about the file times:\n${everything(r)}`);
      });
    });
  });
});
