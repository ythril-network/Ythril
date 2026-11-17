/**
 * The preflight's run order is COMPUTED: the stages' declared needs and kinds fix what may run before what, and the measured cost
 * of finding a failure picks among the stages that may run (Q-865).
 *
 * ## The defect this refuses
 *
 * The order was a hand-ordered list. It held the cheap-first rule of flow convention `convention-preflight-cheapest-first-and-parallel`
 * only as far as its author's guess of each stage's cost, and nothing said which stage reads another's output, so a re-ordering
 * could not be checked and a measurement could not be used. `planStages` (`scripts/_shared/preflight-stages.mjs`) is the one
 * function that answers the order, from the stages' `needs`, their kinds (barriers: source, then build, then test) and the cost the
 * records say (`stageCost`: median milliseconds over the smoothed failure rate, so a cheap stage that often fails goes first).
 *
 * ## What it asserts
 *
 * - `stageCost` is median / ((failed + 1) / (ran + 2)), finite for every row, a stage that never passed included.
 * - Within a kind the cheapest cost goes first; a stage never goes before a stage it needs, nor before an earlier kind, over
 *   hand-built fixtures AND over the real list under many cost tables, in both modes.
 * - A mode is applied first: a `--static` plan drops the `static: false` stages, and a need on a dropped stage counts as met.
 * - No costs (null, or an empty table) give exactly the list order, filtered by the mode; a stage the costs do not list runs after
 *   the listed stages of its kind; a name like `constructor` is never read off the object's prototype.
 * - A graph problem (an unknown kind, a repeated name, a need naming no stage, a cycle) is named by `stageGraphProblems`, and
 *   `planStages` refuses such a list, naming it.
 *
 * Run: node --test testing/standalone/the-preflight-plans-its-stages-by-needs-and-cost.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';

const STAGES_MODULE = pathToFileURL(join(REPO_ROOT, 'scripts/_shared/preflight-stages.mjs')).href;
/** Imported inside each case, so a base without the export fails each case by name and not the whole file at load. */
const stagesModule = () => import(STAGES_MODULE);

const KIND_RANK = { source: 0, build: 1, test: 2 };

/** A stage of a fixture list. */
const S = (name, kind, extra = {}) => Object.freeze({ name, kind, ...extra });
/** A cost row: `ran` runs of which `failed` failed, `medianMs` the median time. */
const C = (ran, failed, medianMs) => ({ ran, failed, medianMs });
const costsOf = (stages) => ({ stages });

/**
 * One list with a first source stage everything else in its kind needs, a cross-kind chain, two stages a static run drops, and
 * a test stage that needs one of them.
 */
const LIST = Object.freeze([
  S('u', 'source'),
  S('a', 'source', { needs: ['u'] }),
  S('b', 'source', { needs: ['u'] }),
  S('c', 'source', { needs: ['u'] }),
  S('x', 'build'),
  S('y', 'build', { needs: ['x'] }),
  S('z', 'build', { static: false }),
  S('w', 'build', { needs: ['z'], static: false }),
  S('t1', 'test', { needs: ['y', 'w'] }),
  S('t2', 'test'),
]);

/**
 * Hand-computed from the rule: cost = medianMs / ((failed + 1) / (ran + 2)).
 *   a 6000 / (1/12) = 72 000 · b 3000 / (6/12) = 6 000 · c 1000 / (1/12) = 12 000 · u 100 / (1/12) = 1 200
 *   x 60 000 / (1/12) = 720 000 · y 100 / (1/12) = 1 200 · z 1000 / (1/12) = 12 000 · w 10 / (1/12) = 120
 *   t1 3000 / (1/7) = 21 000 · t2 100 / (1/7) = 700
 */
const COSTS = costsOf({
  u: C(10, 0, 100), a: C(10, 0, 6000), b: C(10, 5, 3000), c: C(10, 0, 1000),
  x: C(10, 0, 60_000), y: C(10, 0, 100), z: C(10, 0, 1000), w: C(10, 0, 10),
  t1: C(5, 0, 3000), t2: C(5, 0, 100),
});

const names = (plan) => plan.map(s => s.name);

/** The rules every plan keeps, stated once: the right set, no stage before a need that is in the plan, no kind descending. */
function assertSound(list, plan, { isStatic }, label) {
  const expected = list.filter(s => !(isStatic && s.static === false)).map(s => s.name);
  assert.deepEqual([...names(plan)].sort(), [...expected].sort(), `${label}: the plan is not the list's stages for this mode`);
  const at = new Map(names(plan).map((n, i) => [n, i]));
  let reached = 0;
  for (const s of plan) {
    for (const need of s.needs ?? []) {
      if (at.has(need)) assert.ok(at.get(need) < at.get(s.name), `${label}: ${s.name} runs before ${need}, which it needs\n${names(plan).join('\n')}`);
    }
    const rank = KIND_RANK[s.kind];
    assert.ok(rank >= reached, `${label}: ${s.name} (${s.kind}) runs after a ${Object.keys(KIND_RANK)[reached]} stage`);
    reached = Math.max(reached, rank);
  }
}

/** A deterministic cost table: every name gets a row from a seeded generator, so a failing seed can be replayed. */
function seededCosts(stages, seed, shape) {
  let x = seed >>> 0 || 1;
  const next = (n) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
  const rows = {};
  for (const s of stages) {
    const ran = 1 + next(20);
    const failed = next(ran + 1);
    rows[s.name] = C(ran, failed, shape === 'reversed' ? 1 + next(5) : 1 + next(900_000));
  }
  return costsOf(rows);
}

describe('stageCost: the expected cost of finding a failure', () => {
  it('is the median over the smoothed failure rate, so a cheap stage that often fails costs less than a cheap one that never does', async () => {
    const { stageCost } = await stagesModule();
    assert.equal(stageCost(C(10, 0, 1000)), 12_000);
    assert.equal(stageCost(C(10, 5, 3000)), 6000);
    assert.equal(stageCost(C(0, 0, 1000)), 2000);
    assert.ok(Math.abs(stageCost(C(3, 3, 50)) - 62.5) < 1e-9, String(stageCost(C(3, 3, 50))));
    assert.ok(stageCost(C(10, 5, 1000)) < stageCost(C(10, 0, 1000)), 'a stage that fails is not cheaper to find a failure in than one that never does');
  });

  it('is finite for every row, a stage that never passed (all runs failed) and one that never ran included', async () => {
    const { stageCost } = await stagesModule();
    for (const row of [C(4, 4, 2500), C(1, 1, 0), C(0, 0, 0), C(20, 0, 1), C(20, 20, 900_000), C(7, 3, 123_456)]) {
      assert.ok(Number.isFinite(stageCost(row)), `${JSON.stringify(row)} gave ${stageCost(row)}`);
    }
  });
});

describe('planStages over hand-built fixtures', () => {
  it('runs the cheap, failure-prone stage first within its kind, and a stage after the stages it needs whatever it costs', async () => {
    const { planStages } = await stagesModule();
    // source: u is forced first by every other source stage's need; then b (6 000, it fails half the time), c (12 000), a (72 000).
    // build: z (12 000) and x (720 000) can start; w (120) needs z, y (1 200) needs x: z, w, x, y. test: t2 (700) before t1 (21 000).
    assert.deepEqual(names(planStages(LIST, COSTS, { static: false })), ['u', 'b', 'c', 'a', 'z', 'w', 'x', 'y', 't2', 't1']);
  });

  it('puts a stage that fails often ahead of a slower-failing stage that is cheaper to run once', async () => {
    const { planStages } = await stagesModule();
    const list = [S('s1', 'source'), S('s2', 'source'), S('s3', 'source')];
    // s1: 2000 / (1/12) = 24 000, s2: 2000 / (6/12) = 4 000 (half its runs fail), s3: 500 / (1/12) = 6 000
    const plan = planStages(list, costsOf({ s1: C(10, 0, 2000), s2: C(10, 5, 2000), s3: C(10, 0, 500) }), { static: false });
    assert.deepEqual(names(plan), ['s2', 's3', 's1']);
  });

  it('breaks a tie by list position', async () => {
    const { planStages } = await stagesModule();
    const list = [S('p', 'source'), S('q', 'source'), S('r', 'source')];
    const same = C(10, 0, 1000);
    assert.deepEqual(names(planStages(list, costsOf({ p: same, q: same, r: same }), { static: false })), ['p', 'q', 'r']);
    const cheaperLast = planStages(list, costsOf({ p: same, q: same, r: C(10, 0, 1) }), { static: false });
    assert.deepEqual(names(cheaperLast), ['r', 'p', 'q']);
  });

  it('never moves a stage across a kind: a build stage that is nearly free still runs after every source stage', async () => {
    const { planStages } = await stagesModule();
    const list = [S('src', 'source'), S('bld', 'build'), S('tst', 'test')];
    const plan = planStages(list, costsOf({ src: C(10, 0, 900_000), bld: C(10, 10, 1), tst: C(10, 10, 1) }), { static: false });
    assert.deepEqual(names(plan), ['src', 'bld', 'tst']);
  });

  it('applies the mode first: a static plan drops the static:false stages, and a need on a dropped stage counts as met', async () => {
    const { planStages } = await stagesModule();
    const full = planStages(LIST, COSTS, { static: false });
    const stat = planStages(LIST, COSTS, { static: true });
    assert.deepEqual(names(stat), ['u', 'b', 'c', 'a', 'x', 'y', 't2', 't1']);
    assert.ok(names(full).includes('z') && names(full).includes('w'));
    assert.ok(names(stat).includes('t1'), 't1 needs w, which a static run drops: the need is met, t1 still runs');
  });

  it('with no costs (null, or none listed) gives exactly the list order, filtered by the mode', async () => {
    const { planStages } = await stagesModule();
    assert.deepEqual(names(planStages(LIST, null, { static: false })), ['u', 'a', 'b', 'c', 'x', 'y', 'z', 'w', 't1', 't2']);
    assert.deepEqual(names(planStages(LIST, null, { static: true })), ['u', 'a', 'b', 'c', 'x', 'y', 't1', 't2']);
    assert.deepEqual(names(planStages(LIST, costsOf({}), { static: false })), ['u', 'a', 'b', 'c', 'x', 'y', 'z', 'w', 't1', 't2']);
  });

  it('runs a stage the costs do not list after the listed stages of its kind, and keeps list order inside a kind none of whose stages is listed', async () => {
    const { planStages } = await stagesModule();
    const listed = costsOf({ a: C(10, 0, 6000), c: C(10, 0, 1000) });
    // source: u (forced first), then c (12 000), a (72 000), then b, which the costs do not list. build and test: nothing listed, list order.
    assert.deepEqual(names(planStages(LIST, listed, { static: false })), ['u', 'c', 'a', 'b', 'x', 'y', 'z', 'w', 't1', 't2']);
  });

  it('ignores a cost for a name that is no stage, and never reads a name off the prototype (a stage called constructor or toString)', async () => {
    const { planStages } = await stagesModule();
    const list = [S('constructor', 'source'), S('toString', 'source'), S('real', 'source')];
    const plan = planStages(list, costsOf({ real: C(10, 0, 5), 'not-a-stage': C(10, 0, 1) }), { static: false });
    assert.deepEqual(names(plan), ['real', 'constructor', 'toString']);
    assert.deepEqual(names(planStages(list, costsOf({}), { static: false })), ['constructor', 'toString', 'real']);
  });

  it('plans a stage that never passed (its median is of its failed runs) like any other: finite cost, a sound plan', async () => {
    const { planStages, stageCost } = await stagesModule();
    const never = C(4, 4, 2500);
    assert.ok(Number.isFinite(stageCost(never)));
    const costs = costsOf({ ...COSTS.stages, a: never });
    // a: 2500 / ((4 + 1) / (4 + 2)) = 3 000, now the cheapest source stage after u
    assert.deepEqual(names(planStages(LIST, costs, { static: false })).slice(0, 4), ['u', 'a', 'b', 'c']);
  });

  it('answers the list\'s own stage objects, and leaves the list as it was', async () => {
    const { planStages } = await stagesModule();
    const before = JSON.stringify(LIST);
    const plan = planStages(LIST, COSTS, { static: false });
    assert.ok(plan.every(s => LIST.includes(s)), 'the plan holds a stage object the list does not');
    assert.equal(JSON.stringify(LIST), before);
  });
});

describe('planStages over the real list and many cost tables', () => {
  it('holds the rules in both modes for 60 seeded cost tables, a table that makes the dependants cheapest, and one that makes them dearest', async () => {
    const { PREFLIGHT_STAGES, planStages } = await stagesModule();
    const tables = [];
    for (let seed = 1; seed <= 30; seed++) tables.push([`seed ${seed}`, seededCosts(PREFLIGHT_STAGES, seed, 'spread')]);
    for (let seed = 101; seed <= 130; seed++) tables.push([`reversed seed ${seed}`, seededCosts(PREFLIGHT_STAGES, seed, 'reversed')]);
    // The stages that read a build cheapest of all, the builds dearest: only the needs and the kinds can keep the order sound.
    const dependants = new Set(PREFLIGHT_STAGES.filter(s => (s.needs ?? []).length > 0 && s.kind !== 'source').map(s => s.name));
    tables.push(['dependants cheapest', costsOf(Object.fromEntries(PREFLIGHT_STAGES.map(s => [s.name, dependants.has(s.name) ? C(20, 20, 1) : C(20, 0, 900_000)])))]);
    tables.push(['dependants dearest', costsOf(Object.fromEntries(PREFLIGHT_STAGES.map(s => [s.name, dependants.has(s.name) ? C(20, 0, 900_000) : C(20, 20, 1)])))]);
    assert.ok(dependants.size >= 3, `only ${dependants.size} non-source stage(s) declare a need: the fixture would prove nothing`);
    for (const [label, costs] of tables) {
      for (const isStatic of [false, true]) {
        assertSound(PREFLIGHT_STAGES, planStages(PREFLIGHT_STAGES, costs, { static: isStatic }), { isStatic }, `${label}, ${isStatic ? 'static' : 'full'}`);
      }
    }
  });

  it('keeps unregistered-local-files first in every plan (every other source stage needs it: it asks git alone, and test files parse writes sibling files)', async () => {
    const { PREFLIGHT_STAGES, planStages } = await stagesModule();
    for (let seed = 1; seed <= 20; seed++) {
      for (const isStatic of [false, true]) {
        const plan = planStages(PREFLIGHT_STAGES, seededCosts(PREFLIGHT_STAGES, seed, 'reversed'), { static: isStatic });
        assert.equal(plan[0].name, 'unregistered-local-files', `seed ${seed}: ${names(plan).slice(0, 3).join(', ')}`);
      }
    }
  });

  it('with no costs is exactly the list order, filtered by the mode', async () => {
    const { PREFLIGHT_STAGES, planStages } = await stagesModule();
    assert.deepEqual(names(planStages(PREFLIGHT_STAGES, null, { static: false })), PREFLIGHT_STAGES.map(s => s.name));
    assert.deepEqual(names(planStages(PREFLIGHT_STAGES, null, { static: true })), PREFLIGHT_STAGES.filter(s => s.static !== false).map(s => s.name));
  });

  it('lets a measurement move a stage within its kind: the last source stage that fails every run and costs nothing goes right after the first', async () => {
    const { PREFLIGHT_STAGES, planStages } = await stagesModule();
    const sources = PREFLIGHT_STAGES.filter(s => s.kind === 'source');
    const last = sources[sources.length - 1].name;
    const costs = costsOf(Object.fromEntries(sources.map(s => [s.name, s.name === last ? C(20, 20, 1) : C(20, 0, 60_000)])));
    const plan = names(planStages(PREFLIGHT_STAGES, costs, { static: false }));
    assert.equal(plan[0], 'unregistered-local-files');
    assert.equal(plan[1], last, `${last} was not moved up: ${plan.slice(0, 4).join(', ')}`);
  });
});

describe('stageGraphProblems and the refusal of a list with a problem', () => {
  it('is empty for the real list, which includes the stages a static run drops (a need on one of them is not a problem)', async () => {
    const { PREFLIGHT_STAGES, stageGraphProblems } = await stagesModule();
    assert.deepEqual(stageGraphProblems(PREFLIGHT_STAGES), []);
    assert.deepEqual(stageGraphProblems(LIST), []);
  });

  it('names a need that names no stage', async () => {
    const { stageGraphProblems } = await stagesModule();
    const problems = stageGraphProblems([S('s', 'source'), S('lonely', 'build', { needs: ['ghost-stage'] })]);
    assert.ok(problems.some(p => p.includes('lonely') && p.includes('ghost-stage')), problems.join('\n'));
  });

  it('names a cycle, with the stages in it', async () => {
    const { stageGraphProblems } = await stagesModule();
    const problems = stageGraphProblems([S('loop-p', 'source', { needs: ['loop-q'] }), S('loop-q', 'source', { needs: ['loop-p'] }), S('fine', 'source')]);
    assert.ok(problems.some(p => p.includes('loop-p') && p.includes('loop-q')), problems.join('\n'));
    assert.equal(problems.some(p => p.includes('fine')), false, 'a stage outside the cycle is named in it');
    const self = stageGraphProblems([S('self', 'source', { needs: ['self'] })]);
    assert.ok(self.some(p => p.includes('self')), 'a stage that needs itself is not named');
  });

  it('names a need on a stage of a later kind (it can never be met: every later-kind stage needs every earlier-kind one)', async () => {
    const { stageGraphProblems } = await stagesModule();
    const problems = stageGraphProblems([S('early', 'source', { needs: ['late'] }), S('late', 'test')]);
    assert.ok(problems.some(p => p.includes('early') && p.includes('late')), problems.join('\n'));
  });

  it('names an unknown kind and a stage listed twice', async () => {
    const { stageGraphProblems } = await stagesModule();
    assert.ok(stageGraphProblems([S('odd-kind', 'slow')]).some(p => p.includes('odd-kind')));
    assert.ok(stageGraphProblems([S('twin', 'source'), S('twin', 'build')]).some(p => p.includes('twin')));
  });

  it('is shown on copies of the real list: a planted unknown need, a planted cycle and a planted misspelt need are each named', async () => {
    const { PREFLIGHT_STAGES, stageGraphProblems } = await stagesModule();
    const withNeed = (name, needs) => PREFLIGHT_STAGES.map(s => (s.name === name ? { ...s, needs } : s));
    assert.ok(stageGraphProblems(withNeed('lint:docs', ['no-such-stage'])).some(p => p.includes('lint:docs') && p.includes('no-such-stage')));
    assert.ok(stageGraphProblems(withNeed('build:server', ['audit-route-coverage'])).some(p => p.includes('build:server') && p.includes('audit-route-coverage')));
    assert.ok(stageGraphProblems(withNeed('bundle-budgets', ['build:prods'])).some(p => p.includes('bundle-budgets') && p.includes('build:prods')));
  });

  it('is what planStages refuses: a cycle, an unknown need, an unknown kind, each thrown with its stage named', async () => {
    const { planStages } = await stagesModule();
    const refused = (list, ...named) => assert.throws(() => planStages(list, null, { static: false }), (e) => named.every(n => String(e.message).includes(n)), `not refused naming ${named.join(', ')}`);
    refused([S('loop-p', 'source', { needs: ['loop-q'] }), S('loop-q', 'source', { needs: ['loop-p'] })], 'loop-p', 'loop-q');
    refused([S('s', 'source', { needs: ['ghost-stage'] })], 's', 'ghost-stage');
    refused([S('odd-kind', 'slow')], 'odd-kind');
    refused([S('twin', 'source'), S('twin', 'source')], 'twin');
  });
});
