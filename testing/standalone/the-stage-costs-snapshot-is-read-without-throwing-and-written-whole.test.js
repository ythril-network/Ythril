/**
 * The preflight reads the measured stage costs from one untracked snapshot, `test-results/stage-costs.json`, and the host keeps it
 * fresh (Q-865). The reader never throws and refuses what it cannot trust; the writer never leaves a half-written file.
 *
 * ## The defect this refuses
 *
 * The preflight must never fetch (a down instance would delay the fast failure it exists for), so the measurements reach it through a
 * file. A file read by a script that runs before every push is input from outside the run: a truncated write, another tool's JSON, a
 * `__proto__` key, a snapshot from last month. Each must end as the hand-ordered list with a reason (`{ costs: null, why }`), never as
 * a throw that stops the preflight, a plan from numbers nobody measured, or a polluted prototype. And the file lives in the results
 * folder under a name `clearTimingResults('preflight')` does not remove: the preflight clears its own `preflight-*` files at the
 * start of every run, and the snapshot is not one of them.
 *
 * ## What it asserts
 *
 * - `readStageCosts(dir, { now })` answers `{ costs, why }` and never throws: a missing, truncated, garbage, foreign-shaped,
 *   `__proto__`-keyed or older-than-14-days file gives `costs: null` and a `why`; a fresh one reads back whole.
 * - `writeStageCosts(dir, snapshot)` writes a temporary file in the folder and renames it into place: afterwards the folder holds
 *   the snapshot and nothing else.
 * - The name survives `clearTimingResults('preflight')`.
 * - `node scripts/test-times.mjs --preflight-costs` writes the snapshot from the instance's records (the runner's rows, filtered on
 *   the server), and `--drain-unrecorded` refreshes it after the drain, also when nothing was spooled, and a refresh that fails
 *   changes neither the exit status nor the drain. Local fake instance only.
 *
 * Run: node --test testing/standalone/the-stage-costs-snapshot-is-read-without-throwing-and-written-whole.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { makeWorkdir, runTimes, everything } from '../_shared/test-times-harness.mjs';

const url = (p) => pathToFileURL(join(REPO_ROOT, p)).href;
/** Imported inside each case, so a base without the module fails each case by name and not the whole file at load. */
const costsModule = () => import(url('scripts/_shared/stage-costs.mjs'));
const recordModule = () => import(url('scripts/_shared/preflight-run-record.mjs'));
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const DAY = 86_400_000;
const at = (ms) => new Date(ms).toISOString();
const now = () => NOW;

/** A snapshot as the host writes it, `over` replacing what a case is about. */
const snapshot = (over = {}) => ({
  generatedAt: at(NOW - 3_600_000), window: 20, runner: 'container', runs: 7,
  stages: { alpha: { ran: 7, failed: 1, medianMs: 1500 }, beta: { ran: 7, failed: 0, medianMs: 40_000 } },
  ...over,
});

/** A scratch folder holding `text` as the snapshot, and what to read it with. */
async function withFile(text, fn) {
  const { STAGE_COSTS_FILE } = await costsModule();
  const dir = mkdtempSync(join(scratchRoot(), 'stage-costs-'));
  try {
    if (text !== null) writeFileSync(join(dir, STAGE_COSTS_FILE), text);
    return await fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What a reading must be, for a file it does not trust. */
async function assertRefused(text, label) {
  const { readStageCosts } = await costsModule();
  await withFile(text, (dir) => {
    let answer;
    assert.doesNotThrow(() => { answer = readStageCosts(dir, { now }); }, `${label}: the reader threw`);
    assert.equal(answer.costs, null, `${label}: the file was trusted`);
    assert.equal(typeof answer.why, 'string', `${label}: no reason given`);
    assert.ok(answer.why.length > 0, `${label}: an empty reason`);
  });
}

describe('readStageCosts never throws, and trusts only a fresh snapshot of the right shape', () => {
  it('reads a fresh snapshot back whole', async () => {
    const { readStageCosts } = await costsModule();
    await withFile(JSON.stringify(snapshot()), (dir) => {
      const answer = readStageCosts(dir, { now });
      assert.deepEqual(answer.costs, snapshot());
    });
  });

  it('reads one 13 days old and refuses one 15 days old, naming the age', async () => {
    const { readStageCosts } = await costsModule();
    await withFile(JSON.stringify(snapshot({ generatedAt: at(NOW - 13 * DAY) })), (dir) => {
      assert.notEqual(readStageCosts(dir, { now }).costs, null);
    });
    await withFile(JSON.stringify(snapshot({ generatedAt: at(NOW - 15 * DAY) })), (dir) => {
      const answer = readStageCosts(dir, { now });
      assert.equal(answer.costs, null);
      assert.match(answer.why, /stale/i);
      assert.match(answer.why, /15/);
    });
  });

  it('refuses a missing file, naming that there is none', async () => {
    const { readStageCosts } = await costsModule();
    await withFile(null, (dir) => {
      const answer = readStageCosts(dir, { now });
      assert.equal(answer.costs, null);
      assert.ok(answer.why.length > 0);
    });
    const answer = readStageCosts(join(scratchRoot(), 'no-such-folder-for-stage-costs'), { now });
    assert.equal(answer.costs, null, 'a folder that does not exist');
  });

  it('refuses a truncated file, an empty one and plain garbage', async () => {
    const whole = JSON.stringify(snapshot());
    await assertRefused(whole.slice(0, Math.floor(whole.length / 2)), 'truncated');
    await assertRefused('', 'empty');
    await assertRefused('this is not json at all', 'garbage');
    await assertRefused('\u0000\u0000\u0000', 'NUL bytes');
  });

  it('refuses JSON of a foreign shape: a list, another tool\'s object, rows that are not cost rows, a date that is no date', async () => {
    await assertRefused('[]', 'a list');
    await assertRefused('null', 'null');
    await assertRefused('"stage-costs"', 'a string');
    await assertRefused(JSON.stringify({ name: 'some-other-tool', version: 2 }), 'another tool\'s object');
    await assertRefused(JSON.stringify(snapshot({ stages: [] })), 'stages as a list');
    await assertRefused(JSON.stringify(snapshot({ stages: { alpha: 'fast' } })), 'a row that is a string');
    await assertRefused(JSON.stringify(snapshot({ stages: { alpha: { ran: 'many', failed: 0, medianMs: 5 } } })), 'a row whose count is a string');
    await assertRefused(JSON.stringify(snapshot({ stages: { alpha: { ran: 3, failed: 0, medianMs: -5 } } })), 'a negative time');
    await assertRefused(JSON.stringify(snapshot({ generatedAt: 'yesterday' })), 'a date that is no date');
    const { generatedAt: _gone, ...noDate } = snapshot();
    await assertRefused(JSON.stringify(noDate), 'no generatedAt');
  });

  it('refuses a snapshot with a __proto__ key among its stages, and pollutes nothing', async () => {
    const text = `{"generatedAt":"${at(NOW - 60_000)}","window":20,"runner":"host","runs":3,"stages":{"__proto__":{"ran":1,"failed":0,"medianMs":5},"alpha":{"ran":1,"failed":0,"medianMs":5}}}`;
    await assertRefused(text, '__proto__ key');
    assert.equal(({}).ran, undefined, 'Object.prototype carries a cost row field');
    assert.equal(({}).medianMs, undefined);
    const { readStageCosts } = await costsModule();
    const ctor = `{"generatedAt":"${at(NOW - 60_000)}","window":20,"runner":"host","runs":3,"stages":{"constructor":{"ran":1,"failed":0,"medianMs":5}}}`;
    await withFile(ctor, (dir) => {
      const { costs } = readStageCosts(dir, { now });
      if (costs !== null) assert.ok(Object.hasOwn(costs.stages, 'constructor'), 'a stage named constructor read as something else');
    });
  });

  it('is not misled by a stage name that exists on every object: a snapshot with no such stage gives no row for it', async () => {
    const { readStageCosts } = await costsModule();
    await withFile(JSON.stringify(snapshot()), (dir) => {
      const { costs } = readStageCosts(dir, { now });
      assert.equal(Object.hasOwn(costs.stages, 'toString'), false);
      assert.equal(Object.hasOwn(costs.stages, 'alpha'), true);
    });
  });
});

describe('writeStageCosts writes the file whole', () => {
  it('leaves the snapshot and no temporary file, and a second write replaces the first', async () => {
    const { writeStageCosts, readStageCosts } = await costsModule();
    const dir = mkdtempSync(join(scratchRoot(), 'stage-costs-write-'));
    try {
      writeStageCosts(dir, snapshot());
      writeStageCosts(dir, snapshot({ runs: 19, stages: { gamma: { ran: 19, failed: 2, medianMs: 321 } } }));
      assert.deepEqual(readdirSync(dir), ['stage-costs.json'], 'the write left something besides the snapshot');
      const { costs } = readStageCosts(dir, { now });
      assert.deepEqual(costs, snapshot({ runs: 19, stages: { gamma: { ran: 19, failed: 2, medianMs: 321 } } }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the file name is not one clearTimingResults(\'preflight\') removes, and a preflight-* file beside it is', async () => {
    const { writeStageCosts, STAGE_COSTS_FILE } = await costsModule();
    const { clearTimingResults } = await import(url('testing/_shared/timing-reporter-flags.mjs'));
    const dir = mkdtempSync(join(scratchRoot(), 'stage-costs-clear-'));
    try {
      writeStageCosts(dir, snapshot());
      writeFileSync(join(dir, 'preflight-pure-1.jsonl'), '{}\n');
      assert.equal(clearTimingResults('preflight', { dir }), 1);
      assert.deepEqual(readdirSync(dir), [STAGE_COSTS_FILE]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('test-times writes and refreshes the snapshot (a fake instance, a scratch repository)', () => {
  const st = (name, ms, outcome = 'passed') => ({ name, kind: 'source', ms, outcome });
  /** A Preflight-Run as the instance holds it. */
  const seedRun = (server, n, stages, runner) => {
    const startsAt = at(Date.parse('2026-11-16T10:00:00.000Z') + n * 60_000);
    return server.seed({
      type: 'Preflight-Run', title: `preflight run ${n}`, startsAt, endsAt: startsAt,
      properties: { recordKey: `local:h:${startsAt}:preflight`, formatVersion: 1, source: 'local', mode: 'full', commit: 'a'.repeat(40), branch: 'main', dirty: false, host: 'h', outcome: 'passed', wallMs: 1000, stageCount: stages.length, stages: JSON.stringify(stages), ...(runner ? { runner } : {}) },
    });
  };
  const readSnapshot = (dir) => JSON.parse(readFileSync(join(dir, 'test-results', 'stage-costs.json'), 'utf8'));
  const withInstance = async (fn) => {
    const server = await startFakeYthril();
    const work = makeWorkdir();
    try { return await fn({ server, work, env: { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token, RUNNER_HEAD: 'planted-head' } }); } finally { await server.close(); work.cleanup(); }
  };

  it('--preflight-costs writes the container runner\'s measurements: its rows only, filtered on the server, with the run count and the date', async () => {
    await withInstance(async ({ server, work, env }) => {
      for (let n = 1; n <= 5; n++) seedRun(server, n, [st('alpha', 1000 * n), st('beta', 50)], 'container');
      for (let n = 6; n <= 8; n++) seedRun(server, n, [st('alpha', 90_000), st('beta', 50)], 'host');
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const snap = readSnapshot(work.dir);
      assert.equal(snap.runner, 'container');
      assert.equal(snap.runs, 5);
      assert.equal(snap.window, 20);
      assert.deepEqual(snap.stages.alpha, { ran: 5, failed: 0, medianMs: 3000 });
      assert.ok(Math.abs(Date.parse(snap.generatedAt) - Date.now()) < 120_000, snap.generatedAt);
      const asked = server.callsTo('filter').map(c => JSON.stringify(c.args.filter));
      assert.ok(asked.some(f => /runner/.test(f) && /container/.test(f)), `no filter call asked for the runner:\n${asked.join('\n')}`);
      assert.deepEqual(readdirSync(join(work.dir, 'test-results')), ['stage-costs.json'], 'the write left a temporary file');
    });
  });

  it('--preflight-costs with fewer than 3 container rows takes the records that name no runner too (the older records)', async () => {
    await withInstance(async ({ server, work, env }) => {
      for (let n = 1; n <= 4; n++) seedRun(server, n, [st('alpha', 2000)], undefined);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const snap = readSnapshot(work.dir);
      assert.equal(snap.runs, 4);
      assert.equal(snap.stages.alpha.medianMs, 2000);
    });
  });

  it('--drain-unrecorded refreshes the snapshot after the drain: the spooled run is in the count, and an older snapshot is replaced', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    const { spoolPayload } = await import(url('scripts/_shared/unrecorded-spool.mjs'));
    await withInstance(async ({ server, work, env }) => {
      for (let n = 1; n <= 4; n++) seedRun(server, n, [st('alpha', 1000)], 'container');
      mkdirSync(join(work.dir, 'test-results'), { recursive: true });
      writeFileSync(join(work.dir, 'test-results', 'stage-costs.json'), JSON.stringify(snapshot({ generatedAt: at(Date.now() - 5 * DAY), runs: 1 })));
      const payload = buildPreflightRunPayload({
        stages: [st('alpha', 1000)], mode: 'full', startedAt: '2026-11-17T09:00:00.000Z', endedAt: '2026-11-17T09:00:01.000Z',
        commit: 'b'.repeat(40), branch: 'main', dirty: false, host: 'h', runner: 'container',
      });
      spoolPayload(join(work.dir, 'test-results', 'unrecorded'), payload);
      const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(readdirSync(join(work.dir, 'test-results', 'unrecorded')), [], 'the drain left the spooled record');
      const snap = readSnapshot(work.dir);
      assert.equal(snap.runs, 5, 'the snapshot does not count the record the drain just wrote');
      assert.ok(Date.now() - Date.parse(snap.generatedAt) < 120_000, `the old snapshot stayed: ${snap.generatedAt}`);
    });
  });

  it('--drain-unrecorded refreshes the snapshot also when nothing was spooled', async () => {
    await withInstance(async ({ server, work, env }) => {
      for (let n = 1; n <= 3; n++) seedRun(server, n, [st('alpha', 700)], 'container');
      const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.equal(readSnapshot(work.dir).runs, 3);
    });
  });

  it('a refresh that fails is one line and changes neither the exit status nor the drain', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    const { spoolPayload } = await import(url('scripts/_shared/unrecorded-spool.mjs'));
    await withInstance(async ({ server, work, env }) => {
      // The drain looks a record up by its key; the refresh asks for the runner's rows. Only the second is refused.
      server.respond = (call, body) => (call.tool === 'filter' && !JSON.stringify(body.filter ?? {}).includes('recordKey')
        ? { status: 500, body: { ok: false, error: 'the instance is busy', data: null } } : undefined);
      const payload = buildPreflightRunPayload({
        stages: [st('alpha', 1000)], mode: 'full', startedAt: '2026-11-17T09:00:00.000Z', endedAt: '2026-11-17T09:00:01.000Z',
        commit: 'b'.repeat(40), branch: 'main', dirty: false, host: 'h', runner: 'container',
      });
      spoolPayload(join(work.dir, 'test-results', 'unrecorded'), payload);
      const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(readdirSync(join(work.dir, 'test-results', 'unrecorded')), [], 'a failed refresh kept the spooled record');
      assert.equal(server.store.filter(e => e.type === 'Preflight-Run').length, 1, 'the drain did not write its record');
      assert.equal(existsSync(join(work.dir, 'test-results', 'stage-costs.json')), false, 'a snapshot was written from a refused read');
      const said = everything(r).split(/\r?\n/).filter(l => /cost/i.test(l));
      assert.equal(said.length, 1, `the failure is not one line about the costs:\n${everything(r)}`);
    });
  });
});
