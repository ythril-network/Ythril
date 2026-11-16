/**
 * The preflight runs its stages cheapest first, and stops at the first stage that fails.
 *
 * ## The defect this refuses
 *
 * A full preflight takes about 35 minutes. Its sub-minute text gates (the CHANGELOG entry, docs lint, the todo index, the
 * route list, the CI-reach check) ran after 26 minutes of standalone test batches, and a failing gate did not end the run:
 * the script went on to the end and listed what failed there. Every preflight failure on 2026-11-16 was one of those cheap
 * gates, learned half an hour late. Flow convention `convention-preflight-cheapest-first-and-parallel`: no-build stages first,
 * then the builds and the gates that read them, then the suites, slowest last; the first failing stage ends the run.
 *
 * ## What it asserts, and where each answer comes from
 *
 * - The order is DATA (`scripts/_shared/preflight-stages.mjs`, `PREFLIGHT_STAGES`, each stage with its kind): kinds never
 *   descend, the CHANGELOG gate is among the `source` stages, and the client unit tests come before the standalone batches.
 *   `stageOrderViolations` is shown to name a planted misorder, built from a copy of the real list (never retyped).
 * - `scripts/preflight.mjs` enters its stages in exactly the list's order: its `begin('<name>')` calls, read as text with
 *   comments stripped, with the two gate loops expanded from the list's own gate tables, equal the list.
 * - The runner stops at the first failure: with an injected list, a failing `source` stage ends the run before the `test`
 *   stage's body starts, and `onStop` is told every stage that did not run. A stage entered out of order, or never entered,
 *   throws.
 * - End to end: the REAL `scripts/preflight.mjs`, run in a scratch folder whose CHANGELOG gate is planted to fail, exits 1
 *   at that gate, names it, lists the stages it did not run, and starts neither the server build nor any test batch (a
 *   sentinel file each would write is absent), under `--static` as well.
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

const STAGES_MODULE = pathToFileURL(join(REPO_ROOT, 'scripts/_shared/preflight-stages.mjs')).href;
const PREFLIGHT = join(REPO_ROOT, 'scripts/preflight.mjs');
/** Imported inside each test, so a base without the module fails each test for the missing module and not the whole file at load. */
const stagesModule = () => import(STAGES_MODULE);

/** The project's scratch root, made to exist (it is outside the checkout, and a fresh machine may not have it yet). */
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };

describe('the stage list is data, cheapest kind first', () => {
  it('lists no kind after a costlier one, and no stage twice', async () => {
    const { PREFLIGHT_STAGES, stageOrderViolations } = await stagesModule();
    assert.deepEqual(stageOrderViolations(PREFLIGHT_STAGES), []);
  });

  it('puts the CHANGELOG gate, docs lint and the todo index before the server build, and the build before every suite', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    const at = (name) => {
      const i = PREFLIGHT_STAGES.findIndex(s => s.name === name);
      assert.ok(i >= 0, `${name} is not a stage`);
      return i;
    };
    for (const cheap of ['check-changelog', 'lint:docs', 'todo:check', 'unrun-tests', 'test files parse']) {
      assert.equal(PREFLIGHT_STAGES[at(cheap)].kind, 'source', `${cheap} reads source only and must be a source stage`);
      assert.ok(at(cheap) < at('build:server'), `${cheap} runs after the server build`);
    }
    for (const built of ['audit-route-coverage', 'surface-matrix-audit']) {
      assert.ok(at('build:server') < at(built), `${built} imports server/dist and must run after the build`);
    }
    assert.ok(at('typecheck:client') < at('client unit tests'), 'the client type-check must run before the client unit tests');
    assert.ok(at('client unit tests') < at('test:standalone (offline subset)'), 'the client unit tests (about 4 minutes) must run before the standalone batches (about 26)');
    const firstTest = PREFLIGHT_STAGES.findIndex(s => s.kind === 'test');
    assert.ok(PREFLIGHT_STAGES.slice(0, firstTest).every(s => s.kind !== 'test'));
    assert.ok(PREFLIGHT_STAGES.filter(s => s.kind !== 'test').every(s => PREFLIGHT_STAGES.indexOf(s) < firstTest), 'a non-test stage is listed after a suite');
  });

  it('names a planted misorder: the CHANGELOG gate moved behind the last suite, an unknown kind, a repeated stage', async () => {
    const { PREFLIGHT_STAGES, stageOrderViolations } = await stagesModule();
    const moved = PREFLIGHT_STAGES.filter(s => s.name !== 'check-changelog');
    moved.push(PREFLIGHT_STAGES.find(s => s.name === 'check-changelog'));
    assert.ok(stageOrderViolations(moved).some(v => v.includes('check-changelog') && /after a test stage/.test(v)), stageOrderViolations(moved).join('\n'));
    assert.ok(stageOrderViolations([...PREFLIGHT_STAGES, { name: 'x', kind: 'slow' }]).some(v => v.includes('"slow"')));
    assert.ok(stageOrderViolations([...PREFLIGHT_STAGES, PREFLIGHT_STAGES[0]]).some(v => /listed twice/.test(v)));
  });

  it('marks exactly what a static run leaves out: the client suite, the production build and its budgets', async () => {
    const { PREFLIGHT_STAGES } = await stagesModule();
    assert.deepEqual(PREFLIGHT_STAGES.filter(s => s.static === false).map(s => s.name).sort(), ['build:prod', 'bundle-budgets', 'client unit tests']);
  });
});

describe('scripts/preflight.mjs enters its stages in the list\'s order (the real file, read as text)', () => {
  it('its begin() calls, with the gate loops expanded, are the list', async () => {
    const { PREFLIGHT_STAGES, SOURCE_GATES, BUILT_GATES } = await stagesModule();
    const code = stripComments(readFileSync(PREFLIGHT, 'utf8'));
    // Built fresh: a global regex shared between calls keeps its lastIndex (pitfall-shared-global-regex).
    const token = /\bbegin\(\s*(['"`])([^'"`]+)\1\s*\)|\bof\s+(SOURCE_GATES|BUILT_GATES)\s*\)\s*gate\(/g;
    const entered = [];
    for (const m of code.matchAll(token)) {
      if (m[2]) entered.push(m[2]);
      else entered.push(...(m[3] === 'SOURCE_GATES' ? SOURCE_GATES : BUILT_GATES).map(([name]) => name));
    }
    assert.deepEqual(entered, PREFLIGHT_STAGES.map(s => s.name),
      'the stages preflight.mjs enters, in the order it enters them, are not the stage list: move the code or the list so they agree');
  });

  it('hands every gate it runs through the runner (gate() begins its stage before it runs)', () => {
    const code = stripComments(readFileSync(PREFLIGHT, 'utf8'));
    const body = code.match(/function gate\([^)]*\)\s*\{([^]*?)\n\}/);
    assert.ok(body, 'preflight.mjs no longer declares gate()');
    assert.ok(body[1].search(/\.begin\(\s*name\s*\)/) >= 0 && body[1].search(/\.begin\(\s*name\s*\)/) < body[1].indexOf('run('), 'gate() does not begin its stage before it runs the gate');
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

describe('the real preflight stops at a failing cheap gate, before any build or test batch (end to end)', () => {
  /** Runs preflight.mjs with `args` in a scratch folder whose CHANGELOG gate fails; the build and the todo gate write a sentinel if they start. */
  function planted(args) {
    const dir = mkdtempSync(join(scratchRoot(), 'preflight-stop-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts/unregistered-local-files.mjs'), 'process.exit(0);\n');
      writeFileSync(join(dir, 'scripts/check-changelog.mjs'), "console.log('planted: no [Unreleased] line'); process.exit(1);\n");
      writeFileSync(join(dir, 'scripts/touch.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], '');\n");
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'planted', private: true, type: 'module',
        scripts: {
          'todo:check': 'node scripts/touch.mjs ran-todo-check',
          'build:server': 'node scripts/touch.mjs ran-build-server',
        },
      }));
      const r = spawnSync(process.execPath, [PREFLIGHT, ...args], { cwd: dir, encoding: 'utf8', env: testChildEnv(), timeout: 90_000 });
      return {
        status: r.status,
        out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
        ranTodo: existsSync(join(dir, 'ran-todo-check')),
        ranBuild: existsSync(join(dir, 'ran-build-server')),
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
      for (const stage of ['todo:check', 'build:server', 'surface-matrix-audit', 'test:standalone (offline subset)']) {
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
  }
});
