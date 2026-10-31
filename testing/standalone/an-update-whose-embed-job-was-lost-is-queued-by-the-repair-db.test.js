/**
 * A record whose text changed while its embed job could not be queued is found and queued by the repair (Q-261).
 *
 * ## The defect
 *
 * A peer's update of a record this instance embeds carries the stored vector, model and `matchedText` across the replace
 * (the receiver keeps its own), and queues a job AFTER the write. If that enqueue fails the record is stored with the NEW
 * text, the OLD vector and the OLD lexical text, and the repair (`POST /reembed`) selected only records with NO vector,
 * so it could not see this one. Nothing re-delivers an update at an equal seq, so nothing ever came back to it.
 *
 * ## The rule
 *
 * A vector is stored only beside the text it was made from (`matchedText`), so a record owes the worker a job exactly when
 * its `matchedText` differs from the text its builder gives today. The repair compares them and queues the records that differ.
 *
 * ## What is asked
 *
 * Per kind (`EMBED_SWEEP_KINDS`, floor of five): seed through a real arrival, give the record a vector made from its text (the
 * worker's own write), push an UPDATE that changes its text with the jobs collection failing, then `reembedSpace`:
 *  - the record is queued, and the answer's `stale` counts it (and `byKind`);
 *  - controls: an update that leaves the text unchanged is not queued; a derived file row with no text is not queued;
 *  - convergence: after the worker has run the job (a stub embedder), a second call queues nothing.
 *
 * Run: node --test testing/standalone/an-update-whose-embed-job-was-lost-is-queued-by-the-repair-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { build, openPushDoor, PEER_TOKEN } from './_push-door.mjs';
import { queryAxis, startStubEmbedder } from './_vector-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';
const DIMS = 8;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

/** Per embed kind: the push family, and the field its words ride in. */
const FAMILY = {
  fact: { key: 'facts', coll: 'facts', words: 'fact' },
  entity: { key: 'entities', coll: 'entities', words: 'name' },
  edge: { key: 'edges', coll: 'edges', words: 'description' },
  chrono: { key: 'chrono', coll: 'chrono', words: 'title' },
  file: { key: 'filemeta', coll: 'files', words: 'description' },
};

let door, stub, embedRecord, reembed, sweep, loader;
let original = null;
let originalOne = null;
let failJobs = false;

const jobsFor = (id) => door.coll(SPACE, 'embed_jobs').countDocuments({ recordId: id });

/** The smallest body of a kind, with its words. */
function arriving(kind, id, seq, words, extra = {}) {
  const fam = FAMILY[kind];
  const builder = { fact: build.fact, entity: build.entity, edge: build.edge, chrono: build.chrono, file: build.filemeta }[kind];
  return builder(SPACE, id, seq, { [fam.words]: words, ...extra });
}

async function push(kind, doc) {
  const r = await door.push('/batch-upsert', { [FAMILY[kind].key]: [doc] }, { spaceId: SPACE, token: PEER_TOKEN });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  await door.settled();
}

/** What the worker's own success write leaves: a vector, its model, and the text it was made from. */
async function asEmbedded(kind, id) {
  const row = await door.coll(SPACE, FAMILY[kind].coll).findOne({ _id: id });
  const text = await embedRecord.buildEmbedText(SPACE, kind, row);
  await door.coll(SPACE, FAMILY[kind].coll).updateOne({ _id: id }, {
    $set: { embedding: queryAxis(DIMS), embeddingModel: loader.getEmbeddingConfig().model, matchedText: text },
  });
  return text;
}

/** A file row holds bytes here when it has a size or a hash: its arrival would have queued it. */
const holdBytes = (id) => door.coll(SPACE, 'files').updateOne({ _id: id }, { $set: { sizeBytes: 12, sha256: 'a'.repeat(64) } });

async function seed(kind, id) {
  await push(kind, arriving(kind, id, 1, `the ${'first'} wording of ${id}`));
  if (kind === 'file') await holdBytes(id);
  await asEmbedded(kind, id);
  // The seed's own job is the worker's, already done: cleared, so a job counted below can only be the update's.
  await door.coll(SPACE, 'embed_jobs').deleteMany({ recordId: id });
}

/** An update at the next seq, pushed while the jobs collection fails. */
async function updateWithoutJob(kind, id, words) {
  failJobs = true;
  try { await push(kind, arriving(kind, id, 2, words)); } finally { failJobs = false; }
  assert.equal(await jobsFor(id), 0, 'the simulated failure did not apply: the update queued a job, so the test checks nothing');
}

describe('an update whose embed job was lost is queued by the repair (Q-261)', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    door = await openPushDoor({ suite: 'repair-stale', spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }] });
    loader = await import('../../server/dist/config/loader.js');
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    reembed = await import('../../server/dist/brain/reembed.js');
    sweep = { EMBED_SWEEP_KINDS: reembed.REEMBED_KINDS };
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    original = proto.bulkWrite;
    const originalUpdateOne = proto.updateOne;
    proto.updateOne = async function maybeFailOne(...args) {
      if (failJobs && this.collectionName === `${SPACE}_embed_jobs`) throw new Error('simulated jobs-collection failure');
      return originalUpdateOne.apply(this, args);
    };
    originalOne = originalUpdateOne;
    proto.bulkWrite = async function maybeFail(...args) {
      if (failJobs && this.collectionName === `${SPACE}_embed_jobs`) throw new Error('simulated jobs-collection failure');
      return original.apply(this, args);
    };
  });

  after(async () => {
    if (original) Object.getPrototypeOf(door.mongo.col('probe')).bulkWrite = original;
    if (originalOne) Object.getPrototypeOf(door.mongo.col('probe')).updateOne = originalOne;
    await door?.close();
    await stub?.close();
  });

  beforeEach(async () => {
    failJobs = false;
    await door.wipe(SPACE);
    await door.coll(SPACE, 'embed_jobs').deleteMany({});
  });

  it('covers every embed kind, derived from the code', () => {
    assert.ok(sweep.EMBED_SWEEP_KINDS.length >= 5, `the floor of five kinds fell to ${sweep.EMBED_SWEEP_KINDS.length}`);
    assert.deepEqual(Object.keys(FAMILY).sort(), [...sweep.EMBED_SWEEP_KINDS].sort(), 'a kind has no family in this test');
  });

  for (const kind of ['fact', 'entity', 'edge', 'chrono', 'file']) {
    it(`${kind}: an update whose job was lost is queued by the repair, and counted as stale`, async () => {
      const id = kind === 'file' ? 'docs/repair.md' : `${kind}-repair`;
      await seed(kind, id);
      await updateWithoutJob(kind, id, `a CHANGED wording of ${id}`);
      const stored = await door.coll(SPACE, FAMILY[kind].coll).findOne({ _id: id });
      assert.ok(Array.isArray(stored.embedding), 'the carried vector is gone: the premise of the test does not hold');
      assert.notEqual(stored.matchedText, await embedRecord.buildEmbedText(SPACE, kind, stored), 'the record is not stale: the premise of the test does not hold');

      const result = await reembed.reembedSpace(SPACE);
      assert.equal(await jobsFor(id), 1, `the repair did not queue the record whose job was lost: ${JSON.stringify(result)}`);
      assert.equal(result.stale, 1, `the answer does not say it queued one stale record: ${JSON.stringify(result)}`);
      assert.equal(result.byKind[kind], 1, JSON.stringify(result));
      assert.equal(result.enqueued, 1, JSON.stringify(result));
    });

    it(`${kind}: the job the repair queued settles the record, and a second repair queues nothing`, async () => {
      const id = kind === 'file' ? 'docs/settle.md' : `${kind}-settle`;
      await seed(kind, id);
      await updateWithoutJob(kind, id, `a CHANGED wording of ${id}`);
      await reembed.reembedSpace(SPACE);
      assert.equal(await embedRecord.embedStoredRecord(SPACE, kind, id), 'embedded');
      const again = await reembed.reembedSpace(SPACE);
      assert.equal(again.enqueued, 0, `a settled record is queued again: ${JSON.stringify(again)}`);
      assert.equal(again.stale, 0, JSON.stringify(again));
    });

    it(`${kind}: control: an update that leaves the text unchanged is not queued`, async () => {
      const id = kind === 'file' ? 'docs/same.md' : `${kind}-same`;
      await seed(kind, id);
      // The same words, a newer copy: nothing the text depends on changed.
      await updateWithoutJob(kind, id, `the first wording of ${id}`);
      const result = await reembed.reembedSpace(SPACE);
      assert.equal(await jobsFor(id), 0, `a record whose text did not change was queued: ${JSON.stringify(result)}`);
      assert.equal(result.stale, 0, JSON.stringify(result));
    });
  }

  it('control: a derived file row with no text is not queued, on any call', async () => {
    await door.coll(SPACE, 'files').insertMany([
      { _id: 'docs/p.md', spaceId: SPACE, path: 'docs/p.md', tags: [], seq: 1 },
      { _id: 'docs/p.md#chunk9', spaceId: SPACE, parentFileId: 'docs/p.md', embedding: queryAxis(DIMS), embeddingModel: 'x', matchedText: 'path text from an old backfill' },
      { _id: 'docs/p.md#chunk8', spaceId: SPACE, parentFileId: 'docs/p.md' },
    ]);
    const first = await reembed.reembedSpace(SPACE, { kinds: ['file'] });
    assert.equal(await jobsFor('docs/p.md#chunk8'), 0, `a textless derived row was queued: ${JSON.stringify(first)}`);
    assert.equal(await jobsFor('docs/p.md#chunk9'), 0, `a textless derived row holding a vector was queued by the stale pass: ${JSON.stringify(first)}`);
  });

  it('a suppressed record whose lexical text is missing is queued, and its job writes the text with no model call', async () => {
    const id = 'fact-quiet';
    await door.coll(SPACE, 'facts').insertOne({ ...build.fact(SPACE, id, 3, { fact: 'quiet words', suppressEmbeddings: true }) });
    const result = await reembed.reembedSpace(SPACE);
    assert.equal(await jobsFor(id), 1, `the suppressed record with no text was not queued: ${JSON.stringify(result)}`);
    assert.equal(result.stale, 1, JSON.stringify(result));
    assert.equal(await embedRecord.embedStoredRecord(SPACE, 'fact', id), 'excluded');
    const settled = await door.coll(SPACE, 'facts').findOne({ _id: id });
    assert.equal(settled.matchedText, 'quiet words');
    assert.equal(settled.embedding, undefined);
    assert.equal((await reembed.reembedSpace(SPACE)).enqueued, 0, 'the settled suppressed record is queued again');
  });

  it('the cap bounds what is queued, and the owed records beyond it are counted into remaining, never dropped silently', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = `fact-cap-${i}`;
      ids.push(id);
      await seed('fact', id);
      await updateWithoutJob('fact', id, `a CHANGED wording of ${id}`);
    }
    const capped = await reembed.reembedSpace(SPACE, { limit: 2 });
    assert.equal(capped.enqueued, 2, JSON.stringify(capped));
    assert.equal(capped.remaining, 1, JSON.stringify(capped));
    assert.equal(capped.truncated, true, JSON.stringify(capped));
  });
});
