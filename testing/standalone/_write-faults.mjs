/**
 * Make a write fail, or make it WAIT, against the real store — the question "what does the code do when a write
 * does not go through", answered once for every -db test that asks it. A subset of main's module of the same name
 * (copied for the 5.6.4 patch, which has no write bound and no record-write observer): the three faults that were
 * written by hand more than twice.
 *
 * - `parkWrites`: a write PARKED behind a gate the test opens (a JavaScript park: the write has not reached the
 *   driver). The set of methods it wraps is `MUTATORS` of `_space-writers.mjs`, the one list of what changes a
 *   document, so a method added there is parked here.
 * - `withValidator`: a validator on a collection while a function runs, so every write that violates it fails with
 *   the store's own refusal (code 121) — the error shape is the driver's, never a hand-built one.
 * - `withCollectionAsView`: a collection turned into a VIEW, so every write to it fails at the command level.
 *
 * ## The guard a hand-written copy drops
 *
 * **A fault that was not installed.** A validator that matches everything refuses nothing, and a test of "the delete
 * survives a failing write" passes having injected no failure. Each fault here is the real store's, and the
 * installing helpers assert that the store holds it (`withValidator` reads the validator back).
 */
import assert from 'node:assert/strict';
import { MUTATORS } from './_space-writers.mjs';

/** Poll `predicate` until it is true or `ms` passes; true when it held. */
export async function eventually(predicate, ms, everyMs = 10) {
  const until = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= until) return false;
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** A validator on `collName` while `fn` runs, removed after it whatever happened. Real store refusals (code 121). */
export async function withValidator(db, collName, validator, fn) {
  const exists = (await db.listCollections({ name: collName }).toArray()).length > 0;
  if (!exists) await db.createCollection(collName);
  await db.command({ collMod: collName, validator, validationLevel: 'strict', validationAction: 'error' });
  const held = (await db.listCollections({ name: collName }).toArray())[0]?.options?.validator;
  assert.ok(held && Object.keys(held).length > 0, `withValidator: the store holds no validator on ${collName} — the fault would fail nothing`);
  try { return await fn(); } finally {
    await db.command({ collMod: collName, validator: {} });
  }
}

/**
 * `name` is a VIEW on `viewOn` while `fn` runs: every write to it fails at the command level, and a read of it reads
 * `viewOn`. Put back as an empty ordinary collection afterwards, with the indexes it held BEFORE the fault.
 *
 * The indexes are captured here and recreated here, not by a `restore` each caller must remember to pass: dropping the
 * collection drops its unique indexes with it (an edge collection loses its endpoint-triplet index), and a later case
 * in the same file would then run against a store that no longer refuses a duplicate, passing for the wrong reason.
 */
export async function withCollectionAsView(db, name, viewOn, fn) {
  const held = (await db.collection(name).indexes().catch(() => [])).filter(i => i.name !== '_id_');
  await db.collection(name).drop().catch(() => {});
  await db.createCollection(name, { viewOn, pipeline: [] });
  try { return await fn(); } finally {
    await db.collection(name).drop();
    await db.createCollection(name);
    if (held.length > 0) await db.command({ createIndexes: name, indexes: held });
  }
}

/** The write methods a park wraps: every document-changing one that returns a promise. */
const WRITE_METHODS = MUTATORS;

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
 * Park writes on `Collection.prototype` behind gates the test opens. Installed over whatever is on the prototype now,
 * so a park installed after `openPushDoor` (which patches `updateOne`/`findOneAndUpdate` to observe the counter) must
 * be `restore()`d BEFORE the door closes, or the door's restore puts back the park and this one puts back a stale door.
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
