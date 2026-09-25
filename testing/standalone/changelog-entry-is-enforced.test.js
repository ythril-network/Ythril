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
import { yamlItemAt, blockAfter } from './_structural-window.mjs';

const SCRIPT_PATH = join('scripts', 'check-changelog.mjs');
const WORKFLOW_PATH = join('.github', 'workflows', 'ci.yml');
const SCRIPT = existsSync(SCRIPT_PATH) ? readFileSync(SCRIPT_PATH, 'utf8') : '';
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');

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

  it('the workflow invokes it on pull requests', () => {
    assert.match(WORKFLOW, /node scripts\/check-changelog\.mjs/,
      'CI does not run the check, so the rule is back to being remembered rather than enforced');
    const at = WORKFLOW.indexOf('node scripts/check-changelog.mjs');
    const step = WORKFLOW.slice(WORKFLOW.lastIndexOf('- name:', at), at);
    assert.match(step, /if:\s*github\.event_name == 'pull_request'/,
      'the step must be PR-only: a push to main has no base to diff against, and the entry was already required of '
      + 'the PR that produced it');
  });

  it('the checkout fetches full history', () => {
    // Without this the diff has no merge base. It errors, and an unguarded script would treat that as "nothing to
    // check" — a green build for a missing entry, which is worse than not having the check.
    const at = WORKFLOW.indexOf('actions/checkout@v4');
    assert.ok(at > 0, 'the checkout step is gone');
    // The step is bounded by where the next step begins, which is indentation. A character count here changes
    // meaning the moment somebody adds a `name:` to the step above it.
    const step = yamlItemAt(WORKFLOW, at, 'the checkout step');
    assert.match(step, /fetch-depth:\s*0/,
      'actions/checkout needs fetch-depth: 0, or `base...HEAD` has no merge base and the check silently no-ops');
  });
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
