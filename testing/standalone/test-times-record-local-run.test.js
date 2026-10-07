/**
 * `scripts/test-times.mjs --record` writes one typed, complete, idempotent record per suite of a local run to a
 * Ythril instance — and when it cannot, loses nothing, says so in exact words, and never touches the tests' exit
 * code.
 *
 * ## What this prevents
 *
 * The protocol of test runs lives in Ythril as `Test-Run` chrono entries so the loop can read "how long does main
 * take" from a record instead of from a CI log. A recorder like that goes wrong quietly in six ways, each tested
 * here by running the real CLI against a local server that speaks the Ythril REST tool door (it keeps a store, so
 * "one record" means one entry actually held):
 *
 * 1. **A second record for the same run.** The record's identity is `properties.recordKey` =
 *    `source:runId:attempt:job:suite`. The recorder FINDS by it, then updates by id or inserts — it cannot supply its
 *    own id, because `save_chrono` ignores one that names nothing (P8) — and every `--record` collapses duplicates of
 *    its key to the newest. Two recorders at once would race the find and the insert, so there is one writer per
 *    machine (a lock), and a recorder that died holding it must not wedge the next one.
 * 2. **A record that says "passed" about a run that did not finish.** `outcome` (`passed`, `failed`, `cancelled`,
 *    `incomplete`), `scope` (`full`, `subset`, `files`), `layout` (`local` here), `dirty` and `formatVersion` are
 *    derived from the JSONL SET: a file with no sentinel line, a sentinel whose count is wrong or a last line cut
 *    mid-object is incomplete, and a suite whose batches disagree is the weaker of them. Baselines are drawn only from
 *    `full` + `passed`, so a wrong value here poisons every flag.
 * 3. **A lost record.** With no URL configured, or an instance that answers 500, 401, or not at all, the payload is
 *    written to `test-results/unrecorded/` and the lines `test-times: not recorded: <why>; kept <path>` are printed.
 *    The next `--record` that can reach the instance drains the folder. The CLI exits 0 either way: a recording
 *    problem is never a test failure.
 * 4. **A leaked secret.** The token is never printed or stored; a failure message that carries a token-shaped
 *    string or an absolute home path is masked before it is written, and a stack is never stored.
 * 5. **A recording from CI.** CI never holds a token; `--record` and `--record-ci` refuse under `GITHUB_ACTIONS` or
 *    `CI` and send nothing.
 * 6. **An undocumented input.** `--help` names every flag and variable the script reads.
 *
 * ## The interface this pins
 *
 * The CLI runs in the repository root: results from `test-results/*.jsonl` (line shape: see
 * `testing/_shared/test-times-harness.mjs`), commit, branch and cleanliness from git, destination from
 * `YTHRIL_TEST_RUNS_URL` / `YTHRIL_TEST_RUNS_TOKEN`, space `y-proj-ythril`. One `Test-Run` chrono entry per suite,
 * `status: completed`, `startsAt` / `endsAt` the sentinel's, flat `properties` (string, number or boolean values only)
 * with `recordKey`, `source`, `commit`, `branch`, `runId` (a string), `attempt`, `job`, `suite`, `ms` (the sum of the
 * files' own durations), `files`, `tests`, `passed`, `failed`, `cancelled`, `skipped`, `todo`, `outcome`, `scope`,
 * `layout`, `dirty`, `formatVersion` and `measurements` (a JSON string of every file's ms, tests, skips and failures).
 *
 * Local server only; no real instance.
 *
 * Run: node --test testing/standalone/test-times-record-local-run.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeYthril, FAKE_SPACE } from '../_shared/fake-ythril-tool-server.mjs';
import { closedLoopbackPort } from '../_shared/closed-port.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { makeWorkdir, writeResults, runTimes, spawnTimes, everything, entriesBySuite as bySuite, T } from '../_shared/test-times-harness.mjs';

const envFor = (server, extra = {}) => ({ YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token, ...extra });
const PRIMITIVE = new Set(['string', 'number', 'boolean']);

/** Stand a scratch repo and a fake instance up, run `body`, and take both down whatever happens. */
async function withRun(opts, body) {
  const server = await startFakeYthril(opts.server);
  const work = makeWorkdir(opts.git);
  try { return await body({ server, work, dir: work.dir }); } finally { await server.close(); work.cleanup(); }
}

const A = 'testing/standalone/a.test.js';
const B = 'testing/standalone/b.test.js';
const C = 'testing/standalone/c.test.js';
const R = 'testing/red-team-tests/r.test.js';

/** standalone: two batches, three files; redteam: one batch, one file. Expected sums are in STANDARD. */
function writeStandard(dir, over = {}) {
  writeResults(dir, { suite: 'standalone', batch: 'pure', files: [
    { file: A, ms: 4000, tests: [T('t1', 1000), T('t2', 2000), T('t3', 5, { skip: true, reason: 'expected-in-ci: corpus not fetched' })] },
    { file: B, ms: 6000, tests: [T('t4', 3000), T('t5', 1, { todo: true })] },
  ], ...over.pure });
  writeResults(dir, { suite: 'standalone', batch: 'db', files: [{ file: C, ms: 10_000, tests: [T('t6', 9000)] }], ...over.db });
  writeResults(dir, { suite: 'redteam', batch: 'all', files: [{ file: R, ms: 3000, tests: [T('t7', 1000), T('t8', 1000)] }], ...over.red });
}
const STANDARD = {
  standalone: { files: 3, tests: 6, passed: 4, failed: 0, cancelled: 0, skipped: 1, todo: 1, ms: 20_000 },
  redteam: { files: 1, tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, ms: 3000 },
};

/** The chrono entries the fake holds, by record key. */
const byKey = (server) => {
  const map = new Map();
  for (const e of server.store) { const k = e.properties?.recordKey; map.set(k, [...(map.get(k) ?? []), e]); }
  return map;
};

const findKey = (obj, key) => {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) { const hit = findKey(v, key); if (hit !== undefined) return hit; }
  return undefined;
};

describe('a full, clean local run is recorded once per suite, typed and complete', () => {
  it('writes one completed Test-Run per suite into y-proj-ythril with the plan\'s flat, typed properties', async () => {
    await withRun({}, async ({ server, work, dir }) => {
      writeStandard(dir);
      const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.store.length, 2, 'two suites, two records');
      const saves = server.callsTo('save_chrono');
      assert.equal(saves.length, 2);
      for (const c of saves) {
        assert.equal(c.args.space, FAKE_SPACE);
        assert.equal(c.args.type, 'Test-Run');
        assert.equal(c.args.status, 'completed');
        assert.equal(c.args.startsAt, '2026-10-05T10:00:00.000Z', 'startsAt is the run\'s start');
        assert.equal(c.args.endsAt, '2026-10-05T10:07:30.000Z', 'endsAt is the run\'s end');
        assert.ok(!('id' in c.args), 'a supplied id is not adopted by the server, so none is supplied');
      }
      const records = bySuite(server);
      for (const [suite, want] of Object.entries(STANDARD)) {
        const p = records[suite].properties;
        for (const [k, v] of Object.entries(p)) assert.ok(PRIMITIVE.has(typeof v), `${suite}.${k} is ${typeof v}; a chrono property is a string, number or boolean`);
        assert.equal(p.source, 'local');
        assert.equal(p.commit, work.commit);
        assert.equal(p.branch, 'main');
        assert.equal(p.suite, suite);
        assert.equal(typeof p.runId, 'string', 'the run id is text');
        assert.match(p.runId, /^local-/);
        assert.ok(p.runId.endsWith(work.commit.slice(0, 7)), `a local run id ends in the commit\'s 7 characters: ${p.runId}`);
        assert.equal(p.recordKey, `${p.source}:${p.runId}:${p.attempt}:${p.job}:${p.suite}`);
        assert.equal(String(p.attempt), '1');
        assert.equal(typeof p.job, 'string');
        assert.equal(p.formatVersion, 1);
        assert.equal(p.outcome, 'passed');
        assert.equal(p.scope, 'full');
        assert.equal(p.layout, 'local');
        assert.equal(p.dirty, false);
        for (const k of ['files', 'tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'ms']) assert.equal(p[k], want[k], `${suite}.${k}`);
        assert.equal(p.passed + p.failed + p.cancelled + p.skipped + p.todo, p.tests, 'the counts partition the tests');
        const measurements = JSON.parse(p.measurements);
        const text = JSON.stringify(measurements);
        for (const f of [A, B, C, R].filter(f => (suite === 'standalone') === !f.includes('red-team'))) assert.ok(text.includes(f), `${suite} measurements name ${f}`);
        if (suite === 'standalone') assert.ok(text.includes('corpus not fetched'), 'the skip and its reason are in the measurements');
      }
    });
  });

  it('records the branch it was run on, not main', async () => {
    await withRun({ git: { branch: 'feature/faster-ci' } }, async ({ server, dir }) => {
      writeStandard(dir);
      const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.store.length, 2, 'both suites were recorded');
      for (const e of server.store) assert.equal(e.properties.branch, 'feature/faster-ci');
    });
  });

  it('finds before it writes: the first call for each key is a read of properties.recordKey', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeStandard(dir);
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(server.store.length, 2, 'both suites were recorded');
      for (const e of server.store) {
        const key = e.properties.recordKey;
        const firstTouch = server.calls.findIndex(c => JSON.stringify(c.args).includes(key));
        assert.equal(server.calls[firstTouch].tool, 'filter', `the first call naming ${key} is a read`);
        assert.ok(JSON.stringify(server.calls[firstTouch].args.filter).includes('properties.recordKey'));
        assert.ok(firstTouch < server.calls.findIndex(c => c.tool === 'save_chrono' && c.args.properties.recordKey === key));
      }
    });
  });
});

describe('outcome, scope and dirty are derived from the JSONL set and the tree', () => {
  const ROWS = [
    ['a clean run', {}, 'passed'],
    ['a failing test', { tests: [T('t1', 1, { status: 'fail', message: 'AssertionError: boom' })] }, 'failed', { failed: 1 }],
    ['a file that failed to load (no test lines)', { fail: true, tests: [] }, 'failed', { failed: 1 }],
    ['a failed hook (a suite line, no failed test)', { tests: [T('describe block', 1, { suiteFail: true, message: 'before hook failed' })] }, 'failed', { failed: 1 }],
    ['a cancelled test', { tests: [T('t1', 1, { status: 'cancelled' })] }, 'cancelled', { cancelled: 1 }],
  ];
  for (const [what, file, outcome, counts] of ROWS) {
    it(`${what} → outcome ${outcome}`, async () => {
      await withRun({}, async ({ server, dir }) => {
        writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, ...file }] });
        const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
        assert.equal(r.code, 0, everything(r));
        const p = bySuite(server).standalone.properties;
        assert.equal(p.outcome, outcome);
        for (const [k, v] of Object.entries(counts ?? {})) assert.equal(p[k], v, `${what}: ${k} counts the failure once, from the test event and not from the failing file wrapped round it`);
      });
    });
  }

  const INCOMPLETE = [
    ['no sentinel line (a killed run)', { sentinel: 'missing' }],
    ['a sentinel whose event count is wrong', { sentinel: 'miscount' }],
    ['a last line cut mid-object', { truncated: true }],
  ];
  for (const [what, over] of INCOMPLETE) {
    it(`a file with ${what} → outcome incomplete, never passed`, async () => {
      await withRun({}, async ({ server, dir }) => {
        writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('t1', 1)] }], ...over });
        const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
        assert.equal(r.code, 0, everything(r));
        assert.equal(bySuite(server).standalone.properties.outcome, 'incomplete');
      });
    });
  }

  it('a suite of two batches is as weak as its weakest: one incomplete batch makes it incomplete, one failed batch makes it failed', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('t1', 1)] }] });
      writeResults(dir, { suite: 'standalone', batch: 'db', files: [{ file: C, ms: 1000, tests: [T('t2', 1)] }], sentinel: 'missing' });
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(bySuite(server).standalone.properties.outcome, 'incomplete');
    });
    await withRun({}, async ({ server, dir }) => {
      writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('t1', 1)] }] });
      writeResults(dir, { suite: 'standalone', batch: 'db', files: [{ file: C, ms: 1000, tests: [T('t2', 1, { status: 'fail', message: 'x' })] }] });
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(bySuite(server).standalone.properties.outcome, 'failed');
    });
  });

  for (const scope of ['full', 'subset', 'files']) {
    it(`scope ${scope} is recorded as ${scope}`, async () => {
      await withRun({}, async ({ server, dir }) => {
        writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('t1', 1)] }], scope });
        await runTimes(['--record'], { cwd: dir, env: envFor(server) });
        assert.equal(bySuite(server).standalone.properties.scope, scope);
      });
    });
  }

  it('a run whose runner did not say what it covered is never `full`', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('t1', 1)] }], scope: null });
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      const scope = bySuite(server).standalone.properties.scope;
      assert.ok(['subset', 'files'].includes(scope), `scope is ${scope}; a baseline must not be drawn from a run nobody vouched for`);
    });
  });

  it('a suite where one batch covered less than the whole is not `full`', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('t1', 1)] }], scope: 'full' });
      writeResults(dir, { suite: 'standalone', batch: 'db', files: [{ file: C, ms: 1000, tests: [T('t2', 1)] }], scope: 'files' });
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.notEqual(bySuite(server).standalone.properties.scope, 'full');
    });
  });

  const DIRTY = [
    ['a clean tree', {}, false],
    ['a modified tracked file', { dirty: true }, true],
    ['an untracked file', { untracked: true }, true],
  ];
  for (const [what, git, dirty] of DIRTY) {
    it(`${what} → dirty ${dirty}`, async () => {
      await withRun({ git }, async ({ server, dir }) => {
        writeStandard(dir);
        await runTimes(['--record'], { cwd: dir, env: envFor(server) });
        assert.equal(server.store.length, 2, 'both suites were recorded');
        for (const e of server.store) assert.equal(e.properties.dirty, dirty);
      });
    });
  }
});

describe('one record per key, however often and however many at once', () => {
  it('a second --record of the same run adds nothing: it finds the first', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeStandard(dir);
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      const first = server.store.map(e => ({ id: e._id, key: e.properties.recordKey }));
      const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.callsTo('save_chrono').length, 2, 'no second insert');
      assert.deepEqual(server.store.map(e => ({ id: e._id, key: e.properties.recordKey })), first);
    });
  });

  it('updates the entry it finds, by id, rather than inserting beside it', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeStandard(dir);
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      const entry = bySuite(server).standalone;
      const id = entry._id;
      entry.properties.ms = 1; // a stale or partial earlier write
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(server.callsTo('save_chrono').length, 2);
      assert.equal(server.store.length, 2);
      assert.equal(bySuite(server).standalone._id, id);
      assert.equal(bySuite(server).standalone.properties.ms, STANDARD.standalone.ms, 'the entry was brought up to date');
      assert.ok(server.callsTo('update_chrono').some(c => c.args.id === id));
    });
  });

  it('collapses duplicates of the key to the NEWEST one', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeStandard(dir);
      await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      const original = bySuite(server).standalone;
      const key = original.properties.recordKey;
      const older = server.seed({ properties: { ...original.properties, ms: 5 }, createdAt: '2020-01-01T00:00:00.000Z' });
      const newest = server.seed({ properties: { ...original.properties, ms: 6 }, createdAt: '2099-01-01T00:00:00.000Z' });
      const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(r.code, 0, everything(r));
      const held = byKey(server).get(key);
      assert.equal(held.length, 1, 'duplicates of one key are collapsed on every run');
      assert.equal(held[0]._id, newest._id, 'the newest survives');
      assert.deepEqual(new Set(server.callsTo('delete_chrono').map(c => c.args.id)), new Set([original._id, older._id]));
      assert.equal(held[0].properties.ms, STANDARD.standalone.ms, 'and is the one brought up to date');
    });
  });

  it('serialises two recorders on one machine: never two requests open at once, one entry per key', async () => {
    await withRun({ server: { delayMs: 400 } }, async ({ server, dir }) => {
      writeStandard(dir);
      const one = spawnTimes(['--record'], { cwd: dir, env: envFor(server) });
      const two = spawnTimes(['--record'], { cwd: dir, env: envFor(server) });
      const [a, b] = await Promise.all([one.done, two.done]);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(b.code, 0, b.stderr);
      assert.equal(server.maxInFlight, 1, 'a second writer waited for the first instead of racing it');
      assert.equal(server.store.length, 2);
      assert.equal(byKey(server).size, 2);
    });
  });

  it('is not wedged by a recorder that was killed while holding the lock', async () => {
    await withRun({ server: { delayMs: 4000 } }, async ({ server, dir }) => {
      writeStandard(dir);
      const doomed = spawnTimes(['--record'], { cwd: dir, env: envFor(server) });
      await waitFor(() => server.calls.length > 0, 15_000, 50, undefined, { what: 'the first recorder to reach the server' });
      doomed.child.kill('SIGKILL');
      await doomed.done;
      server.delayMs = 0;
      const r = await runTimes(['--record'], { cwd: dir, env: envFor(server), timeoutMs: 25_000 });
      assert.equal(r.code, 0, everything(r));
      assert.equal(byKey(server).size, 2, 'the next recorder wrote its records');
      for (const entries of byKey(server).values()) assert.equal(entries.length, 1);
    });
  });
});

describe('a record that cannot be written is kept, said so in exact words, and never fails the caller', () => {
  const unrecordedFiles = (dir) => {
    const folder = join(dir, 'test-results', 'unrecorded');
    return existsSync(folder) ? readdirSync(folder).filter(f => f.endsWith('.json')).map(f => join(folder, f)) : [];
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = (r, re) => everything(r).split(/\r?\n/).filter(l => re.test(l));

  it('with no URL configured: prints the exact line per kept payload, exits 0, writes nothing anywhere', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeStandard(dir);
      const r = await runTimes(['--record'], { cwd: dir });
      assert.equal(r.code, 0, everything(r));
      const kept = unrecordedFiles(dir);
      assert.equal(kept.length, 2, 'one payload per suite');
      const said = lines(r, /^test-times: not recorded: YTHRIL_TEST_RUNS_URL unset; kept test-results\/unrecorded\/\S+\.json$/);
      assert.equal(said.length, 2, `the exact line, once per payload; output was:\n${everything(r)}`);
      for (const f of kept) assert.ok(said.some(l => l.endsWith(f.split(/[\\/]/).pop())), 'each line names a file that exists');
      for (const f of kept) assert.ok(typeof findKey(JSON.parse(readFileSync(f, 'utf8')), 'recordKey') === 'string', 'the kept payload is the record');
      assert.equal(server.calls.length, 0);
    });
  });

  const FAILURES = [
    ['an instance that answers 500', (s) => { s.respond = () => ({ status: 500, body: { ok: false, error: 'boom', data: null } }); return {}; }, (s) => new RegExp(`^test-times: not recorded: 500 from ${escapeRe(s.url)}\\S*; kept test-results/unrecorded/\\S+\\.json$`)],
    ['a token the instance refuses', () => ({ YTHRIL_TEST_RUNS_TOKEN: 'ythril_wrong_token_value_000' }), (s) => new RegExp(`^test-times: not recorded: 401 from ${escapeRe(s.url)}\\S*; kept test-results/unrecorded/\\S+\\.json$`)],
  ];
  for (const [what, arrange, expected] of FAILURES) {
    it(`${what}: keeps the payload, prints the exact line, exits 0, prints no secret`, async () => {
      await withRun({}, async ({ server, dir }) => {
        writeStandard(dir);
        const extra = arrange(server);
        const r = await runTimes(['--record'], { cwd: dir, env: envFor(server, extra) });
        assert.equal(r.code, 0, everything(r));
        assert.equal(unrecordedFiles(dir).length, 2);
        assert.equal(lines(r, expected(server)).length, 2, `output was:\n${everything(r)}`);
        for (const secret of [server.token, extra.YTHRIL_TEST_RUNS_TOKEN].filter(Boolean)) {
          assert.ok(!everything(r).includes(secret), 'the token is not printed');
          for (const f of unrecordedFiles(dir)) assert.ok(!readFileSync(f, 'utf8').includes(secret), 'nor stored beside the payload');
        }
      });
    });
  }

  it('an instance that cannot be reached: keeps the payload, prints the line, exits 0', async () => {
    await withRun({}, async ({ dir }) => {
      writeStandard(dir);
      const port = await closedLoopbackPort();
      const r = await runTimes(['--record'], { cwd: dir, env: { YTHRIL_TEST_RUNS_URL: `http://127.0.0.1:${port}`, YTHRIL_TEST_RUNS_TOKEN: 'ythril_some_token_value_123' } });
      assert.equal(r.code, 0, everything(r));
      assert.equal(unrecordedFiles(dir).length, 2);
      assert.equal(lines(r, /^test-times: not recorded: \S.*; kept test-results\/unrecorded\/\S+\.json$/).length, 2, everything(r));
      assert.ok(!everything(r).includes('ythril_some_token_value_123'));
    });
  });

  it('the next --record that can reach the instance drains the folder, says how many, and leaves one record per key', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeStandard(dir);
      await runTimes(['--record'], { cwd: dir }); // not configured: both kept
      assert.equal(unrecordedFiles(dir).length, 2);
      const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(r.code, 0, everything(r));
      assert.equal(unrecordedFiles(dir).length, 0, 'the folder is empty afterwards');
      const said = lines(r, /drain/i);
      assert.ok(said.some(l => /\b2\b/.test(l)), `a line says how many were drained:\n${everything(r)}`);
      assert.equal(server.store.length, 2);
      for (const entries of byKey(server).values()) assert.equal(entries.length, 1, 'the kept payload and the fresh one are the same record');
    });
  });
});

describe('what the recorder writes carries no secret and no stack', () => {
  it('masks token-shaped strings and absolute home paths, and stores the first line of a failure only', async () => {
    await withRun({}, async ({ server, dir }) => {
      const message = 'AssertionError: leaked ythril_abcdef0123456789ABCDEF and ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Authorization: Bearer opaque-credential-0123456789 at C:\\Users\\Menne\\secret-project\\file.js';
      writeResults(dir, { suite: 'standalone', batch: 'pure', files: [{ file: A, ms: 1000, tests: [T('the failing test', 1, { status: 'fail', message })] }] });
      const r = await runTimes(['--record'], { cwd: dir, env: envFor(server) });
      assert.equal(r.code, 0, everything(r));
      const sent = JSON.stringify(server.calls.map(c => c.args));
      for (const secret of ['ythril_abcdef0123456789ABCDEF', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'opaque-credential-0123456789', 'Menne', 'secret-project']) assert.ok(!sent.includes(secret), `${secret} must not be written`);
      assert.ok(sent.includes('the failing test'), 'the failure itself is recorded');
      assert.ok(!/"(actor|author|email|login|sender)/i.test(JSON.stringify(server.store.map(e => e.properties))), 'no person is named');
    });
  });
});

describe('recording is refused under CI, and sends nothing', () => {
  for (const variable of ['GITHUB_ACTIONS', 'CI']) {
    for (const flag of ['--record', '--record-ci']) {
      it(`${flag} with ${variable}=true`, async () => {
        await withRun({}, async ({ server, dir }) => {
          writeStandard(dir);
          const r = await runTimes([flag], { cwd: dir, env: envFor(server, { [variable]: 'true', GH_TOKEN: 'ghp_irrelevant' }) });
          assert.notEqual(r.code, 0, `a refusal is an error:\n${everything(r)}`);
          assert.match(everything(r), /GITHUB_ACTIONS|\bCI\b/);
          assert.equal(server.calls.length, 0, 'nothing is sent from CI');
          assert.equal(server.store.length, 0);
        });
      });
    }
  }

  it('every recording form is refused with one code, and it is not the code of an ordinary failure', async () => {
    await withRun({}, async ({ server, dir }) => {
      writeStandard(dir);
      const env = envFor(server, { GITHUB_ACTIONS: 'true', GH_TOKEN: 'ghp_irrelevant' });
      // An ordinary failure of this script (a command it does not know) is the code a refusal must be told apart from.
      const ordinary = await runTimes(['--no-such-command'], { cwd: dir, env: envFor(server) });
      assert.notEqual(ordinary.code, 0, everything(ordinary));
      const codes = new Map();
      for (const args of [['--record'], ['--record-ci'], ['--record-ci', '1001'], ['--rewrite', 'ci:1001:1:standalone-pure:standalone'], ['--rewrite', 'local:1:1:local:standalone']]) {
        const r = await runTimes(args, { cwd: dir, env });
        assert.match(everything(r), /GITHUB_ACTIONS|\bCI\b/, `${args.join(' ')} was not refused for CI:\n${everything(r)}`);
        codes.set(args.join(' '), r.code);
      }
      assert.equal(new Set(codes.values()).size, 1, `the refusal's code depends on the form: ${JSON.stringify([...codes])}`);
      const [code] = codes.values();
      assert.notEqual(code, 0);
      assert.notEqual(code, ordinary.code, 'a refusal for CI exits with the code of an ordinary failure, so a caller cannot tell the two apart');
      assert.equal(server.calls.length, 0, 'nothing is sent from CI');
    });
  });
});

describe('--help names every input the script reads', () => {
  it('lists the flags and the variables', async () => {
    await withRun({}, async ({ dir }) => {
      const r = await runTimes(['--help'], { cwd: dir });
      assert.equal(r.code, 0, everything(r));
      for (const word of ['--record', '--record-ci', '--trend', 'YTHRIL_TEST_RUNS_URL', 'YTHRIL_TEST_RUNS_TOKEN', 'GH_TOKEN']) {
        assert.ok(r.stdout.includes(word), `--help mentions ${word}:\n${r.stdout}`);
      }
    });
  });

  it('says --record-ci takes the id of the run a caller waits for (Q-402), and that the pass fails when it was not listed', async () => {
    await withRun({}, async ({ dir }) => {
      const r = await runTimes(['--help'], { cwd: dir });
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /--record-ci\s+\[<runId>\]/, `--help shows the optional run id:\n${r.stdout}`);
      const entry = r.stdout.slice(r.stdout.indexOf('--record-ci'), r.stdout.indexOf('--type-schema'));
      assert.match(entry, /not (?:in|among) the listing|not listed/i, `the entry says what happens to a named run the pass did not list:\n${entry}`);
    });
  });
});
