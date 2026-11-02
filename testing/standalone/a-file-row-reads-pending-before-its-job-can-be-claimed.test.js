/**
 * A file row reads `pending` BEFORE the job that makes it so can be claimed.
 *
 * ## What goes wrong in the other order
 *
 * Making a text embed job claimable and marking the file row `pending` are two writes. If the job goes first, the worker
 * can claim it, mark the row `processing`, and finish (or fail) before the second write lands, and the late
 * `pending` overwrites the worker's mark. On a healthy embedder that leaves a FINISHED file reading `pending` for ever:
 * the job is `complete`, nothing revisits it, and the file shows a spinner. The same gap was the flake in
 * `embedding-failure-reporting.test.js` on release PR #1578: a fast worker inside `enqueueTextJob`'s window.
 *
 * The wake is part of the gap: `markSpaceMayHaveWork` is what makes the worker probe the space, so the row's `pending` must
 * be written before it too. The media branch already has it right (`dispatch.ts`: `setMediaStatus('pending')`, then
 * `enqueueMediaJob`); the text queue's three writers did not.
 *
 * ## What is derived, never listed
 *
 *  - **The writers**: every top-level function of `job-queue.ts` that writes a job `status: 'pending'` (a `$set` or an inserted
 *    document, read from the comment-stripped source) AND marks the file row `embeddingStatus: 'pending'` through
 *    `setFileProcessingState`. For each, the row mark must come BEFORE the first pending job write and BEFORE the first
 *    `markSpaceMayHaveWork`.
 *  - **The others**: every function that writes a job `pending` and does NOT mark the row is one the row is already right for, or
 *    one whose caller marks it. They are named below with the reason, and a row that no longer matches a function FAILS, so an
 *    excuse cannot outlive what it excuses and a new pending-writer cannot land without being argued for.
 *
 * Scope: `job-queue.ts` only; the media-status marks (`setMediaStatus`) live in `dispatch.ts` and are in order there.
 *
 * ## Seen red
 *
 * On 213dac05d `enqueueTextJob`, `retryJob` and `retryFailedJobs` write the row after the job and after the wake. Mutation
 * (put back by hand): move the `setFileProcessingState(..., 'pending')` call in any of them below its job write.
 *
 * Run: node --test testing/standalone/a-file-row-reads-pending-before-its-job-can-be-claimed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { topLevelFunctions } from './_call-graph.mjs';
import { stripComments } from './_strip-comments.mjs';
import { REPO_ROOT } from './_sources.mjs';

const JOB_QUEUE = 'server/src/files/media/job-queue.ts';

/** A job written `pending`: in a `$set`, or in the inserted document. A FILTER on `status: 'pending'` is not a write. Built fresh per use. */
const jobPendingWrite = () => /(?:\$set\s*:\s*\{[^}]*?|const\s+doc\b[^=]*=\s*\{[^}]*?)\bstatus\s*:\s*'pending'/g;
/** The file row marked `pending` through the one writer of processing state. */
const rowPendingMark = () => /\bsetFileProcessingState\s*\([^;]*?\bembeddingStatus\s*:\s*'pending'/;
const wake = () => /\bmarkSpaceMayHaveWork\s*\(/;

/**
 * Functions that put a job `pending` and leave the file row alone, with why that is right. Keyed by name; a stale row fails.
 */
const ROW_ALREADY_RIGHT = {
  enqueueMediaJob: 'the media branch: `dispatch.ts` marks the row (`setMediaStatus(\'pending\')`) before it calls this',
  failJob: 'a retry: the row already reads `processing` and stays so until the job ends; the row is not told anything until then',
  deferJob: 'a deferral while the face gallery cannot answer: the row already reads `processing` and stays so until the job ends, as for a failJob retry',
  releaseClaimedJob: 'hands a claimed job back at shutdown: the row already reads `processing`, and the next claim writes it again',
  resetStalledJobs: 'stall recovery re-queues a job that stopped reporting: the row already reads `processing`',
  holdJobsForMove: 'the job is held (not claimable) for a move; the move rewrites the row itself',
};

/**
 * Functions of `src` that write a job pending and mark the row pending: `marking`, `name -> what the row mark comes
 * after` (empty when it is in order). Plus `others`: the pending-writers that do not mark the row.
 */
export function pendingWriters(src) {
  const functions = topLevelFunctions(stripComments(src));
  const marking = new Map();
  const others = [];
  for (const [name, body] of functions) {
    const writes = [...body.matchAll(jobPendingWrite())].map(m => m.index);
    if (writes.length === 0) continue;
    const row = rowPendingMark().exec(body);
    if (!row) { others.push(name); continue; }
    const woken = wake().exec(body);
    const late = [];
    if (row.index > Math.min(...writes)) late.push('the job write');
    if (woken && row.index > woken.index) late.push('the wake');
    marking.set(name, late);
  }
  return { marking, others };
}

const SRC = readFileSync(join(REPO_ROOT, JOB_QUEUE), 'utf8');

describe('the detector reads which functions put a job pending, and in what order', () => {
  const plant = (body) => `export async function f(spaceId: string) {\n${body}\n}\n`;

  it('flags a row marked after the job, and after the wake; passes the row first', () => {
    const job = "await jobs.updateOne(filter, { $set: { status: 'pending', attempts: 0 } });";
    const row = "await setFileProcessingState(spaceId, id, { embeddingStatus: 'pending' });";
    const wakeCall = 'markSpaceMayHaveWork(spaceId);';
    assert.deepEqual([...pendingWriters(plant(`${job}\n${wakeCall}\n${row}`)).marking], [['f', ['the job write', 'the wake']]]);
    assert.deepEqual([...pendingWriters(plant(`${job}\n${row}\n${wakeCall}`)).marking], [['f', ['the job write']]]);
    assert.deepEqual([...pendingWriters(plant(`${row}\n${job}\n${wakeCall}`)).marking], [['f', []]]);
    assert.deepEqual([...pendingWriters(plant(`${row}\n${wakeCall}\n${job}`)).marking], [['f', []]], 'no wake after the job: only the job write is compared');
  });

  it('reads an inserted document, an inline $set with other keys first, and a retry-all updateMany', () => {
    const row = "await setFileProcessingState(spaceId, ids, { embeddingStatus: 'pending', mediaJobError: undefined });";
    assert.deepEqual([...pendingWriters(plant(`const doc: MediaJobDoc = { _id: id, status: 'pending', attempts: 0 };\nawait jobs.insertOne(doc);\n${row}`)).marking],
      [['f', ['the job write']]]);
    assert.deepEqual([...pendingWriters(plant(`await jc.updateMany(f, { $set: { status: 'pending', attempts: 0 } });\n${row}`)).marking],
      [['f', ['the job write']]]);
  });

  it('does not read a filter, a comment, or a function with no job write as a pending write', () => {
    const row = "await setFileProcessingState(spaceId, id, { embeddingStatus: 'pending' });";
    assert.equal(pendingWriters(plant(`const j = await jobs.findOneAndUpdate({ status: 'pending' }, { $set: { status: 'processing' } });\n${row}`)).marking.size, 0);
    assert.equal(pendingWriters(plant(`// $set: { status: 'pending' }\n${row}`)).marking.size, 0);
  });

  it('puts a pending-writer that does not mark the row among the others', () => {
    assert.deepEqual(pendingWriters(plant("await jobs.updateOne(f, { $set: { status: 'pending' } });\nmarkSpaceMayHaveWork(spaceId);")).others, ['f']);
  });
});

describe('job-queue.ts: a file row reads pending before its job is claimable', () => {
  const { marking, others } = pendingWriters(SRC);

  it('finds the three writers, so the rule cannot pass by finding none', () => {
    for (const name of ['enqueueTextJob', 'retryJob', 'retryFailedJobs']) {
      assert.ok(marking.has(name), `${name} is no longer seen writing a job pending and marking its row pending: re-derive`);
    }
  });

  it('every function that marks the row pending does so before the job write and before the wake', () => {
    const out = [...marking].filter(([, late]) => late.length > 0).map(([name, late]) => `${name} marks the row after ${late.join(' and after ')}`);
    assert.deepEqual(out, [],
      'a worker that claims the job inside that gap marks the row processing and finishes, and the late `pending` overwrites it: '
      + 'the file reads pending for ever. Write the row first (as dispatch.ts does for media)');
  });

  it('every other function that puts a job pending is one the row is already right for, with the reason', () => {
    assert.deepEqual(others.filter(n => !(n in ROW_ALREADY_RIGHT)).sort(), [],
      'these put a job pending and never mark its row: mark it first, or say in ROW_ALREADY_RIGHT why the row is already right');
    assert.deepEqual(Object.keys(ROW_ALREADY_RIGHT).filter(n => !others.includes(n)), [],
      'these are excused and no longer put a job pending without marking the row: remove the row');
  });
});
