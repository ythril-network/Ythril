/**
 * End the WAIT for work that cannot be cancelled — a file-system call, a ping, a whole sync cycle — after a stated time. The work
 * itself goes on; only the caller stops waiting for it.
 *
 * ## Why one module
 *
 * The race was written three times (the readiness probe's ping, the synchronous sync trigger, and the space acts' file-tree steps),
 * and the part each copy has to get right is the part that is easy to drop: CLEARING the timer when the work wins. A copy that forgets
 * it keeps the event loop busy for the whole bound on every call that succeeded. A second part is easy to drop too: a promise that
 * outlives its bound must not leave an unhandled rejection behind when it finally fails. Both are here, and a caller cannot leave them
 * out.
 *
 * ## What it does not do
 *
 * It does not stop the work. A file-system call cannot be cancelled, so a stuck mount leaves one orphaned promise; `withinFsBound` says
 * so once per step, never per call.
 */
import { log, peerText } from './log.js';
import { warnOnce } from './warn-once.js';

/** The bound ended the wait. `ms` is the bound that did it, so a caller can say which. */
export class TimeBoundEnded extends Error {
  override readonly name = 'TimeBoundEnded';
  constructor(readonly what: string, readonly ms: number) {
    super(`${what} did not finish within ${ms}ms`);
  }
}

/** True when `err` is a {@link TimeBoundEnded}, across module instances too. */
export function isTimeBoundEnded(err: unknown): err is TimeBoundEnded {
  return err instanceof TimeBoundEnded || (err instanceof Error && err.name === 'TimeBoundEnded');
}

/**
 * Wait for `work` at most `ms`: its value or its rejection when it settles first, else a {@link TimeBoundEnded} naming `what`.
 * `onOrphan` runs when the bound won, so the caller can say the work is still running somewhere.
 */
export async function withinTimeBound<T>(work: Promise<T>, ms: number, what: string, onOrphan?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeBoundEnded(what, ms)), ms);
  });
  try {
    return await Promise.race([work, ended]);
  } catch (err) {
    if (isTimeBoundEnded(err)) {
      // The orphan may still fail later: that failure is nobody's to answer, and must not surface as an unhandled rejection.
      work.catch(() => { /* answered by the bound already */ });
      onOrphan?.();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** What waiting for work at most `ms` came to: its value, or that the wait ended first (the work goes on). */
export type SettledWithin<T> = { finished: true; value: T } | { finished: false };

/**
 * Wait for `work` at most `ms` and SAY whether it finished — the answering sibling of {@link withinTimeBound}, which REJECTS when the bound
 * ends. For a caller whose late work is an answer ("still running", "queued", "still loading") and not an error. A rejection of `work` before
 * the bound is still the caller's; one after it is nobody's and never surfaces as an unhandled rejection.
 *
 * What it prevents: a door's wait for its space acts, the model verifier's probe and the webhook drain each wrote this race by hand, and
 * the half each copy had to get right is the one easy to drop — clearing the timer when the work wins (a copy that forgot kept the loop
 * busy for the whole bound on every call that succeeded) and handling the work's own late failure.
 *
 * The timer holds the loop, like any wait a caller is awaiting: a bound that is not allowed to hold the process open (the metrics scrape's
 * budget, `metrics/registry.ts`) is a different question and keeps its own.
 */
export async function settledWithin<T>(work: Promise<T>, ms: number): Promise<SettledWithin<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); });
  const outcome = work.then(value => ({ value }));
  try {
    const first = await Promise.race([outcome, late]);
    if (first === null) {
      outcome.catch(() => { /* the bound answered already */ });
      return { finished: false };
    }
    return { finished: true, value: first.value };
  } finally {
    clearTimeout(timer);
  }
}

const orphanSaid = warnOnce<string>({ every: 10 * 60_000 });

/**
 * One file-system step of `what`, waited for at most `ms`. A step the bound ended leaves its call running (a file-system call cannot be
 * cancelled) and says so once per `what` and window; the caller sees {@link TimeBoundEnded} and treats the step as failed.
 */
export function withinFsBound<T>(fn: () => Promise<T>, ms: number, what: string): Promise<T> {
  let work: Promise<T>;
  try { work = fn(); } catch (err) { return Promise.reject(err); }
  return withinTimeBound(work, ms, what, () => orphanSaid(what, () =>
    log.warn(`${peerText(what)} did not return within ${ms}ms; it is left running and the step counts as failed`)));
}
