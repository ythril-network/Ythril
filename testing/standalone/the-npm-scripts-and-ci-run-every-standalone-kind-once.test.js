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
import { loadCi, jobEntries, stepsOf, shellOf } from '../_shared/ci-workflow.mjs';

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

  it('runs each kind in exactly one step', () => {
    const steps = jobEntries(loadCi()).flatMap(({ job }) => stepsOf(job));
    for (const kind of KINDS) {
      const running = steps.filter(s => RUNNER.test(commandOf(s)) && new RegExp(`--only=${kind}\\b`).test(commandOf(s)));
      assert.equal(running.length, 1, `${running.length} step(s) of ci.yml run the ${kind} kind: a file of it runs ${running.length === 0 ? 'nowhere' : 'more than once'}`);
    }
  });
});

describe('the guides', () => {
  for (const guide of ['docs/contribution-guide.md', 'docs/testing-guide.md']) {
    it(`${guide} names the script of each kind`, () => {
      const text = readFileSync(join(REPO_ROOT, guide), 'utf8');
      for (const kind of KINDS) assert.ok(text.includes(`test:standalone:${kind}`), `${guide} never names \`npm run test:standalone:${kind}\``);
    });
  }
});
