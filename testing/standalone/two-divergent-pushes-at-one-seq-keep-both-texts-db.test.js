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
 * ## Every kind, and the id (Q-624, re-anchored)
 *
 * The writer's read-back decides by the body, so the race is the same for every kind that forks (`FORKING_FAMILIES`, read from the
 * planner via `_fork-kinds.mjs`): an entity, a chrono entry and an edge whose write lost the race keep their body as a fork too. And the
 * fork the loser becomes is stored under the id ITS BODY derives (`forkIdFor(forkOf, seq, authoredContentHash(family, body).text)`, design
 * section 3), not the text-derived id the fact fork had. Seen red on the base (b857da8f): an equal-seq entity, chrono entry or edge is
 * never a divergence, so the loser's body is stored nowhere; and the fact fork's id is the text-derived one.
 *
 * Run: node --test testing/standalone/two-divergent-pushes-at-one-seq-keep-both-texts-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { parkWrites } from './_write-faults.mjs';
import { FORK_FIXTURE, forkingFamilies, forkIdOf, copyOf } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();

const S = 'divrace';
let door, park, FAMILIES;

/** Park the FIRST `bulkWrite` to `<S>_<family>` until released — the shared park (`_write-faults.mjs`). */
function parkFirstWrite(family) {
  park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
  const { reached, release } = park.arm(`${S}_${family}`, { when: (method) => method === 'bulkWrite' });
  return { parked: reached, release };
}

/** Every body stored for record `f` of `family`: the record itself and every fork of it. */
async function bodiesOf(family, id) {
  const field = FORK_FIXTURE[family].field;
  const rows = await door.coll(S, family).find({ $or: [{ _id: id }, { forkOf: id }] }).toArray();
  return { bodies: rows.map(r => r[field]).sort(), forks: rows.filter(r => r.forkOf === id) };
}

describe('two divergent pushes at one seq keep both bodies (Q-232, Q-624)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'divrace', spaces: [{ id: S, label: 'Race', folders: [], meta: {} }] });
    FAMILIES = await forkingFamilies();
  });
  // Restored before the door closes: the door's own restore would otherwise put the park back (`parkWrites`).
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  const send = {
    batch: (family, doc) => door.push('/batch-upsert', { [family]: [doc] }, { spaceId: S }),
    single: (family, doc) => door.push(FORK_FIXTURE[family].single, doc, { spaceId: S }),
  };

  for (const via of Object.keys(send)) {
    it(`${via}: for every kind that forks, the push parked behind the other's write keeps its body, as a fork under the id the body derives`, async () => {
      const failures = [];
      for (const family of FAMILIES) {
        await door.wipe(S);
        const a = copyOf(family, S, 'f', 5, 'body from peer A');
        const b = copyOf(family, S, 'f', 5, 'body from peer B');
        const { parked, release } = parkFirstWrite(family);
        const first = send[via](family, a);
        await parked;
        const second = await send[via](family, b);
        release();
        const firstAnswer = await first;
        park.restore(); park = undefined;
        if (second.code !== 200 || firstAnswer.code !== 200) { failures.push(`${via}/${family}: answers ${second.code} ${firstAnswer.code}: ${JSON.stringify(firstAnswer.body)}`); continue; }
        const { bodies, forks } = await bodiesOf(family, 'f');
        if (JSON.stringify(bodies) !== JSON.stringify(['body from peer A', 'body from peer B'])) {
          failures.push(`${via}/${family}: two divergent copies of one record at one seq left ${JSON.stringify(bodies)}: the push whose write lost the race was answered ${JSON.stringify(firstAnswer.body)} and its body is stored nowhere`);
          continue;
        }
        if (forks.length !== 1) { failures.push(`${via}/${family}: expected ONE fork of the record, found ${forks.length}`); continue; }
        const field = FORK_FIXTURE[family].field;
        const expected = await forkIdOf(family, 'f', 5, copyOf(family, S, 'f', 5, forks[0][field]));
        if (forks[0]._id !== expected) failures.push(`${via}/${family}: the fork is stored under ${forks[0]._id}; its body derives ${expected}`);
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s): ${failures.join('; ')}`);
    });
  }
});
