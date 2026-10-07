/**
 * A pull request into a release branch runs Build & Test, as one into `main` does (`Q-56`).
 *
 * A patch is cut on `release/X.Y.x` from the published tag, and the release phase bumps it through a pull request that
 * merges on the only merge gate, Build & Test. `ci.yml` ran that job for pull requests into `main` alone, so a patch
 * PR had no check to wait for and 5.1.1–5.1.5 were committed to the release branch directly, with the suites run by
 * hand. The same trigger, on the release branches too, makes the step followable as written.
 *
 * The branch list is read from the PARSED workflow by `branchesOf` (`testing/_shared/ci-workflow.mjs`), the one reader of a
 * trigger's branch filter. This file used to cut it out of the text with a regular expression that understood one spelling,
 * a flow-style list on a single line; a block-style list or a comment inside the brackets read as "no branches", and the gate
 * that held the release branches then failed — or, written the other way round, passed — for a spelling and not for a rule.
 *
 * Run: node --test testing/standalone/a-release-branch-pr-runs-build-and-test.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCi, parseWorkflow, triggersOf } from '../_shared/ci-workflow.mjs';
// `branchesOf` is read off the namespace, so a module that lacks it fails these tests and does not stop the file loading.
import * as CW from '../_shared/ci-workflow.mjs';

const CI = loadCi();
const onOf = (doc) => doc.on ?? doc[true];

/** The branch list under one trigger of ci.yml's `on:`; the trigger must be there and must filter by branch. */
function branchesOf(trigger) {
  assert.ok(triggersOf(CI).has(trigger), `ci.yml has no ${trigger} trigger — this gate is reading the wrong file`);
  const branches = CW.branchesOf(onOf(CI), trigger);
  assert.ok(branches !== null, `the ${trigger} trigger has no branch filter`);
  assert.ok(branches.length > 0, `the ${trigger} trigger lists no branches`);
  return branches;
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

describe('branchesOf — a trigger\'s branch filter, read from the parsed workflow in whichever way it is written', () => {
  /** A workflow with the given `on:` text, parsed. */
  const workflow = (onText) => parseWorkflow(`name: x\n${onText}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`, 'a synthetic workflow');
  const read = (onText, event) => CW.branchesOf(onOf(workflow(onText)), event);

  const LISTS = [
    ['a flow-style list on one line', "on:\n  pull_request:\n    branches: [main, 'release/**']"],
    ['a block-style list', "on:\n  pull_request:\n    branches:\n      - main\n      - 'release/**'"],
    ['a block-style list with double quotes and a comment between items', 'on:\n  pull_request:\n    branches:\n      - "main"\n      # patches are bumped through a PR into a release line\n      - "release/**"'],
    ['a flow-style list over several lines, with comments inside the brackets', "on:\n  pull_request:\n    branches: [\n      main,  # the default branch\n      'release/**',\n    ]"],
    ['a list that follows another key of the trigger', "on:\n  pull_request:\n    types: [opened, synchronize]\n    branches:\n      - main\n      - 'release/**'"],
    ['a list under a trigger that is not the first', "on:\n  push:\n    branches: [other]\n  pull_request:\n    branches: [main, 'release/**']"],
  ];

  it('has a table worth its name', () => {
    assert.ok(LISTS.length >= 5, `the table holds ${LISTS.length} spellings`);
  });

  for (const [what, onText] of LISTS) {
    it(`reads ${what}`, () => {
      assert.deepEqual(read(onText, 'pull_request'), ['main', 'release/**']);
    });
  }

  it('reads each event\'s own filter, not the first one in the file', () => {
    const on = "on:\n  pull_request:\n    branches: [main, 'release/**']\n  push:\n    branches: [main]";
    assert.deepEqual(read(on, 'push'), ['main']);
    assert.deepEqual(read(on, 'pull_request'), ['main', 'release/**']);
  });

  it('tells a trigger with no branch filter (null) from a filter that lists nothing ([])', () => {
    assert.deepEqual(read('on:\n  push:\n    branches: []', 'push'), []);
    for (const [what, onText] of [
      ['a trigger with no body', 'on:\n  push:'],
      ['a trigger with an empty mapping', 'on:\n  push: {}'],
      ['a trigger that filters by tag only', "on:\n  push:\n    tags: ['v*']"],
      ['a trigger that ignores branches without listing any', "on:\n  push:\n    branches-ignore: [docs]"],
      ['the bare word', 'on: push'],
      ['a list of events', 'on: [push, pull_request]'],
    ]) {
      assert.equal(read(onText, 'push'), null, `${what} has no branch filter, and must not read as an empty one`);
    }
  });

  it('an empty list and an absent filter are different answers, so neither can stand in for the other', () => {
    assert.notEqual(read('on:\n  push:\n    branches: []', 'push'), read('on:\n  push:', 'push'));
  });

  it('gives the entries as plain strings, without their quotes', () => {
    for (const entry of read("on:\n  push:\n    branches: ['main', \"release/**\", full-run/**]", 'push')) {
      assert.equal(typeof entry, 'string');
      assert.ok(!/^['"]|['"]$/.test(entry), `${entry} kept a quote`);
    }
  });
});
