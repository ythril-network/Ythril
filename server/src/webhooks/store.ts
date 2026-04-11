/**
 * Webhook subscription store — MongoDB-backed CRUD with in-memory cache.
 *
 * Subscriptions are stored in the `_webhooks` collection.
 * Delivery logs are stored in the `_webhook_deliveries` collection.
 */

import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/mongo.js';
import { log } from '../util/log.js';
import type { WebhookSubscription, WebhookDelivery, WebhookEventType } from './types.js';

const COLLECTION = '_webhooks';
const DELIVERIES_COLLECTION = '_webhook_deliveries';
const MAX_DELIVERIES_PER_WEBHOOK = 100;

// ── In-memory cache ─────────────────────────────────────────────────────────

let _cache: WebhookSubscription[] | null = null;

async function ensureCache(): Promise<WebhookSubscription[]> {
  if (_cache) return _cache;
  _cache = (await col<WebhookSubscription>(COLLECTION).find({}).toArray()) as WebhookSubscription[];
  return _cache;
}

function invalidateCache(): void {
  _cache = null;
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

/** Internal — returns the full record including secret (for HMAC signing). */
export async function getWebhookFull(id: string): Promise<WebhookSubscription | null> {
  const subs = await ensureCache();
  return subs.find(s => s.id === id) ?? null;
}

/** Returns all enabled subscriptions that match a given event+space. */
export async function getMatchingWebhooks(
  event: WebhookEventType,
  spaceId: string,
): Promise<WebhookSubscription[]> {
  const subs = await ensureCache();
  return subs.filter(s => {
    if (!s.enabled) return false;
    if (s.status === 'disabled') return false;
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
    secret: input.secret,
    spaces: input.spaces ?? [],
    events: input.events ?? [],
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    status: input.enabled === false ? 'disabled' : 'active',
    consecutiveFailures: 0,
  };

  await col<WebhookSubscription>(COLLECTION).insertOne(sub as never);
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

export async function updateWebhook(
  id: string,
  input: UpdateWebhookInput,
): Promise<SafeWebhook | null> {
  const subs = await ensureCache();
  const existing = subs.find(s => s.id === id);
  if (!existing) return null;

  const $set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.url !== undefined) $set['url'] = input.url;
  if (input.secret !== undefined) $set['secret'] = input.secret;
  if (input.spaces !== undefined) $set['spaces'] = input.spaces;
  if (input.events !== undefined) $set['events'] = input.events;
  if (input.enabled !== undefined) {
    $set['enabled'] = input.enabled;
    $set['status'] = input.enabled ? 'active' : 'disabled';
    if (input.enabled) $set['consecutiveFailures'] = 0;
  }

  await col<WebhookSubscription>(COLLECTION).updateOne({ id } as never, { $set } as never);
  invalidateCache();

  return getWebhook(id);
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const result = await col<WebhookSubscription>(COLLECTION).deleteOne({ id } as never);
  // Also remove delivery logs
  await col<WebhookDelivery>(DELIVERIES_COLLECTION).deleteMany({ webhookId: id } as never);
  invalidateCache();
  return (result.deletedCount ?? 0) > 0;
}

// ── Delivery logging ────────────────────────────────────────────────────────

export async function recordDelivery(delivery: WebhookDelivery): Promise<void> {
  await col<WebhookDelivery>(DELIVERIES_COLLECTION).insertOne(delivery as never);

  // Trim old deliveries to keep at most MAX_DELIVERIES_PER_WEBHOOK per webhook
  const count = await col<WebhookDelivery>(DELIVERIES_COLLECTION).countDocuments({ webhookId: delivery.webhookId } as never);
  if (count > MAX_DELIVERIES_PER_WEBHOOK) {
    const oldest = await col<WebhookDelivery>(DELIVERIES_COLLECTION)
      .find({ webhookId: delivery.webhookId } as never)
      .sort({ timestamp: 1 } as never)
      .limit(count - MAX_DELIVERIES_PER_WEBHOOK)
      .toArray() as WebhookDelivery[];
    if (oldest.length > 0) {
      const ids = oldest.map(d => d.id);
      await col<WebhookDelivery>(DELIVERIES_COLLECTION).deleteMany({ id: { $in: ids } } as never);
    }
  }
}

export async function listDeliveries(webhookId: string, limit = 100): Promise<WebhookDelivery[]> {
  return (await col<WebhookDelivery>(DELIVERIES_COLLECTION)
    .find({ webhookId } as never)
    .sort({ timestamp: -1 } as never)
    .limit(Math.min(limit, 100))
    .toArray()) as WebhookDelivery[];
}

// ── Status tracking ─────────────────────────────────────────────────────────

export async function markWebhookSuccess(id: string): Promise<void> {
  await col<WebhookSubscription>(COLLECTION).updateOne(
    { id } as never,
    { $set: { status: 'active', consecutiveFailures: 0 } } as never,
  );
  invalidateCache();
}

export async function markWebhookFailure(id: string): Promise<void> {
  const subs = await ensureCache();
  const sub = subs.find(s => s.id === id);
  if (!sub) return;

  const failures = (sub.consecutiveFailures ?? 0) + 1;
  const status = failures >= 6 ? 'failing' : sub.status;

  await col<WebhookSubscription>(COLLECTION).updateOne(
    { id } as never,
    { $set: { status, consecutiveFailures: failures } } as never,
  );
  invalidateCache();
}
