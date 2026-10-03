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
 *  2. **A refused element does not move the cursor**: the page's highest seq belongs to an element the receiver
 *     refused, and the next page is asked from what was ACCEPTED.
 *  3. **A whole page of one seq cannot be paged past**, so the transfer answers `truncated`, warns naming the space,
 *     the peer and the seq, and the record watermark stays below the deletions it did not apply.
 *  4. **The push pager the same**, for both shapes of tie.
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
      // The first page's highest-seq element arrives forged: the cursor must come from what was ACCEPTED.
      door.state.tamper = (body, asked) => {
        if (asked.sinceSeq !== '0' || !body.facts?.length) return body;
        const facts = [...body.facts];
        facts[facts.length - 1] = { ...facts[facts.length - 1], seq: MAX_INGEST_SEQ + 5 };
        return { ...body, facts };
      };
      await door.sync();
      const have = await storedIds();
      assert.deepEqual(missing(all.slice(-2), have), [],
        'the tombstones after a refused max-seq element were never applied: the transfer stopped at, or paged past, the element it refused');
      assert.ok(await door.counter(S) < MAX_INGEST_SEQ, 'the refused seq moved the counter');
    });

    it('a whole page of one seq answers truncated with a warning, and the record watermark is capped', async () => {
      await door.seedPeer(S, run(CLAMP + 1, () => 7));
      door.state.records[S] = { facts: [build.fact(S, 'rec', 100, { author: PEER_AUTHOR })] };
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

    it('more of one seq than the clamp holds answers truncated with a warning, and the push watermark is capped', async () => {
      // A record of this instance's own at seq 100 is pushed in the same cycle, so the push watermark would reach
      // 100 if the tombstone transfer claimed it was complete.
      const local = run(CLAMP + 1, () => 7, 'w');
      await door.reset({ direction: 'push' });
      await door.coll(S, 'facts').insertOne(build.fact(S, 'mine', 100, { author: { instanceId: door.instanceId, instanceLabel: 'Receiver' } }));
      await door.coll(S, 'tombstones').insertMany(local.map(t => ({ ...t, instanceId: door.instanceId })));
      await door.bumpSeq(S, 100);
      const { lines } = await door.logsDuring(() => door.sync());
      assert.ok(door.state.pushedRecords.some(r => r._id === 'mine'), 'the record was not pushed, so the watermark proves nothing');
      const watermark = door.member().lastSeqPushed?.[S] ?? 0;
      assert.ok(watermark < 7,
        `the push watermark moved to ${watermark}, past seq-7 deletions the push could not page through — they are never `
        + 'offered again');
      assert.ok(lines.some(l => l.includes(S) && l.includes(PEER_LABEL) && /\b7\b/.test(l) && /tombstone/i.test(l)),
        `no warning names the space, the peer and the seq the push stopped at:\n${lines.join('\n')}`);
    });
  });
});
