/**
 * "Once the server is LISTENING" — the one place that question is answered.
 *
 * ## Why a module
 *
 * The configured instance's services start before the server listens (`startConfiguredInstanceServices` runs in
 * `index.ts` ahead of `server.listen`), and the setup route runs them after it. Work that must not compete with the
 * boot — a scan of every space, an index build that is not needed to serve — needs to wait for the listen when the
 * process is booting and must NOT wait when it is not: a first-run instance that has just been configured is already
 * listening and would otherwise hold the work for a mark that never comes again.
 *
 * ## What it guarantees
 *
 * `afterListening(work)` holds `work` until `markListening()` and runs it at once afterwards, so the same call serves
 * both callers. The listen callback marks it. Work runs in the order it was handed over; one that throws or rejects is
 * logged and never stops the work after it or surfaces as an unhandled rejection — it is background work, and a boot
 * that crashed over a scan would be the cost of asking for one.
 */
import { log } from './log.js';

let listening = false;
const held: Array<() => unknown> = [];

function run(work: () => unknown): void {
  const failed = (err: unknown): void => { log.error(`Work started once the server listens failed: ${err instanceof Error ? err.message : String(err)}`); };
  try {
    const result = work();
    if (result && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(undefined, failed);
  } catch (err) {
    failed(err);
  }
}

/** Run `work` once the server listens: at once when it already does, else when `markListening` is called. */
export function afterListening(work: () => unknown): void {
  if (listening) run(work);
  else held.push(work);
}

/** The server is listening: release what was held, in order. Idempotent. */
export function markListening(): void {
  if (listening) return;
  listening = true;
  for (const work of held.splice(0)) run(work);
}
