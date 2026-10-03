/**
 * Arriving file metadata is held to the arrival writer's guards — by the push door and by the pull alike
 * (`Q-107` part 2, data integrity).
 *
 * ## The guard file metadata did not have
 *
 * `writeArrivals` guards every brain family's write with `{ _id, seq < s or absent }`, so a copy NEWER than the
 * one planned, written between the accept read and the write, fails that write and is kept. File metadata was the
 * stated exception (`sync/arrivals.ts`, rule 6): it was merged per document by `ingestFileMeta`, whose `$set`
 * upsert filters on `_id` alone, so only the accept read guarded it — and a copy written in between was
 * overwritten by an OLDER one, with no error and a 200 on the way back. Part 2 writes the page as one bulk of
 * guarded upserts, and this is the half of that change a reviewer cannot see in a diff.
 *
 * The race is made, not waited for: just before the writer's first write to the files collection, the case writes
 * a newer copy there itself (the write methods are read from `COLLECTION_METHOD_EFFECT`, so whichever one the
 * writer uses is the one intercepted). The accept read has already run by then and admitted the older copy.
 *
 * ## The two guards the rewrite must keep — pins, green today
 *
 *  - **A legacy read spill never lands** (`Q-92`): a path of the spill shape is one caller's search result an older
 *    peer wrote into its space. `ingestFileMeta` refused it; the batched write must refuse it too.
 *  - **A peer's text is stored as text.** A merge written as an update PIPELINE (the brain families' shape, and
 *    the obvious way to carry local fields across) reads a string that starts with `$` as a FIELD PATH: a peer's
 *    description `$seq` would be stored as this instance's seq. Every value the peer authored must arrive inside
 *    `$literal`, or be written by an operator that does not evaluate it — asserted here on the value, whichever.
 *
 * Every case runs on both doors: the push (`POST /api/sync/batch-upsert`) and the pull (`runSyncForPeer` against a
 * peer serving the page), because one writer serving both is the claim and a door that bypassed it would pass
 * every case asked only of the other.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-file-metadata-arrival-keeps-the-writers-guards-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, FAMILIES } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'filemetaguards';
const KEY = Object.entries(FAMILIES).find(([, f]) => f.coll === 'files')?.[0];
const LOCAL_AUTHOR = { instanceId: 'filemetaguards-receiver', instanceLabel: 'Receiver' };

let door;
/** The write methods of a collection, as the server's own write observer classifies them. */
let WRITE_METHODS;
/** `{ collection, before }`: run `before(collection)` ahead of the next write to that collection, once. */
let armed = null;
let proto, originals;

const files = () => door.coll(S, 'files');
const stored = (id) => files().findOne({ _id: id });

const DOORS = {
  async push(docs) {
    const res = await door.push('/batch-upsert', { [KEY]: docs }, { spaceId: S });
    assert.equal(res.code, 200, JSON.stringify(res.body));
  },
  async pull(docs) {
    door.state.records[S] = { [KEY]: docs };
    await door.sync();
  },
};

describe('arriving file metadata keeps the writer\'s guards', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'filemetaguards', spaces: [S] });
    const { COLLECTION_METHOD_EFFECT } = await import('../../server/dist/db/record-write-observer.js');
    WRITE_METHODS = Object.entries(COLLECTION_METHOD_EFFECT)
      .filter(([, e]) => typeof e === 'object' && e.write).map(([m]) => m);
    assert.ok(WRITE_METHODS.length >= 8, `the write observer classifies only ${WRITE_METHODS.length} write methods`);
    // Installed AFTER the door, which patches the same prototype, and removed before it closes (it restores its
    // own saved originals, which would clobber or leak this one otherwise).
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    originals = Object.fromEntries(WRITE_METHODS.filter(m => typeof proto[m] === 'function').map(m => [m, proto[m]]));
    for (const [m, orig] of Object.entries(originals)) {
      proto[m] = async function interleaved(...args) {
        if (armed && this.collectionName === armed.collection) {
          const a = armed;
          armed = null;
          await a.before(this);
        }
        return orig.apply(this, args);
      };
    }
  });
  after(async () => {
    if (proto) for (const [m, orig] of Object.entries(originals)) proto[m] = orig;
    await door?.close();
  });
  beforeEach(async () => {
    armed = null;
    await door.reset();
  });

  it('the family and the write methods are found', () => {
    assert.ok(KEY, 'the push door has no family stored in the files collection — re-anchor this test');
    for (const m of ['bulkWrite', 'updateOne', 'replaceOne', 'insertMany']) {
      assert.ok(WRITE_METHODS.includes(m), `'${m}' is not a write method to the observer, so it would not be intercepted`);
    }
  });

  for (const via of Object.keys(DOORS)) {
    it(`${via}: a newer copy written between the accept read and the write is kept`, async () => {
      const id = `docs/${via}/raced.md`;
      // What this instance holds when the page is planned: older than what arrives, so the accept admits it.
      await files().insertOne(build.filemeta(S, id, 5, { author: LOCAL_AUTHOR, description: 'as it was' }));
      let intercepted = false;
      armed = {
        collection: `${S}_files`,
        // A local edit lands meanwhile, at a seq above the arriving copy's.
        before: async (coll) => {
          intercepted = true;
          await originals.replaceOne.call(coll, { _id: id },
            build.filemeta(S, id, 50, { author: LOCAL_AUTHOR, description: 'written here meanwhile' }));
        },
      };
      await DOORS[via]([build.filemeta(S, id, 10, { author: PEER_AUTHOR, description: 'the peer, older' })]);
      assert.ok(intercepted, 'the writer never wrote to the files collection, so the race was never made');
      const now = await stored(id);
      assert.equal(now?.seq, 50,
        `${via}: the stored copy at seq 50 was overwritten by an arriving copy at seq 10 — the file-metadata write `
        + `filters on _id alone, so only the accept read guards it (stored: ${JSON.stringify(now)})`);
      assert.equal(now?.description, 'written here meanwhile', `${via}: the newer copy's content was replaced`);
    });

    it(`${via}: PIN — a legacy read spill path is never stored`, async () => {
      const spill = '_tmp/graph-0b0b0b0b-1111-4222-8333-444444444444.json';
      await DOORS[via]([
        build.filemeta(S, spill, 7, { author: PEER_AUTHOR }),
        build.filemeta(S, `docs/${via}/control.md`, 8, { author: PEER_AUTHOR }),
      ]);
      assert.ok(await stored(`docs/${via}/control.md`), `${via}: the control file did not land, so the refusal proves nothing`);
      assert.equal(await stored(spill), null, `${via}: a legacy read spill was stored — it travels in neither direction (Q-92)`);
    });

    it(`${via}: PIN — peer values that start with $ are stored as the text that was sent`, async () => {
      const sent = {
        description: '$seq',
        tags: ['$_id', '$$ROOT'],
        properties: { a: '$path', b: '$$NOW', c: '$author.instanceId' },
      };
      const fresh = `docs/${via}/dollar-new.md`;
      const over = `docs/${via}/dollar-over.md`;
      // One over a stored copy, so a merge that carries local fields (the update shape) is exercised too.
      await files().insertOne(build.filemeta(S, over, 3, { author: LOCAL_AUTHOR, description: 'plain', sha256: 'f'.repeat(64) }));
      await DOORS[via]([
        build.filemeta(S, fresh, 21, { author: PEER_AUTHOR, ...sent }),
        build.filemeta(S, over, 22, { author: PEER_AUTHOR, ...sent }),
      ]);
      for (const id of [fresh, over]) {
        const d = await stored(id);
        assert.ok(d, `${via}: ${id} did not land`);
        assert.equal(d.description, sent.description, `${via}: ${id}'s description was evaluated as a field path`);
        assert.deepEqual(d.tags, sent.tags, `${via}: ${id}'s tags were evaluated`);
        assert.deepEqual(d.properties, sent.properties, `${via}: ${id}'s property values were evaluated`);
      }
      assert.equal((await stored(over)).sha256, 'f'.repeat(64), `${via}: the merge dropped the receiver's own hash`);
    });
  }
});
