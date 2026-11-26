/**
 * The index read is served by the statement indexes (bundle-273, Q-764, review point V3).
 *
 * ## The point
 *
 * `rowsOf` and `match` send each pattern's filter (`filterOf`), alone or under an `$and` with `nK > 0` for a caller without the files right,
 * to `rdf_quads`. The review asked whether the planner uses `p_o_s` and `o_s_p` for the `$or` under that `$and`. Every shape of a pattern's
 * filter, and an `$or` of several, is explained here, and none of the winning plans scans the collection.
 *
 * ## Seen red
 *
 * On d5192c4f6 this holds: V3 is not a defect.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-read-filters-are-index-served-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc, edgeDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixp-points';

describe('the index read is served by the statement indexes', { skip }, () => {
  let d;
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixp-points', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    const docs = [];
    for (let i = 0; i < 200; i++) {
      docs.push(['entities', entityDoc(S, `p${i}`, `Person ${i}`, i % 2 ? 'person' : 'org', { age: i })]);
      docs.push(['edges', edgeDoc(S, `e${i}`, `p${i}`, `p${(i + 1) % 200}`, 'knows')]);
    }
    await landAll(d, S, docs);
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('V3: the filters of every pattern shape, under the knowledge-only $and and alone, are index plans', async () => {
    const { filterOf } = await import('../../server/dist/rdf/triple-index/read.js');
    const terms = await d.col(`${S}_rdf_terms`).find({ _id: { $gt: 0 } }).sort({ _id: 1 }).limit(60).toArray();
    const [a, b, c, e, f, g] = terms.map(t => t._id);
    const shapes = {
      'p': [filterOf(undefined, a, undefined)],
      'o': [filterOf(undefined, undefined, b)],
      'p and o': [filterOf(undefined, a, b)],
      's and o': [filterOf(c, undefined, b)],
      's and p': [filterOf(c, a, undefined)],
      's': [filterOf(c, undefined, undefined)],
      'several subjects': [filterOf(a, undefined, undefined), filterOf(b, undefined, undefined), filterOf(c, undefined, undefined)],
      'several objects': [filterOf(undefined, undefined, a), filterOf(undefined, undefined, b), filterOf(undefined, undefined, c)],
      'a mixed batch': [filterOf(undefined, a, undefined), filterOf(undefined, undefined, b), filterOf(c, undefined, e), filterOf(f, g, undefined), filterOf(e, a, b)],
    };
    for (const [name, filters] of Object.entries(shapes)) {
      const where = filters.length === 1 ? { ...filters[0] } : { $or: filters };
      for (const [how, filter] of [['alone', where], ['without the files right', { $and: [where, { nK: { $gt: 0 } }] }]]) {
        const plan = JSON.stringify((await d.col(`${S}_rdf_quads`).find(filter).explain('queryPlanner')).queryPlanner.winningPlan);
        assert.ok(!plan.includes('COLLSCAN'), `${name}, ${how}: the plan does not scan rdf_quads: ${plan}`);
      }
    }
  });
});
