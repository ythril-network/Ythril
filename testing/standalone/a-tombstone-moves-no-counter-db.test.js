/**
 * A tombstone a peer delivers moves NO counter — on both doors, whatever was done with it — and so a counter is never why a tombstone page fails
 * (bundle-81, design rev 8 §1a, D-19 B). The inverse of what this file held until then (`a-tombstone-moves-the-counter-db`, bundle-46 plan row 5:
 * "every tombstone a peer delivers advances this instance's seq counter … and a counter that could not be moved is never answered as success"); the
 * reason is stated here so the inversion is not read as a weakened gate. It replaces `a-tombstone-advances-the-clock.test.js` no longer: that file's
 * subject went with the bump.
 *
 * ## Why the rule turned over
 *
 * The bump existed for one chain: a busy peer (counter 5001) deletes a record -> tombstone at seq 5001; a quiet peer (counter 300) receives it; the quiet
 * peer re-creates the record with the same id and the next local write takes 301; it pushes back, and every peer holding the tombstone refuses 301 as
 * older. A local write is stamped per RECORD now (`util/version-stamp.ts`): above the version the record holds AND above any tombstone held for its id
 * (capped, `VERSION_FLOOR_CAP`), so the re-created record takes 5002 whatever the counter stands at — without the counter having followed the peer's
 * clock. A tombstone that raised the counter would let a peer lift every later stamp of the space to wherever it chose, which is the thing the cap and
 * the reserve exist to refuse.
 *
 * ## The rules
 *
 *  1. **Nothing received moves the counter**, applied or refused: a tombstone refused on authorship grounds leaves the record alone and the counter where it was.
 *  2. **A counter that cannot move is no failure of the apply**, because the apply never writes it: with the counter collection refusing every seq above a
 *     ceiling, a tombstone above it is stored and the push is answered 200 (the pull cycle counts no error).
 *  3. **An apply that fails is the error reported** — as ever, with the counter no longer a second thing that can fail beside it: the push answers 500 for
 *     the view's refusal, the pull logs it and its watermark does not pass the tombstone.
 *  4. **A record re-created over a deletion held for it takes a version above that deletion**, though the counter stands far below it: this is what the
 *     counter bump used to buy, bought by the stamp.
 *
 * Faults are REAL: a view where a record collection should be (every write to it fails at the command level), and a validator on the counter collection
 * refusing a seq above 100 for one space. Each is installed for its case and removed after it, so the wipe between cases runs against ordinary collections.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-tombstone-moves-no-counter-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { withCollectionAsView, withCounterCeiling as counterCeiling } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const C = 'tsclock';
const F = 'tsclockfault';
/** Where the counter stands before every case that reads it. */
const STANDING = 5;
let door;

const ISSUER = { push: PEER_TOKEN.peerInstanceId, pull: PEER };
const tomb = (space, id, seq, issuer) => build.tombstone(space, id, 'fact', seq, { instanceId: issuer });
const author = (instanceId) => ({ author: { instanceId, instanceLabel: instanceId } });

async function deliver(name, space, tombstones) {
  if (name === 'push') return door.push('/tombstones', { tombstones }, { spaceId: space });
  await door.seedPeer(space, tombstones);
  return door.sync();
}

/**
 * `<space>_facts` as a view on `<space>_entities` while `fn` runs: every write to it fails at the command level, and
 * a read of it sees the entities — so a tombstone's target is found, authored by its issuer, and its delete fails.
 */
async function withFactsAView(space, targets, fn) {
  const db = door.mongo.getDb();
  if (targets.length > 0) await db.collection(`${space}_entities`).insertMany(targets);
  try { return await withCollectionAsView(db, `${space}_facts`, `${space}_entities`, fn); } finally {
    await db.collection(`${space}_entities`).deleteMany({});
  }
}

/** The counter collection refuses a seq above `ceiling` for `space` while `fn` runs (`_write-faults.mjs`). */
const withCounterCeiling = (space, ceiling, fn) => counterCeiling(door.mongo.getDb(), space, ceiling, fn);

describe('a delivered tombstone moves no counter, and a counter is never why a tombstone page fails', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsclock', spaces: [C, F] });
    // The counter collection must exist for collMod; a raise creates it.
    await door.raiseVersionTo('tsclock-probe', 1);
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the faults are real: the view refuses a write and the validator refuses a raise above its ceiling', async () => {
    const { raiseVersionTo } = await import('../../server/dist/util/version-stamp.js');
    await withFactsAView(F, [], async () => {
      await assert.rejects(door.coll(F, 'facts').deleteMany({ _id: 'x' }), /view/i);
    });
    await withCounterCeiling(F, 100, async () => {
      await raiseVersionTo(F, 50);
      await assert.rejects(raiseVersionTo(F, 500), /validation/i);
    });
  });

  for (const name of ['push', 'pull']) {
    describe(name, () => {
      it('a tombstone refused on authorship leaves the other record and the counter alone', async () => {
        // bundle-51: the fake peer of the pull door is this instance's UPSTREAM, and an upstream's tombstone now deletes what
        // the upstream delivered whoever wrote it — so the deletion this row needs REFUSED must come from a deliverer that is
        // not the upstream. The pull is re-pointed at a peer that is a subscriber (`both`: this instance publishes to it); the
        // push door's peer is no member of the network at all. Neither is the upstream, so authorship decides, as it did.
        if (name === 'pull') door.configure({ direction: 'both' });
        await door.coll(C, 'facts').insertOne(build.fact(C, 'theirs', 3, author('someone-else')));
        await door.setCounter(C, STANDING);
        const res = await deliver(name, C, [tomb(C, 'theirs', 90, ISSUER[name])]);
        if (name === 'push') assert.equal(res.counterAtResponse, 0, `push: the server wrote the counter (to ${res.counterAtResponse}) before it answered`);
        assert.equal(await door.counter(C), STANDING, `${name}: a tombstone at seq 90 was received and refused, and the counter is now ${await door.counter(C)}, not ${STANDING}`);
        assert.ok(await door.coll(C, 'facts').findOne({ _id: 'theirs' }), 'the other author\'s record was deleted');
      });

      it('a counter that cannot move fails nothing: the tombstone above its ceiling is stored and the call succeeds', async () => {
        const res = await withCounterCeiling(F, 100, () => deliver(name, F, [tomb(F, 'b1', 500, ISSUER[name])]));
        if (name === 'push') {
          assert.equal(res.code, 200, `the push answered ${res.code} over a counter nothing asked to move: ${JSON.stringify(res.body)}`);
        } else {
          assert.equal(res.errors, 0, `the pull cycle reported ${JSON.stringify(res)} over a counter nothing asked to move`);
        }
        assert.ok(await door.coll(F, 'tombstones').findOne({ _id: 'b1' }), 'the tombstone was not stored');
      });

      it('an apply that failed is the error reported, and the counter is not part of it', async () => {
        await door.setCounter(F, STANDING);
        const res = await withFactsAView(F, [build.entity(F, 'gone', 3, author(ISSUER[name]))],
          () => deliver(name, F, [tomb(F, 'gone', 300, ISSUER[name])]));
        if (name === 'push') assert.equal(res.code, 500, `an apply that failed answered ${res.code}`);
        assert.equal(await door.counter(F), STANDING, `${name}: the apply failed and the counter is now ${await door.counter(F)}: a received seq moved it`);
      });
    });
  }

  it('push: the apply error is the one reported (the view), under a counter that would have refused too', async () => {
    // A repeated fault is said once per window (`reportServerFailureOncePerWindow`): this case reads the line a first meeting leaves, so it starts a new window.
    const { forgetFaultReports } = await import('../../server/dist/util/report-failure.js');
    forgetFaultReports();
    const { result: res, lines } = await door.logsDuring(() => withCounterCeiling(F, 100, () =>
      withFactsAView(F, [build.entity(F, 'both', 3, author(ISSUER.push))],
        () => deliver('push', F, [tomb(F, 'both', 400, ISSUER.push)]))));
    assert.equal(res.code, 500, JSON.stringify(res.body));
    const report = lines.filter(l => /failed with a 5xx/.test(l));
    assert.equal(report.length, 1, `expected one 5xx report:\n${lines.join('\n')}`);
    assert.match(report[0], /view/i, `the 5xx reports something other than the apply error:\n${report[0]}`);
    assert.ok(!lines.some(l => /failed validation/i.test(l)), `a counter write was attempted (and refused by the validator) although an arrival moves none:\n${lines.join('\n')}`);
  });

  it('pull: the apply error is logged and the watermark does not pass the tombstone', async () => {
    const { lines } = await door.logsDuring(() => withCounterCeiling(F, 100, () =>
      withFactsAView(F, [build.entity(F, 'both', 3, author(ISSUER.pull))],
        () => deliver('pull', F, [tomb(F, 'both', 400, ISSUER.pull)]))));
    const applyLines = lines.filter(l => /is a view/i.test(l));
    assert.ok(applyLines.length >= 1, `the apply error is not reported at all:\n${lines.join('\n')}`);
    assert.ok(!lines.some(l => /failed validation/i.test(l)), `a counter write was attempted (and refused by the validator) although an arrival moves none:\n${lines.join('\n')}`);
    assert.ok((door.member().lastSeqReceived?.[F] ?? 0) < 400, 'the watermark moved past a tombstone whose apply failed');
  });

  it('a record re-created over a deletion held for it takes a version above that deletion, though the counter stands far below it', async () => {
    const fact = await import('../../server/dist/brain/fact.js');
    // A deletion of 'again' at seq 5001 was delivered by a peer, and this instance's counter never followed it.
    await door.setCounter(C, STANDING);
    const res = await door.push('/tombstones', { tombstones: [tomb(C, 'again-id', 5001, ISSUER.push)] }, { spaceId: C });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(await door.counter(C), STANDING, 'the delivery moved the counter');
    // The record comes back under the same id. It is stamped above the deletion, not above the counter.
    await door.coll(C, 'facts').insertOne(build.fact(C, 'again-id', 3, author(ISSUER.push)));
    await fact.updateFact(C, 'again-id', { fact: 'back again' });
    const after = await door.coll(C, 'facts').findOne({ _id: 'again-id' });
    assert.ok(after.seq > 5001, `the re-created record took seq ${after.seq}, not above the deletion held at 5001: every peer holding the tombstone would refuse it`);
  });
});
