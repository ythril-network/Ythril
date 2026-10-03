/**
 * A peer's file whose METADATA arrives before its bytes still takes this instance's file retention window — on every
 * door that brings file metadata in — `Q-250`, 5.6.3.
 *
 * ## The defect
 *
 * File metadata arrives through the arrival writer, which merges it with `ingestFileMeta`. That upsert created the row
 * with no `_expireAt`. The bytes landing afterwards (`recordArrivedFile`) found the row already there, so its
 * insert-only stamp never ran: a file the space should expire never did, on whichever instance happened to receive the
 * metadata first. (`an-arrived-file-is-live-and-takes-this-instances-retention-db` holds the bytes-first order.)
 *
 * ## The rule, per door
 *
 *  - the row the metadata creates takes this instance's file window;
 *  - a later copy of the metadata through the same door, and then the bytes, never re-slide it;
 *  - with no file window there is no `_expireAt` key at all (control: an explicit null would read as "stamped").
 *
 * ## The doors
 *
 * Every door that brings a peer's file metadata in reaches `ingestFileMeta` through the arrival writer: the PUSH
 * (`batch-upsert`, for each family `familiesCarriedByBatch()` reads) and the PULL (the engine pulls every
 * `REPLICATED_FAMILIES` member). The file-metadata family is derived from the registry by its collection, and each door
 * is included only when the derivation says it carries that family — so a door that stops carrying it fails the floor
 * rather than leaving the rule asserted on the other one alone.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-file-whose-metadata-arrives-first-takes-this-instances-retention-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, familiesCarriedByBatch } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const W = 'meta-first';            // a 30-day file window
const N = 'meta-first-nowindow';   // no window
const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** The file-metadata family, by its collection, and the doors that carry it — derived, read at load. */
const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
const FILE_FAMILY = REPLICATED_FAMILIES.find(f => f.collection === 'files');
let door, recordArrivedFile;

const DOORS = {
  /** Pushed by the peer: `POST /api/sync/batch-upsert`, through the alias middleware and the route's own handler. */
  push: {
    carries: () => familiesCarriedByBatch().includes(FILE_FAMILY?.payloadKey),
    async deliver(space, doc) {
      const res = await door.push('/batch-upsert', { [FILE_FAMILY.payloadKey]: [doc] }, { spaceId: space });
      assert.equal(res.code, 200, JSON.stringify(res.body));
    },
  },
  /** Pulled by this instance: the real engine's page of the family from the fake peer. */
  pull: {
    carries: () => REPLICATED_FAMILIES.includes(FILE_FAMILY),
    async deliver(space, doc) {
      door.state.records[space] = { [FILE_FAMILY.payloadKey]: [doc] };
      door.member().lastSeqReceived = {};
      await door.sync();
    },
  },
};
const meta = (space, id, seq, extra = {}) => build.filemeta(space, id, seq, { author: PEER_AUTHOR, ...extra });
const stored = (space, id) => door.coll(space, 'files').findOne({ _id: id });

describe('file metadata that arrives before its bytes takes this instance\'s file window, on every door', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'metafirst', spaces: [W, N], spaceSettings: { [W]: { recordTtlDays: { file: WINDOW_DAYS } } } });
    ({ recordArrivedFile } = await import('../../server/dist/files/file-meta.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the file-metadata family is derived and both doors carry it (floor)', () => {
    assert.ok(FILE_FAMILY, 'no replicated family writes the files collection — re-anchor');
    const carrying = Object.entries(DOORS).filter(([, d]) => d.carries()).map(([n]) => n);
    assert.deepEqual(carrying, Object.keys(DOORS),
      `only ${carrying.join(', ') || 'no door'} carries '${FILE_FAMILY.payloadKey}' — the derivation or a door changed`);
  });

  it('control: the window is live — bytes arriving first stamp a new row from it', async () => {
    await recordArrivedFile(W, 'bytes-first.md', 10, 'hash-bytes-first', PEER_AUTHOR);
    assert.ok((await stored(W, 'bytes-first.md'))?._expireAt instanceof Date,
      'the configured file window does not reach the space, so every row below would prove nothing');
  });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(name, () => {
      it('metadata first, then a later copy, then the bytes: the row takes the window once, and nothing re-slides it', async () => {
        const id = `${name}-first.md`;
        const before = Date.now();
        await d.deliver(W, meta(W, id, 20, { description: 'described upstream' }));
        const first = (await stored(W, id))?._expireAt;
        assert.ok(first instanceof Date,
          `${name}: the row file metadata created has no _expireAt in a space with a ${WINDOW_DAYS}-day file window, and the `
          + 'bytes arriving later find the row already there, so nothing ever stamps it: the file never expires '
          + `(${JSON.stringify(await stored(W, id))})`);
        const days = (first.getTime() - before) / DAY_MS;
        assert.ok(Math.abs(days - WINDOW_DAYS) < 1, `${name}: expires in ${days.toFixed(2)} days, not this instance's ${WINDOW_DAYS}`);

        await d.deliver(W, meta(W, id, 21, { description: 'edited upstream' }));
        assert.equal((await stored(W, id))?._expireAt?.toISOString(), first.toISOString(), `${name}: a later copy re-slid the expiry`);
        await recordArrivedFile(W, id, 10, `hash-${name}`, PEER_AUTHOR);
        const row = await stored(W, id);
        assert.equal(row?._expireAt?.toISOString(), first.toISOString(), `${name}: the bytes arriving re-slid the expiry`);
        assert.equal(row?.description, 'edited upstream', `${name}: the later metadata did not land, so the row proves nothing`);
      });

      it('control: with no file window, metadata first then bytes leaves no _expireAt key at all', async () => {
        const id = `${name}-nowindow.md`;
        await d.deliver(N, meta(N, id, 20));
        await recordArrivedFile(N, id, 10, `hash-${name}-n`, PEER_AUTHOR);
        const row = await stored(N, id);
        assert.ok(row, `${name}: the metadata did not land`);
        assert.equal(Object.hasOwn(row, '_expireAt'), false, `${name}: a space with no window stored _expireAt: ${JSON.stringify(row._expireAt)}`);
      });
    });
  }
});
