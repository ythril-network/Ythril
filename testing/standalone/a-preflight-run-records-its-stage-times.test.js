/**
 * Every run of `scripts/preflight.mjs` records its stage times (Q-864).
 *
 * ## The defect this refuses
 *
 * CI runs are recorded per suite (`scripts/test-times.mjs`), a local preflight records nothing. The preflight's order is set from
 * measured cost (flow convention `convention-preflight-cheapest-first-and-parallel`), and there was nothing to measure it from:
 * which stage takes how long on a developer's machine, how that moves, which stage a run stopped at. A recorder that can break
 * the run it measures, or that quietly drops a record, is worse than none, so the same tests hold the other side too.
 *
 * ## What it asserts, each from where the answer comes from
 *
 * - The stage runner measures each stage itself (an injected clock, never output parsing): a stage's time runs from its `begin`
 *   to the next `begin` or `end`; a stage whose run added a failure is `failed`; the stages after the first failure are
 *   `not-run` with no time; `onStop` is handed the same list.
 * - The record: a `Preflight-Run` chrono entry, a type registered in `TELEMETRY_SPECS` (so the generic gate over every
 *   spec holds it), `recordKey` `local:<host>:<startedAt>:preflight`, one JSON string of the stages (a chrono property cannot be
 *   an array), `firstFailingStage` absent on a pass.
 * - A failed recording never fails or slows the run: `recordPreflightRun` spools the payload first, then drains it through
 *   `test-times --drain-unrecorded` under a time bound; an unset instance, a recorder that hangs and a folder that cannot be
 *   written each leave one line and never throw. A reachable instance gets the record once (a second drain upserts by key).
 * - The real `scripts/preflight.mjs`, run in a scratch folder whose CHANGELOG gate is planted to fail, exits 1 as before and
 *   leaves the spooled record naming that stage as first failing and every later stage as not run.
 * - The report prints each stage's time per run and the median per stage, from fixture records.
 *
 * Run: node --test testing/standalone/a-preflight-run-records-its-stage-times.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { makeWorkdir, runTimes, everything, cleanEnv } from '../_shared/test-times-harness.mjs';

const url = (p) => pathToFileURL(join(REPO_ROOT, p)).href;
/** Imported inside each test, so a base without the module fails each test for the missing module and not the whole file at load. */
const stagesModule = () => import(url('scripts/_shared/preflight-stages.mjs'));
const recordModule = () => import(url('scripts/_shared/preflight-run-record.mjs'));
const telemetryModule = () => import(url('scripts/_shared/telemetry-record.mjs'));
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };

const STAGES = [
  { name: 'cheap', kind: 'source' },
  { name: 'check-changelog', kind: 'source' },
  { name: 'build', kind: 'build' },
  { name: 'suite', kind: 'test' },
];

/** A clock that returns the next of `times` on each read, so a stage's time is exactly the gap the test wrote. */
const clockOf = (times) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };

describe('the stage runner measures each stage itself', () => {
  function drive({ failAt = null, times, stages = STAGES, isStatic = false }) {
    return stagesModule().then(({ createStageRunner }) => {
      const failures = [];
      const stop = new Error('stopped');
      let told;
      const runner = createStageRunner({ stages, failures, isStatic, now: clockOf(times), onStop: (s) => { told = s; throw stop; } });
      try {
        for (const s of stages.filter(x => !(isStatic && x.static === false))) {
          runner.begin(s.name);
          if (s.name === failAt) failures.push({ name: s.name, why: 'planted' });
        }
        runner.end();
      } catch (e) { if (e !== stop) throw e; }
      return { runner, told };
    });
  }

  it('a passing run: each stage runs from its begin to the next begin, the last to end()', async () => {
    // reads: begin x4 then end: 1000, 1100 (cheap = 100), 1350 (changelog = 250), 2350 (build = 1000), 5350 (suite = 3000) and the end read
    const { runner } = await drive({ times: [1000, 1100, 1350, 2350, 5350] });
    assert.deepEqual(runner.timings().map(({ name, kind, ms, outcome }) => ({ name, kind, ms, outcome })), [
      { name: 'cheap', kind: 'source', ms: 100, outcome: 'passed' },
      { name: 'check-changelog', kind: 'source', ms: 250, outcome: 'passed' },
      { name: 'build', kind: 'build', ms: 1000, outcome: 'passed' },
      { name: 'suite', kind: 'test', ms: 3000, outcome: 'passed' },
    ]);
  });

  it('a failing stage is failed with its own time; the stages after it are not-run with no time, and onStop is told the same list', async () => {
    const { runner, told } = await drive({ failAt: 'check-changelog', times: [1000, 1100, 1150] });
    const expected = [
      { name: 'cheap', kind: 'source', ms: 100, outcome: 'passed' },
      { name: 'check-changelog', kind: 'source', ms: 50, outcome: 'failed' },
      { name: 'build', kind: 'build', ms: 0, outcome: 'not-run' },
      { name: 'suite', kind: 'test', ms: 0, outcome: 'not-run' },
    ];
    const plain = (list) => list.map(({ name, kind, ms, outcome }) => ({ name, kind, ms, outcome }));
    assert.deepEqual(plain(runner.timings()), expected);
    assert.deepEqual(plain(told.stages), expected, 'onStop was not handed the stage times');
  });

  it('under --static the stages a static run leaves out are not part of the record at all', async () => {
    const stages = [...STAGES.slice(0, 2), { name: 'only-in-full', kind: 'test', static: false }, STAGES[3]];
    const { runner } = await drive({ stages, isStatic: true, times: [0, 10, 20, 30, 40] });
    assert.deepEqual(runner.timings().map(s => s.name), ['cheap', 'check-changelog', 'suite']);
  });
});

describe('the record is a Preflight-Run chrono entry', () => {
  const stages = [
    { name: 'cheap', kind: 'source', ms: 100, outcome: 'passed' },
    { name: 'check-changelog', kind: 'source', ms: 50, outcome: 'failed' },
    { name: 'build', kind: 'build', ms: 0, outcome: 'not-run' },
  ];
  const base = { stages, mode: 'full', startedAt: '2026-11-16T10:00:00.000Z', endedAt: '2026-11-16T10:00:00.150Z', commit: 'a'.repeat(40), branch: 'bundle-308', dirty: true, host: 'laptop' };

  it('is registered in TELEMETRY_SPECS under its own type, so the generic gate over every spec holds it', async () => {
    const { TELEMETRY_SPECS, telemetryTypeDeclaration } = await telemetryModule();
    const spec = TELEMETRY_SPECS.find(s => s.type === 'Preflight-Run');
    assert.ok(spec, 'no Preflight-Run spec is registered');
    assert.equal(spec.space, 'y-proj-ythril');
    const declared = telemetryTypeDeclaration(spec).typeSchemas.chrono['Preflight-Run'];
    assert.equal(declared.suppressEmbeddings, true);
    assert.ok(declared.propertySchemas.stages, 'the stages are not a declared property');
  });

  it('carries the key, the identity, the verdict and the stages as one JSON string, and conforms to its spec', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    const { TELEMETRY_SPECS, checkTelemetryProperties } = await telemetryModule();
    const payload = buildPreflightRunPayload(base);
    assert.equal(payload.type, 'Preflight-Run');
    assert.equal(payload.space, 'y-proj-ythril');
    const p = checkTelemetryProperties(TELEMETRY_SPECS.find(s => s.type === 'Preflight-Run'), payload.properties);
    assert.equal(p.recordKey, 'local:laptop:2026-11-16T10:00:00.000Z:preflight');
    assert.deepEqual({ source: p.source, mode: p.mode, outcome: p.outcome, dirty: p.dirty, host: p.host, branch: p.branch, commit: p.commit },
      { source: 'local', mode: 'full', outcome: 'failed', dirty: true, host: 'laptop', branch: 'bundle-308', commit: 'a'.repeat(40) });
    assert.equal(p.firstFailingStage, 'check-changelog');
    assert.equal(p.wallMs, 150);
    assert.deepEqual(JSON.parse(p.stages), stages);
    assert.equal(payload.startsAt, base.startedAt);
    assert.equal(payload.endsAt, base.endedAt);
  });

  it('a passing run has outcome passed and no firstFailingStage (an optional field is absent, never an empty string)', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    const passed = buildPreflightRunPayload({ ...base, mode: 'static', stages: stages.slice(0, 1) });
    assert.equal(passed.properties.outcome, 'passed');
    assert.equal(passed.properties.mode, 'static');
    assert.equal('firstFailingStage' in passed.properties, false);
  });

  it('refuses a stage that is not named, a kind it does not know and a mode that is neither full nor static', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    assert.throws(() => buildPreflightRunPayload({ ...base, mode: 'quick' }), /mode/);
    assert.throws(() => buildPreflightRunPayload({ ...base, stages: [{ name: '', kind: 'source', ms: 1, outcome: 'passed' }] }), /stage/);
    assert.throws(() => buildPreflightRunPayload({ ...base, stages: [{ name: 'x', kind: 'source', ms: 1, outcome: 'maybe' }] }), /outcome/);
  });
});

describe('a failed recording never fails or slows the run', () => {
  const payloadOf = async () => {
    const { buildPreflightRunPayload } = await recordModule();
    return buildPreflightRunPayload({
      stages: [{ name: 'cheap', kind: 'source', ms: 5, outcome: 'passed' }], mode: 'static',
      startedAt: '2026-11-16T10:00:00.000Z', endedAt: '2026-11-16T10:00:00.005Z', commit: 'b'.repeat(40), branch: 'main', dirty: false, host: 'h',
    });
  };
  const kept = (dir) => (existsSync(join(dir, 'test-results', 'unrecorded')) ? readdirSync(join(dir, 'test-results', 'unrecorded')).filter(f => f.endsWith('.json')) : []);

  it('with no instance configured the payload stays in test-results/unrecorded and one line says why', async () => {
    const { recordPreflightRun } = await recordModule();
    const work = makeWorkdir();
    try {
      const line = await recordPreflightRun(await payloadOf(), { cwd: work.dir, env: cleanEnv() });
      assert.equal(kept(work.dir).length, 1, `nothing was kept; the line said: ${line}`);
      assert.match(line, /^preflight: .*not recorded/, line);
      assert.equal(line.includes('\n'), false, 'one line');
    } finally { work.cleanup(); }
  });

  it('a recorder that never answers is cut off at the bound, the payload is kept, and the call returns', async () => {
    const { recordPreflightRun } = await recordModule();
    const work = makeWorkdir();
    const scratch = mkdtempSync(join(scratchRoot(), 'preflight-hang-'));
    try {
      const hang = join(scratch, 'hang.mjs');
      writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
      const t0 = Date.now();
      const line = await recordPreflightRun(await payloadOf(), { cwd: work.dir, env: cleanEnv(), script: hang, timeoutMs: 1500 });
      assert.ok(Date.now() - t0 < 10_000, `the call took ${Date.now() - t0} ms, past its 1500 ms bound`);
      assert.equal(kept(work.dir).length, 1, 'the payload was not kept when the recorder was cut off');
      assert.match(line, /^preflight: .*not recorded/, line);
    } finally { work.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  it('a folder that cannot be written is a line, never a throw', async () => {
    const { recordPreflightRun } = await recordModule();
    const scratch = mkdtempSync(join(scratchRoot(), 'preflight-nowrite-'));
    try {
      const file = join(scratch, 'a-file-not-a-folder');
      writeFileSync(file, 'x');
      const line = await recordPreflightRun(await payloadOf(), { cwd: file, env: cleanEnv() });
      assert.match(line, /^preflight: .*not recorded/, line);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it('a reachable instance gets the record once, the spool file is gone, and the same key written again replaces it', async () => {
    // The recorder runs as an ASYNC child here: recordPreflightRun waits for its child synchronously (the preflight has nothing else
    // to do), which would stop this process from answering the fake instance it is talking to.
    const { spoolPayload } = await import(url('scripts/_shared/unrecorded-spool.mjs'));
    const server = await startFakeYthril();
    const work = makeWorkdir();
    try {
      const env = { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token };
      const payload = await payloadOf();
      for (const round of [1, 2]) {
        spoolPayload(join(work.dir, 'test-results', 'unrecorded'), payload);
        const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir, env });
        assert.equal(r.code, 0, `round ${round}: ${everything(r)}`);
        assert.deepEqual(kept(work.dir), [], `round ${round}: a recorded payload is left in the spool`);
      }
      const held = server.store.filter(e => e.type === 'Preflight-Run');
      assert.equal(held.length, 1, 'one key is one record');
      assert.equal(held[0].properties.recordKey, payload.properties.recordKey);
      assert.equal(held[0].properties.mode, 'static');
    } finally { await server.close(); work.cleanup(); }
  });
});

describe('test-times --drain-unrecorded', () => {
  it('says the instance is unset in one line, keeps the file and exits 0', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    const { spoolPayload } = await import(url('scripts/_shared/unrecorded-spool.mjs'));
    const work = makeWorkdir();
    try {
      const payload = buildPreflightRunPayload({
        stages: [{ name: 'cheap', kind: 'source', ms: 5, outcome: 'passed' }], mode: 'full',
        startedAt: '2026-11-16T11:00:00.000Z', endedAt: '2026-11-16T11:00:00.005Z', commit: 'c'.repeat(40), branch: 'main', dirty: false, host: 'h',
      });
      spoolPayload(join(work.dir, 'test-results', 'unrecorded'), payload);
      const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir });
      assert.equal(r.code, 0, everything(r));
      assert.match(everything(r), /test-times: not recorded: YTHRIL_TEST_RUNS_URL unset/, everything(r));
      assert.equal(readdirSync(join(work.dir, 'test-results', 'unrecorded')).length, 1);
    } finally { work.cleanup(); }
  });
});

describe('the real preflight leaves its record, and its exit status is the one it had', () => {
  const PREFLIGHT = join(REPO_ROOT, 'scripts/preflight.mjs');

  /** preflight.mjs in a scratch folder whose CHANGELOG gate is planted to fail; returns its status and the spooled records. */
  function planted(args) {
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-record-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts/unregistered-local-files.mjs'), 'process.exit(0);\n');
      writeFileSync(join(dir, 'scripts/check-changelog.mjs'), "console.log('planted: no [Unreleased] line'); process.exit(1);\n");
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'planted', private: true, type: 'module', scripts: {} }));
      const r = spawnSync(process.execPath, [PREFLIGHT, ...args], { cwd: dir, encoding: 'utf8', env: testChildEnv(), timeout: 90_000 });
      const folder = join(dir, 'test-results', 'unrecorded');
      const records = existsSync(folder) ? readdirSync(folder).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(folder, f), 'utf8'))) : [];
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, records };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  for (const [label, args, mode] of [['full', [], 'full'], ['static', ['--static'], 'static']]) {
    it(`${label}: exits 1 at the planted gate and spools one Preflight-Run naming it first failing, the later stages not run`, async () => {
      const { PREFLIGHT_STAGES } = await stagesModule();
      const r = planted(args);
      assert.equal(r.status, 1, r.out.slice(-1500));
      assert.equal(r.records.length, 1, `no record was spooled:\n${r.out.slice(-1500)}`);
      const [rec] = r.records;
      assert.equal(rec.type, 'Preflight-Run');
      assert.equal(rec.properties.mode, mode);
      assert.equal(rec.properties.outcome, 'failed');
      assert.equal(rec.properties.firstFailingStage, 'check-changelog');
      const stages = JSON.parse(rec.properties.stages);
      const planned = PREFLIGHT_STAGES.filter(s => !(mode === 'static' && s.static === false)).map(s => s.name);
      assert.deepEqual(stages.map(s => s.name), planned, 'the record lists a different set of stages than the run planned');
      assert.deepEqual(stages.filter(s => s.outcome !== 'not-run').map(s => `${s.name}:${s.outcome}`), ['unregistered-local-files:passed', 'check-changelog:failed']);
      assert.ok(stages.filter(s => s.outcome === 'not-run').every(s => s.ms === 0));
      assert.match(r.out, /^preflight: .*not recorded/m, 'the run did not say in one line that it kept the record');
    });
  }
});

describe('scripts/preflight.mjs ends every run through the recording (the real file, read as text)', () => {
  it('has one process.exit that is not the usage refusal, and the recording is called before it', () => {
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts/preflight.mjs'), 'utf8'));
    const exits = [...src.matchAll(/process\.exit\(\s*(?!2\s*\))[^)]*\)/g)];
    assert.equal(exits.length, 1, `process.exit appears ${exits.length} times besides the usage refusal: a second exit is a way out that records nothing`);
    const before = src.slice(0, exits[0].index);
    assert.match(before, /recordPreflightRun\(/, 'the recording is not called before the one exit');
  });
});

describe('the report prints each stage per run and the median per stage', () => {
  const row = (n, mode, stages, startsAt) => ({
    _id: `id${n}`, type: 'Preflight-Run', startsAt,
    properties: { recordKey: `local:h:${startsAt}:preflight`, mode, outcome: stages.some(s => s.outcome === 'failed') ? 'failed' : 'passed', commit: String(n).repeat(40).slice(0, 40), wallMs: stages.reduce((a, s) => a + s.ms, 0), stages: JSON.stringify(stages), formatVersion: 1 },
  });
  const S = (name, ms, outcome = 'passed') => ({ name, kind: 'source', ms, outcome });
  const rows = [
    row(3, 'full', [S('alpha', 30000), S('beta', 900000)], '2026-11-16T12:00:00.000Z'),
    row(2, 'full', [S('alpha', 10000), S('beta', 600000)], '2026-11-16T11:00:00.000Z'),
    row(1, 'static', [S('alpha', 20000), S('beta', 0, 'failed'), S('gamma', 0, 'not-run')], '2026-11-16T10:00:00.000Z'),
  ];

  it('one row per stage with its time in every run (a not-run stage is a dash) and its median over the runs that ran it', async () => {
    const { preflightTrendLines } = await recordModule();
    const text = preflightTrendLines(rows).join('\n');
    const line = (name) => text.split('\n').find(l => new RegExp(`^\\s*${name}\\b`).test(l)) ?? `(no line for ${name})\n${text}`;
    // alpha passed in all three runs: 20 s, 10 s, 30 s (oldest run first); the median is 20 s
    assert.match(line('alpha'), /median 20\.0 s/);
    assert.match(line('alpha'), /20\.0 s\s+10\.0 s\s+30\.0 s/, 'the times are listed oldest run first');
    // beta passed twice (600 s, 900 s: the median of an even count is their mean) and failed once: a failed stage has no comparable time
    assert.match(line('beta'), /median 750\.0 s/);
    assert.match(line('beta'), /failed/);
    // gamma never ran: a dash in its run, no median
    assert.match(line('gamma'), /median -/);
  });

  it('prints the wall time of each run and the median wall time per mode', async () => {
    const { preflightTrendLines } = await recordModule();
    const lines = preflightTrendLines(rows);
    const text = lines.join('\n');
    assert.match(text, /wall/i);
    assert.match(text, /full[^\n]*median[^\n]*/i, text);
    assert.match(text, /static[^\n]*median[^\n]*/i, text);
  });

  it('skips a record it cannot read (stages that are not JSON, or of an unknown shape) and says how many', async () => {
    const { preflightTrendLines } = await recordModule();
    const bad = { _id: 'x', type: 'Preflight-Run', startsAt: '2026-11-16T09:00:00.000Z', properties: { recordKey: 'k', mode: 'full', stages: 'not json' } };
    const text = preflightTrendLines([...rows, bad]).join('\n');
    assert.match(text, /skipped 1 record/i, text);
    assert.match(text, /alpha/);
  });

  it('says there are no runs when there are none', async () => {
    const { preflightTrendLines } = await recordModule();
    assert.match(preflightTrendLines([]).join('\n'), /no recorded preflight runs/i);
  });
});
