/**
 * Re-embedding a space: the refusals, and the RUN — a document per space that queues every record for a rebuild
 * and finishes when the queue has rebuilt them.
 *
 * ## Why a reindex goes through the embed queue (Q-99 part 2)
 *
 * It used to embed inline: five hand-written loops, one per collection, each with its own projection and its own
 * call to an embed-text builder, running on the server's main thread. Three things were wrong with that, and all
 * three were invisible:
 *
 *  - **The copy had drifted from the queue's builder.** An edge's projection dropped its endpoint kinds, so a fact or
 *    file end embedded its raw id; a file's dropped `excerpt`, so every converted document re-embedded without its
 *    own text. Nothing stores `matchedText` there, so no API could see the difference.
 *  - **Derived records were never rebuilt.** Passages and captions kept the old model's vectors after a model change.
 *  - **Nothing survived a restart**, and an outage turned every record into an `errors++` that was never retried.
 *
 * So a reindex now queues: `queueEmbedSweep` walks the space, `enqueueEmbedJobs` puts a `rebuild` job in the lowest
 * lane for every record, and the worker rebuilds each through `embedStoredRecord` — the same text builder every
 * write uses, for derived records too. A record's vector has exactly one place it is made.
 *
 * ## The run is a document, and that is what makes it honest
 *
 * `<space>_reindex_run`, `_id: 'run'`. It records what the run promised (`flagged`: needsReindex was asserted when it
 * began; `target`: the model, dimensions and prefix scheme it is rebuilding for), how far the sweep got (`cursor`,
 * saved after each acknowledged batch), and whether the sweep has finished. A boot re-asserts the flag from it in the
 * same step that computes needsReindex (`initSpace`), so recall never reopens over half-rebuilt vectors; it resumes
 * the sweep from the cursor, and restarts it when the target changed underneath. Being one of the SPACE's
 * collections, it moves with a rename and goes with a delete or a full wipe.
 *
 * ## Who sweeps: the lease (`Q-274`, bundle-53 G15)
 *
 * Two things resume a run whose sweep is not complete: the boot (`resumeReindexRuns`) and the watcher's tick, which is what
 * retries a boot that could not (a space that failed or hung, a store that was down). They must not both sweep it, and in two
 * processes (a rolling restart, a second instance on the same database) a variable in memory cannot say. The run document says:
 * `sweepLeaseAt`, taken with one atomic `findOneAndUpdate` by whoever resumes the run (`takeSweepLease`), by `startReindex` at
 * creation, and renewed in the same write as every saved cursor. A lease older than a minute is a sweep that died.
 *
 * A run ends when its sweep is complete and no rebuild job of the space is pending or processing. It then clears
 * needsReindex, logs what it did, and deletes its document. A sweep that keeps failing records `error`, keeps the
 * document and the flag, and does not block a new reindex, which replaces it.
 *
 * ## Two properties that are easy to lose
 *
 *  - **A re-embed is not a write.** `embedStoredRecord` writes the vector with a direct `$set`, so `seq` and
 *    `updatedAt` do not move. Through the record update path, every record in the space would be a sync-visible
 *    change on every peer, for a local re-embed that changed no content.
 *  - **Never await the work.** Both doors answer `status: 'started'` as soon as the run document is written; the
 *    sweep and the rebuild run after. Awaiting would turn a multi-minute job into a request timeout.
 *
 * ## The refusal is per space
 *
 * One reindex per INSTANCE was the rule while the work ran inline: two concurrent loops would embed the same
 * records and fight over the main thread. The queue serialises the embedding now and coalesces a record's jobs, so
 * that refusal protected nothing and cost every operator a whole drain between spaces. A space with an active run
 * refuses a second one; any other space starts.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { getEmbeddingConfig } from '../config/loader.js';
import { needsReindex, clearReindexFlag, setReindexNeeded } from '../spaces/_shared.js';
import { isProxy, concreteSpaces } from '../spaces/proxy.js';
import { reindexInProgress } from '../metrics/registry.js';
import { log, peerText } from '../util/log.js';
import { spaceCollection } from '../db/space-collection.js';
import { queueEmbedSweep, countUnswept, type SweepCursor } from './queue-embed-sweep.js';
import { EMBED_PRIORITY, getEmbedJobCounts } from './embed-queue.js';
import { resolvePrefixScheme } from './embedding.js';
import { backoffDelayMs } from '../util/backoff.js';
import { eachSpace, type WalkResult } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { intervalJob } from '../util/interval-job.js';
import type { SpaceConfig, BrainEmbedRecordType } from '../config/types.js';

/** A refusal, carrying the status the contract suite pins. */
export type ReindexRefusal = {
  status: 400 | 404 | 409;
  body: { error: string; proxyFor?: string[] };
};

export type ReindexPlan = {
  spaceId: string;
  /** The member spaces to walk -- for a normal space, itself. Resolved by the caller, which knows the token scope. */
  memberIds: string[];
};

export type ReindexDecision =
  | { ok: false; refusal: ReindexRefusal }
  | { ok: true; plan: ReindexPlan };

/** What a run is rebuilding FOR. A resume under a different target starts the sweep again. */
interface ReindexTarget {
  model: string;
  dimensions: number;
  prefixScheme: string | null;
}

/**
 * The run document. Local to this instance: it never syncs, and it is not hashed (`reindexRun` is in no list of the replicated
 * collections: `BRAIN_COLLECTIONS` holds the record kinds only, and a test holds that), so a field added here needs no
 * `Incoming*` schema and no entry in `merkle.ts`.
 */
interface ReindexRunDoc {
  _id: 'run';
  spaceId: string;
  members: string[];
  /** needsReindex was asserted for the space when the run began, so the run must keep it asserted until done. */
  flagged: boolean;
  target: ReindexTarget;
  startedAt: string;
  /** The last moment the run's remaining work went down; the no-progress warning measures from it. */
  progressAt?: string;
  lastRemaining?: number;
  warnedStalled?: boolean;
  cursor: (SweepCursor & { member?: string }) | null;
  sweepComplete: boolean;
  /**
   * Whose sweep this is, as a fact on the document: the moment (epoch ms) the sweeper last proved it is alive. Taken atomically
   * (`takeSweepLease`) by whoever resumes the run, at CREATION by the process that starts it, and renewed with every cursor
   * save. A run whose lease is younger than {@link SWEEP_LEASE_STALE_MS} is being swept and is left alone; absent (a run written
   * before the lease existed) reads as stale. Cross-process safe because the document is the only thing both sides read.
   */
  sweepLeaseAt?: number;
  queued?: number;
  skippedSuppressed?: number;
  error?: string;
}

const RUN_ID = 'run' as const;
/** One tick of the watcher, for every run on the instance. */
const WATCH_MS = 5_000;
/** A run whose remaining work has not gone down for this long says so, once. */
const STALLED_MS = 10 * 60_000;
/** Attempts at a sweep before the run records its error. */
const SWEEP_ATTEMPTS = 3;
/**
 * How long a sweep may go without renewing its lease before another may take the run. A sweeper renews with every saved cursor (a
 * batch of 500 records), so a live one is far inside this. It is also how long a run waits after a CRASH: the dead process's lease
 * looks fresh to the boot that follows, and the watcher's tick takes the run once it is stale. Not larger, for that reason; not
 * smaller, because a duplicate sweeper is wasted work (a rebuild job is coalesced per record) and never wrong.
 */
const SWEEP_LEASE_STALE_MS = 60_000;

/** The names a failure of each walk is counted and said under (`declareStep`: the series start at 0). */
const WATCH_STEP = declareStep('Reindex watcher');
const RESUME_STEP = declareStep('Reindex resume');
const GAUGE_STEP = declareStep('Reindex gauge');
/** All three are retried by the next tick of the watcher. */
const WHEN = 'next tick';

const runs = (spaceId: string) => col<ReindexRunDoc>(spaceCollection(spaceId, 'reindexRun'));

/**
 * What the vectors are made by now. The prefix scheme is the EFFECTIVE one (`resolvePrefixScheme`): under `auto` a
 * change of endpoint changes the scheme, and naming `nomic` where `auto` already meant it changes nothing. Similarity
 * is not here — it shapes the search index, not a vector.
 */
function currentTarget(): ReindexTarget {
  const cfg = getEmbeddingConfig();
  return { model: cfg.model, dimensions: cfg.dimensions, prefixScheme: resolvePrefixScheme(cfg) };
}

function sameTarget(a: ReindexTarget | undefined, b: ReindexTarget): boolean {
  return !!a && a.model === b.model && Number(a.dimensions) === Number(b.dimensions)
    && (a.prefixScheme ?? null) === (b.prefixScheme ?? null);
}

async function activeRun(spaceId: string): Promise<ReindexRunDoc | null> {
  const doc = await runs(spaceId).findOne(asFilter<ReindexRunDoc>({ _id: RUN_ID })) as ReindexRunDoc | null;
  return doc && !doc.error ? doc : null;
}

/**
 * Decide a reindex: refuse it, or return the run to start.
 *
 * `memberIds` is passed in rather than resolved here because scope resolution differs per surface -- REST narrows by
 * request, MCP by the token's accessible spaces -- and re-deriving it here would be a second place for the two to
 * disagree about which spaces a token may touch. The proxy refusal comes before the run check, as it always has.
 */
export async function planReindex(input: {
  spaceId: string;
  space: SpaceConfig | undefined;
  memberIds: string[];
}): Promise<ReindexDecision> {
  const { spaceId, space, memberIds } = input;

  if (!space) {
    return { ok: false, refusal: { status: 404, body: { error: `Space '${spaceId}' not found` } } };
  }

  /**
   * A PROXY is refused, by name, with its members listed.
   *
   * It used to answer `200 {"status":"started"}` and then re-embed the member spaces -- which the caller was also
   * reindexing individually, because they are in the same space list. A proxy is not a place records live, so the
   * members are named and the remedy is the response rather than a second lookup.
   */
  if (isProxy(space)) {
    const members = space.proxyFor!;
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: `'${spaceId}' is a proxy space and has no index of its own. `
            + `Reindex its members instead: ${members.join(', ')}.`,
          proxyFor: members,
        },
      },
    };
  }

  for (const mid of memberIds) {
    if (await activeRun(mid)) {
      // Names only the space that was asked for: a refusal must not tell a scoped token about other spaces.
      return { ok: false, refusal: { status: 409, body: { error: `A reindex of '${spaceId}' is already running` } } };
    }
  }

  return { ok: true, plan: { spaceId, memberIds } };
}

/**
 * Write the run document and start its sweep, then return.
 *
 * Resolves once the document is written — a restart from then on resumes the run — and never awaits the sweep or the
 * rebuild. The members are persisted from the request's scope, and a resumed run re-walks them without a token: the
 * work is local and idempotent, and it is what the caller who started it asked for.
 */
export async function startReindex(plan: ReindexPlan): Promise<void> {
  const now = new Date().toISOString();
  for (const mid of plan.memberIds) {
    const doc: ReindexRunDoc = {
      _id: RUN_ID,
      spaceId: mid,
      members: [mid],
      flagged: needsReindex(mid),
      target: currentTarget(),
      startedAt: now,
      progressAt: now,
      cursor: null,
      sweepComplete: false,
      // Born leased: the process that starts the run sweeps it, and no tick may find it unowned in the moment between the
      // document and the sweep's first batch.
      sweepLeaseAt: Date.now(),
    };
    // Replaces an errored run, which is the operator's way out of one.
    await runs(mid).replaceOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }), doc, { upsert: true });
    sweepInBackground(mid);
  }
  await refreshGauge();
  armWatcher();
}

/**
 * Start (or resume) a run's sweep on the next turn, so the caller's response is not held behind it. The caller HOLDS the run's
 * lease (it created the run, or `takeSweepLease` returned it): the sweep renews it and never asks for it.
 */
function sweepInBackground(spaceId: string): void {
  setImmediate(() => { void sweepRun(spaceId); });
}

/**
 * Take the sweep of a run: the one atomic step that decides who sweeps. Matches only a run that has not ended in error and whose
 * lease is stale or absent (`$not` / `$gte`, so a missing field matches: a run written before the lease existed is resumable), and
 * answers the run AS IT IS NOW, so a caller that lost a race to a sweep that has since finished reads `sweepComplete` from the
 * document and not from the copy it read earlier. `null` is "someone else has it, or it is not a run to resume".
 */
async function takeSweepLease(spaceId: string): Promise<ReindexRunDoc | null> {
  const now = Date.now();
  return await runs(spaceId).findOneAndUpdate(
    asFilter<ReindexRunDoc>({
      _id: RUN_ID,
      error: { $exists: false },
      sweepLeaseAt: { $not: { $gte: now - SWEEP_LEASE_STALE_MS } },
    }),
    asUpdate<ReindexRunDoc>({ $set: { sweepLeaseAt: now } }),
    { returnDocument: 'after' },
  ) as ReindexRunDoc | null;
}

/**
 * Resume a run whose sweep is not being made — the ONE function the boot and the tick both ask, so the target-changed reset has a
 * single copy. Does nothing for a run with nothing to sweep (its sweep is complete under the configuration it is running now) and
 * for one another sweeper holds. A run built for a model the instance no longer runs starts its sweep again from the beginning.
 *
 * Returns whether it started a sweep (or reset the run to start one): the caller's copy of the document is then out of date.
 */
async function resumeRun(run: ReindexRunDoc, target: ReindexTarget): Promise<boolean> {
  const retargeted = !sameTarget(run.target, target);
  if (run.sweepComplete && !retargeted) return false;
  const held = await takeSweepLease(run.spaceId);
  if (!held) return false;
  if (!sameTarget(held.target, target)) {
    log.info(`Reindex of '${peerText(run.spaceId)}' resumes against a different embedding configuration: its sweep starts again`);
    await runs(run.spaceId).updateOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }),
      { $set: { target, cursor: null, sweepComplete: false } });
  } else if (held.sweepComplete) {
    return false;
  }
  sweepInBackground(run.spaceId);
  return true;
}

/** Walk the space and queue every record as a rebuild, saving the cursor as it goes; retry, then record the error. */
async function sweepRun(spaceId: string): Promise<void> {
  let lastError = '';
  for (let attempt = 1; attempt <= SWEEP_ATTEMPTS; attempt++) {
    try {
      const run = await activeRun(spaceId);
      if (!run || run.sweepComplete) return;
      // A retry waited out its backoff: say the sweep is alive before it goes on.
      if (attempt > 1) await runs(spaceId).updateOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }), { $set: { sweepLeaseAt: Date.now() } });
      const swept = await queueEmbedSweep(spaceId, {
        match: 'all',
        priority: EMBED_PRIORITY.rebuild,
        rebuild: true,
        ...(run.cursor ? { after: { kind: run.cursor.kind as BrainEmbedRecordType, lastId: run.cursor.lastId } } : {}),
        onBatch: async (cursor) => {
          // The lease is renewed in the SAME write as the cursor: a sweep that is making progress is never one a tick may take.
          await runs(spaceId).updateOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }), { $set: { cursor, sweepLeaseAt: Date.now() } });
        },
      });
      await runs(spaceId).updateOne(
        asFilter<ReindexRunDoc>({ _id: RUN_ID }),
        { $set: { sweepComplete: true }, $inc: { queued: swept.enqueued, skippedSuppressed: swept.skippedSuppressed } },
      );
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < SWEEP_ATTEMPTS) await new Promise(r => setTimeout(r, backoffDelayMs(attempt - 1, 1_000, 10_000)));
    }
  }
  try {
    const run = await runs(spaceId).findOne(asFilter<ReindexRunDoc>({ _id: RUN_ID })) as ReindexRunDoc | null;
    const at = run?.cursor ? ` (stopped after ${run.cursor.kind} ${run.cursor.lastId})` : '';
    log.error(`Reindex of '${peerText(spaceId)}' could not queue its records after ${SWEEP_ATTEMPTS} attempts${peerText(at)}: ${peerText(lastError)}`);
    await runs(spaceId).updateOne(
      asFilter<ReindexRunDoc>({ _id: RUN_ID }),
      { $set: { error: `the sweep failed after ${SWEEP_ATTEMPTS} attempts: ${peerText(lastError, { max: 300 })}` } },
    );
  } catch (err) {
    log.error(`Reindex of '${peerText(spaceId)}': could not record the sweep's failure: ${peerText(err)}`);
  }
  await refreshGauge().catch(() => { /* the next tick recomputes it */ });
}

/** Rebuild jobs of a space still to run, and the ones that went terminal — from one snapshot of the queue. */
async function rebuildCounts(spaceId: string): Promise<{ remaining: number; failed: number }> {
  const c = await getEmbedJobCounts(spaceId, { rebuild: true });
  return { remaining: c.pending + c.processing, failed: c.failed };
}

/**
 * What a caller sees of a space's reindex: whether recall is waiting for one, and how far the running one has got.
 *
 * The one answer both doors give (`GET .../reindex-status` and `space_meta`), so a client polling either reads the
 * same numbers. `remaining` and `failed` count rebuild jobs: the work a reindex queued and the work that gave up.
 */
export async function reindexStateFor(memberIds: string[]): Promise<{
  needsReindex: boolean;
  reindexRun: { running: boolean; remaining: number; failed: number };
}> {
  let running = false;
  let remaining = 0;
  let failed = 0;
  for (const mid of memberIds) {
    const run = await activeRun(mid);
    if (run) running = true;
    const c = await rebuildCounts(mid);
    remaining += c.remaining;
    failed += c.failed;
    // Until the sweep is complete, the records it has not reached yet are left too — or the first poll of a run reads
    // "0 left" while every record waits to be queued.
    if (run && !run.sweepComplete) {
      remaining += await countUnswept(mid, {
        match: 'all',
        ...(run.cursor ? { after: { kind: run.cursor.kind as BrainEmbedRecordType, lastId: run.cursor.lastId } } : {}),
      });
    }
  }
  return { needsReindex: memberIds.some(mid => needsReindex(mid)), reindexRun: { running, remaining, failed } };
}

/**
 * Did the walk ANSWER for every space it was given? Only then is a count made from it the whole truth: a space that failed, was
 * passed over in quarantine, or was never reached because the store stopped answering may hold a run the count never saw.
 */
function walkAnswered(walk: WalkResult<unknown>, spaces: number): boolean {
  return !walk.storeDown && !walk.stalled && walk.outcomes.length === spaces && walk.outcomes.every(o => o.status === 'ok');
}

/**
 * THE writer of `ythril_reindex_in_progress` (a test holds that no other statement in `server/src` sets it): the number of active
 * runs, and only when every space was read. A count that skipped a space says fewer runs than there are, which is the direction
 * an operator trusts ("nothing is running"); so while any space could not be read the gauge keeps its last value (`OB-1`).
 */
function publishGauge(active: number, answered: boolean): void {
  if (answered) reindexInProgress.set(active);
}

/**
 * The gauge, recomputed from the documents so two runs can never leave it wrong. For the callers that read no run document
 * themselves (a start, a sweep that gave up); the tick and the boot count while they walk and call {@link publishGauge}.
 */
async function refreshGauge(): Promise<void> {
  const spaces = concreteSpaces();
  let n = 0;
  const walk = await eachSpace(GAUGE_STEP, spaces, async (space) => { if (await activeRun(space.id)) n++; }, { when: WHEN });
  publishGauge(n, walkAnswered(walk, spaces.length));
}

/**
 * One tick of the watcher, for every run on the instance. Exported so a test drives it instead of waiting on a timer.
 *
 * Every space is its own unit of the walk (`eachSpace`): one whose run cannot be read, or whose read hangs, is reported once and
 * the spaces behind it are still looked at. There is no per-step catch inside a space: a space's tick is one step, and what fails
 * in it fails the space, which is what lets the walk SEE it.
 *
 * - **A run whose sweep is not complete is resumed** when nobody holds its lease (`resumeRun`): a boot that could not resume it
 *   (a failing space, a store that was down) is retried here, every tick, until it succeeds.
 * - **A run is finished** when its sweep is complete and no rebuild job is left pending or processing. A run whose sweep is not
 *   complete is never finished here, whoever is or is not sweeping it: an incomplete sweep is a promise of records not yet queued.
 */
export async function reindexRunTick(): Promise<void> {
  const spaces = concreteSpaces();
  const target = currentTarget();
  let active = 0;
  const walk = await eachSpace(WATCH_STEP, spaces, async (space) => {
    const run = await activeRun(space.id);
    if (!run) return;
    active++;
    // Started or reset: the document read above is out of date, and finishing from it would end a run that was just restarted.
    if (await resumeRun(run, target)) return;
    const { remaining, failed } = await rebuildCounts(space.id);
    const now = Date.now();
    if (!run.sweepComplete || remaining > 0) {
      if (run.lastRemaining === undefined || remaining < run.lastRemaining) {
        await runs(space.id).updateOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }),
          { $set: { lastRemaining: remaining, progressAt: new Date(now).toISOString(), warnedStalled: false } });
      } else if (!run.warnedStalled && now - Date.parse(run.progressAt ?? run.startedAt) > STALLED_MS) {
        log.warn(`Reindex of '${peerText(space.id)}' has made no progress for ${Math.round(STALLED_MS / 60_000)} minutes: `
          + `${remaining} record(s) still to rebuild${run.sweepComplete ? '' : ', and the sweep has not finished'}`);
        await runs(space.id).updateOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }), { $set: { warnedStalled: true } });
      }
      return;
    }
    for (const mid of run.members) clearReindexFlag(mid);
    log.info(`Reindex completed for space '${peerText(space.id)}': queued=${run.queued ?? 0}, `
      + `suppressed=${run.skippedSuppressed ?? 0}, failed=${failed}`);
    await runs(space.id).deleteOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }));
    active--;
  }, { when: WHEN });
  // Counted on the same pass rather than by reading every run document again.
  publishGauge(active, walkAnswered(walk, spaces.length));
}

/**
 * One interval for every run, armed by the first run — or by a boot that could not tell whether there is one. An interval job:
 * one tick at a time (a tick slower than the interval is skipped and counted, never stacked behind the one still running), its
 * database work bounded, one walk budget for the tick, a throw contained (`util/interval-job.ts`).
 */
const watcher = intervalJob('Reindex watcher', WATCH_MS, reindexRunTick);

function armWatcher(): void { watcher.start(); }

/** End the watcher's timer. For a shutdown and for a test that drives the tick itself. A tick already running is left to finish. */
export function stopReindexWatcher(): void { watcher.stop(); }

/**
 * Pick up every run this instance had when it stopped. Called once services start, on first run and on every boot.
 *
 * A run whose target no longer matches the configuration starts its sweep again from the beginning: the vectors it
 * already rebuilt are for a model the instance no longer runs. An errored run stays as it is — it needs an operator,
 * and its flag is already re-asserted by `initSpace`.
 *
 * Every space is its own unit of the walk, so one that cannot be read does not stop the spaces behind it, and the boot never
 * throws for it. **A space that could not be read is not a space with no run:** the watcher is armed whenever any space was found
 * to hold a run OR any space could not be asked, and its tick resumes what this boot could not.
 */
export async function resumeReindexRuns(): Promise<void> {
  const spaces = concreteSpaces();
  const target = currentTarget();
  let active = 0;
  const walk = await eachSpace(RESUME_STEP, spaces, async (space) => {
    const run = await activeRun(space.id);
    if (!run) return;
    active++;
    if (run.flagged) setReindexNeeded(space.id, true);
    await resumeRun(run, target);
  }, { when: WHEN });
  const answered = walkAnswered(walk, spaces.length);
  if (active > 0 || !answered) armWatcher();
  publishGauge(active, answered);
}

/** Whether a run document asks for this space's needsReindex to stay asserted. Read by `initSpace`. */
export async function reindexRunFlags(spaceId: string): Promise<boolean> {
  const doc = await runs(spaceId).findOne(asFilter<ReindexRunDoc>({ _id: RUN_ID })) as ReindexRunDoc | null;
  return doc?.flagged === true;
}

/**
 * After a rename moved the run document to the new space's collection, make its `members` name the new id. A resumed
 * run walks `members`; left at the old id it would walk a space that no longer exists, and never end. `spaceId` is
 * already rewritten by `repairStaleSpaceIds`, the step of the rename that fixes it in every moved collection.
 */
export async function renameReindexRun(oldId: string, newId: string): Promise<void> {
  const doc = await runs(newId).findOne(asFilter<ReindexRunDoc>({ _id: RUN_ID })) as ReindexRunDoc | null;
  if (!doc) return;
  await runs(newId).updateOne(asFilter<ReindexRunDoc>({ _id: RUN_ID }), {
    $set: { members: doc.members.map(m => (m === oldId ? newId : m)) },
  });
}
