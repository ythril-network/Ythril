/**
 * An embed job's vector write lands only on the version of the record it READ — never on a newer copy that arrived
 * while it was embedding (plan v3 §E, Q-230).
 *
 * ## The race
 *
 * `embedStoredRecord` reads the record, builds its text, calls the model, then writes `embedding`, `embeddingModel`
 * and `matchedText` filtered on `_id` alone. The model call is the slow step, and a peer's newer copy can land
 * inside it. Two outcomes, both silent:
 *
 * - the newer copy is SUPPRESSED (record tier here): the arrival rightly holds no vector, and the job then writes
 *   one — of the old text — onto a record this instance keeps out of meaning-ranked search;
 * - the newer copy has new text: the job writes the OLD text's vector and `matchedText`, which is also the
 *   "unchanged" fingerprint, so the next job may take the stale vector as current.
 *
 * The rule: the job's write is guarded by the seq it read; a copy written since is not touched.
 *
 * ## How the race is made deterministic
 *
 * The job's own vector write is parked on a gate after it has embedded, the newer copy is pushed through the real
 * door, then the write is released. The embedder is a stub HTTP endpoint (`_vector-harness.mjs`), so the real
 * `embed()` path runs.
 *
 * Seen red on the base (0b066822): both cases — the parked write lands on the newer copy.
 *
 * Run: node --test testing/standalone/an-embed-job-never-writes-over-a-newer-arrival-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { startStubEmbedder } from './_vector-harness.mjs';
import { parkWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'embedrace';
let door, embedder, proto, park, embedStoredRecord, dims;

/** Park the FIRST vector write (`$set.embedding`) to `<S>_facts` until released. */
function parkTheJobsVectorWrite() {
  park = parkWrites(proto);
  const { reached, release } = park.arm(`${S}_facts`,
    { when: (method, [, update]) => method === 'updateOne' && update?.$set?.embedding !== undefined });
  return { parked: reached, release };
}

describe('an embed job never writes over a newer arrival', { skip }, () => {
  before(async () => {
    embedder = await startStubEmbedder(() => Array.from({ length: dims ?? 3 }, (_, i) => (i === 0 ? 1 : 0)));
    door = await openPushDoor({ suite: 'embedrace', spaces: [{ id: S, label: 'Race', folders: [], meta: {} }] });
    ({ embedStoredRecord } = await import('../../server/dist/brain/embed-record.js'));
    dims = (await import('../../server/dist/config/loader.js')).getEmbeddingConfig().dimensions;
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  // Restored before the door closes: the door's own restore would otherwise put the park back (`parkWrites`).
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); await embedder?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    await door.coll(S, 'facts').insertOne(build.fact(S, 'f', 5, { fact: 'the old text' }));
  });

  const cases = {
    'a suppressing arrival': { fact: 'the old text', suppressEmbeddings: true },
    'an arrival with new text': { fact: 'the new text' },
  };

  for (const [name, change] of Object.entries(cases)) {
    it(`${name} lands while the job embeds: the job's write does not touch the newer copy`, async () => {
      const { parked, release } = parkTheJobsVectorWrite();
      const job = embedStoredRecord(S, 'fact', 'f');
      await parked;
      const r = await door.push('/facts', build.fact(S, 'f', 6, change), { spaceId: S });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      release();
      await job.catch(() => {});
      const after = await door.coll(S, 'facts').findOne({ _id: 'f' });
      assert.equal(after.seq, 6, 'fixture check: the newer copy did not land');
      // The stored copy had no vector and the arrival carries none, so any of the three is the job's stale write.
      assert.deepEqual(['embedding', 'embeddingModel', 'matchedText'].filter(f => f in after), [],
        'the job read seq 5 and wrote its vector and text onto the seq-6 copy that arrived meanwhile: '
        + JSON.stringify({ ...after, embedding: Array.isArray(after.embedding) ? `[${after.embedding.length} numbers]` : after.embedding }));
    });
  }
});
