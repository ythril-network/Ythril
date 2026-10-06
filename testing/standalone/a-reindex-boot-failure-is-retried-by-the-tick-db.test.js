/**
 * A reindex run that could not be resumed at boot is resumed by the tick, and two sweepers never share a run
 * (`Q-274`, `Q-358`, `Q-317`, bundle-53 G15).
 *
 * ## The defect
 *
 * `resumeReindexRuns` looped over the spaces with no catch and no bound, and armed the watcher only when it had FOUND a run.
 * A space whose run collection could not be read at boot therefore threw out of the loop: the spaces behind it were never
 * resumed, the boot line said "could not resume runs", and the watcher was never armed, so nothing tried again for as long as
 * the process lived. And once it was armed the tick did not resume a run whose sweep was not complete ("whoever is or is not
 * sweeping it"), so a failed boot resume was a run that waited for the next restart. Three more things stood beside it:
 *
 *  - **The gauge had two writers.** The tick set `ythril_reindex_in_progress` from the spaces it COULD read, so one space whose
 *    run could not be read made the number lower than the truth, and the boot set it from its own count. A gauge that is wrong
 *    in the direction that says "nothing is running" is the one an operator trusts.
 *  - **Nothing owned a sweep.** A boot resume and a tick that both resume would sweep the same run twice. The run document is
 *    local to this instance, so an atomic LEASE on it (`sweepLeaseAt`, taken with `findOneAndUpdate`, renewed with every cursor
 *    save) is what makes "who is sweeping" a fact that holds across processes and not a guess.
 *  - **A hung space held the tick.** The watcher's per-space reads had no bound.
 *
 * ## What is pinned, against a real MongoDB
 *
 * A space whose run collection is a view with a failing `pipeline` (a read fault: the stage throws only for the source document
 * the reader's filter reaches, so the source holds the `run` document) and one whose reads STALL (a view that sleeps per source
 * document, interruptible by `maxTimeMS`, with the guard that says so).
 *
 *  1. FIRST in the file, because the watcher is one timer for the process: a boot that could not read a space's run still ARMS
 *     the watcher, and the watcher alone (the real timer, no test-driven tick) resumes the run once the fault clears;
 *  2. a failing space is reported once and the spaces behind it are still resumed, at boot and in the tick;
 *  3. the gauge, started from a POISONED value, is kept while any space could not be read and recomputed exactly when every
 *     space answered, and is written at one place in the source;
 *  4. a run whose lease is held is not resumed, whether by the boot or the tick; one whose lease is stale is, and the lease is
 *     taken; an errored run is never resumed; the lease is taken at creation and renewed with every cursor save; several resumers
 *     at once sweep a run ONCE;
 *  5. a hung space ends at the housekeeping bound, at boot and in the tick, and the next space is processed;
 *  6. the run collection is local: no list of the replicated collections names it.
 *
 * Run: `npm run test:up` first, then (after `npm run build:server`)
 *      node --test testing/standalone/a-reindex-boot-failure-is-retried-by-the-tick-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { assertViewStalls, setWriteBoundForTest, settleWithin, withCollectionAsView } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const BOUND_MS = 1_000;
const STALL_STEP_MS = 200;
const STALL_STEPS = 23; // 4 600 ms: well past the bound, and past what a settle window below would tolerate
const STALL_MS = STALL_STEP_MS * STALL_STEPS;

// A space that is FAULTY sits BEFORE the healthy one in the config: a walk that stops at the first failure leaves exactly the
// spaces after it unprocessed. Each hung space is armed by exactly one case (a hung space is quarantined for a minute).
const SPACES = ['boot-fail', 'skip-fail', 'skip-ok', 'tick-fail', 'tick-ok', 'gauge-bad', 'gauge-ok', 'lease-base', 'lease-held',
  'lease-stale', 'lease-tick', 'lease-retarget', 'lease-conc', 'lease-err', 'lease-new', 'lease-renew', 'hung-tick-1', 'hung-tick-2', 'hung-boot-1',
  'hung-boot-2', 'ref'];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-reindex-tick-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let mongo, loader, reindex, queue, shared, registry, spaceCollection, proto, targetOfThisConfig;

const runCol = (space) => mongo.col(spaceCollection(space, 'reindexRun'));
const jobsCol = (space) => mongo.col(spaceCollection(space, 'embedJobs'));
const factsCol = (space) => mongo.col(spaceCollection(space, 'facts'));
const spaceConfig = (id) => loader.getConfig().spaces.find(s => s.id === id);
const db = () => mongo.getDb();
/** Optional on purpose: on a tree without the export the cases below must fail on what they pin, not on this. */
const stopWatcher = () => reindex?.stopReindexWatcher?.();

async function seedFacts(space, n) {
  const now = new Date().toISOString();
  const ids = Array.from({ length: n }, (_, i) => `${space}-f-${String(i).padStart(4, '0')}`);
  await factsCol(space).insertMany(ids.map((id, i) => ({
    _id: id, spaceId: space, fact: `fact number ${i} in ${space}`, tags: [], entityIds: [], seq: i + 1, createdAt: now, updatedAt: now,
  })));
  return ids;
}

/** A run document as a restart would find it. `sweepLeaseAt` is given by the case: its absence is a case of its own. */
const runDoc = (space, extra = {}) => ({
  _id: 'run', spaceId: space, members: [space], flagged: false, target: targetOfThisConfig,
  startedAt: new Date().toISOString(), cursor: null, sweepComplete: false, ...extra,
});
const seedRun = (space, extra) => runCol(space).insertOne(runDoc(space, extra));

const STALE = () => Date.now() - 60 * 60_000;
/** A lease nobody lets go of for the length of a case: the run is held by "another process". */
const HELD = () => Date.now() + 60 * 60_000;

const rebuildQueued = async (space) =>
  new Set((await jobsCol(space).find({ rebuild: true }).project({ recordId: 1 }).toArray()).map(r => r.recordId));
const until = (cond, what, timeoutMs = 15_000) => waitForValue(cond, timeoutMs, 100, undefined, { what });
const sweepDone = (space) => until(async () => (await runCol(space).findOne({ _id: 'run' }))?.sweepComplete === true,
  `the run of '${space}' to report sweepComplete`);
const gauge = async () => (await registry.reindexInProgress.get()).values[0]?.value;
const linesFor = (lines, step, space) => lines.filter(l => l.includes(`${step} failed for space '${space}'`));

/** Reads of the run collection THROW for the `run` document: a view whose stage cannot convert the source's field. */
async function withFailingRunReads(space, fn) {
  await db().collection(`${space}_src`).insertOne({ _id: 'run', f: 'not a number' });
  try {
    return await withCollectionAsView(db(), spaceCollection(space, 'reindexRun'), `${space}_src`, fn,
      { pipeline: [{ $addFields: { _x: { $toInt: '$f' } } }] });
  } finally { await db().collection(`${space}_src`).deleteMany({}); }
}

/**
 * Reads of the run collection STALL for `STALL_MS`, interruptible by the server's `maxTimeMS`. `withStalledReads` stalls per
 * source document the reader's filter lets through, and the reader asks for `_id: 'run'` (which the view's own `$match` would
 * coalesce with, so every document but that one never reaches the stall: a second sleep step, not 23). So the view is built
 * here from the same one interruptible form (`$match` over `$expr` / `$function`, `_write-faults.mjs`) over SOURCE documents the
 * reader never names, and its last stages collapse them into the one `run` document: the `$group` must consume every source
 * document (a `$sort` + `$limit` over the `_id` index would stop after the first), and `$replaceWith` makes the output a document
 * of its own, which the reader's filter cannot reach back past.
 *
 * Two guards, because a stall that stalled nothing passes every bound test: `assertViewStalls` (a raw read takes this long AND is
 * ended by the server's own code 50 before it is over) and the READER's own read, `findOne({ _id: 'run' })`, which must take it too.
 */
async function withStalledRunReads(space, fn) {
  const name = spaceCollection(space, 'reindexRun');
  await db().collection(`${space}_src`).insertMany(Array.from({ length: STALL_STEPS }, (_, i) => ({ _id: `stall-${i}` })));
  try {
    return await withCollectionAsView(db(), name, `${space}_src`, async () => {
      await assertViewStalls(db(), name, { ms: STALL_MS });
      const started = Date.now();
      const doc = await db().collection(name).findOne({ _id: 'run' });
      const tookMs = Date.now() - started;
      assert.ok(doc && tookMs >= STALL_MS - STALL_STEP_MS,
        `the reader's own read (_id: 'run') took ${tookMs}ms and found ${JSON.stringify(doc)}: the view stalls a raw read but not the read the code under test makes`);
      return fn();
    }, {
      pipeline: [
        { $match: { $expr: { $function: { body: `function(){sleep(${STALL_STEP_MS});return true}`, args: [], lang: 'js' } } } },
        { $group: { _id: null } },
        { $replaceWith: { _id: 'run' } },
      ],
    });
  } finally { await db().collection(`${space}_src`).deleteMany({}); }
}

/** How many `aggregate` calls each collection received while `fn` ran: a sweep reads a kind twice (its count, then its walk). */
async function aggregatesDuring(fn) {
  const original = proto.aggregate;
  const counts = new Map();
  proto.aggregate = function counting(...args) {
    counts.set(this.collectionName, (counts.get(this.collectionName) ?? 0) + 1);
    return original.apply(this, args);
  };
  try { await fn(); } finally { proto.aggregate = original; }
  return counts;
}

describe('a reindex boot failure is retried by the tick (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'reindex-tick', instanceLabel: 'test', tokens: [], networks: [],
      spaces: SPACES.map(id => ({ id, label: id, folders: [] })),
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('reindextick');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    reindex = await import('../../server/dist/brain/reindex.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    shared = await import('../../server/dist/spaces/_shared.js');
    registry = await import('../../server/dist/metrics/registry.js');
    proto = Object.getPrototypeOf(mongo.col('probe'));
  });

  after(async () => {
    stopWatcher();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // THE FIRST CASE, and it has to stay first: the watcher is one timer for the process and `startReindex` (which `ref`, below,
  // uses to read the target) arms it. Nothing here has started a run, and no space holds one, so what arms it is the FAILURE.
  it('a boot that could not read a space\'s run still arms the watcher, and the watcher alone resumes the run once the fault clears', async () => {
    const space = 'boot-fail';
    let resolved = false;
    let lines;
    await withFailingRunReads(space, async () => {
      ({ lines } = await logLinesDuring(async () => { await reindex.resumeReindexRuns(); resolved = true; }));
    });
    assert.equal(resolved, true, 'a space that cannot be read must not make the boot resume throw');
    const said = linesFor(lines, 'Reindex resume', space);
    assert.equal(said.length, 1, `reported once, by name: ${said.join(' | ')}`);
    assert.match(said[0], /retried next tick/, 'and saying who retries it');

    // The fault is gone (the view was put back as an ordinary collection). The run exists now; only the watcher can find it.
    const ids = await seedFacts(space, 5);
    await seedRun(space, { flagged: true, target: { model: 'a-model-the-config-no-longer-runs', dimensions: DIMS, prefixScheme: null } });
    await sweepDone(space);
    assert.deepEqual([...await rebuildQueued(space)].sort(), ids,
      'the tick resumed the run from the start: its target is not the configuration\'s, so every record is queued again');
    const doc = await runCol(space).findOne({ _id: 'run' });
    assert.equal(typeof doc.sweepLeaseAt, 'number', 'the resumer took the lease');
    stopWatcher();
  });

  describe('everything below drives the tick itself', () => {
    beforeEach(async () => {
      stopWatcher();
      for (const s of SPACES) {
        await factsCol(s).deleteMany({});
        await jobsCol(s).deleteMany({});
        await runCol(s).deleteMany({});
        shared.setReindexNeeded(s, false);
      }
      queue.resetEmbedPendingHint();
      if (!targetOfThisConfig) {
        // Read from a run `startReindex` wrote, never spelled here (the sibling file does the same).
        const decision = await reindex.planReindex({ spaceId: 'ref', space: spaceConfig('ref'), memberIds: ['ref'] });
        await reindex.startReindex(decision.plan);
        targetOfThisConfig = (await runCol('ref').findOne({ _id: 'run' })).target;
        stopWatcher();
        await runCol('ref').deleteMany({});
      }
    });

    describe('a failing space is that space\'s', () => {
      it('at boot: one report, and the spaces after it are still resumed', async () => {
        await seedFacts('skip-ok', 4);
        await seedRun('skip-ok', { sweepLeaseAt: STALE() });
        let lines;
        await withFailingRunReads('skip-fail', async () => {
          ({ lines } = await logLinesDuring(() => reindex.resumeReindexRuns()));
          await sweepDone('skip-ok');
        });
        assert.equal((await rebuildQueued('skip-ok')).size, 4, 'the space after the failing one was resumed and swept');
        assert.equal(linesFor(lines, 'Reindex resume', 'skip-fail').length, 1, 'the failing one is reported once');
      });

      it('in the tick: one report, and a finished run of a later space is still finished', async () => {
        shared.setReindexNeeded('tick-ok', true);
        await seedRun('tick-ok', { flagged: true, sweepComplete: true, sweepLeaseAt: STALE() });
        let lines;
        await withFailingRunReads('tick-fail', async () => {
          ({ lines } = await logLinesDuring(() => reindex.reindexRunTick()));
        });
        assert.equal(await runCol('tick-ok').findOne({ _id: 'run' }), null, 'the later space\'s finished run was finished');
        assert.equal(shared.needsReindex('tick-ok'), false, 'and its flag cleared');
        const said = linesFor(lines, 'Reindex watcher', 'tick-fail');
        assert.equal(said.length, 1, `reported once, in the walk's words: ${lines.join(' | ')}`);
        assert.match(said[0], /retried next tick/);
      });
    });

    describe('the gauge has one writer, and never says less than the truth', () => {
      // Each starts from a POISONED value: a gauge already at the expected value proves nothing about the step under test.
      it('a boot that could not read a space leaves it at its last value', async () => {
        await seedRun('gauge-ok', { sweepLeaseAt: HELD() });
        await withFailingRunReads('gauge-bad', async () => {
          registry.reindexInProgress.set(99);
          await logLinesDuring(() => reindex.resumeReindexRuns());
          assert.equal(await gauge(), 99,
            'a boot that could not read a space wrote a count of the spaces it could: the unreadable one may hold a run');
        });
      });

      it('a tick that could not read a space leaves it at its last value', async () => {
        await seedRun('gauge-ok', { sweepLeaseAt: HELD() });
        await withFailingRunReads('gauge-bad', async () => {
          registry.reindexInProgress.set(99);
          await logLinesDuring(() => reindex.reindexRunTick());
          assert.equal(await gauge(), 99, 'a tick wrote a count of the spaces it could read: the number said fewer runs than there are');
        });
      });

      it('once every space answers, the tick and the boot each recompute it exactly', async () => {
        await seedRun('gauge-ok', { sweepLeaseAt: HELD() });
        registry.reindexInProgress.set(99);
        await reindex.reindexRunTick();
        assert.equal(await gauge(), 1, 'a tick: exactly the active runs');
        registry.reindexInProgress.set(99);
        await reindex.resumeReindexRuns();
        assert.equal(await gauge(), 1, 'and the boot');
      });

      it('is written at ONE place in server/src', () => {
        const writers = trackedSources('server/src', { floor: 100 })
          .map(file => ({ file, src: stripComments(fs.readFileSync(file, 'utf8')) }))
          .map(({ file, src }) => ({ file, n: (src.match(/reindexInProgress\s*\.\s*(?:set|inc|dec|reset|zero|labels)\s*\(/g) ?? []).length }))
          .filter(w => w.n > 0);
        assert.ok(writers.length >= 1, 'the scan found no writer of the gauge at all: the pattern or the scan is broken');
        assert.deepEqual(writers.map(w => `${w.file} x${w.n}`), [`server/src/brain/reindex.ts x1`],
          'ythril_reindex_in_progress has one writer: two of them is how the tick and the boot disagreed');
      });
    });

    describe('a run has one sweeper: the lease', () => {
      it('a run whose lease is held is resumed by neither the boot nor the tick', async () => {
        await seedFacts('lease-held', 6);
        const lease = HELD();
        await seedRun('lease-held', { sweepLeaseAt: lease });
        await reindex.resumeReindexRuns();
        await reindex.reindexRunTick();
        await sleep(400); // a sweep that WAS started begins on the next turn; give it far more than that
        assert.equal((await rebuildQueued('lease-held')).size, 0, 'a sweep ran over a run that another process is sweeping');
        const doc = await runCol('lease-held').findOne({ _id: 'run' });
        assert.equal(doc.sweepLeaseAt, lease, 'and the lease it does not own was left alone');
        assert.equal(doc.cursor, null);
      });

      it('a run whose lease is stale is resumed by the boot, and the lease is taken', async () => {
        const before = Date.now();
        const ids = await seedFacts('lease-stale', 6);
        await seedRun('lease-stale', { sweepLeaseAt: STALE() });
        await reindex.resumeReindexRuns();
        await sweepDone('lease-stale');
        assert.deepEqual([...await rebuildQueued('lease-stale')].sort(), ids);
        assert.ok((await runCol('lease-stale').findOne({ _id: 'run' })).sweepLeaseAt >= before, 'the resumer took the lease');
      });

      it('a run with no lease at all (written before the lease existed) is resumable', async () => {
        const ids = await seedFacts('lease-stale', 3);
        await seedRun('lease-stale');
        await reindex.resumeReindexRuns();
        await sweepDone('lease-stale');
        assert.deepEqual([...await rebuildQueued('lease-stale')].sort(), ids);
      });

      it('the tick resumes a run whose sweep is not complete, once its lease is stale', async () => {
        const ids = await seedFacts('lease-tick', 6);
        await seedRun('lease-tick', { sweepLeaseAt: STALE() });
        await reindex.reindexRunTick();
        await sweepDone('lease-tick');
        assert.deepEqual([...await rebuildQueued('lease-tick')].sort(), ids,
          'a tick that never resumes is a failed boot resume that waits for the next restart');
      });

      it('a tick that finds a finished run built for another model restarts it, and does not finish it from the copy it read', async () => {
        const ids = await seedFacts('lease-retarget', 4);
        shared.setReindexNeeded('lease-retarget', true);
        // Complete, nothing queued, so by the OLD rule a tick would end it on the spot; but its vectors are for a model
        // the instance no longer runs.
        await seedRun('lease-retarget', {
          flagged: true, sweepComplete: true, sweepLeaseAt: STALE(),
          target: { ...targetOfThisConfig, model: `${targetOfThisConfig.model}-previous` },
        });
        await reindex.reindexRunTick();
        const doc = await runCol('lease-retarget').findOne({ _id: 'run' });
        assert.ok(doc, 'the tick ended a run it had just restarted');
        assert.equal(shared.needsReindex('lease-retarget'), true, 'and cleared the flag recall is refused behind');
        await sweepDone('lease-retarget');
        assert.deepEqual([...await rebuildQueued('lease-retarget')].sort(), ids, 'every record is queued again');
        assert.deepEqual((await runCol('lease-retarget').findOne({ _id: 'run' })).target, targetOfThisConfig);
      });

      it('an errored run is resumed by neither', async () => {
        await seedFacts('lease-err', 4);
        const lease = STALE();
        await seedRun('lease-err', { sweepLeaseAt: lease, error: 'the sweep failed after 3 attempts' });
        await reindex.resumeReindexRuns();
        await reindex.reindexRunTick();
        await sleep(400);
        assert.equal((await rebuildQueued('lease-err')).size, 0, 'an errored run needs an operator, not a retry');
        const doc = await runCol('lease-err').findOne({ _id: 'run' });
        assert.equal(doc.sweepLeaseAt, lease, 'and no lease was taken on it');
        assert.equal(doc.error, 'the sweep failed after 3 attempts');
      });

      it('several resumers at once sweep the run ONCE', async () => {
        // What ONE sweep costs the facts collection, measured through the same door rather than written here: it reads a kind
        // twice (its count, then its walk).
        await seedFacts('lease-base', 8);
        await seedRun('lease-base', { sweepLeaseAt: STALE() });
        const one = await aggregatesDuring(async () => { await reindex.resumeReindexRuns(); await sweepDone('lease-base'); await sleep(300); });
        const perSweep = one.get(spaceCollection('lease-base', 'facts'));
        assert.ok(perSweep >= 1, `the lone sweep read the facts collection ${perSweep} time(s): the counter is not seeing the sweep`);
        await runCol('lease-base').deleteMany({});

        await seedFacts('lease-conc', 8);
        await seedRun('lease-conc', { sweepLeaseAt: STALE() });
        const many = await aggregatesDuring(async () => {
          await Promise.all([reindex.resumeReindexRuns(), reindex.reindexRunTick(), reindex.resumeReindexRuns(),
            reindex.reindexRunTick(), reindex.resumeReindexRuns()]);
          await sweepDone('lease-conc');
          await sleep(400); // a second sweeper, had one started, has made its reads by now
        });
        assert.equal(many.get(spaceCollection('lease-conc', 'facts')), perSweep,
          'five resumers swept the run more than once: nothing says who owns a sweep');
      });

      it('the lease is taken when the run is CREATED, and the creating process\'s own tick does not sweep it again', async () => {
        const before = Date.now();
        await seedFacts('lease-new', 1_100); // a sweep of three batches: still going when the ticks below read the run
        const decision = await reindex.planReindex({ spaceId: 'lease-new', space: spaceConfig('lease-new'), memberIds: ['lease-new'] });
        const counts = await aggregatesDuring(async () => {
          await reindex.startReindex(decision.plan);
          const doc = await runCol('lease-new').findOne({ _id: 'run' });
          assert.equal(typeof doc.sweepLeaseAt, 'number', 'a run created without the lease is open to the first tick that finds it');
          assert.ok(doc.sweepLeaseAt >= before && doc.sweepLeaseAt <= Date.now());
          await Promise.all([reindex.reindexRunTick(), reindex.reindexRunTick()]);
          await sweepDone('lease-new');
          await sleep(300);
        });
        stopWatcher();
        // One sweep: its count and its walk.
        assert.equal(counts.get(spaceCollection('lease-new', 'facts')), 2, 'the tick swept a run that its creator was already sweeping');
      });

      it('every cursor save renews the lease: a sweep that is making progress is never taken from', async () => {
        await seedFacts('lease-renew', 1_100); // three batches of the walk (500, 500, 100)
        await seedRun('lease-renew', { sweepLeaseAt: STALE() });
        const saves = [];
        const original = proto.updateOne;
        proto.updateOne = function recording(filter, update, ...rest) {
          if (this.collectionName === spaceCollection('lease-renew', 'reindexRun') && update?.$set && 'cursor' in update.$set) saves.push(update.$set);
          return original.call(this, filter, update, ...rest);
        };
        try {
          await reindex.resumeReindexRuns();
          await sweepDone('lease-renew');
        } finally { proto.updateOne = original; }
        assert.ok(saves.length >= 2, `the sweep saved its cursor ${saves.length} time(s): the case is not exercising batches`);
        for (const set of saves) {
          assert.equal(typeof set.sweepLeaseAt, 'number',
            `a cursor save without a lease renewal lets the lease go stale under a live sweep: ${JSON.stringify(set)}`);
        }
      });
    });

    describe('a hung space ends at the housekeeping bound (Q-358)', () => {
      it('in the tick: it ends in about the bound, the hung space is reported once, and the next space is processed', async () => {
        shared.setReindexNeeded('hung-tick-2', true);
        await seedRun('hung-tick-2', { flagged: true, sweepComplete: true, sweepLeaseAt: STALE() });
        const restore = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
        let outcome; let lines;
        try {
          await withStalledRunReads('hung-tick-1', async () => {
            ({ lines, result: outcome } = await logLinesDuring(() => settleWithin(reindex.reindexRunTick(), 3_500)));
            if (!outcome.settled) await outcome.rest; // the stall's own end, before the view is put back
          });
        } finally { restore(); }
        assert.ok(outcome.settled, `the tick was still waiting after ${outcome.elapsedMs}ms on a read that stalls for ${STALL_MS}ms: nothing ended it at the ${BOUND_MS}ms bound`);
        assert.equal(outcome.ok, true, `the tick returns for a hung space: ${outcome.error}`);
        assert.equal(await runCol('hung-tick-2').findOne({ _id: 'run' }), null, 'the space after the hung one was processed');
        const said = linesFor(lines, 'Reindex watcher', 'hung-tick-1');
        assert.equal(said.length, 1, `reported once: ${said.join(' | ')}`);
        assert.match(said[0], /time bound of 1000 ms/, 'in the words of the bound it ran into');
      });

      it('at boot: the same, and the resumed run of the next space is swept', async () => {
        await seedFacts('hung-boot-2', 4);
        await seedRun('hung-boot-2', { sweepLeaseAt: STALE() });
        const restore = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
        let outcome; let lines;
        try {
          await withStalledRunReads('hung-boot-1', async () => {
            ({ lines, result: outcome } = await logLinesDuring(() => settleWithin(reindex.resumeReindexRuns(), 3_500)));
            if (!outcome.settled) await outcome.rest;
            if (outcome.settled) await sweepDone('hung-boot-2');
          });
        } finally { restore(); }
        assert.ok(outcome.settled, `the boot resume was still waiting after ${outcome.elapsedMs}ms: nothing ended the stalled read at the bound`);
        assert.equal(outcome.ok, true, `${outcome.error}`);
        assert.equal((await rebuildQueued('hung-boot-2')).size, 4, 'the space after the hung one was resumed');
        assert.equal(linesFor(lines, 'Reindex resume', 'hung-boot-1').length, 1, 'the hung space is reported once');
      });
    });

    describe('the watcher is a timer that can be stopped', () => {
      it('stopReindexWatcher is exported, so a shutdown and a test can end the one timer', () => {
        assert.equal(typeof reindex.stopReindexWatcher, 'function');
      });
    });

    describe('the run collection is local to this instance', () => {
      it('no list of the replicated collections names it', async () => {
        const kinds = await import('../../server/dist/config/types-knowledge.js');
        assert.ok(kinds.BRAIN_COLLECTIONS.length >= 5, 'the list of replicated collections was not read');
        assert.equal(kinds.BRAIN_COLLECTIONS.includes('reindexRun'), false,
          'a field added to the run document (`sweepLeaseAt`) would be hashed and replicated if the run were a brain collection');
      });
    });
  });
});
