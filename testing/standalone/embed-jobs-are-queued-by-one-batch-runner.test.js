/**
 * Embed jobs are queued in batches by ONE runner, and the write commit uses it (Q-99 part 3, Design v3 item 7, A7).
 *
 * ## The rule
 *
 * `brain/embed-queue.ts` already has a batch enqueue — `enqueueEmbedJobs`, the sweep's — built on the same
 * `freshJob` as the single `enqueueEmbedJob`. The write commit needs a batched enqueue too (one round trip for a
 * batch's jobs instead of one per record), with the WRITE lane's semantics: reset an existing job, take the
 * higher priority, never throw into a write. Writing that as a second `bulkWrite` over the jobs collection would
 * be the third enqueue copy, and the copies differ in exactly the parts a reader skims (the reset, the priority
 * `$min`, the never-throw) — so the rule is one runner with an op builder per lane.
 *
 * ## What this holds
 *
 *  1. **One batched write onto the jobs collection exists in server/src.** Every `bulkWrite` whose receiver
 *     resolves to the space's `embed_jobs` collection is counted, through aliases and helpers
 *     (`_space-writers.mjs`); the collection's name comes from `SPACE_COLLECTIONS`, not from here. A `bulkWrite`
 *     whose collection name is computed could be one, so each is named below with the reason it is not.
 *  2. **The commit reaches it**, and every jobs-collection write the commit reaches is that one — so the write
 *     lane cannot queue per record (`enqueueEmbedJob`'s `updateOne`) or through a copy.
 *  3. **The sweep reaches the same one**, so the runner is shared rather than the sweep's alone.
 *
 * ## Seen red
 *
 * Red on 1d88828e: `brain/write-plan/commit.ts` does not exist. Mutation: a second `bulkWrite` on
 * `spaceCollection(spaceId, 'embedJobs')` added by hand to a scratch function in `brain/embed-queue.ts` (red:
 * two runners), then removed by hand.
 *
 * Run: node --test testing/standalone/embed-jobs-are-queued-by-one-batch-runner.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, walkFrom } from './_call-graph.mjs';
import { spaceWriters } from './_space-writers.mjs';

const { SPACE_COLLECTIONS } = await import('../../server/dist/db/space-collection.js');

const COMMIT = 'server/src/brain/write-plan/commit.ts';
const SWEEP_ENQUEUE = 'server/src/brain/embed-queue.ts:enqueueEmbedJobs';
const JOBS = SPACE_COLLECTIONS.embedJobs;

/** A batched write whose collection name is computed, and why it is not the jobs collection. */
const COMPUTED_BULK_WRITES = {
  'server/src/sync/engine.ts:batchUpsertBySeq': 'sync pull replicates brain documents; embed jobs are local and never replicated',
  'server/src/brain/write-plan/commit.ts:writeStage': 'the write commit\'s record stage: the collection is a record kind\'s '
    + '(`PLAN_KINDS`), never the jobs collection — the commit queues its jobs through the runner, which the last case holds',
};

const INDEX = moduleIndex('server/src');
// Lowered from 170 with the plan/commit split (`Q-99` part 3) — see `a-create-converge-write-lives-in-the-commit`.
const WRITERS = spaceWriters(INDEX, { floors: { space: 150 } });
const ALL = [...WRITERS.sites, ...WRITERS.orphans.map(o => ({ ...o, key: `${o.file}:(orphan)` }))];

const computed = s => s.kind === 'unknown' || (s.kind === 'space' && s.collection == null);
const RUNNERS = ALL.filter(s => s.op === 'bulkWrite' && s.collection === JOBS);

describe('one batch runner queues embed jobs', () => {
  it('the jobs collection name is derived, and a batched write onto it is found (floor)', () => {
    assert.equal(typeof JOBS, 'string', 'SPACE_COLLECTIONS.embedJobs is gone — re-derive the jobs collection');
    assert.ok(RUNNERS.length >= 1, `no bulkWrite on '${JOBS}' found — the scan is broken, or the sweep stopped batching`);
  });

  it('there is exactly one', () => {
    assert.deepEqual(RUNNERS.map(s => `${s.key}:${s.line}`), RUNNERS.slice(0, 1).map(s => `${s.key}:${s.line}`),
      `more than one bulkWrite onto '${JOBS}': a second hand-written batch enqueue. Add a lane's op builder to the `
      + 'runner instead');
  });

  it('every bulkWrite with a computed collection name is named, with why it is not the jobs collection', () => {
    const unnamed = ALL.filter(s => s.op === 'bulkWrite' && computed(s) && !(s.key in COMPUTED_BULK_WRITES))
      .map(s => `${s.key}:${s.line} (${s.why})`);
    assert.deepEqual(unnamed, [], 'a bulkWrite onto a collection this scan cannot name — it may be a second jobs runner');
    const live = new Set(ALL.filter(s => s.op === 'bulkWrite' && computed(s)).map(s => s.key));
    const stale = Object.keys(COMPUTED_BULK_WRITES).filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'entries for code that no longer holds a computed bulkWrite — delete them');
  });

  it('the sweep enqueue reaches the runner', () => {
    const { seen } = walkFrom(INDEX, [SWEEP_ENQUEUE]);
    assert.ok(RUNNERS.some(r => seen.has(r.key)), `${SWEEP_ENQUEUE} does not reach the jobs runner`);
  });

  it('the write commit queues its jobs through the same runner, and through nothing else', () => {
    const roots = [...INDEX.bodies.keys()].filter(k => k.startsWith(`${COMMIT}:`));
    assert.ok(roots.length >= 1, `${COMMIT} does not exist (or holds no function) — the write lane still enqueues per record`);
    const { seen } = walkFrom(INDEX, roots);
    assert.ok(RUNNERS.some(r => seen.has(r.key)), `${COMMIT} does not reach the jobs runner`);
    const other = ALL.filter(s => s.collection === JOBS && seen.has(s.key) && !RUNNERS.includes(s))
      .map(s => `${s.key}:${s.line} ${s.op}`);
    assert.deepEqual(other, [], 'the commit writes the jobs collection outside the batch runner');
  });
});
