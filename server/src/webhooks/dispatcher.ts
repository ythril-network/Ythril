/**
 * Webhook event dispatcher — emits events to matching subscriptions.
 *
 * - HMAC-SHA256 signature using the subscription's shared secret
 * - At-least-once delivery with exponential backoff retries
 * - MongoDB-backed retry queue — retries survive process restarts
 * - First deliveries bounded per subscription: a burst or a hung sink cannot open unbounded connections (see
 *   {@link FIRST_DELIVERY_BOUND}); what does not fit is persisted to the retry queue, and a write of it that fails is counted
 *   (`ythril_webhook_first_deliveries_lost_total`) and said
 * - Delivery logging for debugging
 * - Fire-and-forget from the caller's perspective (non-blocking)
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Filter, Sort } from 'mongodb';
import {
  getMatchingWebhooks, getWebhookFull, recordDelivery, markWebhookSuccess, markWebhookFailure, acceptsDeliveries, claimDueProbe,
  markProbeRecovered, FAILING_AFTER,
} from './store.js';
import { asDoc, col } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { log, peerText } from '../util/log.js';
import { publishBrainChange } from '../brain/brain-events.js';
import type { WebhookEventType, WebhookEventPayload, WebhookDelivery, WebhookSubscription } from './types.js';
import { withJitter } from '../util/backoff.js';
import { intervalJob, type IntervalJob, type IntervalJobDeps } from '../util/interval-job.js';
import { mapLimit, mapLimitPerKey } from '../util/map-limit.js';
import { keyedLimiter } from '../util/keyed-limiter.js';
import { writeInOneCommands } from '../db/one-command.js';
import { warnOnce } from '../util/warn-once.js';
import { drainedQueue } from '../util/drained-queue.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';
import { settledWithin } from '../util/time-bound.js';
import { detachedWrite } from '../db/write-bound.js';
import { readRowsById } from '../db/read-by-id.js';
import { dropIndexesIfPresent, indexNamesOf } from '../db/index-names.js';
import { retryRowsStored, type RetryRowVerdict } from './retry-rows-stored.js';

/** Retry schedule in milliseconds: 10s, 30s, 1m, 5m, 30m, 1h */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000, 1_800_000, 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
const RETRY_COLLECTION = '_webhook_retry_queue';

/** The two keys the poll's choice reads (bundle-169, Q-483): the due subscriptions, covered, and one subscription's earliest due rows. */
const DUE_KEYS_INDEX = { scheduledAt: 1, webhookId: 1 } as const;
const LANE_INDEX = { webhookId: 1, scheduledAt: 1 } as const;
/** The index the two compounds replace; its only reader was the poll's old `find().sort({ scheduledAt: 1 })`. */
const REPLACED_INDEX = 'scheduledAt_1';

/**
 * Ensure the retry queue's indexes, at startup, as a step of its own that the boot does not wait for (`bootstrap.ts`): the queue is
 * small until a burst overflows into it (a directory delete to a sink that is down), and a build over a large one must not hold the
 * listen. The poll works without them, only slower.
 *
 * The two compounds the poll's choice reads are built first, and the `{ scheduledAt: 1 }` they replace is dropped only once both are
 * listed (`dropIndexesIfPresent`), so the queue is never left with neither.
 */
export async function initRetryQueueIndexes(): Promise<void> {
  const queue = col<RetryJob>(RETRY_COLLECTION);
  const names = [await queue.createIndex(DUE_KEYS_INDEX), await queue.createIndex(LANE_INDEX)];
  const present = await indexNamesOf(RETRY_COLLECTION);
  if (names.every(n => present.includes(n))) await dropIndexesIfPresent(RETRY_COLLECTION, [REPLACED_INDEX], present);
}
/** How often the retry poll runs a tick. The drain sentence of integration guide 14 states it (a gate compares). */
export const RETRY_POLL_INTERVAL_MS = 10_000;

// ── Retry queue document ────────────────────────────────────────────────────

export interface RetryJob {
  _id: string;
  webhookId: string;
  body: string;
  event: WebhookEventType;
  spaceId: string;
  deliveryId: string;
  attempt: number;
  scheduledAt: Date;
  createdAt: Date;
}

// ── Retry worker ────────────────────────────────────────────────────────────

/** The poll's name: its interval job's label, and so the `job` of `ythril_interval_tick_skipped_total`. A constant. */
export const RETRY_JOB_LABEL = 'Webhook retry poll';
/** How many due retries one tick delivers at once. */
export const RETRY_CONCURRENCY = 4;
/** The most of those {@link RETRY_CONCURRENCY} slots one subscription holds at once, so a hung sink cannot take the whole tick. */
export const RETRY_PER_KEY = 2;
/** The most due retries one tick takes from the queue, shared across the due subscriptions (see `chooseDueRetries`). */
export const RETRY_BATCH = 50;
/**
 * A tick stops STARTING deliveries this long after it began; a row it did not start stays queued (the row is removed in `retryOne`, which
 * an unstarted row never reaches). So a tick of slow sinks ends in about this plus one delivery timeout, not in its batch times that timeout.
 */
export const RETRY_TICK_BUDGET_MS = 30_000;

/**
 * What one retry tick reaches. Production is {@link realRetryPollDeps}; a test hands in fakes (the queue is a collection, and a
 * delivery is an outbound request that the SSRF guard would refuse to send to anything a test could listen on).
 */
export interface RetryPollDeps {
  /** The poll's clock, ms (the tick's budget is read from it). Production leaves it out: `Date.now`. */
  now?: () => number;
  dueJobs(now: Date): Promise<RetryJob[]>;
  removeJob(id: string): Promise<void>;
  getWebhook(id: string): Promise<WebhookSubscription | null>;
  deliver(sub: WebhookSubscription, job: RetryJob): Promise<WebhookDelivery>;
  markSuccess(webhookId: string): Promise<void>;
  /** Count an exhausted schedule; answers whether this call flipped the subscription to failing (`markWebhookFailure`). */
  markFailure(webhookId: string): Promise<boolean>;
  /** Put the job back for its next attempt (`job.attempt + 1`), at the next backoff step. */
  requeue(job: RetryJob): Promise<void>;
  // The probe of failing subscriptions (Q-477). Production always has all three (`productionRetryPollDeps`); a fake that leaves
  // `claimDueProbe` out has no probe due, which is what the poll tests written before probing existed hand in.
  /** Claim one failing subscription whose probe is due (the claim also schedules the next one), or null. */
  claimDueProbe?(now: Date): Promise<{ id: string; url: string } | null>;
  /** Send the probe: one delivery, no retry. */
  deliverProbe?(sub: WebhookSubscription, body: string, event: WebhookEventType, spaceId: string, deliveryId: string): Promise<WebhookDelivery>;
  /** Recover the subscription the probe reached at `url`; answers whether this write changed the row. */
  markProbeRecovered?(webhookId: string, url: string): Promise<boolean>;
}

/**
 * The tick's rows: at most {@link RETRY_BATCH}, shared across the due subscriptions, chosen from ids and index keys and only then read whole.
 *
 * It took the 50 OLDEST due rows, whoever they belonged to, so one subscription with a backlog (all of it older than anyone else's) filled
 * every tick and another subscription's single retry waited until the backlog had drained. Now:
 *
 *  1. the due subscriptions and each one's oldest due row: one aggregate COVERED by `{ scheduledAt: 1, webhookId: 1 }` (no document is
 *     read; the cost is one index key per due row), oldest first, at most the batch of them;
 *  2. each subscription's earliest due ids, a share of `max(1, floor(batch / subscriptions))` on `{ webhookId: 1, scheduledAt: 1 }`, and
 *     what a subscription did not need passed to those that filled theirs, until the batch is full or nobody has more;
 *  3. the chosen rows read by `_id` (`readRowsById`): bodies only for those.
 *
 * The order the poll starts them in is the poll's (`laneOrdered`), not this read's.
 */
async function chooseDueRetries(now: Date): Promise<RetryJob[]> {
  const queue = col<RetryJob>(RETRY_COLLECTION);
  const lanes = await queue.aggregate<{ _id: string }>([
    { $match: { scheduledAt: { $lte: now } } },
    { $group: { _id: '$webhookId', oldest: { $min: '$scheduledAt' } } },
    { $sort: { oldest: 1, _id: 1 } },
    { $limit: RETRY_BATCH },
  ]).toArray();
  const taken = new Map<string, string[]>(lanes.map(l => [String(l._id), []]));
  let left = RETRY_BATCH;
  let open = [...taken.keys()];
  while (left > 0 && open.length > 0) {
    const share = Math.max(1, Math.floor(left / open.length));
    const got = await mapLimit(open.slice(0, left), RETRY_CONCURRENCY, async (webhookId) => {
      const ids = await queue.find({ webhookId, scheduledAt: { $lte: now } } as Filter<RetryJob>, { projection: { _id: 1 } })
        .sort({ scheduledAt: 1 } as Sort).skip(taken.get(webhookId)!.length).limit(share).toArray();
      return { webhookId, ids: ids.map(d => String(d._id)) };
    });
    open = [];
    for (const { webhookId, ids } of got) {
      const keep = ids.slice(0, left);
      taken.get(webhookId)!.push(...keep);
      left -= keep.length;
      if (ids.length === share) open.push(webhookId);
    }
  }
  return await readRowsById<RetryJob>(RETRY_COLLECTION, [...taken.values()].flat(), 'all');
}

/**
 * The poll's deps as production runs them: the queue, the store's status writes and the SSRF-checked delivery. A new object per call,
 * so a test can replace one door (the probe's delivery, the clock) and keep every other one production's. `getWebhook` is
 * `getWebhookFull`: a delivery's HMAC is keyed with the DECRYPTED secret, and a probe reads its subscription through it too, never the
 * row its claim returned (whose `secret` is the stored ciphertext).
 */
export function productionRetryPollDeps(): RetryPollDeps {
  return {
    dueJobs: chooseDueRetries,
    removeJob: async (id) => { await col<RetryJob>(RETRY_COLLECTION).deleteOne({ _id: id } as Filter<RetryJob>); },
    getWebhook: (id) => getWebhookFull(id),
    deliver: (sub, job) => attemptDelivery(sub, job.body, job.event, job.spaceId, job.deliveryId),
    markSuccess: markWebhookSuccess,
    markFailure: markWebhookFailure,
    requeue: (job) => writeRetryRow(retryJobFor(job.webhookId, job.body, job.event, job.spaceId, job.deliveryId, job.attempt + 1)),
    claimDueProbe,
    deliverProbe: attemptDelivery,
    markProbeRecovered,
  };
}

/**
 * The retry poll as an interval job (`Q-317`), and `deps` is a test seam: production never passes it.
 *
 * ## It SKIPS an overlapping tick, and delivers four at a time
 *
 * A bare `setInterval` ran a pass every 10 s whether or not the last had ended, and a pass delivered its due jobs one after
 * another. Both were wrong in a way a slow sink exposes: a sink that takes its whole delivery timeout held every other sink's
 * retries behind it, and the passes that fired meanwhile read the same queue. The job skips an overlapping tick (a second
 * delivery of the same event is the worse failure: the queue is re-read next tick, so a skip costs a delay, never a retry) and
 * counts it. And a tick delivers with a concurrency of {@link RETRY_CONCURRENCY} and at most {@link RETRY_PER_KEY} per subscription
 * (`mapLimitPerKey`), so one slow sink holds at most two slots and every other sink's retry goes out meanwhile.
 *
 * **What bounds a tick.** The job's tick runs inside the housekeeping bound, so every database operation here ends at
 * `housekeepingOpMs()`. A delivery is not a database operation and carries its own timeout (`DELIVERY_TIMEOUT_MS`, an abort
 * signal on the request). The one wait with no signal is the DNS lookup inside `ssrfSafeFetch`, which is its own ticket.
 *
 * One job failing (a database error after its row was removed, an unexpected throw in delivery) is said and the others of the
 * tick go on; a failure before any job is read (the queue itself) is the interval job's: `Webhook retry poll failed: …`.
 *
 * ## It is shared across subscriptions, and it ends at a budget (bundle-169, Q-483)
 *
 * One subscription holds at most {@link RETRY_PER_KEY} of the four slots (`mapLimitPerKey`: a row whose subscription is at its cap
 * waits without holding a slot), the rows start in the order of each subscription's OLDEST due row, one row per subscription in turn
 * (`laneOrdered`), and a tick stops starting deliveries at {@link RETRY_TICK_BUDGET_MS}: the rows it did not start stay queued, the cut
 * is counted (`ythril_webhook_retry_ticks_cut_total`) and said once per window. A subscription not started in a cut tick keeps the
 * oldest row, so it leads the next one.
 *
 * ## It probes failing subscriptions, first (Q-477)
 *
 * A subscription marked failing is refused every event and every retry; what brings it back is a probe: a `test.ping` in the test
 * route's envelope, marked `entry.probe: true` ({@link probePayload}), sent by this same poll (no second timer). The probes of a tick run
 * in ONE slot of their own, the first started before any retry, at most {@link PROBES_PER_TICK}, each claimed at its own start after
 * the budget check a retry makes, so a spent tick claims nothing. A probe the sink answers recovers the subscription on probation
 * (`markProbeRecovered`); one it refuses leaves it failing, already rescheduled by its claim (1 min doubling to 1 h, equal-jittered).
 */
export function createRetryWorker(deps: RetryPollDeps = productionRetryPollDeps(), jobDeps?: IntervalJobDeps): { job: IntervalJob } {
  const job = intervalJob(RETRY_JOB_LABEL, RETRY_POLL_INTERVAL_MS, () => pollRetryQueue(deps), jobDeps);
  return { job };
}

const retryWorker = createRetryWorker();

/** Start the background retry queue poller. Call once during startup. */
export function startRetryWorker(): void {
  if (retryWorker.job.armed) return;
  retryWorker.job.start();
  log.debug('Webhook retry worker started');
}

/** Stop the retry queue poller. Called during graceful shutdown. */
export function stopRetryWorker(): void {
  retryWorker.job.stop();
}

async function pollRetryQueue(deps: RetryPollDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const began = now();
  // The budget is asked at each START, never of a delivery in flight: an unstarted row is still in the queue, an unclaimed probe still due.
  const budgetSpent = (): boolean => now() - began >= RETRY_TICK_BUDGET_MS;
  // The probes go first: the retries start once the first probe has started, or the probe slot has found nothing to start.
  let probesStarted!: () => void;
  const firstProbeStarted = new Promise<void>(resolve => { probesStarted = resolve; });
  const probing = probeDueSubscriptions(deps, now, budgetSpent, probesStarted).finally(probesStarted);
  await firstProbeStarted;
  let notStarted = 0;
  const retrying = (async () => {
    const jobs = laneOrdered(await deps.dueJobs(new Date(began)));
    await mapLimitPerKey(jobs, RETRY_CONCURRENCY, j => j.webhookId, RETRY_PER_KEY, async (job) => {
      if (budgetSpent()) { notStarted++; return; }
      await retryOne(deps, job);
    });
  })();
  // Both halves run to their end before either's failure is the tick's, so a failed queue read never leaves a probe running past its tick.
  const [probed, retried] = await Promise.allSettled([probing, retrying]);
  for (const r of [retried, probed]) if (r.status === 'rejected') throw r.reason;
  if (notStarted > 0) {
    retryTicksCut++;
    sayDeliveryFailureOnce('retry-tick-cut', 'all', () => {
      log.warn(`Webhook retry poll stopped starting deliveries after its ${RETRY_TICK_BUDGET_MS / 1000} s budget; ${notStarted} due retries stay queued for the next tick (counted in ythril_webhook_retry_ticks_cut_total)`);
    });
  }
}

/**
 * The tick's rows in the order they start: subscriptions by their OLDEST due row, one row of each in turn, each subscription's rows
 * earliest first. Whatever order the selection hands over, so a subscription left unstarted by a cut tick leads the next.
 */
function laneOrdered(jobs: readonly RetryJob[]): RetryJob[] {
  const lanes = new Map<string, RetryJob[]>();
  for (const j of jobs) { const l = lanes.get(j.webhookId); if (l) l.push(j); else lanes.set(j.webhookId, [j]); }
  const at = (j: RetryJob): number => new Date(j.scheduledAt).getTime();
  const ordered = [...lanes.values()].map(l => l.sort((x, y) => at(x) - at(y)));
  ordered.sort((x, y) => at(x[0]!) - at(y[0]!));
  const out: RetryJob[] = [];
  for (let round = 0; out.length < jobs.length; round++) for (const l of ordered) if (round < l.length) out.push(l[round]!);
  return out;
}

/** Ticks of the retry poll that stopped starting deliveries at their budget: `ythril_webhook_retry_ticks_cut_total`. */
let retryTicksCut = 0;
export function webhookRetryTicksCutCount(): number {
  return retryTicksCut;
}

async function retryOne(deps: RetryPollDeps, job: RetryJob): Promise<void> {
  try {
    // Remove from queue before delivery attempt (at-least-once: if we crash
    // mid-delivery, the webhook gets a duplicate rather than being lost).
    await deps.removeJob(job._id);

    const sub = await deps.getWebhook(job.webhookId);
    if (!sub) { dropRetry('deleted', job.webhookId); return; } // webhook deleted while retry was queued
    // Switched off, disabled or failing: the retry is dropped (its row is already gone), with no delivery and no verdict about the
    // subscription. A burst to a sink that went down leaves a row per event; once the subscription is marked failing, delivering the rest
    // is an attempt at a sink the dispatcher has stopped sending to. Counted and said, because the row was the event's only copy.
    if (!acceptsDeliveries(sub)) { dropRetry(sub.status === 'failing' ? 'failing' : 'disabled', job.webhookId); return; }

    const result = await deps.deliver(sub, job);

    if (result.success) {
      await deps.markSuccess(sub.id);
    } else if (job.attempt < MAX_ATTEMPTS) {
      await deps.requeue(job);
      sayDeliveryFailureOnce('retry', job.webhookId, () => { log.warn(`Webhook retry ${job.attempt}/${MAX_ATTEMPTS} failed for ${peerText(job.webhookId)}: ${peerText(result.error ?? `HTTP ${result.responseStatus}`)}`); });
    } else if (await deps.markFailure(sub.id)) {
      // Said by the exhausted schedule whose flip changed the row: once per flip, not once per exhausted schedule.
      log.error(`Webhook ${peerText(sub.id)} marked as failing after ${FAILING_AFTER} retry schedules of ${MAX_ATTEMPTS} delivery attempts ran out; it is probed until it answers`);
    }
  } catch (err) {
    sayDeliveryFailureOnce('retry-error', job.webhookId, () => { log.warn(`Webhook retry queue error for ${peerText(job.webhookId)}: ${peerText(err)}`); });
  }
}

// ── Probes of failing subscriptions ─────────────────────────────────────────

/** The most failing subscriptions one tick probes, one after another in the probe slot. */
export const PROBES_PER_TICK = 2;

/** The `test.ping` envelope: the ONE shape the test route and the probe both send (`spaceId` and `spaceName` `'_test'`). */
export function testPingPayload(entry: Record<string, unknown>, actor: WebhookActor = {}, at: Date = new Date()): WebhookEventPayload {
  return {
    event: 'test.ping',
    timestamp: at.toISOString(),
    spaceId: '_test',
    spaceName: '_test',
    entry,
    ...(actor.tokenId ? { tokenId: actor.tokenId } : {}),
    ...(actor.tokenLabel ? { tokenLabel: actor.tokenLabel } : {}),
  };
}

/**
 * A probe's body: the test route's envelope, marked `entry.probe: true` so a receiver can tell it from an admin's test. No event type of
 * its own: a receiver switching on the event table already knows `test.ping`, and a new type would be one it refuses.
 */
export function probePayload(at: Date = new Date()): WebhookEventPayload {
  return testPingPayload({ probe: true, message: 'Probe of a failing webhook subscription by Ythril' }, {}, at);
}

/**
 * The tally behind `ythril_webhook_probes_total{outcome}`: a probe that recovered its subscription, one the sink refused, and one the sink
 * answered whose recovery matched nothing (`superseded`: the subscription was disabled, its URL changed or it was recovered otherwise
 * while the probe was in flight). Every probe sent is counted under exactly one.
 */
const probeOutcomes = { recovered: 0, failed: 0, superseded: 0 };
export function webhookProbeCounts(): Readonly<{ recovered: number; failed: number; superseded: number }> {
  return { ...probeOutcomes };
}

/**
 * The tick's probes: up to {@link PROBES_PER_TICK}, one at a time, each claimed at its own start after the budget check. `started` is
 * called as the first probe's delivery begins (the retries wait for it, so the probes go first); the caller calls it again when this
 * ends, for a tick with nothing to probe. A probe's failure is said and the next probe goes on.
 */
async function probeDueSubscriptions(deps: RetryPollDeps, now: () => number, budgetSpent: () => boolean, started: () => void): Promise<void> {
  const { claimDueProbe: claim, deliverProbe, markProbeRecovered: recover } = deps;
  if (!claim || !deliverProbe || !recover) return;
  for (let n = 0; n < PROBES_PER_TICK; n++) {
    if (budgetSpent()) return;
    const due = await claim(new Date(now()));
    if (!due) return;
    try {
      await probeOne(due.id, deps.getWebhook, deliverProbe, recover, started);
    } catch (err) {
      sayDeliveryFailureOnce('probe-error', due.id, () => { log.warn(`Webhook probe error for ${peerText(due.id)}: ${peerText(err)}`); });
    }
  }
}

async function probeOne(
  id: string,
  getWebhook: RetryPollDeps['getWebhook'],
  deliverProbe: NonNullable<RetryPollDeps['deliverProbe']>,
  recover: NonNullable<RetryPollDeps['markProbeRecovered']>,
  started: () => void,
): Promise<void> {
  const sub = await getWebhook(id);
  if (!sub) return; // deleted since the claim
  const delivery = deliverProbe(sub, JSON.stringify(probePayload()), 'test.ping', '_test', uuidv4());
  started();
  const result = await delivery;
  if (!result.success) {
    probeOutcomes.failed++;
    sayDeliveryFailureOnce('probe', id, () => { log.warn(`Webhook probe of failing ${peerText(id)} was not answered: ${peerText(result.error ?? `HTTP ${result.responseStatus}`)}; it stays failing and is probed again on its schedule`); });
    return;
  }
  // The URL the probe went to: a subscription whose URL changed meanwhile is not recovered by a probe of the old one.
  if (await recover(id, sub.url)) {
    probeOutcomes.recovered++;
    log.info(`Webhook ${peerText(id)} recovered: its probe was answered, so it takes deliveries again (on probation: one more exhausted retry schedule marks it failing)`);
  } else {
    probeOutcomes.superseded++;
  }
}

/** Why a queued retry was removed and not delivered; the labels of `ythril_webhook_retries_dropped_total`. */
const RETRY_DROP_REASONS = ['deleted', 'disabled', 'failing'] as const;
type RetryDropReason = typeof RETRY_DROP_REASONS[number];

/** The tally behind `ythril_webhook_retries_dropped_total`, every reason present at 0 so every series is on the scrape from the start. */
const retriesDropped: Record<RetryDropReason, number> = { deleted: 0, disabled: 0, failing: 0 };
export function webhookRetriesDroppedCounts(): Readonly<Record<RetryDropReason, number>> {
  return { ...retriesDropped };
}

/** A retry removed from the queue and not delivered: counted every time, said once per window per subscription and reason. */
function dropRetry(reason: RetryDropReason, webhookId: string): void {
  retriesDropped[reason]++;
  sayDeliveryFailureOnce(`retry-dropped-${reason}`, webhookId, () => {
    log.warn(`Webhook retries for ${peerText(webhookId)} are being dropped without a delivery attempt (${reason}); every one is counted in ythril_webhook_retries_dropped_total`);
  });
}

/** One retry-queue document for a delivery's attempt number `attempt` (2 is the first retry). The ONE shape, written by every writer. */
function retryJobFor(
  webhookId: string,
  body: string,
  event: WebhookEventType,
  spaceId: string,
  deliveryId: string,
  attempt: number,
): RetryJob {
  // Jittered: one webhook target going down fails every event queued against it at once, and without
  // jitter they would all come back at the same instant — a burst aimed at an endpoint that is, by
  // definition, already having a bad time. See `util/backoff.ts`.
  const delayMs = withJitter(RETRY_DELAYS_MS[attempt - 2] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!);
  return {
    _id: uuidv4(),
    webhookId,
    body,
    event,
    spaceId,
    deliveryId,
    attempt,
    scheduledAt: new Date(Date.now() + delayMs),
    createdAt: new Date(),
  };
}

/**
 * Write ONE retry row (the requeue after a failed first delivery, and the poll's requeue of a failed retry). A write that fails is counted
 * by what the queue holds (`countRetryRowsAfterFailure`): a row that landed is not lost and the call resolves; one that did not is counted
 * lost by its reason and the failure is thrown on to the caller's reporter, which names it.
 */
async function writeRetryRow(job: RetryJob): Promise<void> {
  try {
    await col<RetryJob>(RETRY_COLLECTION).insertOne(asDoc<RetryJob>(job));
  } catch (err) {
    const { stored } = await countRetryRowsAfterFailure([{ job, overflow: false }], err);
    if (stored === 0) throw err;
  }
}

// ── Delivery failure lines ──────────────────────────────────────────────────

/**
 * How long a failure line for one subscription is not said again. A sink that is down fails every delivery of a burst, and a line per
 * delivery is the burst's size in log lines (the log ring is bounded, so they push out what an operator needs). Said again after the
 * window, so a failure that goes on is still visible.
 */
const DELIVERY_FAILURE_WINDOW_MS = 10 * 60_000;
const deliveryFailureSaid = warnOnce<string>({ max: 500, every: DELIVERY_FAILURE_WINDOW_MS });

/**
 * Say a delivery failure line once per window per subscription and kind; `kind` keeps a first-delivery failure and a retry failure apart.
 * `say` writes the line (a `log.warn` with its values bounded where they enter the text), so what is said stays at the site that knows it.
 */
function sayDeliveryFailureOnce(kind: string, webhookId: string, say: () => void): void {
  deliveryFailureSaid(`${kind}:${webhookId}`, say);
}

// ── Public emit API ─────────────────────────────────────────────────────────

/**
 * Identifies the token that caused a mutation, for webhook attribution. Threaded from the
 * request/MCP surface down into the shared writer functions, which own the emit: a
 * shared mutating function emits when (and only when) it is given an actor — `if (actor)
 * emitWebhookEvent(...)` — so user-facing surfaces (REST, MCP) pass one and emit, while
 * internal callers (sync, import, bulk, a file's byte arrival) pass none and stay silent.
 * That is ONE rule for the brain records and the file family alike, and it governs both
 * halves of {@link emitWebhookEvent}: no actor means no webhook delivery AND no live-view
 * (SSE) event, because the one function does both. An actor may carry no fields at all
 * (`{}`, an unauthenticated session): it is still an actor, and the act is still a user's.
 * Centralises both the emit call AND its attribution in one place.
 */
export interface WebhookActor {
  tokenId?: string;
  tokenLabel?: string;
}

export interface EmitWebhookEventOptions {
  event: WebhookEventType;
  spaceId: string;
  entry: Record<string, unknown>;
  tokenId?: string;
  tokenLabel?: string;
}

/**
 * Emit a webhook event. This is fire-and-forget — callers should not await.
 * Matching subscriptions are resolved, payloads signed, and HTTP POSTs
 * dispatched asynchronously. Failures are retried via the MongoDB retry queue.
 *
 * Callers gate this on having an actor (`if (actor)`, see {@link WebhookActor}); it is not
 * split into a bus half and a webhook half, and a caller that wants one without the other
 * has a second rule to explain.
 */
export function emitWebhookEvent(opts: EmitWebhookEventOptions): void {
  // F12: mirror every brain mutation onto the in-process bus that drives live SSE updates. Done here,
  // the single choke point every write already funnels through, so it fires regardless of whether any
  // webhook subscription matches.
  publishBrainChange({ event: opts.event, spaceId: opts.spaceId, entry: opts.entry });
  emitQueue.push({ opts, at: new Date().toISOString() });
}

/**
 * Emitted events wait here and are resolved ONE AT A TIME, in emit order. Resolving them all at once made a burst move in lockstep: every
 * event of a directory delete was past the subscription lookup in the same instant, so every one of them reached a sink's first-delivery
 * bound together, before a single delivery could finish and free a slot. One at a time, a sink that answers keeps pace with the resolution
 * and a sink that does not fills its own bound and overflows to the retry queue (Q-469). The cost is bounded by the burst itself: the
 * lookup is the in-memory subscription cache, and the entries queued here were already held by the callers' closures.
 */
const emitQueue = drainedQueue<{ opts: EmitWebhookEventOptions; at: string }>(
  async ([next]) => { await _emitAsync(next!.opts, next!.at); },
  { batchSize: 1, onError: err => { sayDeliveryFailureOnce('emit-error', 'all', () => { log.warn(`Webhook emit error: ${peerText(err)}`); }); } },
);

async function _emitAsync(opts: EmitWebhookEventOptions, at: string): Promise<void> {
  const { event, spaceId, entry, tokenId, tokenLabel } = opts;

  const subs = await getMatchingWebhooks(event, spaceId);
  if (subs.length === 0) return;

  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  const spaceName = space?.label ?? spaceId;

  const payload: WebhookEventPayload = {
    event,
    timestamp: at, // when it was emitted, not when its turn in the queue came
    spaceId,
    spaceName,
    entry,
    ...(tokenId ? { tokenId } : {}),
    ...(tokenLabel ? { tokenLabel } : {}),
  };

  const body = JSON.stringify(payload);

  for (const sub of subs) {
    const full = await getWebhookFull(sub.id);
    if (!full) continue;

    offerFirstDelivery({ sub: full, body, event, spaceId, deliveryId: uuidv4() });
  }
}

// ── First deliveries, bounded per subscription ──────────────────────────────

/**
 * How many first deliveries to ONE subscription run at once, and how many may be running plus waiting before the rest go to the retry
 * queue. Per subscription, so a sink that hangs holds only its own slots and every other sink's events go out meanwhile.
 *
 * ## What this closes (Q-469)
 *
 * `emitWebhookEvent` started a delivery per matching subscription per event, un-awaited and with no limit: ten thousand `file.deleted`
 * events were ten thousand simultaneous outbound connections, and a sink that stayed down turned each into a retry row at once. Only the
 * retries were bounded. A directory delete is the first emitter to make a burst of N.
 *
 * ## Where an event goes
 *
 * Started when its subscription has a free slot, waits in memory behind the running ones, or — when the subscription is at its bound —
 * is written straight to the retry queue as a retry document (attempt 2, the first retry), and the retry poll delivers it at its own
 * pace. An event is never dropped by the bound. At shutdown the queued-not-attempted ones are persisted the same way
 * ({@link drainFirstDeliveries}); a delivery already in flight is not waited for, as before.
 */
export const FIRST_DELIVERY_CONCURRENCY = 8;
export const FIRST_DELIVERY_BOUND = 64;
/** What a first delivery needs: the subscription, the signed body's payload, and its ids. */
interface FirstDelivery {
  sub: WebhookSubscription;
  body: string;
  event: WebhookEventType;
  spaceId: string;
  deliveryId: string;
}

/** What one first delivery reaches. Production is {@link attemptDelivery}; a test hands in a fake (see {@link setFirstDeliveryDepsForTest}). */
export interface FirstDeliveryDeps {
  deliver(sub: WebhookSubscription, body: string, event: WebhookEventType, spaceId: string, deliveryId: string): Promise<WebhookDelivery>;
}

/** The handed-in delivery, or null for production. */
let firstDeliveryOverride: FirstDeliveryDeps | null = null;

/**
 * Test seam: hand in the first delivery (`null` restores production). A delivery is an outbound request the SSRF guard would refuse to
 * send to anything a test could listen on, so the per-subscription bound can only be seen in flight through a handed-in `deliver`.
 */
export function setFirstDeliveryDepsForTest(deps: FirstDeliveryDeps | null): void {
  firstDeliveryOverride = deps;
}

/** Why a retry row is counted lost: the labels of `ythril_webhook_first_deliveries_lost_total` (see `retry-rows-stored.ts`). */
type LostReason = Exclude<RetryRowVerdict, 'stored'>;

/**
 * The tally behind `ythril_webhook_first_deliveries_queued_total`, `_overflowed_total` and `_lost_total{reason}`; the registry reads it at
 * scrape time. `overflowed` and `lost` are counted by what the queue HOLDS after a failed write, never by the write's answer.
 */
const firstDeliveryTally = { queued: 0, overflowed: 0, lost: { not_stored: 0, not_known_stored: 0 } as Record<LostReason, number> };
export function webhookFirstDeliveryCounts(): { queued: number; overflowed: number; lost: Readonly<Record<LostReason, number>> } {
  return { queued: firstDeliveryTally.queued, overflowed: firstDeliveryTally.overflowed, lost: { ...firstDeliveryTally.lost } };
}
const lostTotal = (): number => firstDeliveryTally.lost.not_stored + firstDeliveryTally.lost.not_known_stored;

/**
 * The read-back deadline while the shutdown drains (`drainFirstDeliveries`), so a read-back after a failed write takes the drain's budget
 * and not a write bound of its own; `null` otherwise.
 */
let shutdownReadBackDeadline: number | null = null;

/**
 * After a write of `rows` failed with `err`: read them back, count `overflowed` for the overflow rows the queue holds and `lost` by
 * reason for each row it does not, and answer how many were stored and lost. The one place a failed retry-row write is counted, for all
 * three writers (the overflow flush, the first-delivery requeue, the poll's requeue).
 */
async function countRetryRowsAfterFailure(
  rows: readonly { job: RetryJob; overflow: boolean }[], err: unknown,
): Promise<{ stored: number; lost: number }> {
  const deadline = shutdownReadBackDeadline;
  const verdicts = await retryRowsStored(RETRY_COLLECTION, rows.map(r => r.job), err, deadline === null ? {} : { timeLeft: () => deadline - Date.now() });
  let stored = 0; let lost = 0;
  for (const { job, overflow } of rows) {
    const v = verdicts.get(job._id) ?? 'not_known_stored';
    if (v === 'stored') { stored++; if (overflow) firstDeliveryTally.overflowed++; continue; }
    lost++;
    firstDeliveryTally.lost[v]++;
  }
  return { stored, lost };
}

const firstDeliveries = keyedLimiter<string, FirstDelivery>({
  concurrency: FIRST_DELIVERY_CONCURRENCY,
  bound: FIRST_DELIVERY_BOUND,
  // Detached: the delivery's writes (its requeue, `markWebhookSuccess`) belong to no request, whatever request emitted the event.
  run: (_id, d) => detachedWrite(() => deliverFirst(d)),
  onError: (id, err) => { sayDeliveryFailureOnce('delivery-error', id, () => { log.warn(`Webhook delivery error for ${peerText(id)}: ${peerText(err)}`); }); },
});

/** Start the delivery, queue it behind its subscription's running ones, or — at the bound, or after shutdown began — persist it for retry. */
function offerFirstDelivery(d: FirstDelivery): void {
  switch (firstDeliveries.submit(d.sub.id, d)) {
    case 'started': return;
    case 'queued': firstDeliveryTally.queued++; return;
    case 'refused': persistForRetry(d, { overflow: !firstDeliveries.closed }); return;
  }
}

/**
 * Overflow rows are written in batches, not one `insertOne` per event: a burst that overflows is thousands of events in one tick, and a
 * write each is thousands of pending driver operations. One flush at a time; rows that arrive while it writes are taken by the same loop.
 */
const pendingRetryRows = drainedQueue<{ job: RetryJob; overflow: boolean }>(
  // Detached: the flush belongs to no request, and a request's hold deadline must not end a write whose rows may land (C5, N1).
  async (batch) => await detachedWrite(async () => {
    try {
      // Sliced by bytes and count so each write is ONE wire command (`db/one-command.ts`): a retry body is a whole event payload.
      await writeInOneCommands(batch.map(b => asDoc<RetryJob>(b.job)), (slice, { ordered }) => col<RetryJob>(RETRY_COLLECTION).insertMany(slice, { ordered }), { ordered: false });
      firstDeliveryTally.overflowed += batch.filter(b => b.overflow).length;
    } catch (err) {
      // Counted by what the queue holds after the failure, not by the answer: rows can land with the reply lost (Q-580).
      const { lost } = await countRetryRowsAfterFailure(batch, err);
      if (lost > 0) {
        sayDeliveryFailureOnce('persist', 'retry-queue', () => { log.warn(`Webhook retry queue write failed; ${lost} of ${batch.length} first deliveries are not known to be stored (counted in ythril_webhook_first_deliveries_lost_total by reason): ${peerText(err)}`); });
      }
    }
  }),
  {
    beforeFirstBatch: yieldToEventLoop, // the rest of the burst joins this batch
    onError: err => { sayDeliveryFailureOnce('persist', 'retry-queue', () => { log.warn(`Webhook retry queue flush failed: ${peerText(err)}`); }); },
  },
);

/** `overflow`: the delivery was refused by its subscription's bound, and is counted as overflowed once its row is written (a shutdown's are not). */
function persistForRetry(d: FirstDelivery, { overflow }: { overflow: boolean }): void {
  pendingRetryRows.push({ job: retryJobFor(d.sub.id, d.body, d.event, d.spaceId, d.deliveryId, 2), overflow });
}

/**
 * Shutdown: the first deliveries that were queued and never attempted are written to the retry queue (so a restart delivers them), and
 * every first delivery offered afterwards goes there as well. Resolves when the rows are written, or after `withinMs` — the shutdown's own
 * drain budget, so a database that stopped answering costs the budget and not the orchestrator's kill. Returns how many queued deliveries
 * this call persisted.
 *
 * **Called twice by the shutdown, and safe to.** First before the HTTP drain, while the database is open; then once more after the drain,
 * before the connection closes: an event emitted by a request that finished while the server was draining went to the closed limiter and
 * on to the rows, and nobody awaited those. The second call closes nothing (the limiter is already closed) and waits for what is left.
 */
export async function drainFirstDeliveries({ withinMs }: { withinMs: number }): Promise<number> {
  const lostBefore = lostTotal();
  shutdownReadBackDeadline = Date.now() + withinMs;
  const queued = firstDeliveries.close();
  for (const d of queued) persistForRetry(d, { overflow: false });
  // Events emitted but not yet resolved are resolved now, against the closed limiter: each lands in the rows below.
  const written = (async () => { await emitQueue.settled(); await settledRetryWrites(); })();
  // The deadline is this call's: a read-back after it returns (the next call, a test) takes its own bound, not a spent budget.
  const outcome = await settledWithin(written, withinMs).finally(() => { shutdownReadBackDeadline = null; });
  if (!outcome.finished) {
    log.warn(`Shutdown: the webhook retry queue did not finish writing within ${withinMs}ms (${emitQueue.size} events unresolved, ${pendingRetryRows.size} rows unwritten); those deliveries are lost`);
  }
  if (lostTotal() > lostBefore) {
    log.warn(`Shutdown: ${lostTotal() - lostBefore} queued webhook deliveries could not be persisted for retry`);
  }
  return queued.length;
}

/**
 * Resolves when every retry row handed to the overflow flush so far, and every one handed to it meanwhile, has been written and COUNTED.
 * Used by the shutdown drain, and by a reader of the overflow counters (a test): the rows are visible to another connection before the
 * write resolves here and the counter rises (Q-580, probe P1(a)), so a reader that waits for the rows reads the counter too early.
 */
export async function settledRetryWrites(): Promise<void> {
  await pendingRetryRows.settled();
}

/**
 * Deliver a webhook payload to a specific subscription (first attempt).
 * If delivery fails, enqueue for retry instead of sleeping.
 */
async function deliverFirst(d: FirstDelivery): Promise<void> {
  const { sub, body, event, spaceId, deliveryId } = d;
  const result = await (firstDeliveryOverride
    ? firstDeliveryOverride.deliver(sub, body, event, spaceId, deliveryId)
    : attemptDelivery(sub, body, event, spaceId, deliveryId));

  if (result.success) {
    await markWebhookSuccess(sub.id);
  } else {
    // Enqueue first retry (attempt 2). A write that fails is counted by what the queue holds; one that left no copy goes on to the
    // limiter's reporter, which names it.
    await writeRetryRow(retryJobFor(sub.id, body, event, spaceId, deliveryId, 2));
    sayDeliveryFailureOnce('first', sub.id, () => { log.warn(`Webhook first delivery failed for ${peerText(sub.id)}: ${peerText(result.error ?? `HTTP ${result.responseStatus}`)} — queued for retry`); });
  }
}

/**
 * Deliver directly to a single webhook — used by the test endpoint.
 * Does NOT enqueue retries on failure (test is one-shot).
 */
export async function deliverToWebhook(
  sub: WebhookSubscription,
  body: string,
  event: WebhookEventType,
  spaceId: string,
): Promise<void> {
  const deliveryId = uuidv4();
  const result = await attemptDelivery(sub, body, event, spaceId, deliveryId);
  if (result.success) {
    await markWebhookSuccess(sub.id);
  } else {
    log.warn(`Test webhook delivery failed for ${sub.id}: ${result.error ?? `HTTP ${result.responseStatus}`}`);
  }
}

// ── Delivery attempt ────────────────────────────────────────────────────────

/** Max redirect hops to follow during delivery. Config-editable (reload-aware)
 *  with an env-var override; clamped to a sane range. Default 3. */
function webhookMaxRedirects(): number {
  const env = process.env['WEBHOOK_MAX_REDIRECTS'];
  let raw: unknown;
  if (env !== undefined && env !== '') raw = Number(env);
  else { try { raw = getConfig().webhookMaxRedirects; } catch { raw = undefined; } }
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 3;
  return Math.max(0, Math.min(20, n));
}

async function attemptDelivery(
  sub: WebhookSubscription,
  body: string,
  event: WebhookEventType,
  spaceId: string,
  deliveryId: string,
): Promise<WebhookDelivery> {
  const start = Date.now();
  const signature = computeHmac(sub.secret, body);

  const delivery: WebhookDelivery = {
    id: deliveryId,
    webhookId: sub.id,
    event,
    spaceId,
    timestamp: new Date().toISOString(),
    responseStatus: 0,
    latencyMs: 0,
    success: false,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    // Use the SSRF-safe fetch: it re-resolves DNS, pins the connection to the
    // validated IP, and re-validates every redirect hop, so a webhook target
    // validated at creation time cannot rebind or 3xx-redirect to an internal
    // address (cloud IMDS, RFC-1918, loopback).
    //
    // allowPrivate stays false, and does not follow allowPrivateModelEndpoints even when that is on.
    // The model opt-in exists because an operator chose a self-hosted inference server; it says nothing
    // about where a webhook may point, and a webhook is the more dangerous of the two — it is the
    // classic SSRF primitive, an attacker-influenceable URL this server will POST to on an event.
    const resp = await ssrfSafeFetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ythril-Signature': `sha256=${signature}`,
        'X-Ythril-Event': event,
        'X-Ythril-Delivery': deliveryId,
      },
      body,
      signal: controller.signal,
    }, { maxRedirects: webhookMaxRedirects() });

    clearTimeout(timeout);

    delivery.responseStatus = resp.status;
    delivery.latencyMs = Date.now() - start;
    delivery.success = resp.status >= 200 && resp.status < 300;
    if (!delivery.success) {
      delivery.error = `HTTP ${resp.status}`;
    }
  } catch (err) {
    delivery.latencyMs = Date.now() - start;
    // Stored and listed to the operator: bounded by the one renderer (bundle-30 I6, C16).
    delivery.error = peerText(err, { max: 500 });
  }

  // Record delivery — fire and forget
  recordDelivery(delivery).catch(() => {});

  return delivery;
}

// ── HMAC ────────────────────────────────────────────────────────────────────

function computeHmac(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
