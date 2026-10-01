/**
 * Ask again on a delay until an answer says stop — through failed requests and hidden tabs.
 *
 * ## Why this is a module
 *
 * The client had the same chain written by hand more than once — a `setTimeout`, a request, a decision whether to go
 * on — and each copy dropped a different guard. The reindex poll (`Q-99` part 2) was first written so that ONE failed
 * request ended the chain: the run went on, the page never heard, and both Reindex buttons stayed held until a
 * reload. The Spaces list's index poll had the guards and nobody else could reach them.
 *
 * So the forgettable parts live here, where a caller cannot leave them out:
 * - **a failed request schedules the next one**, it never ends the chain — a blip is not the end of the work;
 * - **a hidden tab skips the request but keeps the schedule**, so a background tab costs nothing and the poll resumes
 *   the moment it is looked at, with no visibility listener to leak;
 * - **`stop()` also drops an answer still in flight**, so a poll stopped by a space switch cannot write the old
 *   space's answer into the new one;
 * - **the delay is read for every tick**, so a caller can slow down (a search service that is merely late) without
 *   restarting the poll.
 *
 * It answers one question: "keep asking until told to stop". A fixed refresh that never stops (a badge every minute)
 * is a different question and does not belong here.
 */
import type { Observable, Subscription } from 'rxjs';

export interface PollUntilOptions<T> {
  /** Milliseconds before the next ask, read before every tick. */
  delayMs: () => number;
  /** The request one tick makes. */
  request: () => Observable<T>;
  /** Take the answer; return true to ask again, false to stop. Not called for a failed request. */
  onAnswer: (value: T) => boolean;
}

export interface PollHandle {
  /** Cancel the next tick and ignore any answer still in flight. Safe to call more than once. */
  stop(): void;
  /** True until the poll has stopped, by its own answer or by `stop()`. */
  readonly active: boolean;
}

export function pollUntil<T>(opts: PollUntilOptions<T>): PollHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Subscription | undefined;
  let active = true;

  const schedule = (): void => {
    if (!active) return;
    timer = setTimeout(tick, opts.delayMs());
  };

  const tick = (): void => {
    timer = undefined;
    if (!active) return;
    if (typeof document !== 'undefined' && document.hidden) { schedule(); return; }
    inFlight = opts.request().subscribe({
      next: (value) => {
        if (!active) return;
        if (opts.onAnswer(value)) schedule();
        else stop();
      },
      error: () => schedule(),
    });
  };

  const stop = (): void => {
    active = false;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    inFlight?.unsubscribe();
    inFlight = undefined;
  };

  schedule();
  return { stop, get active() { return active; } };
}
