/**
 * Webhook event dispatcher — emits events to matching subscriptions.
 *
 * - HMAC-SHA256 signature using the subscription's shared secret
 * - At-least-once delivery with exponential backoff retries
 * - Delivery logging for debugging
 * - Fire-and-forget from the caller's perspective (non-blocking)
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getMatchingWebhooks, getWebhookFull, recordDelivery, markWebhookSuccess, markWebhookFailure } from './store.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { WebhookEventType, WebhookEventPayload, WebhookDelivery, WebhookSubscription } from './types.js';

/** Retry schedule in milliseconds: 10s, 30s, 1m, 5m, 30m, 1h */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000, 1_800_000, 3_600_000];
const DELIVERY_TIMEOUT_MS = 10_000;

// ── Public emit API ─────────────────────────────────────────────────────────

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
 * dispatched asynchronously. Failures are retried with exponential backoff.
 */
export function emitWebhookEvent(opts: EmitWebhookEventOptions): void {
  // Do not block the caller — schedule delivery asynchronously.
  _emitAsync(opts).catch(err => {
    log.warn(`Webhook emit error: ${err}`);
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
    // Fetch full subscription (with secretHash) for HMAC signing
    const full = await getWebhookFull(sub.id);
    if (!full) continue;

    deliverWithRetry(full, body, event, spaceId).catch(err => {
      log.warn(`Webhook delivery error for ${sub.id}: ${err}`);
    });
  }
}

// ── Delivery with retry ─────────────────────────────────────────────────────

async function deliverWithRetry(
  sub: WebhookSubscription,
  body: string,
  event: WebhookEventType,
  spaceId: string,
): Promise<void> {
  const deliveryId = uuidv4();
  const maxAttempts = RETRY_DELAYS_MS.length + 1; // first attempt + retries

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1]!;
      await sleep(delay);
    }

    const result = await attemptDelivery(sub, body, event, spaceId, deliveryId);

    if (result.success) {
      await markWebhookSuccess(sub.id);
      return;
    }

    log.warn(`Webhook delivery attempt ${attempt + 1}/${maxAttempts} failed for ${sub.id}: ${result.error ?? `HTTP ${result.responseStatus}`}`);
  }

  // All retries exhausted
  await markWebhookFailure(sub.id);
  log.error(`Webhook ${sub.id} marked as failing after ${maxAttempts} delivery attempts`);
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

    const resp = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ythril-Signature': `sha256=${signature}`,
        'X-Ythril-Event': event,
        'X-Ythril-Delivery': deliveryId,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    delivery.responseStatus = resp.status;
    delivery.latencyMs = Date.now() - start;
    delivery.success = resp.status >= 200 && resp.status < 300;
    if (!delivery.success) {
      delivery.error = `HTTP ${resp.status}`;
    }
  } catch (err) {
    delivery.latencyMs = Date.now() - start;
    delivery.error = err instanceof Error ? err.message : String(err);
  }

  // Record delivery — fire and forget
  recordDelivery(delivery).catch(() => {});

  return delivery;
}

// ── HMAC ────────────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 of the body using the subscription's shared secret.
 * The receiver uses the same secret to verify payload authenticity.
 */
function computeHmac(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
