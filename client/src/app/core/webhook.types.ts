/**
 * The webhook subscription types and the event list their picker groups. Moved out of `api.types.ts` (bundle-231), which is past its size
 * limit: the group is self-contained (it names no other type of that file), and `api.types.ts` re-exports it so every importer keeps its path.
 */

export type WebhookEventType =
  | 'fact.created' | 'fact.updated' | 'fact.deleted'
  | 'entity.created' | 'entity.updated' | 'entity.deleted' | 'entity.merged'
  | 'edge.created' | 'edge.updated' | 'edge.deleted'
  | 'chrono.created' | 'chrono.updated' | 'chrono.deleted'
  | 'file.created' | 'file.updated' | 'file.deleted'
  | 'bulk.write'
  | 'link_violation.created'
  | 'duplicate.detected' | 'change_note.received';

/**
 * Selectable webhook events, grouped by domain for the picker. `test.ping` is deliberately excluded —
 * it is the test-button's internal event, not a real domain event a user would subscribe to.
 */
export const WEBHOOK_EVENT_GROUPS: { group: string; events: WebhookEventType[] }[] = [
  { group: 'fact', events: ['fact.created', 'fact.updated', 'fact.deleted'] },
  { group: 'entity', events: ['entity.created', 'entity.updated', 'entity.deleted', 'entity.merged'] },
  { group: 'edge', events: ['edge.created', 'edge.updated', 'edge.deleted'] },
  { group: 'chrono', events: ['chrono.created', 'chrono.updated', 'chrono.deleted'] },
  { group: 'file', events: ['file.created', 'file.updated', 'file.deleted'] },
  { group: 'other', events: ['bulk.write', 'link_violation.created', 'duplicate.detected', 'change_note.received'] },
];

/** A webhook subscription as returned by the API — the shared HMAC secret is never included. */
export interface WebhookSubscription {
  id: string;
  url: string;
  /** Space ID filter; empty = all spaces. */
  spaces: string[];
  /** Event type filter; empty = all events. */
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'failing' | 'disabled';
  consecutiveFailures: number;
  /** A failing subscription's next probe (ISO 8601 UTC); absent otherwise, and on one failing since before probing existed (probed at once). */
  nextProbeAt?: string;
  /** Probes of this failing subscription so far; the wait between them doubles from 1 min to at most 1 h. */
  probeAttempts?: number;
}

/** Create/update payload. `secret` is write-only; omit on update to keep the existing one. */
export interface WebhookUpsert {
  url?: string;
  secret?: string;
  spaces?: string[];
  events?: WebhookEventType[];
  enabled?: boolean;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  spaceId: string;
  timestamp: string;
  responseStatus: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}
