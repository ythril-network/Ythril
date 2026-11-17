/**
 * The cost a stage is planned by is measured from the recorded `Preflight-Run` records of ONE runner, over the newest runs, and a
 * record says which runner wrote it (Q-865).
 *
 * ## The defect this refuses
 *
 * A plan computed from every record mixes a container's times with a laptop's (several-fold apart), runs from before a speed-up with
 * runs after it, and counts a stage that a failure never let run as if it had run. `stageStats`
 * (`scripts/_shared/preflight-run-record.mjs`) is the one reading: the rows of one runner, the newest `window`, per stage how many
 * runs ran it, how many of those failed, and the median time. The record names its runner so the rows can be told apart.
 *
 * ## What it asserts
 *
 * - The median is over the runs where the stage PASSED; a failed run's time is not in it; failed runs are counted.
 * - A stage a run never reached (`not-run`) is not a run of it. A stage with no passed run takes the median of its failed runs.
 * - Only the newest `window` rows count, whatever order they come in.
 * - Only the runner's rows count; a row that names no runner counts only while fewer than 3 rows carry the runner (the records written
 *   before the field existed, or a runner not yet measured).
 * - A row whose stages cannot be read is skipped, never counted as a run.
 * - `preflightRunIdentity` says `container` when `RUNNER_HEAD` is set (the runner sets it) and `host` otherwise; the record carries
 *   it (optional, declared in `PREFLIGHT_RUN_SCHEMA`, so a record written before it still validates).
 *
 * Run: node --test testing/standalone/the-stage-costs-come-from-the-recorded-runs-of-one-runner.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';

const url = (p) => pathToFileURL(join(REPO_ROOT, p)).href;
/** Imported inside each case, so a base without the export fails each case by name and not the whole file at load. */
const recordModule = () => import(url('scripts/_shared/preflight-run-record.mjs'));
const telemetryModule = () => import(url('scripts/_shared/telemetry-record.mjs'));
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };

/** One stage of a recorded run. */
const st = (name, ms, outcome = 'passed') => ({ name, kind: 'source', ms, outcome });

/** A recorded run: `n` orders runs in time (higher is newer); `runner` undefined leaves the property out, as an old record is. */
function row(n, stages, { runner, mode = 'full' } = {}) {
  const startsAt = new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();
  return {
    _id: `run-${n}`, type: 'Preflight-Run', startsAt,
    properties: {
      recordKey: `local:h:${startsAt}:preflight`, formatVersion: 1, mode, commit: String(n % 10).repeat(40),
      outcome: stages.some(s => s.outcome === 'failed') ? 'failed' : 'passed', wallMs: stages.reduce((a, s) => a + s.ms, 0),
      stages: JSON.stringify(stages), ...(runner === undefined ? {} : { runner }),
    },
  };
}

describe('stageStats: per stage, over the runs that ran it', () => {
  it('takes the median over the PASSED runs, counts the failed ones, and leaves a failed run\'s time out of the median', async () => {
    const { stageStats } = await recordModule();
    const rows = [
      row(1, [st('alpha', 10_000)], { runner: 'container' }),
      row(2, [st('alpha', 60_000)], { runner: 'container' }),
      row(3, [st('alpha', 5, 'failed')], { runner: 'container' }),
      row(4, [st('alpha', 20_000)], { runner: 'container' }),
    ];
    const out = stageStats(rows, { runner: 'container' });
    assert.equal(out.runs, 4);
    assert.deepEqual(out.stages.alpha, { ran: 4, failed: 1, medianMs: 20_000 });
  });

  it('takes the mean of the two middle times for an even count of passed runs', async () => {
    const { stageStats } = await recordModule();
    const rows = [row(1, [st('alpha', 10_000)], { runner: 'host' }), row(2, [st('alpha', 30_000)], { runner: 'host' })];
    assert.equal(stageStats(rows, { runner: 'host' }).stages.alpha.medianMs, 20_000);
  });

  it('does not count a stage a run never reached (not-run) as a run of it', async () => {
    const { stageStats } = await recordModule();
    const rows = [
      row(1, [st('alpha', 100), st('gamma', 4000)], { runner: 'container' }),
      row(2, [st('alpha', 120, 'failed'), st('gamma', 0, 'not-run')], { runner: 'container' }),
      row(3, [st('alpha', 110), st('gamma', 2000)], { runner: 'container' }),
      row(4, [st('alpha', 0, 'not-run'), st('zeta', 0, 'not-run')], { runner: 'container' }),
    ];
    const out = stageStats(rows, { runner: 'container' });
    assert.deepEqual(out.stages.gamma, { ran: 2, failed: 0, medianMs: 3000 });
    assert.deepEqual(out.stages.alpha, { ran: 3, failed: 1, medianMs: 105 }, 'median of the two passed runs, 3 runs counted');
    assert.ok(out.stages.zeta === undefined || out.stages.zeta.ran === 0, 'a stage no run reached was given a measurement');
  });

  it('gives a stage with no passed run in the window the median of its failed runs, so its cost is finite', async () => {
    const { stageStats } = await recordModule();
    const rows = [
      row(1, [st('delta', 4000, 'failed')], { runner: 'container' }),
      row(2, [st('delta', 8000, 'failed')], { runner: 'container' }),
    ];
    assert.deepEqual(stageStats(rows, { runner: 'container' }).stages.delta, { ran: 2, failed: 2, medianMs: 6000 });
  });

  it('counts only the newest `window` rows, 20 by default, whatever order the rows arrive in', async () => {
    const { stageStats } = await recordModule();
    const old = Array.from({ length: 5 }, (_, i) => row(i + 1, [st('alpha', 999_999)], { runner: 'container' }));
    const fresh = Array.from({ length: 20 }, (_, i) => row(i + 10, [st('alpha', 1000)], { runner: 'container' }));
    const shuffled = [...fresh.slice(10), ...old, ...fresh.slice(0, 10)];
    const out = stageStats(shuffled, { runner: 'container' });
    assert.equal(out.runs, 20);
    assert.deepEqual(out.stages.alpha, { ran: 20, failed: 0, medianMs: 1000 });
    const three = stageStats(shuffled, { runner: 'container', window: 3 });
    assert.equal(three.runs, 3);
    assert.equal(three.stages.alpha.ran, 3);
  });

  it('skips a row whose stages cannot be read (not JSON, not a list, no properties) and does not count it as a run', async () => {
    const { stageStats } = await recordModule();
    const good = [row(1, [st('alpha', 10)], { runner: 'container' }), row(3, [st('alpha', 30)], { runner: 'container' })];
    const garbage = [
      { ...row(2, [], { runner: 'container' }), properties: { mode: 'full', runner: 'container', stages: 'not json' } },
      { ...row(4, [], { runner: 'container' }), properties: { mode: 'full', runner: 'container', stages: '{"a":1}' } },
      { _id: 'x', type: 'Preflight-Run', startsAt: '2026-11-02T00:00:00.000Z' },
      { ...row(5, [], { runner: 'container' }), properties: { mode: 'full', runner: 'container', stages: JSON.stringify([{ name: 'alpha', ms: 'slow', outcome: 'passed' }]) } },
    ];
    const out = stageStats([...good, ...garbage], { runner: 'container' });
    assert.equal(out.runs, 2);
    assert.deepEqual(out.stages.alpha, { ran: 2, failed: 0, medianMs: 20 });
  });

  it('says no runs and no stages for no rows', async () => {
    const { stageStats } = await recordModule();
    assert.deepEqual(stageStats([], { runner: 'container' }), { runs: 0, stages: {} });
  });
});

describe('stageStats: one runner\'s rows', () => {
  const mixed = () => [
    ...Array.from({ length: 4 }, (_, i) => row(i + 1, [st('alpha', 1000)], { runner: 'container' })),
    ...Array.from({ length: 4 }, (_, i) => row(i + 10, [st('alpha', 9000)], { runner: 'host' })),
  ];

  it('counts a runner\'s rows only: the container\'s times are not pulled up by the host\'s, nor the host\'s down', async () => {
    const { stageStats } = await recordModule();
    const c = stageStats(mixed(), { runner: 'container' });
    const h = stageStats(mixed(), { runner: 'host' });
    assert.deepEqual([c.runs, c.stages.alpha.medianMs], [4, 1000]);
    assert.deepEqual([h.runs, h.stages.alpha.medianMs], [4, 9000]);
  });

  it('takes the runner\'s own rows alone once 3 rows carry it, the records without a runner left out', async () => {
    const { stageStats } = await recordModule();
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row(i + 1, [st('alpha', 1000)], { runner: 'container' })),
      ...Array.from({ length: 5 }, (_, i) => row(i + 10, [st('alpha', 5000)])),
    ];
    const out = stageStats(rows, { runner: 'container' });
    assert.equal(out.runs, 3);
    assert.equal(out.stages.alpha.medianMs, 1000);
  });

  it('adds the records without a runner while fewer than 3 rows carry it, and never another runner\'s', async () => {
    const { stageStats } = await recordModule();
    const rows = [
      ...Array.from({ length: 2 }, (_, i) => row(i + 1, [st('alpha', 1000)], { runner: 'container' })),
      ...Array.from({ length: 4 }, (_, i) => row(i + 10, [st('alpha', 5000)])),
      ...Array.from({ length: 3 }, (_, i) => row(i + 20, [st('alpha', 90_000)], { runner: 'host' })),
    ];
    const out = stageStats(rows, { runner: 'container' });
    assert.equal(out.runs, 6, 'the 2 container rows and the 4 that name no runner');
    assert.equal(out.stages.alpha.medianMs, 5000, 'the host rows (90 000) are in the figure');
  });

  it('applies the window to the runner\'s rows, so another runner\'s newer rows do not push them out of it', async () => {
    const { stageStats } = await recordModule();
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row(i + 1, [st('alpha', 1000)], { runner: 'container' })),
      ...Array.from({ length: 25 }, (_, i) => row(i + 10, [st('alpha', 9000)], { runner: 'host' })),
    ];
    const out = stageStats(rows, { runner: 'container', window: 20 });
    assert.deepEqual([out.runs, out.stages.alpha.medianMs], [3, 1000]);
  });
});

describe('the record names its runner', () => {
  it('preflightRunIdentity says container when RUNNER_HEAD is set (the runner sets it), host when it is not', async () => {
    const { preflightRunIdentity } = await recordModule();
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-identity-'));
    try {
      assert.equal(preflightRunIdentity(dir, { RUNNER_HEAD: '0123abc' }).runner, 'container');
      assert.equal(preflightRunIdentity(dir, {}).runner, 'host');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const base = {
    stages: [{ name: 'cheap', kind: 'source', ms: 5, outcome: 'passed' }], mode: 'full',
    startedAt: '2026-11-16T10:00:00.000Z', endedAt: '2026-11-16T10:00:00.005Z', commit: 'a'.repeat(40), branch: 'main', dirty: false, host: 'h',
  };

  it('carries the runner in its properties, and a record without one is still valid (the field is optional)', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    assert.equal(buildPreflightRunPayload({ ...base, runner: 'container' }).properties.runner, 'container');
    assert.equal(buildPreflightRunPayload({ ...base, runner: 'host' }).properties.runner, 'host');
    const without = buildPreflightRunPayload(base);
    assert.equal('runner' in without.properties, false, 'an absent runner is written as a key');
  });

  it('refuses a runner that is neither container nor host', async () => {
    const { buildPreflightRunPayload } = await recordModule();
    assert.throws(() => buildPreflightRunPayload({ ...base, runner: 'laptop' }), /runner/);
  });

  it('declares the runner in PREFLIGHT_RUN_SCHEMA, optional, and in the type declaration the instance is given', async () => {
    const { PREFLIGHT_RUN_SCHEMA, PREFLIGHT_RUN_SPEC, telemetryTypeDeclaration } = await telemetryModule();
    assert.ok(PREFLIGHT_RUN_SCHEMA.runner, 'PREFLIGHT_RUN_SCHEMA has no runner');
    assert.notEqual(PREFLIGHT_RUN_SCHEMA.runner.required, true, 'a required runner would refuse every record written before it existed');
    assert.deepEqual([...PREFLIGHT_RUN_SCHEMA.runner.values].sort(), ['container', 'host']);
    const declared = telemetryTypeDeclaration(PREFLIGHT_RUN_SPEC).typeSchemas.chrono['Preflight-Run'];
    assert.ok(declared.propertySchemas.runner, 'the declaration sent to the instance has no runner property');
  });
});
