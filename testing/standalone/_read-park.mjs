/**
 * Park a READ after it has answered, so the code that asked holds a snapshot while the world moves on — the question
 * "what does this code do with a read that is stale by the time it writes", answered once for every -db test that asks it.
 *
 * ## Why a module, and why it is not `parkWrites`
 *
 * `parkWrites` (`_write-faults.mjs`) holds a WRITE before it reaches the driver. A publish that reads a collection and
 * then writes what the read told it is raced differently: the read must have RUN (so it reports the state of that
 * moment) and only then wait, with every other writer free to go past it. A park placed before the read lets the read
 * see the later state, so the stale-snapshot case vanishes and the test passes on the code that has the defect — the
 * vet found exactly that for the one-tombstone-per-path race (bundle-71, T5(a)).
 *
 * ## The part a hand-written copy drops
 *
 * **The park must be proved reached.** `arm()` hands back `reached`, which `holdWhileOtherRuns` awaits with a bound and
 * throws on, naming the read it was waiting for: a predicate that matches nothing otherwise leaves a test that "raced"
 * two writers that never overlapped, green for no reason.
 *
 * **The second runner is not awaited past a window.** A fix that serialises the two (a lock held across its read and its
 * write) leaves the second one waiting for the first, which is parked: awaiting it before releasing would deadlock the
 * test on exactly the code that is correct. `holdWhileOtherRuns` gives the second `windowMs`, reports whether it finished
 * inside the window, releases the first either way, and awaits both.
 *
 * ## What it does not do
 *
 * It parks `find(...).toArray()` only, which is how the code under test reads here. A reader that uses `findOne` or a
 * `for await` over the cursor is not parked, and the arm then fails `reached` — loudly, never silently.
 */
import assert from 'node:assert/strict';
import { sleep } from '../_shared/sleep.mjs';

/** The prototype that defines `toArray` for every find cursor: the driver's `AbstractCursor`. */
function cursorPrototype(mongo) {
  let proto = Object.getPrototypeOf(mongo.col('probe').find({}));
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'toArray')) proto = Object.getPrototypeOf(proto);
  assert.ok(proto, 're-anchor _read-park.mjs: no prototype of a find cursor defines toArray');
  return proto;
}

/**
 * Install the park over `toArray` for the life of the test file; `restore()` puts back what was there (before the door
 * closes). `mongo` is the door's own module (`openPushDoor().mongo`, so `acts.door.mongo`).
 */
export function parkReadsAfterAnswer(mongo) {
  const proto = cursorPrototype(mongo);
  const original = proto.toArray;
  let armed = null;
  proto.toArray = async function parkedToArray(...args) {
    const rows = await original.apply(this, args);
    const a = armed;
    if (a && this.namespace?.collection === a.collection && a.when(this.cursorFilter ?? {})) {
      armed = null;
      a.reached();
      await a.gate;
    }
    return rows;
  };
  return {
    /**
     * Park the NEXT read of `collection` whose filter `when(filter)` admits, after it has answered. Returns `reached` (a
     * promise that settles when the read is parked) and `release`.
     */
    arm(collection, when) {
      let reached; let release;
      const reachedP = new Promise(r => { reached = r; });
      const gate = new Promise(r => { release = r; });
      armed = { collection, when, reached, gate };
      return { reached: reachedP, release, name: collection };
    },
    restore() { armed = null; proto.toArray = original; },
  };
}

/**
 * Start `first` (not awaited) with its read parked, wait until the park is reached, start `second` and give it `windowMs`
 * to finish while the first is parked, release the first and await both.
 *
 * @returns `{ secondFinishedWhileFirstWasParked }` — what a test may state about the code's own ordering, never what it
 *   must be: a lock is allowed to make the second wait.
 */
export async function holdWhileOtherRuns(park, { first, second, windowMs = 400, reachedWithinMs = 8_000 }) {
  const firstP = first();
  firstP.catch(() => {});
  const reached = await Promise.race([park.reached.then(() => true), sleep(reachedWithinMs).then(() => false)]);
  if (!reached) {
    park.release();
    await firstP.catch(() => {});
  }
  assert.ok(reached, `the read of ${park.name} that was to be parked never happened: the interleaving was not reached, so nothing below says anything`);
  const secondP = second();
  secondP.catch(() => {});
  const secondFinishedWhileFirstWasParked = await Promise.race([secondP.then(() => true, () => true), sleep(windowMs).then(() => false)]);
  park.release();
  await Promise.all([firstP, secondP]);
  return { secondFinishedWhileFirstWasParked };
}
