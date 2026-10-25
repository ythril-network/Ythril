/**
 * A run of tombstones at ONE seq cannot wedge other members' tombstone transfers, and a prune never takes the unserved rest of a
 * run (bundle-52, `Q-295`; the same-seq defect of `Q-277` on the tombstone route). Re-pointed to positions for bundle-81 (design rev 8 §6).
 *
 * ## The defect
 *
 * A tombstone keeps its issuer's seq, and `POST /api/sync/tombstones` takes 5000 tombstones a request with any seq the issuer names, so a
 * peer token can plant a run of thousands at ONE seq. Paged by seq, a puller moves on from the last seq of a FULL group, so a group that is
 * full and all ONE seq cannot be paged past: the 5.6 puller held the member's whole receive mark below that seq every cycle, and one member
 * could stop every other member's deletions from replicating. And the prune trusts the recorded served mark as "every tombstone up to here
 * was served".
 *
 * ## What changed, and what is still true
 *
 * A tombstone now takes a POSITION on the instance that stores it, and a page is read by `(position, _id)`. A run planted through the push
 * door lands at distinct positions of the receiver's own clock, so it is no tie at all; the ties that remain are the LEGACY band, the rows
 * carried from 5.6 whose position is their seq. That band is what this file seeds directly, because it is what a pager can still stall on:
 *
 *  1. **A planted run is a run of seqs and not of positions.** 6000 tombstones at one seq, planted through a peer token in two requests,
 *     each lands at a position of its own (the stream's, above every carried one).
 *  2. **An upgraded puller pages past a run at ONE position.** 6000 carried tombstones at one position and one above, on the fake peer:
 *     the real engine applies all 6001 and its receive mark moves past the run, not to the position before it.
 *  3. **A `sinceSeq`-only puller is refused**, with the answer that names position paging (`400`), instead of being served the first
 *     5000 of the run and left to stop: the 5.x reading of the groups is gone.
 *  4. **The route pages a run by cursor, and records what it has served as the position BELOW the cursor's.** A cursor from the middle of
 *     a run reads the rest of it; following `nextCursor` serves every tombstone of the run once; and `lastPosServed` after a mid-run
 *     request is the position below the run, so a prune never takes the part of the run that has not been served.
 *
 * ## How a cursor is obtained here
 *
 * The tombstone route's cursor is the same pair cursor the record routes hand back, and it is OPAQUE: this file mints one by asking
 * `GET /facts` for the first of two facts at the run's position (their ids sort below the tombstones'), and never builds or decodes one.
 * Case 2 goes through the real engine and so does not depend on how the route is entered at all.
 *
 * Template: `a-tombstone-transfer-delivers-all-or-holds-db.test.js`.
 * Run: node --test testing/standalone/a-tombstone-run-at-one-seq-does-not-wedge-db.test.js (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { missingAndRepeated } from './_seq-tie-families.mjs';
import { positioned, positionedTombstone, seedRows, readMark } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tsrun';
/** The seq of the run AND, for a carried row, its position: the legacy band, where a run can tie. */
const RUN_SEQ = 50;
const RUN_SIZE = 6000;
const AFTER_SEQ = 60;
/** The route's clamp and the planting door's per-request cap, read from the sources of truth. */
let CLAMP, MAX_PER_REQUEST;
let door, prune;

/** The peer-bound token of the fake peer's own member: what makes a request count as that peer's for `lastPosServed`. */
const MEMBER_TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
/** The token that PLANTS in this instance's own space: a member peer delivering tombstones it issued itself. */
const PLANTING_TOKEN = Object.freeze({ ...PEER_TOKEN, peerInstanceId: PEER });

const runIds = () => Array.from({ length: RUN_SIZE }, (_, k) => `t-${String(k + 1).padStart(5, '0')}`);
const tomb = (space, id, seq) => build.tombstone(space, id, 'fact', seq, { instanceId: PEER });
/** A tombstone as a carried row stands: its position is its seq, so a run shares one. */
const carried = (space, id, seq) => positionedTombstone(space, id, 'fact', seq, { instanceId: PEER });

/** Plant tombstones through the push door as a peer token would, in requests of at most the door's cap. */
async function plant(space, tombstones) {
  let applied = 0;
  let requests = 0;
  for (let i = 0; i < tombstones.length; i += MAX_PER_REQUEST) {
    const r = await door.push('/tombstones', { tombstones: tombstones.slice(i, i + MAX_PER_REQUEST) }, { spaceId: space, token: PLANTING_TOKEN });
    assert.equal(r.code, 200, `planting: ${JSON.stringify(r.body)}`);
    applied += r.body.applied;
    requests++;
  }
  assert.equal(applied, tombstones.length, 'the planting door admitted every tombstone — the fixture is broken');
  return requests;
}

/** One GET /tombstones as the fake peer's member would send it. */
async function getTombstones(query) {
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await door.handler('get', '/tombstones')({ query: { networkId: door.NET, ...query }, params: {}, authToken: MEMBER_TOKEN, get: () => undefined }, res);
  return res;
}

/** The tombstone ids a response carries: the one `items` list of the position-paged answer. */
const idsOf = (body) => (body.items ?? []).map(x => x._id);

describe('a run of tombstones at one seq does not wedge a transfer', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsrun', spaces: [S] });
    ({ MAX_TOMBSTONES_PER_REQUEST: MAX_PER_REQUEST } = await import('../../server/dist/sync/tombstone-apply.js'));
    prune = await import('../../server/dist/brain/tombstone-prune.js');
    CLAMP = 5000;
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await door.coll(S, 'tombstones').deleteMany({});
    await door.coll(S, 'facts').deleteMany({});
    door.member().lastPosServed = {};
  });

  it('plants more than one request holds, and each planted tombstone lands at a position of its own', async () => {
    assert.ok(RUN_SIZE > MAX_PER_REQUEST, `a run of ${RUN_SIZE} fits one request of ${MAX_PER_REQUEST}`);
    assert.ok(RUN_SIZE > CLAMP, `a run of ${RUN_SIZE} fits one page of ${CLAMP}`);
    const requests = await plant(S, runIds().map(id => tomb(S, id, RUN_SEQ)));
    assert.equal(requests, 2, 'the run goes in over two requests');
    assert.equal(await door.coll(S, 'tombstones').countDocuments({ seq: RUN_SEQ }), RUN_SIZE, 'the run keeps its issuer\'s seq as its version');
    const positions = await door.coll(S, 'tombstones').distinct('pos', { seq: RUN_SEQ });
    assert.equal(positions.length, RUN_SIZE, 'the planted run shares positions: a tombstone takes a position at receipt, never its issuer\'s seq');
    assert.ok(positions.every(p => p > 2 ** 50), 'a planted tombstone landed inside the legacy band, where only carried rows live');
  });

  describe('an upgraded puller (the real engine)', () => {
    it('pages past a run of 6000 at one position: every tombstone is applied and the receive mark moves past it', async () => {
      // On the fake peer's own storage: no network carries `peer-<space>`, so a member's token cannot plant there; the shape is a run of
      // CARRIED rows (position = seq), which is the tie a pager can still stall on, with one tombstone above it.
      const all = [...runIds().map(id => carried(S, id, RUN_SEQ)), carried(S, 'after-the-run', AFTER_SEQ)];
      await door.seedPeer(S, all);
      // A record the peer holds above the run, so the mark has somewhere to go that the tombstones do not set.
      door.state.records[S] = { facts: [positioned(build.fact(S, 'record-above', 100, { author: PEER_AUTHOR }))] };
      const { lines } = await door.logsDuring(() => door.sync());
      const stored = (await door.coll(S, 'tombstones').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id);
      const { missing } = missingAndRepeated(all.map(t => t._id), stored);
      assert.deepEqual(missing.slice(0, 5), [],
        `${missing.length} of ${all.length} tombstones were never applied (first: ${missing.slice(0, 3).join(', ')}) — the puller could not page past `
        + `the ${RUN_SIZE} tombstones at position ${RUN_SEQ}. Log: ${lines.filter(l => /tombstone/i.test(l)).join(' | ')}`);
      const mark = readMark(door, 'received', S);
      assert.ok(Number.isSafeInteger(mark) && mark > AFTER_SEQ,
        `the receive mark is ${String(mark)}: held at or below the run, so one member planting a run at one position would stop every other member's deletions`);
    });
  });

  describe('a sinceSeq-only puller (a 5.x client)', () => {
    it('is refused with the answer that names position paging, and is served no part of the run', async () => {
      await seedRows(door, S, 'tombstones', [...runIds().map(id => carried(S, id, RUN_SEQ)), carried(S, 'after-the-run', AFTER_SEQ)]);
      for (const query of [{ sinceSeq: '0', limit: String(CLAMP) }, { sinceSeq: String(RUN_SEQ - 1) }, { sinceSeq: '0', cursor: 'bm90LWEtY3Vyc29y' }]) {
        const res = await getTombstones({ spaceId: S, ...query });
        assert.equal(res.code, 400, `a sinceSeq request ${JSON.stringify(query)} was answered ${res.code}: the 5.x grouped reading is gone`);
        assert.match(String(res.body?.error), /afterPos/, 'the refusal does not name the start a 6.0 server takes');
        assert.equal(idsOf(res.body).length, 0, 'a refused request was served tombstones');
      }
    });
  });

  describe('the route, by cursor', () => {
    /** A cursor positioned at the FIRST of two facts at the run's position, minted by the record route (opaque). */
    async function cursorAtRunStart() {
      await seedRows(door, S, 'facts', [positioned(build.fact(S, 'a-1', RUN_SEQ)), positioned(build.fact(S, 'a-2', RUN_SEQ))]);
      await door.raiseVersionTo(S, 100);
      const page = await door.pull('/facts', { spaceId: S, afterPos: String(RUN_SEQ - 1), limit: '1' });
      assert.ok(page.nextCursor, 'the fact route handed no cursor for a one-row page of two — the fixture is broken');
      return page.nextCursor;
    }
    const seedRun = async () => {
      const old = Array.from({ length: 10 }, (_, k) => carried(S, `old-${k + 1}`, 10));
      await seedRows(door, S, 'tombstones', [...old, ...runIds().map(id => carried(S, id, RUN_SEQ))]);
      return old;
    };

    it('serves every tombstone of the run exactly once by following nextCursor, and records the position BELOW the run as served', async () => {
      await seedRun();
      let cursor = await cursorAtRunStart();

      const got = [];
      let firstServed;
      for (let page = 0; page < 40; page++) {
        const res = await getTombstones({ spaceId: S, limit: '1000', cursor });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        got.push(...idsOf(res.body));
        if (page === 0) {
          firstServed = door.member().lastPosServed?.[S];
          assert.ok(typeof res.body.nextCursor === 'string' && res.body.nextCursor,
            'the tombstone route handed back no nextCursor for a page that ended inside a run of equal positions');
        }
        if (!res.body.nextCursor) break;
        cursor = res.body.nextCursor;
      }
      const { missing, repeated, unexpected } = missingAndRepeated(runIds(), got);
      assert.deepEqual({ missing: missing.length, repeated, unexpected }, { missing: 0, repeated: [], unexpected: [] },
        `following nextCursor from the start of the run did not serve it exactly once (never served: ${missing.slice(0, 3).join(', ')}; unexpected: ${unexpected.slice(0, 3).join(', ')})`);
      assert.equal(firstServed, RUN_SEQ - 1,
        `a cursor request from inside the run at position ${RUN_SEQ} recorded ${firstServed} as served; everything BELOW the cursor's position was delivered and part of the run at it was not`);
    });

    it('a prune after a request from the middle of the run keeps the rest of the run, and takes what is below it', async () => {
      const old = await seedRun();
      const cursor = await cursorAtRunStart();
      const res = await getTombstones({ spaceId: S, limit: '100', cursor });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(idsOf(res.body).length, 100, 'a page of 100 was asked of a run of 6000 and a different number came back');
      assert.equal(door.member().lastPosServed?.[S], RUN_SEQ - 1,
        `a cursor request from inside the run at position ${RUN_SEQ} recorded ${door.member().lastPosServed?.[S]} as served; the prune below takes what that says`);

      const result = await prune.pruneAllTombstones();
      assert.ok(result.removed >= old.length,
        `the prune removed ${result.removed} tombstone(s): the ten below the run are served and must go (blocked: ${JSON.stringify(result.blocked)}) — without this the next assertion proves nothing`);
      assert.equal(await door.coll(S, 'tombstones').countDocuments({ pos: RUN_SEQ }), RUN_SIZE,
        'the prune took tombstones of the run that no peer has been served');
      assert.equal(await door.coll(S, 'tombstones').countDocuments({ pos: 10 }), 0, 'the prune left tombstones below the served position');
    });
  });
});
