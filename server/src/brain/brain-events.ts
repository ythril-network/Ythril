/**
 * In-process brain-change event bus (F12 — live updates).
 *
 * A pure leaf (only `node:events`, no brain/webhook imports) so the webhook dispatcher can publish to
 * it without creating an import cycle. Every brain write already funnels through `emitWebhookEvent`
 * (webhooks/dispatcher.ts), which now also calls `publishBrainChange` here; the per-space SSE endpoint
 * subscribes and fans each change out to connected browsers. This is process-local — it drives live UI
 * on the instance that made the write; cross-instance propagation is the sync layer's job, and a synced
 * write lands as a normal local write on the peer, which re-publishes here.
 */
import { EventEmitter } from 'node:events';

/** Shape published on every brain mutation. `event` is a `WebhookEventType`; `entry` is the record (or summary). */
export interface BrainChangeEvent {
  event: string;
  spaceId: string;
  entry: Record<string, unknown>;
}

const _emitter = new EventEmitter();
// SSE fans out to many concurrent browser tabs, so the default 10-listener warning would fire on a normal day.
// Lifted rather than removed: the COUNT is bounded where a listener is added — `util/sse-stream.ts` refuses a
// stream past `MAX_SSE_CONNECTIONS` — so this is no longer the only thing between a caller and unbounded listeners.
_emitter.setMaxListeners(0);

/** Publish a brain change to in-process subscribers. Fire-and-forget; a bad subscriber never breaks a write. */
export function publishBrainChange(ev: BrainChangeEvent): void {
  try {
    _emitter.emit('change', ev);
  } catch {
    /* a listener throwing must never propagate into the write path */
  }
}

/** Subscribe to changes for a single space. Returns an unsubscribe function. */
export function subscribeBrainChanges(spaceId: string, listener: (ev: BrainChangeEvent) => void): () => void {
  const handler = (ev: BrainChangeEvent): void => {
    if (ev.spaceId === spaceId) {
      try { listener(ev); } catch { /* isolate one subscriber's failure from the others */ }
    }
  };
  _emitter.on('change', handler);
  return () => { _emitter.off('change', handler); };
}
