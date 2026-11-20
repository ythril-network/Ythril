/**
 * Between the npm scripts and the CI workflow, every kind of standalone file runs, once each (Q-870, bundle-316 sweep F1).
 *
 * ## The defect this refuses
 *
 * Once the text-only files became a kind of their own (`text`, `pure`, `db`, instance), `npm run test:standalone:pure` ran the pure kind WITHOUT them, and no
 * npm script ran `--only=text`: a developer who followed the guide (`npm run build:server && npm run test:standalone:pure`) skipped every text-only file and got a
 * green result. CI was right (a step runs the text kind first, the pure script second), so only the by-hand path was wrong, and nothing said so.
 *
 * ## What is asserted
 *
 * - The runner's kinds (its `THIRDS`) are exactly text, pure, db and instance, and each has ONE npm script that runs it alone (`--only=<kind>`), named
 *   `test:standalone:<kind>`; `test:standalone` has no `--only`, so it runs them all, once.
 * - In `ci.yml`, each kind is run by exactly one step, directly or through its npm script: none twice (a file would run twice), none missing.
 *   A step of a matrix job runs in every cell (bundle-356, Q-947: the pure job became a matrix of two shards), so it counts once only when
 *   it runs the cell's own shard (it reads `matrix.<axis>`) or its `if` pins it to one value of the matrix; the text step is pinned to the
 *   first shard, and a text step left unpinned counts twice.
 * - Both guides name each of the four scripts, so a developer is told which one runs which kind.
 *
 * Run: node --test testing/standalone/the-npm-scripts-and-ci-run-every-standalone-kind-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { loadCi, parseWorkflow, jobEntries, stepsOf, shellOf, expressionOf } from '../_shared/ci-workflow.mjs';

const KINDS = ['text', 'pure', 'db', 'instance'];
const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
const RUNNER = /run-standalone\.mjs\b/;

describe('the standalone kinds', () => {
  it('are the runner\'s own list, text, pure, db and instance', () => {
    const runner = stripComments(readFileSync(join(REPO_ROOT, 'testing/_init/run-standalone.mjs'), 'utf8'));
    const listed = /const THIRDS = \[([^\]]*)\]/.exec(runner)?.[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
    assert.deepEqual(listed, KINDS, 'the runner knows other kinds than this gate: re-anchor it, and give the new kind a script and a CI step');
  });

  it('each have one npm script that runs them alone, and test:standalone runs all of them', () => {
    for (const kind of KINDS) {
      const runs = Object.entries(scripts).filter(([, cmd]) => RUNNER.test(cmd) && new RegExp(`--only=${kind}\\b`).test(cmd)).map(([name]) => name);
      assert.deepEqual(runs, [`test:standalone:${kind}`], `the ${kind} kind has ${runs.length} npm script(s) that run it alone (${runs.join(', ') || 'none'}), not exactly test:standalone:${kind}`);
    }
    assert.ok(RUNNER.test(scripts['test:standalone']) && !/--only=/.test(scripts['test:standalone']), 'test:standalone does not run every kind (it names --only, or not the runner)');
  });
});

describe('ci.yml', () => {
  /** What a step runs of the standalone runner: its own command, and the body of each npm script it names. */
  const commandOf = (step) => {
    const shell = shellOf(step);
    return [shell, ...[...shell.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)].map(m => scripts[m[1]] ?? '')].join('\n');
  };

  /**
   * How many times a step runs the files it names across its job's matrix (bundle-356, Q-947). A job without a matrix runs it once. In a
   * matrix job every step runs in every cell, so a step runs its files once only when it reads the matrix (its command or env names
   * `matrix.<axis>`: each cell runs that cell's shard, and the shard gates hold that the shards are a partition), or when its `if` pins it
   * to one value of an axis the matrix has. Anything else runs its files once per cell.
   */
  const timesRun = (job, step) => {
    const axes = Object.entries(job.strategy?.matrix ?? {}).filter(([, v]) => Array.isArray(v));
    if (axes.length === 0) return 1;
    if (/\bmatrix\.[\w-]+/.test(`${shellOf(step)}\n${JSON.stringify(step.env ?? {})}`)) return 1;
    const condition = step.if == null ? '' : expressionOf(step.if).trim();
    const pinned = axes.some(([axis, values]) => {
      const m = new RegExp(`^matrix\\.${axis}\\s*==\\s*'?([\\w.-]+)'?$`).exec(condition);
      return m && values.map(String).includes(m[1]);
    });
    return pinned ? 1 : axes.reduce((n, [, values]) => n * values.length, 1);
  };

  /** Per kind, how many times ci.yml (or `doc`) runs it: the sum of `timesRun` over the steps that run it. */
  const runsPerKind = (doc) => Object.fromEntries(KINDS.map(kind => [kind, jobEntries(doc).flatMap(({ job }) => stepsOf(job)
    .filter(s => RUNNER.test(commandOf(s)) && new RegExp(`--only=${kind}\\b`).test(commandOf(s))).map(s => timesRun(job, s))).reduce((a, b) => a + b, 0)]));

  it('runs each kind once: in exactly one step, and in one cell of a matrix unless the step runs that cell\'s shard', () => {
    const runs = runsPerKind(loadCi());
    for (const kind of KINDS) {
      assert.equal(runs[kind], 1, `ci.yml runs the ${kind} kind ${runs[kind]} time(s): a file of it runs ${runs[kind] === 0 ? 'nowhere' : 'more than once'}`);
    }
  });

  describe('the count, over a miniature with the pure job as a matrix of two', () => {
    const mini = ({ textIf = '        if: matrix.shard == 1\n', pureEnv = '        env:\n          PURE_SHARD: ${{ matrix.shard }}/2\n', pureArg = ' -- --shard="$PURE_SHARD"' } = {}) => parseWorkflow(`
on: push
jobs:
  pure:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - name: Text
${textIf}        run: node testing/_init/run-standalone.mjs --only=text
      - name: Pure
        run: npm run test:standalone:pure${pureArg}
${pureEnv}  db:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:standalone:db
      - run: npm run test:standalone:instance
`);
    it('counts each kind once for the conforming shape', () => assert.deepEqual(runsPerKind(mini()), { text: 1, pure: 1, db: 1, instance: 1 }));
    it('counts the text kind twice when its step is not pinned to one cell', () => assert.equal(runsPerKind(mini({ textIf: '' })).text, 2));
    it('counts the text kind twice when its pin names a value the matrix does not have', () => assert.equal(runsPerKind(mini({ textIf: '        if: matrix.shard == 3\n' })).text, 2));
    it('counts the pure kind twice when its step does not take the cell\'s shard', () => assert.equal(runsPerKind(mini({ pureEnv: '', pureArg: '' })).pure, 2));
  });
});

describe('the testing guide', () => {
  const guide = 'docs/testing-guide.md';
  it(`${guide} names the script of each kind`, () => {
    const text = readFileSync(join(REPO_ROOT, guide), 'utf8');
    for (const kind of KINDS) assert.ok(text.includes(`test:standalone:${kind}`), `${guide} never names \`npm run test:standalone:${kind}\``);
  });
});
