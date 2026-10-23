/**
 * Webhook subscription store — MongoDB-backed CRUD with an in-memory cache that expires ({@link CACHE_TTL_MS}).
 *
 * Subscriptions are stored in the `_webhooks` collection.
 * Delivery logs are stored in the `_webhook_deliveries` collection.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Filter, UpdateFilter, Sort } from 'mongodb';
import { col } from '../db/mongo.js';
import { ensureExpiryIndex } from '../db/expiry-index.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { backoffDelayMs } from '../util/backoff.js';
import { encryptSecret, decryptSecret, isEncrypted } from '../util/crypto.js';
import type { WebhookSubscription, WebhookDelivery, WebhookEventType } from './types.js';
import { subscriptionAfterRetiredIds } from '../config/migrate-proxies-to-views.js';

const COLLECTION = '_webhooks';
const DELIVERIES_COLLECTION = '_webhook_deliveries';

/** Delivery records are retained for 30 days via TTL index. */
const DELIVERY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

// ── Delivery TTL index ──────────────────────────────────────────────────────

/**
 * Ensure the delivery collection has a TTL index on `_expireAt`.
 * Called once during startup from index.ts. (The retry queue's own index is ensured by the module that owns the queue,
 * `initRetryQueueIndexes` in `webhooks/dispatcher.ts`, run by the bootstrap as a step of its own that the boot does not await.)
 */
export async function initWebhookDeliveryIndexes(): Promise<void> {
  const dc = col<WebhookDelivery>(DELIVERIES_COLLECTION);
  await ensureExpiryIndex(DELIVERIES_COLLECTION, '_expireAt', 0, 'ttl_delivery_expireAt');
  await dc.createIndex({ webhookId: 1, timestamp: -1 });
}

/**
 * The DB phase of the 6.0 proxy-to-view upgrade, for webhooks (Q-531): a subscription that named ONLY retired proxy ids is DISABLED and
 * keeps its list (emptying it would subscribe it to every space: an empty list means all); one that named others loses only the retired ids.
 * Subscriptions live in the database, not in `config.json`, so the config migration cannot reach them. Idempotent: a repeat finds nothing to do,
 * and a subscription an admin re-enabled after it was disabled stays enabled (the rule records the ids it disabled for).
 * @returns how many subscriptions it changed.
 */
export async function retireWebhookSpaceIds(retiredIds: readonly string[]): Promise<number> {
  if (retiredIds.length === 0) return 0;
  let changed = 0;
  for (const sub of await col<WebhookSubscription>(COLLECTION).find({}).toArray()) {
    const after = subscriptionAfterRetiredIds(sub as WebhookSubscription, retiredIds);
    if (after === sub || (after.enabled === sub.enabled && after.spaces.length === sub.spaces.length)) continue;
    await col<WebhookSubscription>(COLLECTION).updateOne(
      { id: sub.id } as Filter<WebhookSubscription>,
      { $set: {
        spaces: after.spaces, enabled: after.enabled, status: after.enabled ? sub.status : 'disabled', updatedAt: new Date().toISOString(),
        ...(after.retiredIdsDisabledFor ? { retiredIdsDisabledFor: after.retiredIdsDisabledFor } : {}),
      } } as UpdateFilter<WebhookSubscription>,
    );
    changed++;
  }
  if (changed > 0) {
    invalidateCache();
    log.warn(`${changed} webhook subscription(s) named a retired proxy id: ones that named only retired ids are disabled, the rest lost the id`);
  }
  return changed;
}

// ── In-memory cache ─────────────────────────────────────────────────────────

/**
 * How long this process trusts its copy of the subscriptions (`Q-477`). Every write through this module drops the copy at once; the
 * expiry is for a write made by ANOTHER process (a rolling update runs two instances): without it, a subscription the other instance
 * marked failing, or recovered, kept its old status here until this process happened to write one itself.
 */
export const CACHE_TTL_MS = 5_000;

let _cache: WebhookSubscription[] | null = null;
let _cacheLoadedAt = 0;

async function ensureCache(): Promise<WebhookSubscription[]> {
  if (_cache && Date.now() - _cacheLoadedAt < CACHE_TTL_MS) return _cache;
  const loadedAt = Date.now();
  _cache = (await col<WebhookSubscription>(COLLECTION).find({}).toArray()) as WebhookSubscription[];
  _cacheLoadedAt = loadedAt;
  return _cache;
}

function invalidateCache(): void {
  _cache = null;
}

// ── Secret helpers ──────────────────────────────────────────────────────────

/**
 * Decrypt a webhook secret, handling migration from plaintext transparently.
 * Existing plaintext secrets (created before encryption was added) are
 * returned as-is; new (encrypted) secrets are decrypted.
 */
function getPlaintextSecret(stored: string): string {
  return isEncrypted(stored) ? decryptSecret(stored) : stored;
}

// ── Safe projection (strip secret) ─────────────────────────────────────────

type SafeWebhook = Omit<WebhookSubscription, 'secret'>;

function stripSecret(sub: WebhookSubscription): SafeWebhook {
  const { secret: _s, ...rest } = sub;
  return rest;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function listWebhooks(): Promise<SafeWebhook[]> {
  const subs = await ensureCache();
  return subs.map(stripSecret);
}

export async function getWebhook(id: string): Promise<SafeWebhook | null> {
  const subs = await ensureCache();
  const sub = subs.find(s => s.id === id);
  if (!sub) return null;
  return stripSecret(sub);
}

/** Internal — returns the full record with **decrypted** secret (for HMAC signing). */
export async function getWebhookFull(id: string): Promise<WebhookSubscription | null> {
  const subs = await ensureCache();
  const sub = subs.find(s => s.id === id);
  if (!sub) return null;
  return { ...sub, secret: getPlaintextSecret(sub.secret) };
}

/**
 * Does this subscription take deliveries at all — switched on, and neither disabled nor failing? The ONE answer, asked by the event
 * match (what a new event is sent to) and by the retry worker (what a queued retry is still delivered to), so a subscription the
 * operator switched off or the dispatcher marked failing is not reached by one door while the other has stopped. **It fails closed on
 * `enabled`**: only an explicit `true` takes deliveries (a row with no `enabled` was never switched on, and the event match used to
 * refuse it before this one answer existed). An ABSENT `status` is active: only `disabled` or `failing` stops it.
 */
export function acceptsDeliveries(sub: Pick<WebhookSubscription, 'enabled' | 'status'>): boolean {
  return sub.enabled === true && sub.status !== 'disabled' && sub.status !== 'failing';
}

/** Returns all enabled, non-failing subscriptions that match a given event+space. */
export async function getMatchingWebhooks(
  event: WebhookEventType,
  spaceId: string,
): Promise<WebhookSubscription[]> {
  const subs = await ensureCache();
  return subs.filter(s => {
    if (!acceptsDeliveries(s)) return false;
    if (s.spaces.length > 0 && !s.spaces.includes(spaceId)) return false;
    if (s.events.length > 0 && !s.events.includes(event)) return false;
    return true;
  });
}

export interface CreateWebhookInput {
  url: string;
  secret: string;
  spaces?: string[];
  events?: WebhookEventType[];
  enabled?: boolean;
}

export async function createWebhook(input: CreateWebhookInput): Promise<{ subscription: SafeWebhook; id: string }> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const sub: WebhookSubscription = {
    id,
    url: input.url,
    secret: encryptSecret(input.secret),
    spaces: input.spaces ?? [],
    events: input.events ?? [],
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    status: input.enabled === false ? 'disabled' : 'active',
    consecutiveFailures: 0,
  };

  // `as any` — MongoDB driver's OptionalUnlessRequiredId<T> doesn't match T directly
  await col<WebhookSubscription>(COLLECTION).insertOne(sub as any);
  invalidateCache();
  log.info(`Webhook created: ${id} → ${input.url}`);

  return { subscription: stripSecret(sub), id };
}

export interface UpdateWebhookInput {
  url?: string;
  secret?: string;
  spaces?: string[];
  events?: WebhookEventType[];
  enabled?: boolean;
}

/** The probe fields, removed whenever a subscription stops being failing: by an admin's `enabled`, a recovery or a success. */
const PROBE_FIELDS_UNSET = { nextProbeAt: '', probeAttempts: '' } as const;

/**
 * The update an admin's edit writes. `enabled` in the body, either way, is the explicit act on the subscription's status: `true` is the
 * documented reset (active, count 0) and `false` disables it, and both clear the probe schedule (`nextProbeAt`, `probeAttempts`), which
 * belongs to a failing subscription only. An edit without `enabled` leaves status, count and schedule as they are.
 */
export function webhookUpdateWrite(input: UpdateWebhookInput): UpdateFilter<WebhookSubscription> {
  const $set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.url !== undefined) $set['url'] = input.url;
  if (input.secret !== undefined) $set['secret'] = encryptSecret(input.secret);
  if (input.spaces !== undefined) $set['spaces'] = input.spaces;
  if (input.events !== undefined) $set['events'] = input.events;
  if (input.enabled === undefined) return { $set } as UpdateFilter<WebhookSubscription>;
  $set['enabled'] = input.enabled;
  $set['status'] = input.enabled ? 'active' : 'disabled';
  if (input.enabled) $set['consecutiveFailures'] = 0;
  return { $set, $unset: PROBE_FIELDS_UNSET } as UpdateFilter<WebhookSubscription>;
}

export async function updateWebhook(
  id: string,
  input: UpdateWebhookInput,
): Promise<SafeWebhook | null> {
  const result = await col<WebhookSubscription>(COLLECTION).updateOne(
    { id } as Filter<WebhookSubscription>,
    webhookUpdateWrite(input),
  );
  invalidateCache();
  if (result.matchedCount === 0) return null;

  return getWebhook(id);
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const result = await col<WebhookSubscription>(COLLECTION).deleteOne(
    { id } as Filter<WebhookSubscription>,
  );
  // Also remove delivery logs
  await col<WebhookDelivery>(DELIVERIES_COLLECTION).deleteMany(
    { webhookId: id } as Filter<WebhookDelivery>,
  );
  invalidateCache();
  return (result.deletedCount ?? 0) > 0;
}

// ── Delivery logging ────────────────────────────────────────────────────────

export async function recordDelivery(delivery: WebhookDelivery): Promise<void> {
  const doc = {
    ...delivery,
    _expireAt: new Date(Date.now() + DELIVERY_RETENTION_SECONDS * 1000),
  };
  await col<WebhookDelivery>(DELIVERIES_COLLECTION).insertOne(doc as any);
}

export async function listDeliveries(webhookId: string, limit = 100): Promise<WebhookDelivery[]> {
  return (await col<WebhookDelivery>(DELIVERIES_COLLECTION)
    .find({ webhookId } as Filter<WebhookDelivery>)
    .sort({ timestamp: -1 } as Sort)
    .limit(Math.min(limit, 100))
    .toArray()) as WebhookDelivery[];
}

// ── Status tracking ─────────────────────────────────────────────────────────

//
// Every status write here is CONDITIONAL on what the row says when the write lands, never on this process's copy of it (`Q-477`). The
// copy is one process's, up to `CACHE_TTL_MS` old, and a second process (or a second call in this one) writes the same row: a count read
// from the copy and written back loses the other writer's failure, and a status written to "whatever row this id names" turns a
// subscription an admin disabled meanwhile back to active. So a count is `$inc`ed, a status changes only through a filter that names the
// status it changes FROM, and the line a status change is said by is said only by the write that changed the row (`modifiedCount`).

/**
 * How many exhausted retry schedules in a row mark a subscription failing. A schedule is a delivery's seven attempts (`MAX_ATTEMPTS` in
 * `dispatcher.ts`), so this is six events in a row that the sink refused for about an hour and a half each, not six failed requests.
 */
export const FAILING_AFTER = 6;

/** The probe schedule of a failing subscription: `backoffDelayMs(probeAttempts, PROBE_BASE_MS, PROBE_CAP_MS)`, equal-jittered. */
const PROBE_BASE_MS = 60_000;
const PROBE_CAP_MS = 3_600_000;

/**
 * The flip of a subscription to failing, once its count has reached {@link FAILING_AFTER}: from active (a row with no status is active,
 * as {@link acceptsDeliveries} reads it) and switched on, never from disabled and never twice. It schedules the first probe at once
 * (`nextProbeAt` now, `probeAttempts` 0).
 */
export function failingFlipWrite(id: string, now: Date): { filter: Filter<WebhookSubscription>; update: UpdateFilter<WebhookSubscription> } {
  return {
    filter: { id, enabled: true, status: { $nin: ['failing', 'disabled'] }, consecutiveFailures: { $gte: FAILING_AFTER } } as Filter<WebhookSubscription>,
    update: { $set: { status: 'failing', nextProbeAt: now.toISOString(), probeAttempts: 0 } } as UpdateFilter<WebhookSubscription>,
  };
}

/**
 * The claim of one due probe, and it IS the schedule: the write moves `nextProbeAt` on as if the probe will fail
 * (`backoffDelayMs(k, 1 min, 1 h)`) and counts the attempt, so a probe that never reports back (a crash, a shutdown) is retried on that
 * schedule, and two processes cannot claim the same probe: the filter carries the `probeAttempts` this claim was computed from (`k`, or
 * the field missing when `k` is 0), so the second claim matches nothing. A row failing since before probing existed has neither field,
 * and is due.
 */
export function probeClaim(
  row: Pick<WebhookSubscription, 'id'> & { probeAttempts?: unknown },
  now: Date,
): { filter: Filter<WebhookSubscription>; update: UpdateFilter<WebhookSubscription> } {
  const read = row.probeAttempts;
  // A count is a whole number of 0 or more, or missing (a row failing since before probing existed). Anything else (null, -1, a string)
  // is matched as the value it is, so the claim takes the row it read: a filter that missed it would leave that row first in the due
  // order for ever, read by every try and claimed by none, and no other subscription would be probed again. Its count starts again.
  const isCount = read === undefined || (typeof read === 'number' && Number.isInteger(read) && read >= 0);
  const k = isCount ? ((read as number | undefined) ?? 0) : 0;
  const attempts = !isCount ? { probeAttempts: read }
    : k === 0 ? { $or: [{ probeAttempts: { $exists: false } }, { probeAttempts: 0 }] }
    : { probeAttempts: k };
  const nextProbeAt = new Date(now.getTime() + backoffDelayMs(k, PROBE_BASE_MS, PROBE_CAP_MS)).toISOString();
  return {
    filter: {
      id: row.id, status: 'failing', enabled: true,
      $and: [{ $or: [{ nextProbeAt: { $exists: false } }, { nextProbeAt: { $lte: now.toISOString() } }] }, attempts],
    } as Filter<WebhookSubscription>,
    update: (isCount
      ? { $set: { nextProbeAt }, $inc: { probeAttempts: 1 } }
      : { $set: { nextProbeAt, probeAttempts: 1 } }) as UpdateFilter<WebhookSubscription>,
  };
}

/**
 * A probe the sink answered: the subscription is active again ON PROBATION (count {@link FAILING_AFTER} - 1, so one more exhausted
 * schedule flips it back: a sink that answers a ping and refuses real payloads is not given six more schedules), and the probe fields
 * go. Only the row that was probed: still failing, still switched on, still at the URL the probe went to.
 */
export function probeRecoveryWrite(id: string, url: string): { filter: Filter<WebhookSubscription>; update: UpdateFilter<WebhookSubscription> } {
  return {
    filter: { id, status: 'failing', enabled: true, url } as Filter<WebhookSubscription>,
    update: { $set: { status: 'active', consecutiveFailures: FAILING_AFTER - 1 }, $unset: PROBE_FIELDS_UNSET } as UpdateFilter<WebhookSubscription>,
  };
}

/** Claim one failing subscription whose probe is due, or null when none is (or another process claimed each one first). */
export async function claimDueProbe(now: Date): Promise<{ id: string; url: string } | null> {
  const subs = col<WebhookSubscription>(COLLECTION);
  const due = {
    status: 'failing', enabled: true,
    $or: [{ nextProbeAt: { $exists: false } }, { nextProbeAt: { $lte: now.toISOString() } }],
  } as Filter<WebhookSubscription>;
  // A claim lost to another process is the only reason to look again, and three losses in a row is a contended tick: the next has its turn.
  for (let tries = 0; tries < 3; tries++) {
    const row = await subs.findOne(due, { projection: { id: 1, url: 1, probeAttempts: 1 }, sort: { nextProbeAt: 1 } });
    if (!row) return null;
    const { filter, update } = probeClaim(row, now);
    const claimed = await subs.updateOne(filter, update);
    if (claimed.modifiedCount === 1) { invalidateCache(); return { id: row.id, url: row.url }; }
  }
  return null;
}

/** Recover a probed subscription ({@link probeRecoveryWrite}); answers whether this write changed the row. */
export async function markProbeRecovered(id: string, url: string): Promise<boolean> {
  const { filter, update } = probeRecoveryWrite(id, url);
  const result = await col<WebhookSubscription>(COLLECTION).updateOne(filter, update);
  invalidateCache();
  return result.modifiedCount === 1;
}

/**
 * A delivery succeeded (a real event, or an admin's test ping): the subscription is active with a count of 0, and a failing one is
 * recovered. Never a disabled or switched-off one. Writes only when that CHANGES the row, so a burst of N successful deliveries to a
 * healthy sink is not N writes of an unchanged row (and N cache invalidations, each making the next event re-read every subscription):
 * the collection decides, never this process's copy alone, which a failure another process counted has not reached (round 2, F2).
 * When the copy says there is nothing to reset, the collection is asked in the background (at most once per subscription per
 * `CACHE_TTL_MS`), so the delivery does not wait on it; when the copy says there is, the reset is awaited by the caller (a first
 * delivery or a retry; the test route answers `queued` without waiting for its delivery, so nothing reads this reset back).
 *
 * The background reset clears failures counted by ANOTHER instance between this success and the check landing, and does so on
 * purpose: the sink answered, which is what the count measures, so a failure counted elsewhere just before is superseded by it.
 */
export async function markWebhookSuccess(id: string): Promise<void> {
  const sub = (await ensureCache()).find(s => s.id === id);
  if (sub && sub.status === 'active' && (sub.consecutiveFailures ?? 0) === 0) {
    // The copy says there is nothing to reset, and it is up to CACHE_TTL_MS old: a failure ANOTHER process counted in that window is
    // not in it, and would survive this success. So the collection is asked too, but not on the delivery's time: a delivery that
    // waited on a database round trip would let a burst outrun its sink's bound. At most one check per subscription per window
    // (`checkAfterSuccess`).
    checkAfterSuccess(id);
    return;
  }
  await resetAfterSuccess(id);
}

/** What a success changes: a row that is switched on, not disabled, and either not active or carrying failures. */
const needsResetAfterSuccess = (id: string): Filter<WebhookSubscription> => ({
  id, enabled: true, status: { $ne: 'disabled' },
  $or: [{ status: { $ne: 'active' } }, { consecutiveFailures: { $ne: 0 } }],
} as Filter<WebhookSubscription>);

/**
 * Reset a subscription after a success, if the COLLECTION says it needs one. The read is the no-op path (a find, never a write of an
 * unchanged row); the write's own filter asks the same question again when it lands.
 */
async function resetAfterSuccess(id: string): Promise<void> {
  const subs = col<WebhookSubscription>(COLLECTION);
  if (!(await subs.findOne(needsResetAfterSuccess(id), { projection: { _id: 1 } }))) return;
  const result = await subs.updateOne(
    needsResetAfterSuccess(id),
    { $set: { status: 'active', consecutiveFailures: 0 }, $unset: PROBE_FIELDS_UNSET } as UpdateFilter<WebhookSubscription>,
  );
  if (result.modifiedCount > 0) invalidateCache();
}

/**
 * When each subscription's last background check started. At most ONE check per subscription per {@link CACHE_TTL_MS} window: a
 * success inside the window after a check started starts none (round 3). The window is the staleness this process already accepts for
 * every status it reads from its copy, so a failure another instance counted is reset by the first success after the window at the
 * latest, and a busy healthy subscription pays one read per window, not one per success. Keyed by id and bounded by the subscriptions.
 */
const successCheckStartedAt = new Map<string, number>();
const successCheckFailed = warnOnce<string>({ max: 500, every: 10 * 60_000 });
let successChecksStopped = false;

/**
 * Shutdown: start no more background checks after a success. A check started late in the drain would land after the connection
 * closed and log a failure that says nothing true about the subscription. Called by the shutdown with the other webhook stops.
 */
export function stopSuccessChecks(): void {
  successChecksStopped = true;
}

function checkAfterSuccess(id: string): void {
  if (successChecksStopped) return;
  const now = Date.now();
  const last = successCheckStartedAt.get(id);
  if (last !== undefined && now - last < CACHE_TTL_MS) return;
  successCheckStartedAt.set(id, now);
  void resetAfterSuccess(id).catch((err: unknown) => {
    successCheckFailed(id, () => { log.warn(`Webhook ${peerText(id)}: the check after a delivery success failed (a failure counted by another instance may stand until a later success): ${peerText(err)}`); });
  });
}

/**
 * A delivery's retry schedule ran out. Counts it (`$inc`, so concurrent failures, from this process or another, each count), then flips
 * the subscription to failing when the count has reached {@link FAILING_AFTER} ({@link failingFlipWrite}). Answers whether THIS call's
 * flip changed the row, so the "marked as failing" line is said once per flip and not on every exhausted schedule.
 */
export async function markWebhookFailure(id: string): Promise<boolean> {
  const subs = col<WebhookSubscription>(COLLECTION);
  const counted = await subs.updateOne(
    { id, status: { $ne: 'disabled' } } as Filter<WebhookSubscription>,
    { $inc: { consecutiveFailures: 1 } } as UpdateFilter<WebhookSubscription>,
  );
  if (counted.matchedCount === 0) return false;
  const { filter, update } = failingFlipWrite(id, new Date());
  const flipped = await subs.updateOne(filter, update);
  invalidateCache();
  return flipped.modifiedCount === 1;
}

/** How many subscriptions are failing now: the `ythril_webhooks_failing` gauge, read from the collection at scrape time. */
export async function countFailingWebhooks(): Promise<number> {
  return await col<WebhookSubscription>(COLLECTION).countDocuments({ status: 'failing' } as Filter<WebhookSubscription>);
}
