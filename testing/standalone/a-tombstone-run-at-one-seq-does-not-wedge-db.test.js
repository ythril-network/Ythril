/**
 * A run of tombstones at ONE seq cannot wedge other members' tombstone transfers, and a prune never takes the unserved rest of a
 * run (bundle-52, `Q-295`; the same-seq defect of `Q-277` on the tombstone route).
 *
 * ## The defect
 *
 * `GET /api/sync/tombstones` serves `seq > sinceSeq`, per type, at most `limit` (clamped at 5000) of each. A puller moves on from
 * the last seq of a FULL group, so a group that is full and all ONE seq cannot be paged past: the 5.6 puller asks again at the
 * maximum, then stops, logs it, and holds the member's whole receive watermark below that seq every cycle. Any peer token can plant
 * such a run — `POST /api/sync/tombstones` takes 5000 tombstones a request and an issuer may name any seq — so one member could
 * stop every other member's deletions from replicating. And `recordServedSeq` records the `sinceSeq` a peer asked from, which is
 * what the tombstone prune trusts as "every tombstone up to here was served".
 *
 * ## The rules this file holds
 *
 *  1. **An upgraded puller pages past a run.** 6000 tombstones at one seq, planted through a peer token in two requests, and one
 *     later: the real engine applies all 6001 and its receive watermark reaches the record transfer's, not the run's seq - 1.
 *  2. **A legacy puller (sinceSeq only) still stops, and the documented outcome is held, not fixed.** The 5.6 client's loop is
 *     restated here (the base engine is what it is run from, and cannot be run against a server from this tree), and its
 *     outcome — the first 5000 of the run, then a stop naming seq 50 — is asserted as it stands. The legacy read is unchanged on
 *     purpose: an old client reads "group full" as "more may follow", so a changed shape would be misread.
 *  3. **The route pages a run by cursor, and records what it has served as `cursor.seq - 1`.** A cursor from the middle of a run
 *     reads the rest of it; following `nextCursor` serves every tombstone of the run once; and `lastSeqServed` after a mid-run
 *     request is the seq BELOW the run, so a prune never takes the part of the run that has not been served.
 *
 * ## How a cursor is obtained here
 *
 * The tombstone route's cursor is "the same pair cursor" the record routes hand back, and it is OPAQUE: this file mints one by
 * asking `GET /facts` for the first of two facts at the run's seq (their ids sort below the tombstones'), and never builds or
 * decodes one. Rule 1 goes through the real engine and so does not depend on how the route is entered at all.
 *
 * ## What "red at base" is
 *
 * Rule 1 fails with the 1001 tombstones never applied and the watermark held; rule 3 fails because the route ignores `cursor` and
 * hands back no `nextCursor`. Rule 2 holds at base and after: it is a characterisation of what the fix does not change.
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

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'tsrun';
const RUN_SEQ = 50;
const RUN_SIZE = 6000;
const AFTER_SEQ = 60;
/** The route's clamp and the planting door's per-request cap, read from the sources of truth. */
let CLAMP, MAX_PER_REQUEST, TOMBSTONE_TYPES, TOMBSTONE_COLLECTION;
let door, prune;

/** The peer-bound token of the fake peer's own member: what makes a request count as that peer's for `lastSeqServed`. */
const MEMBER_TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
/** The token that PLANTS in this instance's own space: a member peer delivering tombstones it issued itself. */
const PLANTING_TOKEN = Object.freeze({ ...PEER_TOKEN, peerInstanceId: PEER });

const runIds = () => Array.from({ length: RUN_SIZE }, (_, k) => `t-${String(k + 1).padStart(5, '0')}`);
const tomb = (space, id, seq) => build.tombstone(space, id, 'fact', seq, { instanceId: PEER });

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

/** The tombstone ids a response carries, across every type's group. */
const idsOf = (body) => TOMBSTONE_TYPES.flatMap(t => (body[TOMBSTONE_COLLECTION[t]] ?? []).map(x => x._id));

describe('a run of tombstones at one seq does not wedge a transfer', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsrun', spaces: [S] });
    ({ TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } = await import('../../server/dist/config/types.js'));
    ({ MAX_TOMBSTONES_PER_REQUEST: MAX_PER_REQUEST } = await import('../../server/dist/sync/tombstone-apply.js'));
    prune = await import('../../server/dist/brain/tombstone-prune.js');
    CLAMP = 5000;
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await door.coll(S, 'tombstones').deleteMany({});
    door.member().lastSeqServed = {};
  });

  it('plants more than one request holds, so the run is a real one', async () => {
    assert.ok(RUN_SIZE > MAX_PER_REQUEST, `a run of ${RUN_SIZE} fits one request of ${MAX_PER_REQUEST}`);
    assert.ok(RUN_SIZE > CLAMP, `a run of ${RUN_SIZE} fits one page of ${CLAMP}`);
    assert.ok(TOMBSTONE_TYPES.length >= 5, `only ${TOMBSTONE_TYPES.length} tombstone type(s) — the vocabulary did not load`);
    const requests = await plant(S, runIds().map(id => tomb(S, id, RUN_SEQ)));
    assert.equal(requests, 2, 'the run goes in over two requests');
    assert.equal(await door.coll(S, 'tombstones').countDocuments({ seq: RUN_SEQ }), RUN_SIZE);
  });

  describe('an upgraded puller (the real engine)', () => {
    it('pages past a run of 6000 at one seq: every tombstone is applied and the receive watermark moves on', async () => {
      // On the fake peer's own storage: no network carries `peer-<space>`, so a member's token cannot plant there; the shape
      // is the one `plant` makes in the first case (6000 at one seq, one above), stored as the peer's own.
      const all = [...runIds().map(id => tomb(S, id, RUN_SEQ)), tomb(S, 'after-the-run', AFTER_SEQ)];
      await door.seedPeer(S, all);
      // A record the peer holds above the run, so the receive watermark has somewhere to go that the tombstones do not set.
      door.state.records[S] = { facts: [build.fact(S, 'record-above', 100, { author: PEER_AUTHOR })] };
      const { lines } = await door.logsDuring(() => door.sync());
      const stored = (await door.coll(S, 'tombstones').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id);
      const { missing } = missingAndRepeated(all.map(t => t._id), stored);
      assert.deepEqual(missing.slice(0, 5), [],
        `${missing.length} of ${all.length} tombstones were never applied (first: ${missing.slice(0, 3).join(', ')}) — the puller could not page past `
        + `the ${RUN_SIZE} tombstones at seq ${RUN_SEQ}. Log: ${lines.filter(l => /tombstone/i.test(l)).join(' | ')}`);
      assert.equal(door.member().lastSeqReceived?.[S], 100,
        'the receive watermark was held below the run: one member planting a run at one seq stops every other member\'s deletions');
    });
  });

  describe('a legacy puller (sinceSeq only) — characterised, not fixed', () => {
    /** The 5.6 client's tombstone loop (`pageTombstones`, `sync/tombstone-transfer.ts` at 5.6), restated against the real route. */
    async function legacyPull(space) {
      const seen = new Set();
      let cursor = 0;
      let limit = CLAMP;
      for (let pages = 0; pages < 200; pages++) {
        const res = await door.pull('/tombstones', { spaceId: space, sinceSeq: String(cursor), limit: String(limit) });
        let fullLast = Infinity;
        for (const t of TOMBSTONE_TYPES) {
          const group = res[TOMBSTONE_COLLECTION[t]] ?? [];
          for (const x of group) seen.add(x._id);
          if (group.length >= limit) fullLast = Math.min(fullLast, group[group.length - 1].seq);
        }
        if (fullLast === Infinity) return { done: true, seen, cursor };
        const next = fullLast - 1;
        if (next <= cursor) {
          if (limit < MAX_PER_REQUEST) { limit = MAX_PER_REQUEST; continue; }
          return { done: false, seen, stuckAt: cursor + 1 };
        }
        cursor = next;
      }
      return { done: false, seen, stuckAt: -1 };
    }

    it('still stops at the run, having read its first 5000, and never sees what follows (the documented outcome)', async () => {
      await plant(S, [...runIds().map(id => tomb(S, id, RUN_SEQ)), tomb(S, 'after-the-run', AFTER_SEQ)]);
      const out = await legacyPull(S);
      assert.equal(out.done, false, 'a sinceSeq-only puller paged past a full page of one seq — the legacy read changed shape, and an old client misreads the new one');
      assert.equal(out.stuckAt, RUN_SEQ, `the legacy puller stops naming seq ${RUN_SEQ} (it named ${out.stuckAt})`);
      assert.equal(out.seen.size, CLAMP, `the legacy read serves ${CLAMP} of the run, per type and unchanged (it served ${out.seen.size})`);
      assert.ok(!out.seen.has('after-the-run'), 'the tombstone after the run reached a puller that cannot page past it');
    });
  });

  describe('the route, by cursor', () => {
    /** A cursor positioned at the FIRST of two facts at the run's seq, minted by the record route (opaque). */
    async function cursorAtRunStart() {
      const facts = [build.fact(S, 'a-1', RUN_SEQ), build.fact(S, 'a-2', RUN_SEQ)];
      await door.coll(S, 'facts').insertMany(facts.map(f => ({ ...f })));
      await door.bumpSeq(S, 100);
      const page = await door.pull('/facts', { spaceId: S, sinceSeq: String(RUN_SEQ - 1), limit: '1' });
      assert.ok(page.nextCursor, 'the fact route handed no cursor for a one-row page of two — the fixture is broken');
      return page.nextCursor;
    }

    it('serves every tombstone of the run exactly once by following nextCursor, and records the seq BELOW the run as served', async () => {
      const old = Array.from({ length: 10 }, (_, k) => tomb(S, `old-${k + 1}`, 10));
      await plant(S, [...old, ...runIds().map(id => tomb(S, id, RUN_SEQ))]);
      let cursor = await cursorAtRunStart();

      const got = [];
      let firstServed;
      for (let page = 0; page < 40; page++) {
        const res = await getTombstones({ spaceId: S, limit: '1000', cursor });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        got.push(...idsOf(res.body));
        if (page === 0) {
          firstServed = door.member().lastSeqServed?.[S];
          assert.ok(typeof res.body.nextCursor === 'string' && res.body.nextCursor,
            'the tombstone route handed back no nextCursor for a page that ended inside a run of equal seqs — a cursor request is read by seq alone');
        }
        if (!res.body.nextCursor) break;
        cursor = res.body.nextCursor;
      }
      const { missing, repeated, unexpected } = missingAndRepeated(runIds(), got);
      assert.deepEqual({ missing: missing.length, repeated, unexpected }, { missing: 0, repeated: [], unexpected: [] },
        `following nextCursor from the start of the run did not serve it exactly once (never served: ${missing.slice(0, 3).join(', ')}; unexpected: ${unexpected.slice(0, 3).join(', ')})`);
      assert.equal(firstServed, RUN_SEQ - 1,
        `a cursor request from inside the run at seq ${RUN_SEQ} recorded ${firstServed} as served; everything BELOW the cursor's seq was delivered and part of the run at it was not`);
    });

    it('a prune after a request from the middle of the run keeps the rest of the run, and takes what is below it', async () => {
      const old = Array.from({ length: 10 }, (_, k) => tomb(S, `old-${k + 1}`, 10));
      await plant(S, [...old, ...runIds().map(id => tomb(S, id, RUN_SEQ))]);
      const cursor = await cursorAtRunStart();
      const res = await getTombstones({ spaceId: S, limit: '100', cursor });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(idsOf(res.body).length, 100, 'a page of 100 was asked of a run of 6000 and a different number came back');
      assert.equal(door.member().lastSeqServed?.[S], RUN_SEQ - 1,
        `a cursor request from inside the run at seq ${RUN_SEQ} recorded ${door.member().lastSeqServed?.[S]} as served; the prune below takes what that says`);

      const result = await prune.pruneAllTombstones();
      assert.ok(result.removed >= old.length,
        `the prune removed ${result.removed} tombstone(s): the ten below the run are served and must go (blocked: ${JSON.stringify(result.blocked)}) — without this the next assertion proves nothing`);
      assert.equal(await door.coll(S, 'tombstones').countDocuments({ seq: RUN_SEQ }), RUN_SIZE,
        'the prune took tombstones of the run that no peer has been served');
      assert.equal(await door.coll(S, 'tombstones').countDocuments({ seq: 10 }), 0, 'the prune left tombstones below the served seq');
    });
  });
});
