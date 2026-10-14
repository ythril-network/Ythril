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
import { getMatchingWebhooks, getWebhookFull, recordDelivery, markWebhookSuccess, markWebhookFailure, acceptsDeliveries } from './store.js';
import { asDoc, col } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { log, peerText } from '../util/log.js';
import { publishBrainChange } from '../brain/brain-events.js';
import type { WebhookEventType, WebhookEventPayload, WebhookDelivery, WebhookSubscription } from './types.js';
import { withJitter } from '../util/backoff.js';
import { intervalJob, type IntervalJob, type IntervalJobDeps } from '../util/interval-job.js';
import { mapLimit } from '../util/map-limit.js';
import { keyedLimiter } from '../util/keyed-limiter.js';
import { writeInOneCommands } from '../db/one-command.js';
import { warnOnce } from '../util/warn-once.js';
import { drainedQueue } from '../util/drained-queue.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';

/** Retry schedule in milliseconds: 10s, 30s, 1m, 5m, 30m, 1h */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000, 1_800_000, 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
const RETRY_COLLECTION = '_webhook_retry_queue';

/**
 * Ensure the retry queue's index on `scheduledAt`, once at startup (`bootstrap.ts`, beside the store's own indexes). The poll reads the queue
 * `{ scheduledAt: { $lte: now } }` sorted by it, every ten seconds; the queue is small until a burst overflows into it (a directory delete
 * to a sink that is down), and then each poll would scan and sort all of it.
 */
export async function initRetryQueueIndexes(): Promise<void> {
  await col<RetryJob>(RETRY_COLLECTION).createIndex({ scheduledAt: 1 });
}
const RETRY_POLL_INTERVAL_MS = 10_000;

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
/** The most due retries one tick takes from the queue. */
const RETRY_BATCH = 50;

/**
 * What one retry tick reaches. Production is {@link realRetryPollDeps}; a test hands in fakes (the queue is a collection, and a
 * delivery is an outbound request that the SSRF guard would refuse to send to anything a test could listen on).
 */
export interface RetryPollDeps {
  dueJobs(now: Date): Promise<RetryJob[]>;
  removeJob(id: string): Promise<void>;
  getWebhook(id: string): Promise<WebhookSubscription | null>;
  deliver(sub: WebhookSubscription, job: RetryJob): Promise<WebhookDelivery>;
  markSuccess(webhookId: string): Promise<void>;
  markFailure(webhookId: string): Promise<void>;
  /** Put the job back for its next attempt (`job.attempt + 1`), at the next backoff step. */
  requeue(job: RetryJob): Promise<void>;
}

const realRetryPollDeps: RetryPollDeps = {
  dueJobs: async (now) => await col<RetryJob>(RETRY_COLLECTION)
    .find({ scheduledAt: { $lte: now } } as Filter<RetryJob>)
    .sort({ scheduledAt: 1 } as Sort)
    .limit(RETRY_BATCH)
    .toArray() as RetryJob[],
  removeJob: async (id) => { await col<RetryJob>(RETRY_COLLECTION).deleteOne({ _id: id } as Filter<RetryJob>); },
  getWebhook: (id) => getWebhookFull(id),
  deliver: (sub, job) => attemptDelivery(sub, job.body, job.event, job.spaceId, job.deliveryId),
  markSuccess: markWebhookSuccess,
  markFailure: markWebhookFailure,
  requeue: (job) => enqueueRetry(job.webhookId, job.body, job.event, job.spaceId, job.deliveryId, job.attempt + 1),
};

/**
 * The retry poll as an interval job (`Q-317`), and `deps` is a test seam: production never passes it.
 *
 * ## It SKIPS an overlapping tick, and delivers four at a time
 *
 * A bare `setInterval` ran a pass every 10 s whether or not the last had ended, and a pass delivered its due jobs one after
 * another. Both were wrong in a way a slow sink exposes: a sink that takes its whole delivery timeout held every other sink's
 * retries behind it, and the passes that fired meanwhile read the same queue. The job skips an overlapping tick (a second
 * delivery of the same event is the worse failure: the queue is re-read next tick, so a skip costs a delay, never a retry) and
 * counts it. And a tick delivers with a concurrency of {@link RETRY_CONCURRENCY} (`mapLimit`), so one slow sink holds one slot
 * of four and every other sink's retry goes out meanwhile.
 *
 * **What bounds a tick.** The job's tick runs inside the housekeeping bound, so every database operation here ends at
 * `housekeepingOpMs()`. A delivery is not a database operation and carries its own timeout (`DELIVERY_TIMEOUT_MS`, an abort
 * signal on the request). The one wait with no signal is the DNS lookup inside `ssrfSafeFetch`, which is its own ticket.
 *
 * One job failing (a database error after its row was removed, an unexpected throw in delivery) is said and the others of the
 * tick go on; a failure before any job is read (the queue itself) is the interval job's: `Webhook retry poll failed: …`.
 */
export function createRetryWorker(deps: RetryPollDeps = realRetryPollDeps, jobDeps?: IntervalJobDeps): { job: IntervalJob } {
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
  const jobs = await deps.dueJobs(new Date());
  await mapLimit(jobs, RETRY_CONCURRENCY, (job) => retryOne(deps, job));
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
    } else {
      await deps.markFailure(sub.id);
      log.error(`Webhook ${peerText(sub.id)} marked as failing after ${MAX_ATTEMPTS} delivery attempts`);
    }
  } catch (err) {
    sayDeliveryFailureOnce('retry-error', job.webhookId, () => { log.warn(`Webhook retry queue error for ${peerText(job.webhookId)}: ${peerText(err)}`); });
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

async function enqueueRetry(
  webhookId: string,
  body: string,
  event: WebhookEventType,
  spaceId: string,
  deliveryId: string,
  attempt: number,
): Promise<void> {
  await col<RetryJob>(RETRY_COLLECTION).insertOne(asDoc<RetryJob>(retryJobFor(webhookId, body, event, spaceId, deliveryId, attempt)));
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

/** The tally behind `ythril_webhook_first_deliveries_queued_total`, `_overflowed_total` and `_lost_total`; the registry reads it at scrape time. */
const firstDeliveryTally = { queued: 0, overflowed: 0, lost: 0 };
export function webhookFirstDeliveryCounts(): { queued: number; overflowed: number; lost: number } {
  return { ...firstDeliveryTally };
}

const firstDeliveries = keyedLimiter<string, FirstDelivery>({
  concurrency: FIRST_DELIVERY_CONCURRENCY,
  bound: FIRST_DELIVERY_BOUND,
  run: (_id, d) => deliverFirst(d),
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
  async (batch) => {
    try {
      // Sliced by bytes and count so each write is ONE wire command (`db/one-command.ts`): a retry body is a whole event payload.
      await writeInOneCommands(batch.map(b => asDoc<RetryJob>(b.job)), (slice, { ordered }) => col<RetryJob>(RETRY_COLLECTION).insertMany(slice, { ordered }), { ordered: false });
      firstDeliveryTally.overflowed += batch.filter(b => b.overflow).length;
    } catch (err) {
      // Counted as lost: `writeInOneCommands` may have landed some slices before one failed, so this is an upper bound, which is the
      // honest side for a counter of events a subscriber may never be sent.
      firstDeliveryTally.lost += batch.length;
      sayDeliveryFailureOnce('persist', 'retry-queue', () => { log.warn(`Webhook retry queue write failed; up to ${batch.length} first deliveries were not persisted and are lost (counted in ythril_webhook_first_deliveries_lost_total): ${peerText(err)}`); });
    }
  },
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
  const lostBefore = firstDeliveryTally.lost;
  const queued = firstDeliveries.close();
  for (const d of queued) persistForRetry(d, { overflow: false });
  // Events emitted but not yet resolved are resolved now, against the closed limiter: each lands in the rows below.
  const written = (async () => { await emitQueue.settled(); await pendingRetryRows.settled(); })();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), withinMs); timer.unref(); });
  const outcome = await Promise.race([written.then(() => 'written' as const), budget]);
  clearTimeout(timer);
  if (outcome === 'late') {
    log.warn(`Shutdown: the webhook retry queue did not finish writing within ${withinMs}ms (${emitQueue.size} events unresolved, ${pendingRetryRows.size} rows unwritten); those deliveries are lost`);
  }
  if (firstDeliveryTally.lost > lostBefore) {
    log.warn(`Shutdown: ${firstDeliveryTally.lost - lostBefore} queued webhook deliveries could not be persisted for retry`);
  }
  return queued.length;
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
    // Enqueue first retry (attempt 2). A write that fails leaves the event with no copy anywhere: counted before the failure goes to the
    // limiter's reporter, which names it.
    try { await enqueueRetry(sub.id, body, event, spaceId, deliveryId, 2); } catch (err) { firstDeliveryTally.lost++; throw err; }
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
