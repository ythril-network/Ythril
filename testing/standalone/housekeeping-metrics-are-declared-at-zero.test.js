/**
 * The housekeeping counters exist before the first failure, and a signal moves exactly its own series (Q-274, Q-358, Q-359,
 * Q-317, bundle-53 G22).
 *
 * ## The four series and why each starts at 0
 *
 *   ythril_housekeeping_space_failures_total{step,kind}   kind: failure, timeout, store_down, stalled
 *   ythril_housekeeping_records_failed_total{step}        what a retention cycle could not delete (Q-359)
 *   ythril_interval_tick_skipped_total{job}               a repeating job that found its previous tick still running
 *   ythril_housekeeping_quarantined_spaces                spaces passed over right now (a gauge, so an absolute value)
 *
 * A counter that does not exist until its first event cannot be told from a counter that is not wired: `rate()` over a series
 * that appears at the first failure shows nothing for the whole healthy period, and an alert on it never evaluates until it is
 * too late. So every STEP a site has declared (`declareStep`, `util/housekeeping-signals.ts`) starts every series it can move
 * at 0, and so does every JOB (`declareJob`, which `intervalJob` calls at construction) for the skipped-tick series — the ones
 * declared before the registry was built, and the ones declared after. A step is not a job: no job series is invented for it.
 *
 * ## What this holds, and the shape of each case
 *
 *  - the series are there at 0 for EVERY declared step, derived from `declaredSteps()` and never listed (a floor guards the
 *    derivation: an empty set passes every loop written over it);
 *  - a signal moves exactly its own series by exactly its own amount, and nothing else (a snapshot diff of the whole scrape);
 *  - the gauge is POISONED before the step under test runs, so a subscription that does not write it fails the case — a reset
 *    would read 0 either way, and 0 is also the right answer after a recovery;
 *  - a count that is not a positive finite number never reaches a counter (prom-client throws on it, and a throw inside a
 *    listener must not become the failure being reported);
 *  - each name is a literal `name: 'ythril_...'` in `metrics/registry.ts`, because the docs-coverage gate reads that file only.
 *
 * Mutations seen red (restored by hand): drop the pre-declaration of one kind, drop the declaration made after the build, drop
 * the gauge write, drop the count guard.
 *
 * Run: node --test testing/standalone/housekeeping-metrics-are-declared-at-zero.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const signals = await import('../../server/dist/util/housekeeping-signals.js');

// One step and one job declared BEFORE the registry is built: they are read from `declaredSteps()` / `declaredJobs()` at build.
const BEFORE = signals.declareStep('G22 step declared before the registry');
const JOB_BEFORE = 'G22 job declared before the registry';
signals.declareJob(JOB_BEFORE);
const registry = await import('../../server/dist/metrics/registry.js');
// And one of each AFTER: they arrive as `step-declared` / `job-declared` signals.
const AFTER = signals.declareStep('G22 step declared after the registry');
const JOB_AFTER = 'G22 job declared after the registry';
signals.declareJob(JOB_AFTER);

const FAILURE = 'ythril_housekeeping_space_failures_total';
const RECORDS = 'ythril_housekeeping_records_failed_total';
const SKIPPED = 'ythril_interval_tick_skipped_total';
const QUARANTINED = 'ythril_housekeeping_quarantined_spaces';
const KINDS = ['failure', 'timeout', 'store_down', 'stalled'];

const SOURCE = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'server', 'src', 'metrics', 'registry.ts');

/** Every sample of one series name in a scrape, keyed by its labels in a stable spelling. */
function samples(text, name) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue;
    const m = /^[a-z_]+(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels = [...(m[1] ?? '').matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)].map(l => `${l[1]}=${l[2]}`).sort().join(',');
    out.set(labels, Number(m[2]));
  }
  return out;
}

/** The four housekeeping series of one scrape, flattened so two scrapes can be diffed. */
async function snapshot() {
  const text = await registry.register.metrics();
  const flat = new Map();
  for (const name of [FAILURE, RECORDS, SKIPPED, QUARANTINED]) {
    for (const [labels, value] of samples(text, name)) flat.set(`${name}{${labels}}`, value);
  }
  return flat;
}

/** Which series changed between two snapshots, and by how much: the whole answer to "did it move exactly its own". */
function moved(before, after) {
  const out = {};
  for (const [key, value] of after) {
    const was = before.get(key) ?? 0;
    if (value !== was) out[key] = value - was;
  }
  return out;
}

describe('the housekeeping counters are declared at zero', () => {
  it('derives its subjects from the declared steps, with a floor', () => {
    const steps = signals.declaredSteps();
    assert.ok(steps.includes(BEFORE) && steps.includes(AFTER), 'the two steps this file declared are not listed');
    assert.ok(steps.length >= 2, `only ${steps.length} declared steps: an empty derivation passes every loop over it`);
  });

  it('derives its jobs from the declared jobs, with a floor', () => {
    const jobs = signals.declaredJobs();
    assert.ok(jobs.includes(JOB_BEFORE) && jobs.includes(JOB_AFTER), 'the two jobs this file declared are not listed');
    assert.ok(jobs.length >= 2, `only ${jobs.length} declared jobs: an empty derivation passes every loop over it`);
  });

  it('holds the step series at 0 for every declared step, before and after the registry was built', async () => {
    const text = await registry.register.metrics();
    const failures = samples(text, FAILURE);
    const records = samples(text, RECORDS);
    for (const step of signals.declaredSteps()) {
      for (const kind of KINDS) {
        assert.equal(failures.get(`kind=${kind},step=${step}`), 0, `${FAILURE}{step="${step}",kind="${kind}"} is not at 0 on a scrape`);
      }
      assert.equal(records.get(`step=${step}`), 0, `${RECORDS}{step="${step}"} is not at 0 on a scrape`);
    }
    assert.equal(samples(text, QUARANTINED).get(''), 0, `${QUARANTINED} is not at 0 on a scrape`);
  });

  it('holds the skipped-tick series at 0 for every declared job, and invents none for a step that is not a job', async () => {
    const skipped = samples(await registry.register.metrics(), SKIPPED);
    for (const job of signals.declaredJobs()) {
      assert.equal(skipped.get(`job=${job}`), 0, `${SKIPPED}{job="${job}"} is not at 0 on a scrape`);
    }
    const jobs = new Set(signals.declaredJobs());
    for (const step of signals.declaredSteps().filter(s => !jobs.has(s))) {
      assert.ok(!skipped.has(`job=${step}`), `${SKIPPED}{job="${step}"} exists, but "${step}" is a step and no job of that name was declared`);
    }
  });

  it('the kinds it pre-declares are the kinds a signal can carry', () => {
    assert.deepEqual([...registry.HOUSEKEEPING_FAILURE_KINDS].sort(), [...KINDS].sort());
  });

  it('a space-failure signal moves exactly its (step, kind) series by one, whichever kind', async () => {
    for (const kind of KINDS) {
      const before = await snapshot();
      signals.signalHousekeeping({ type: 'space-failure', step: BEFORE, kind });
      const after = await snapshot();
      assert.deepEqual(moved(before, after), { [`${FAILURE}{kind=${kind},step=${BEFORE}}`]: 1 }, `kind ${kind}`);
    }
  });

  it('a records-failed signal adds its count to its step, and moves nothing else', async () => {
    const before = await snapshot();
    signals.signalHousekeeping({ type: 'records-failed', step: AFTER, count: 7 });
    const after = await snapshot();
    assert.deepEqual(moved(before, after), { [`${RECORDS}{step=${AFTER}}`]: 7 });
  });

  it('a tick-skipped signal moves its job, and a job nobody declared appears at its first skip', async () => {
    const before = await snapshot();
    signals.signalHousekeeping({ type: 'tick-skipped', job: JOB_BEFORE });
    signals.signalHousekeeping({ type: 'tick-skipped', job: 'a job nobody declared' });
    const after = await snapshot();
    assert.deepEqual(moved(before, after), {
      [`${SKIPPED}{job=${JOB_BEFORE}}`]: 1,
      [`${SKIPPED}{job=a job nobody declared}`]: 1,
    });
  });

  it('a failure of a step nobody declared still counts', async () => {
    const before = await snapshot();
    signals.signalHousekeeping({ type: 'space-failure', step: 'a step nobody declared', kind: 'failure' });
    const after = await snapshot();
    assert.deepEqual(moved(before, after), { [`${FAILURE}{kind=failure,step=a step nobody declared}`]: 1 });
  });

  it('the quarantine gauge is written by the signal, and is an absolute value (poisoned first, so a missing write is red)', async () => {
    const gauge = registry.housekeepingQuarantinedSpaces;
    for (const count of [3, 1, 0]) {
      gauge.set(999_999);
      signals.signalHousekeeping({ type: 'quarantined-spaces', count });
      assert.equal((await snapshot()).get(`${QUARANTINED}{}`), count, `the gauge read the poison, not ${count}: the signal did not write it`);
    }
  });

  it('a count that is not a positive finite number never reaches a counter, and never throws into the signaller', async () => {
    const before = await snapshot();
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '4', undefined, null]) {
      assert.doesNotThrow(() => signals.signalHousekeeping({ type: 'records-failed', step: BEFORE, count }), `count ${String(count)}`);
    }
    for (const count of [-3, Number.NaN, '2', undefined]) {
      assert.doesNotThrow(() => signals.signalHousekeeping({ type: 'quarantined-spaces', count }), `quarantined ${String(count)}`);
    }
    const after = await snapshot();
    assert.deepEqual(moved(before, after), {}, 'a malformed count moved a series');
    assert.equal(after.get(`${QUARANTINED}{}`), 0, 'a malformed quarantine count was written to the gauge');
  });

  it('names each metric as a literal in registry.ts (the docs-coverage gate reads that file only)', () => {
    const src = readFileSync(SOURCE, 'utf8');
    for (const name of [FAILURE, RECORDS, SKIPPED, QUARANTINED]) {
      assert.ok(src.includes(`name: '${name}'`), `${name} is not declared with a literal name: '...' in metrics/registry.ts`);
    }
  });
});
