/**
 * The three embedding-suppression tiers split every record into exactly one side: suppressed, or not (Q-184).
 *
 * ## The defect
 *
 * `suppressionExclusion` (`brain/queue-embed-sweep.ts`, the records a sweep may embed) and `suppressedWithVectorFilter`
 * (`brain/suppression-sweep.ts`, the records the sweep strips) each looped over `meta.typeSchemas` with a rule of their own.
 * They agreed by a hand check only: a tier rule changed in one would not reach the other, and a record would be embedded and
 * stripped in a loop (suppressed by neither filter, but excluded by the other), or neither.
 *
 * ## The rule this file holds
 *
 * For one fixture set, in a real MongoDB, for every record kind and every meta: **each seeded record matches exactly one of the
 * suppressed filter and the not-suppressed filter** (an `'all'` exclusion reads "everything is suppressed"), and the suppressed
 * side is the record's own answer, `embeddingSuppressed`, written out by hand per row (the record tier's `false` is "not
 * stated"; a schema's `false` releases its type from the space tier). The fixture covers the record flag true / false / absent,
 * the schema flag true / false / absent, the space on / off / absent, a type with no schema and a record with no type at all,
 * for entities, facts, edges (keyed on `label`), chrono and files (no schema tier).
 *
 * ## Which rows are red today
 *
 * The first block is written against the two EXISTING functions and passes on unchanged code: it pins the partition. The
 * second block asks the module the change creates (`server/dist/brain/suppression-tiers.js`, `suppressionTiers`); on unchanged
 * code each of its rows fails on the module that does not exist yet.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-suppression-tiers-partition-every-record-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-suppression-tiers-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const S = 'suppresstiers';
/** The kinds a sweep walks and each one's collection suffix (`COLLECTION` in `brain/embed-record.ts`). */
const KINDS = { entity: 'entities', fact: 'facts', edge: 'edges', chrono: 'chrono', file: 'files' };
/** The key a kind's schema is looked up by (`TYPE_FIELD`): edges key on `label`, a file has none. */
const FIELD = { entity: 'type', fact: 'type', edge: 'label', chrono: 'type', file: undefined };

/** The type names the fixture seeds, and what each one's schema states in the metas below. */
const TYPES = ['stated-true', 'stated-false', 'stated-none', 'no-schema', undefined];
const SCHEMAS = { 'stated-true': { suppressEmbeddings: true }, 'stated-false': { suppressEmbeddings: false }, 'stated-none': {} };
/** The record tier: absent, `false` (not stated) and `true`. */
const RECORD_FLAGS = [undefined, false, true];

const withSchemas = (space) => ({
  ...(space === undefined ? {} : { suppressEmbeddings: space }),
  typeSchemas: Object.fromEntries(['entity', 'fact', 'edge', 'chrono'].map((k) => [k, SCHEMAS])),
});
/** Every meta a space can be in: the space tier absent / off / on, each with and without schemas. */
const METAS = {
  'space absent, no schemas': {},
  'space off, no schemas': { suppressEmbeddings: false },
  'space on, no schemas': { suppressEmbeddings: true },
  'space absent, schemas': withSchemas(undefined),
  'space off, schemas': withSchemas(false),
  'space on, schemas': withSchemas(true),
};

let mongo, spaceCollection, embeddingSuppressed, sweep, exclusionOf, tiers = null, tiersError = null;
/** The seeded rows of each kind: `{ _id, type, flag }`. */
const seeded = {};

const idOf = (kind, type, flag) => `${kind}|${type ?? 'none'}|${flag === undefined ? 'absent' : flag}`;

before(async () => {
  if (skip) return;
  mongo = await openTestMongo(S);
  ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
  ({ embeddingSuppressed } = await import('../../server/dist/brain/suppress-embeddings.js'));
  sweep = await import('../../server/dist/brain/suppression-sweep.js');
  exclusionOf = (await import('../../server/dist/brain/queue-embed-sweep.js')).suppressionExclusion;
  try { tiers = await import('../../server/dist/brain/suppression-tiers.js'); } catch (err) { tiersError = err; }
  for (const [kind, suffix] of Object.entries(KINDS)) {
    const docs = [];
    for (const type of kind === 'file' ? [undefined] : TYPES) {
      for (const flag of RECORD_FLAGS) {
        docs.push({
          _id: idOf(kind, type, flag), embedding: [0.25, 0.5],
          ...(FIELD[kind] && type !== undefined ? { [FIELD[kind]]: type } : {}),
          ...(flag === undefined ? {} : { suppressEmbeddings: flag }),
        });
      }
    }
    await mongo.col(spaceCollection(S, suffix)).insertMany(docs);
    seeded[kind] = docs.map((d) => ({ _id: d._id, type: d[FIELD[kind]], flag: d['suppressEmbeddings'] }));
  }
});

after(async () => { await closeTestMongo(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const idsMatching = async (kind, filter) =>
  (await mongo.col(spaceCollection(S, KINDS[kind])).find(mongo.asFilter(filter), { projection: { _id: 1 } }).toArray()).map((d) => d._id).sort();

/** What each seeded row resolves to, written out by hand from the tier rule (`record > schema > space`), not read from any filter. */
function expectedSuppressed(meta, kind, row) {
  const schema = kind === 'file' || row.type === undefined ? undefined : meta.typeSchemas?.[kind]?.[row.type];
  return embeddingSuppressed({ record: row.flag === true ? true : undefined, schema, space: meta.suppressEmbeddings });
}

/** The two sides' ids for one kind and meta, from a pair of filters (`notSuppressed` null = nothing is left unsuppressed). */
async function sides(kind, suppressed, notSuppressed) {
  return { suppressed: suppressed ? await idsMatching(kind, suppressed) : [], notSuppressed: notSuppressed ? await idsMatching(kind, notSuppressed) : [] };
}

/** Assert the partition: every row on exactly one side, and the suppressed side is the hand-written expectation. */
function assertPartition(label, kind, got) {
  const all = seeded[kind].map((r) => r._id).sort();
  const both = got.suppressed.filter((id) => got.notSuppressed.includes(id));
  assert.deepEqual(both, [], `${label}: rows matching BOTH the suppressed and the not-suppressed filter`);
  assert.deepEqual([...got.suppressed, ...got.notSuppressed].sort(), all, `${label}: rows matching NEITHER (or a row missing from the fixture)`);
}

function assertSuppressedSide(label, meta, kind, got) {
  const expected = seeded[kind].filter((r) => expectedSuppressed(meta, kind, r)).map((r) => r._id).sort();
  assert.deepEqual(got.suppressed, expected, `${label}: the suppressed side is not what record > schema > space says`);
}

describe('the existing two filters partition every record', { skip }, () => {
  for (const [metaName, meta] of Object.entries(METAS)) {
    for (const kind of Object.keys(KINDS)) {
      it(`${kind}, ${metaName}`, async () => {
        const exclusion = exclusionOf(meta, kind);
        const notSuppressed = exclusion === 'all' ? null : exclusion.query;
        // The stripping filter is for the typed kinds: a file's strip is the sweep's own two-case read (`sweepFiles`).
        const suppressed = kind === 'file' ? null : sweep.suppressedWithVectorFilter(meta, kind);
        const got = await sides(kind, suppressed, notSuppressed);
        if (kind === 'file') {
          // No stripping filter for a file: the complement of the exclusion is the suppressed side.
          got.suppressed = seeded[kind].map((r) => r._id).filter((id) => !got.notSuppressed.includes(id)).sort();
        }
        assertPartition(`${kind}, ${metaName}`, kind, got);
        assertSuppressedSide(`${kind}, ${metaName}`, meta, kind, got);
      });
    }
  }
});

/** The module the change creates — read per row, so a missing one fails EACH row with its own message. */
function tiersModule() {
  if (tiers?.suppressionTiers) return tiers.suppressionTiers;
  throw new Error('server/dist/brain/suppression-tiers.js exports no suppressionTiers — the one classification of the three tiers '
    + `(Q-184) does not exist yet (${tiersError?.message ?? 'no export'})`);
}

describe('suppressionTiers yields both filters from one classification', { skip }, () => {
  for (const [metaName, meta] of Object.entries(METAS)) {
    for (const kind of Object.keys(KINDS)) {
      it(`${kind}, ${metaName}`, async () => {
        const { suppressed, notSuppressed } = tiersModule()(meta, kind);
        const got = await sides(kind, suppressed, notSuppressed);
        assertPartition(`${kind}, ${metaName}`, kind, got);
        assertSuppressedSide(`${kind}, ${metaName}`, meta, kind, got);
      });

      it(`${kind}, ${metaName}: both sweeps ask it, so they read the sets it names`, async () => {
        const { suppressed, notSuppressed } = tiersModule()(meta, kind);
        const exclusion = exclusionOf(meta, kind);
        assert.deepEqual(exclusion === 'all' ? [] : await idsMatching(kind, exclusion.query), notSuppressed ? await idsMatching(kind, notSuppressed) : [],
          `${kind}, ${metaName}: suppressionExclusion is not the module's not-suppressed side`);
        if (kind !== 'file') {
          assert.deepEqual(await idsMatching(kind, sweep.suppressedWithVectorFilter(meta, kind)), await idsMatching(kind, suppressed),
            `${kind}, ${metaName}: suppressedWithVectorFilter is not the module's suppressed side (every seeded row holds a vector)`);
        }
      });
    }
  }

  it('a suppressed row without a vector is never swept, though the suppressed side names it', async () => {
    const meta = METAS['space on, no schemas'];
    const coll = mongo.col(spaceCollection(S, 'facts'));
    await coll.insertOne({ _id: 'fact|vectorless', type: 'no-schema', embedding: [] });
    try {
      const swept = await idsMatching('fact', sweep.suppressedWithVectorFilter(meta, 'fact'));
      assert.ok(!swept.includes('fact|vectorless'), 'a row holding no vector was selected for stripping');
      const { suppressed } = tiersModule()(meta, 'fact');
      assert.ok((await idsMatching('fact', suppressed)).includes('fact|vectorless'), 'the suppressed side must name a vectorless row too: it is the tier, not the sweep');
    } finally { await coll.deleteOne({ _id: 'fact|vectorless' }); }
  });
});
