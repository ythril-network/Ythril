/**
 * In-process brain-change event bus (F12 — live updates).
 *
 * A pure leaf (only `node:events`, no brain/webhook imports) so the webhook dispatcher can publish to
 * it without creating an import cycle. `emitWebhookEvent` (webhooks/dispatcher.ts) also calls
 * `publishBrainChange` here; the per-space SSE endpoint subscribes and fans each change out to
 * connected browsers.
 *
 * **One rule decides whether a write is published, and it is the same for the brain and the file family:
 * `if (actor) emitWebhookEvent(...)`.** A write a user made — the surfaces a person uses (REST, MCP) hand the
 * writer an actor — emits, and `emitWebhookEvent` is one function, so it is a webhook AND a bus event. A write
 * no user made — a record or a file that ARRIVED by sync (push or pull, bytes included), an import, housekeeping
 * — passes no actor and emits neither. So a synced write is NOT re-published here: this bus drives live UI on
 * the instance whose user made the write, and the peer's open page learns of it on its next load. Cross-instance
 * propagation is the sync layer's job, and the dispatcher is not split into a bus half and a webhook half: two
 * rules for one question would be the defect this repository produces most. (The rule is about a WRITE. The few
 * events that are a system's own report rather than someone's write — `duplicate.detected`, `change_note.received`,
 * `link_violation.created` — have no actor to give and are emitted without one on purpose.)
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
