/**
 * Every write that sets `seq` sets a fresh `pos` and `posAtSeq = seq` in the same write (bundle-81, design rev 8 §9 gates,
 * testing S5, §1b "One landing wrapper").
 *
 * ## The finding this holds
 *
 * A row's position is what sync pages and list order read; its `posAtSeq` records the version the position was taken for, so that
 * a row changed by a 5.6 build (which keeps `pos` when it `$set`s a row) is found and repaired at re-upgrade. A write that moves
 * `seq` and not `pos` hides the change from every puller and from the landing order; a write that moves `pos` and leaves
 * `posAtSeq` looks, to the repair, like a 5.6 edit. `a-seq-allocation-is-followed-by-its-write` says nothing about `pos` (it
 * asks that the next await is a write). This gate asks the other half, at runtime, of the write itself.
 *
 * ## What is derived, with a floor
 *
 * - **The mutators:** the driver's document-changing methods read from the server's own table (`MUTATORS`,
 *   `_document-mutators.mjs`, which reads `COLLECTION_METHOD_EFFECT`), observed on the collection prototype with the same park
 *   fixture `_write-faults.mjs` provides (armed per collection, never parking).
 * - **The collections:** every member of `SEQ_CARRYING` from `util/seq.ts` (the record families, files and tombstones).
 * - **The writes:** every write the local writers make while this file drives one create or edit per family and one delete of a
 *   fact (a tombstone): the document, replacement or update (`$set`, `$setOnInsert` or a pipeline stage) is read, and when it
 *   names `seq` it must also name a `pos` in the clock band (above 2^50) and a `posAtSeq` equal to that `seq`.
 * - **The floor:** at least one seq-setting write observed on every collection of `SEQ_CARRYING`. A collection with none is a
 *   writer this file does not drive, and fails rather than passing for nothing.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: every seq-setting write sets `seq` alone (there is no `pos` anywhere). Mutation for the newly covered part:
 * stamp `pos` without `posAtSeq` in one writer, and the case names that collection and method. Restore by hand.
 *
 * Database prefix: `b81tE_`. Run: node --test testing/standalone/every-seq-change-moves-the-position-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openB81Mongo, closeB81Mongo, mongoSkipReason } from './_b81e-mongo.mjs';
import { parkWrites } from './_write-faults.mjs';
import { MUTATORS } from './_document-mutators.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b81e-seq-pos-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'b81e-seqpos';
const CLOCK_BAND = 2 ** 50;
const ENT_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const ENT_B = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const FACT_1 = 'bbbbbbbb-0000-4000-8000-000000000001';

let mongo, park, seqMod;
/** `{ part, method, doc }` for every write observed that names `seq`. */
const seen = [];

/** The documents a write hands the driver, as plain objects: inserts, replacements, `$set`/`$setOnInsert`, pipeline `$set` stages. */
function documentsOf(method, args) {
  const fromUpdate = (u) => Array.isArray(u)
    ? u.filter(s => s && (s.$set || s.$addFields)).map(s => ({ ...(s.$set ?? {}), ...(s.$addFields ?? {}) }))
    : [{ ...(u?.$set ?? {}), ...(u?.$setOnInsert ?? {}) }];
  switch (method) {
    case 'insertOne': return [args[0]];
    case 'insertMany': return args[0];
    case 'replaceOne': case 'findOneAndReplace': return [args[1]];
    case 'updateOne': case 'updateMany': case 'findOneAndUpdate': return fromUpdate(args[1]);
    case 'bulkWrite': return args[0].flatMap(op => {
      const [kind, body] = Object.entries(op)[0];
      if (kind === 'insertOne') return [body.document];
      if (kind === 'replaceOne') return [body.replacement];
      if (kind === 'updateOne' || kind === 'updateMany') return fromUpdate(body.update);
      return [];
    });
    default: return [];
  }
}

const collectionOf = (part) => `${SPACE}_${part === 'files' ? 'files' : part}`;

before(async () => {
  if (skip) return;
  mongo = await openB81Mongo('seqpos');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'b81e-seqpos-test', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'E', folders: [], meta: {} }],
  }, null, 2), { mode: 0o600 });
  (await import('../../server/dist/config/loader.js')).loadConfig();
  seqMod = await import('../../server/dist/util/seq.js');
  park = parkWrites(Object.getPrototypeOf(mongo.col('probe')));
  for (const part of seqMod.SEQ_CARRYING) {
    const name = collectionOf(part);
    // `when` runs for every write to this collection, records it, and answers false: the park never holds anything.
    park.arm(name, {
      count: Number.MAX_SAFE_INTEGER,
      when: (method, args) => {
        for (const doc of documentsOf(method, args)) if (doc && typeof doc === 'object' && 'seq' in doc) seen.push({ part, method, doc });
        return false;
      },
    });
  }
  const db = mongo.getDb();
  await db.collection(collectionOf('entities')).insertMany([
    { _id: ENT_A, spaceId: SPACE, name: 'A', type: 'person', tags: [] },
    { _id: ENT_B, spaceId: SPACE, name: 'B', type: 'person', tags: [] },
  ]);
  seen.length = 0; // the two fixture rows above are this file's, not a writer's
});
after(async () => {
  park?.restore();
  await closeB81Mongo(mongo);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the mutators and the collections are derived', () => {
  it('the driver\'s document-changing methods come from the server\'s table, and SEQ_CARRYING has every record collection', async () => {
    assert.ok(MUTATORS.length >= 11, `only ${MUTATORS.length} mutators`);
    const { SEQ_CARRYING } = await import('../../server/dist/util/seq.js');
    for (const part of ['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones']) {
      assert.ok(SEQ_CARRYING.includes(part), `SEQ_CARRYING does not name ${part}`);
    }
  });
});

describe('every write that sets seq sets a fresh pos and posAtSeq = seq', { skip }, () => {
  it('one create or edit per family, an edit that converges, and a delete: every seq-setting write carries its position', async () => {
    const fact = await import('../../server/dist/brain/fact.js');
    const ents = await import('../../server/dist/brain/entities.js');
    const edges = await import('../../server/dist/brain/edges.js');
    const chrono = await import('../../server/dist/brain/chrono.js');
    const links = await import('../../server/dist/brain/links.js');
    const fileMeta = await import('../../server/dist/files/file-meta.js');
    const created = await fact.saveFact(SPACE, 'a fact', [], [], undefined, undefined, 'note');
    await ents.upsertEntity(SPACE, 'Held', 'concept', [], {});
    await ents.upsertEntity(SPACE, 'Held', 'concept', [], { description: 'edited, so the write converges on a held row' });
    await edges.upsertEdge(SPACE, ENT_A, ENT_B, 'knows');
    await chrono.createChrono(SPACE, { title: 'event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' });
    await links.addLink(SPACE, created._id ?? FACT_1, 'fact', ENT_A, 'entity');
    await fileMeta.upsertFileMeta(SPACE, 'held.md', 10);
    await fact.deleteFact(SPACE, created._id ?? FACT_1);

    const { SEQ_CARRYING } = seqMod;
    const parts = new Set(seen.map(s => s.part));
    const undriven = SEQ_CARRYING.filter(p => !parts.has(p));
    assert.deepEqual(undriven, [],
      `no seq-setting write was observed on ${undriven}: a collection of SEQ_CARRYING this file does not drive, or a writer that stopped setting seq. Observed: ${[...parts]}`);

    const problems = [];
    for (const { part, method, doc } of seen) {
      const where = `${part}.${method} seq=${doc.seq}`;
      if (typeof doc.pos !== 'number' || !(doc.pos > CLOCK_BAND)) problems.push(`${where}: sets no pos in the clock band (pos = ${JSON.stringify(doc.pos)})`);
      else if (doc.posAtSeq !== doc.seq && doc.posAtSeq !== '$seq') problems.push(`${where}: sets pos but posAtSeq = ${JSON.stringify(doc.posAtSeq)}, not the seq`);
    }
    assert.deepEqual(problems, [],
      'a write moved a record\'s version without moving its position (or its posAtSeq): every puller and the landing order miss the change, and the repair cannot tell it from a 5.6 edit');
  });
});
