/**
 * A pull cycle that reads one family after another loses no record that landed on the peer between the two reads (bundle-81, P2;
 * design rev 8 §6 "Marks and watermark", §9 test 6).
 *
 * ## The defect (P2: "max-of-families loses a mid-cycle write", `sync/watermark.ts:226`)
 *
 * The pull's families share ONE watermark and are read one after another. `resolveWatermark` takes the candidate as the MAXIMUM of
 * what each family reached. A record that lands on the peer after family f was read and before family g is, with a seq between
 * what f reached and what g reached, is behind the watermark when the cycle ends: f was already read, g's highest record is above
 * it, and nothing ever asks for it again.
 *
 * ## The rule (6.0)
 *
 * The cycle's candidate is the MINIMUM of `through` over every transfer, and each `through` is "complete through" the peer's settled
 * position at the time that family was read. A write that landed after family f was read has a position above f's `through`, so the
 * mark stays below it and the next cycle reads it.
 *
 * ## What is derived
 *
 * Every pair of consecutive families of `REPLICATED_FAMILIES` (floor 5 pairs): the family read first gets a record before the
 * cycle, the family read second gets one with a higher seq, and the write under test is inserted into the first family while the
 * peer is answering the SECOND family's first page (the peer's answer is held at that point by the test's own hook, not by a timer).
 * That write carries a clock position, as a real writer stamps it, and a seq between the two.
 *
 * ## Red at 9a7ab3f7
 *
 * The next cycle reads from the maximum seq of the cycle, which is above the mid-cycle record's seq: the record is never pulled.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-cross-family-cycle-loses-no-mid-cycle-write-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, derivedLinkBuilder } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { clearPositionMarks, positioned } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'p2space';
/** The record type each family's builder is keyed by (`_push-door.mjs` `build`). */
const BUILDER = { facts: 'fact', entities: 'entity', chrono: 'chrono', filemeta: 'filemeta', edges: 'edge', links: 'link' };

let door, FAMILIES, derivedLink;

/** A file row's id is its path. */
const idOf = (family, id) => (family.payloadKey === 'filemeta' ? `notes/${id}.md` : id);
/** A link is named by a key and carries the id its endpoints derive, the only id a pulled link may carry (Q-222). */
const peerRecord = (family, id, seq, extra = {}) => positioned(family.payloadKey === 'links'
  ? derivedLink(S, id, seq, { author: PEER_AUTHOR })
  : build[BUILDER[family.payloadKey]](S, idOf(family, id), seq, { author: PEER_AUTHOR }), extra);
const has = (family, id) => door.coll(S, family.collection).findOne({ _id: id });

describe('a cross-family pull cycle loses no mid-cycle write', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b81tB_p2', spaces: [S], direction: 'pull' });
    ({ REPLICATED_FAMILIES: FAMILIES } = await import('../../server/dist/sync/replicated-families.js'));
    derivedLink = await derivedLinkBuilder();
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'pull' });
    clearPositionMarks(door);
  });

  it('derives the families, so an empty set cannot pass', () => {
    assert.ok(FAMILIES.length >= 6, `only ${FAMILIES.length} replicated families`);
    for (const f of FAMILIES) assert.ok(BUILDER[f.payloadKey], `no fixture builder for family ${f.payloadKey}`);
  });

  it('a record written to an already-read family during the next family\'s read is pulled by the next cycle, for every consecutive pair', async () => {
    let pairs = 0;
    const lost = [];
    for (let i = 0; i + 1 < FAMILIES.length; i++) {
      const first = FAMILIES[i], second = FAMILIES[i + 1];
      pairs++;
      await door.reset({ direction: 'pull' });
      clearPositionMarks(door);

      const early = peerRecord(first, `p2-${first.payloadKey}-early`, 10);
      const carrier = peerRecord(second, `p2-${second.payloadKey}-carrier`, 30);
      await door.seedPeerRecords(S, first.payloadKey, [early]);
      await door.seedPeerRecords(S, second.payloadKey, [carrier]);

      // The write under test: a seq between the two (below the carrier's, so a watermark at the maximum covers it) and a clock
      // position (what a real writer stamps, which is above everything the peer has settled when `first` was read).
      // The position is taken WHEN THE WRITE LANDS, inside the hook: a position taken at setup is below what the peer settles
      // when the cycle reads `first`, which no writer can stamp (a stamp is at or above the cap the earlier read saw).
      const mid = peerRecord(first, `p2-${first.payloadKey}-mid`, 20);
      let injected = false;
      door.state.family = async (req, res, family) => {
        if (family === second.payloadKey && !injected) {
          injected = true;
          await door.coll(door.peerSide(S), first.collection).insertOne({ ...mid, pos: Date.now() * 1000 });
        }
        await door.serveFamily(req, res, family);
      };

      await door.sync();
      assert.ok(injected, `${first.payloadKey} -> ${second.payloadKey}: the peer was never asked for ${second.payloadKey}, so the write was never made mid-cycle`);
      assert.ok(await has(first, early._id), `control, ${first.payloadKey} -> ${second.payloadKey}: the first cycle did not pull the early record`);
      assert.ok(await has(second, carrier._id), `control, ${first.payloadKey} -> ${second.payloadKey}: the first cycle did not pull the carrier record`);

      door.state.family = door.serveFamily;
      await door.sync();
      if (!(await has(first, mid._id))) lost.push(`${first.payloadKey} -> ${second.payloadKey}`);
    }
    assert.ok(pairs >= 5, `only ${pairs} consecutive family pairs were exercised`);
    assert.deepEqual(lost, [],
      'a record written to an already-read family while the next family was being read was NEVER pulled, for these pairs: the cycle watermark is the maximum over the families, which sits above it');
  });
});
