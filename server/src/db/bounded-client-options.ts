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

/**
 * Close a client opened on its own (a dump's, a restore's, a migrate's target client), waiting at most one bound for it: the active
 * scope's per-operation figure, else the client's own `timeoutMS`, else its `connectTimeoutMS`. Never throws.
 *
 * ## What it prevents (Q-564)
 *
 * `MongoClient.close()` ends the client's sessions on the server before it lets go, and that command carries no bound: against a target
 * that had stopped answering it took 25.5 s at an operation bound of 1.5 s, awaited in the `finally` of the act's body, so a migrate's
 * attempt could not end - and could not be abandoned - until it did. Past the figure the close is left to finish in the background
 * (the driver squashes its failure) and the caller goes on; nothing it closes is used again. Every act body's client closes through
 * here, so the restore's close and the migrate's cannot differ.
 */
export async function closeWithinBound(client: { close(): Promise<void>; readonly timeoutMS?: number; readonly options?: { connectTimeoutMS?: number } }): Promise<void> {
  const ms = boundOperationMs() ?? (typeof client.timeoutMS === 'number' && client.timeoutMS > 0 ? client.timeoutMS : undefined)
    ?? client.options?.connectTimeoutMS ?? 10_000;
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); });
  try {
    await Promise.race([client.close().catch(() => { /* the close's own failure: nothing is left to undo */ }), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

/** A cursor's options on a client of {@link boundedClientOptions}: each batch bounded when the client carries a figure, else none. */
export function perBatchTimeout(client: { readonly timeoutMS?: number }): { timeoutMode?: 'iteration' } {
  return typeof client.timeoutMS === 'number' && client.timeoutMS > 0 ? { timeoutMode: 'iteration' } : {};
}
