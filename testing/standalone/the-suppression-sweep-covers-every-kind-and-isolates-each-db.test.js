/**
 * The suppression sweep covers FILES and their derived rows, isolates each record kind from the others' failures, and
 * retires the jobs it cancels in bounded chunks (Q-230; Q-361 item 11).
 *
 * ## The rules
 *
 *  - **Files are swept.** A file has two tiers, its own flag and the space: the space tier reaches every file row that
 *    holds a vector, parents and derived rows alike; the record tier reaches a flagged file and every row derived from
 *    it down to the ancestry the embed path reads (a caption chunk of an image extracted from a document is the
 *    document's too) — as deep as `MAX_ANCESTRY` of `brain/embed-record.ts`, the one bound the embed path and the sweep
 *    share, and no deeper. What goes is the vector and its model; `matchedText` stays, because the content did not change.
 *  - **The file-tier filter never keys on a type a file does not have.** Reusing the record kinds' filter with an
 *    undefined type field would match EVERY row (`$nin` of a missing field) — so a space whose only suppression is a
 *    TYPE schema must leave every file vector alone, and a space-tier sweep must count only rows that held a vector.
 *  - **Each kind is swept in its own try.** One collection the store refuses must not leave every kind after it holding
 *    its vectors. The failure is collected and raised once, naming every kind that failed; when it is the trigger
 *    (a meta write) that ran the sweep, the log carries ONE warning naming them — and ONLY them: a kind that swept
 *    cleanly is not in the message.
 *  - **Jobs are retired in chunks.** The ids of a large space are never one `$in`: a single delete over every id of a
 *    big space exceeds the 16 MB command limit and fails the whole retirement.
 *
 * Seen red on 6eb5a333 (5.6.3): files are not swept at all, the first failing kind stops the sweep, and every job is
 * retired by one delete.
 *
 * The chunk bound asserted is `SWEEP_BATCH` of `brain/embed-queue.ts`, imported; the fixture is sized from it, so the
 * case still has more ids than one chunk holds whatever the constant becomes.
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

let door, sweep, spaces, log, proto, SWEEP_BATCH, MAX_ANCESTRY, COLLECTION_SUFFIX;

const hasVector = async (part, id) => 'embedding' in ((await door.coll(S, part).findOne({ _id: id })) ?? {});
const job = async (kind, id) => !!(await door.coll(S, 'embed_jobs').findOne({ _id: `${kind}:${id}` }));
const queue = (kind, id) => door.coll(S, 'embed_jobs').insertOne({ _id: `${kind}:${id}`, recordType: kind, recordId: id, status: 'pending' });
const fact = (id, extra = {}) => ({ ...build.fact(S, id, 1), type: 'plain', ...VEC, ...extra });
const file = (id, extra = {}) => ({ ...build.filemeta(S, id, 1), ...VEC, ...extra });
const chunk = (id, parent, extra = {}) => ({ _id: id, spaceId: S, path: id, parentFileId: parent, content: `passage ${id}`, tags: [], ...VEC, ...extra });

/** The lines logged at `level` while `fn` runs; `fn` is handed the (growing) list, to wait on a line it expects. */
async function logged(level, fn) {
  const lines = [];
  const orig = log[level];
  log[level] = (...a) => { lines.push(a.join(' ')); };
  try { await fn(lines); } finally { log[level] = orig; }
  return lines;
}

/**
 * The kinds a sweep failure names, in the order it names them. The failure text is `the sweep failed for <kind>
 * (<reason>); <kind> (<reason>)`, so a kind is a word that opens an entry — never a word inside a driver's reason.
 */
const kindsNamedBy = (text) => [...String(text).matchAll(/(?:failed for |; )(\w+) \(/g)].map(m => m[1]);

describe('the suppression sweep covers every kind and isolates each', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'sweepkinds', spaces: [{ id: S, label: 'Sweep kinds', folders: [], meta: {} }] });
    sweep = await import('../../server/dist/brain/suppression-sweep.js');
    spaces = await import('../../server/dist/spaces/spaces.js');
    ({ log } = await import('../../server/dist/util/log.js'));
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    ({ SWEEP_BATCH } = await import('../../server/dist/brain/embed-queue.js'));
    ({ MAX_ANCESTRY } = await import('../../server/dist/brain/embed-record.js'));
    ({ COLLECTION_SUFFIX } = await import('../../server/dist/config/types-knowledge.js'));
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

    it('record tier: a row as deep below the flagged file as the embed path looks is swept, the row below that is not', async () => {
      // The chain is derived from the bound both paths share, and it is deeper than the two levels the first case covers.
      assert.ok(MAX_ANCESTRY > 2, `MAX_ANCESTRY is ${MAX_ANCESTRY}: this case exists for a chain deeper than two levels — re-anchor it`);
      const chain = ['docs/deep.md'];
      for (let depth = 1; depth <= MAX_ANCESTRY + 1; depth++) chain.push(`docs/deep.md#level${depth}`);
      await door.coll(S, 'files').insertMany([
        file(chain[0], { suppressEmbeddings: true }),
        ...chain.slice(1).map((id, i) => chunk(id, chain[i])),
      ]);
      await sweep.sweepSuppressedVectors(S, {});
      for (const id of chain.slice(0, MAX_ANCESTRY + 1)) {
        assert.equal(await hasVector('files', id), false, `${id} is within ${MAX_ANCESTRY} levels of the flagged file and kept its vector`);
      }
      const beyond = chain[MAX_ANCESTRY + 1];
      assert.equal(await hasVector('files', beyond), true,
        `${beyond} is deeper than the embed path looks, so it does not resolve to suppressed — the sweep took a vector nothing suppresses`);
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

    it('the fixture seeds every record kind the sweep walks', () => {
      const seeded = new Set(['entity', 'edge', 'chrono', 'fact']);
      const unseeded = Object.keys(COLLECTION_SUFFIX).filter(k => !seeded.has(k));
      assert.deepEqual(unseeded, [], `a record kind the sweep walks is not seeded by seedEveryKind: ${unseeded}`);
    });

    it('facts refuse the sweep: entities, edges, chrono and files are swept anyway, and the failure names only the kind', async () => {
      await seedEveryKind();
      await door.coll(S, 'facts_src').insertOne(fact('f1'));
      let raised;
      await withCollectionAsView(door.mongo.getDb(), `${S}_facts`, `${S}_facts_src`, async () => {
        raised = await sweep.sweepSuppressedVectors(S, { suppressEmbeddings: true }).then(() => null, (e) => e);
      });
      assert.deepEqual(await everyOtherKindSwept(), [], 'the first failing kind left the kinds after it holding their vectors');
      assert.ok(raised, 'a kind the store refused was swept over in silence');
      assert.deepEqual(kindsNamedBy(raised.message), ['fact'], `the failure names the kinds that failed, and only them: ${raised.message}`);
    });

    it('two kinds refuse: ONE failure names both, and the trigger logs ONE warning', async () => {
      await seedEveryKind();
      await door.coll(S, 'facts_src').insertOne(fact('f1'));
      await door.coll(S, 'edges_src').insertOne({ ...build.edge(S, 'g2', 1), ...VEC });
      await door.coll(S, 'edges').deleteMany({});
      let warnings = [];
      await withCollectionAsView(door.mongo.getDb(), `${S}_facts`, `${S}_facts_src`, () =>
        withCollectionAsView(door.mongo.getDb(), `${S}_edges`, `${S}_edges_src`, async () => {
          warnings = await logged('warn', async (lines) => {
            spaces.updateSpace(S, { meta: { suppressEmbeddings: true } });
            // Files are the last kind a run sweeps and the warning is logged as the run ends, so the file's vector going
            // and then the warning arriving are the run's own two last events — nothing is waited out.
            assert.ok(await eventually(async () => !(await hasVector('files', 'docs/a.md')), 10_000, 50),
              'the sweep did not reach the file kind after two kinds failed');
            assert.ok(await eventually(async () => lines.some(l => /sweep/i.test(l)), 10_000, 10),
              'two kinds refused the sweep and the trigger logged no warning');
          });
        }));
      const mine = warnings.filter(l => /sweep/i.test(l));
      assert.equal(mine.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
      assert.deepEqual(kindsNamedBy(mine[0]).sort(), ['edge', 'fact'], `the warning names the kinds that failed, and only them: ${mine[0]}`);
    });
  });

  describe('retiring the jobs', () => {
    it('is chunked: no delete names more ids than the bound, and every job still goes', async () => {
      // More ids than one chunk holds, so a delete over every id of the space could not pass for chunked.
      const N = SWEEP_BATCH * 2 + 200;
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
      assert.ok(deletes.length >= Math.ceil(N / SWEEP_BATCH), `${N} ids went in ${deletes.length} delete(s): ${JSON.stringify(deletes)}`);
      assert.ok(Math.max(...deletes) <= SWEEP_BATCH, `one delete named ${Math.max(...deletes)} ids`);
    });
  });
});