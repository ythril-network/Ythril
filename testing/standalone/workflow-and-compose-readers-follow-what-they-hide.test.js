/**
 * The shared readers of a CI workflow and of a compose file read what a plain look at them misses, and refuse what they
 * cannot read instead of returning less (bundle-56 dedup, items 1 and 10).
 *
 * ## What each row pins
 *
 * - **A command moved into a local composite action is still seen.** `ci.yml` job steps `uses: ./.github/actions/<name>`
 *   run that action's `run:` scripts; a reader of `step.run` alone sees a step that runs nothing. `unrun-tests` read that
 *   as "no selection" (or, for one command among several, as the files it selects being unrun), a start-set read it as
 *   "no stack". `shellOf` follows the action, so every consumer — `unrun-tests`, `compose-start-sets`, the search-process
 *   gate, the flags gate — sees the move, and the rows below show two of them do.
 * - **A local action it cannot read is a failure.** A missing `action.yml` or an action that uses itself throws; an empty
 *   script would pass every rule written over it.
 * - **"Does this run `docker compose up`" has one answer**, the same one the start-set reader uses: `config --images |
 *   grep up` is not a start, `docker-compose up` is.
 * - **A compose value has one resolver and one size parser**: a `${VAR:-default}` anywhere in a value means its default,
 *   a size in MiB means one number whatever the gate that asks, and a size nobody can read is a throw.
 *
 * Run: node --test testing/standalone/workflow-and-compose-readers-follow-what-they-hide.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { shellOf, parseWorkflow, CI_WORKFLOW } from '../_shared/ci-workflow.mjs';
import { CI_WORKFLOW as CI_WORKFLOW_PATH } from '../_shared/ci-workflow-path.mjs';
import { startSets, stackJobs, startsComposeStack, upCommands } from '../_shared/compose-start-sets.mjs';
import { loadCompose, resolveDefaults, resolvedValue, isOverridable, memoryMiB, environmentOf } from '../_shared/compose-file.mjs';
import { makeCiRoot } from './_ci-root-fixture.mjs';
import { unrunTests } from '../../scripts/unrun-tests.mjs';

const composite = (...runs) => `name: x\ndescription: y\nruns:\n  using: composite\n  steps:\n${runs.map(r => `    - shell: bash\n      run: ${r}\n`).join('')}`;

describe('shellOf follows a local composite action', () => {
  let root;
  const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  before(() => { root = mkdtempSync(join(tmpdir(), 'ythril-local-actions-')); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('a step that runs a script is its script, comments gone and continuations joined', () => {
    assert.match(shellOf({ run: '# a comment\nnpm ci \\\n  --ignore-scripts\n' }), /^npm ci\s+--ignore-scripts\s*$/);
  });

  it('a step that uses a remote action runs no script of ours', () => {
    assert.equal(shellOf({ uses: 'actions/checkout@v4' }), '');
  });

  it('the repository\'s real failure-dump action is seen: its `docker cp` belongs to the step that uses it', () => {
    const script = shellOf({ uses: './.github/actions/dump-test-stack-logs' });
    assert.match(script, /docker cp\b/);
  });

  it('an action that uses another local action is followed, to any depth', () => {
    write('.github/actions/outer/action.yml', `name: o\ndescription: o\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo outer\n    - uses: ./.github/actions/inner\n`);
    write('.github/actions/inner/action.yml', composite('echo inner'));
    const script = shellOf({ uses: './.github/actions/outer' }, { root });
    assert.match(script, /echo outer/);
    assert.match(script, /echo inner/);
  });

  it('a local action that is not composite runs no shell', () => {
    write('.github/actions/js/action.yml', 'name: j\ndescription: j\nruns:\n  using: node20\n  main: index.js\n');
    assert.equal(shellOf({ uses: './.github/actions/js' }, { root }), '');
  });

  it('a local action that does not exist is a failure, not an empty script', () => {
    assert.throws(() => shellOf({ uses: './.github/actions/nope' }, { root }), /no action\.yml/);
  });

  it('a local action that uses itself is refused', () => {
    write('.github/actions/loop/action.yml', `name: l\ndescription: l\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/loop\n`);
    assert.throws(() => shellOf({ uses: './.github/actions/loop' }, { root }), /uses itself/);
  });
});

describe('the consumers read a command that lives in a composite action', () => {
  let ci;
  before(() => { ci = makeCiRoot(); });
  after(() => ci.dispose());

  const TEST_FILE = "import { it } from 'node:test';\nit('registers', () => {});\n";
  const BENCH = 'testing/bench/only-a-composite-runs-me.test.js';
  const ACTION = '.github/actions/run-bench/action.yml';
  const addBench = { [BENCH]: TEST_FILE, [ACTION]: composite(`node --test ${BENCH}`) };
  const useIt = { [CI_WORKFLOW_PATH]: (t) => t.replace(/^(\s*)- name: Checkout\r?\n/m, '$1- uses: ./.github/actions/run-bench\n$1- name: Checkout\n') };

  it('unrun-tests: a test file only a composite action runs is not unrun', () => {
    ci.with({ add: addBench, replace: useIt }, () => {
      assert.ok(!unrunTests(ci.root).unrun.includes(BENCH), 'the composite action\'s `node --test` was not read');
    });
  });

  it('unrun-tests: the same file IS unrun while no job uses the action — an action alone selects nothing', () => {
    ci.with({ add: addBench }, () => {
      assert.ok(unrunTests(ci.root).unrun.includes(BENCH));
    });
  });

  it('a start set: a `docker compose up` in a composite action starts its stack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ythril-up-action-'));
    try {
      mkdirSync(join(dir, '.github/actions/up'), { recursive: true });
      writeFileSync(join(dir, '.github/actions/up/action.yml'), composite('docker compose -f t.yml up -d app'));
      const compose = { services: { app: { depends_on: { db: {} } }, db: {}, other: {} } };
      const workflow = parseWorkflow('on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/up\n', 'fixture');
      assert.deepEqual(stackJobs(workflow, { root: dir }).map(j => j.id), ['j']);
      assert.deepEqual(startSets(compose, workflow, { root: dir }).find(s => s.label === 'CI job j')?.services, ['app', 'db']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('"does this run docker compose up" has one answer', () => {
  it('a start is one, in either spelling, with options before `up`', () => {
    assert.ok(startsComposeStack('docker compose -p x -f t.yml --profile office up -d --wait'));
    assert.ok(startsComposeStack('docker-compose up -d'));
    assert.ok(startsComposeStack('set -e\ndocker compose up -d $SERVICES'), 'an unreadable service list still starts a stack');
  });

  it('a command that merely mentions up, or starts nothing, is not one', () => {
    assert.ok(!startsComposeStack('docker compose config --images | grep up'));
    assert.ok(!startsComposeStack('docker compose -f t.yml build app'));
    assert.ok(!startsComposeStack('docker compose down'));
  });

  it('what a start names is read from the same match', () => {
    assert.deepEqual(upCommands('docker compose --profile=extra up -d --wait-timeout 300 app'), [{ profiles: ['extra'], services: ['app'] }]);
  });
});

describe('a compose value is resolved and measured one way', () => {
  it('a default is its default wherever the variable stands in the value', () => {
    assert.equal(resolveDefaults('${YTHRIL_TEST_MONGO_A_MEM:-3072m}'), '3072m');
    assert.equal(resolveDefaults('-Xmx${HEAP:-1280m} -Xms${lower:-64m}'), '-Xmx1280m -Xms64m');
    assert.equal(resolveDefaults('${SIDECAR_BIND:-127.0.0.1}:8100:8100'), '127.0.0.1:8100:8100');
    assert.equal(resolveDefaults('plain'), 'plain');
    assert.equal(resolveDefaults(512), '512');
  });

  it('only a whole-value default is overridable', () => {
    assert.ok(isOverridable('${X_MEM:-2g}'));
    assert.ok(!isOverridable('2g'));
    assert.ok(!isOverridable(undefined));
    assert.ok(!isOverridable('${X:-2g}-and-more'));
  });

  it('a declared value is resolved, an absent one is null', () => {
    assert.equal(resolvedValue({ mem_limit: ' ${M:-1344m} ' }, 'mem_limit'), '1344m');
    assert.equal(resolvedValue({ cpus: 1.5 }, 'cpus'), '1.5');
    assert.equal(resolvedValue({}, 'cpus'), null);
    assert.equal(resolvedValue(undefined, 'cpus'), null);
  });

  it('a size is MiB whatever unit or default wrote it, and an unreadable one throws', () => {
    assert.equal(memoryMiB('1280m'), 1280);
    assert.equal(memoryMiB('3g'), 3072);
    assert.equal(memoryMiB('1.5GB'), 1536);
    assert.equal(memoryMiB('2048k'), 2);
    assert.equal(memoryMiB('"512m"'), 512);
    assert.equal(memoryMiB('${YTHRIL_TEST_MONGO_A_MEM:-3072m}'), 3072);
    assert.throws(() => memoryMiB('lots'), /unreadable memory value/);
    assert.throws(() => memoryMiB(''), /unreadable memory value/);
  });

  it('an environment is a map whether compose was given a map or a list', () => {
    assert.deepEqual(environmentOf({ environment: { A: 'x', B: 1 } }), { A: 'x', B: 1 });
    assert.deepEqual(environmentOf({ environment: ['A=x', 'B=y=z', 'C'] }), { A: 'x', B: 'y=z', C: '' });
    assert.deepEqual(environmentOf({}), {});
  });

  it('a compose file with no services is a failure, and the real ones load with theirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ythril-compose-'));
    try {
      writeFileSync(join(dir, 'empty.yml'), 'name: x\n');
      assert.throws(() => loadCompose('empty.yml', dir), /compose file with services/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(Object.keys(loadCompose('docker-compose.yml').services).length >= 5);
    assert.ok(Object.keys(loadCompose('testing/docker-compose.test.yml').services).length >= 9);
  });

  it('the CI workflow path is one string, whichever module names it', () => {
    assert.equal(CI_WORKFLOW, CI_WORKFLOW_PATH);
  });
});
