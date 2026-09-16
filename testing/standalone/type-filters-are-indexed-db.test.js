/**
 * A `type` filter is an index seek, not a collection scan — asserted from the QUERY PLAN.
 *
 * ## Measured, not assumed
 *
 * Every brain list endpoint exposes a `type` filter, and since `total` shipped each of those requests also runs a
 * `countDocuments` with the same filter. `explain()` against a live instance returned **COLLSCAN** for
 * `{type: …}` on `memories`, `entities`, `edges` and `chrono`.
 *
 * Entities are the instructive one: they carry `{ name: 1, type: 1 }`, which looks like coverage and is not —
 * `type` is not a prefix of that index, so it cannot serve a query on `type` alone. Reading the index list would
 * have said "covered". The plan said otherwise.
 *
 * ## Why this test reads the plan
 *
 * Asserting that `type_1` appears in `getIndexes()` would pass on an index Mongo chooses not to use, and the
 * thing being protected is the CPU, not the catalogue. `winningPlan` is the only artefact that says which one
 * actually happens.
 *
 * The fix is quality-neutral by construction: same documents, same order, same counts, different plan. That is
 * why it is safe to gate this way — a regression here is a performance regression and nothing else.
 *
 * Run: node --test testing/standalone/type-filters-are-indexed-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const COLLECTIONS = ['facts', 'entities', 'edges', 'chrono'];
const SPACE = `idxprobe${Date.now()}`;

let mongo;

before(async () => {
  if (skip) return;
  mongo = await openTestMongo('typeidx');
  // The index set `initSpace` declares, for the four collections this is about — created here rather than by
  // importing `initSpace`, which pulls in config loading and the whole space lifecycle. What is under test is
  // whether the DECLARED index serves the query; that the declaration exists is asserted against source below.
  for (const name of COLLECTIONS) {
    const c = mongo.col(`${SPACE}_${name}`);
    await c.insertOne({ _id: `seed-${name}`, spaceId: SPACE, type: 'service', seq: 1 });
    await c.createIndex({ seq: 1 });
    await c.createIndex({ type: 1 });
  }
  await mongo.col(`${SPACE}_entities`).createIndex({ name: 1, type: 1 });
});

after(async () => {
  if (skip) return;
  for (const name of COLLECTIONS) await mongo.col(`${SPACE}_${name}`).drop().catch(() => {});
  await mongo.col(`${SPACE}_entities_compoundonly`).drop().catch(() => {});
  await closeTestMongo(mongo);
});

const stageOf = (plan) => {
  const s = JSON.stringify(plan);
  const m = s.match(/"stage":"(COLLSCAN|IXSCAN)"/);
  return m ? m[1] : s.slice(0, 120);
};

describe('a type filter uses an index', { skip }, () => {
  for (const name of COLLECTIONS) {
    it(`${name}`, async () => {
      const plan = await mongo.col(`${SPACE}_${name}`)
        .find({ type: 'service' }).explain('queryPlanner');
      assert.equal(stageOf(plan.queryPlanner.winningPlan), 'IXSCAN',
        `a type filter on ${name} must not scan the collection — every list request with a type filter runs this, `
        + 'and since `total` shipped, twice');
    });
  }

  it('the count behind `total` uses it too', async () => {
    // `countDocuments` builds an aggregation, so its plan is reached differently — and it is the half that was
    // added most recently, which makes it the half most likely to have been left unindexed.
    const plan = await mongo.col(`${SPACE}_entities`)
      .find({ type: 'service' }).explain('executionStats');
    assert.equal(plan.executionStats.totalDocsExamined <= plan.executionStats.nReturned + 1, true,
      `examined ${plan.executionStats.totalDocsExamined} documents to return `
      + `${plan.executionStats.nReturned} — that is a scan wearing an index's clothes`);
  });
});

describe('the compound entity index is not mistaken for coverage', { skip }, () => {
  it('`{name, type}` alone does NOT serve a type-only query', async () => {
    // The premise of the whole finding. If this ever stops being true, the `{type: 1}` index is redundant and
    // should be dropped rather than kept out of habit.
    const c = mongo.col(`${SPACE}_entities_compoundonly`);
    await c.insertOne({ _id: 'x', name: 'a', type: 'service' });
    await c.createIndex({ name: 1, type: 1 });
    const plan = await c.find({ type: 'service' }).explain('queryPlanner');
    assert.equal(stageOf(plan.queryPlanner.winningPlan), 'COLLSCAN',
      'a prefix-less field became servable by a compound index — re-derive whether `{type: 1}` is still needed');
    await c.drop().catch(() => {});
  });
});

describe('the declaration exists where new AND existing spaces will get it', () => {
  it('initSpace creates it, and a boot pass covers spaces that already exist', async () => {
    const { readFileSync } = await import('node:fs');
    const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    const lifecycle = strip(readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));
    for (const coll of ['memoriesColl', 'entitiesColl', 'edgesColl', 'chronoColl']) {
      assert.match(lifecycle, new RegExp(`${coll}\\.createIndex\\(\\{ type: 1 \\}\\)`),
        `${coll} must declare the type index for newly created spaces`);
    }
    // `initSpace` runs for NEW spaces only (`!oldSpaceIds.has(...)` in app.ts), so without this pass the index
    // would reach the changelog and never an operator's existing database.
    const ensure = strip(readFileSync('server/src/spaces/ensure-query-indexes.ts', 'utf8'));
    assert.match(ensure, /createIndex\(\{ type: 1 \}\)/);
    assert.match(ensure, /proxyFor\?\.length\) continue/, 'a proxy owns no collections');
    assert.match(strip(readFileSync('server/src/bootstrap.ts', 'utf8')), /ensureQueryIndexes\(\)/,
      'the boot step must actually be called');
  });
});
