/**
 * The reembed backfill counts each record ONCE, in exactly one outcome (Q-656, bundle-211).
 *
 * ## The defect
 *
 * `reembedSpace` was two walks: a `vectorless` one (no `embedding` field) and a `stale` one (text differs from the stored text), whose
 * counts were summed and subtracted (`skippedSuppressed - staleSuppressed`). A record the two disagreed about fell between them or was
 * counted twice:
 *
 * - `embedding: null` or `[]` is a record with no vector: `$exists: false` misses the null, and the stale walk's `$isArray` calls
 *   the empty array a vector. Queued by neither walk, and counted nowhere;
 * - a suppressed record that still holds a vector (the sweep that removes it has not run) is "has a vector, text current" to both;
 * - a chunk of a suppressed parent, or an orphan chunk whose parent is gone, was asked the RECORD question
 *   (`embeddingSuppressedFor`), not the file question the worker asks, so it was re-queued on every call for ever and never settled;
 * - a textless derived row that kept a leftover `matchedText` was owed (the worker clears it) and counted nowhere;
 * - a record whose own field has the wrong type threw out of the walk, after jobs had already been queued, failing the call.
 *
 * ## The rule
 *
 * One walk reads each candidate once and puts it in exactly one outcome. An owed record is queued while `enqueued < limit`, else it is
 * counted in `remaining`; a suppressed record with no vector whose text is current is `skippedSuppressed`; so
 * `enqueued + remaining + skippedSuppressed` is the counted set and no count is ever subtracted. `stale` is a subset of `enqueued`.
 * After the queue is drained, a second call owes nothing except a record whose text can never be built.
 *
 * ## What the cases say, with the records seeded as LITERAL documents
 *
 * Nothing here derives a fixture from the code under test, except that a record's "current text" is spelled out beside it (a fact with
 * no tags is its fact string; a chunk with no heading is its content) and a precondition case checks those literals against the builder.
 * Identity is asserted by job id, not only by counts: a count that is right for the wrong records is the failure this file exists for.
 *
 *   owed (queued):  b1 suppressed, stale text          c1 `embedding: null`, stale text    d1 `embedding: null`, current text
 *                   e1 vector, stale text              h1 suppressed + vector, current     i1 `tags: 'x'` (text cannot be built)
 *                   i2 edge with an unknown fromKind   k1 vector, stale text, old model    n1 plain vectorless
 *                   o1 `embedding: []`, current        par-ok.md, par-ok.md#chunk1 (unsuppressed parent)
 *                   orph2#chunk0 orphan WITH a vector  l1#chunk0 textless row with a leftover matchedText
 *                   par-sup.md suppressed, no text     par-sup.md#chunk1 chunk of a suppressed parent WITH a vector
 *   skipped:        a1 suppressed (record), current    a2 suppressed (type schema), current   par-sup.md#chunk0 (chunk, suppressed parent)
 *   nothing:        f1 textless derived row, no derived field    _tmp/results-g1.json spill row
 *                   p1 healthy                         orph1#chunk0 orphan without a vector
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/the-backfill-counts-each-record-once-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
// One directory for both runs of the suite: the config loader reads CONFIG_PATH once, at its first import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-backfill-once-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
const DIMS = 8;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let mongo, reembed, embedRecord, worker, queue, MODEL, server, local;
const vectorFor = (text) => Array.from({ length: DIMS }, (_, i) => ((String(text).length + i) % 10) / 10 + 0.05);
const c = (part) => mongo.col(`${SPACE}_${part}`);
const VEC = [0.1, 0.2, 0.3, 0.4];
const NOW = '2026-01-01T00:00:00.000Z';
const base = { spaceId: SPACE, tags: [], createdAt: NOW, updatedAt: NOW };

const fact = (id, text, extra = {}) => ({ _id: id, ...base, fact: text, entityIds: [], ...extra });
const file = (id, extra = {}) => ({ _id: id, ...base, path: id, sizeBytes: 1, ...extra });

/** Seeds every case; a record's key is `kind:id`, the job's own identity. `MODEL` is read once the config is loaded. */
async function seed(withUnbuildable) {
  for (const p of ['facts', 'files', 'edges', 'entities', 'chrono', 'embed_jobs']) await c(p).deleteMany({});
  OWED = withUnbuildable ? OWED_ALL : OWED_ALL.filter(k => !UNBUILDABLE_ALL.includes(k));
  await c('facts').insertMany([
    fact('a1', 'alpha one', { suppressEmbeddings: true, matchedText: 'alpha one' }),
    fact('a2', 'alpha two', { type: 'secret', matchedText: 'alpha two' }),
    fact('b1', 'bravo one', { suppressEmbeddings: true, matchedText: 'old bravo' }),
    fact('c1', 'charlie one', { embedding: null, matchedText: 'old charlie' }),
    fact('d1', 'delta one', { embedding: null, matchedText: 'delta one' }),
    fact('e1', 'echo one', { embedding: VEC, embeddingModel: MODEL, matchedText: 'old echo' }),
    fact('h1', 'hotel one', { suppressEmbeddings: true, embedding: VEC, embeddingModel: MODEL, matchedText: 'hotel one' }),
    fact('i1', 'india one', { tags: 'x' }),
    fact('k1', 'kilo one', { embedding: VEC, embeddingModel: 'old-model', matchedText: 'old kilo' }),
    fact('n1', 'november one'),
    fact('o1', 'oscar one', { embedding: [], matchedText: 'oscar one' }),
    fact('p1', 'papa one', { embedding: VEC, embeddingModel: MODEL, matchedText: 'papa one' }),
  ]);
  await c('edges').insertOne({ _id: 'i2', ...base, from: 'x1', to: 'x2', label: 'relates', fromKind: 'bogus' });
  await c('files').insertMany([
    file('f1', { parentFileId: 'par-ok.md', chunkIndex: 0, faceEmbedding: VEC }),
    file('_tmp/results-g1.json'),
    file('par-ok.md'),
    file('par-ok.md#chunk1', { parentFileId: 'par-ok.md', chunkIndex: 1, content: 'ctl text', matchedText: 'ctl text' }),
    file('orph1#chunk0', { parentFileId: 'missing.md', chunkIndex: 0, content: 'orphan text', matchedText: 'orphan text' }),
    file('orph2#chunk0', { parentFileId: 'missing.md', chunkIndex: 0, content: 'orphan two', matchedText: 'orphan two', embedding: VEC, embeddingModel: MODEL }),
    file('l1#chunk0', { parentFileId: 'par-ok.md', chunkIndex: 0, matchedText: 'leftover' }),
    file('par-sup.md', { suppressEmbeddings: true }),
    file('par-sup.md#chunk0', { parentFileId: 'par-sup.md', chunkIndex: 0, content: 'sup chunk', matchedText: 'sup chunk' }),
    file('par-sup.md#chunk1', { parentFileId: 'par-sup.md', chunkIndex: 1, content: 'sup chunk two', matchedText: 'sup chunk two', embedding: VEC, embeddingModel: MODEL }),
  ]);
  if (!withUnbuildable) {
    // The same table without the record whose text cannot be built (it used to throw out of the walk), so a failure of the OTHER rules
    // shows by itself and is not hidden behind the throw that every case with it present dies on. i2 stays: its unknown endpoint kind
    // builds through the raw-id fallback, so it is an ordinary owed record, and the worker settles it.
    await c('facts').deleteOne({ _id: 'i1' });
  }
}

/** The owed records of the seeded space: all of them with the unbuildable pair, and without it, what `seed` set last. */
let OWED;
const UNBUILDABLE_ALL = ['fact:i1'];
const OWED_ALL = [
  'fact:b1', 'fact:c1', 'fact:d1', 'fact:e1', 'fact:h1', 'fact:i1', 'fact:k1', 'fact:n1', 'fact:o1',
  'edge:i2',
  'file:par-ok.md', 'file:par-ok.md#chunk1', 'file:orph2#chunk0', 'file:l1#chunk0', 'file:par-sup.md', 'file:par-sup.md#chunk1',
].sort();
const SKIPPED = ['fact:a1', 'fact:a2', 'file:par-sup.md#chunk0'].sort();
const NOTHING = ['fact:p1', 'file:f1', 'file:_tmp/results-g1.json', 'file:orph1#chunk0'].sort();
/** Everything the seeds hold, for the check that the table partitions it. */
const everything = () => [...OWED, ...SKIPPED, ...NOTHING].sort();
/** Of OWED, the ones the repair counts as `stale`: they hold a vector, or are suppressed, and their stored text is not their current text. */
const STALE = ['fact:b1', 'fact:e1', 'fact:k1', 'file:par-sup.md'];
/** A record whose text can never be built: owed on every call, its job fails where `list_embed_jobs` shows it. */
const UNBUILDABLE = ['fact:i1'];

const jobIds = async () => (await c('embed_jobs').find({}).toArray()).map(j => `${j.recordType}:${j.recordId}`).sort();

/**
 * Drain the queue with the REAL worker (`runOneEmbedJob` -> `embedStoredRecord`) over a stub embedder endpoint, so what settles a record
 * is the worker's own question and no second copy of it (a suppression list, a text rule) is written here: "a drained space owes nothing"
 * is then a statement about the worker and the walk agreeing, which a hand-written drain could not show. Returns the keys that were
 * queued; a job that failed (a text that cannot be built) is removed after the drain, so the next call starts from an empty queue.
 */
async function drainQueue() {
  const drained = await jobIds();
  queue.resetEmbedPendingHint();
  for (let i = 0; i < 200 && await worker.runOneEmbedJob(); i++) { /* drain */ }
  await c('embed_jobs').deleteMany({});
  return drained;
}

/** The whole table, once without the records whose text cannot be built (the rules alone) and once with them (the walk must survive them). */
const backfillSuite = (withUnbuildable) => describe(`the reembed backfill counts each record once (real MongoDB), ${withUnbuildable ? 'with' : 'without'} the records whose text cannot be built`, { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'backfill-once-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: { typeSchemas: { fact: { secret: { suppressEmbeddings: true } } } } }],
    }, null, 2), { mode: 0o600 });
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', ch => { body += ch; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vectorFor(JSON.parse(body).input) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    mongo = await openTestMongo('backfillonce');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    MODEL = loader.getEmbeddingConfig().model;
    reembed = await import('../../server/dist/brain/reembed.js');
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    queue.resetEmbedPendingHint();
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
  });

  beforeEach(() => seed(withUnbuildable));

  it('the seeds are what the table says: each "current text" is the builder\'s text, each stale one is not, and the partition covers every record', async () => {
    const CURRENT = { 'fact:a1': 'facts', 'fact:a2': 'facts', 'fact:d1': 'facts', 'fact:o1': 'facts', 'fact:p1': 'facts', 'fact:h1': 'facts',
      'file:par-ok.md#chunk1': 'files', 'file:orph1#chunk0': 'files', 'file:orph2#chunk0': 'files', 'file:par-sup.md#chunk0': 'files', 'file:par-sup.md#chunk1': 'files' };
    for (const [key, part] of Object.entries(CURRENT)) {
      const [kind, ...rest] = key.split(':');
      const doc = await c(part).findOne({ _id: rest.join(':') });
      assert.equal(doc.matchedText, await embedRecord.buildEmbedText(SPACE, kind, doc), `${key} is not seeded with its current text`);
    }
    for (const key of ['fact:b1', 'fact:c1', 'fact:e1', 'fact:k1']) {
      const doc = await c('facts').findOne({ _id: key.slice(5) });
      assert.notEqual(doc.matchedText, await embedRecord.buildEmbedText(SPACE, 'fact', doc), `${key} is not seeded with a stale text`);
    }
    assert.equal(await embedRecord.buildEmbedText(SPACE, 'file', await c('files').findOne({ _id: 'f1' })), null, 'f1 is not a textless derived row');
    const seeded = [
      ...(await c('facts').find({}).toArray()).map(d => `fact:${d._id}`),
      ...(await c('edges').find({}).toArray()).map(d => `edge:${d._id}`),
      ...(await c('files').find({}).toArray()).map(d => `file:${d._id}`),
    ].sort();
    assert.deepEqual(everything(), seeded, 'a seeded record is in no outcome of the table, or in two');
  });

  // Declared only where the unbuildable record is seeded, so no run lists a permanent skip.
  if (withUnbuildable) {
    it('a call does not throw on a record whose own field has the wrong type or an edge whose endpoint kind is unknown', async () => {
      // One throwing record failed the whole call after jobs had been queued, and again on every later call.
      await assert.doesNotReject(reembed.reembedSpace(SPACE, { limit: 1000 }), 'the call failed on i1 (tags: "x") or i2 (fromKind "bogus")');
    });
  }

  it('with room for all of them, exactly the owed records are queued, each once, and the skipped ones are counted', async () => {
    const res = await reembed.reembedSpace(SPACE, { limit: 1000 });
    const queued = await jobIds();
    const missing = OWED.filter(k => !queued.includes(k));
    const extra = queued.filter(k => !OWED.includes(k));
    assert.deepEqual(missing, [], 'owed records no backfill queued');
    assert.deepEqual(extra, [], 'records queued that nothing owes (settled, skipped, spill or a record with no text)');
    assert.equal(new Set(queued).size, queued.length, 'a record was queued twice');
    assert.equal(res.enqueued, OWED.length);
    assert.equal(res.remaining, 0);
    assert.equal(res.truncated, false);
    assert.equal(res.skippedSuppressed, SKIPPED.length, `skippedSuppressed is the suppressed records left alone: ${SKIPPED}`);
    assert.equal(res.stale, STALE.length, `stale counts the owed records that hold a vector or are suppressed with an old text: ${STALE}`);
    assert.equal(Object.values(res.byKind).reduce((a, b) => a + b, 0), res.enqueued, 'byKind does not add up to enqueued');
  });

  it('under a cap smaller than the owed count, enqueued + remaining + skippedSuppressed is the counted set, and stale is inside enqueued', async () => {
    const LIMIT = 5;
    assert.ok(LIMIT < OWED.length, 'the cap must be smaller than the owed count for this case to ask anything');
    const res = await reembed.reembedSpace(SPACE, { limit: LIMIT });
    const queued = await jobIds();
    assert.equal(res.enqueued, LIMIT, 'the cap was not filled although more is owed');
    assert.equal(queued.length, LIMIT);
    assert.deepEqual(queued.filter(k => !OWED.includes(k)), [], 'a record nothing owes was queued under the cap');
    assert.equal(res.remaining, OWED.length - LIMIT, 'the owed records past the cap are counted in remaining, each once');
    assert.equal(res.skippedSuppressed, SKIPPED.length, 'a skipped record was counted twice, or not at all');
    assert.equal(res.enqueued + res.remaining + res.skippedSuppressed, OWED.length + SKIPPED.length, 'the counts are not a partition of the counted set');
    assert.equal(res.truncated, true);
    assert.ok(res.stale <= res.enqueued, `stale ${res.stale} is not a subset of enqueued ${res.enqueued}`);
    assert.ok(res.stale <= STALE.length);
  });

  it('calling again under the cap walks through every owed record exactly once, and never queues a settled one', async () => {
    const seen = [];
    for (let call = 0; call < 12; call++) {
      const res = await reembed.reembedSpace(SPACE, { limit: 5 });
      const drained = await drainQueue();
      seen.push(...drained);
      assert.deepEqual(drained.filter(k => !OWED.includes(k)), [], `call ${call + 1} queued a record nothing owes`);
      if (!res.truncated) break;
    }
    const once = seen.filter(k => !UNBUILDABLE.includes(k));
    assert.deepEqual([...new Set(once)].sort(), OWED.filter(k => !UNBUILDABLE.includes(k)), 'a record was never reached, or queued after it was settled');
    assert.equal(once.length, new Set(once).size, 'a record that can be built was queued in more than one call');
  });

  it('after the queue is drained, a second call queues only the record whose text can never be built', async () => {
    const first = await reembed.reembedSpace(SPACE, { limit: 1000 });
    assert.equal(first.enqueued, OWED.length, 'the first call had work');
    await drainQueue();
    const second = await reembed.reembedSpace(SPACE, { limit: 1000 });
    const queued = await jobIds();
    assert.deepEqual(queued.filter(k => !UNBUILDABLE.includes(k)), [], 'a settled record was queued again: the backfill does not converge');
    if (withUnbuildable) assert.ok(queued.includes('fact:i1'), 'the record whose text cannot be built is not owed: its job would never fail where an operator can see it');
    assert.equal(second.remaining, 0);
    assert.equal(second.truncated, false);
    assert.equal(second.enqueued, queued.length);
    assert.ok(second.stale <= second.enqueued);
  });
});

backfillSuite(false);
backfillSuite(true);

after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });
