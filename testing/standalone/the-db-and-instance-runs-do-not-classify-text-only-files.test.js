/**
 * A database-only or instance-only plan never runs the text-only classifier (Q-870, bundle-316 sweep F5).
 *
 * ## The defect this refuses
 *
 * The design says the classification is lazy, so the db and instance runs neither pay for it nor can be broken by it. `offlineRuns` built the text set on every
 * call and `run-standalone.mjs` called it for every `--only`, so `--only=db` (each CI database shard job) and `--only=instance` read the import closure of every
 * pure file, and a classifier failure (git not answering, an unreadable file) took down a job that runs no text file.
 *
 * ## What is asserted
 *
 * The classifier needs a git checkout to list the tracked files. Given a split whose `root` is not one, `offlineRuns`:
 * - answers the database runs when only `db` is wanted, and nothing when no kind is wanted (the instance-only run), with no throw: the classifier was not asked;
 * - throws when `text` or `pure` is wanted (the classifier is asked, and fails for want of a checkout, so the other cases cannot pass by never asking);
 * - and `run-standalone.mjs` passes the kinds it wants, so those plans are what the runner builds.
 *
 * Run: node --test testing/standalone/the-db-and-instance-runs-do-not-classify-text-only-files.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { offlineRuns } from '../_shared/standalone-split.mjs';

describe('offlineRuns asks the classifier only for the kinds that need it', () => {
  const notACheckout = mkdtempSync(join(tmpdir(), 'no-git-here-'));
  const split = { offlinePure: ['a.test.js', 'b.test.js'], offlineDb: ['d.test.js'], ciOnly: [], root: notACheckout };

  it('a plan for the database kind alone answers the database runs and does not ask', () => {
    const runs = offlineRuns(split, { kinds: ['db'] });
    assert.deepEqual(runs.map(r => r.kind), ['db']);
    assert.deepEqual(runs.flatMap(r => r.files), ['testing/standalone/d.test.js']);
  });

  it('a plan for no offline kind (the instance-only run) is empty and does not ask', () => {
    assert.deepEqual(offlineRuns(split, { kinds: [] }), []);
  });

  it('a plan for the text or the pure kind asks, and fails here for want of a checkout', () => {
    for (const kind of ['text', 'pure']) assert.throws(() => offlineRuns(split, { kinds: [kind] }), undefined, `the ${kind} plan did not ask the classifier`);
    rmSync(notACheckout, { recursive: true, force: true });
  });
});

describe('run-standalone.mjs', () => {
  it('builds its plan for the kinds it was asked for', () => {
    const runner = stripComments(readFileSync(join(REPO_ROOT, 'testing/_init/run-standalone.mjs'), 'utf8'));
    assert.match(runner, /offlineRuns\(split,\s*\{[^}]*\bkinds\b/, 'the runner asks offlineRuns for every kind whatever --only says, so --only=db classifies the pure files');
  });
});
