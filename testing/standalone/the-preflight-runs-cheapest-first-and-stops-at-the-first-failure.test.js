/**
 * The preflight runs its stages in a COMPUTED order that is cheapest-first and never wrong about what needs what, and stops at the
 * first stage that fails.
 *
 * ## The defect this refuses
 *
 * A full preflight takes about 35 minutes. Its sub-minute text gates (the CHANGELOG entry, docs lint, the todo index, the
 * route list, the CI-reach check) ran after 26 minutes of standalone test batches, and a failing gate did not end the run:
 * the script went on to the end and listed what failed there. Every preflight failure on 2026-11-16 was one of those cheap
 * gates, learned half an hour late. Flow convention `convention-preflight-cheapest-first-and-parallel`: no-build stages first,
 * then the builds and the gates that read them, then the suites; the first failing stage ends the run. Since Q-865 the order is
 * not a hand-written list: the stages declare what they need and `planStages` orders them by measured cost inside that.
 *
 * ## What it asserts, and where each answer comes from
 *
 * - The stage list is a sound graph (`stageGraphProblems`), its `static:false` stages are exactly the client suite, the production
 *   build and the budgets, and its declared needs are the ones written here by hand (what each stage's code reads).
 * - In EVERY plan (many cost tables, both modes): kinds never descend, a stage that reads a build runs after it, and the old rule
 *   "the client unit tests before the standalone batches" is NOT a need (a cost table puts the standalone batches first).
 * - A stage whose code runs a file that reads `server/dist` or `client/dist` declares the matching need. Derived from the files, not
 *   from the list: the standalone stage from the pure files it runs (`testing/standalone/*.test.js`, the ones preflight runs), the
 *   built gates and the surface audit from their own files, and the source gates must read neither.
 * - Since Q-870 the source stages include `text-only standalone tests`, listed after the gates: the standalone files that read only tracked text
 *   (`testing/_shared/text-only-test.mjs`), minus the gate files. Every file a source stage runs must pass that classifier, and the dist rule
 *   (`readsDist`) is the classifier module's, not a copy here.
 * - `scripts/preflight.mjs` registers a body for every listed stage (read as text, comments stripped, the gate loops expanded from
 *   the gate tables) and runs them through `runStages(planStages(...))`; no `begin(...)` call is left in it.
 * - The runner stops at the first failure: with an injected list a failing `source` stage ends the run before the `test` stage's
 *   body starts and `onStop` is told every stage that did not run; a stage entered out of order, or never entered, throws; a plan
 *   whose kinds descend is refused.
 * - End to end: the REAL `scripts/preflight.mjs`, run in a scratch folder whose CHANGELOG gate is planted to fail, exits 1 at that
 *   gate, names it, lists the stages it did not run, and starts neither the server build nor any test batch, under `--static` too.
 *   With a planted `test-results/stage-costs.json` the run's order is the snapshot's (a cheap stage that fails often goes first, so
 *   the CHANGELOG gate never starts) and it says where the order came from; a stale or garbage snapshot gives the list order and
 *   says why; a static run removes an old client report before any stage runs.
 *
 * Run: node --test testing/standalone/the-preflight-runs-cheapest-first-and-stops-at-the-first-failure.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { offlineRuns, splitStandalone } from '../_shared/standalone-split.mjs';
import { importOrFail } from '../_shared/import-or-fail.mjs';

const STAGES_MODULE = pathToFileURL(join(REPO_ROOT, 'scripts/_shared/preflight-stages.mjs')).href;
const PREFLIGHT = join(REPO_ROOT, 'scripts/preflight.mjs');
/** Imported inside each test, so a base without the module fails each test for the missing module and not the whole file at load. */
const stagesModule = () => import(STAGES_MODULE);

/** The project's scratch root, made to exist (it is outside the checkout, and a fresh machine may not have it yet). */
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };

const KINDS = ['source', 'build', 'test'];
const C = (ran, failed, medianMs) => ({ ran, failed, medianMs });
const names = (plan) => plan.map(s => s.name);

/** A cost table from a seeded generator, so a failing seed can be replayed; `shape` 'reversed' makes the times tiny and the failure rates wild. */
function seededCosts(stages, seed, shape) {
  let x = seed >>> 0 || 1;
  const next = (n) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
  const rows = {};
  for (const s of stages) {
    const ran = 1 + next(20);
    rows[s.name] = C(ran, next(ran + 1), shape === 'reversed' ? 1 + next(5) : 1 + next(900_000));
  }
  return { stages: rows };
}

/** Every plan the rules are asserted over: many tables, both modes. */
async function everyPlan() {
  const { PREFLIGHT_STAGES, planStages } = await stagesModule();
  const plans = [];
  const tables = [['no costs', null]];
  for (let seed = 1; seed <= 25; seed++) tables.push([`seed ${seed}`, seededCosts(PREFLIGHT_STAGES, seed, 'spread')]);
  for (let seed = 101; seed <= 125; seed++) tables.push([`reversed ${seed}`, seededCosts(PREFLIGHT_STAGES, seed, 'reversed')]);
  for (const [label, costs] of tables) {
    for (const isStatic of [false, true]) plans.push({ label: `${label}, ${isStatic ? 'static' : 'full'}`, isStatic, plan: planStages(PREFLIGHT_STAGES, costs, { static: isStatic }) });
  }
  return plans;
}

/** What each stage reads of another's output, written by hand from the code each one runs (Q-865). The others need nothing, bar the source stages' first. */
const HAND_NEEDS = {
  'audit-route-coverage': ['build:server'],
  'surface-matrix-audit': ['build:server'],
  'bundle-budgets': ['build:prod'],
  'test:standalone (offline subset)': ['build:server', 'build:prod'],
};

describe('the stage list is data: a sound graph, with the needs each stage\'s code has', () => {
  it('has no unknown kind, no repeated name, no need that names no stage and no cycle', async () => {
    const { PREFLIGHT_STAGES, stageGraphProblems } = await stagesModule();
    assert.deepEqual(stageGraphProblems(PREFLIGHT_STAGES), []);
  });

  it('declares exactly the needs the stages\' code has: the builds a stage reads, and unregistered-local-files for every other source stage', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    const declared = Object.fromEntries(PREFLIGHT_STAGES.map(s => [s.name, [...(s.needs ?? [])].sort()]));
    const expected = Object.fromEntries(PREFLIGHT_STAGES.map(s => [s.name, [...(HAND_NEEDS[s.name] ?? (s.kind === 'source' && s.name !== 'unregistered-local-files' ? ['unregistered-local-files'] : []))].sort()]));
    assert.deepEqual(declared, expected);
  });

  it('puts the CHANGELOG gate, docs lint and the todo index among the source stages (they read no build), and the CHANGELOG gate is a stage at all', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    for (const cheap of ['check-changelog', 'lint:docs', 'todo:check', 'unrun-tests', 'test files parse']) {
      const s = PREFLIGHT_STAGES.find(x => x.name === cheap);
      assert.ok(s, `${cheap} is not a stage`);
      assert.equal(s.kind, 'source', `${cheap} reads source only and must be a source stage`);
    }
  });

  it('marks exactly what a static run leaves out: the client suite, the production build and its budgets', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    assert.deepEqual(PREFLIGHT_STAGES.filter(s => s.static === false).map(s => s.name).sort(), ['build:prod', 'bundle-budgets', 'client unit tests']);
  });

  it('is shown a planted fault on a copy of the real list: a need that names no stage, a cycle, an unknown kind and a repeated stage are each named', async () => {
    const { PREFLIGHT_STAGES, stageGraphProblems } = await stagesModule();
    const copy = (change) => PREFLIGHT_STAGES.map(s => change(s) ?? s);
    assert.ok(stageGraphProblems(copy(s => (s.name === 'lint:docs' ? { ...s, needs: ['no-such-stage'] } : null))).some(p => p.includes('lint:docs') && p.includes('no-such-stage')));
    assert.ok(stageGraphProblems(copy(s => (s.name === 'build:server' ? { ...s, needs: ['audit-route-coverage'] } : null))).some(p => p.includes('build:server') && p.includes('audit-route-coverage')));
    assert.ok(stageGraphProblems([...PREFLIGHT_STAGES, { name: 'planted', kind: 'slow' }]).some(p => p.includes('planted')));
    assert.ok(stageGraphProblems([...PREFLIGHT_STAGES, PREFLIGHT_STAGES[0]]).some(p => p.includes(PREFLIGHT_STAGES[0].name)));
  });
});

describe('every plan keeps the order the stages need: kinds never descend, a stage reading a build runs after it', () => {
  it('lists no kind after a costlier one in any plan (25 + 25 cost tables, both modes)', async () => {
    for (const { label, plan } of await everyPlan()) {
      let reached = 0;
      for (const s of plan) {
        const rank = KINDS.indexOf(s.kind);
        assert.ok(rank >= reached, `${label}: ${s.name} (${s.kind}) runs after a ${KINDS[reached]} stage`);
        reached = Math.max(reached, rank);
      }
    }
  });

  it('runs the CHANGELOG gate, docs lint, the todo index, unrun-tests and test files parse before the server build, in every plan', async () => {
    for (const { label, plan } of await everyPlan()) {
      const at = (n) => names(plan).indexOf(n);
      for (const cheap of ['check-changelog', 'lint:docs', 'todo:check', 'unrun-tests', 'test files parse']) {
        assert.ok(at(cheap) >= 0 && at(cheap) < at('build:server'), `${label}: ${cheap} does not run before the server build`);
      }
    }
  });

  it('runs the server build before the gates that import server/dist, and the production build before the budgets, in every plan', async () => {
    for (const { label, plan, isStatic } of await everyPlan()) {
      const at = (n) => names(plan).indexOf(n);
      for (const built of ['audit-route-coverage', 'surface-matrix-audit', 'test:standalone (offline subset)']) {
        assert.ok(at('build:server') >= 0 && at('build:server') < at(built), `${label}: ${built} runs before the server build it imports`);
      }
      if (!isStatic) {
        assert.ok(at('build:prod') >= 0 && at('build:prod') < at('bundle-budgets'), `${label}: the budgets run before the production build they read`);
        assert.ok(at('build:prod') < at('test:standalone (offline subset)'), `${label}: the standalone batches run before the client build they read`);
      }
    }
  });

  it('runs every build-kind stage before every test-kind stage, in every plan', async () => {
    for (const { label, plan } of await everyPlan()) {
      const firstTest = plan.findIndex(s => s.kind === 'test');
      assert.ok(firstTest > 0);
      assert.equal(plan.slice(firstTest).some(s => s.kind !== 'test'), false, `${label}: a non-test stage runs after a suite began`);
    }
  });

  it('does not make "the client unit tests before the standalone batches" a need: a cost table that makes the standalone batches cheaper puts them first', async () => {
    const { PREFLIGHT_STAGES, planStages } = await stagesModule();
    const costs = { stages: { 'client unit tests': C(10, 0, 240_000), 'test:standalone (offline subset)': C(10, 9, 1000) } };
    const plan = names(planStages(PREFLIGHT_STAGES, costs, { static: false }));
    assert.ok(plan.indexOf('test:standalone (offline subset)') < plan.indexOf('client unit tests'), plan.slice(-3).join(', '));
  });

  it('removes exactly the static:false stages from a static plan, whatever the costs', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    for (const { label, plan, isStatic } of await everyPlan()) {
      const left = PREFLIGHT_STAGES.map(s => s.name).filter(n => !names(plan).includes(n));
      assert.deepEqual(left, isStatic ? ['build:prod', 'bundle-budgets', 'client unit tests'] : [], label);
    }
  });

  it('refuses a plan with the CHANGELOG gate moved behind the last suite, naming it (shown on a copy of a real plan)', async () => {
    const { PREFLIGHT_STAGES, planStages, createStageRunner } = await stagesModule();
    const plan = planStages(PREFLIGHT_STAGES, null, { static: false });
    const moved = [...plan.filter(s => s.name !== 'check-changelog'), plan.find(s => s.name === 'check-changelog')];
    assert.throws(() => createStageRunner({ stages: moved, failures: [], isStatic: false, onStop() {} }), (e) => /check-changelog/.test(e.message) && /out of order/.test(e.message));
    assert.doesNotThrow(() => createStageRunner({ stages: plan, failures: [], isStatic: false, onStop() {} }));
  });
});

/**
 * The dist rule and the text-only classifier are one module (`testing/_shared/text-only-test.mjs`, Q-870): the stage test used to hold its own
 * `readsDist`, the second spelling of a rule the classifier needs. Imported inside each case, so a base without the module fails each case by name.
 */
const textOnlyModule = () => importOrFail('testing/_shared/text-only-test.mjs', 'readsDist and the text-only classification');

describe('a stage whose code runs a file that reads a build declares the need (derived from the files, not from the list)', () => {
  const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

  it('test:standalone declares build:server for a pure file that reads server/dist and build:prod for one that reads client/dist', async () => {
    const { readsDist } = await textOnlyModule();
    const { PREFLIGHT_STAGES } = await stagesModule();
    const standalone = PREFLIGHT_STAGES.find(s => s.name === 'test:standalone (offline subset)');
    const pure = offlineRuns(splitStandalone({ root: REPO_ROOT }), { ciOnly: false }).filter(r => r.kind === 'pure').flatMap(r => r.files);
    assert.ok(pure.length > 500, `only ${pure.length} pure files found: the scan is broken`);
    const readers = (which) => pure.filter(f => readsDist(read(f), which));
    assert.ok(readers('server').length > 0, 'no pure file reads server/dist: the premise of the need is gone, or the scan is broken');
    assert.ok(readers('client').includes('testing/standalone/bundle-budget-coverage.test.js'), `bundle-budget-coverage.test.js reads client/dist and is not a pure file the scan found; found ${readers('client').join(', ')}`);
    assert.ok((standalone.needs ?? []).includes('build:server'), `the standalone stage runs ${readers('server').length} file(s) that read server/dist (e.g. ${readers('server')[0]}) and does not need build:server`);
    assert.ok((standalone.needs ?? []).includes('build:prod'), `the standalone stage runs ${readers('client').length} file(s) that read client/dist (${readers('client').slice(0, 2).join(', ')}) and does not need build:prod`);
  });

  it('each built gate, and the surface audit, reads server/dist and declares build:server', async () => {
    const { readsDist } = await textOnlyModule();
    const { PREFLIGHT_STAGES, BUILT_GATES } = await stagesModule();
    const files = new Map([...BUILT_GATES.map(([n]) => [n, `testing/standalone/${n}.test.js`]), ['surface-matrix-audit', 'scripts/surface-matrix-audit.mjs']]);
    assert.ok(files.size >= 2);
    for (const [stage, file] of files) {
      assert.ok(readsDist(read(file), 'server'), `${file} no longer reads server/dist: ${stage} would not need the build`);
      const s = PREFLIGHT_STAGES.find(x => x.name === stage);
      assert.ok((s.needs ?? []).includes('build:server'), `${stage} runs ${file}, which reads server/dist, and does not need build:server`);
    }
  });

  it('the bundle budgets read the production build\'s output, and declare build:prod', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    assert.ok((PREFLIGHT_STAGES.find(s => s.name === 'bundle-budgets').needs ?? []).includes('build:prod'));
    assert.match(stripComments(read('scripts/preflight.mjs')), /build:prod[^]*bundle-budgets|bundle-budgets[^]*build:prod/, 'preflight.mjs no longer ties the budgets to the production build');
  });

  it('no source stage reads a build: each source gate and each source script reads neither server/dist nor client/dist (so an empty need is honest)', async () => {
    const { readsDist } = await textOnlyModule();
    const { PREFLIGHT_STAGES, SOURCE_GATES } = await stagesModule();
    const sourceFiles = [
      ...SOURCE_GATES.map(([n]) => `testing/standalone/${n}.test.js`),
      'scripts/unregistered-local-files.mjs', 'scripts/check-changelog.mjs', 'scripts/unrun-tests.mjs',
    ];
    assert.ok(PREFLIGHT_STAGES.filter(s => s.kind === 'source').length >= sourceFiles.length - 3);
    for (const file of sourceFiles) {
      for (const which of ['server', 'client']) assert.equal(readsDist(read(file), which), false, `${file} reads ${which}/dist but runs in a source stage that needs no build`);
    }
  });

  it('every file a source stage runs, the gate files and the text stage\'s computed files alike, reads only tracked text (the classifier, not only the dist rule)', async () => {
    const { readsOnlyTrackedText, textOnlyFiles } = await textOnlyModule();
    const { SOURCE_GATE_FILES } = await stagesModule();
    assert.ok(SOURCE_GATE_FILES instanceof Set && SOURCE_GATE_FILES.size >= 11, 'SOURCE_GATE_FILES is not the gate table as a set of test paths');
    const textStageFiles = textOnlyFiles(splitStandalone({ root: REPO_ROOT }), { root: REPO_ROOT }).filter(f => !SOURCE_GATE_FILES.has(f));
    assert.ok(textStageFiles.length >= 150, `the text stage would run only ${textStageFiles.length} file(s) besides the gates`);
    const refused = [...SOURCE_GATE_FILES, ...textStageFiles]
      .map(f => [f, readsOnlyTrackedText(f, { root: REPO_ROOT })]).filter(([, a]) => !a.textOnly).map(([f, a]) => `${f}: ${a.reason}`);
    assert.deepEqual(refused, [], 'these files run in a source stage, which needs no build and no install, and read more than tracked text');
  });
});

describe('the text stage is listed after the gates, as a source stage with the first stage as its one need', () => {
  it('is a source stage named text-only standalone tests, after every gate stage, needing only unregistered-local-files', async () => {
    const { PREFLIGHT_STAGES, SOURCE_GATES } = await stagesModule();
    const at = (n) => PREFLIGHT_STAGES.findIndex(s => s.name === n);
    const text = PREFLIGHT_STAGES.find(s => s.name === 'text-only standalone tests');
    assert.ok(text, 'the stage list has no stage named text-only standalone tests');
    assert.equal(text.kind, 'source', 'the text stage reads no build and must be a source stage');
    assert.deepEqual([...(text.needs ?? [])], ['unregistered-local-files']);
    for (const [gate] of SOURCE_GATES) assert.ok(at('text-only standalone tests') > at(gate), `the text stage is listed before the gate ${gate}: the gates keep their place in the cost order`);
  });

  it('is in every plan, before the server build, in both modes', async () => {
    for (const { label, plan } of await everyPlan()) {
      const where = names(plan).indexOf('text-only standalone tests');
      assert.ok(where >= 0 && where < names(plan).indexOf('build:server'), `${label}: the text stage is missing or runs after the server build`);
    }
  });
});

describe('scripts/preflight.mjs registers a body for every listed stage and runs them through runStages(planStages(...)) (the real file, read as text)', () => {
  it('registers a body for each stage in the list, once, with the gate loops expanded from the gate tables', async () => {
    const { PREFLIGHT_STAGES, SOURCE_GATES, BUILT_GATES } = await stagesModule();
    const code = stripComments(readFileSync(PREFLIGHT, 'utf8'));
    // Built fresh: a global regex shared between calls keeps its lastIndex (pitfall-shared-global-regex).
    const token = /\bstage\(\s*(['"`])([^'"`]+)\1\s*,|\bof\s+(SOURCE_GATES|BUILT_GATES)\s*\)\s*gate\(/g;
    const registered = [];
    for (const m of code.matchAll(token)) {
      if (m[2]) registered.push(m[2]);
      else registered.push(...(m[3] === 'SOURCE_GATES' ? SOURCE_GATES : BUILT_GATES).map(([name]) => name));
    }
    assert.deepEqual([...registered].sort(), PREFLIGHT_STAGES.map(s => s.name).sort(),
      'the stages preflight.mjs registers a body for are not the stage list: register the missing body, or list the stage');
  });

  it('registers each gate through gate(), which registers its stage with stage(name, ...)', () => {
    const code = stripComments(readFileSync(PREFLIGHT, 'utf8'));
    const body = code.match(/function gate\([^)]*\)\s*\{([^]*?)\n\}/);
    assert.ok(body, 'preflight.mjs no longer declares gate()');
    assert.match(body[1], /\bstage\(\s*name\s*,/, 'gate() does not register its stage');
  });

  it('enters no stage by hand any more: no begin(...) call, the order is the plan\'s', () => {
    const code = stripComments(readFileSync(PREFLIGHT, 'utf8'));
    assert.equal(/\.begin\(/.test(code), false, 'preflight.mjs still calls begin(): a stage entered by hand is a stage run in the order the code was written in');
  });

  it('runs the bodies through runStages(planStages(PREFLIGHT_STAGES, costs, { static })), importing both from the stage module', () => {
    const code = stripComments(readFileSync(PREFLIGHT, 'utf8'));
    assert.match(code, /import\s*\{[^}]*\bplanStages\b[^}]*\}\s*from\s*['"]\.\/_shared\/preflight-stages\.mjs['"]/, 'planStages is not imported from the stage module');
    assert.match(code, /import\s*\{[^}]*\brunStages\b[^}]*\}\s*from\s*['"]\.\/_shared\/preflight-stages\.mjs['"]/, 'runStages is not imported from the stage module');
    const planned = code.match(/planStages\(\s*PREFLIGHT_STAGES\s*,[^;]*\bstatic\s*:\s*STATIC\b/);
    assert.ok(planned, 'the plan is not planStages(PREFLIGHT_STAGES, costs, { static: STATIC })');
    const call = code.match(/\brunStages\(\s*([A-Za-z_$][\w$]*|planStages\([^)]*\))/);
    assert.ok(call, 'runStages is never called');
    assert.ok(call[1].startsWith('planStages') || new RegExp(`\\b(const|let)\\s+${call[1].replace(/[$]/g, '\\$')}\\s*=\\s*planStages\\(`).test(code), `runStages is handed ${call[1]}, which is not what planStages returned`);
  });

  it('reads the costs through readStageCosts and never fetches: no call to an instance in the preflight', () => {
    const code = stripComments(readFileSync(PREFLIGHT, 'utf8'));
    assert.match(code, /\breadStageCosts\(/, 'the costs are not read through readStageCosts');
    assert.equal(/\bcreateYthrilApi\b|\bfetch\(|YTHRIL_TEST_RUNS_URL/.test(code), false, 'the preflight reaches for the instance: a down instance would delay its fast failure');
  });
});

describe('the runner stops at the first failing stage (an injected list)', () => {
  /** A cheap source stage, the CHANGELOG gate, a build and a suite; `ran` records the bodies that started. */
  async function drive({ failAt, isStatic = false }) {
    const { createStageRunner } = await stagesModule();
    const stages = [
      { name: 'cheap', kind: 'source' },
      { name: 'check-changelog', kind: 'source' },
      { name: 'build', kind: 'build' },
      { name: 'only-in-full', kind: 'test', static: false },
      { name: 'suite', kind: 'test' },
    ];
    const failures = [];
    const ran = [];
    const stop = new Error('stopped');
    let told;
    const runner = createStageRunner({ stages, failures, isStatic, onStop: (s) => { told = s; throw stop; } });
    try {
      for (const s of stages.filter(x => !(isStatic && x.static === false))) {
        runner.begin(s.name);
        ran.push(s.name);
        if (s.name === failAt) failures.push({ name: s.name, why: 'planted' });
      }
      runner.end();
    } catch (e) {
      if (e !== stop) throw e;
    }
    return { ran, told };
  }

  it('a failing source stage ends the run before the build and the suite start, and says what did not run', async () => {
    const { ran, told } = await drive({ failAt: 'check-changelog' });
    assert.deepEqual(ran, ['cheap', 'check-changelog']);
    assert.deepEqual(told.notRun, ['build', 'only-in-full', 'suite']);
  });

  it('under --static the stages a static run leaves out are neither expected nor reported as not run', async () => {
    const { ran, told } = await drive({ failAt: 'cheap', isStatic: true });
    assert.deepEqual(ran, ['cheap']);
    assert.deepEqual(told.notRun, ['check-changelog', 'build', 'suite']);
  });

  it('with no failure every stage runs and nothing stops', async () => {
    const { ran, told } = await drive({ failAt: null });
    assert.deepEqual(ran, ['cheap', 'check-changelog', 'build', 'only-in-full', 'suite']);
    assert.equal(told, undefined);
  });

  it('a stage entered out of order, and a stage never entered, both throw', async () => {
    const { createStageRunner } = await stagesModule();
    const stages = [{ name: 'a', kind: 'source' }, { name: 'b', kind: 'test' }];
    const onStop = () => { throw new Error('unexpected stop'); };
    const early = createStageRunner({ stages, failures: [], isStatic: false, onStop });
    assert.throws(() => early.begin('b'), /order drifted: entered "b" but the stage list says "a" is next/);
    const short = createStageRunner({ stages, failures: [], isStatic: false, onStop });
    short.begin('a');
    assert.throws(() => short.end(), /ended without entering: b/);
  });

  it('refuses a stage list whose kinds descend', async () => {
    const { createStageRunner } = await stagesModule();
    assert.throws(() => createStageRunner({ stages: [{ name: 't', kind: 'test' }, { name: 's', kind: 'source' }], failures: [], isStatic: false, onStop() {} }), /out of order/);
  });
});

describe('the real preflight (end to end, in a scratch folder)', () => {
  const lines = (r) => r.out.split(/\r?\n/);
  /** The line the run says its order's source on. */
  const sourceLine = (r) => lines(r).find(l => /^preflight: stage order\b/i.test(l)) ?? '';

  /**
   * Runs preflight.mjs with `args` in a scratch folder; `changelog` and `unrunTests` are the exit codes of those two gates, and `seed(dir)` plants
   * what the run reads beforehand. The build, the todo gate and the CHANGELOG gate write a sentinel if they start.
   */
  function planted(args, { changelog = 1, unrunTests = 0, seed = () => {}, env = {} } = {}) {
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-stop-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts/unregistered-local-files.mjs'), 'process.exit(0);\n');
      writeFileSync(join(dir, 'scripts/touch.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], '');\n");
      writeFileSync(join(dir, 'scripts/check-changelog.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('ran-changelog', ''); console.log('planted: no [Unreleased] line'); process.exit(${changelog});\n`);
      writeFileSync(join(dir, 'scripts/unrun-tests.mjs'), `console.log('planted: a test no job selects'); process.exit(${unrunTests});\n`);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'planted', private: true, type: 'module',
        scripts: {
          'todo:check': 'node scripts/touch.mjs ran-todo-check',
          'build:server': 'node scripts/touch.mjs ran-build-server',
        },
      }));
      seed(dir);
      const base = { ...process.env };
      delete base.RUNNER_HEAD;
      const r = spawnSync(process.execPath, [PREFLIGHT, ...args], { cwd: dir, encoding: 'utf8', env: testChildEnv(typeof env === 'function' ? env(dir) : env, base), timeout: 90_000 });
      return {
        status: r.status,
        out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
        ranTodo: existsSync(join(dir, 'ran-todo-check')),
        ranBuild: existsSync(join(dir, 'ran-build-server')),
        ranChangelog: existsSync(join(dir, 'ran-changelog')),
        clientReportLeft: existsSync(join(dir, 'test-results', 'client.json')),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [label, args, verdict] of [['full', [], /Preflight FAILED — 1 gate\(s\)/], ['static', ['--static'], /Preflight STATIC FAILED — 1 gate\(s\)/]]) {
    it(`${label}: exits 1 at the planted CHANGELOG gate, names it and the stages that did not run`, () => {
      const r = planted(args);
      assert.equal(r.status, 1, r.out.slice(-1500));
      assert.match(r.out, verdict, r.out.slice(-1500));
      assert.match(r.out, /check-changelog\n\s+a file that changes what ships/, 'the failing stage is not named with its reason');
      const notRun = r.out.match(/Not run[^\n]*/)?.[0] ?? '';
      for (const stage of ['todo:check', 'text-only standalone tests', 'build:server', 'surface-matrix-audit', 'test:standalone (offline subset)']) {
        assert.ok(notRun.includes(stage), `the summary does not list ${stage} as not run:\n${r.out.slice(-1500)}`);
      }
      assert.equal(notRun.includes('build:prod') || notRun.includes('client unit tests') || notRun.includes('bundle-budgets'), label === 'full',
        `${label}: the client suite, the production build and the budgets are ${label === 'full' ? 'part of' : 'not part of'} this run's plan`);
    });

    it(`${label}: starts no server build, no later gate and no test batch`, () => {
      const r = planted(args);
      assert.equal(r.ranBuild, false, 'the server build started after the CHANGELOG gate failed');
      assert.equal(r.ranTodo, false, 'a later source gate started after the CHANGELOG gate failed');
      assert.doesNotMatch(r.out, /standalone tests that need no running instance|batch \d+\/\d+/, 'a standalone test batch started');
    });

    it(`${label}: with no snapshot it says the order is the list's, and why`, () => {
      const r = planted(args);
      assert.match(sourceLine(r), /list order/i, `no line says where the order came from:\n${r.out.slice(0, 1500)}`);
    });

    it(`${label}: removes an old client report before any stage runs, so a run that stops early leaves none standing as its own`, () => {
      const r = planted(args, { seed: (dir) => { mkdirSync(join(dir, 'test-results'), { recursive: true }); writeFileSync(join(dir, 'test-results', 'client.json'), '{"numTotalTests":1}'); } });
      assert.equal(r.status, 1, r.out.slice(-1500));
      assert.equal(r.clientReportLeft, false, 'an earlier run\'s client report is still there after a run that never reached the client stage');
    });

    it(`${label}: follows a planted snapshot's order: a cheap stage that fails often goes first, so the CHANGELOG gate never starts`, () => {
      const runs = 12;
      const snapshot = {
        generatedAt: new Date().toISOString(), window: 20, runner: 'container', runs,
        stages: {
          'unregistered-local-files': C(runs, 0, 50),
          'unrun-tests': C(runs, 10, 100),
          'check-changelog': C(runs, 0, 3000),
        },
      };
      const r = planted(args, {
        changelog: 0, unrunTests: 1,
        env: (dir) => ({ RUNNER_HEAD: 'planted-head', YTHRIL_TEST_RESULTS_DIR: join(dir, 'test-results') }),
        seed: (dir) => { mkdirSync(join(dir, 'test-results'), { recursive: true }); writeFileSync(join(dir, 'test-results', 'stage-costs.json'), JSON.stringify(snapshot)); },
      });
      assert.equal(r.status, 1, r.out.slice(-1500));
      assert.match(r.out, /unrun-tests\n\s+a tracked test file that no CI job selects/, 'the cheap failing stage was not the one that ended the run');
      assert.equal(r.ranChangelog, false, 'the CHANGELOG gate started: the run did not follow the snapshot\'s order');
      assert.ok((r.out.match(/Not run[^\n]*/)?.[0] ?? '').includes('check-changelog'), `check-changelog is not listed as not run:\n${r.out.slice(-1500)}`);
      const said = sourceLine(r);
      assert.match(said, new RegExp(`\\b${runs}\\b`), `the order's source line does not say how many runs it rests on: ${said || '(no such line)'}`);
      assert.doesNotMatch(said, /list order/i, said);
    });
  }

  it('an old snapshot (15 days) is not followed: the list order runs, and the line says it is stale', () => {
    const old = {
      generatedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(), window: 20, runner: 'container', runs: 12,
      stages: { 'unrun-tests': C(12, 10, 100), 'check-changelog': C(12, 0, 3000) },
    };
    const r = planted([], {
      changelog: 0, unrunTests: 1, env: { RUNNER_HEAD: 'planted-head' },
      seed: (dir) => { mkdirSync(join(dir, 'test-results'), { recursive: true }); writeFileSync(join(dir, 'test-results', 'stage-costs.json'), JSON.stringify(old)); },
    });
    assert.equal(r.ranChangelog, true, 'a snapshot 15 days old reordered the run');
    assert.match(sourceLine(r), /stale/i, r.out.slice(0, 1500));
    assert.match(sourceLine(r), /list order/i);
  });

  it('a garbage snapshot does not stop the run: the list order runs and the line says why', () => {
    const r = planted([], {
      seed: (dir) => { mkdirSync(join(dir, 'test-results'), { recursive: true }); writeFileSync(join(dir, 'test-results', 'stage-costs.json'), '{"generatedAt": "2026-11-1'); },
    });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.equal(r.ranChangelog, true);
    assert.match(sourceLine(r), /list order/i, r.out.slice(0, 1500));
  });
});
