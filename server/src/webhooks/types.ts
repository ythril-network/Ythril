/**
 * Webhook / event subscription types.
 *
 * Webhook subscriptions allow external systems to receive real-time
 * notifications when write events occur on Ythril spaces.
 */

// ── Event types ─────────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'memory.created' | 'memory.updated' | 'memory.deleted'
  | 'entity.created' | 'entity.updated' | 'entity.deleted'
  | 'edge.created'   | 'edge.updated'   | 'edge.deleted'
  | 'chrono.created'  | 'chrono.updated'  | 'chrono.deleted'
  | 'file.created'    | 'file.updated'    | 'file.deleted'
  | 'test.ping';

export const ALL_WEBHOOK_EVENTS: ReadonlySet<string> = new Set<WebhookEventType>([
  'memory.created', 'memory.updated', 'memory.deleted',
  'entity.created', 'entity.updated', 'entity.deleted',
  'edge.created',   'edge.updated',   'edge.deleted',
  'chrono.created',  'chrono.updated',  'chrono.deleted',
  'file.created',    'file.updated',    'file.deleted',
  'test.ping',
]);

// ── Subscription ────────────────────────────────────────────────────────────

export interface WebhookSubscription {
  id: string;
  url: string;
  /**
   * Shared secret for HMAC-SHA256 signing. Stored server-side for signing
   * outbound payloads — never returned in GET responses after creation.
   */
  secret: string;
  /** Space ID filter; empty array = all spaces. */
  spaces: string[];
  /** Event type filter; empty array = all events. */
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Current delivery status. */
  status: 'active' | 'failing' | 'disabled';
  /** Number of consecutive delivery failures. */
  consecutiveFailures: number;
}

// ── Delivery log entry ──────────────────────────────────────────────────────

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  spaceId: string;
  timestamp: string;
  /** HTTP status code returned by the receiver (0 if timeout/error). */
  responseStatus: number;
  /** Round-trip latency in milliseconds. */
  latencyMs: number;
  success: boolean;
  error?: string;
}

// ── Event payload ───────────────────────────────────────────────────────────

export interface WebhookEventPayload {
  event: WebhookEventType;
  timestamp: string;
  spaceId: string;
  spaceName: string;
  entry: Record<string, unknown>;
  tokenId?: string;
  tokenLabel?: string;
}
