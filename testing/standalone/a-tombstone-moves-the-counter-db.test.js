/**
 * Every tombstone a peer delivers advances this instance's seq counter — on both doors, whatever was done with it,
 * and a counter that could not be moved is never answered as success (bundle-46 plan row 5, rows (b) and (c) of the
 * vet disposition). Replaces `a-tombstone-advances-the-clock.test.js` (plan row 10, deleted with this file's
 * arrival): it read the bump's spelling in the route and the engine, so it could not survive the bump moving into the
 * apply. Its watermark assertion (`alsoCheck: { tombstones }` on both directions) lives on in
 * `one-watermark-every-transfer`; its arrival-writer assertion is held by the pull and push -db counter rows.
 *
 * ## The invariant, in `bumpSeq`'s own words
 *
 * *"Bump the local seq counter so future local writes always get a seq higher than any document received from this
 * peer."* A tombstone is received from a peer and carries the deleting instance's seq:
 *
 * ```text
 * a busy peer   (counter 5001) deletes a record      ->  tombstone, seq 5001
 * a quiet peer  (counter  300) receives it           ->  counter stays 300
 * the quiet peer re-creates it with the same id      ->  local seq 301
 * it pushes back                                     ->  tombstone.seq >= incoming.seq: refused as `tombstoned`
 * ```
 *
 * The comparison is the counter and not a second clock (`createdAt` against `deletedAt`): the protocol runs on one.
 *
 * ## The rules
 *
 *  1. **Over what was RECEIVED, not what was applied.** A tombstone refused on authorship grounds still tells us where
 *     that peer's clock is; advancing too far only skips seq numbers, not advancing far enough loses a record.
 *  2. **A failed bump with no other error fails the call** — a push answers 5xx and a pull cycle counts an error,
 *     never a 200 over a counter still behind what was received.
 *  3. **The bump runs even when the apply failed**, over what was admitted, so a page that half-landed does not leave
 *     the counter behind what did land.
 *  4. **A failed bump never hides an apply error**: the apply error is the one reported, the bump failure is logged.
 *
 * Faults are REAL: a view where a record collection should be (every write to it fails at the command level), and a
 * validator on the counter collection refusing a seq above 100 for one space. Each is installed for its case and
 * removed after it, so the wipe between cases runs against ordinary collections.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-tombstone-moves-the-counter-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const C = 'tsclock';
const F = 'tsclockfault';
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
  await db.collection(`${space}_facts`).drop();
  await db.createCollection(`${space}_facts`, { viewOn: `${space}_entities`, pipeline: [] });
  try { return await fn(); } finally {
    await db.collection(`${space}_facts`).drop();
    await db.createCollection(`${space}_facts`);
    await db.collection(`${space}_entities`).deleteMany({});
  }
}

/** The counter collection refuses a seq above `ceiling` for `space` while `fn` runs. */
async function withCounterCeiling(space, ceiling, fn) {
  const db = door.mongo.getDb();
  await db.command({ collMod: 'ythril_counters', validationLevel: 'strict', validationAction: 'error',
    validator: { $or: [{ _id: { $ne: space } }, { seq: { $lte: ceiling } }] } });
  try { return await fn(); } finally {
    await db.command({ collMod: 'ythril_counters', validator: {} });
  }
}

describe('a delivered tombstone moves the counter, and a counter that could not move is never success', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsclock', spaces: [C, F] });
    // The counter collection must exist for collMod; a bump creates it.
    await door.bumpSeq('tsclock-probe', 1);
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the faults are real: the view refuses a write and the validator refuses a bump above its ceiling', async () => {
    const { bumpSeq } = await import('../../server/dist/util/seq.js');
    await withFactsAView(F, [], async () => {
      await assert.rejects(door.coll(F, 'facts').deleteMany({ _id: 'x' }), /view/i);
    });
    await withCounterCeiling(F, 100, async () => {
      await bumpSeq(F, 50);
      await assert.rejects(bumpSeq(F, 500), /validation/i);
    });
  });

  for (const name of ['push', 'pull']) {
    describe(name, () => {
      it('a tombstone refused on authorship still advances the counter: its seq was received', async () => {
        await door.coll(C, 'facts').insertOne(build.fact(C, 'theirs', 3, author('someone-else')));
        const res = await deliver(name, C, [tomb(C, 'theirs', 90, ISSUER[name])]);
        const at = name === 'push' ? res.counterAtResponse : await door.counter(C);
        assert.ok(at >= 90,
          `${name}: the counter is at ${at} after a tombstone at seq 90 was received and refused — a record re-created `
          + 'here takes a seq below it and is refused as tombstoned by every peer holding it');
        assert.ok(await door.coll(C, 'facts').findOne({ _id: 'theirs' }), 'the other author\'s record was deleted');
      });

      it('a failed bump with no other error fails the call', async () => {
        const res = await withCounterCeiling(F, 100, () => deliver(name, F, [tomb(F, 'b1', 500, ISSUER[name])]));
        if (name === 'push') {
          assert.equal(res.code, 500, `the push answered ${res.code} over a counter it could not move: ${JSON.stringify(res.body)}`);
        } else {
          assert.equal(res.errors, 1, `the pull cycle reported ${JSON.stringify(res)} over a counter it could not move`);
        }
      });

      it('the bump runs even when the apply failed, over what was admitted', async () => {
        const res = await withFactsAView(F, [build.entity(F, 'gone', 3, author(ISSUER[name]))],
          () => deliver(name, F, [tomb(F, 'gone', 300, ISSUER[name])]));
        if (name === 'push') assert.equal(res.code, 500, `an apply that failed answered ${res.code}`);
        const at = await door.counter(F);
        assert.ok(at >= 300,
          `${name}: the apply failed and the counter stayed at ${at}, below the seq 300 it received — the bump must run `
          + 'in a finally, not after a step that can throw');
      });
    });
  }

  it('push: a failed bump is logged, never thrown over an apply error', async () => {
    const { result: res, lines } = await door.logsDuring(() => withCounterCeiling(F, 100, () =>
      withFactsAView(F, [build.entity(F, 'both', 3, author(ISSUER.push))],
        () => deliver('push', F, [tomb(F, 'both', 400, ISSUER.push)]))));
    assert.equal(res.code, 500, JSON.stringify(res.body));
    const report = lines.filter(l => /failed with a 5xx/.test(l));
    assert.equal(report.length, 1, `expected one 5xx report:\n${lines.join('\n')}`);
    assert.match(report[0], /view/i, `the 5xx reports something other than the apply error:\n${report[0]}`);
    assert.doesNotMatch(report[0], /failed validation/i, 'the bump failure replaced the apply error in the report');
    assert.ok(lines.some(l => !/failed with a 5xx/.test(l) && /failed validation/i.test(l)),
      `the bump failure under the apply error is not logged at all:\n${lines.join('\n')}`);
  });

  it('pull: a failed bump is logged, never thrown over an apply error', async () => {
    /*
     * The pull has no 5xx to read, so "the apply error is the one reported" is read from what the cycle logs about
     * the tombstone transfer: a line naming the apply's fault (the view), and the bump's own failure on a line of
     * its own — never the bump's failure standing in for the apply's.
     */
    const { lines } = await door.logsDuring(() => withCounterCeiling(F, 100, () =>
      withFactsAView(F, [build.entity(F, 'both', 3, author(ISSUER.pull))],
        () => deliver('pull', F, [tomb(F, 'both', 400, ISSUER.pull)]))));
    const applyLines = lines.filter(l => /is a view/i.test(l));
    assert.ok(applyLines.length >= 1, `the apply error is not reported at all:\n${lines.join('\n')}`);
    assert.ok(applyLines.every(l => !/failed validation/i.test(l)), 'the bump failure is folded into the apply error\'s report');
    assert.ok(lines.some(l => !/is a view/i.test(l) && /failed validation/i.test(l)),
      `the bump failure under the apply error is not logged at all:\n${lines.join('\n')}`);
    assert.ok((door.member().lastSeqReceived?.[F] ?? 0) < 400, 'the watermark moved past a tombstone whose apply failed');
  });
});
