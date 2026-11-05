/**
 * How the seeds of one scan batch are kept from failing one another — the one answer both background scanners
 * (`dupe-scanner.ts`, `contradiction-scanner.ts`) give (`Q-274`, `Q-358`, bundle-53 G16).
 *
 * ## The question it answers
 *
 * A scan reads a batch of records and evaluates each one (a "seed"): a vector search, a few reads, a write. Each seed has to be
 * isolated from the others, because one record with no stored vector, or one that fails every night, must not stop the scan of
 * the thousands behind it. Both scanners did that with an empty `catch` around the seed, and an empty catch is
 * exactly wrong for the one failure that is not a seed's: a timeout (a hung space, which then cost one bound PER RECORD) or a store
 * that is not answering (which then cost a connection attempt per record). The rule that separates them is the walk's
 * (`eachUnit`, `util/housekeeping-walk.ts`: an ordinary failure is reported and the loop goes on; a timeout or a store that does not
 * answer is rethrown to the walk, which ends the SPACE), and it is written once, there. This module only picks the right door to it.
 *
 *  - **In a walk** ({@link seedsInWalk}, what `runDupeScanAllSpaces` / `runContradictionScanAllSpaces` use): `eachUnit`, with the
 *    seed's TYPE as the unit's name. Not the seed's id: a space whose every seed fails the same way is one condition and one line
 *    per window (`reportSpaceFailure` throttles on step + space + unit), not five thousand.
 *  - **Outside one** ({@link seedsInRequest}, what a request for a scan of ONE space uses — `POST /api/duplicates/scan`,
 *    `POST /api/contradictions/scan`): `eachUnit` throws there, because it reports against the space being walked and a request has
 *    no walk. The failure is reported through the same reporter instead (`reportSpaceFailure` is synchronous and never throws, so
 *    it is safe in a catch) and the scan goes on, as it always did; a request carries no bound of ours (that belongs to the walk),
 *    so there is no timeout of ours to end the space.
 *
 * What it does NOT decide is which failures are a seed's expected outcome (a record not embedded yet, or merged away: a
 * `NotFoundError` from `findSimilar`). That stays in the scanner, which is the only one that knows, and it must be handled INSIDE the
 * seed's function: whatever escapes it is a failure.
 */
import { storeIsNotAnswering } from '../db/store-condition.js';
import { eachUnit } from '../util/housekeeping-walk.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import type { DegradedReason } from './degraded-reasons.js';

/** What a scan does with a seed whose neighbour search answered `degraded`: wait for the index (`hold`) or settle the seed and go on (`advance`). */
export type SeedSearchOutcome = 'hold' | 'advance';

/**
 * One decision per degraded reason, typed over the whole vocabulary: a reason added to `DEGRADED_REASONS` without a decision here does not compile,
 * so no scan is left to guess for it (the guess a forgotten spelling made was "advance", which marks the seed scanned and loses its pairs).
 */
const SEED_SEARCH_OUTCOME: Record<DegradedReason, 'hold' | 'advance'> = {
  // The only wait: an index being built over records it should serve, so the next run, once it serves, reads the same records again (`Q-326`).
  index_not_ready: 'hold',
  // An index that exists and refuses needs an operator, and a scan that waited on it would read the same records every night and stall the type
  // for ever (bundle-72 A-S8). Recall warns about the index, throttled; the scan moves on.
  index_unavailable: 'advance',
  // The rest describe a RECALL's own pipeline or budget, not an index that did not answer; a seed's search carries no deadline and no reranker,
  // so they cannot arrive from a scan's search today, and if one does, waiting for it would not make it go away.
  rerank_unavailable: 'advance',
  rerank_skipped_budget: 'advance',
  search_timeout: 'advance',
  filter_window: 'advance',
  candidate_cap: 'advance',
};

/**
 * Is the seed whose neighbour search answered `degraded` settled? The one answer both background scanners give, so neither spells the
 * decision itself: the duplicate scanner held on `degraded?.includes('index_not_ready')` by hand and the contradiction scanner read no
 * `degraded` at all, which settled every seed it met an unready index on (`Q-697`).
 *
 * The strictest reason of the answer decides: a hold anywhere holds, so a recall that was also `search_timeout` in another collection still
 * holds the seed whose collection was not ready. An answer with no `degraded` (the field is absent when nothing degraded) advances.
 */
export function seedSearchOutcome(degraded: readonly DegradedReason[] | undefined): SeedSearchOutcome {
  return degraded?.some(reason => SEED_SEARCH_OUTCOME[reason] === 'hold') ? 'hold' : 'advance';
}

/** Run `fn` over `seeds` (one batch of one type), each isolated from the others. Resolves when every seed has been asked. */
export type SeedRunner = <S>(seeds: readonly S[], fn: (seed: S) => Promise<void>, type: string) => Promise<void>;

/** The seed runner of a scan that is a unit of a walk (`eachSpace` is above it). */
export const seedsInWalk: SeedRunner = async (seeds, fn, type) => {
  await eachUnit(seeds, (seed) => fn(seed), () => type);
};

/**
 * The seed runner of a scan a request asked for: no walk above it, so a failure is reported here and the scan goes on — except a
 * failure that says the store is not answering (`storeIsNotAnswering`, `db/store-condition.ts`: the one question for code with no walk
 * above it). The next seed would wait the driver's timeout again, once per seed of the batch, while the operator waits on the request:
 * so it is reported once and RETHROWN, and the route answers it the way its door maps a store failure (`sendCaughtFailure`: 503,
 * retryable).
 */
export function seedsInRequest(step: string, spaceId: string): SeedRunner {
  return async (seeds, fn, type) => {
    for (const seed of seeds) {
      try {
        await fn(seed);
      } catch (err) {
        // The seed's own line even for a store that is not answering: it is rethrown below for the request to answer, and the line
        // names the seed that was running — so the default of `reportSpaceFailure` (a store-down stop line) is declined on purpose.
        reportSpaceFailure(step, spaceId, err, { unit: type, when: 'next scan', kind: 'space-failure' });
        if (storeIsNotAnswering(err)) throw err;
      }
    }
  };
}
