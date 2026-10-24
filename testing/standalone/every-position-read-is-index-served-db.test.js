/**
 * Every read by position is served by the `(pos, _id)` index, with no blocking sort (bundle-81, design rev 8 §3 step 7, decisions 9
 * and 32, P36).
 *
 * ## The finding this holds
 *
 * The default order of every Brain list is landing order (`LANDING_ORDER = { pos: -1, _id: -1 }`), the sync pager reads by
 * `(pos, _id)`, the fresh-write scan sorts by `pos` with no `$match`, and the first carry looks up `pos: null`. MongoDB uses a
 * PARTIAL index only when the query names its predicate, and none of these does, so a partial `(pos, _id)` index would be
 * ignored: each read would scan and sort a whole collection, and `fresh-writes.ts` swallows the sort-memory failure and answers
 * `[]` (data-integrity S8, performance S1). The index is non-partial, declared in `SPACE_INDEXES`, and this gate holds every read
 * to it at a size where a blocking sort is not an accident of a small test (50,000 rows).
 *
 * ## What is derived, with a floor
 *
 * - **The collections:** `SEQ_CARRYING` from `util/seq.ts` (the record families, files and tombstones), never listed here. Floor 7
 *   is not asserted by number: each is driven, and the loop asserts at least the five record collections ran.
 * - **The sorts:** `LANDING_ORDER` from `brain/query.ts`, plus every sort document on `pos` that `server/src` spells
 *   (`git grep -n -E "pos: ?-?1"`, comments blanked), canonicalised. Floor 4 hits, as the plan says; today there are none.
 * - **The reads:** for each collection, each sort as a `find().sort().limit()`, the fresh-write shape (`$sort` then `$limit`, no
 *   `$match`), the ascending range the pager reads (`pos > n` sorted by `(pos, _id)`) and the carry's `pos: null` lookup.
 * - **The index:** the entries of `SPACE_INDEXES` for the collection, built by the server's own `buildSpaceIndex`, so what is
 *   declared is what is measured. A declared `pos` index must not carry `partialFilterExpression`.
 * - **The assertion:** the winning plan has an `IXSCAN` on `pos_1__id_1` and NO stage named exactly `SORT` (decision 32: a
 *   `SORT_MERGE` is streaming and passes; a blocking `SORT` fails).
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: `LANDING_ORDER` is not exported, no source spells a `pos` sort, and `SPACE_INDEXES` declares no `pos` index, so
 * every read is a collection scan with a blocking sort (the explain shows `COLLSCAN` and `SORT`). Mutation for the newly covered
 * part: add `partialFilterExpression: { pos: { $exists: true } }` to the declaration and the unnamed reads go red. Restore by hand.
 *
 * Database prefix: `b81tE_`. Run: node --test testing/standalone/every-position-read-is-index-served-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openB81Mongo, closeB81Mongo, mongoSkipReason } from './_b81e-mongo.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b81e-explain-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'b81e-explain';
const ROWS = 50_000;
const SORT_SPELLING_FLOOR = 4;
const COLLECTION_FLOOR = 5;
const INDEX_NAME = 'pos_1__id_1';
const POS_BASE = 1_790_000_000_000_000;

let mongo, seqMod, indexes, spaceColl, query;

/** Every sort document on `pos` the server source spells, canonicalised: `{ pos: -1, _id: -1 }` and the like. */
function spelledPosSorts() {
  const out = new Map();
  let hits = 0;
  for (const file of trackedSources('server/src', { floor: 200 })) {
    const text = blankComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    for (const m of text.matchAll(/\{\s*pos\s*:\s*(-?1)\s*(?:,\s*_id\s*:\s*(-?1)\s*)?\}/g)) {
      hits++;
      const doc = { pos: Number(m[1]), ...(m[2] ? { _id: Number(m[2]) } : {}) };
      out.set(JSON.stringify(doc), doc);
    }
  }
  return { hits, sorts: [...out.values()] };
}

/** Every stage name in an explain plan, at any depth. */
const stagesOf = (plan) => [...JSON.stringify(plan).matchAll(/"stage":"([A-Z_]+)"/g)].map(m => m[1]);
const indexNamesOf = (plan) => [...JSON.stringify(plan).matchAll(/"indexName":"([^"]+)"/g)].map(m => m[1]);

before(async () => {
  if (skip) return;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'E' }], networks: [], tokens: [] }, null, 2));
  mongo = await openB81Mongo('explain');
  (await import('../../server/dist/config/loader.js')).loadConfig();
  seqMod = await import('../../server/dist/util/seq.js');
  query = await import('../../server/dist/brain/query.js');
  spaceColl = await import('../../server/dist/db/space-collection.js');
  indexes = await import('../../server/dist/spaces/space-indexes.js');
});
after(async () => {
  await closeB81Mongo(mongo);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the subjects are derived', () => {
  it('a sort on `pos` is spelled in the source at least four times, and LANDING_ORDER is exported', async () => {
    const { hits } = spelledPosSorts();
    assert.ok(hits >= SORT_SPELLING_FLOOR,
      `only ${hits} sort document(s) on \`pos\` are spelled in server/src (floor ${SORT_SPELLING_FLOOR}): no reader of the landing order exists yet, so there is nothing for an index to serve`);
    const q = await import('../../server/dist/brain/query.js');
    assert.ok(q.LANDING_ORDER && q.LANDING_ORDER.pos === -1, 'brain/query.ts exports no LANDING_ORDER = { pos: -1, _id: -1 }');
  });

  it('SPACE_INDEXES declares a non-partial (pos, _id) index on every seq-carrying collection', async () => {
    const ix = await import('../../server/dist/spaces/space-indexes.js');
    const { SEQ_CARRYING } = await import('../../server/dist/util/seq.js');
    assert.ok(SEQ_CARRYING.length >= 6, `SEQ_CARRYING has ${SEQ_CARRYING.length} members: the derivation is broken`);
    const missing = [];
    const partial = [];
    for (const part of SEQ_CARRYING) {
      const declared = ix.SPACE_INDEXES.filter(i => i.part === part && Object.keys(i.keys).join() === 'pos,_id');
      if (declared.length !== 1) missing.push(part);
      else if (declared[0].options.partialFilterExpression) partial.push(part);
    }
    assert.deepEqual(missing, [], 'collections with no declared (pos, _id) index');
    assert.deepEqual(partial, [], 'a PARTIAL (pos, _id) index is used only by a query that names its predicate, and no position read does');
  });
});

describe('every read by position is an IXSCAN on pos_1__id_1 with no blocking SORT', { skip, timeout: 600_000 }, () => {
  it('50,000 rows per collection, the declared indexes built, every subject explained', async () => {
    const { SEQ_CARRYING } = seqMod;
    const sorts = [
      ...(query.LANDING_ORDER ? [query.LANDING_ORDER] : [{ pos: -1, _id: -1 }]),
      ...spelledPosSorts().sorts,
      { pos: 1, _id: 1 },
    ];
    const canonical = [...new Map(sorts.map(s => [JSON.stringify(s), s])).values()];
    const failures = [];
    let driven = 0;
    for (const part of SEQ_CARRYING) {
      const name = spaceColl.spaceCollection(SPACE, part);
      const coll = mongo.getDb().collection(name);
      const docs = Array.from({ length: ROWS }, (_, i) => ({ _id: `r${String(i).padStart(6, '0')}`, seq: i + 1, pos: POS_BASE + i, type: 'x', name: `n${i}` }));
      for (let at = 0; at < docs.length; at += 10_000) await coll.insertMany(docs.slice(at, at + 10_000), { ordered: false });
      for (const ix of indexes.SPACE_INDEXES.filter(i => i.part === part)) {
        try { await indexes.buildSpaceIndex(SPACE, ix); } catch { /* a declared index this fixture cannot satisfy is not this gate's subject */ }
      }
      const shapes = [
        ...canonical.map(s => ({ label: `sort ${JSON.stringify(s)}`, plan: () => coll.find({}).sort(s).limit(50).explain('queryPlanner') })),
        { label: 'fresh-write scan ($sort then $limit, no $match)', plan: () => coll.aggregate([{ $sort: { pos: -1 } }, { $limit: 20 }]).explain('queryPlanner') },
        { label: 'pager range (pos > n by (pos, _id))', plan: () => coll.find({ pos: { $gt: POS_BASE + 100 } }).sort({ pos: 1, _id: 1 }).limit(200).explain('queryPlanner') },
        { label: 'the carry\'s `pos: null` lookup', plan: () => coll.find({ pos: null }).limit(1000).explain('queryPlanner') },
      ];
      for (const s of shapes) {
        const plan = await s.plan();
        const winning = plan.queryPlanner?.winningPlan ?? plan.stages?.[0]?.$cursor?.queryPlanner?.winningPlan ?? plan;
        const stages = stagesOf(winning);
        const names = indexNamesOf(winning);
        const problems = [];
        if (!stages.includes('IXSCAN') || !names.includes(INDEX_NAME)) problems.push(`no IXSCAN on ${INDEX_NAME} (stages ${stages.join('>')}, indexes ${names.join(',') || 'none'})`);
        if (stages.includes('SORT')) problems.push('a blocking SORT');
        if (problems.length > 0) failures.push(`${part}: ${s.label}: ${problems.join('; ')}`);
      }
      driven++;
    }
    assert.ok(driven >= COLLECTION_FLOOR, `only ${driven} collection(s) driven`);
    assert.deepEqual(failures, [], 'a read by position that the index does not serve: it scans and sorts a whole collection');
  });
});
