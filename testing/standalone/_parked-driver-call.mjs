/**
 * Park ONE call of a driver method on one of a space's collections, at the instant a test chooses — the question "what does
 * everything else do while this write is half-way through", answered once for every test that asks it (bundle-44 D-29, Q-436).
 *
 * ## Why a module
 *
 * The claim fence is about an interleaving, and an interleaving is a fact of ORDER: a delete that lands between a derived
 * write's fence and its row, or between a delete's own child removal and its flag. A test that sets it up with a sleep tests
 * the machine's speed. This parks the call on a latch the test holds, tells the test when the call has REACHED the point
 * (`reached`), and lets it go when the test says so (`release`), so "the writer is inside its transaction" is a thing the test
 * waits for and not a thing it hopes for.
 *
 * ## What a hand-written copy drops
 *
 * **The restore.** The patch is on the driver's `Collection` prototype and so reaches every collection of the process; one that
 * is left in place after a failed assertion parks the next test's call for ever. `release` and `restore` both put the original
 * back, and the call is armed ONCE: only the first call that matches is parked, so the retry a transaction makes after a write
 * conflict is not caught in a gate nobody will open.
 *
 * `before: true` parks BEFORE the call runs (the call has not touched the store); otherwise AFTER it ran and before it returns
 * (the write has landed, and for a session's write has not committed).
 *
 * @param {object} mongo  the harness's `db/mongo.js` module (`door.mongo`)
 * @param {string} space
 * @param {string} suffix  the collection's suffix: `files`, `media_jobs`...
 * @param {string} method  the driver method: `updateOne`, `replaceOne`, `deleteOne`...
 * @param {(...args: unknown[]) => boolean} match  which call to park, by its arguments
 * @param {{ before?: boolean }} [o]
 * @returns {{ reached: Promise<void>, release: () => void, restore: () => void }}
 */
export function parkDriverCall(mongo, space, suffix, method, match, { before = false } = {}) {
  const proto = Object.getPrototypeOf(mongo.col('probe'));
  const original = proto[method];
  let release;
  const gate = new Promise(r => { release = r; });
  let reachedResolve;
  const reached = new Promise(r => { reachedResolve = r; });
  let armed = true;
  const restore = () => { if (proto[method] !== original) proto[method] = original; };
  proto[method] = async function parked(...args) {
    if (armed && this.collectionName === `${space}_${suffix}` && match(...args)) {
      armed = false;
      if (before) { reachedResolve(); await gate; return original.apply(this, args); }
      const result = await original.apply(this, args);
      reachedResolve();
      await gate;
      return result;
    }
    return original.apply(this, args);
  };
  return { reached, release: () => { release(); restore(); }, restore };
}
