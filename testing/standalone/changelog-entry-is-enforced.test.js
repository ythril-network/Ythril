/**
 * The CHANGELOG rule is enforced by CI, not by memory.
 *
 * ## The finding — Documentation & DX audit lens
 *
 * The house rule is an `[Unreleased]` entry for every user-facing change, and it was being followed — **28 PRs in the
 * batch that added this check, every one with an entry**. Nothing enforced it. A rule kept alive by memory alone is one
 * distracted afternoon from lapsing, and the lapse is **invisible**: nobody notices the entry that was never written.
 *
 * ## What the check does, and the two decisions inside it
 *
 * A diff touching `server/src/` or `client/src/` must add at least one line **inside the `[Unreleased]` section**.
 *
 * **Inside the section, not merely "the file changed".** Touching `CHANGELOG.md` is easy to satisfy by accident — a
 * typo fix in a released section would pass while the actual change went unrecorded.
 *
 * **Exempt by path, with no "skip changelog" marker.** Tests, `docs/`, `scripts/`, `todo/`, workflows and any
 * `*.spec.ts` change without changing what a user gets. A marker in a PR title leaves no record and gets used the
 * moment it is inconvenient; if a source change genuinely has no user-facing effect, one CHANGELOG line saying so is
 * cheap and records that somebody considered the question.
 *
 * ## Why this gate exists on top of the CI step
 *
 * The step can be deleted, renamed, or quietly made conditional, and nothing else in the tree would notice. This
 * pins the wiring — including `fetch-depth: 0`, without which `base...HEAD` has no merge base, the diff errors, and
 * a check that cannot run reports success. That last part is the failure mode the whole exercise exists to prevent,
 * so the script itself must fail hard in CI when it cannot diff.
 *
 * Run: node --test testing/standalone/changelog-entry-is-enforced.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { blockAfter } from './_structural-window.mjs';
import {
  MERGE_GATE_NAME, loadCi, parseWorkflow, jobEntries, stepsOf, shellOf, usesOf, expressionOf, transitiveNeeds,
} from '../_shared/ci-workflow.mjs';
import { GOOD_CI } from '../_shared/ci-workflow-fixture.mjs';

const SCRIPT_PATH = join('scripts', 'check-changelog.mjs');
const SCRIPT = existsSync(SCRIPT_PATH) ? readFileSync(SCRIPT_PATH, 'utf8') : '';

/**
 * The script with comments removed.
 *
 * Every assertion about behaviour reads THIS, not `SCRIPT`. The script's docstring necessarily quotes the things it
 * forbids and the paths it exempts, so matching the raw text let two assertions pass on prose: the exemption check
 * found `testing/` in a sentence, and the no-escape-hatch check fired on the paragraph explaining why there is none.
 * Sixth time in this batch that a gate read its own documentation as code.
 */
const CODE = SCRIPT.replace(/^[ 	]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('CI runs the check', () => {
  it('the script exists', () => {
    assert.ok(SCRIPT.length > 500, 'scripts/check-changelog.mjs is missing or a stub');
  });

  it('the workflow runs it once, on pull requests only, from a checkout with full history, in a job the merge gate waits for', () => {
    const found = changelogWiringViolations(loadCi());
    assert.deepEqual(found, [], found.join('\n'));
  });
});

/**
 * What is wrong with how a workflow runs the check, read from the PARSED workflow. Empty when nothing is.
 *
 * Four properties, each of which a green build can lose without anything else noticing:
 *
 *  - **once, PR-only.** A push to main has no base to diff against and the entry was already required of the PR.
 *  - **a checkout with `fetch-depth: 0` BEFORE it, in the SAME job.** Without full history `base...HEAD` has no merge
 *    base, the diff errors, and a check that cannot run reports success. "The first checkout in the file" was the old
 *    form of this and means a different job's checkout the moment the file has more than one.
 *  - **in a job that is not conditional.** A skipped job runs no check and reads as passing.
 *  - **in a job the merge gate waits for.** A step in a job nothing waits for is a red X that merges anyway; the
 *    rule is enforced by CI only if CI's required check depends on the job that runs it.
 */
function changelogWiringViolations(doc) {
  const hits = [];
  for (const { id, job } of jobEntries(doc)) {
    stepsOf(job).forEach((s, i) => { if (/node\s+scripts\/check-changelog\.mjs/.test(shellOf(s))) hits.push({ id, job, i, s }); });
  }
  if (hits.length !== 1) return [`${hits.length} steps run scripts/check-changelog.mjs; exactly one`];
  const { id, job, i, s } = hits[0];
  const v = [];
  if (expressionOf(s.if) !== "github.event_name == 'pull_request'") {
    v.push(`the step's condition is \`${s.if ?? '(none)'}\`; it must be PR-only: a push to main has no base to diff against`);
  }
  if (job.if != null) v.push(`the job ${id} has a condition (\`${job.if}\`): a skipped job runs no check and reads as passing`);
  const checkouts = stepsOf(job).slice(0, i).filter((x) => usesOf(x)?.action === 'actions/checkout');
  if (!checkouts.length) v.push(`job ${id} has no checkout before the check`);
  for (const c of checkouts) {
    if (String(c.with?.['fetch-depth']) !== '0') {
      v.push(`a checkout before the check has fetch-depth ${c.with?.['fetch-depth'] ?? '(default 1)'}: base...HEAD then has no merge base and the check silently no-ops`);
    }
  }
  const gate = jobEntries(doc).find((j) => j.name === MERGE_GATE_NAME);
  if (!gate) v.push(`no job is named "${MERGE_GATE_NAME}"`);
  else if (id !== gate.id && !transitiveNeeds(doc, gate.id).has(id)) {
    v.push(`job ${id} runs the check but "${MERGE_GATE_NAME}" does not wait for it: a missing entry fails nothing that blocks a merge`);
  }
  return v;
}

describe('the wiring check itself, held to a conforming workflow and to each way of losing the rule', () => {
  const GOOD = parseWorkflow(GOOD_CI, 'the conforming fixture');
  const withChange = (mutate) => { const d = structuredClone(GOOD); mutate(d); return changelogWiringViolations(d); };
  const checkStep = (d) => d.jobs.prepare.steps.find((x) => /check-changelog/.test(x.run ?? ''));

  it('the conforming shape is clean', () => assert.deepEqual(changelogWiringViolations(GOOD), []));

  const CASES = [
    ['the checkout is shallow', (d) => { delete d.jobs.prepare.steps[0].with; }, /fetch-depth/],
    ['the checkout is depth 1 explicitly', (d) => { d.jobs.prepare.steps[0].with = { 'fetch-depth': 1 }; }, /fetch-depth 1/],
    ['the checkout is in another job than the check', (d) => { d.jobs.prepare.steps.shift(); }, /no checkout before the check/],
    ['the step runs on pushes too', (d) => { delete checkStep(d).if; }, /PR-only/],
    ['the step runs on pushes to main only', (d) => { checkStep(d).if = "github.event_name == 'push'"; }, /PR-only/],
    ['the job is conditional', (d) => { d.jobs.prepare.if = "github.event_name == 'push'"; }, /has a condition/],
    ['the step is run twice', (d) => { d.jobs.prepare.steps.push(structuredClone(checkStep(d))); }, /exactly one/],
    ['the step is gone', (d) => { d.jobs.prepare.steps = d.jobs.prepare.steps.filter((x) => x !== checkStep(d)); }, /exactly one/],
    ['the gate stops waiting for the job that runs it', (d) => {
      d.jobs.test.needs = d.jobs.test.needs.filter((n) => n !== 'prepare');
      for (const id of ['standalone', 'integration', 'sync']) d.jobs[id].needs = 'client-tests';
    }, /does not wait for it/],
  ];
  for (const [what, mutate, expected] of CASES) {
    it(`flags: ${what}`, () => {
      const found = withChange(mutate);
      assert.ok(found.some((m) => expected.test(m)), `wanted ${expected}, got ${JSON.stringify(found)}`);
    });
  }
});

describe('the check cannot pass vacuously', () => {
  it('a diff that fails is a hard failure in CI', () => {
    assert.match(CODE, /process\.env\['CI'\]/,
      'the script must distinguish CI from a local run: skipping is fine locally, never in CI');
    const at = CODE.indexOf("if (process.env['CI'])");
    assert.ok(at > 0, 'the CI branch is gone');
    // Bounded by the NEXT statement, not by the first `}` — that one closes a `${...}` inside a template literal, so
    // the slice ended before `process.exit(1)` and the assertion failed against correct code. Same convenience-slice
    // mistake this repo has now recorded three times.
    const end = CODE.indexOf('console.log(`check-changelog: cannot diff', at);
    assert.ok(end > at, 'could not bound the CI branch');
    const branch = CODE.slice(at, end);
    assert.match(branch, /process\.exit\(1\)/, 'in CI, a check that cannot run must fail rather than report success');
  });

  it('it requires the line to be INSIDE [Unreleased]', () => {
    // "CHANGELOG.md was touched" is satisfiable by a typo fix in a released section.
    assert.match(CODE, /\[Unreleased\]/, 'the script must locate the Unreleased section');
    // The WIRING, not the names. Renaming the declaration while leaving the call site passed a name-only check —
    // the script would have crashed at runtime and this gate would have stayed green.
    assert.match(CODE, /const range = unreleasedRange\(\)/, 'the range must be computed');
    // Q-56: the added lines are judged by `linesUnderUnshippedSections` — [Unreleased], or a version section the same
    // change adds (a patch). What it counts is tested as behaviour in `a-patch-entry-counts-under-the-section-it-adds`;
    // this pins that the check hands it the added lines rather than counting that the file was touched.
    assert.match(CODE, /linesUnderUnshippedSections\([^;]*?addedChangelogLines\(\)\)/,
      'the added line numbers must be judged by section — that is what makes it "an unshipped section" rather '
      + 'than "the file was touched"');
    assert.match(CODE, /function unreleasedRange\(\)/, 'the helper must still be declared');
    assert.match(CODE, /function addedChangelogLines\(\)/, 'the helper must still be declared');
  });

  it('a missing [Unreleased] section fails rather than passing', () => {
    const at = CODE.indexOf('if (!range)');
    assert.ok(at > 0, 'the missing-section branch is gone');
    assert.match(blockAfter(CODE, at, 'the missing-section branch'), /process\.exit\(1\)/,
      'no Unreleased section must fail — otherwise deleting the heading disables the check');
  });
});

describe('what it exempts, and what it refuses to exempt', () => {
  it('tests, docs, scripts, workflows and trackers are exempt', () => {
    const at = CODE.indexOf('const EXEMPT');
    assert.ok(at > 0, 'the exemption list is gone');
    const list = CODE.slice(at, CODE.indexOf('];', at));
    // Scoped to the LIST. Matching the whole file found `testing/` in the docstring, so deleting a real exemption
    // left this green.
    for (const p of ['testing', 'docs', 'scripts', 'todo', 'github', 'spec']) {
      assert.match(list, new RegExp(p, 'i'), `${p} should be in the exemption list`);
    }
  });

  it('shipped code is not exempt', () => {
    const at = CODE.indexOf('const SHIPPED');
    assert.ok(at > 0, 'the shipped-path list is gone');
    const list = CODE.slice(at, CODE.indexOf('];', at));
    assert.match(list, /server\\\/src\\\//, 'server/src must require an entry');
    assert.match(list, /client\\\/src\\\//, 'client/src must require an entry');
  });

  it('there is no marker-based escape hatch', () => {
    // A "[skip changelog]" in a PR title leaves no record and is used the moment it is inconvenient. The exemption
    // is by PATH so the decision is visible in the diff.
    assert.doesNotMatch(CODE, /skip[- ]?changelog/i,
      'no marker-based bypass: if a change truly has no user-facing effect, one CHANGELOG line saying so is cheaper '
      + 'than a bypass and leaves a record');
  });
});
