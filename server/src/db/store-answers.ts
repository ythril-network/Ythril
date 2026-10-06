/**
 * Does the store answer at all? — the question that tells a hung SPACE from a dead STORE (`Q-274`, bundle-53 G8).
 *
 * ## What it is for
 *
 * A housekeeping walk whose operation timed out cannot tell from the error whether that one space hung (a lock, a runaway scan:
 * the store is fine, and the other spaces should still be walked) or the store stopped answering (every space will time out, and
 * a walk that carries on pays one bound per space). `walkVerdict` (`util/space-failure.ts`) asks this once, and a store that does
 * not answer ends the walk at the first timeout.
 *
 * ## What a hand-written ping drops
 *
 * **Its own bound.** A ping against a store that stopped answering waits for server selection once the pool has cleared: 54 s
 * measured (probe P6). With `timeoutMS` it settles in ~3 s in every phase — socket read, checkout, selection — and always as
 * `MongoOperationTimeoutError`. A walk that stops at the first timeout must not spend a second bound finding out it should.
 * **The memo.** Asked from a `catch`, it would be asked per failed record; it is answered from the last answer for 10 s
 * (`util/cached-probe.ts`: also never throws, and shared by callers that arrive while it is in flight).
 *
 * ## Why the raw client and not `getDb()`
 *
 * The ping goes to the `admin` database of the raw client, deliberately outside `getDb()`: a ping carries its own `timeoutMS`,
 * and a housekeeping scope's bound laid over a ping about the bound would be a bound about itself. It is not a space's data
 * and reaches no collection. It lives here and not in `db/mongo.ts` so that the connection module has one owner.
 *
 * A client that is not connected yet is `false`: there is no store to ask, which is the answer.
 */
import type { MongoClient } from 'mongodb';
import { cachedProbe, type ProbeCache } from '../util/cached-probe.js';
import { getMongo } from './mongo.js';

/** How long the ping may take, ms. Past it the store does not answer. */
export const STORE_PING_MS = 3_000;
/** How long an answer — either — is reused, ms. */
export const STORE_ANSWERS_TTL_MS = 10_000;

const MEMO_KEY = 'store';

/**
 * `storeAnswers` over a client and a probe cache of your own, for a test that has no store. The module's `storeAnswers` is this
 * over the real client and the process-wide cache.
 */
export function createStoreAnswers(
  { client, cache }: { client: () => Pick<MongoClient, 'db'>; cache?: Pick<ProbeCache, 'probe'> },
): (ms?: number) => Promise<boolean> {
  const probe = cache ? cache.probe.bind(cache) : cachedProbe;
  return (ms = STORE_PING_MS) => probe(MEMO_KEY, STORE_ANSWERS_TTL_MS, async () => {
    await client().db('admin').command({ ping: 1 }, { timeoutMS: ms });
    return true;
  });
}

/**
 * Does the store answer a ping inside `ms` (3 s)? Memoised for 10 s, false when it does not or when there is no client, and
 * NEVER throws.
 */
export const storeAnswers: (ms?: number) => Promise<boolean> = createStoreAnswers({ client: getMongo });
