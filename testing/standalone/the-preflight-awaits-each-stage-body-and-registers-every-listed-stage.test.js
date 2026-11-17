/**
 * The preflight runs the stage bodies the script registered through `runStages`: one at a time, each awaited, every listed stage
 * registered, and a stage that fails stops the run at that stage (Q-865).
 *
 * ## The defect this refuses
 *
 * Three ways a computed order goes wrong silently.
 *
 * - **A stage nobody registered, or a body for no stage.** The order is computed from the stage list; the code that runs a stage is a
 *   separate registration. A listed stage with no body would be planned and never run (a gate that stopped running), a body with no
 *   stage never planned. `runStages` compares the two sets both ways BEFORE any body runs and names the difference.
 * - **An async body charged to the next stage.** The runner reads a stage's failures when the next one begins; a body that is
 *   `async` and fails after a tick, not awaited, is charged to the stage that started after it, and the run stops one stage late.
 *   `runStages` awaits each body.
 * - **A rejection that ends the process.** A body that rejects (a thrown error in a stage) is a failure of THAT stage, with the first
 *   line of its message, and the next stage never begins.
 *
 * The runner's own order checks follow the plan it is given: no stage before a stage it needs that is in the plan, kinds never
 * descending, no name twice.
 *
 * Bodies are a `Map` of stage name to function, as `runStages(plan, bodies, runner)` takes them.
 *
 * Run: node --test testing/standalone/the-preflight-awaits-each-stage-body-and-registers-every-listed-stage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { elapse } from '../_shared/sleep.mjs';

const STAGES_MODULE = pathToFileURL(join(REPO_ROOT, 'scripts/_shared/preflight-stages.mjs')).href;
/** Imported inside each case, so a base without the export fails each case by name and not the whole file at load. */
const stagesModule = () => import(STAGES_MODULE);

const STOP = new Error('stopped by onStop');

/**
 * The real list planned in list order, a body for every stage that records its start and its end, and the runner a
 * run builds. `bodyFor(name)` replaces a stage's body; `override` adds or drops registered names.
 */
async function setup({ bodyFor = () => null, isStatic = false, add = [], drop = [] } = {}) {
  const { PREFLIGHT_STAGES, planStages, createStageRunner, runStages } = await stagesModule();
  const plan = planStages(PREFLIGHT_STAGES, null, { static: isStatic });
  const started = [];
  const finished = [];
  const failures = [];
  let told;
  const runner = createStageRunner({ failures, isStatic, stages: plan, onStop: (s) => { told = s; throw STOP; } });
  const bodies = new Map();
  for (const name of [...PREFLIGHT_STAGES.map(s => s.name).filter(n => !drop.includes(n)), ...add]) {
    const inner = bodyFor(name, { failures }) ?? (async () => {});
    bodies.set(name, async (...args) => { started.push(name); try { return await inner(...args); } finally { finished.push(name); } });
  }
  /** Runs the plan; an onStop that throws is the run ending, not a failure of the test. */
  const run = async () => {
    try { await runStages(plan, bodies, runner); runner.end(); } catch (e) { if (e !== STOP) throw e; }
  };
  return { plan, started, finished, failures, runner, bodies, run, told: () => told };
}

const plain = (list) => list.map(({ name, outcome }) => ({ name, outcome }));

describe('runStages refuses a body set that is not the stage list, before any body runs', () => {
  it('runs every body of the plan, in the plan\'s order, when the registered names are the list\'s names', async () => {
    const { plan, started, run, failures } = await setup();
    await run();
    assert.deepEqual(started, plan.map(s => s.name));
    assert.deepEqual(failures, []);
  });

  it('refuses a planted extra name (a body for a stage the list does not have), naming it, and starts no body', async () => {
    const { plan, started, run } = await setup({ add: ['planted-extra-stage'] });
    assert.ok(plan.length > 0);
    await assert.rejects(run, (e) => String(e.message).includes('planted-extra-stage'));
    assert.deepEqual(started, [], 'a body ran before the registration was checked');
  });

  it('refuses a planted missing name (a listed stage with no body), naming it, and starts no body', async () => {
    const { started, run } = await setup({ drop: ['lint:docs'] });
    await assert.rejects(run, (e) => String(e.message).includes('lint:docs'));
    assert.deepEqual(started, [], 'a body ran before the registration was checked');
  });

  it('holds the registration to the FULL list also under --static: the stages a static run leaves out still need their bodies', async () => {
    const full = await setup({ isStatic: true });
    await full.run();
    assert.ok(full.started.length > 0 && !full.started.includes('build:prod'), 'a static run started a stage it leaves out');
    const missing = await setup({ isStatic: true, drop: ['build:prod'] });
    await assert.rejects(missing.run, (e) => String(e.message).includes('build:prod'), 'a body missing for a stage only the full run runs was not refused');
    assert.deepEqual(missing.started, []);
  });
});

describe('runStages awaits each body, and a failure stops the run at the stage that failed', () => {
  const FAILING = 'lint:docs';

  /** The stage the failing one is followed by in the plan, and every stage after it. */
  const after = (plan, name) => plan.slice(plan.findIndex(s => s.name === name) + 1).map(s => s.name);

  it('an async body that fails after a tick: the failure is that stage\'s, and the next stage never begins', async () => {
    const t = await setup({
      bodyFor: (name, { failures }) => (name === FAILING ? async () => { await elapse(5, 'simulated latency: the stage body fails after a tick'); failures.push({ name: FAILING, why: 'planted: failed after a tick' }); } : null),
    });
    await t.run();
    const next = after(t.plan, FAILING);
    assert.ok(next.length > 0);
    assert.deepEqual(t.started.slice(-1), [FAILING], `the run went on past the failing stage: ${t.started.slice(-3).join(', ')}`);
    assert.equal(t.started.some(n => next.includes(n)), false, 'a stage began after the failing one');
    const timings = plain(t.runner.timings());
    assert.deepEqual(timings.filter(s => s.outcome === 'failed'), [{ name: FAILING, outcome: 'failed' }], 'the failure is charged to another stage');
    assert.ok(timings.filter(s => next.includes(s.name)).every(s => s.outcome === 'not-run'));
    assert.deepEqual(t.told().notRun, next, 'onStop was not told the stages that did not run');
  });

  it('a body that rejects: the failure is that stage\'s, with the first line of the message, and the next stage never begins', async () => {
    const t = await setup({ bodyFor: (name) => (name === FAILING ? async () => { await elapse(5, 'simulated latency: the stage body fails after a tick'); throw new Error('planted rejection\nsecond line, not reported'); } : null) });
    await t.run();
    assert.deepEqual(t.failures, [{ name: FAILING, why: 'planted rejection' }]);
    const next = after(t.plan, FAILING);
    assert.equal(t.started.some(n => next.includes(n)), false, 'a stage began after the one that rejected');
    assert.deepEqual(plain(t.runner.timings()).filter(s => s.outcome === 'failed'), [{ name: FAILING, outcome: 'failed' }]);
  });

  it('a body that throws without being async is a failure of its stage too', async () => {
    const t = await setup({ bodyFor: (name) => (name === FAILING ? () => { throw new Error('planted synchronous throw'); } : null) });
    await t.run();
    assert.deepEqual(t.failures, [{ name: FAILING, why: 'planted synchronous throw' }]);
    assert.equal(t.started.some(n => after(t.plan, FAILING).includes(n)), false);
  });

  it('the last stage rejecting is a failure of the last stage, and the run ends with it', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    const last = PREFLIGHT_STAGES[PREFLIGHT_STAGES.length - 1].name;
    const t = await setup({ bodyFor: (name) => (name === last ? async () => { throw new Error('planted rejection in the last stage'); } : null) });
    await t.run();
    assert.deepEqual(t.failures, [{ name: last, why: 'planted rejection in the last stage' }]);
    assert.deepEqual(plain(t.runner.timings()).filter(s => s.outcome === 'failed'), [{ name: last, outcome: 'failed' }]);
  });

  it('a body is awaited before the next begins: no two bodies are open at once', async () => {
    let open = 0;
    let most = 0;
    const slow = async () => { open++; most = Math.max(most, open); await elapse(3, 'simulated latency: a stage body that takes a tick'); open--; };
    const t = await setup({ bodyFor: () => slow });
    await t.run();
    assert.equal(most, 1, `${most} bodies were open at once`);
    assert.equal(t.started.length, t.plan.length);
  });
});

describe('the runner holds the plan it is given to the stages\' needs and kinds', () => {
  const noStop = () => { throw new Error('unexpected stop'); };
  const make = (stages) => import(STAGES_MODULE).then(({ createStageRunner }) => createStageRunner({ stages, failures: [], isStatic: false, onStop: noStop }));

  it('refuses a plan that lists a stage before a stage it needs, naming both', async () => {
    await assert.rejects(make([{ name: 'reader', kind: 'build', needs: ['producer'] }, { name: 'producer', kind: 'build' }]), (e) => /reader/.test(e.message) && /producer/.test(e.message));
  });

  it('accepts a need on a stage the plan does not hold (a static run dropped it)', async () => {
    await assert.doesNotReject(make([{ name: 'a', kind: 'source' }, { name: 'reader', kind: 'test', needs: ['dropped-by-the-mode'] }]));
  });

  it('still refuses kinds that descend and a name listed twice', async () => {
    await assert.rejects(make([{ name: 't', kind: 'test' }, { name: 's', kind: 'source' }]), /out of order/);
    await assert.rejects(make([{ name: 'twin', kind: 'source' }, { name: 'twin', kind: 'source' }]), /twin/);
  });

  it('is shown on a copy of the real plan: a stage moved before its need is refused, the unmoved plan is accepted', async () => {
    const { PREFLIGHT_STAGES, planStages } = await stagesModule();
    const plan = planStages(PREFLIGHT_STAGES, null, { static: false });
    await assert.doesNotReject(make(plan));
    const at = (n) => plan.findIndex(s => s.name === n);
    const moved = plan.filter(s => s.name !== 'bundle-budgets');
    moved.splice(at('build:prod'), 0, plan[at('bundle-budgets')]);
    await assert.rejects(make(moved), (e) => /bundle-budgets/.test(e.message));
  });
});
