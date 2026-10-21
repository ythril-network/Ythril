/**
 * The options of a MongoClient that work inside a bound scope opens on its own: the liveness figures every client takes
 * (`client-options.ts`), and the active scope's per-operation bound as the client's `timeoutMS` (bundle-157 slice I4a).
 *
 * ## What it prevents
 *
 * The bound of a scope (`write-bound.ts`: `withinHousekeepingBound`, the space-act runner's body) reaches an operation through the one
 * door, `getDb()`. A client opened on its own - a migrate's dump of this database, its restore into the new URI, the index copy onto
 * it - is not behind that door, so its operations carried no bound at all: one insert the target never answered held the migrate's
 * act, every space's hold and maintenance for as long as the socket stayed open, and the runner never saw a failure to retry.
 *
 * ## The rule
 *
 * Inside a scope the client carries `timeoutMS` = the scope's per-operation figure ({@link boundOperationMs}), lowered to a `timeoutMS`
 * the connection string itself names; outside any scope it carries none, as such a client always did (a scheduled backup is not inside
 * an act). The driver ends an operation at that figure with a `MongoOperationTimeoutError`, which the store-failure classification
 * reads as the store's timeout, so a body rethrows it and the runner retries it as an outage.
 *
 * What it does NOT promise: that a write ended this way cannot land later. The client's clock, not the server's, ends it
 * (`write-bound.ts` says why the one door orders it the other way round). A body that opens such a client is therefore one whose retry
 * replaces what it wrote - a migrate drops and reloads every collection of its target - and says so where it opens it.
 *
 * A cursor read across many batches takes {@link perBatchTimeout} as its options, so the figure bounds each batch and not the
 * whole read (the driver's default for a client `timeoutMS` is the cursor's whole lifetime, which a large collection would outlast).
 */
import { mongoClientOptions, uriQueryOptions, type CallerDefaults, type ClientLivenessOptions } from './client-options.js';
import { boundOperationMs } from './write-bound.js';

/** The options for `new MongoClient(uri, …)` opened inside (or outside) a bound scope. A fresh object each call. */
export function boundedClientOptions(uri: string, callerDefaults: CallerDefaults = {}): Partial<ClientLivenessOptions> & { timeoutMS?: number } {
  const options = mongoClientOptions(uri, callerDefaults);
  const bound = boundOperationMs();
  if (bound === undefined) return options;
  const named = Number(uriQueryOptions(uri).get('timeoutms'));
  return { ...options, timeoutMS: Number.isFinite(named) && named > 0 ? Math.min(named, bound) : bound };
}

/** A cursor's options on a client of {@link boundedClientOptions}: each batch bounded when the client carries a figure, else none. */
export function perBatchTimeout(client: { readonly timeoutMS?: number }): { timeoutMode?: 'iteration' } {
  return typeof client.timeoutMS === 'number' && client.timeoutMS > 0 ? { timeoutMode: 'iteration' } : {};
}
