/**
 * The suppression sweep covers FILES and their derived rows, isolates each record kind from the others' failures, and
 * retires the jobs it cancels in bounded chunks (Q-230; Q-361 item 11).
 *
 * ## The rules
 *
 *  - **Files are swept.** A file has two tiers, its own flag and the space: the space tier reaches every file row that
 *    holds a vector, parents and derived rows alike; the record tier reaches a flagged file and every row derived from
 *    it down to the ancestry the embed path reads (a caption chunk of an image extracted from a document is the
 *    document's too). What goes is the vector and its model; `matchedText` stays, because the content did not change.
 *  - **The file-tier filter never keys on a type a file does not have.** Reusing the record kinds' filter with an
 *    undefined type field would match EVERY row (`$nin` of a missing field) — so a space whose only suppression is a
 *    TYPE schema must leave every file vector alone, and a space-tier sweep must count only rows that held a vector.
 *  - **Each kind is swept in its own try.** One collection the store refuses must not leave every kind after it holding
 *    its vectors. The failure is collected and raised once, naming every kind that failed; when it is the trigger
 *    (a meta write) that ran the sweep, the log carries ONE warning naming them.
 *  - **Jobs are retired in chunks.** The ids of a large space are never one `$in`: a single delete over every id of a
 *    big space exceeds the 16 MB command limit and fails the whole retirement.
 *
 * Seen red on 6eb5a333 (5.6.3): files are not swept at all, the first failing kind stops the sweep, and every job is
 * retired by one delete.
 *
 * The chunk bound asserted is 500 ids per delete (`SWEEP_BATCH` in `brain/embed-queue.ts`, the size the plan names).
 *
 * Run: node --test testing/standalone/the-suppression-sweep-covers-every-kind-and-isolates-each-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { withCollectionAsView, eventually } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'sweepkinds';
const VEC = { embedding: [0.25, 0.5, 0.75], embeddingModel: 'receiver-model', matchedText: 'the text it holds' };
const MAX_JOB_IDS_PER_DELETE = 500;

let door, sweep, spaces, log, proto;

const hasVector = async (part, id) => 'embedding' in ((await door.coll(S, part).findOne({ _id: id })) ?? {});
const job = async (kind, id) => !!(await door.coll(S, 'embed_jobs').findOne({ _id: `${kind}:${id}` }));
const queue = (kind, id) => door.coll(S, 'embed_jobs').insertOne({ _id: `${kind}:${id}`, recordType: kind, recordId: id, status: 'pending' });
const fact = (id, extra = {}) => ({ ...build.fact(S, id, 1), type: 'plain', ...VEC, ...extra });
const file = (id, extra = {}) => ({ ...build.filemeta(S, id, 1), ...VEC, ...extra });
const chunk = (id, parent, extra = {}) => ({ _id: id, spaceId: S, path: id, parentFileId: parent, content: `passage ${id}`, tags: [], ...VEC, ...extra });

/** The lines logged at `level` while `fn` runs. */
async function logged(level, fn) {
  const lines = [];
  const orig = log[level];
  log[level] = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { log[level] = orig; }
  return lines;
}

describe('the suppression sweep covers every kind and isolates each', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'sweepkinds', spaces: [{ id: S, label: 'Sweep kinds', folders: [], meta: {} }] });
    sweep = await import('../../server/dist/brain/suppression-sweep.js');
    spaces = await import('../../server/dist/spaces/spaces.js');
    ({ log } = await import('../../server/dist/util/log.js'));
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    for (const src of ['facts_src', 'edges_src']) await door.coll(S, src).drop().catch(() => {});
  });

  describe('files', () => {
    it('space tier: every file row that holds a vector loses embedding and embeddingModel; matchedText stays; its job is retired', async () => {
      await door.coll(S, 'files').insertMany([file('docs/a.md'), chunk('docs/a.md#chunk0', 'docs/a.md')]);
      await queue('file', 'docs/a.md');
      await sweep.sweepSuppressedVectors(S, { suppressEmbeddings: true });
      for (const id of ['docs/a.md', 'docs/a.md#chunk0']) {
        const d = await door.coll(S, 'files').findOne({ _id: id });
        assert.deepEqual(['embedding', 'embeddingModel'].filter(f => f in d), [], `${id} still holds its vector`);
        assert.equal(d.matchedText, VEC.matchedText, `${id} lost its matchedText — the content did not change`);
      }
      assert.equal(await job('file', 'docs/a.md'), false, 'the file\'s queued job was left to write the vector straight back');
    });

    it('record tier: a flagged file and every row derived from it down its ancestry lose their vectors; other files keep theirs', async () => {
      await door.coll(S, 'files').insertMany([
        file('docs/flagged.md', { suppressEmbeddings: true }),
        chunk('docs/flagged.md#chunk0', 'docs/flagged.md'),
        chunk('docs/flagged.md#chunk0#caption', 'docs/flagged.md#chunk0'),
        file('docs/other.md'), chunk('docs/other.md#chunk0', 'docs/other.md'),
      ]);
      await sweep.sweepSuppressedVectors(S, {});
      for (const id of ['docs/flagged.md', 'docs/flagged.md#chunk0', 'docs/flagged.md#chunk0#caption']) {
        assert.equal(await hasVector('files', id), false, `${id} (the flagged file's own tree) still holds a vector`);
      }
      for (const id of ['docs/other.md', 'docs/other.md#chunk0']) {
        assert.equal(await hasVector('files', id), true, `${id} (not suppressed) lost its vector`);
      }
    });

    it('the file tier never keys on a type: a TYPE schema that suppresses touches no file', async () => {
      await door.coll(S, 'files').insertMany([file('docs/a.md'), chunk('docs/a.md#chunk0', 'docs/a.md')]);
      await door.coll(S, 'facts').insertOne(fact('f-muted', { type: 'muted' }));
      await sweep.sweepSuppressedVectors(S, { typeSchemas: { fact: { muted: { suppressEmbeddings: true } } } });
      assert.equal(await hasVector('facts', 'f-muted'), false, 'fixture check: the type schema did not sweep its own record');
      assert.equal(await hasVector('files', 'docs/a.md'), true, 'a files-tier filter keyed on an undefined type swept a file no tier suppresses');
      assert.equal(await hasVector('files', 'docs/a.md#chunk0'), true);
    });

    it('a space-tier sweep reports only the rows that held a vector, kind file counting rows', async () => {
      await door.coll(S, 'files').insertMany([
        file('docs/a.md'), chunk('docs/a.md#chunk0', 'docs/a.md'),
        { ...build.filemeta(S, 'docs/b.md', 1) }, { ...chunk('docs/b.md#chunk0', 'docs/b.md'), embedding: undefined },
      ]);
      await door.coll(S, 'files').updateOne({ _id: 'docs/b.md#chunk0' }, { $unset: { embedding: '', embeddingModel: '' } });
      const lines = await logged('info', () => sweep.sweepSuppressedVectors(S, { suppressEmbeddings: true }));
      assert.deepEqual(lines.filter(l => /Suppression sweep/.test(l)), [`Suppression sweep: removed 2 file vector(s) in ${S}`]);
    });
  });

  describe('each kind is swept in its own try', () => {
    /** Rows of every kind holding a vector, and a queued job each. */
    async function seedEveryKind() {
      await door.coll(S, 'entities').insertOne({ ...build.entity(S, 'e', 1), ...VEC });
      await door.coll(S, 'edges').insertOne({ ...build.edge(S, 'g', 1), ...VEC });
      await door.coll(S, 'chrono').insertOne({ ...build.chrono(S, 'c', 1), ...VEC });
      await door.coll(S, 'files').insertOne(file('docs/a.md'));
      for (const [kind, id] of [['entity', 'e'], ['edge', 'g'], ['chrono', 'c'], ['file', 'docs/a.md']]) await queue(kind, id);
    }
    const everyOtherKindSwept = async () => {
      const wrong = [];
      for (const [part, kind, id] of [['entities', 'entity', 'e'], ['edges', 'edge', 'g'], ['chrono', 'chrono', 'c'], ['files', 'file', 'docs/a.md']]) {
        if (await hasVector(part, id)) wrong.push(`${part}/${id} still holds its vector`);
        if (await job(kind, id)) wrong.push(`${kind}:${id}'s job was not retired`);
      }
      return wrong;
    };

    it('facts refuse the sweep: entities, edges, chrono and files are swept anyway, and the failure names the kind', async () => {
      await seedEveryKind();
      await door.coll(S, 'facts_src').insertOne(fact('f1'));
      let raised;
      await withCollectionAsView(door.mongo.getDb(), `${S}_facts`, `${S}_facts_src`, async () => {
        raised = await sweep.sweepSuppressedVectors(S, { suppressEmbeddings: true }).then(() => null, (e) => e);
      });
      assert.deepEqual(await everyOtherKindSwept(), [], 'the first failing kind left the kinds after it holding their vectors');
      assert.ok(raised, 'a kind the store refused was swept over in silence');
      assert.match(String(raised.message), /\bfact\b/, `the failure does not name the kind that failed: ${raised.message}`);
    });

    it('two kinds refuse: ONE failure names both, and the trigger logs ONE warning', async () => {
      await seedEveryKind();
      await door.coll(S, 'facts_src').insertOne(fact('f1'));
      await door.coll(S, 'edges_src').insertOne({ ...build.edge(S, 'g2', 1), ...VEC });
      await door.coll(S, 'edges').deleteMany({});
      let warnings = [];
      await withCollectionAsView(door.mongo.getDb(), `${S}_facts`, `${S}_facts_src`, () =>
        withCollectionAsView(door.mongo.getDb(), `${S}_edges`, `${S}_edges_src`, async () => {
          warnings = await logged('warn', async () => {
            spaces.updateSpace(S, { meta: { suppressEmbeddings: true } });
            await eventually(async () => !(await hasVector('entities', 'e')), 10_000, 50);
            await new Promise(r => setTimeout(r, 500));
          });
        }));
      const mine = warnings.filter(l => /sweep/i.test(l));
      assert.equal(mine.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
      assert.match(mine[0], /\bfact\b/);
      assert.match(mine[0], /\bedge\b/);
    });
  });

  describe('retiring the jobs', () => {
    it('is chunked: no delete names more ids than the bound, and every job still goes', async () => {
      const N = 1_200;
      const ids = Array.from({ length: N }, (_, i) => `f${String(i).padStart(4, '0')}`);
      await door.coll(S, 'facts').insertMany(ids.map(id => fact(id)));
      await door.coll(S, 'embed_jobs').insertMany(ids.map(id => ({ _id: `fact:${id}`, recordType: 'fact', recordId: id, status: 'pending' })));
      const deletes = [];
      const orig = proto.deleteMany;
      proto.deleteMany = function recording(filter, ...rest) {
        if (this.collectionName === `${S}_embed_jobs`) deletes.push(filter?._id?.$in?.length ?? Infinity);
        return orig.call(this, filter, ...rest);
      };
      try { await sweep.sweepSuppressedVectors(S, { suppressEmbeddings: true }); } finally { proto.deleteMany = orig; }
      assert.equal(await door.coll(S, 'embed_jobs').countDocuments({}), 0, 'a queued job survived the sweep');
      assert.ok(deletes.length >= Math.ceil(N / MAX_JOB_IDS_PER_DELETE), `${N} ids went in ${deletes.length} delete(s): ${JSON.stringify(deletes)}`);
      assert.ok(Math.max(...deletes) <= MAX_JOB_IDS_PER_DELETE, `one delete named ${Math.max(...deletes)} ids`);
    });
  });
});