/**
 * Every find the quad source issues is answered from an index: each narrowed find shape is an index scan whose documents examined are no more
 * than the rows of its most selective field, and the walk pages `_id` order on the `_id` index (bundle-271, Q-756; design §1.4, §1.5, r2 R4.4).
 *
 * ## What is derived
 *
 * The finds are the source's own: `quadCandidates` (the pure planner) over every pattern of every record statement the fixture exports, each
 * turned into the query the source sends by `candidateQuery`. No find shape is written here, so a new rule is measured the day it is added.
 *
 * ## Why the bound is the most selective field
 *
 * A find on `{label, from}` may scan either index; what it must not do is read a collection. The rows of its most selective field alone are
 * the most an index scan on one of its fields examines, so the bound holds for every plan the planner may pick and fails for a scan.
 *
 * ## Seen red
 *
 * On 2bfffd806: `server/src/rdf/quad-candidates.ts` does not exist. Mutation (seen red once it exists): a narrowing rule on an unindexed field
 * (`author.instanceId` for an agent subject) answers a COLLSCAN.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-quad-pattern-read-is-index-served-db.test.js (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openQuadSourceFixture, A, patternOf } from './_quad-source-fixture.mjs';

const skip = await mongoSkipReason();
const CAP = 1000;
const PAGER_ORDER = { _id: 1 };

let fx, candidates, source, members;

/** Every stage name under a plan node. */
function stagesOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.stage === 'string') out.push(node.stage + (node.indexName ? `(${node.indexName})` : ''));
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(n => stagesOf(n, out)); else if (v && typeof v === 'object') stagesOf(v, out);
  }
  return out;
}

/** The finds of every pattern over member A, keyed by their shape (collection, filter, sort), each with its query. */
function findShapes() {
  const { quadCandidates } = needModule(candidates, ['quadCandidates'], 'the quad planner');
  const { candidateQuery } = needModule(source, ['candidateQuery'], 'the quad source');
  const member = members.find(m => m.space === A);
  const shapes = new Map();
  for (const q of fx.exported) {
    for (let mask = 0; mask < 16; mask++) {
      for (const find of quadCandidates(patternOf(q, mask), member)) {
        const query = candidateQuery(A, find, CAP);
        const key = JSON.stringify([query.collection, query.filter, query.walk]);
        if (!shapes.has(key)) shapes.set(key, { find, query });
      }
    }
  }
  return [...shapes.values()];
}

describe('every quad pattern read is served by an index', { skip }, () => {
  before(async () => {
    fx = await openQuadSourceFixture('qsrc-index');
    candidates = await loadDistModule('../../server/dist/rdf/quad-candidates.js', import.meta.url);
    source = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
    const helper = await loadDistModule('../../server/dist/rdf/rdf-members.js', import.meta.url);
    members = helper.mod ? helper.mod.rdfMembers([A], fx.reader).members : [];
  });
  after(async () => { await fx?.d.close(); });

  it('the planner yields narrowed finds and walks (a floor, so a planner that only walks cannot pass)', () => {
    const shapes = findShapes();
    const narrowed = shapes.filter(s => !s.find.walk);
    assert.ok(narrowed.length >= 12, `only ${narrowed.length} narrowed find shapes: ${narrowed.map(s => JSON.stringify(s.query.filter)).join(' ')}`);
    assert.ok(shapes.some(s => s.find.walk), 'no pattern walks');
  });

  it('each narrowed find is an index scan reading no more than its most selective field\'s rows', async () => {
    const wrong = [];
    for (const { find, query } of findShapes().filter(s => !s.find.walk)) {
      const coll = fx.d.col(query.collection);
      const plan = await coll.find(query.filter, { projection: query.projection, limit: query.limit }).explain('executionStats');
      const stages = stagesOf(plan.queryPlanner.winningPlan);
      const examined = plan.executionStats.totalDocsExamined;
      const fields = Object.entries(find.filter);
      const bound = fields.length === 0 ? Infinity : Math.min(...await Promise.all(fields.map(([k, v]) => coll.countDocuments({ [k]: v }))));
      if (!stages.some(s => s.includes('IXSCAN')) || stages.some(s => s.startsWith('COLLSCAN'))) wrong.push(`${query.collection} ${JSON.stringify(query.filter)}: ${stages.join('<-')}`);
      else if (examined > bound) wrong.push(`${query.collection} ${JSON.stringify(query.filter)}: examined ${examined} > ${bound}`);
    }
    assert.deepEqual(wrong, [], 'a narrowed find is not served by an index');
  });

  it('a walk pages in _id order on the _id index, with no sort stage', async () => {
    const wrong = [];
    for (const { query } of findShapes().filter(s => s.find.walk)) {
      assert.equal(query.walk, true, `the walk of ${query.collection} is not read by the _id pager`);
      // The page the one `_id` pager (`idKeysetPage`) sends: the walk's filter, in `_id` order, the walk's page size.
      const plan = await fx.d.col(query.collection).find(query.filter, { projection: query.projection, sort: PAGER_ORDER, limit: query.limit }).explain('executionStats');
      const stages = stagesOf(plan.queryPlanner.winningPlan);
      if (!stages.some(s => s.includes('IXSCAN(_id_)')) || stages.includes('SORT')) wrong.push(`${query.collection}: ${stages.join('<-')}`);
    }
    assert.deepEqual(wrong, [], 'a walk page is not served by the _id index');
  });
});
