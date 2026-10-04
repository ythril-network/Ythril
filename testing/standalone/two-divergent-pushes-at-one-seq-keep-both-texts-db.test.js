/**
 * Two peers push DIFFERENT text for one fact at one seq at the same moment: both texts survive, one as a fork of the
 * other (Q-232).
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
 * compares content (`divergesFrom`) and the divergent copy is forked, on every door.
 *
 * ## How the race is made deterministic
 *
 * The first push's facts write is parked on a gate after it planned and before it writes; the second push runs to
 * completion meanwhile; then the first write is released. That is the interleaving the race produces, without
 * sleeps.
 *
 * Seen red on the base (0b066822): the parked push's text is lost; only one of the two texts is stored.
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

describe('two divergent pushes at one seq keep both texts (Q-232)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'divrace', spaces: [{ id: S, label: 'Race', folders: [], meta: {} }] });
  });
  // Restored before the door closes: the door's own restore would otherwise put the park back (`parkWrites`).
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  const send = {
    batch: (doc) => door.push('/batch-upsert', { facts: [doc] }, { spaceId: S }),
    single: (doc) => door.push('/facts', doc, { spaceId: S }),
  };

  for (const via of Object.keys(send)) {
    it(`${via}: the push parked behind the other's write keeps its text, as a fork`, async () => {
      const a = build.fact(S, 'f', 5, { fact: 'text from peer A' });
      const b = build.fact(S, 'f', 5, { fact: 'text from peer B' });
      const { parked, release } = parkFirstFactsWrite();
      const first = send[via](a);
      await parked;
      const second = await send[via](b);
      release();
      const firstAnswer = await first;
      assert.equal(second.code, 200, JSON.stringify(second.body));
      assert.equal(firstAnswer.code, 200, JSON.stringify(firstAnswer.body));

      const { texts, forks } = await textsOf('f');
      assert.deepEqual(texts, ['text from peer A', 'text from peer B'].sort(),
        `two divergent copies of one fact at one seq left ${JSON.stringify(texts)}: the push whose write lost the race `
        + `was answered ${JSON.stringify(firstAnswer.body)} and its text is stored nowhere`);
      assert.equal(forks, 1, 'the divergent copy is stored as ONE fork of the record');
    });
  }
});
