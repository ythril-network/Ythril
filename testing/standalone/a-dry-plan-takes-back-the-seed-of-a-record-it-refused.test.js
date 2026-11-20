/**
 * A record the dry plan refused is no longer a seeded end for the records planned after it (bundle-270 review U5).
 *
 * ## The doubt
 *
 * An import seeds the read set with every record the file brings, so an edge or a link that names one is judged as naming a record that
 * exists. In `warn` mode an import goes on without a refused record: it is not written. A seed that outlived the refusal made every edge and
 * link to the refused record pass the dry plan, and the commit (which never refuses) would then be handed an edge whose end is not there.
 *
 * ## What it holds
 *
 * An item carries the id it was seeded under (`seededId`). When the dry plan refuses it (at the record checks or in its planner) the seed is
 * taken back (`ReadSet.unseed`) before the next item is planned, and the result names what it took back (`unseeded`):
 *
 *  - an EDGE to a refused entity is refused too under strict linkage, naming the end (edges are planned after the records);
 *  - a FACT's link to a refused entity was planned before the entity (the commit's order is facts first), so it passes THIS plan, and the result
 *    names the entity: a caller plans again on a fresh read set without it and the fact is then refused (the loop the act owes);
 *  - an item without a `seededId`, and a record that is not refused, keep their seeds and are not named.
 *
 * Run: node --test testing/standalone/a-dry-plan-takes-back-the-seed-of-a-record-it-refused.test.js (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SPACE = 'unseed-space';
const GOOD = '11111111-1111-4111-8111-111111111111';
const BAD = '22222222-2222-4222-8222-222222222222';
const FACT = '33333333-3333-4333-8333-333333333333';

let dir, ReadSet, trustedPlan, dryPlan, entity, fact, edge;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ythril-unseed-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'i-1', instanceLabel: 'Test', tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'Unseed', folders: [], meta: { validationMode: 'strict', strictLinkage: true, typeSchemas: { entity: { person: { propertySchemas: { born: { type: 'string', required: true } } } } } } }],
  }), 'utf8');
  process.env['CONFIG_PATH'] = cfgPath;
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
  ({ trustedPlan } = await import('../../server/dist/brain/write-plan/trust.js'));
  ({ dryPlan } = await import('../../server/dist/brain/write-plan/dry-plan.js'));
  entity = await import('../../server/dist/brain/write-plan/plan-entity.js');
  fact = await import('../../server/dist/brain/write-plan/plan-fact.js');
  edge = await import('../../server/dist/brain/write-plan/plan-edge.js');
});
after(() => rmSync(dir, { recursive: true, force: true }));

const ADA = { name: 'Ada', type: 'person', properties: { born: '1815' } };
const entityItem = (id, input) => {
  const trust = trustedPlan(SPACE, { mintedId: id });
  return { kind: 'entity', input, seededId: id, want: entity.entityWant(input, trust), plan: v => entity.planEntity(SPACE, input, v, trust) };
};
const factItem = (input, seededId) => {
  const trust = trustedPlan(SPACE, { mintedId: FACT });
  return { kind: 'fact', input, ...(seededId ? { seededId } : {}), want: fact.factWant(input, trust), plan: v => fact.planFact(SPACE, input, v, trust) };
};
const edgeItem = (from, to) => {
  const input = { from, to, label: 'knows', opts: { fromKind: 'entity', toKind: 'entity' } };
  return { kind: 'edge', input, want: edge.edgeWant(SPACE, input, undefined, undefined), plan: v => edge.planEdge(SPACE, input, v) };
};

async function plan(items, seeded) {
  const view = new ReadSet(SPACE, async () => []);
  await view.seed('entity', seeded.map(id => ({ _id: id, type: 'person' })));
  return dryPlan(items(), view);
}

describe('a refused record takes its seed with it', () => {
  it('an edge to a refused entity is refused too, naming the end; the edge between records that stand is planned', async () => {
    const result = await plan(() => [
      entityItem(GOOD, ADA),
      entityItem(BAD, { type: 'person' }),
      edgeItem(GOOD, BAD),
    ], [GOOD, BAD]);
    assert.deepEqual(result.refusals.map(r => r.index), [1, 2], JSON.stringify(result.refusals));
    assert.ok(result.refusals[1].reason.includes(BAD), `the edge's refusal does not name the end that was refused: ${result.refusals[1].reason}`);
    assert.deepEqual(result.unseeded, [{ kind: 'entity', id: BAD }]);
    const control = await plan(() => [
      entityItem(GOOD, ADA),
      entityItem(BAD, { name: 'Bob', type: 'person', properties: { born: '1816' } }),
      edgeItem(GOOD, BAD),
    ], [GOOD, BAD]);
    assert.deepEqual(control.refusals, [], 'with both records valid the edge is planned, so the refusal above is the refused record\'s');
    assert.deepEqual(control.unseeded, []);
  });

  it('a fact\'s link to a refused entity passes this plan, the result names the entity, and the plan on a fresh set without it refuses the fact', async () => {
    // The refused entity states a name and no `born`, which the strict schema requires: its planner refuses it, after the fact was planned.
    const items = () => [entityItem(GOOD, ADA), entityItem(BAD, { name: 'Bob', type: 'person' }),
      factItem({ fact: 'about both', linkEntities: [GOOD, BAD] })];
    const first = await plan(items, [GOOD, BAD]);
    assert.deepEqual(first.refusals.map(r => r.index), [1], 'facts are planned first: the link to the entity refused later passes this plan');
    assert.deepEqual(first.unseeded, [{ kind: 'entity', id: BAD }]);
    const again = await plan(items, [GOOD, BAD].filter(id => !first.unseeded.some(u => u.id === id)));
    assert.ok(again.refusals.some(r => r.kind === 'fact'), `the plan without the refused seed still passes the fact: ${JSON.stringify(again.refusals)}`);
  });

  it('an item with no seededId, and a record that stands, keep their seeds and are not named', async () => {
    const result = await plan(() => [
      entityItem(GOOD, ADA),
      { ...entityItem(BAD, { type: 'person' }), seededId: undefined },
    ], [GOOD, BAD]);
    assert.deepEqual(result.refusals.map(r => r.index), [1]);
    assert.deepEqual(result.unseeded, []);
  });
});
