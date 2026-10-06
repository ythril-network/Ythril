/**
 * The errors one throw carries — itself, then whatever it wraps — outermost first.
 *
 * ## Why a module
 *
 * Two questions look through a wrapper to the driver's error under it: "did a bound end this?" (`isWriteTimeout`) and
 * "is this the store's condition?" (`brain/store-failure.ts`). Our own wrappers carry the driver's error as
 * `underlying` (`ArrivalWriteError`, the counter error) and the driver nests one as `cause` (`PoolClearedError` holds
 * the network error that cleared the pool). A door that classifies only the outermost error answers a wrapped store
 * failure as the caller's fault, with the wrapper's text — so the walk is written once, here (bundle-30 I12).
 *
 * ## The part a hand-written copy drops
 *
 * The bound and the cycle check. A `cause` that points back at an error already seen (or at itself) would loop for
 * ever inside a `catch`, which is the one place nothing else can recover it; the walk stops at a repeat and at a depth
 * no wrapping in this codebase reaches (ours nest at most one level over the driver's three: a bulk wrapper, the
 * error it wraps, and that error's `cause`).
 *
 * ## The driver's third way of wrapping, which is neither (bundle-30 I14, verify-drive-4 D1)
 *
 * When anything is thrown under a bulk write (`insertMany`, `bulkWrite`) — a failed server selection, a dropped
 * connection, a driver refusal — the driver rethrows it as `new MongoBulkWriteError(thrown, result)`
 * (`bulk/common.js`). That keeps the thrown error as the wrapper's `errorResponse`, NOT as `cause`, and copies its
 * own fields over the wrapper — its text, and its labels if it had any, but not its class. A server's own error
 * response is a plain document, so an `errorResponse` that is an `Error` is the driver saying "this is what was
 * thrown", and the walk follows it. Unfollowed, a paused store reached every classifier as a `MongoServerError` with
 * no code and no label: "the server refused the caller", answered `400` with the store's address.
 *
 * ## An `AggregateError` is every error it holds (bundle-53 G1)
 *
 * A step that runs over several units and reports them together (the config reload, over every space) throws one
 * `AggregateError` whose `errors` are the units' failures. Read as ONE error, its class says nothing, and a store that
 * had gone away under one unit was answered as an internal fault of ours. Its members are walked — breadth first, so
 * the chain stays outermost first — and a question asked of the chain ("is any of these the store's?") is true when
 * any member is.
 */
const MAX_DEPTH = 5;
/**
 * The most errors one chain holds. An aggregate has one member per failed unit, so depth alone does not bound it: a
 * reload over a thousand spaces would otherwise be a thousand-entry list inside a `catch`.
 */
const MAX_MEMBERS = 256;

/**
 * Is this the driver's wrapper around an error that was THROWN, rather than an error the server answered with? Then
 * the wrapper's class says nothing — the error it wraps is what happened (see the module docblock).
 */
export function wrapsAThrownError(e: object): boolean {
  return (e as { errorResponse?: unknown }).errorResponse instanceof Error;
}

/** What one error directly wraps: its one wrapped error (`underlying`, then `cause`, then a driver wrapper's thrown error), and an aggregate's members. */
function wrappedBy(e: object): unknown[] {
  const wrapped = e as { underlying?: unknown; cause?: unknown; errorResponse?: unknown };
  const one = wrapped.underlying ?? wrapped.cause ?? (wrapsAThrownError(e) ? wrapped.errorResponse : undefined);
  return e instanceof AggregateError && Array.isArray(e.errors) ? [one, ...e.errors] : [one];
}

/**
 * `err` and each error it wraps (`underlying`, then `cause`, then a driver wrapper's thrown error, and every member of an
 * `AggregateError`), outermost first.
 */
export function errorChain(err: unknown): object[] {
  const chain: object[] = [];
  const seen = new Set<object>();
  let level: unknown[] = [err];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const e of level) {
      if (e === null || typeof e !== 'object' || seen.has(e) || chain.length >= MAX_MEMBERS) continue;
      seen.add(e);
      chain.push(e);
      next.push(...wrappedBy(e));
    }
    level = next;
  }
  return chain;
}
