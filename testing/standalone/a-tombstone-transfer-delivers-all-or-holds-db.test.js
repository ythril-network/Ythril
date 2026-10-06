/**
 * A tombstone transfer delivers every tombstone up to the horizon, or holds the member's watermark where it stopped
 * and says so — in both directions (`Q-237`, bundle-46 plan rows 4 and 6, and the vet's gzip acceptance row).
 *
 * ## The defect
 *
 * The pull asked `GET /api/sync/tombstones` once, with no `limit`, so the peer served its default of 1000 per type —
 * and the transfer reported itself complete. Every deletion past the thousandth was never applied, and the record
 * watermark moved past it, so it was never asked for again. The push pages, but moves its cursor to the LAST seq of
 * a page and asks for `seq > cursor`: a run of equal seqs across the page boundary loses every element of the run
 * the first page did not hold. Equal seqs are legitimate on the wire — a peer relays tombstones issued by several
 * instances, each with its own clock.
 *
 * ## The rules, each against the real engine and a fake peer serving the real GET handler (`_pull-door.mjs`)
 *
 *  1. **Everything is applied**: more tombstones than one page holds, with a run of equal seqs across the boundary.
 *  2. **A refused element does not move the cursor**: the page's last element is one the receiver refused, and the
 *     next page is asked from the peer's position after it (bundle-52: the cursor is the SERVER's, never read off an
 *     element). An element whose seq is not the one the peer's cursor names is not followed at all: the transfer stops.
 *  3. **A whole page of one seq from a peer WITHOUT the cursor mode cannot be paged past** (a 5.6 peer; bundle-52 gives the
 *     mode, and `a-tombstone-run-at-one-seq-does-not-wedge-db` holds that a peer with it pages any run), so the transfer
 *     answers `truncated`, warns naming the space, the peer and the seq, and the record watermark stays below the
 *     deletions it did not apply.
 *  4. **The push pages by `(seq, _id)`**, for both shapes of tie and for a run longer than a page.
 *  5. **A full page is affordable**: the pull asks at the handler's clamp (5000 per type) and the answer arrives
 *     compressed, under the `boundedJson` cap, every type full.
 *  6. **Characterised, must not get worse**: a record the peer re-created after deleting it survives the tombstone
 *     being pulled again (a capped watermark re-pulls it), because the tombstones are applied before the records.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-tombstone-transfer-delivers-all-or-holds-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_LABEL, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tspage';
/** The GET handler's clamp: the most one request can be served per type, read from the handler's source of truth. */
const CLAMP = 5000;
let door, TOMBSTONE_TYPES, TOMBSTONE_COLLECTION, MAX_INGEST_SEQ;

const tomb = (id, seq, type = 'fact') => build.tombstone(S, id, type, seq, { instanceId: PEER });
/** `n` tombstones; position i (1-based) gets `seqAt(i)`. */
const run = (n, seqAt, prefix = 't') => Array.from({ length: n }, (_, k) => tomb(`${prefix}-${k + 1}`, seqAt(k + 1)));
const storedIds = async () => new Set((await door.coll(S, 'tombstones').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id));
const missing = (want, have) => want.filter(t => !have.has(t._id)).map(t => t._id);

describe('a tombstone transfer delivers everything up to the horizon, or holds and says so', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tspage', spaces: [S] });
    ({ TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } = await import('../../server/dist/config/types.js'));
    ({ MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the clamp this file pages around is the handler\'s', async () => {
    // Re-anchor rather than page around a number the handler no longer serves.
    await door.seedPeer(S, run(CLAMP + 1, i => i, 'clamp'));
    const body = await door.pull('/tombstones', { spaceId: `peer-${S}`, sinceSeq: '0', limit: String(CLAMP * 10) });
    assert.equal(body.facts.length, CLAMP, `GET /tombstones clamps at ${body.facts.length}, not ${CLAMP} — re-anchor`);
  });

  describe('pull', () => {
    it('more tombstones than one page holds are all applied, with a run of equal seqs across the boundary', async () => {
      // Positions 1..4994 unique; 4995..5010 all seq 4995, so the run straddles the 5000th element.
      const all = run(CLAMP + 10, i => Math.min(i, CLAMP - 5));
      await door.seedPeer(S, all);
      await door.coll(S, 'facts').insertMany(all.slice(-16).map(t => build.fact(S, t._id, 1, { author: PEER_AUTHOR })));
      await door.sync();
      const lost = missing(all, await storedIds());
      assert.deepEqual(lost.slice(0, 10), [],
        `${lost.length} of ${all.length} pulled tombstones were never applied (first: ${lost.slice(0, 5).join(', ')}), and the `
        + 'record watermark moved past them, so they are never asked for again');
      assert.equal(await door.coll(S, 'facts').countDocuments(), 0, 'a record the run of equal seqs deletes is still here');
    });

    it('an element the receiver refuses does not move the cursor past the ones after it', async () => {
      const all = run(CLAMP + 1, i => i);
      await door.seedPeer(S, all);
      // The first page's last element arrives malformed (its `instanceId` is not a string): the receiver refuses it, and the
      // next page is asked from the SERVER's position after it — the cursor is never read off an element it refused.
      door.state.tamper = (body, asked) => {
        if (asked.sinceSeq !== '0' || !body.facts?.length) return body;
        const facts = [...body.facts];
        facts[facts.length - 1] = { ...facts[facts.length - 1], instanceId: 12 };
        return { ...body, facts };
      };
      await door.sync();
      const have = await storedIds();
      // The refused element itself (the 5000th) is not stored; the one after it, on the next page, is.
      assert.deepEqual(missing(all.slice(-1), have), [],
        'the tombstone after a refused element was never applied: the transfer stopped at, or paged past, the element it refused');
      assert.ok(!have.has(all[CLAMP - 1]._id), 'the malformed element was stored');
    });

    it('a last element whose seq is not the one the peer\'s cursor names is not followed: the transfer stops and the counter does not move', async () => {
      const all = run(CLAMP + 1, i => i);
      await door.seedPeer(S, all);
      // The first page's last element claims a seq far above its place, beside the peer's honest cursor: nothing the page says
      // can be trusted to place the next ask, so the transfer holds below it and says so.
      door.state.records[S] = { facts: [build.fact(S, 'rec', 100, { author: PEER_AUTHOR })] };
      door.state.tamper = (body, asked) => {
        if (asked.sinceSeq !== '0' || !body.facts?.length) return body;
        const facts = [...body.facts];
        facts[facts.length - 1] = { ...facts[facts.length - 1], seq: MAX_INGEST_SEQ + 5 };
        return { ...body, facts };
      };
      const { lines } = await door.logsDuring(() => door.sync());
      assert.ok(await door.counter(S) < MAX_INGEST_SEQ, 'the refused seq moved the counter');
      assert.ok((door.member().lastSeqReceived?.[S] ?? 0) < MAX_INGEST_SEQ, 'the refused seq moved the receive watermark');
      assert.ok(lines.some(l => l.includes(S) && l.includes(PEER_LABEL) && /tombstone/i.test(l) && /stopped/.test(l)),
        `no warning says the tombstone transfer stopped:\n${lines.join('\n')}`);
    });

    it('a whole page of one seq from a peer without the cursor mode answers truncated with a warning, and the record watermark is capped', async () => {
      await door.seedPeer(S, run(CLAMP + 1, () => 7));
      door.state.records[S] = { facts: [build.fact(S, 'rec', 100, { author: PEER_AUTHOR })] };
      // A 5.6 peer ignores `cursor` and sends no `nextCursor`: its page is what the per-type read gave, here one type's 5000.
      // (A peer WITH the mode pages past the run: `a-tombstone-run-at-one-seq-does-not-wedge-db`.)
      door.state.tamper = (body) => { const { nextCursor: _dropped, ...legacy } = body; return legacy; };
      const { lines } = await door.logsDuring(() => door.sync());
      const watermark = door.member().lastSeqReceived?.[S] ?? 0;
      assert.ok(watermark < 7,
        `the record watermark moved to ${watermark}, past seq-7 deletions the transfer could not page through — they are `
        + 'never asked for again');
      assert.ok(lines.some(l => l.includes(S) && l.includes(PEER_LABEL) && /\b7\b/.test(l) && /tombstone/i.test(l)),
        `no warning names the space, the peer and the seq it stopped at:\n${lines.join('\n')}`);
    });

    it('the pull asks at the clamp, and a page with every type full arrives compressed, under the boundedJson cap', async () => {
      assert.ok(TOMBSTONE_TYPES.length >= 5, `only ${TOMBSTONE_TYPES.length} tombstone type(s) — the vocabulary did not load`);
      const all = TOMBSTONE_TYPES.flatMap(type => Array.from({ length: CLAMP },
        (_, k) => tomb(`${type}-${k + 1}`, k + 1, type)));
      await door.seedPeer(S, all);
      await door.sync();
      const first = door.state.requests[0];
      assert.equal(first?.limit, String(CLAMP),
        `the tombstone pull asked with limit ${first?.limit ?? '(none)'}, so the peer served ${first?.limit ?? 1000} per type`);
      const answer = door.state.answers[0];
      assert.match(String(answer.encoding), /^(gzip|br|deflate)$/, `a full tombstone page went out uncompressed (${answer.encoding})`);
      assert.ok(answer.bytes < door.maxUpstreamBytes,
        `a full page is ${answer.bytes} bytes, over the ${door.maxUpstreamBytes}-byte boundedJson cap`);
      for (const type of TOMBSTONE_TYPES) {
        assert.equal(await door.coll(S, 'tombstones').countDocuments({ type }), CLAMP,
          `not every ${TOMBSTONE_COLLECTION[type]} tombstone of a full page was applied`);
      }
    });

    it('characterised: a record re-created after its deletion survives the tombstone being pulled again', async () => {
      await door.coll(S, 'facts').insertOne(build.fact(S, 'again', 5, { author: PEER_AUTHOR }));
      await door.seedPeer(S, [tomb('again', 10)]);
      door.state.records[S] = { facts: [build.fact(S, 'again', 20, { author: PEER_AUTHOR, fact: 're-created' })] };
      await door.sync();
      assert.equal((await door.coll(S, 'facts').findOne({ _id: 'again' }))?.seq, 20, 'the re-created record did not land');
      // A capped watermark re-pulls the older tombstone next cycle, in the same order: tombstones, then records.
      door.member().lastSeqReceived = {};
      await door.sync();
      assert.equal((await door.coll(S, 'facts').findOne({ _id: 'again' }))?.seq, 20,
        'a re-pulled older tombstone deleted the record the peer re-created after it');
    });
  });

  describe('push', () => {
    async function pushOnly(local) {
      await door.reset({ direction: 'push' });
      await door.coll(S, 'tombstones').insertMany(local.map(t => ({ ...t, instanceId: 'tspage-receiver' })));
      await door.bumpSeq(S, local.reduce((m, t) => Math.max(m, t.seq), 0));
      await door.sync();
      return new Set(door.state.received.map(t => t._id));
    }

    it('a run of equal seqs across a push page boundary is delivered whole', async () => {
      // Positions 1..495 unique; 496..510 all seq 496, straddling the 500-element push page.
      const local = run(510, i => Math.min(i, 496), 'p');
      const lost = missing(local, await pushOnly(local));
      assert.deepEqual(lost, [], `${lost.length} tombstone(s) of a tie across the page boundary were never pushed`);
    });

    it('a whole push page of one seq is delivered whole', async () => {
      const local = run(501, () => 7, 'q');
      const lost = missing(local, await pushOnly(local));
      assert.deepEqual(lost, [], `${lost.length} tombstone(s) of a page of one seq were never pushed`);
    });

    it('more of one seq than the clamp holds is delivered whole, in pages that continue the run, and the push watermark passes it', async () => {
      // The push pages by `(seq, _id)`, so a run of any length goes out in pages (it used to stop at the clamp and hold the
      // watermark below the run for ever). A record of this instance's own at seq 100 is pushed in the same cycle: the push
      // watermark reaches 100 only if the tombstone transfer is complete.
      const local = run(CLAMP + 1, () => 7, 'w');
      await door.reset({ direction: 'push' });
      await door.coll(S, 'facts').insertOne(build.fact(S, 'mine', 100, { author: { instanceId: door.instanceId, instanceLabel: 'Receiver' } }));
      await door.coll(S, 'tombstones').insertMany(local.map(t => ({ ...t, instanceId: door.instanceId })));
      await door.bumpSeq(S, 100);
      await door.sync();
      assert.ok(door.state.pushedRecords.some(r => r._id === 'mine'), 'the record was not pushed, so the watermark proves nothing');
      const lost = missing(local, new Set(door.state.received.map(t => t._id)));
      assert.deepEqual(lost, [], `${lost.length} tombstone(s) of a run longer than a page were never pushed`);
      assert.equal(door.state.received.length, local.length, 'a tombstone of the run was offered twice');
      assert.equal(door.member().lastSeqPushed?.[S], 100, 'the push watermark was held below a run that was delivered whole');
    });
  });
});
