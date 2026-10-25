/**
 * A fork tombstone this instance's authority declines does not delete the fork: it MARKS it for a decision here (Q-624 design §9a, test 25).
 *
 * ## What it prevents
 *
 * A resolve deletes the resolving instance's copy of a fork behind an issued-here tombstone. A fork row keeps the author of the copy it was
 * made from, which is another instance by construction, so on a peer `authorises` declines that tombstone (`not_author`, `not_issuer`,
 * `not_upstream`) and today the decline is only COUNTED: the fork stays, listed in Review, and nothing says another instance already decided
 * it. Deleting it anyway would be exactly the deletion the authority refused. The decline path therefore writes `_resolvedElsewhere` on
 * the fork row (an array of `{ by, at, seq, proven, via? }`, one entry per issuer, at most 16, the highest seqs kept), and the row stays.
 *
 * ## The rule, for every forking kind
 *
 *  - each decline reason on a fork row writes a mark with `proven` set right (true when the deliverer IS the issuer; false, with `via` the
 *    deliverer, when it only relays) and deletes nothing;
 *  - a decline on a row that is no fork writes no mark;
 *  - 17 issuers leave 16 entries, the highest seqs;
 *  - a fork re-delivered by its author keeps its mark;
 *  - a peer's pushed `_resolvedElsewhere` is dropped on arrival (a peer cannot plant a decision owed here);
 *  - the field is local-only (so merkle does not hash it: a marked and an unmarked copy have ONE leaf) and is in `RESTORED_LOCAL_FIELDS`
 *    (so an export and a restore keep it). Both are read from `sync/local-only-fields.js`; the full restart/export/restore round is
 *    held by the mesh test;
 *  - a resolve here removes the mark with the row.
 *
 * Run: node --test testing/standalone/a-declined-fork-tombstone-marks-the-fork-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, peerToken } from './_push-door.mjs';
import { FORK_KINDS, initForkFixtures, seedFork, reviewDoors } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();
const S = 'q624decline';
const UP = 'q624-publisher';
const UP_SPACE = 'q624upstream';
/** A subscriber's network: the publisher is a member this instance PULLS from, so a delivery from it is the upstream's. */
const NETWORK = {
  id: 'q624-up-net', label: 'Upstream', type: 'pubsub', origin: 'joined', votes: [], votingDeadlineHours: 24, spaces: [UP_SPACE],
  members: [{ instanceId: UP, label: 'Publisher', url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'pull' }],
};

describe('a declined fork tombstone marks the fork', { skip }, () => {
  let door; let doors; let locals;

  before(async () => {
    door = await openPushDoor({ suite: 'q624t3_decline', networks: [NETWORK],
      spaces: [{ id: S, label: 'Decline', folders: [], meta: {} }, { id: UP_SPACE, label: 'Upstream', folders: [], meta: {} }] });
    await initForkFixtures();
    doors = await reviewDoors(door, S);
    locals = await import('../../server/dist/sync/local-only-fields.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); await door.wipe(UP_SPACE); });

  /** A subject and its fork (both authored by the push door's default peer), and the tombstone wire a peer sends for the fork. */
  async function stored(kind, space = S) {
    const k = FORK_KINDS[kind];
    const subject = `subject-${kind}`;
    await door.coll(space, k.family).insertOne({ ...k.row(space, subject, 5, { pos: 5, posAtSeq: 5 }) });
    const fork = await seedFork(door, space, kind, subject, 5, k.alt);
    return { k, subject, fork };
  }
  const wire = (space, id, kind, issuer, seq) => build.tombstone(space, id, kind, seq, { instanceId: issuer });
  const send = async (space, tombs, deliverer) => {
    const r = await door.push('/tombstones', { tombstones: tombs }, { spaceId: space, token: peerToken(deliverer) });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    return r;
  };
  const markOf = async (space, family, id) => (await door.coll(space, family).findOne({ _id: id }))?._resolvedElsewhere;

  for (const kind of Object.keys(FORK_KINDS)) {
    describe(kind, () => {
      it('not_author: the deliverer is the issuer and does not govern the fork: the fork stays, marked proven', async () => {
        const { k, fork } = await stored(kind);
        await send(S, [wire(S, fork._id, kind, 'peer-b', 9)], 'peer-b');
        assert.equal(await door.coll(S, k.family).countDocuments({ _id: fork._id }), 1, 'the declined tombstone deleted the fork');
        const mark = await markOf(S, k.family, fork._id);
        assert.deepEqual(mark?.map(m => [m.by, m.seq, m.proven]), [['peer-b', 9, true]], `no proven mark for the issuer: ${JSON.stringify(mark)}`);
        assert.equal(typeof mark[0].at, 'string', 'the mark does not say when the issuer decided');
      });

      it('not_issuer: a relay names another issuer: the fork stays, marked unproven, naming who relayed it', async () => {
        const { k, fork } = await stored(kind);
        await send(S, [wire(S, fork._id, kind, 'peer-c', 9)], 'peer-b');
        assert.equal(await door.coll(S, k.family).countDocuments({ _id: fork._id }), 1, 'the declined tombstone deleted the fork');
        const mark = await markOf(S, k.family, fork._id);
        assert.deepEqual(mark?.map(m => [m.by, m.proven, m.via]), [['peer-c', false, 'peer-b']], `no unproven mark naming the relay: ${JSON.stringify(mark)}`);
      });

      it('not_upstream: the upstream relays an issuer it does not prove: the fork stays, marked unproven', async () => {
        const { k, fork } = await stored(kind, UP_SPACE);
        await send(UP_SPACE, [wire(UP_SPACE, fork._id, kind, 'peer-c', 9)], UP);
        assert.equal(await door.coll(UP_SPACE, k.family).countDocuments({ _id: fork._id }), 1, 'the declined tombstone deleted the fork');
        const mark = await markOf(UP_SPACE, k.family, fork._id);
        assert.deepEqual(mark?.map(m => [m.by, m.proven, m.via]), [['peer-c', false, UP]], `no mark on a not_upstream decline: ${JSON.stringify(mark)}`);
      });

      it('17 issuers leave 16 entries, the highest seqs', async () => {
        const { k, fork } = await stored(kind);
        for (let i = 1; i <= 17; i++) await send(S, [wire(S, fork._id, kind, `peer-${i}`, i)], `peer-${i}`);
        const mark = await markOf(S, k.family, fork._id);
        assert.equal(mark?.length, 16, `${mark?.length} entries after 17 issuers: the bound sits in the writer`);
        assert.equal(Math.min(...mark.map(m => m.seq)), 2, 'the entry kept out was not the lowest seq');
      });

      it('a fork re-delivered by its author keeps its mark, and a peer cannot plant one', async () => {
        const { k, fork } = await stored(kind);
        await send(S, [wire(S, fork._id, kind, 'peer-b', 9)], 'peer-b');
        const { _resolvedElsewhere, pos, posAtSeq, ...redelivered } = await door.coll(S, k.family).findOne({ _id: fork._id });
        const again = await door.push('/batch-upsert', { [k.family]: [redelivered] }, { spaceId: S });
        assert.equal(again.code, 200, JSON.stringify(again.body));
        assert.deepEqual((await markOf(S, k.family, fork._id))?.map(m => m.by), ['peer-b'], 'a re-delivery cleared a decision this instance still owes');
        const other = await seedFork(door, S, kind, `subject-${kind}`, 5, { ...k.alt, ...(kind === 'fact' ? { fact: 'a third version' } : kind === 'entity' ? { name: 'Third' } : kind === 'chrono' ? { title: 'third' } : { description: 'third' }) });
        const { pos: p2, posAtSeq: q2, ...planted } = other;
        await door.coll(S, k.family).deleteOne({ _id: other._id });
        await door.push('/batch-upsert', { [k.family]: [{ ...planted, _resolvedElsewhere: [{ by: 'liar', at: 'x', seq: 99, proven: true }] }] }, { spaceId: S });
        assert.equal(await markOf(S, k.family, other._id), undefined, 'a peer planted a mark by push');
      });

      it('a resolve here removes the mark with the row', async () => {
        const { k, fork } = await stored(kind);
        await send(S, [wire(S, fork._id, kind, 'peer-b', 9)], 'peer-b');
        const r = await doors.resolve.MCP(kind, fork._id, 'parent');
        assert.ok(r.ok, `resolve refused: ${r.sentence}`);
        assert.equal(await door.coll(S, k.family).countDocuments({ _id: fork._id }), 0, 'the fork is still stored after its resolve');
        assert.equal((await door.coll(S, 'tombstones').findOne({ _id: fork._id }))?.issuedHere, true, 'the resolve left no tombstone issued here');
      });
    });
  }

  it('a decline on a row that is no fork writes no mark', async () => {
    await door.coll(S, 'entities').insertOne(build.entity(S, 'plain', 5));
    await send(S, [wire(S, 'plain', 'entity', 'peer-b', 9)], 'peer-b');
    assert.equal(await door.coll(S, 'entities').countDocuments({ _id: 'plain' }), 1, 'fixture check: the tombstone deleted a row its issuer did not author');
    assert.equal((await door.coll(S, 'entities').findOne({ _id: 'plain' }))._resolvedElsewhere, undefined, 'a non-fork row was marked');
  });

  it('the mark is local-only (never hashed) and restored by an import', async () => {
    assert.ok(locals.LOCAL_ONLY_FIELDS.has('_resolvedElsewhere'), '_resolvedElsewhere is not in LOCAL_ONLY_FIELDS: merkle hashes it and the arrival writer keeps a peer\'s copy');
    assert.ok(locals.RESTORED_LOCAL_FIELDS.has('_resolvedElsewhere'), '_resolvedElsewhere is not in RESTORED_LOCAL_FIELDS: a restore forgets a decision owed here');
    const { docLeaf } = await import('../../server/dist/brain/merkle.js');
    const { fork } = await stored('fact');
    const marked = { ...fork, _resolvedElsewhere: [{ by: 'peer-b', at: '2026-10-25T00:00:00.000Z', seq: 9, proven: true }] };
    assert.equal(docLeaf('facts', marked), docLeaf('facts', fork), 'two instances that differ only in their marks hash differently');
  });
});
