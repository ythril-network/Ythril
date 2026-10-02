/**
 * The arrival writer's duplicate read-back keeps a copy written MEANWHILE at a higher seq (`Q-218` round R, item R8).
 *
 * ## The rule
 *
 * The write guard (`{ _id, seq < s or absent }`, upserted) fails with a duplicate `_id` when a newer copy was stored
 * between the writer's read of the stored copies and its write. The writer reads such an id back
 * (`sync/arrivals.ts`, the `dupes` branch): a stored copy ABOVE the planned seq is `newerLocal` and is the copy that
 * stays — never counted as a unique-index duplicate (which a push door answers `duplicate` and a sender reads as
 * "not delivered"), and never overwritten.
 *
 * Coverage of a branch no test exercised. A concurrent writer is simulated by storing the higher copy at the moment
 * the writer's bulk write starts, on the one collection under test.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-copy-written-meanwhile-is-kept-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'readback';
/** The families the writer bulk-writes (file metadata from a peer is merged one by one, so it has no read-back). */
const BULK = Object.entries(FAMILIES).filter(([k]) => k !== 'filemeta').map(([key, f]) => ({ key, ...f }));
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link' };

let door, writeArrivals;

describe('a copy written meanwhile at a higher seq is kept, and counted newerLocal', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'readback', spaces: [{ id: S, label: 'Read back', folders: [], meta: {} }] });
    ({ writeArrivals } = await import('../../server/dist/sync/arrivals.js'));
  });
  after(async () => { await door?.close(); });

  it('every family the writer bulk-writes', async () => {
    assert.ok(BULK.length >= 5, `only ${BULK.length} families`);
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const original = proto.bulkWrite;
    const wrong = [];
    try {
      for (const fam of BULK) {
        const id = `raced-${fam.key}`;
        let raced = 0;
        proto.bulkWrite = async function racing(...args) {
          if (this.collectionName === `${S}_${fam.coll}` && raced++ === 0) {
            await door.coll(S, fam.coll).insertOne(build[KIND[fam.key]](S, id, 9, { updatedAt: 'written meanwhile' }));
          }
          return original.apply(this, args);
        };
        const out = await writeArrivals(S, fam.coll, fam.type, [build[KIND[fam.key]](S, id, 5)], { from: 'test' });
        assert.equal(raced, 1, `fixture check: ${fam.key} never reached the bulk write`);
        const kept = await door.coll(S, fam.coll).findOne({ _id: id });
        const got = { newerLocal: out.newerLocal, duplicates: out.duplicates, landed: [...out.inserted, ...out.updated],
          kept: [kept?.seq, kept?.updatedAt] };
        const want = { newerLocal: [id], duplicates: [], landed: [], kept: [9, 'written meanwhile'] };
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${fam.key}: ${JSON.stringify(got)}`);
      }
    } finally {
      proto.bulkWrite = original;
    }
    assert.deepEqual(wrong, [], 'a copy stored meanwhile at a higher seq was not read back as newerLocal and kept');
  });
});
