/**
 * The filtered holds-read selects what the index's native filter selects (Q-696, design v3 item 5).
 *
 * ## The premise this pins
 *
 * A filtered recall whose native `$vectorSearch` answered nothing asks the collection a second question: does an aged vectored
 * record satisfy the caller's predicate (`holdsRecordTheIndexShouldServe` with `filter` and `maxAge`, a `findOne` in MongoDB's own
 * grammar)? When it says "none", the empty answer is complete and the index is never asked again. That is only sound if the
 * predicate, written as a MongoDB filter, selects the same records as the filter the index applied, written as a `$vectorSearch`
 * native filter - two grammars over two engines. If they diverged, "none" would be said over a record the index should have served
 * (a confident empty over a missed match, the defect), or "some" over a record it rightly excluded (a reason where there is none).
 *
 * Probed once by hand (11 of 11 selections identical, 2026-11-05); this keeps it a test, so a later mongot change that breaks
 * the parity goes red here, before a recall says the wrong thing.
 *
 * ## What each row asserts
 *
 * Over a SERVING index (every record aged, so the age bound of the holds-read does not decide), per filter:
 *  - the index answering one record or more means the holds-read says yes;
 *  - the index answering none means the holds-read says no.
 *
 * ## Where the rows come from
 *
 * Never a hand list of operators. The native operators are asked of production's own `rawToNativeVectorFilter` over every
 * MongoDB comparison and array operator the grammar has: those it pushes are the table's operators, cross-checked against the
 * constant's own source text so a candidate missing from the list cannot hide an operator. Every pushed operator must have a
 * sample (a hit and a miss) here, so adding one to the code fails this file until its rows exist. Beside the operators: a scalar, a
 * `tags` list, and an `$and` of clauses. A floor on the rows, and on the rows of each answer, keeps an empty table from passing.
 *
 * ## It may be green on the base
 *
 * It pins a premise, not a change: both halves exist today (`holdsRecordTheIndexShouldServe` is the boolean the build keeps). It
 * is still a test: the last case plants rows whose two filters disagree and requires the comparison to say so.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-filtered-holds-read-selects-what-the-index-filter-selects-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { unitAt, queryAxis, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing } from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const SPACE = 'parity';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-holdsparity-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

/** An hour ago: outside the fresh-write window, so the holds-read's age bound admits every record. */
const OLD = new Date(Date.now() - 3_600_000).toISOString();

/** Every MongoDB operator that could plausibly be a native filter's: asked of the code, never trusted as the answer. */
const CANDIDATE_OPS = ['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists', '$regex', '$not', '$size', '$all',
  '$elemMatch', '$mod', '$type', '$text', '$expr'];

/**
 * A hit (selects at least one record) and a miss (selects none) per native operator, on a number the space declares
 * (`properties.n`) and on a string every entity has (`name`). The records: n is 5, 10, the STRING '7', none, none; names are
 * alpha, beta, gamma, delta, epsilon.
 */
const SAMPLES = {
  '$eq': { 'properties.n': { hit: 5, miss: 99 }, name: { hit: 'alpha', miss: 'nope' } },
  '$in': { 'properties.n': { hit: [5, 99], miss: [98, 99] }, name: { hit: ['alpha', 'zzz'], miss: ['zzz', 'yyy'] } },
  '$gt': { 'properties.n': { hit: 4, miss: 100 }, name: { hit: 'delta', miss: 'zzzz' } },
  '$gte': { 'properties.n': { hit: 10, miss: 11 }, name: { hit: 'gamma', miss: 'zzzz' } },
  '$lt': { 'properties.n': { hit: 6, miss: 5 }, name: { hit: 'beta', miss: 'a' } },
  '$lte': { 'properties.n': { hit: 5, miss: 4 }, name: { hit: 'alpha', miss: '0' } },
};

const entity = (id, deg, extra) => ({
  _id: id, spaceId: SPACE, name: id, type: 'note', tags: [], properties: {}, description: `record ${id}`,
  embedding: unitAt(deg, DIMS), embeddingModel: 'stub', seq: 1, createdAt: OLD, updatedAt: OLD, ...extra,
});
const RECORDS = [
  entity('alpha', 10, { tags: ['x', 'y'], properties: { n: 5 } }),
  entity('beta', 20, { tags: ['y'], properties: { n: 10 } }),
  entity('gamma', 30, { type: 'task', properties: { n: '7' } }),
  entity('delta', 40, { type: 'task', tags: ['x'] }),
  entity('epsilon', 50, { type: ['note', 'task'], tags: 'x' }),
];

let mongo, stub, filterMod, recallFilter, holdsMod, vectorIndex, declared;

/** The native filter and the predicate for one row, built by production's own code from the caller's filter. */
function build({ filter, tags }) {
  let resolved;
  if (filter !== undefined) {
    resolved = resolveOk(filter);
  }
  const nativeFilter = filter !== undefined
    ? filterMod.rawToNativeVectorFilter(filter, declared)
    : filterMod.toNativeVectorFilter(tags, undefined, declared);
  return { nativeFilter, predicate: recallFilter.recallPredicate(tags, resolved, 'entity') };
}
function resolveOk(filter) {
  const r = recallFilter.resolveRecallFilter(filter);
  assert.ok(r.ok, `the filter was refused: ${r.error}`);
  return r.kind === 'mongo' ? r.filter : r.expression;
}

/** What the index answers for `nativeFilter` and what the holds-read says for `predicate`. */
async function ask(nativeFilter, predicate) {
  const rows = await mongo.col(`${SPACE}_entities`).aggregate([
    { $vectorSearch: { index: `${SPACE}_entities_embedding`, path: 'embedding', queryVector: queryAxis(DIMS), exact: true, filter: nativeFilter, limit: 50 } },
    { $project: { _id: 1 } },
  ]).toArray();
  const holds = await holdsMod.holdsRecordTheIndexShouldServe(`${SPACE}_entities`, 'embedding', { filter: predicate, maxAge: true, maxTimeMS: 10_000 });
  return { served: rows.length, holds, ids: rows.map(r => r._id).sort() };
}

/** The operators the code pushes into the native filter: asked of `rawToNativeVectorFilter`, never listed. */
const pushedOps = () => CANDIDATE_OPS.filter(op => filterMod.rawToNativeVectorFilter({ name: { [op]: 'x' } }, new Set(['name'])) !== null);

/** The table, built from the operators the code pushes, with its floor inside so no case can run over an empty one. */
function tableRows() {
  const ops = pushedOps();
  const rows = [];
  for (const op of ops) {
    const sample = SAMPLES[op];
    assert.ok(sample, `the code pushes ${op} into the index's native filter and this table has no rows for it: add a hit and a miss to SAMPLES`);
    for (const [field, { hit, miss }] of Object.entries(sample)) {
      rows.push({ label: `${field} ${op} (hit)`, filter: { [field]: { [op]: hit } } });
      rows.push({ label: `${field} ${op} (miss)`, filter: { [field]: { [op]: miss } } });
    }
  }
  rows.push(
    { label: 'scalar type (hit)', filter: { type: 'note' } },
    { label: 'scalar type (miss)', filter: { type: 'nothing' } },
    { label: 'scalar name (hit)', filter: { name: 'beta' } },
    { label: 'tags one (hit)', tags: ['x'] },
    { label: 'tags two (hit)', tags: ['x', 'y'] },
    { label: 'tags two (miss: no record holds both)', tags: ['y', 'zzz'] },
    { label: 'tags one (miss)', tags: ['zzz'] },
    { label: 'two fields, a raw conjunction (hit)', filter: { type: 'note', 'properties.n': { $gt: 4 } } },
    { label: 'two fields, a raw conjunction (miss)', filter: { type: 'note', 'properties.n': { $gt: 100 } } },
  );
  assert.ok(ops.length >= 6 && rows.length >= 25, `${ops.length} operators and ${rows.length} rows: the table is too small to pin the premise`);
  return rows;
}

describe('the filtered holds-read selects what the index filter selects', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: SPACE, meta: {
      typeSchemas: { entity: { note: { propertySchemas: { n: { type: 'number' } } } } },
    } }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('holdsparity');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    filterMod = await import('../../server/dist/brain/filter.js');
    recallFilter = await import('../../server/dist/brain/recall-filter.js');
    holdsMod = await import('../../server/dist/brain/index-should-serve.js');
    await createSpaceCollections(mongo, SPACE);
    await insertAll(mongo, `${SPACE}_entities`, RECORDS);
    await mongo.checkVectorSearchAvailability();
    declared = new Set(vectorIndex.vectorFilterFieldsFor(SPACE, 'entities'));
    await vectorIndex.ensureVectorSearchIndex(SPACE, 'entities', DIMS, 'cosine', 'embedding', 'embedding', true, [...declared]);
    await waitUntilServing(mongo, `${SPACE}_entities`, `${SPACE}_entities_embedding`, { dims: DIMS, n: RECORDS.length });
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the operators are derived from the code: those it pushes, equal to the constant\'s own list, with a floor', () => {
    const pushed = pushedOps();
    const source = fs.readFileSync(path.join(REPO_ROOT, 'server', 'src', 'brain', 'filter.ts'), 'utf8');
    const listed = /NATIVE_VECTOR_FILTER_OPS\s*=\s*\[([^\]]*)\]/.exec(source)?.[1];
    assert.ok(listed, 'NATIVE_VECTOR_FILTER_OPS is no longer declared in brain/filter.ts as a list literal: re-point this derivation');
    const named = [...listed.matchAll(/'(\w+)'/g)].map(m => `$${m[1]}`);
    assert.deepEqual([...pushed].sort(), [...named].sort(),
      'the operators the code pushes differ from the list it declares: a candidate is missing from CANDIDATE_OPS, or the list and the translation disagree');
    assert.ok(pushed.length >= 6, `only ${pushed.length} native operators derived: the derivation is broken, not the code`);
    assert.ok(tableRows().length >= 25, 'the table is too small to pin the premise');
  });

  it('fixture check: the index serves every record, the declared fields include the ones the rows use, and the rows reach both answers', async () => {
    for (const field of ['name', 'type', 'tags', 'properties.n']) assert.ok(declared.has(field), `${field} is not a declared filter field`);
    const answers = [];
    for (const row of tableRows()) {
      const { nativeFilter, predicate } = build(row);
      assert.ok(nativeFilter, `${row.label}: the code does not push this filter natively - the row tests nothing`);
      answers.push((await ask(nativeFilter, predicate)).served);
    }
    assert.ok(answers.filter(n => n >= 1).length >= 12, 'too few rows the index answers: the table pins only the "no" half');
    assert.ok(answers.filter(n => n === 0).length >= 12, 'too few rows the index answers nothing for: the table pins only the "yes" half');
  });

  it('every row: the index answering one record or more means the holds-read says yes, and none means no', async () => {
    const divergent = [];
    const rows = tableRows();
    for (const row of rows) {
      const { nativeFilter, predicate } = build(row);
      const answer = await ask(nativeFilter, predicate);
      if ((answer.served >= 1) !== answer.holds) {
        divergent.push(`${row.label}: the index answered ${answer.served} [${answer.ids.join(', ')}] and the holds-read said ${answer.holds ? 'yes' : 'no'}`);
      }
    }
    assert.deepEqual(divergent, [], `${divergent.length} of ${rows.length} rows diverge:\n  ${divergent.join('\n  ')}`);
  });

  it('an `$and` of clauses, the predicate and the native filter built from the same clause list', async () => {
    const clauses = [{ type: 'task' }, { 'properties.n': { $lte: 100 } }, { name: { $gte: 'delta' } }];
    const nativeFilter = { $and: clauses.map(c => filterMod.rawToNativeVectorFilter(c, declared)) };
    const answer = await ask(nativeFilter, { $and: clauses });
    assert.equal(answer.served >= 1, answer.holds, `the index answered ${answer.served} [${answer.ids.join(', ')}] and the holds-read said ${answer.holds ? 'yes' : 'no'}`);
    const none = await ask({ $and: [nativeFilter.$and[0], { name: { $eq: 'nope' } }] }, { $and: [clauses[0], { name: 'nope' }] });
    assert.equal(none.served, 0);
    assert.equal(none.holds, false);
  });

  it('planted wrong rows are caught: a predicate that selects other records than the native filter disagrees with the index', async () => {
    // Native filter and predicate for two DIFFERENT questions, one answering and one not, in both directions.
    const yes = build({ filter: { type: 'note' } });
    const no = build({ filter: { type: 'nothing' } });
    const indexYesHoldsNo = await ask(yes.nativeFilter, no.predicate);
    assert.ok((indexYesHoldsNo.served >= 1) !== indexYesHoldsNo.holds, 'a row whose predicate says no over a filter the index answers must read as divergent');
    const indexNoHoldsYes = await ask(no.nativeFilter, yes.predicate);
    assert.ok((indexNoHoldsYes.served >= 1) !== indexNoHoldsYes.holds, 'a row whose predicate says yes over a filter the index answers nothing for must read as divergent');
  });
});
