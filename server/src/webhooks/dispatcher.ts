/**
 * Webhook event dispatcher — emits events to matching subscriptions.
 *
 * - HMAC-SHA256 signature using the subscription's shared secret
 * - At-least-once delivery with exponential backoff retries
 * - MongoDB-backed retry queue — retries survive process restarts
 * - Delivery logging for debugging
 * - Fire-and-forget from the caller's perspective (non-blocking)
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Filter, Sort } from 'mongodb';
import { getMatchingWebhooks, getWebhookFull, recordDelivery, markWebhookSuccess, markWebhookFailure } from './store.js';
import { col } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { log, peerText } from '../util/log.js';
import { publishBrainChange } from '../brain/brain-events.js';
import type { WebhookEventType, WebhookEventPayload, WebhookDelivery, WebhookSubscription } from './types.js';
import { withJitter } from '../util/backoff.js';
import { intervalJob, type IntervalJob, type IntervalJobDeps } from '../util/interval-job.js';
import { mapLimit } from '../util/map-limit.js';

/** Retry schedule in milliseconds: 10s, 30s, 1m, 5m, 30m, 1h */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000, 1_800_000, 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
const RETRY_COLLECTION = '_webhook_retry_queue';
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
    if (!sub) return; // webhook deleted while retry was queued

    const result = await deps.deliver(sub, job);

    if (result.success) {
      await deps.markSuccess(sub.id);
    } else if (job.attempt < MAX_ATTEMPTS) {
      await deps.requeue(job);
      log.warn(`Webhook retry ${job.attempt}/${MAX_ATTEMPTS} failed for ${peerText(job.webhookId)}: ${peerText(result.error ?? `HTTP ${result.responseStatus}`)}`);
    } else {
      await deps.markFailure(sub.id);
      log.error(`Webhook ${peerText(sub.id)} marked as failing after ${MAX_ATTEMPTS} delivery attempts`);
    }
  } catch (err) {
    log.warn(`Webhook retry queue error for ${peerText(job.webhookId)}: ${peerText(err)}`);
  }
}

async function enqueueRetry(
  webhookId: string,
  body: string,
  event: WebhookEventType,
  spaceId: string,
  deliveryId: string,
  attempt: number,
): Promise<void> {
  // Jittered: one webhook target going down fails every event queued against it at once, and without
  // jitter they would all come back at the same instant — a burst aimed at an endpoint that is, by
  // definition, already having a bad time. See `util/backoff.ts`.
  const delayMs = withJitter(RETRY_DELAYS_MS[attempt - 2] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!);
  const job: RetryJob = {
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
  await col<RetryJob>(RETRY_COLLECTION).insertOne(job as any);
}

// ── Public emit API ─────────────────────────────────────────────────────────

/**
 * Identifies the token that caused a mutation, for webhook attribution. Threaded from the
 * request/MCP surface down into the shared brain functions, which own webhook emission: a
 * shared mutating function emits when (and only when) it is given an actor — so user-facing
 * surfaces (REST, MCP) pass one and emit, while internal callers (sync, import, bulk) pass
 * none and stay silent. Centralises both the emit call AND its attribution in one place.
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
 */
export function emitWebhookEvent(opts: EmitWebhookEventOptions): void {
  // F12: mirror every brain mutation onto the in-process bus that drives live SSE updates. Done here,
  // the single choke point every write already funnels through, so it fires regardless of whether any
  // webhook subscription matches.
  publishBrainChange({ event: opts.event, spaceId: opts.spaceId, entry: opts.entry });
  _emitAsync(opts).catch(err => {
    log.warn(`Webhook emit error: ${peerText(err)}`);
  });
}

async function _emitAsync(opts: EmitWebhookEventOptions): Promise<void> {
  const { event, spaceId, entry, tokenId, tokenLabel } = opts;

  const subs = await getMatchingWebhooks(event, spaceId);
  if (subs.length === 0) return;

  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  const spaceName = space?.label ?? spaceId;

  const payload: WebhookEventPayload = {
    event,
    timestamp: new Date().toISOString(),
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

    deliverFirst(full, body, event, spaceId).catch(err => {
      log.warn(`Webhook delivery error for ${peerText(sub.id)}: ${peerText(err)}`);
    });
  }
}

/**
 * Deliver a webhook payload to a specific subscription (first attempt).
 * If delivery fails, enqueue for retry instead of sleeping.
 */
async function deliverFirst(
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
    // Enqueue first retry (attempt 2)
    await enqueueRetry(sub.id, body, event, spaceId, deliveryId, 2);
    log.warn(`Webhook first delivery failed for ${peerText(sub.id)}: ${peerText(result.error ?? `HTTP ${result.responseStatus}`)} — queued for retry`);
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
