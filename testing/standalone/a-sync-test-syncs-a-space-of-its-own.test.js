/**
 * A sync test syncs a space of its own, never the shared `general` (`Q-75`).
 *
 * `general` exists on every instance from setup, and every suite writes into it — so a new network that carries it
 * first pushes whatever the suites before it left behind. After `test:integration` that was ~180 records and ~90 s,
 * and the two tests that synced `general` timed out: 245/2 with integration first, 247/0 with sync first. A test
 * whose verdict depends on which suite ran before it is not testing what it says. `closed-network` and `gossip`
 * already made their own spaces for this reason ("so we don't sync 9k+ stale docs from 'general'").
 *
 * Derived over every tracked sync test, so a new one is held to it as well.
 *
 * Run: node --test testing/standalone/a-sync-test-syncs-a-space-of-its-own.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const files = trackedSources('testing/sync', { ext: ['.test.js'], floor: 20, untracked: true });
// `general` named as a space: a quoted id, or a path/query segment (`spaces/general`, `spaceId=general`, `/general/`).
const NAMES_GENERAL = /['"`]general['"`]|\/general(?=[/?`'"]|$)|spaceId=general\b|space=general\b/m;

describe('no sync test syncs the shared general space', () => {
  it('finds the sync tests (the scan itself works)', () => {
    assert.ok(files.length >= 20, `only ${files.length} sync tests found`);
  });
  it('none of them names general as a space', () => {
    const offenders = files.filter(f => NAMES_GENERAL.test(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(offenders, [], 'use a space of the test\'s own (createTestSpace in testing/sync/helpers.js)');
  });
});
