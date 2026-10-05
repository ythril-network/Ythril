/**
 * An embed job's write lands only on the version of the record it READ — never on a newer copy that arrived while it
 * was embedding (plan v3 §E, Q-230; Q-361 item 10).
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
 * The rule: EVERY write the job makes — the vector, the exclusion's `matchedText`, the failure path's `matchedText`
 * and the textless unset — is guarded by the seq it read (a row that had no seq is guarded by having none); a copy
 * written since is not touched, and the job says so: its outcome is `superseded`, terminal like `gone` and
 * `excluded` (done, never retried) — the newer copy's own arrival queued the embedding it is owed. A reindex
 * counts it as done, not as an error.
 *
 * ## How the race is made deterministic
 *
 * The job's own write is parked on a gate after it has decided, the newer copy is pushed through the real door (or
 * written directly, for a row no door carries), then the write is released. The embedder is a stub HTTP endpoint
 * (`_vector-harness.mjs`), so the real `embed()` path runs.
 *
 * Seen red on 6eb5a333 (5.6.3): every write lands on the newer copy and the outcome is `embedded`.
 *
 * Run: node --test testing/standalone/an-embed-job-never-writes-over-a-newer-arrival-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { startStubEmbedder } from './_vector-harness.mjs';
import { parkWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'embedrace';
let embedderPort, door, embedder, proto, park, embedStoredRecord, dims, worker, queue, reindex, log;

/** Park the FIRST write to `<S>_<part>` that `admits(update)` — through the shared park, by what the write sets. */
function parkWrite(part, admits) {
  park = parkWrites(proto);
  const { reached, release } = park.arm(`${S}_${part}`,
    { when: (method, [, update]) => method === 'updateOne' && admits(update ?? {}) });
  return { parked: reached, release };
}
const parkTheJobsVectorWrite = () => parkWrite('facts', u => u.$set?.embedding !== undefined);

/** A port nothing listens on: the embedder is unreachable, so the embed fails the way an outage fails it. */
async function refusedUrl() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return `http://127.0.0.1:${port}`;
}

const derived = (f) => ['embedding', 'embeddingModel', 'matchedText'].filter(k => k in f);

describe('an embed job never writes over a newer arrival', { skip }, () => {
  before(async () => {
    embedder = await startStubEmbedder(() => Array.from({ length: dims ?? 3 }, (_, i) => (i === 0 ? 1 : 0)));
    embedderPort = new URL(process.env['EMBEDDING_URL']).port;
    door = await openPushDoor({ suite: 'embedrace', spaces: [{ id: S, label: 'Race', folders: [], meta: {} }] });
    ({ embedStoredRecord } = await import('../../server/dist/brain/embed-record.js'));
    worker = await import('../../server/dist/brain/embed-worker.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    reindex = await import('../../server/dist/brain/reindex.js');
    ({ log } = await import('../../server/dist/util/log.js'));
    dims = (await import('../../server/dist/config/loader.js')).getEmbeddingConfig().dimensions;
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  // Restored before the door closes: the door's own restore would otherwise put the park back (`parkWrites`).
  afterEach(() => { park?.restore(); park = undefined; process.env['EMBEDDING_URL'] = `http://127.0.0.1:${embedderPort}`; });
  after(async () => { park?.restore(); await door?.close(); await embedder?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    queue.resetEmbedPendingHint();
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
      assert.deepEqual(derived(after), [],
        'the job read seq 5 and wrote its vector and text onto the seq-6 copy that arrived meanwhile: '
        + JSON.stringify({ ...after, embedding: Array.isArray(after.embedding) ? `[${after.embedding.length} numbers]` : after.embedding }));
    });

    it(`${name}: the job reports the outcome superseded, not embedded`, async () => {
      const { parked, release } = parkTheJobsVectorWrite();
      const job = embedStoredRecord(S, 'fact', 'f');
      await parked;
      await door.push('/facts', build.fact(S, 'f', 6, change), { spaceId: S });
      release();
      assert.equal(await job, 'superseded');
    });
  }

  it('the exclusion write (a suppressed record\'s matchedText) does not touch a newer copy either', async () => {
    await door.coll(S, 'facts').updateOne({ _id: 'f' }, { $set: { suppressEmbeddings: true } });
    const { parked, release } = parkWrite('facts', u => u.$set?.matchedText !== undefined && u.$set?.embedding === undefined);
    const job = embedStoredRecord(S, 'fact', 'f');
    await parked;
    await door.push('/facts', build.fact(S, 'f', 6, { fact: 'the new text' }), { spaceId: S });
    release();
    assert.equal(await job, 'superseded');
    const after = await door.coll(S, 'facts').findOne({ _id: 'f' });
    assert.equal(after.seq, 6);
    assert.deepEqual(derived(after), [], 'the exclusion wrote the old text as matchedText on the newer copy');
  });

  it('the failure path (matchedText written when the embed fails) does not touch a newer copy, and still throws', async () => {
    process.env['EMBEDDING_URL'] = await refusedUrl();
    const { parked, release } = parkWrite('facts', u => u.$set?.matchedText !== undefined && u.$set?.embedding === undefined);
    const job = embedStoredRecord(S, 'fact', 'f');
    const settled = job.then(() => ({ ok: true }), (err) => ({ ok: false, err }));
    await parked;
    await door.push('/facts', build.fact(S, 'f', 6, { fact: 'the new text' }), { spaceId: S });
    release();
    const done = await settled;
    assert.equal(done.ok, false, 'PIN: the embed failure still reaches the caller, which retries it');
    const after = await door.coll(S, 'facts').findOne({ _id: 'f' });
    assert.equal(after.seq, 6);
    assert.deepEqual(derived(after), [], 'the failure path wrote the old text as matchedText on the newer copy');
  });

  for (const withSeq of [true, false]) {
    it(`the textless unset does not strip the vector of a newer copy (a derived row ${withSeq ? 'with' : 'without'} a seq)`, async () => {
      const id = `docs/a.pdf#chunk${withSeq ? 1 : 2}`;
      const row = { _id: id, spaceId: S, path: id, parentFileId: 'docs/a.pdf', tags: [], embedding: [0.5, 0.5, 0.5],
        embeddingModel: 'old-model', matchedText: 'old', ...(withSeq ? { seq: 5 } : {}) };
      await door.coll(S, 'files').insertOne(row);
      const { parked, release } = parkWrite('files', u => u.$unset?.embedding !== undefined);
      const job = embedStoredRecord(S, 'file', id);
      await parked;
      // A newer copy of the row, holding a vector of its own, lands while the unset is held.
      await door.coll(S, 'files').replaceOne({ _id: id }, { ...row, seq: 9, embedding: [0.9, 0.9, 0.9], embeddingModel: 'new-model', matchedText: 'new' });
      release();
      assert.equal(await job, 'superseded');
      const after = await door.coll(S, 'files').findOne({ _id: id });
      assert.deepEqual([after.seq, after.embedding, after.embeddingModel], [9, [0.9, 0.9, 0.9], 'new-model'],
        'the textless unset stripped the vector the newer copy holds');
    });
  }

  it('PIN an unchanged record is still embedded, with the outcome embedded', async () => {
    assert.equal(await embedStoredRecord(S, 'fact', 'f'), 'embedded');
    const after = await door.coll(S, 'facts').findOne({ _id: 'f' });
    assert.deepEqual([after.seq, after.matchedText, Array.isArray(after.embedding)], [5, after.matchedText, true]);
    assert.equal(await embedStoredRecord(S, 'fact', 'f'), 'unchanged');
  });

  it('PIN the worker finishes a superseded job as done: it is not failed and is not retried', async () => {
    const { enqueueEmbedJob } = queue;
    await enqueueEmbedJob(S, 'fact', 'f');
    queue.resetEmbedPendingHint();
    const { parked, release } = parkTheJobsVectorWrite();
    const running = worker.runOneEmbedJob();
    await parked;
    // The newer copy's arrival queues its own job (resetting the claim), as a real arrival does.
    await door.push('/facts', build.fact(S, 'f', 6, { fact: 'the new text' }), { spaceId: S });
    release();
    assert.equal(await running, true);
    const jobs = await door.coll(S, 'embed_jobs').find({}).toArray();
    assert.deepEqual(jobs.filter(j => j.status === 'failed' || (j.attempts ?? 0) > 0), [],
      `the superseded attempt was recorded as a failure or an attempt: ${JSON.stringify(jobs)}`);
    const after = await door.coll(S, 'facts').findOne({ _id: 'f' });
    assert.deepEqual(derived(after), [], 'the worker\'s vector write landed on the newer copy');
  });

  it('a reindex counts a superseded record as done, not as an error', async () => {
    await door.coll(S, 'facts').insertMany([
      build.fact(S, 'g', 5, { fact: 'second' }), build.fact(S, 'h', 5, { fact: 'third' }),
    ]);
    // `f` sorts first, so its vector write is the one held.
    const { parked, release } = parkTheJobsVectorWrite();
    const lines = [];
    const info = log.info;
    log.info = (...a) => { lines.push(a.join(' ')); };
    try {
      reindex.startReindex({ spaceId: S, memberIds: [S] });
      await parked;
      await door.push('/facts', build.fact(S, 'f', 6, { fact: 'the new text' }), { spaceId: S });
      release();
      for (let i = 0; i < 300 && !lines.some(l => /Reindex completed/.test(l)); i++) await new Promise(r => setTimeout(r, 50));
    } finally { log.info = info; }
    const done = lines.find(l => /Reindex completed/.test(l));
    assert.ok(done, `the reindex never completed: ${JSON.stringify(lines)}`);
    const tally = Object.fromEntries([...done.matchAll(/(\w+)=(\d+)/g)].map(m => [m[1], Number(m[2])]));
    assert.equal(tally.errors, 0, done);
    const counted = Object.entries(tally).filter(([k]) => k !== 'errors').reduce((n, [, v]) => n + v, 0);
    assert.equal(counted, 3, `three records were walked and each must be counted as done (reindexed, suppressed or superseded): ${done}`);
  });
});