/**
 * Two peers push DIFFERENT text for one fact at one seq at the same moment: both texts survive, one as a fork of the
 * other (Q-232) — on every push door, with the fork's own rules (the held fork of a re-send, the caps) intact.
 *
 * ## The race
 *
 * Each push plans against what is stored. When neither is stored yet, both plan `inserted`. The first write lands;
 * the second's write hits the seq guard (`{ _id, seq < s or absent }`) as a duplicate `_id`, and the writer's
 * read-back compared only the SEQ: the stored copy is at the planned seq, so the second push counted itself
 * `landed` — and its text was in no record anywhere. The sender was told its document landed, and an equal-seq
 * divergence, which every other path forks, lost one side silently.
 *
 * The rule: a same-seq copy with different content is a DIVERGENCE, never "this version landed" — the read-back
 * compares content and the divergent copy is forked, on every push door, by the SAME rules a planned fork follows:
 * a re-send of a fork already made answers `forked` with that fork and writes nothing new, and a chain at its cap
 * refuses exactly as a planned fork does (the single route's 400, the batch's `forkDepthRefused` and `rejected`).
 *
 * ## How the race is made deterministic
 *
 * The first push's facts write is parked on a gate after it planned and before it writes; the second push runs to
 * completion meanwhile; then the first write is released. That is the interleaving the race produces, without
 * sleeps.
 *
 * ## What stays as 5.6.3 answers it (pins, green before the fix)
 *
 * Two pushes of the SAME text at one seq are not a divergence: one record, no fork. A parked push whose competitor
 * landed at a HIGHER seq is `newer here` and forks nothing.
 *
 * Seen red on 6eb5a333 (5.6.3): the parked push's text is lost; only one of the two texts is stored, and the push
 * is answered `inserted`.
 *
 * Run: node --test testing/standalone/two-divergent-pushes-at-one-seq-keep-both-texts-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { parkWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'divrace';
let door, park;
let forkIdFor, MAX_FORK_DEPTH;

/** Park the FIRST `bulkWrite` to `<S>_facts` until released — the shared park (`_write-faults.mjs`). */
function parkFirstFactsWrite() {
  park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
  const { reached, release } = park.arm(`${S}_facts`, { when: (method) => method === 'bulkWrite' });
  return { parked: reached, release };
}

/** Every text stored for fact `f`: the record itself and every fork of it. */
async function textsOf(id) {
  const rows = await door.coll(S, 'facts').find({ $or: [{ _id: id }, { forkOf: id }] }).toArray();
  return { texts: rows.map(r => r.fact).sort(), forks: rows.filter(r => r.forkOf === id).length };
}

/** A chain `f -> a1 -> ... -> a10`: `f` is `MAX_FORK_DEPTH` forks below its root, so nothing may fork it further. */
const chainIds = () => Array.from({ length: MAX_FORK_DEPTH }, (_, i) => `a${i + 1}`);
const chainDocs = () => chainIds().map((id, i, ids) => build.fact(S, id, 1, ids[i + 1] ? { forkOf: ids[i + 1] } : {}));

describe('two divergent pushes at one seq keep both texts (Q-232)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'divrace', spaces: [{ id: S, label: 'Race', folders: [], meta: {} }] });
    ({ forkIdFor } = await import('../../server/dist/sync/upsert-plan.js'));
    ({ MAX_FORK_DEPTH } = await import('../../server/dist/api/sync/_shared.js'));
  });
  // Restored before the door closes: the door's own restore would otherwise put the park back (`parkWrites`).
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  const send = {
    batch: (doc) => door.push('/batch-upsert', { facts: [doc] }, { spaceId: S }),
    single: (doc) => door.push('/facts', doc, { spaceId: S }),
  };

  /** Run the race: `parkedDoc` is pushed first and held; `winnerDoc` lands meanwhile; then the parked write is released. */
  async function race(via, parkedDoc, winnerDoc) {
    const { parked, release } = parkFirstFactsWrite();
    const first = send[via](parkedDoc);
    await parked;
    const second = await send[via](winnerDoc);
    release();
    return { first: await first, second };
  }

  for (const via of Object.keys(send)) {
    it(`${via}: the push parked behind the other's write keeps its text, as a fork`, async () => {
      const a = build.fact(S, 'f', 5, { fact: 'text from peer A' });
      const b = build.fact(S, 'f', 5, { fact: 'text from peer B' });
      const { first: firstAnswer, second } = await race(via, a, b);
      assert.equal(second.code, 200, JSON.stringify(second.body));
      assert.equal(firstAnswer.code, 200, JSON.stringify(firstAnswer.body));

      const { texts, forks } = await textsOf('f');
      assert.deepEqual(texts, ['text from peer A', 'text from peer B'].sort(),
        `two divergent copies of one fact at one seq left ${JSON.stringify(texts)}: the push whose write lost the race `
        + `was answered ${JSON.stringify(firstAnswer.body)} and its text is stored nowhere`);
      assert.equal(forks, 1, 'the divergent copy is stored as ONE fork of the record');
    });

    it(`${via}: the push that lost the race is answered forked, as a planned fork is`, async () => {
      const { first } = await race(via, build.fact(S, 'f', 5, { fact: 'lost' }), build.fact(S, 'f', 5, { fact: 'won' }));
      const rows = await door.coll(S, 'facts').find({ forkOf: 'f' }).toArray();
      assert.equal(rows.length, 1, `no fork was stored: ${JSON.stringify(first.body)}`);
      if (via === 'single') assert.deepEqual(first.body, { status: 'forked', forkId: rows[0]._id });
      else assert.equal(first.body.facts.forked, 1, JSON.stringify(first.body.facts));
      assert.equal(first.body.facts?.inserted ?? 0, 0, 'a push whose text was stored nowhere but as a fork is not `inserted`');
    });

    it(`${via}: a re-send of a fork already made answers forked with that fork and writes no second one (heldFork)`, async () => {
      const lostText = 'text of the lost push';
      const heldId = forkIdFor('f', 5, lostText);
      await door.coll(S, 'facts').insertOne(build.fact(S, heldId, 9, { forkOf: 'f', fact: lostText }));
      const { first } = await race(via, build.fact(S, 'f', 5, { fact: lostText }), build.fact(S, 'f', 5, { fact: 'won' }));
      assert.equal(await door.coll(S, 'facts').countDocuments({ forkOf: 'f' }), 1, 'a second fork of the same text was written');
      if (via === 'single') assert.deepEqual(first.body, { status: 'forked', forkId: heldId });
      else assert.equal(first.body.facts.forked, 1, JSON.stringify(first.body.facts));
      assert.equal(first.body.facts?.inserted ?? 0, 0, JSON.stringify(first.body));
    });

    it(`${via}: a chain at its cap refuses the diverged copy exactly as a planned fork is refused`, async () => {
      await door.coll(S, 'facts').insertMany(chainDocs());
      const root = chainIds()[0];
      const { first } = await race(via, build.fact(S, 'f', 5, { fact: 'lost', forkOf: root }), build.fact(S, 'f', 5, { fact: 'won', forkOf: root }));
      assert.equal(await door.coll(S, 'facts').countDocuments({ forkOf: 'f' }), 0, 'a fork was written past the cap');
      if (via === 'single') {
        assert.deepEqual([first.code, first.body], [400, { error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id 'f'` }]);
      } else {
        assert.equal(first.code, 200, JSON.stringify(first.body));
        assert.equal(first.body.facts.forkDepthRefused, 1, JSON.stringify(first.body.facts));
        assert.equal(first.body.facts.rejected, 1, JSON.stringify(first.body.facts));
        assert.equal(first.body.facts.inserted, 0, JSON.stringify(first.body.facts));
      }
    });

    it(`${via}: PIN two pushes of the SAME text at one seq are one record and no fork`, async () => {
      const { first, second } = await race(via, build.fact(S, 'f', 5, { fact: 'same' }), build.fact(S, 'f', 5, { fact: 'same' }));
      assert.equal(first.code, 200, JSON.stringify(first.body));
      assert.equal(second.code, 200, JSON.stringify(second.body));
      const { texts, forks } = await textsOf('f');
      assert.deepEqual(texts, ['same']);
      assert.equal(forks, 0, 'identical text at one seq is not a divergence');
    });

    it(`${via}: PIN a competitor that landed at a HIGHER seq is kept and forks nothing`, async () => {
      const { first } = await race(via, build.fact(S, 'f', 5, { fact: 'older' }), build.fact(S, 'f', 9, { fact: 'newer' }));
      assert.equal(first.code, 200, JSON.stringify(first.body));
      const { texts, forks } = await textsOf('f');
      assert.deepEqual(texts, ['newer']);
      assert.equal(forks, 0);
    });
  }
});