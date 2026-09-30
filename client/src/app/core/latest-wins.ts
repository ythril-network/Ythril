/**
 * Latest wins — ONE slot per piece of state that an answer writes (`Q-88`, `Q-112`).
 *
 * Starting a request through a slot cancels the one before it, so a slow answer to an earlier request can never
 * overwrite the answer to a later one — and the cancelled request stops, rather than finishing for nobody. Without
 * it, answers are applied in whatever order the server finishes them, and the LAST to arrive wins: a record tab
 * showed an old filter's rows under the new filter, and the graph drew a depth its slider no longer showed.
 *
 * **A slot is per destination, not per kind of request.** A tab's list load and its semantic search both write the
 * tab's rows, so they share one slot; two slots would let a stale list answer replace a fresh search.
 *
 * It holds the three guards a hand-written `switchMap` drops, which is why it is a module rather than a pattern:
 * - the ERROR path is routed to its own handler and never to `next`;
 * - `finally` runs when a request ends AND when it is superseded or cancelled — a loading indicator must not stay on
 *   for a request nobody is waiting for any more;
 * - given a `DestroyRef`, the pending wait and the request in flight are dropped when the owner is destroyed.
 *
 * Written first for the tab search bars inside `pages/brain/recall-hits.ts`, where only its first callers could
 * find it; the debounce (`after`) is the same one those bars wrote by hand.
 */
import type { DestroyRef } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';

export interface LatestObserver<T> {
  next: (value: T) => void;
  error?: (err: unknown) => void;
  /**
   * Runs once when this request is over for any reason: answered, failed, superseded or cancelled. `superseded` is
   * true only when a NEWER request replaced it — then whatever it would reset (a loading flag) belongs to the newer
   * one, and resetting it would switch the indicator off while the newer request is still running.
   */
  finally?: (superseded: boolean) => void;
}

export class LatestWins {
  private sub?: Subscription;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(destroyRef?: DestroyRef) {
    destroyRef?.onDestroy(() => this.cancel());
  }

  /** Run `start` once calls pause for `ms` — a new call restarts the wait. */
  after(ms: number, start: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; start(); }, ms);
  }

  /** Start `source`, cancelling whatever this slot was waiting for; only its answer reaches `observer`. */
  run<T>(source: Observable<T>, observer: ((value: T) => void) | LatestObserver<T>): void {
    this.settle(true);
    const o: LatestObserver<T> = typeof observer === 'function' ? { next: observer } : observer;
    let over = false;
    const finish = () => { if (over) return; over = true; o.finally?.(this.superseding); };
    this.sub = source.subscribe({
      next: v => o.next(v),
      error: e => { finish(); o.error?.(e); },
      complete: finish,
    });
    // Teardown runs on completion, on error and on unsubscribe — so a superseded or cancelled request finishes too.
    this.sub.add(finish);
  }

  /** Drop the pending wait and the request in flight — the input was cleared, or the owner is going away. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.settle(false);
  }

  /** Whether the request being settled right now is being replaced by a newer one (read by its `finally`). */
  private superseding = false;

  /** End the request in flight, running its `finally`. */
  private settle(superseded: boolean): void {
    const sub = this.sub;
    this.sub = undefined;
    this.superseding = superseded;
    try { sub?.unsubscribe(); } finally { this.superseding = false; }
  }
}

/** How long a search bar waits for typing to pause before it searches. */
export const INTERACTIVE_DEBOUNCE_MS = 300;
