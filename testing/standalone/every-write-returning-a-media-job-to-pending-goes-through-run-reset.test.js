/**
 * Every write that returns a media job to `pending` goes through the one reset spread (`RUN_RESET`) or is listed here with its reason,
 * and the spread names no identity key (bundle-236, Q-698, DESIGN v3 C6 and C13).
 *
 * ## The defect that bought it
 *
 * `job-queue.ts` returned a job to pending in six places, each its own `$set` of a different handful of fields. They had drifted:
 * `retryJob` and `retryFailedJobs` forgot the deferral marks (S8: a retried job skipped the caption it was retried for), the text
 * enqueue reset the job without them either, the media enqueue unset them and the text one did not, and the one place that did NOT
 * forget anything was the one written last. A reset is one thing, a whole new run, and one spread says what it is: `RUN_RESET` (status
 * `pending`, attempts 0, `lastError`, `claimedAt` and `claimToken` null, `updatedAt`, progress and resolved format unset, and the
 * deferral marks unset). A seventh writer that spells its own `$set` is the next S8.
 *
 * The other half is what the spread must NOT carry. The job's identity (`mimeType`, `mediaType`, `arrival`, `sha256`) is set only by the
 * write door and by the enqueue: a reset that also set `arrival` would turn a peer's arrived image into one written here on every retry
 * (a `-db` test holds the behaviour; this holds the shape).
 *
 * ## What is derived, never listed
 *
 *  - **The writers**: every top-level function of `job-queue.ts` whose source has a `$set` naming `status: 'pending'` (`byHand`), and
 *    every one that uses `RUN_RESET` (`spread`), read from the comment-stripped source by `_pending-job-writes.mjs`, the same
 *    detector the row-before-job gate reads. An inserted document is a NEW job, not a return, and is neither.
 *  - **The rule**: a by-hand writer must be in {@link BY_HAND} with the reason it is not a whole new run. A row that no longer matches a
 *    by-hand writer FAILS, so an excuse cannot outlive what it excuses and a new by-hand writer cannot land without being argued for.
 *  - **The floor**: the spread is declared, and the writers a reset is for (`retryJob`, `retryFailedJobs`, `enqueueMediaJob`) go through
 *    it, so the rule cannot pass by finding nothing.
 *
 * ## Seen red
 *
 * On abe1bde3b `RUN_RESET` does not exist: the declaration is not found, no writer goes through it, and `retryJob`, `retryFailedJobs`,
 * `enqueueMediaJob` and `enqueueTextJob` return a job to pending by hand and are listed nowhere. Mutation (put back by hand): spell a
 * `$set: { status: 'pending', ... }` in any new function, or add `arrival` to the spread.
 *
 * Run: node --test testing/standalone/every-write-returning-a-media-job-to-pending-goes-through-run-reset.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetWriters, runResetDeclaration } from './_pending-job-writes.mjs';
import { REPO_ROOT } from './_sources.mjs';

const JOB_QUEUE = 'server/src/files/media/job-queue.ts';

/** Keys the reset spread may never name: the job's identity is set by the write door and the enqueue, not by a reset. */
const IDENTITY_KEYS = ['arrival', 'mimeType', 'mediaType', 'sha256'];

/**
 * Functions that return a job to pending by hand, with why each is not a whole new run. Keyed by name; a stale row fails.
 */
export const BY_HAND = {
  failJob: 'a retry after a failure: the same run goes on behind a backoff, with the attempt it spent; its marks and identity are the run\'s',
  releaseClaimedJob: 'hands a claimed job back at shutdown: the same run, no attempt spent, no wait',
  resetStalledJobs: 'stall recovery re-queues the run that stopped reporting, with the attempt it spent: the same run, not a new one',
  holdJobsForMove: 'holds a job for a move: not claimable, nothing about the run changes, and the move re-keys it',
  deferJob: 'a deferral: the same run goes on behind a wait, and the marks it sets are the point of it (`DEFERRAL_MARKS` are set here, unset by a reset)',
};

/** What the gate says about `src`: `names` (by-hand writers not listed), `stale` (listed rows no by-hand writer matches). */
export function judge(src, by = BY_HAND) {
  const { byHand, spread } = resetWriters(src);
  return {
    unlisted: byHand.filter(n => !(n in by)).sort(),
    stale: Object.keys(by).filter(n => !byHand.includes(n)).sort(),
    spread,
    byHand,
  };
}

/** The identity keys a `RUN_RESET` declaration names (word-bounded, comments stripped). */
export function identityKeysIn(declaration) {
  return IDENTITY_KEYS.filter(k => new RegExp(`\\b${k}\\b`).test(declaration));
}

const SRC = readFileSync(join(REPO_ROOT, JOB_QUEUE), 'utf8');

describe('the detector reads which functions return a job to pending, by hand or through the spread', () => {
  const plant = (body, name = 'f') => `export async function ${name}(spaceId: string) {\n${body}\n}\n`;

  it('reads a by-hand $set, a spread use, a function with both, and neither an inserted document nor a filter nor a comment', () => {
    assert.deepEqual(resetWriters(plant("await jobs.updateOne(f, { $set: { status: 'pending', attempts: 0 } });")), { byHand: ['f'], spread: [] });
    assert.deepEqual(resetWriters(plant("await jobs.updateOne(f, { $set: { ...RUN_RESET, updatedAt: now } });")), { byHand: [], spread: ['f'] });
    assert.deepEqual(resetWriters(plant("await a({ $set: { ...RUN_RESET } });\nawait b({ $set: { status: 'pending' } });")), { byHand: ['f'], spread: ['f'] });
    assert.deepEqual(resetWriters(plant("const doc: MediaJobDoc = { _id: id, status: 'pending', attempts: 0 };\nawait jobs.insertOne(doc);")), { byHand: [], spread: [] });
    assert.deepEqual(resetWriters(plant("const j = await jobs.findOneAndUpdate({ status: 'pending' }, { $set: { status: 'processing' } });")), { byHand: [], spread: [] });
    assert.deepEqual(resetWriters(plant("// $set: { status: 'pending' } and RUN_RESET")), { byHand: [], spread: [] });
  });

  it('a planted copy: a new by-hand writer is unlisted; a planted writer through the spread is not; a planted stale row is stale', () => {
    const planted = plant("await jobs.updateOne(f, { $set: { status: 'pending', attempts: 0 } });", 'seventhWriter')
      + plant("await jobs.updateOne(f, { $set: { ...RUN_RESET } });", 'viaSpread');
    assert.deepEqual(judge(planted, {}).unlisted, ['seventhWriter'], 'a seventh by-hand writer lands without being argued for');
    assert.deepEqual(judge(planted, { seventhWriter: 'why' }).unlisted, []);
    assert.deepEqual(judge(planted, { seventhWriter: 'why', viaSpread: 'excuse for a writer that goes through the spread' }).stale, ['viaSpread'],
      'an excuse for a writer that no longer returns a job by hand is not refused');
    assert.deepEqual(judge(planted, { seventhWriter: 'why' }).spread, ['viaSpread']);
  });

  it('a planted RUN_RESET that names an identity key is read; one that does not, is not', () => {
    const decl = (body) => runResetDeclaration(`export const RUN_RESET: Reset = {\n${body}\n};\nexport async function f() {}\n`);
    assert.deepEqual(identityKeysIn(decl("status: 'pending', attempts: 0, arrival: false")), ['arrival']);
    assert.deepEqual(identityKeysIn(decl("status: 'pending', mimeType, sha256: null, updatedAt")), ['mimeType', 'sha256']);
    assert.deepEqual(identityKeysIn(decl("status: 'pending', attempts: 0, lastError: null, claimedAt: null")), []);
    assert.deepEqual(identityKeysIn(decl("status: 'pending', ...{ arrival: true }")), ['arrival'], 'a nested literal is inside the declaration');
    assert.equal(runResetDeclaration('export function g() {}'), null);
    assert.ok(decl("status: 'pending'").includes("status: 'pending'") && !decl("status: 'pending'").includes('export async function f'),
      'the declaration ends at its own closing bracket, and a type annotation with braces does not end it early');
    assert.ok(runResetDeclaration("const RUN_RESET: Partial<{ a: 1 }> = { status: 'pending' };").includes("status: 'pending'"));
  });
});

describe('job-queue.ts: every write returning a job to pending goes through RUN_RESET or is listed with its reason', () => {
  const verdict = judge(SRC);

  it('declares RUN_RESET, and the writers a reset is for go through it, so the rule cannot pass by finding none', () => {
    assert.notEqual(runResetDeclaration(SRC), null, 'job-queue.ts declares no RUN_RESET: the reset is still spelled out in each writer');
    for (const name of ['retryJob', 'retryFailedJobs', 'enqueueMediaJob']) {
      assert.ok(verdict.spread.includes(name), `${name} no longer goes through RUN_RESET (writers through it: ${verdict.spread.join(', ') || 'none'})`);
    }
  });

  it('finds the by-hand writers it lists, so the allowlist cannot pass by matching none', () => {
    assert.ok(verdict.byHand.length >= Object.keys(BY_HAND).length - 1,
      `only ${verdict.byHand.length} by-hand writers are seen (${verdict.byHand.join(', ')}): re-derive the detector`);
  });

  it('every function that returns a job to pending by hand is one with a reason it is not a whole new run', () => {
    assert.deepEqual(verdict.unlisted, [],
      'these return a job to pending with their own $set: go through RUN_RESET (a reset is a whole new run), or say in BY_HAND why this one is the same run');
  });

  it('every listed excuse is for a function that still returns a job to pending by hand', () => {
    assert.deepEqual(verdict.stale, [], 'these are excused and no longer return a job to pending by hand: remove the row');
  });
});

describe('RUN_RESET names no identity key', () => {
  const declaration = runResetDeclaration(SRC);

  it('is declared with the fields of a reset, so an empty read cannot pass', () => {
    assert.notEqual(declaration, null, 'job-queue.ts declares no RUN_RESET');
    for (const field of ['status', 'attempts', 'lastError', 'claimedAt', 'claimToken']) {
      assert.ok(new RegExp(`\\b${field}\\b`).test(declaration), `RUN_RESET does not name ${field}: ${declaration.slice(0, 200)}`);
    }
  });

  it('names no arrival, mimeType, mediaType or sha256 key: the identity is set by the write door and the enqueue only', () => {
    assert.ok(declaration !== null, 'job-queue.ts declares no RUN_RESET');
    assert.deepEqual(identityKeysIn(declaration), [],
      'a reset that names the job\'s identity rewrites it on every retry (a retried arrival job would become one written here)');
  });
});
