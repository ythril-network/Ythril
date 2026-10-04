/**
 * Make a write fail, or make it WAIT, against the real store — the question "what does the code do when a write
 * does not go through", answered once for every -db test that asks it.
 *
 * ## Why a module
 *
 * Three faults were written by hand, each more than twice: a write PARKED behind a gate the test opens
 * (`a-pull-never-passes-an-uncommitted-seq-db`, `a-converge-that-loses-a-race-is-replanned-db`,
 * `a-stray-filemeta-collection-is-merged-db`), a collection turned into a VIEW so every write to it fails at the
 * command level (`a-tombstone-moves-the-counter-db`, `a-push-write-failure-keeps-what-it-must-db`,
 * `a-stray-filemeta-collection-is-merged-db`), and a VALIDATOR on the counter collection refusing a seq above a
 * ceiling (`a-tombstone-moves-the-counter-db`, `a-push-write-failure-keeps-what-it-must-db`). Bundle-30's tests
 * needed all three again, plus the one none of them can give.
 *
 * ## The fault none of the copies could give: a write the DRIVER is waiting on
 *
 * A parked write is a JavaScript promise that never reaches the driver, so no driver bound (`timeoutMS`,
 * `maxTimeMS`, a session's `defaultTimeoutMS`) can ever end it — a test of "a hung write is ended by its bound"
 * built on a park passes or fails for reasons that have nothing to do with the bound. `holdDocumentLock` holds a
 * REAL lock instead: another session opens a transaction, writes the document, and leaves it uncommitted. A plain
 * write to that document then waits inside the server for as long as the transaction lives, and a write inside a
 * transaction fails with `WriteConflict` and is retried by `withTransaction` for as long as ITS budget lasts —
 * the stall measured by the bundle-30 design probe (P1), on this store, and the only kind a bound can end.
 *
 * ## The guard a hand-written copy drops
 *
 * **A lock that locked nothing.** An update whose filter matches no document takes no lock, and the write the
 * test meant to stall runs free — so a test of "the stall is ended by the bound" passes having stalled nothing.
 * `holdDocumentLock` THROWS when its write did not modify exactly one document. The same for a ceiling or a view
 * that was not installed: each is checked against the store before it is handed back.
 *
 * ## What it does not do
 *
 * It does not build error objects (one exception, stated where it is: `loseNextCommitReply`). Every other fault
 * here is a condition of the real store, so the error the code under test sees is whatever the driver produces
 * for it — which is the thing a classifier is being tested against.
 *
 * ## `setWriteBoundForTest`
 *
 * The bundle-30 plan (§A1) gives the write bound a test-settable value so a bound test runs in a couple of seconds
 * rather than the production 45. The seam is `db/write-bound.ts`'s export `setWriteBoundForTest(bounds | null)`;
 * this module only resolves it and says plainly when it does not exist, so a test can report that reason AND go
 * on to show the stall the bound is for.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ASYNC_MUTATORS } from './_document-mutators.mjs';

// ── A real lock ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hold a document lock with another session's open, uncommitted transaction until `release()`.
 *
 * @param {object} mongo  the server's `db/mongo.js` module (as `openTestMongo` / `openPushDoor().mongo` hand it)
 * @param {string} collName
 * @param {object} o
 * @param {object} [o.filter]  lock an EXISTING document by updating it (the update adds a field nothing reads)
 * @param {object} [o.insert]  lock an id that does not exist yet, by inserting it uncommitted: an insert or an
 *   upsert of the same `_id` waits behind it
 * @returns {Promise<{ release: () => Promise<void> }>} `release` aborts the transaction; safe to call twice
 */
export async function holdDocumentLock(mongo, collName, { filter, insert } = {}) {
  assert.ok(!!filter !== !!insert, 'holdDocumentLock takes exactly one of filter or insert');
  const session = mongo.getMongo().startSession();
  session.startTransaction();
  const coll = mongo.getDb().collection(collName);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try { await session.abortTransaction(); } catch { /* already ended */ }
    await session.endSession();
  };
  try {
    if (insert) {
      await coll.insertOne(insert, { session });
    } else {
      const r = await coll.updateOne(filter, { $set: { _lockedForTest: randomUUID() } }, { session });
      if (r.modifiedCount !== 1) {
        throw new Error(`holdDocumentLock: ${JSON.stringify(filter)} on ${collName} modified ${r.modifiedCount} document(s). `
          + 'A lock on nothing stalls nothing, and the write it was meant to hold would run free.');
      }
    }
  } catch (err) {
    await release();
    throw err;
  }
  return { release };
}

/**
 * Hold the lock on one space's counter row (`ythril_counters`). Every seq allocation of that space — the `$inc`
 * in `withAllocatedSeqs`, which runs with the horizon already held — and every counter bump then waits.
 * The row is created first when the space has none, since a missing row cannot be locked.
 */
export async function holdCounterLock(mongo, spaceId) {
  await mongo.getDb().collection('ythril_counters').updateOne({ _id: spaceId }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  return holdDocumentLock(mongo, 'ythril_counters', { filter: { _id: spaceId } });
}

/**
 * Wait for `promise` for at most `ms`, without abandoning it: `{ settled, elapsedMs, ok, value, error }`, and
 * `rest` resolves once it has settled whichever way (a caller releases its stall, then awaits `rest`).
 */
export async function settleWithin(promise, ms) {
  const started = Date.now();
  const outcome = promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  let timer;
  const raced = await Promise.race([outcome, new Promise(r => { timer = setTimeout(() => r(null), ms); })]);
  clearTimeout(timer);
  if (raced === null) return { settled: false, elapsedMs: Date.now() - started, rest: outcome };
  return { settled: true, elapsedMs: Date.now() - started, ...raced, rest: outcome };
}

/** Poll `predicate` until it is true or `ms` passes; true when it held. For "the stall has been reached". */
export async function eventually(predicate, ms, everyMs = 10) {
  const until = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= until) return false;
    await new Promise(r => setTimeout(r, everyMs));
  }
}

// ── The write bound's test seam ──────────────────────────────────────────────────────────────────────────────

/**
 * Set the write bound for this process: `{ writeTimeoutMs, holdDeadlineMs }`; returns the restore. THROWS when the
 * server has no such seam — with a message that says so, so the caller can report it as the reason it is red.
 */
export async function setWriteBoundForTest(bounds) {
  const mod = await import('../../server/dist/db/write-bound.js').catch(err => ({ __missing: err }));
  if (mod.__missing || typeof mod.setWriteBoundForTest !== 'function') {
    throw new Error('server/dist/db/write-bound.js exports no setWriteBoundForTest — the write bound has no test seam '
      + `(${mod.__missing ? 'the module does not exist' : 'the export is missing'}), so no bound can be set to a value a test can wait out`);
  }
  mod.setWriteBoundForTest(bounds);
  return () => mod.setWriteBoundForTest(null);
}

// ── A collection that refuses ────────────────────────────────────────────────────────────────────────────────

/**
 * A validator on `collName` while `fn` runs, removed after it whatever happened. Real store refusals (code 121),
 * so the error shape is the driver's.
 */
export async function withValidator(db, collName, validator, fn) {
  const exists = (await db.listCollections({ name: collName }).toArray()).length > 0;
  if (!exists) await db.createCollection(collName);
  await db.command({ collMod: collName, validator, validationLevel: 'strict', validationAction: 'error' });
  try { return await fn(); } finally {
    await db.command({ collMod: collName, validator: {} });
  }
}

/** The counter collection refuses a seq above `ceiling` for `spaceId` while `fn` runs: every bump past it fails. */
export async function withCounterCeiling(db, spaceId, ceiling, fn) {
  return withValidator(db, 'ythril_counters', { $or: [{ _id: { $ne: spaceId } }, { seq: { $lte: ceiling } }] }, fn);
}

/**
 * `name` is a VIEW on `viewOn` while `fn` runs: every write to it fails at the command level, with no
 * per-document shape, and a read of it reads `viewOn`. Put back as an empty ordinary collection afterwards —
 * with whatever indexes `restore` recreates, since a dropped collection loses its own.
 */
export async function withCollectionAsView(db, name, viewOn, fn, { restore } = {}) {
  await db.collection(name).drop().catch(() => {});
  await db.createCollection(name, { viewOn, pipeline: [] });
  try { return await fn(); } finally {
    await db.collection(name).drop();
    await db.createCollection(name);
    if (restore) await restore();
  }
}

// ── A write parked behind a gate ─────────────────────────────────────────────────────────────────────────────

/** The write methods a park wraps: every document-changing one that returns a promise (`_document-mutators.mjs`). */
const WRITE_METHODS = ASYNC_MUTATORS;

/** The seq a write carries — the LOWEST, for a block — or undefined. */
export function seqCarriedBy(method, args) {
  if (method === 'insertOne') return args[0]?.seq;
  if (method === 'replaceOne' || method === 'findOneAndReplace') return args[1]?.seq;
  if (method === 'updateOne' || method === 'findOneAndUpdate') return args[1]?.$set?.seq;
  const seqs = method === 'insertMany' ? (args[0] ?? []).map(d => d?.seq)
    : method === 'bulkWrite' ? (args[0] ?? []).map(op =>
      op.insertOne?.document?.seq ?? op.replaceOne?.replacement?.seq ?? op.updateOne?.update?.$set?.seq)
    : [];
  const numbers = seqs.filter(s => typeof s === 'number');
  return numbers.length > 0 ? Math.min(...numbers) : undefined;
}

/**
 * Park writes on `Collection.prototype` behind gates the test opens. A JavaScript park: the write has not reached
 * the driver, so no driver bound can end it — use `holdDocumentLock` for that question.
 *
 * Installed over whatever is on the prototype now, so a park installed after `openPushDoor` (which patches
 * `updateOne`/`findOneAndUpdate` to observe the counter) must be `restore()`d BEFORE the door closes, or the
 * door's restore puts back the park and this one puts back a stale door.
 */
export function parkWrites(proto) {
  const originals = {};
  let armed = [];
  for (const m of WRITE_METHODS) {
    const orig = proto[m];
    originals[m] = orig;
    proto[m] = async function parked(...args) {
      const a = armed.find(x => x.left > 0 && this.collectionName === x.name && x.when(m, args));
      if (a) {
        a.left -= 1;
        a.reached({ method: m, seq: seqCarriedBy(m, args) });
        await a.gate;
      }
      return orig.apply(this, args);
    };
  }
  return {
    /** Park the next `count` writes to `name` that `when(method, args)` admits; `reached` names the first. */
    arm(name, { count = 1, when = () => true } = {}) {
      let reached, release;
      const reachedP = new Promise(r => { reached = r; });
      const gate = new Promise(r => { release = r; });
      armed.push({ name, left: count, when, reached, gate });
      return { reached: reachedP, release };
    },
    restore() {
      armed = [];
      for (const [m, f] of Object.entries(originals)) proto[m] = f;
    },
  };
}

// ── A commit that lands and whose reply does not ─────────────────────────────────────────────────────────────

/**
 * The next `commitTransaction` COMMITS, and then the caller is told it failed — what `maxCommitTimeMS` firing
 * after the commit applied, or a reply lost on the wire, looks like from the caller's side.
 *
 * The one built error in this module, and why: no store condition produces "committed, and reported as failed"
 * on demand (`failCommand` fail points fail a command BEFORE it runs, and are not enabled on the test store).
 * The commit itself is real; only the reply is replaced, by the shape the driver gives a `MaxTimeMSExpired`
 * (`MongoServerError`, code 50) — which `withTransaction` does not retry, so it reaches the caller.
 *
 * @returns {{ fired: () => boolean, restore: () => void }}
 */
export async function loseNextCommitReply(mongo) {
  const { MongoServerError } = await import('mongodb');
  const session = mongo.getMongo().startSession();
  const proto = Object.getPrototypeOf(session);
  await session.endSession();
  const original = proto.commitTransaction;
  let fired = false;
  proto.commitTransaction = async function lostReply(...args) {
    const result = await original.apply(this, args);
    if (fired) return result;
    fired = true;
    throw new MongoServerError({ ok: 0, code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'operation exceeded time limit' });
  };
  return { fired: () => fired, restore: () => { proto.commitTransaction = original; } };
}
