/**
 * A standalone test that declares itself CI-only runs in some CI job, so the marker can never mean "runs nowhere" (Q-624 round I1b).
 *
 * ## What it prevents
 *
 * Preflight's pure batches leave out a file whose header says `@ci-only` (`testing/_shared/standalone-split.mjs`, `offlineRuns(split, { ciOnly: false })`),
 * because it is too slow, or too sensitive to a loaded machine, to run at every push. Excluding a file from the one place a developer runs it is exactly
 * how a test stops running anywhere with every job green:
 *
 *  - **The marker on a file that is not a pure one.** A `@needs-instance` or a database file is already in another third; a marker there says nothing a
 *    reader can act on, and one on a file the split does not list is a typo that excludes nothing.
 *  - **A `@ci-only` file missing from the CI plan.** The default plan (`offlineRuns(split)`, what `test:standalone` and CI run) must hold every one in a pure
 *    batch, and preflight's plan (`ciOnly: false`) must hold none, or the marker does not do what it says in one direction or the other.
 *  - **No CI job that runs the pure third.** The job is the one whose steps run `npm run test:standalone:pure`, found in the PARSED workflow, and the merge
 *    gate (`Build & Test`) must need it and check its result, or a red `@ci-only` file blocks nothing.
 *  - **The runner that does not take the plan.** `test:standalone:pure` runs `run-standalone.mjs --only=pure`, which must run `offlineRuns(split)` with
 *    no `ciOnly: false`.
 *
 * The set is derived (`splitStandalone().ciOnly`), with a floor: an empty set passes every loop written over it.
 *
 * Run: node --test testing/standalone/a-ci-only-test-runs-in-a-ci-job.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitStandalone, offlineRuns } from '../_shared/standalone-split.mjs';
import { loadCi, jobEntries, stepsOf, shellOf, mergeGateEntries, transitiveNeeds } from '../_shared/ci-workflow.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const PURE_SCRIPT = 'test:standalone:pure';
const split = splitStandalone({ root: REPO_ROOT });
const planned = (plan) => new Set(plan.filter(r => r.kind === 'pure').flatMap(r => r.files.map(f => f.split('/').pop())));

describe('a @ci-only file runs in a CI job', () => {
  it('there is at least one, and each is a pure file the split lists', () => {
    assert.ok(split.ciOnly.length >= 1, 'no file declares @ci-only: the marker is read from nothing, or the one file that needs it lost it');
    for (const f of split.ciOnly) {
      assert.ok(split.offlinePure.includes(f), `${f} declares @ci-only and is not a pure standalone file (it is a database or instance file, or not listed): the marker excludes nothing`);
    }
  });

  it('the default plan runs every one in a pure batch, and preflight\'s plan runs none', () => {
    const everywhere = planned(offlineRuns(split));
    const preflight = planned(offlineRuns(split, { ciOnly: false }));
    for (const f of split.ciOnly) {
      assert.ok(everywhere.has(f), `${f} is @ci-only and the default plan (test:standalone, CI) does not run it: it runs nowhere`);
      assert.ok(!preflight.has(f), `${f} is @ci-only and preflight's plan still runs it`);
    }
    assert.equal(everywhere.size - preflight.size, split.ciOnly.length, 'preflight leaves out something other than the @ci-only files, or the default plan lacks a pure file');
  });

  it('a CI job runs the pure third, and the merge gate needs it and checks its result', () => {
    const doc = loadCi();
    const jobs = jobEntries(doc).filter(({ job }) => stepsOf(job).some(s => shellOf(s).includes(PURE_SCRIPT)));
    assert.equal(jobs.length, 1, `${jobs.length} CI job(s) run ${PURE_SCRIPT} (${jobs.map(j => j.id).join(', ')}): exactly one is where a @ci-only file runs`);
    const [{ id }] = jobs;
    const gates = mergeGateEntries(doc);
    assert.ok(gates.length >= 1, 'no merge gate job found');
    for (const gate of gates) {
      assert.ok(transitiveNeeds(doc, gate.id).has(id), `the merge gate does not wait for ${id}: a red @ci-only file would block nothing`);
      const text = stepsOf(gate.job).map(s => shellOf(s)).join('\n');
      assert.match(text, new RegExp(`check\\s+${id}\\s+"\\$\\{\\{\\s*needs\\.${id}\\.result\\s*\\}\\}"`), `the merge gate does not check ${id}'s result`);
    }
  });

  it('the pure runner runs the plan with the @ci-only files in it', () => {
    const runner = stripComments(readFileSync(join(REPO_ROOT, 'testing/_init/run-standalone.mjs'), 'utf8'));
    assert.match(runner, /offlineRuns\(split\)/, 'run-standalone.mjs does not run `offlineRuns(split)`');
    assert.doesNotMatch(runner, /ciOnly\s*:\s*false/, 'run-standalone.mjs leaves the @ci-only files out: CI would never run them');
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.match(pkg.scripts[PURE_SCRIPT], /run-standalone\.mjs\s+--only=pure/, `${PURE_SCRIPT} is not the pure third of the standalone runner`);
  });

  it('preflight is the one plan that leaves them out, and says so', () => {
    const preflight = stripComments(readFileSync(join(REPO_ROOT, 'scripts/preflight.mjs'), 'utf8'));
    assert.match(preflight, /offlineRuns\(\s*\w+\s*,\s*\{\s*ciOnly\s*:\s*false\s*\}\s*\)/, 'preflight does not leave the @ci-only files out of its plan');
  });
});
