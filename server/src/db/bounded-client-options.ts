/**
 * The options of a MongoClient that work inside a bound scope opens on its own: the liveness figures every client takes
 * (`client-options.ts`), and the active scope's per-operation bound as the client's socket timeout (bundle-157 slice I4a; `Q-716`).
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
 * Inside a scope the client carries `socketTimeoutMS` = the scope's per-operation figure ({@link boundOperationMs}) plus the write
 * bound's backstop margin, lowered to a `socketTimeoutMS` the connection string itself names; outside any scope it carries none, as
 * such a client always did (a scheduled backup is not inside an act). A wait on the socket longer than that ends the operation with
 * a `MongoNetworkTimeoutError` and CLOSES the connection it was on (probed, driver 7.8.0), which the store-failure classification
 * reads as the store not answering, so a body rethrows it and the runner retries it as an outage.
 *
 * It is a socket wait, so it bounds each batch of a cursor read and not the whole read, which a large collection would outlast. With
 * the driver's retryable reads and writes, one call can wait about twice the figure before it fails (the retry's own wait).
 *
 * It was the driver's client-side `timeoutMS` until `Q-716`: that desynchronised the connection pool after a timeout on drivers
 * before 7.8.0 (CVE-2026-119179) and does nothing from 7.8.0 on.
 *
 * What it does NOT promise: that a write ended this way cannot land later. The client's clock, not the server's, ends it
 * (`write-bound.ts` says why the one door orders it the other way round). A body that opens such a client is therefore one whose retry
 * replaces what it wrote - a migrate drops and reloads every collection of its target - and says so where it opens it.
 */
import { mongoClientOptions, uriQueryOptions, type CallerDefaults, type ClientLivenessOptions } from './client-options.js';
import { SERVER_FIRST_MARGIN_MS, boundOperationMs } from './write-bound.js';

/** The options for `new MongoClient(uri, …)` opened inside (or outside) a bound scope. A fresh object each call. */
export function boundedClientOptions(uri: string, callerDefaults: CallerDefaults = {}): Partial<ClientLivenessOptions> & { socketTimeoutMS?: number } {
  const options = mongoClientOptions(uri, callerDefaults);
  const bound = boundOperationMs();
  if (bound === undefined) return options;
  const figure = bound + SERVER_FIRST_MARGIN_MS;
  const named = Number(uriQueryOptions(uri).get('sockettimeoutms'));
  return { ...options, socketTimeoutMS: Number.isFinite(named) && named > 0 ? Math.min(named, figure) : figure };
}

/**
 * Close a client opened on its own (a dump's, a restore's, a migrate's target client), waiting at most one bound for it: the active
 * scope's per-operation figure, else the client's own `socketTimeoutMS`, else its `connectTimeoutMS`. Never throws.
 *
 * ## What it prevents (Q-564)
 *
 * `MongoClient.close()` ends the client's sessions on the server before it lets go, and that command carries no bound: against a target
 * that had stopped answering it took 25.5 s at an operation bound of 1.5 s, awaited in the `finally` of the act's body, so a migrate's
 * attempt could not end - and could not be abandoned - until it did. Past the figure the close is left to finish in the background
 * (the driver squashes its failure) and the caller goes on; nothing it closes is used again. Every act body's client closes through
 * here, so the restore's close and the migrate's cannot differ.
 */
export async function closeWithinBound(client: { close(): Promise<void>; readonly options?: { connectTimeoutMS?: number; socketTimeoutMS?: number } }): Promise<void> {
  const socket = client.options?.socketTimeoutMS;
  const ms = boundOperationMs() ?? (typeof socket === 'number' && socket > 0 ? socket : undefined)
    ?? client.options?.connectTimeoutMS ?? 10_000;
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); });
  try {
    await Promise.race([client.close().catch(() => { /* the close's own failure: nothing is left to undo */ }), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}
