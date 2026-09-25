/**
 * A pull request into a release branch runs Build & Test, as one into `main` does (`Q-56`).
 *
 * A patch is cut on `release/X.Y.x` from the published tag, and the release phase bumps it through a pull request that
 * merges on the only merge gate, Build & Test. `ci.yml` ran that job for pull requests into `main` alone, so a patch
 * PR had no check to wait for and 5.1.1–5.1.5 were committed to the release branch directly, with the suites run by
 * hand. The same trigger, on the release branches too, makes the step followable as written.
 *
 * Run: node --test testing/standalone/a-release-branch-pr-runs-build-and-test.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');

/** The branch list under one trigger of the top-level `on:` block. */
function branchesOf(trigger) {
  const on = CI.slice(CI.indexOf('\non:'));
  const at = on.search(new RegExp(`\\n  ${trigger}:`));
  assert.ok(at > -1, `ci.yml has no ${trigger} trigger — this gate is reading the wrong file`);
  const m = on.slice(at).match(/\n    branches:\s*\[([^\]]*)\]/);
  assert.ok(m, `the ${trigger} trigger lists no branches`);
  return m[1].split(',').map(b => b.trim().replace(/^['"]|['"]$/g, ''));
}

describe('Build & Test runs where a release is prepared', () => {
  it('on pull requests into main', () => {
    assert.ok(branchesOf('pull_request').includes('main'));
  });

  it('and on pull requests into a release branch', () => {
    assert.ok(branchesOf('pull_request').some(b => b === 'release/**' || b === 'release/*'),
      `pull_request branches are ${JSON.stringify(branchesOf('pull_request'))} — a patch PR would have no merge gate`);
  });
});
