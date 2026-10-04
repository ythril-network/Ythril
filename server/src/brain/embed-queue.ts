/**
 * The embedding job queue for brain records — facts, entities, edges, chrono entries.
 *
 * ## Why writes stopped waiting for the model
 *
 * Every brain creator embedded inline, so the caller paid the model's latency on every write. Three of
 * the four then swallowed a failure (`try { embed } catch`) and stored the record without a vector;
 * `saveFact` did not, so a fact write failed outright whenever the embedder was down. Two behaviours,
 * neither of them chosen by the caller, and no path back for a record that missed its vector short of a
 * manual whole-space `POST /reindex` that re-embeds *everything*.
 *
 * A record with no vector is not a slightly worse record — it is **invisible to recall**. Both channels
 * drop it: the vector search never returns it, and the lexical channel's `introduceLexicalOnly` needs an
 * embedding to compute a real similarity and skips what it cannot score. So "stored but never embedded"
 * is silent data loss from the searcher's point of view, and nothing measured it.
 *
 * This queue makes the gap **temporary and self-healing**: the write returns as soon as the record is
 * durable, a worker embeds it moments later, and a failure retries with backoff instead of being final.
 *
 * ## What is deliberately NOT changed
 *
 * A caller who needs the record searchable when the call returns says so — `waitForEmbedding: true` —
 * and gets exactly the old behaviour, including the old failure mode. It is opt-in rather than the
 * default because the common case (an agent writing a fact) does not care, and the uncommon case
 * (write-then-immediately-search) can no longer be silently wrong.
 *
 * ## One job per record, not one per write
 *
 * `_id` is `<type>:<recordId>`, so a record written five times in a second has one job at the end
 * holding its latest content — the work is coalesced rather than queued five deep. This is the same
 * shape the media queue uses (`_id` = file id) and the reason neither queue needs de-duplication logic.
 *
 * Scheduling — the wake signal, the epoch race, the per-space probe hint — is `util/work-signal.ts`,
 * shared with the media queue. Only the job shape and the collection differ.
 */

import { col, asFilter, asUpdate, asBulk } from '../db/mongo.js';
import { log, peerText } from '../util/log.js';
import { inChunks } from '../util/chunks.js';
import { withJitter } from '../util/backoff.js';
import { createWorkSignal } from '../util/work-signal.js';
import { newClaimToken } from '../files/media/lease.js';
import { isSpillPath } from './spill-path.js';
import { LOST_MARKER, NOT_SENT_MARKER } from './embed-errors.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import type { BrainEmbedJobDoc, BrainEmbedRecordType } from '../config/types.js';
import { RECORD_TYPES } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

/** Attempts before a job is left `failed` for an operator (or a rewrite) to deal with. */
export const MAX_EMBED_ATTEMPTS = 5;

/**
 * Times one record may be the job in flight when the inference process is LOST before it is left `failed`.
 *
 * A lost process is the embedder's fault, so it is transient and spends none of the record's attempts. But "the
 * embedder's fault" is also exactly how an input that KILLS the runtime looks, for ever: an outage ends, a segfault on
 * a particular text does not. Three is enough to tell one OOM kill beside a busy moment from a record that does it
 * every time, and the terminal `failed` names the crash in `lastError` where an operator can see it and
 * `retry_embed_record` it. A retry, a rewrite and a new server version each give the record a clean count.
 */
export const MAX_LOST_CHILD_FAILURES = 3;

/**
 * More attempts than the media queue's three, for a different failure profile. A media job fails on a
 * malformed file — retrying identical bytes through the same decoder is unlikely to help. An embedding
 * job fails because the model is loading, the sidecar is restarting, or an external provider is rate
 * limiting: all transient, all resolved by waiting. The backoff carries the schedule; this only bounds it.
 */
const RETRY_BACKOFF_MS: Record<number, number> = {
  1: 5_000,
  2: 30_000,
  3: 120_000,
  4: 600_000,
};

function nextClaimableAfter(nextAttempt: number): string {
  const delay = RETRY_BACKOFF_MS[nextAttempt] ?? 1_800_000;
  // Jittered for the same reason the media queue jitters: a thousand records enqueued while the model
  // was loading would otherwise all become claimable on the same tick and hit it together.
  return new Date(Date.now() + withJitter(delay)).toISOString();
}

const _signal = createWorkSignal();

function jobs(spaceId: string) {
  return col<BrainEmbedJobDoc>(spaceCollection(spaceId, 'embedJobs'));
}

/**
 * The lanes a job is claimed in, most urgent first.
 *
 * ## Why the queue has lanes at all
 *
 * The claim used to take the oldest claimable job of the first space that had one. That was fair while every job was
 * a write. Once a reindex queues a whole space and a backfill queues every vectorless record, oldest-first holds the
 * write somebody is waiting to search for behind tens of thousands of jobs nobody is waiting for.
 *
 * - `write` — a local write.
 * - `background` — work that arrived on its own: a peer's record, a backfill.
 * - `rebuild` — a reindex.
 *
 * Every caller states its lane (`enqueueEmbedJob` takes it as a required argument), because a lane that defaults is
 * a decision nobody made at the call site.
 */
export const EMBED_PRIORITY = { write: 0, background: 1, rebuild: 2 } as const;
export type EmbedPriority = typeof EMBED_PRIORITY[keyof typeof EMBED_PRIORITY];

/** Every lane, in the order they are claimed on an ordinary claim. */
const LANES: readonly EmbedPriority[] = [EMBED_PRIORITY.write, EMBED_PRIORITY.background, EMBED_PRIORITY.rebuild];

/**
 * The lane order for the `n`th claim.
 *
 * Strict priority would let a steady stream of writes starve the other lanes for ever, and a reindex that never
 * finishes keeps its space's recall refused — so one space's writers could switch off another space's search. Every
 * fourth claim therefore starts one lane lower, in turn: lane 1 leads on n % 8 = 3, lane 2 on n % 8 = 7. Under full
 * load each lower lane keeps at least one claim in eight, and a write still leads six claims in eight.
 */
export function claimOrder(n: number): EmbedPriority[] {
  const slot = ((n % 8) + 8) % 8;
  if (slot === 3) return [EMBED_PRIORITY.background, EMBED_PRIORITY.rebuild, EMBED_PRIORITY.write];
  if (slot === 7) return [EMBED_PRIORITY.rebuild, EMBED_PRIORITY.write, EMBED_PRIORITY.background];
  return [...LANES];
}

/**
 * The filter value that selects one lane. Lane 0 also takes a job with NO priority: one queued before lanes existed,
 * which would otherwise sit in no lane and never be claimed. Two point values, so the index still orders it.
 */
function laneMatch(priority: EmbedPriority): unknown {
  return priority === EMBED_PRIORITY.write ? { $in: [EMBED_PRIORITY.write, null] } : priority;
}

let claimCount = 0;

/** Composite id, so a rewrite of the same record replaces its job rather than adding one. */
export function embedJobId(recordType: BrainEmbedRecordType, recordId: string): string {
  return `${recordType}:${recordId}`;
}

/**
 * The indexes `<space>_embed_jobs` needs, declared where the queries live.
 *
 * Same two shapes as the media queue and for the same reasons: `status` leads because every query pins
 * it to one value, and the sort key comes last so it is satisfied by the index rather than in memory.
 */
export const EMBED_JOB_INDEXES: Array<Record<string, 1>> = [
  // claimNextEmbedJob: { status, priority, claimableAfter } sorted by createdAt. The fresh pass pins all three to
  // one value each, so the index alone yields the oldest job with no sort stage.
  { status: 1, priority: 1, claimableAfter: 1, createdAt: 1 },
  // The reindex watcher: how many rebuild jobs are still pending or processing.
  { rebuild: 1, status: 1 },
  // resetStalledEmbedJobs: { status, progressAt < cutoff }, and the per-status counts.
  { status: 1, progressAt: 1 },
  // reviveFailedEmbedJobs: { status: 'failed', revivedForVersion != running }.
  { status: 1, revivedForVersion: 1 },
];

/** Idempotent — safe on every boot for every space, including spaces that predate this queue. */
export async function ensureEmbedJobIndexes(spaceId: string): Promise<void> {
  for (const keys of EMBED_JOB_INDEXES) await jobs(spaceId).createIndex(keys);
}

/**
 * Announce that a record needs embedding.
 *
 * Always resets `status`, `attempts` and `claimableAfter`: a new write is new content, so a job that had
 * exhausted its attempts on the OLD content must not inherit that verdict. This is what makes rewriting
 * a record the operator's escape hatch from a permanently failed job.
 *
 * Never throws into the caller's write path. An enqueue that fails leaves a record whose vector is missing,
 * and failing the write instead would trade a delayed search hit for lost data.
 *
 * **This used to claim "the periodic backfill sweep will find it". There was no such sweep** — the comment
 * described a repair mechanism that had never been built, which is worse than saying nothing: it is exactly the
 * kind of reassurance that stops anyone checking. A swallowed enqueue error meant a record silently missing from
 * recall forever, with no error, no metric and nothing to grep for.
 *
 * The repair now exists and is `POST /api/spaces/:id/reembed` (`brain/reembed.ts`), which queues a job for every
 * record with no vector. It is **on demand, not periodic** — say that precisely, because "it will be picked up"
 * and "an operator can pick it up" are different promises, and only one of them is true here.
 */
export async function enqueueEmbedJob(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
  { priority }: { priority: EmbedPriority },
): Promise<void> {
  // The write lane's ops through the one runner, so a single write and a batch cannot queue differently.
  try {
    await runEmbedJobOps(spaceId, [{ recordType, recordId }],
      (type, id, now) => writeJobOps(spaceId, type, id, now, { priority }));
  } catch {
    /* see the note above — a queue failure must never fail the write it was announcing */
  }
}

/**
 * Whether a record may be queued at all.
 *
 * A spill is a read's own OUTPUT, written so a caller can download a graph that did not fit inline. Embedding it
 * would spend model time turning recall results into recall-searchable content — so the next recall could match the
 * JSON dump of an earlier one. It is also deleted within a day, which is shorter than the queue's own patience on a
 * busy instance. The rule lives here, in both enqueue paths, because `upsertFileMeta` enqueues unconditionally and
 * a sweep walks every file.
 */
function embeddable(recordType: BrainEmbedRecordType, recordId: string): boolean {
  return !(recordType === 'file' && isSpillPath(recordId));
}

/**
 * A job handed back to the pending pool, claimable at once and held by nobody. The one spelling of "release the
 * claim" for every path that does it — a stall reset, a revive, a retry, a sweep — so none of them leaves a stale
 * `claimToken` that would let an old worker's finish delete the new run.
 */
function releasedClaim(now: string) {
  return {
    status: 'pending' as const,
    claimedAt: null,
    claimToken: null,
    claimableAfter: null,
    progressAt: null,
    updatedAt: now,
  };
}

/** A clean attempt budget: what a retry, a revive and new content each grant. */
function freshBudget() {
  return { attempts: 0, transientFailures: 0, lostChildFailures: 0 };
}

/** A job as it is when nothing has happened to it yet — the one place both enqueue paths take its fields from. */
function freshJob(spaceId: string, recordType: BrainEmbedRecordType, recordId: string, now: string) {
  return {
    spaceId, recordType, recordId,
    ...releasedClaim(now),
    ...freshBudget(),
    maxAttempts: MAX_EMBED_ATTEMPTS,
    lastError: null,
  };
}

/** Ids per bulk write. The probe measured no difference between 500 and 1000 (about 1 s for 40k jobs). */
const SWEEP_BATCH = 500;

/**
 * Queue many records of one kind at once — what a sweep (a reindex, a backfill) does, as opposed to a write.
 *
 * ## How it differs from `enqueueEmbedJob`, and why each difference is there
 *
 * - **It does not reset a job that is already waiting.** A sweep is not new content. A pending job keeps its
 *   attempts, its outage counter and its backoff, or a reindex during an outage would hammer the embedder by
 *   resetting every backoff it touched.
 * - **It does revive a FAILED job**, with a fresh budget: the operator asking again is the retry, and a job kept at
 *   its spent budget would go terminal on its first error.
 * - **It re-runs a PROCESSING job.** The worker holding it read the job before `rebuild` was set and may finish it as
 *   "unchanged"; nulling the claim makes that finish match nothing, so the job runs again under the rebuild.
 * - **It throws.** A write's enqueue swallows its error so the write still lands; a sweep that swallowed one would
 *   report a batch as queued that never was, and a reindex would then declare itself done over records it never
 *   reached.
 *
 * `priority` is lowered with `$min` and never raised, so a record a local write already queued stays urgent.
 */
export async function enqueueEmbedJobs(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordIds: readonly string[],
  { priority, rebuild }: { priority: EmbedPriority; rebuild?: boolean },
): Promise<{ queued: number }> {
  const queued = await runEmbedJobOps(spaceId, recordIds.map(recordId => ({ recordType, recordId })),
    (recordType_, recordId, now) => sweepJobOps(spaceId, recordType_, recordId, now, { priority, rebuild }));
  return { queued };
}

/**
 * Queue the records a WRITE just stored — `enqueueEmbedJob`'s semantics for a batch, which the write commit uses.
 *
 * Every field is reset (a new write is new content, so it must not inherit a verdict or a backoff earned on the
 * old one) and the priority only rises. **It never throws into the write** — the records are stored, and failing
 * the write would trade a delayed search hit for lost data — but it does not swallow quietly either: a failed
 * batch is many records missing from recall at once, so it warns with the count and the repair
 * (`POST /api/spaces/:id/reembed`), and the count is returned for the caller to report.
 */
export async function enqueueWriteEmbedJobs(
  spaceId: string,
  records: ReadonlyArray<{ recordType: BrainEmbedRecordType; recordId: string }>,
  { priority }: { priority: EmbedPriority },
): Promise<{ queued: number; failed: number }> {
  try {
    const queued = await runEmbedJobOps(spaceId, records,
      (recordType, recordId, now) => writeJobOps(spaceId, recordType, recordId, now, { priority }));
    return { queued, failed: 0 };
  } catch (err) {
    const failed = records.length;
    log.warn(`embed queue: ${failed} record(s) written to '${peerText(spaceId)}' were NOT queued for embedding `
      + `(${peerText(err)}). They are stored and findable by text; `
      + 'POST /api/spaces/:id/reembed queues every record that has no vector.');
    return { queued: 0, failed };
  }
}

/**
 * THE one batched write onto the jobs collection. Each lane builds its own ops (`sweepJobOps`, `writeJobOps`);
 * this applies them a batch at a time and throws on a failed write — whether that is swallowed is the lane's
 * decision, made where its reason is written.
 */
async function runEmbedJobOps(
  spaceId: string,
  records: ReadonlyArray<{ recordType: BrainEmbedRecordType; recordId: string }>,
  opsFor: (recordType: BrainEmbedRecordType, recordId: string, now: string) => object[],
): Promise<number> {
  const wanted = records.filter(r => embeddable(r.recordType, r.recordId));
  let queued = 0;
  for (const batch of inChunks(wanted, SWEEP_BATCH)) {
    const now = new Date().toISOString();
    const ops = batch.flatMap(r => opsFor(r.recordType, r.recordId, now));
    await jobs(spaceId).bulkWrite(asBulk<BrainEmbedJobDoc>(ops), { ordered: false });
    queued += batch.length;
  }
  if (queued > 0) _signal.markSpaceMayHaveWork(spaceId);
  return queued;
}

/** A sweep's ops for one record — see `enqueueEmbedJobs` for why each differs from a write's. */
function sweepJobOps(
  spaceId: string, recordType: BrainEmbedRecordType, recordId: string, now: string,
  { priority, rebuild }: { priority: EmbedPriority; rebuild?: boolean },
): object[] {
  const _id = embedJobId(recordType, recordId);
  return [
    {
      updateOne: {
        filter: { _id },
        update: {
          $setOnInsert: { ...freshJob(spaceId, recordType, recordId, now), createdAt: now },
          $min: { priority },
          ...(rebuild ? { $set: { rebuild: true } } : {}),
        },
        upsert: true,
      },
    },
    {
      // `lastError` is KEPT, as the version revive keeps it: whoever looks at the re-queued job can still see
      // what it died of last time.
      updateOne: {
        filter: { _id, status: 'failed' },
        update: { $set: { ...releasedClaim(now), ...freshBudget() } },
      },
    },
    {
      updateOne: {
        filter: { _id, status: 'processing' },
        update: { $set: releasedClaim(now) },
      },
    },
  ];
}

/** A write's op for one record — the write lane's, used by `enqueueEmbedJob` and `enqueueWriteEmbedJobs` alike. */
function writeJobOps(
  spaceId: string, recordType: BrainEmbedRecordType, recordId: string, now: string,
  { priority }: { priority: EmbedPriority },
): object[] {
  return [{
    updateOne: {
      filter: { _id: embedJobId(recordType, recordId) },
      // Every field reset: a new write is new content, and it must not inherit a verdict — or a half-hour
      // backoff earned by an outage that has since ended — reached on the old content.
      update: { $set: { ...freshJob(spaceId, recordType, recordId, now) }, $min: { priority }, $setOnInsert: { createdAt: now } },
      upsert: true,
    },
  }];
}

/**
 * Claim one job across the given spaces. Returns null when nothing is claimable.
 *
 * Lane by lane ACROSS every probed space, so a write in the last space overtakes a reindex in the first — see
 * `EMBED_PRIORITY` and `claimOrder`. Within a lane, a job never tried (`claimableAfter: null`) before one whose retry
 * has come due: the first is one equality per index field and comes out of the index already in age order, where
 * the old single query's three-way `$or` sorted every pending job in memory on every claim (61 ms a claim at 40k).
 *
 * A space leaves the probe hint only when EVERY pass found nothing there. Dropping it after an empty lane-0 pass
 * would strand its lane-2 jobs until the next full scan, which is the line that looks like bookkeeping.
 */
export async function claimNextEmbedJob(spaceIds: string[]): Promise<BrainEmbedJobDoc | null> {
  const now = new Date().toISOString();
  // Consumes the full-scan slot, so it is called exactly once per claim.
  const probe = _signal.spacesToProbe(spaceIds);
  const order = claimOrder(claimCount++);
  for (const priority of order) {
    for (const due of [false, true]) {
      for (const spaceId of probe) {
        const claimed = await jobs(spaceId).findOneAndUpdate(
          asFilter<BrainEmbedJobDoc>({
            status: 'pending',
            priority: laneMatch(priority) as never,
            claimableAfter: (due ? { $ne: null, $lte: now } : null) as unknown as string,
          }),
          asUpdate<BrainEmbedJobDoc>({
            $set: {
              status: 'processing', claimedAt: now, progressAt: now, claimableAfter: null,
              updatedAt: now, claimToken: newClaimToken(),
            },
            $inc: { attempts: 1 },
          }),
          { returnDocument: 'after', sort: { createdAt: 1 } },
        ) as BrainEmbedJobDoc | null;
        if (claimed) {
          _signal.noteClaimed(spaceId);
          return claimed;
        }
      }
    }
  }
  for (const spaceId of probe) _signal.noteEmpty(spaceId);
  return null;
}

/**
 * A finished job is DELETED rather than kept as `complete`.
 *
 * The media queue keeps completed jobs because a file's embedding status is a thing the UI reports per
 * file. Here the record itself carries `embeddingStatus`, so a retained job would be a second copy of
 * one fact — and brain records outnumber files by orders of magnitude, so an unbounded `complete` pile
 * is real storage for no answer. What "how many are pending" needs is the pending ones.
 */
export async function completeEmbedJob(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
  claimToken?: string | null,
): Promise<void> {
  await jobs(spaceId).deleteOne(asFilter<BrainEmbedJobDoc>(claimedBy(recordType, recordId, claimToken)));
}

/**
 * The filter for a job this worker CLAIMED, when it says which claim that was.
 *
 * Once the stall sweep has revived a slow job and another worker holds it, the first worker's late `completeEmbedJob`
 * (which deletes the job) or `failEmbedJob` would act on a claim that is no longer its own: the newer holder's job
 * deleted from under it, or its counters overwritten. Naming the token makes a stale finish match nothing. Without
 * a token the filter is the job's id alone, which is how every caller that does not hold a claim (a test, a delete
 * path) behaves as before.
 */
function claimedBy(recordType: BrainEmbedRecordType, recordId: string, claimToken?: string | null): { _id: string; claimToken?: string } {
  const _id = embedJobId(recordType, recordId);
  return claimToken ? { _id, claimToken } : { _id };
}

/**
 * Say the worker is alive and still on this job: advance `progressAt`, but only while the claim is still ours.
 *
 * The stall sweep revives a `processing` job whose `progressAt` is older than two minutes. An embed used to be short,
 * but a cold model load, or a queue behind a long document, now takes longer, so the worker beats while an embed is in
 * flight. `false` means the claim is gone (revived, or finished elsewhere) and is told to nobody: the holder of a stale
 * claim simply finds its finish is ignored.
 */
export async function heartbeatEmbedJob(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
  claimToken: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await jobs(spaceId).updateOne(
    asFilter<BrainEmbedJobDoc>({ ...claimedBy(recordType, recordId, claimToken), status: 'processing' }),
    asUpdate<BrainEmbedJobDoc>({ $set: { progressAt: now } }),
  );
  return res.matchedCount > 0;
}

/**
 * Retire the job for a record that is being DELETED.
 *
 * Same deletion as `completeEmbedJob`, named for the other reason it happens — a caller reading `completeEmbedJob` in a
 * delete path would reasonably wonder what completed.
 *
 * ## Why the delete path has to do this at all
 *
 * Cleanup used to be entirely lazy: the worker claims the job, finds the record gone, and treats `gone` as success. That
 * covers a `pending` job and only a `pending` job — `claimNextEmbedJob` filters on `status: 'pending'`, so a job that
 * exhausted its attempts and went terminal `failed` is **never claimed again**. Delete the record at that moment and the
 * job row outlived it for ever.
 *
 * Invisible until #861, which is exactly why it lasted: the listing and `getEmbedJobCounts` now report that row, so an
 * operator sees a permanent failure naming a `recordId` that 404s. A surface whose whole purpose is that its failures are
 * actionable cannot carry phantoms.
 *
 * Deliberately eager rather than filtered out at read time: hiding an orphan leaves it in the collection, costs a lookup
 * per listed row, and makes the counts disagree with the rows they are counting.
 */
export async function retireEmbedJob(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
): Promise<void> {
  await retireEmbedJobs(spaceId, recordType, [recordId]);
}

/**
 * Retire the jobs of many records of one kind that are gone — `retireEmbedJob`'s rule for a batch: a merge's
 * re-keyed edges, a cascade's chunk. By `embedJobId`, never a hand-spelled `${kind}:${id}` (a second spelling of
 * the id is how a retire comes to match nothing), and chunked, so a hub's thousands of ids are never one `$in`.
 */
export async function retireEmbedJobs(
  spaceId: string, recordType: BrainEmbedRecordType, recordIds: readonly string[],
): Promise<void> {
  for (const batch of inChunks(recordIds, SWEEP_BATCH)) {
    await jobs(spaceId).deleteMany(asFilter<BrainEmbedJobDoc>({ _id: { $in: batch.map(id => embedJobId(recordType, id)) } }));
  }
}

/**
 * Is this failure the RECORD's fault, or the embedder's?
 *
 * ## Why the distinction has to exist
 *
 * `MAX_EMBED_ATTEMPTS` is 5 with a backoff of 5s / 30s / 120s / 600s — about twelve and a half minutes from
 * the first failure to terminal `failed`. That budget is sized for a PER-RECORD failure. Applied to a
 * systemic one, an embedder unreachable for a quarter of an hour during an upgrade takes every queued job in
 * every space terminal at once, and the instance stops indexing without reporting a fault: every job did
 * exactly what it was told to.
 *
 * #910 made that survivable — one clean retry of everything per server version. This makes it right: an
 * outage costs WAITING rather than the budget.
 *
 * ## What counts, and what deliberately does not
 *
 * Reachability and availability: the connection never landed, or the far end said "not now". Those are
 * resolved by waiting and by nothing else the caller can do.
 *
 * A `400` or `422` is NOT here, and that is the whole point of keeping a budget at all — a malformed input is
 * exactly the per-record failure `attempts` exists to bound. Retrying it forever would replace one silent
 * failure mode with another: a job that never completes and never gives up.
 *
 * Matched on the message because that is what reaches us — the embedder is behind `fetch`, an HTTP client or
 * an inference child process depending on configuration, and there is no one error type across the three.
 */
export function isTransientEmbedError(message: string): boolean {
  const m = message.toLowerCase();
  return [
    // A crashed inference process, raised by the host (`embed-errors.ts` owns the words). Transient, and capped per record.
    LOST_MARKER,
    // A request queued behind that crash, never sent to the process that died: transient too, and NOT counted.
    NOT_SENT_MARKER,
    'econnrefused', 'econnreset', 'etimedout', 'ehostunreach', 'enetunreach', 'eai_again', 'enotfound',
    'socket hang up', 'fetch failed', 'network error', 'timeout', 'timed out',
    'too many requests', 'service unavailable', 'bad gateway', 'gateway timeout', 'temporarily unavailable',
    ' 429', ' 502', ' 503', ' 504', 'status 429', 'status 502', 'status 503', 'status 504',
  ].some(needle => m.includes(needle));
}

/**
 * Requeue with backoff, or leave `failed` once the attempt budget is spent.
 *
 * A TRANSIENT failure hands the attempt back and never goes terminal — see `isTransientEmbedError`. It is
 * given back rather than withheld because `claimNextEmbedJob` increments `attempts` at CLAIM time, before
 * the outcome is known, so by the time we are here it has already been spent.
 *
 * The wait then has to come from somewhere else, which is why `transientFailures` is a second counter and not
 * a flag: the backoff is a function of the attempt number, so holding `attempts` still would pin every retry
 * at the first step and hammer a dead embedder every five seconds — the opposite of what this is for.
 */
export async function failEmbedJob(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
  attempts: number,
  errorMessage: string,
  transientFailures = 0,
  opts: {
    /** How many times this job has already been in flight when the inference process was lost. */
    lostChildFailures?: number;
    /** The claim this worker holds; a finish under a claim that has been taken over changes nothing. */
    claimToken?: string | null;
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const filter = claimedBy(recordType, recordId, opts.claimToken);
  // Stored, and read back by `list_embed_jobs`: the one renderer — redacted, cut on a code point, saying it was cut —
  // rather than a code-unit slice that can split a surrogate (bundle-30 I6, C16).
  const lastError = peerText(errorMessage, { max: 500 });

  // A lost inference process is transient, but it is also how an input that kills the runtime looks, so it is the one
  // failure of the embedder's that is counted per record and ends one: see `MAX_LOST_CHILD_FAILURES`. Decided BEFORE
  // the transient branch on purpose, which stays exactly what it says it is: a transient failure never goes terminal.
  // The marker can only have come from the host: text a child supplies has it defused before it becomes an error.
  // Only the request that was IN FLIGHT carries it; one merely queued behind the crash carries `NOT_SENT_MARKER`.
  const lostCrash = errorMessage.includes(LOST_MARKER);
  const lostFailures = (opts.lostChildFailures ?? 0) + (lostCrash ? 1 : 0);
  if (lostCrash && lostFailures >= MAX_LOST_CHILD_FAILURES) {
    await jobs(spaceId).updateOne(
      asFilter<BrainEmbedJobDoc>(filter),
      asUpdate<BrainEmbedJobDoc>({
        $set: {
          status: 'failed', claimedAt: null, claimToken: null, lastError, updatedAt: now,
          transientFailures: transientFailures + 1, lostChildFailures: lostFailures,
        },
      }),
    );
    return;
  }

  if (isTransientEmbedError(errorMessage)) {
    const failures = transientFailures + 1;
    await jobs(spaceId).updateOne(
      asFilter<BrainEmbedJobDoc>(filter),
      asUpdate<BrainEmbedJobDoc>({
        $set: {
          status: 'pending', claimedAt: null, claimToken: null, lastError, updatedAt: now,
          // The attempt is given back: this failure was not the record's.
          attempts: Math.max(0, attempts - 1),
          transientFailures: failures,
          ...(lostCrash ? { lostChildFailures: lostFailures } : {}),
          // Saturates at the last step, so a permanently-dead embedder costs one claim per job per half hour
          // rather than a spin. It self-heals the moment the embedder answers.
          claimableAfter: nextClaimableAfter(failures),
        },
      }),
    );
    _signal.markSpaceMayHaveWork(spaceId);
    return;
  }

  if (attempts < MAX_EMBED_ATTEMPTS) {
    await jobs(spaceId).updateOne(
      asFilter<BrainEmbedJobDoc>(filter),
      asUpdate<BrainEmbedJobDoc>({
        $set: {
          status: 'pending', claimedAt: null, claimToken: null, lastError, updatedAt: now,
          claimableAfter: nextClaimableAfter(attempts + 1),
        },
      }),
    );
    _signal.markSpaceMayHaveWork(spaceId);
    return;
  }

  await jobs(spaceId).updateOne(
    asFilter<BrainEmbedJobDoc>(filter),
    asUpdate<BrainEmbedJobDoc>({
      $set: { status: 'failed', claimedAt: null, claimToken: null, lastError, updatedAt: now },
    }),
  );
}

/**
 * Give every terminally-failed job one clean attempt per server VERSION.
 *
 * ## The failure this repairs, reported from a live instance
 *
 * Owner, 2026-08-15: *"after updating all space indexing failed and since has not been retried
 * automatically."*
 *
 * The retry policy above is sized for a PER-RECORD failure and was being applied to a SYSTEMIC one. Five
 * attempts at 5s / 30s / 120s / 600s is a budget of about **twelve and a half minutes** from the first
 * failure to terminal `failed` — and `claimNextEmbedJob` filters on `status: 'pending'`, so terminal means
 * never claimed again. An embedder that is unreachable for a quarter of an hour during an upgrade therefore
 * takes every queued job in every space terminal, at once, and the instance stops indexing without ever
 * reporting a fault: each individual job did exactly what it was told to do.
 *
 * `resetStalledEmbedJobs` does not help — it revives `processing` jobs whose worker died, which is a
 * different accident. Nothing revived `failed`.
 *
 * ## Why the key is the version and not a timer
 *
 * A periodic sweep would re-run genuinely-bad records for ever, and a boot sweep would do it on every
 * restart. Keying on the running version bounds it exactly where the owner's report points: **a new version
 * is new evidence**, so it earns one honest retry of everything that failed under the old one, and a restart
 * on the same version revives nothing. `revivedForVersion` absent matches `$ne`, so jobs that failed before
 * this existed are included once.
 *
 * `attempts` is reset with it: a job kept at 5 would fail again on its first error and go straight back to
 * terminal, which is a revive that does nothing. `lastError` is deliberately KEPT — an operator looking at a
 * re-queued job should still be able to see what it died of last time.
 *
 * This does not make the retry policy right, only survivable: an "embedder unreachable" and a "this text is
 * malformed" still cost the same one attempt. Classifying them is the other half, tracked as EJ-1.
 */
export async function reviveFailedEmbedJobs(spaceIds: string[], version: string): Promise<number> {
  let revived = 0;
  for (const spaceId of spaceIds) {
    const res = await jobs(spaceId).updateMany(
      asFilter<BrainEmbedJobDoc>({ status: 'failed', revivedForVersion: { $ne: version } as unknown as string }),
      asUpdate<BrainEmbedJobDoc>({
        $set: { ...releasedClaim(new Date().toISOString()), ...freshBudget(), revivedForVersion: version },
      }),
    );
    if (res.modifiedCount > 0) {
      revived += res.modifiedCount;
      _signal.markSpaceMayHaveWork(spaceId);
    }
  }
  return revived;
}

/**
 * Return jobs whose worker died mid-flight to the pending pool.
 *
 * Measured from `progressAt` (last sign of life), never from `claimedAt` — the media queue learned that
 * a wall-clock deadline from the claim cannot tell "wedged" from "slow", and requeues a long job
 * mid-flight forever. An embedding is short, but a cold model load is not.
 */
export async function resetStalledEmbedJobs(spaceIds: string[], timeoutMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  let reset = 0;
  for (const spaceId of spaceIds) {
    const res = await jobs(spaceId).updateMany(
      asFilter<BrainEmbedJobDoc>({ status: 'processing', progressAt: { $lt: cutoff } as unknown as string }),
      asUpdate<BrainEmbedJobDoc>({
        $set: releasedClaim(new Date().toISOString()),
      }),
    );
    if (res.modifiedCount > 0) {
      reset += res.modifiedCount;
      _signal.markSpaceMayHaveWork(spaceId);
    }
  }
  return reset;
}

/**
 * Per-status counts for one space. A missing collection reports all-zero.
 *
 * `rebuild: true` counts a reindex's jobs only — what its progress is made of. One aggregation either way, so the
 * three numbers describe one instant: two counts taken apart over a queue the worker is draining can count a job
 * that moved between them twice, or not at all.
 */
export async function getEmbedJobCounts(
  spaceId: string,
  only: { rebuild?: true } = {},
): Promise<{ pending: number; processing: number; failed: number }> {
  const rows = await jobs(spaceId)
    .aggregate([
      ...(only.rebuild ? [{ $match: { rebuild: true } }] : []),
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    .toArray() as Array<{ _id: string; n: number }>;
  const out = { pending: 0, processing: 0, failed: 0 };
  for (const r of rows) {
    if (r._id === 'pending' || r._id === 'processing' || r._id === 'failed') out[r._id] = r.n;
  }
  return out;
}

/**
 * The record types the queue accepts, as a VALUE — the type union alone cannot validate an incoming string, and every
 * caller that needed to check one was writing its own list. `file` is in here because file CHUNKS are embedded through
 * this same queue; the media pipeline that produces them has its own separate job queue.
 */
/** One of the five names this repo had for the record types. Re-exported so call sites read well. */
export const EMBED_RECORD_TYPES = RECORD_TYPES;

/** Narrowing guard, so a route can reject an unknown type instead of enqueueing a job nothing will ever claim. */
export function isEmbedRecordType(v: unknown): v is BrainEmbedRecordType {
  return typeof v === 'string' && (EMBED_RECORD_TYPES as readonly string[]).includes(v);
}

/**
 * The queue state, READABLE from outside — the surface B-3 is about.
 *
 * The canary operator, 2026-08-11T1200Z, read our 2.5.1 note and concluded that a brain record written while the embedder
 * was unreachable is silently dropped. Half wrong, and better than they feared: the record is stored and a persisted job
 * records the failure per record, with `attempts`, `lastError` and a terminal `failed` status. It is unfindable until the
 * vector lands, but it is not invisible.
 *
 * **What was genuinely missing is exactly this: nothing exposed it.** Files have a listable status and a retry endpoint;
 * brain records had the state and no way to ask. So *"which of my records have no vector"* was unanswerable from
 * outside even though the server knew — which is indistinguishable, from a caller's seat, from the data loss they
 * described.
 *
 * Ordered newest-first by `updatedAt`: a caller triaging failures wants the ones that just broke, and a queue drains
 * from the front so the oldest pending are the least interesting.
 */
export async function listEmbedJobs(
  spaceId: string,
  opts: { status?: 'pending' | 'processing' | 'failed'; limit?: number; skip?: number } = {},
): Promise<BrainEmbedJobDoc[]> {
  // A non-positive or non-numeric limit falls back to the DEFAULT rather than being clamped up to 1. `Math.max(n, 1)`
  // would answer a caller who computed `limit: 0` with a single row, and one row out of a hundred failures reads as a
  // nearly empty queue — a wrong answer that looks like a right one. 200 is the ceiling either way.
  const asked = Number(opts.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 200) : 50;
  const filter = opts.status ? { status: opts.status } : {};
  // `skip` before `limit`, pushed to MongoDB. Without it a caller could be told `counts.failed: 500` and never reach
  // failure #201 — an accurate total beside an unreachable tail, on the one surface whose justification is that its
  // failures are actionable. Same asymmetry that cost the fleet integrator a fabricated number on `/query`.
  const askedSkip = Number(opts.skip);
  const skip = Number.isFinite(askedSkip) && askedSkip >= 1 ? Math.floor(askedSkip) : 0;
  return await jobs(spaceId)
    .find(asFilter<BrainEmbedJobDoc>(filter), { projection: { claimToken: 0 } })
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray() as BrainEmbedJobDoc[];
}

/**
 * Re-queue one record's embed job. The brain counterpart of the media queue's `retryJob`, with the same three outcomes
 * and the same reasoning for each.
 *
 * `processing` is NOT an error and NOT retried: a worker already holds the job, and resetting it would take the work
 * away from a run in progress. `not_found` means no job exists — either it never failed, or the record is gone.
 *
 * Deliberately NOT `enqueueEmbedJob`. That function exists for a NEW WRITE and resets the content-derived fields with
 * it; calling it here would claim the record had changed when only the operator's patience had.
 */
export async function retryEmbedJob(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  recordId: string,
): Promise<'ok' | 'not_found' | 'processing'> {
  const _id = embedJobId(recordType, recordId);
  const existing = await jobs(spaceId).findOne(asFilter<BrainEmbedJobDoc>({ _id })) as BrainEmbedJobDoc | null;
  if (!existing) return 'not_found';
  if (existing.status === 'processing') return 'processing';

  const now = new Date().toISOString();
  await jobs(spaceId).updateOne(
    asFilter<BrainEmbedJobDoc>({ _id }),
    asUpdate<BrainEmbedJobDoc>({
      $set: { ...releasedClaim(now), ...freshBudget(), lastError: null },
    }),
  );
  // A retry is only useful if something picks it up; without this the job sits pending until the next poll.
  wakeEmbedWorkers();
  return 'ok';
}

// ── Worker wake-up, re-exported so callers do not reach into the signal ──────

export const currentEmbedWorkEpoch = (): number => _signal.currentEpoch();
export const waitForEmbedWork = (ms: number, since: number): Promise<boolean> => _signal.wait(ms, since);
export const wakeEmbedWorkers = (): void => _signal.wake();
/** Test seam: forget the probe hint, forcing the next claim to scan every space. */
export const resetEmbedPendingHint = (): void => _signal.reset();

/**
 * Offer a record that arrived from a peer to THIS instance's embedder.
 *
 * ## The bug this closes
 *
 * `embedding` is a DERIVED field, deliberately excluded from replication because two peers may run different
 * models. Sync ingest is a `replaceOne` of the incoming document. Put those together and a record replicated
 * from a peer arrives with **no vector on the receiving instance** — and, before this existed, nothing ever
 * gave it one.
 *
 * A vectorless record is invisible to recall on that instance: the vector search never returns it, and the
 * lexical channel needs an embedding to compute a real similarity and skips what it cannot score. So an
 * instance could hold a peer's entire knowledge base and answer nothing from it, silently, until an operator
 * happened to run a manual whole-space reindex. Nothing measured it and nothing reported it.
 *
 * ## Why it no longer looks at the arriving vector
 *
 * It used to return early when the incoming document already carried one, on the reasoning that a peer which
 * sent a vector should not have it thrown away. Owner's ruling, 2026-09-01, is the other way round:
 *
 * > *"dont transfer embeddings... It CAN break so it WILL break. on transfer the receiver applies its rules...
 * > if it should embed use the receivers embedding mechanism. everything else makes no sense."*
 *
 * So no ingest schema declares `embedding` any more — facts were the last that did — and a vector cannot
 * arrive at all. The old branch would be unreachable, and worse than unreachable: it read as a statement that
 * a peer may send a usable vector, which is the belief being overturned. Two instances ranking one collection
 * against vectors from two different models is a failure that produces plausible-looking results, which is the
 * kind that is never reported.
 *
 * ## And the receiver's own rules decide
 *
 * `embeddingSuppressedFor` resolves `record > schema > space`: the record's own mark, then the type schema,
 * then the space — the last two from THIS instance's configuration. Asking it here is what makes "the receiver
 * applies its rules" true of an arriving record and not only of a locally written one.
 *
 * It is asked here rather than left to the embed worker, which checks it again before writing a vector. That
 * is not duplication for its own sake: a suppressed record would otherwise be queued, claimed, and discarded
 * on every sync of every suppressed record, and a queue full of work that exists to be thrown away is how a
 * real backlog becomes invisible.
 *
 * ## One call per landed chunk
 *
 * What the arrival writer (`sync/arrivals.ts`) queues a page with, so a 500-record pulled page is one bulk write onto
 * the jobs collection and not 500. The single-record twin it was written beside had no caller left once every
 * arrival went through the writer, and was removed (bundle-30 I6, C10); a single record is a chunk of one.
 *
 * The RECEIVER's suppression decides (`record > schema > space`, resolved against this instance's configuration — the
 * space's meta read ONCE for the batch, never per record), and an arrival goes on the BACKGROUND lane.
 * `enqueueWriteEmbedJobs` never throws into the write it announces: the records are stored by the time they are
 * queued, and failing the arrival over a queue fault would make the sender re-send records this instance already
 * holds.
 */
export async function enqueueIngestedRecords(
  spaceId: string,
  recordType: BrainEmbedRecordType,
  docs: ReadonlyArray<{ _id: string; suppressEmbeddings?: boolean }>,
): Promise<void> {
  if (docs.length === 0) return;
  const meta = getSpaceMeta(spaceId);
  const wanted = docs.filter(d => !embeddingSuppressedFor(spaceId, recordType, d as unknown as Record<string, unknown>, meta));
  if (wanted.length === 0) return;
  await enqueueWriteEmbedJobs(spaceId, wanted.map(d => ({ recordType, recordId: d._id })),
    { priority: EMBED_PRIORITY.background });
}
