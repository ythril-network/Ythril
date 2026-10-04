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
 * no wrapping in this codebase reaches (ours nest at most one level over the driver's two).
 */
const MAX_DEPTH = 4;

/** `err` and each error it wraps (`underlying` first, then `cause`), outermost first; only objects, never a repeat. */
export function errorChain(err: unknown): object[] {
  const chain: object[] = [];
  let e: unknown = err;
  while (chain.length < MAX_DEPTH && e !== null && typeof e === 'object' && !chain.includes(e)) {
    chain.push(e);
    e = (e as { underlying?: unknown }).underlying ?? (e as { cause?: unknown }).cause;
  }
  return chain;
}
