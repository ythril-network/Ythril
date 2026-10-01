/**
 * Make a REAL database's search look absent, then bring it back — for the `-db` tests about a late mongot (Q-113).
 *
 * ## Why this is a module, and why it patches the driver rather than the server
 *
 * The behaviour under test is what the server does when mongot is not answering yet and later does. A scratch
 * atlas-local always answers, so the outage has to be simulated; and it has to be simulated BELOW the code under
 * test, or the test asserts that the code equals itself. The one thing every readiness probe has in common, the
 * cold-start window's, the watcher's and `/ready`'s, is `collection.listSearchIndexes()` on a collection whose
 * name starts with an underscore (`_vectorsearch_probe`, `_ready_probe`). A space's collections never do. So
 * while the outage is on, that one call on those collections throws what a refused mongot throws; every other
 * call, including a space's own `listSearchIndexes`, goes to the real database untouched.
 *
 * Nothing here knows the name of a server module or an injection point: the production singleton is exercised
 * exactly as it runs.
 *
 * ## The cold window, sped up
 *
 * The cold-start window is 5 sleeps of 2 s. A test that goes through it several times should not spend a minute
 * there, so `setTimeout(fn, 2000)` alone is shortened to 5 ms. Every other delay (the watcher's, the probe
 * timeout) is left as production has it, so the heal is still the watcher's own schedule.
 */

/** What a refused mongot throws, by class and code, with a message that must never reach a log. */
export const outageError = () => Object.assign(
  new Error('connect ECONNREFUSED mongodb://ythril:hunter2@mongot.internal:27027 (test outage)'),
  { name: 'MongoServerSelectionError', code: 'ECONNREFUSED' });

/**
 * @param mongo the live `db/mongo.js` namespace (from `openTestMongo`)
 * @returns controls: `setDown(bool)`, `flipAfterMicrotasks(n)`, `calls(method, collection?)`, `restore()`
 */
export function installSearchOutage(mongo, { instantAnswers = false } = {}) {
  // `instantAnswers`: while NOT down, a readiness probe (an underscore collection) is answered at once with an empty
  // list instead of asking the real database. A test about what the server does WITH a successful probe must not
  // depend on how fast a cold mongot on a shared CI runner answers it: `/ready` times its probe out at 2 s, and the
  // same test went red in CI on exactly that, with the code under test correct.
  const proto = Object.getPrototypeOf(mongo.getMongo().db().collection('_outage_probe'));
  const realList = proto.listSearchIndexes;
  const realFindOne = proto.findOne;
  const realSetTimeout = globalThis.setTimeout;
  const log = [];
  let down = false;
  let flip = null;
  let failuresThisOutage = 0;

  proto.listSearchIndexes = function patchedList(...args) {
    log.push({ method: 'listSearchIndexes', collection: this.collectionName });
    if (down && this.collectionName.startsWith('_')) {
      failuresThisOutage++;
      const err = outageError();
      const cursor = {
        toArray: () => {
          if (flip && failuresThisOutage === flip.afterFailure) {
            // The service comes back `depth` microtasks after this probe's failure was delivered — the knob a race
            // test turns to land a flip between two steps of the code under test.
            const { depth, run } = flip; flip = null;
            down = false;
            let k = depth;
            const tick = () => { if (k-- > 0) queueMicrotask(tick); else run(); };
            queueMicrotask(tick);
          }
          return Promise.reject(err);
        },
      };
      return cursor;
    }
    if (instantAnswers && this.collectionName.startsWith('_')) return { toArray: async () => [] };
    return realList.apply(this, args);
  };
  proto.findOne = function patchedFindOne(...args) {
    log.push({ method: 'findOne', collection: this.collectionName });
    return realFindOne.apply(this, args);
  };
  globalThis.setTimeout = function fastCold(fn, ms, ...rest) {
    return realSetTimeout(fn, ms === 2000 ? 5 : ms, ...rest);
  };

  return {
    setDown(value) { down = value; if (value) failuresThisOutage = 0; },
    /** When the N-th failed probe of this outage is delivered, bring the service back `depth` microtasks later and call `run`. */
    flipAfter(afterFailure, depth, run) { flip = { afterFailure, depth, run }; },
    calls: (method, collection) => log.filter(c => c.method === method && (collection === undefined || c.collection === collection)).length,
    restore() {
      proto.listSearchIndexes = realList;
      proto.findOne = realFindOne;
      globalThis.setTimeout = realSetTimeout;
    },
  };
}
