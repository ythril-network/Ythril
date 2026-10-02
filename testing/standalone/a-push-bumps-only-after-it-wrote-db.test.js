/**
 * A push moves the counter only AFTER it has written what it received — never while that write is still pending
 * (`Q-196`, `Q-198`; 5.6.2 `Q-218`, design challenge O3).
 *
 * ## Why the order matters on 5.6.x
 *
 * `bumpSeq` does two things: it moves the space counter, and it raises the in-memory horizon a seq-paged reader is
 * capped at (`settledSeqRange` serves below `maxSeen + 1`), because it assumes what it bumps over is committed. A
 * door that bumps BEFORE its write therefore hands a concurrent `GET /api/sync/*` page a horizon above a record that
 * is not stored yet; the pulling peer moves its watermark past that seq and never asks for it again. So every push
 * door writes first and bumps in a `finally`, awaited, before it answers. `a-push-bumps-before-it-answers` holds the
 * statement order; this file holds the behaviour, on every push door that writes a record.
 *
 * ## How the write is held
 *
 * The record collection's write methods are wrapped so the first write to it parks until the case releases it.
 * While it is parked, the case asks the seq module the reader asks (`settledSeqRange`) where a page would stop. The
 * pushed seq is far above anything stored, so a horizon that reaches it can only have come from a bump made before
 * the write.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-push-bumps-only-after-it-wrote-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'pushorder';
const WRITES = ['bulkWrite', 'updateOne', 'replaceOne', 'insertOne', 'insertMany', 'updateMany'];

/** Each push door that writes a record, the collection it writes, and the body it is sent. */
const DOORS = [
  { route: '/facts', coll: 'facts', body: (seq) => build.fact(S, `f-${seq}`, seq) },
  { route: '/entities', coll: 'entities', body: (seq) => build.entity(S, `e-${seq}`, seq) },
  { route: '/edges', coll: 'edges', body: (seq) => build.edge(S, `g-${seq}`, seq) },
  { route: '/chrono', coll: 'chrono', body: (seq) => build.chrono(S, `c-${seq}`, seq) },
  { route: '/batch-upsert', coll: 'facts', body: (seq) => ({ facts: [build.fact(S, `bf-${seq}`, seq)] }) },
  { route: '/batch-upsert', coll: 'links', label: 'links', body: (seq) => ({ links: [build.link(S, `bl-${seq}`, seq)] }) },
];

let door, seqMod;

/** Park the first write to `collectionName` until `release()`; `reached` resolves when it parks. */
function holdFirstWrite(collectionName) {
  const proto = Object.getPrototypeOf(door.mongo.col('probe'));
  const originals = Object.fromEntries(WRITES.map(m => [m, proto[m]]));
  let release;
  const gate = new Promise(r => { release = r; });
  let signal;
  const reached = new Promise(r => { signal = r; });
  let held = false;
  for (const m of WRITES) {
    proto[m] = async function parked(...args) {
      if (this.collectionName === collectionName && !held) {
        held = true;
        signal();
        await gate;
      }
      return originals[m].apply(this, args);
    };
  }
  return { reached, release: () => release(), restore: () => Object.assign(proto, originals) };
}

describe('a push moves the counter only after it wrote what it received', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushorder', spaces: [{ id: S, label: 'Order', folders: [], meta: {} }] });
    seqMod = await import('../../server/dist/util/seq.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  for (const d of DOORS) {
    it(`POST ${d.route}${d.label ? ` (${d.label})` : ''}: while its write is pending, no reader may be handed the pushed seq`, async () => {
      const horizonBefore = (await seqMod.settledSeqRange(S, 0)).$lt;
      const seq = horizonBefore + 1000;
      const hold = holdFirstWrite(`${S}_${d.coll}`);
      let pushing;
      try {
        pushing = door.push(d.route, d.body(seq), { spaceId: S });
        await Promise.race([hold.reached, pushing.then(() => { throw new Error('the push answered without writing'); })]);
        const during = (await seqMod.settledSeqRange(S, 0)).$lt;
        assert.ok(during <= seq,
          `while POST ${d.route} had not yet written seq ${seq}, a seq-paged reader was capped at ${during}: it could `
          + `be served past ${seq} before that record exists, and a peer that pulls then never comes back for it. `
          + 'The counter was bumped before the write.');
      } finally {
        hold.release();
        await pushing?.catch(() => {});
        hold.restore();
      }
      const r = await pushing;
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.ok(r.counterAtResponse >= seq, `POST ${d.route} answered with the counter at ${r.counterAtResponse}, below ${seq}`);
      assert.ok((await seqMod.settledSeqRange(S, 0)).$lt > seq, 'after the write the pushed seq is not servable');
    });
  }
});
