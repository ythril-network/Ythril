/**
 * No build step downloads the CUDA execution provider — not CI, not the image.
 *
 * ## Why this is a gate and not a comment
 *
 * `onnxruntime-node` fetches its CUDA binaries from a GitHub release on postinstall. On a machine with no
 * `nvcc` it logs *"nvcc not found. Assuming CUDA 12"* and downloads the GPU tarball **anyway**. Two CI runs
 * failed 35 minutes apart on that download alone, which is what put `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` on
 * both `npm ci` steps in the workflows.
 *
 * The Dockerfile was left out at the time and parked as P-5, because skipping it in the image is a product
 * decision rather than a build fix: a GPU deployment loses the execution provider and would need its own
 * image variant. Owner ruled A on 2026-08-15 — skip it there too. Nothing in the published image uses it; the
 * bundled embedder runs on CPU.
 *
 * A build that reaches github.com for a tarball nothing loads is a build that fails for a reason unrelated to
 * the change being built, and the image build is the one most likely to run somewhere with neither a fast nor
 * a reliable route there.
 *
 * ## What it checks, and the trap it is built around
 *
 * Every `npm ci` in the Dockerfile must be preceded by the skip. `ENV` does **not** cross a stage boundary, so
 * one declaration at the top would silently cover only the first stage — exactly the kind of thing a reader
 * assumes and a build disproves quietly, by working on a fast connection.
 *
 * Run: node --test testing/standalone/cuda-download-is-skipped-everywhere.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadAllWorkflows, parseWorkflow, jobEntries, stepsOf, runsNpmCi, shellOf } from '../_shared/ci-workflow.mjs';

const SKIP = 'ONNXRUNTIME_NODE_INSTALL_CUDA';
const read = (p) => readFileSync(p, 'utf8');

/**
 * Every `npm ci` step of a workflow that does not have the skip in force — read from the PARSED workflow, per step.
 *
 * "In force" is the step's own `env`, its job's, or the workflow's: the three places GitHub resolves it from. It is
 * asked of EACH install because the question is per install, and per JOB because a workflow that grows from one job
 * to several carries the trap the Dockerfile's stages do: a declaration beside the first install says nothing about
 * the install in the job added next to it. The previous form of this gate asked whether the file's TEXT contained
 * `ONNXRUNTIME_NODE_INSTALL_CUDA: skip` anywhere, which a comment, a different job or an `echo` satisfies.
 */
function npmCiWithoutSkip(doc, label) {
  const inForce = (env) => env != null && String(env[SKIP]) === 'skip';
  const found = { installs: 0, unguarded: [] };
  for (const { id, job } of jobEntries(doc)) {
    for (const step of stepsOf(job)) {
      if (!runsNpmCi(step)) continue;
      found.installs++;
      if (inForce(step.env) || inForce(job.env) || inForce(doc.env)) continue;
      found.unguarded.push(`${label} job ${id}, step "${step.name ?? shellOf(step).trim().split('\n')[0]}"`);
    }
  }
  return found;
}

/** Dockerfile lines, comments dropped — a `#` line naming the variable must not satisfy the check. */
const dockerLines = () =>
  read('Dockerfile').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('the CUDA download is skipped in every build', () => {
  it('every npm ci in the Dockerfile has the skip in force', () => {
    // Walked in order and reset at each FROM, because ENV does not survive a stage boundary. Checking mere
    // PRESENCE anywhere in the file would pass on one declaration covering one of three stages.
    const lines = dockerLines();
    let active = false;
    const unguarded = [];
    for (const l of lines) {
      if (/^FROM\s/i.test(l)) { active = false; continue; }
      if (new RegExp(`^ENV\\s+${SKIP}\\s*=\\s*skip`, 'i').test(l)) { active = true; continue; }
      if (/^RUN\s+.*npm ci/.test(l) && !active && !l.includes(SKIP)) unguarded.push(l);
    }
    assert.deepEqual(unguarded, [], `these run npm ci with the CUDA download still enabled:\n  ${unguarded.join('\n  ')}`);
  });

  it('finds the npm ci steps at all — the scanner before the property', () => {
    const count = dockerLines().filter((l) => /^RUN\s+.*npm ci/.test(l)).length;
    assert.ok(count >= 3, `parsed only ${count} npm ci steps — the scanner is wrong, not the Dockerfile`);
  });

  it('every install of every workflow has the skip in force, job by job', () => {
    // The half that was already true, re-asserted: this gate exists because the setting was applied in one
    // place and not another, and a gate that only watches the new place would let the old one lapse. It is
    // asked of every `npm ci` in every job, because `ci.yml` is no longer one job.
    const per = loadAllWorkflows().map(({ file, doc }) => ({ file, ...npmCiWithoutSkip(doc, file) }));
    const withCi = per.filter((p) => p.installs > 0);
    assert.ok(withCi.length >= 2, `expected at least two workflows running npm ci, found ${withCi.length}`);
    const unguarded = per.flatMap((p) => p.unguarded);
    assert.deepEqual(unguarded, [], `these installs run with the CUDA download still enabled:\n  ${unguarded.join('\n  ')}`);
  });
});

describe('the workflow scanner, against the shapes that fooled the text match', () => {
  const wf = (jobs, top = '') => parseWorkflow(`on: push\n${top}jobs:\n${jobs}`, 'fixture');
  const job = (id, steps) => `  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  const withSkip = `        env:\n          ${SKIP}: skip\n`;
  const unguarded = (doc) => npmCiWithoutSkip(doc, 'f').unguarded;

  it('a step-level, a job-level and a workflow-level skip each count', () => {
    assert.deepEqual(unguarded(wf(job('a', `      - run: npm ci\n${withSkip}`))), []);
    assert.deepEqual(unguarded(wf(`  a:\n    runs-on: x\n    env:\n      ${SKIP}: skip\n    steps:\n      - run: npm ci\n`)), []);
    assert.deepEqual(unguarded(wf(job('a', '      - run: npm ci\n'), `env:\n  ${SKIP}: skip\n`)), []);
  });

  it('a job added beside a guarded one is flagged — the text match saw the first job and passed', () => {
    const doc = wf(job('a', `      - run: npm ci\n${withSkip}`) + job('b', '      - run: npm ci --workspace=client\n'));
    assert.equal(unguarded(doc).length, 1);
    assert.match(unguarded(doc)[0], /job b/);
  });

  it('the variable named in a comment, an echo or another step satisfies nothing', () => {
    const doc = wf(job('a', `      # ${SKIP}: skip\n      - run: 'echo "${SKIP}: skip"'\n      - run: npm ci\n`));
    assert.equal(unguarded(doc).length, 1);
  });

  it('a different value is not the skip', () => {
    const doc = wf(job('a', `      - run: npm ci\n        env:\n          ${SKIP}: download\n`));
    assert.equal(unguarded(doc).length, 1);
  });

  it('npm ci in a comment line of a script is not an install, and `npm run ci-check` is not npm ci', () => {
    const doc = wf(job('a', '      - run: |\n          # npm ci happens elsewhere\n          npm run ci-check\n'));
    assert.deepEqual(npmCiWithoutSkip(doc, 'f'), { installs: 0, unguarded: [] });
  });
});
