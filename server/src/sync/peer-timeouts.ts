/**
 * How long this instance waits for a PEER — the two budgets every outbound sync request is given.
 *
 * Moved out of `sync/engine.ts` (bundle-30) because a second module needs the push budget: a seq hold on the
 * RECEIVING side must end inside the time the sender waits for its answer (`db/write-bound.ts` derives its hold
 * deadline from `BATCH_FETCH_TIMEOUT_MS`). Two literals, 60 000 here and 45 000 there, would be two copies of one
 * relation, and the day one moved the receiver would answer a push the sender had already given up on — so the
 * sender re-sends a page while the first is still holding the receiver's horizon.
 */

/**
 * Timeout for every outbound fetch to a peer. Without it the OS TCP timeout (~75 s on Linux) applies, so one
 * offline peer could block an entire sync cycle by that much per attempt.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * The longer budget for batch push and pull payloads: 200 documents of a few KB each can be several hundred KB
 * over a slow WAN link. The receiver's hold deadline is derived from it, so a stalled push answers before this ends.
 */
export const BATCH_FETCH_TIMEOUT_MS = 60_000;
