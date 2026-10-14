/**
 * Let whatever is waiting on the event loop run before this continues — the one spelling of "yield a turn".
 *
 * ## What it prevents
 *
 * A long pass (a sweep over a space, an at-rest migration, a worker loop, a burst being batched) that never gives the loop
 * a turn starves every request, sync pull and timer queued behind it. The fix is one line, and it was written as that one
 * line four times (`brain/suppression-sweep.ts`, `files/at-rest-migration.ts`, `files/media/slot-pool.ts`,
 * `webhooks/dispatcher.ts`), each choosing its own primitive. They happened to agree. The next one need not, and the wrong
 * choice does not fail — it just stops yielding:
 *
 * - `await Promise.resolve()` / `queueMicrotask` / `process.nextTick` run BEFORE pending I/O. They yield to other promise
 *   callbacks and to nothing that is waiting on a socket or a file, so a loop of them starves I/O exactly as before.
 * - `setTimeout(r, 0)` is clamped to at least 1 ms and runs in the timers phase, so a loop of them is slower for nothing
 *   and orders differently against I/O callbacks.
 *
 * ## What is inside, so no caller can drop it
 *
 * The primitive: `setImmediate`, which resolves in the check phase — after the I/O callbacks that were pending when it was
 * called, before the next timers. That is the only one of the four that lets an upload, a sync pull or a request in.
 *
 * One question. A DEFERRAL — `setImmediate(() => { void run(); })`, scheduling work for later without awaiting it — is a
 * different question (it does not pause the caller) and is not spelled through here.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}
