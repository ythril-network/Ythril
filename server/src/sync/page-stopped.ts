/**
 * A page of arrivals that could not be finished — the one shape every "the writer stopped part-way" error takes.
 *
 * ## Why a base class (bundle-30 I6, `C6`)
 *
 * Two errors say it: `ArrivalWriteError` (a record write the store could not do for reasons that are not one
 * document's) and `CounterBehindError` (the counter could not be moved past what the page delivered). They were
 * written as twins — the same `spaceId`, `underlying` and `partial` — so a caller that reports per document had to
 * name both, and a third would have been a third `instanceof` to forget. A caller asks this class instead: what had
 * the writer done when it stopped (`partial`), and what stopped it (`underlying`, which `isWriteTimeout` looks
 * through).
 */
import type { ArrivalOutcome } from './arrivals.js';

export abstract class PageStoppedError extends Error {
  /**
   * What the arrival writer had already done when it stopped: earlier chunks are committed (and bumped and queued)
   * before a later one fails, so a caller reporting per document must not call them refused. Set by `writeArrivals`;
   * absent where no arrival writer ran (a tombstone page).
   */
  partial?: ArrivalOutcome;
  protected constructor(message: string, readonly spaceId: string, readonly underlying: unknown) {
    super(`${message}: ${underlying instanceof Error ? underlying.message : String(underlying)}`);
  }
}
