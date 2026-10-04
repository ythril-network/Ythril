/**
 * Move the space's seq counter past what a page DELIVERED, after the page's write, whatever became of the write —
 * the one post-step every door that stores a peer's page ends with (bundle-30 `R3`, `Q-224`, `Q-271`).
 *
 * ## Why the counter moves at all
 *
 * `bumpSeq`'s own words: "future local writes always get a seq higher than any document received from this peer".
 * A counter left behind a record this instance holds lets the next local edit of that record take a LOWER seq, and
 * every peer that already has the record refuses the edit as not newer.
 *
 * ## The shape, and what each hand-written copy dropped
 *
 * It was written three times — the tombstone apply, the arrival writer's per-chunk `finally`, the push door's
 * `finally` — and only the first had it right:
 *
 *  - **The bump in its own `try`.** A bump that throws out of a `finally` skips everything after it: the arrival
 *    writer's bookkeeping and embed enqueue never ran, so records that LANDED were never queued, and a re-sent page
 *    then read them as already current and never queued them either (`Q-224`).
 *  - **The original error wins.** A bump error thrown from a `finally` REPLACED the write's error and the `partial`
 *    it carried — the import then called every document refused, over records it had written.
 *  - **A counter left behind with nothing else wrong still fails the call** (`CounterBehindError`): a push door
 *    answers 500 so the sender re-sends and the re-send moves the counter (`Q-271`), a pull holds its
 *    `deliveredThrough`, an import reports the family's counter behind.
 *  - **Logged, every time**, naming the space and the seq: the operator's only sight of a counter that is behind.
 *
 * So the helper RETURNS the error rather than throwing it: the caller throws its own failure first, if it has one,
 * and this one only when it has none.
 */
import { bumpSeq } from '../util/seq.js';
import { log, logSafe, peerText } from '../util/log.js';
import { PageStoppedError } from './page-stopped.js';

/**
 * The counter could not be advanced past what a page delivered, and nothing else failed: the call must not succeed.
 * ONE class for every door — it replaced `TombstoneCounterError` and the arrival writer's planned twin.
 */
export class CounterBehindError extends PageStoppedError {
  constructor(spaceId: string, readonly seq: number, underlying: unknown) {
    super(`the seq counter of space '${spaceId}' could not be advanced to ${seq}, past what a page delivered`, spaceId, underlying);
    this.name = 'CounterBehindError';
  }
}

/**
 * Advance `spaceId`'s counter to at least `seq`. Never throws: a failure is logged (warn, the space and the seq)
 * and RETURNED, for the caller to throw only when nothing else failed — see the module docblock. `where` names the
 * door and the peer, for the log line.
 */
export async function advanceCounterPast(spaceId: string, seq: number, where: string): Promise<CounterBehindError | null> {
  if (!(seq > 0)) return null;
  try {
    await bumpSeq(spaceId, seq);
    return null;
  } catch (err) {
    log.warn(`${logSafe(where)}: the seq counter of space '${peerText(spaceId)}' could not be advanced to ${seq} `
      + `(${logSafe(err instanceof Error ? err.message : String(err))}); the page is not finished until it is, and a `
      + 'local write meanwhile could take a seq below a record this instance holds.');
    return new CounterBehindError(spaceId, seq, err);
  }
}
