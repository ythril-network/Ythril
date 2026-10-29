/**
 * A merge relinks the edges whose end IS the absorbed entity — by kind as well as by id (Q-321).
 *
 * ## What it prevents
 *
 * An edge end is a pair: an id and a kind (absent kind = entity). The relink matched on the id alone, so a fact or a chrono entry whose `_id`
 * equals the absorbed entity's id — ids are minted per collection, so the same string can name two records of different kinds — had its
 * edges moved to the survivor entity. The edge then named a record that is not what the author linked: a relationship rewritten without
 * anyone having touched it. The clause that asks "is this edge's end record X of kind K" was written three times
 * (`findEntityReferences`, `storedEdgeIdentities`, the relink), and the relink's copy was the one without the kind; it is now one module,
 * `brain/edge-ends-of-record.ts`, which the merge plan, the relink, the fork resolve and the reference scan ask.
 *
 * ## The case
 *
 * A strict-off space holds entities S and A and a FACT whose `_id` is A's id. Three edges: `A(entity) -> X` (moves), `A(fact) -> X` and
 * `X -> A(fact)` (do not). After `mergeEntities(S, A)` the first ends at S; the other two are unchanged byte for byte. A control edge to an
 * unrelated entity shows the merge ran. The fork resolve of a fact asks the same question through `relinkEdgesOfRecord`; it is driven in
 * the second case, where a fact's id is the absorbed id of an entity edge that must stay.
 *
 * Run: node --test testing/standalone/a-merge-relinks-only-edges-ending-at-the-absorbed-entity-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { FORK_KINDS, initForkFixtures, seedFork } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();
const S = 'q321merge';

describe('a merge relinks only the edges whose end is the absorbed entity, by kind as well as id', { skip }, () => {
  let door; let merge; let edgeIdFor; let relink; let tx; let forks;

  before(async () => {
    door = await openPushDoor({ suite: 'q321_merge', spaces: [{ id: S, label: 'Q321', folders: [], meta: { strictLinkage: false } }] });
    merge = await import('../../server/dist/brain/merge.js');
    relink = await import('../../server/dist/brain/relink-references.js');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    tx = await import('../../server/dist/brain/held-transaction.js');
    forks = await import('../../server/dist/brain/forks.js');
    await initForkFixtures();
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  const edge = (from, to, label, fromKind, toKind, seq = 5) =>
    build.edge(S, edgeIdFor(from, to, label, fromKind, toKind), seq, { from, to, label, ...(fromKind ? { fromKind } : {}), ...(toKind ? { toKind } : {}) });
  const stored = (id) => door.coll(S, 'edges').findOne({ _id: id });

  async function seed() {
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4), build.entity(S, 'ab', 4), build.entity(S, 'xx', 4)]);
    // A fact whose id is the absorbed entity's id: the same string, another kind.
    await door.coll(S, 'facts').insertOne(build.fact(S, 'ab', 4));
    const e1 = edge('ab', 'xx', 'knows', undefined, undefined);
    const e2 = edge('ab', 'xx', 'knows', 'fact', 'entity');
    const e3 = edge('xx', 'ab', 'knows', 'entity', 'fact');
    await door.coll(S, 'edges').insertMany([e1, e2, e3]);
    return { e1, e2, e3 };
  }

  it('control: the edge whose end is the absorbed ENTITY ends at the survivor afterwards', async () => {
    const { e1 } = await seed();
    const out = await merge.mergeEntities(S, 'sv', 'ab', []);
    assert.equal(out.kind, 'merged', JSON.stringify(out).slice(0, 300));
    // A peer-authored edge is relinked in place (`rekeyEdges` declines it), so it keeps its id.
    assert.equal((await stored(e1._id))?.from, 'sv', 'the absorbed entity\'s edge does not end at the survivor: it was not relinked');
    assert.equal(await door.coll(S, 'edges').countDocuments({ from: 'ab', fromKind: { $in: [null, 'entity'] } }), 0, 'an edge still starts at the absorbed entity');
  });

  it('an edge whose end is a FACT with the absorbed id is left alone, at either end', async () => {
    const { e2, e3 } = await seed();
    const before2 = await stored(e2._id);
    const before3 = await stored(e3._id);
    const out = await merge.mergeEntities(S, 'sv', 'ab', []);
    assert.equal(out.kind, 'merged', JSON.stringify(out).slice(0, 300));
    assert.deepEqual(await stored(e2._id), before2, 'the edge from the FACT was changed by an entity merge (id, ends, kinds, seq or any field)');
    assert.deepEqual(await stored(e3._id), before3, 'the edge to the FACT was changed by an entity merge (id, ends, kinds, seq or any field)');
    assert.equal(await door.coll(S, 'edges').countDocuments({ from: 'sv', fromKind: 'fact' }), 0, 'an edge from the fact was relinked to the survivor entity');
    assert.equal(await door.coll(S, 'edges').countDocuments({ to: 'sv', toKind: 'fact' }), 0, 'an edge to the fact was relinked to the survivor entity');
    assert.deepEqual(out.deletedDuplicateEdgeIds, [], 'an edge of another kind was deleted as a duplicate');
  });

  it('the merge plan counts and warns about the entity\'s edges only', async () => {
    await seed();
    // A survivor edge that the FACT edge would collide with if its end were wrongly read as the absorbed entity: same label, other end, fact kind.
    await door.coll(S, 'edges').insertOne(edge('sv', 'xx', 'knows', 'fact', 'entity'));
    const result = await merge.computeMergePlan(S, 'sv', 'ab', []);
    assert.ok(!('error' in result), JSON.stringify(result).slice(0, 300));
    const named = result.plan.duplicateEdgeWarnings.map(d => d.absorbedEdgeId);
    assert.deepEqual(named, [], `the plan names ${JSON.stringify(named)} as duplicates: an edge of the fact with the absorbed id was read as the entity's`);
    const bound = await door.coll(S, 'edges').countDocuments(relink.edgesOfRecord(S, 'ab', 'entity'));
    assert.equal(bound, 1, 'the entity-end read counted the fact\'s edges: the bound and the writer would count a different set from the one the merge moves');
  });

  it('the Review list counts the edges that name a fork entity by kind too: a fact holding its id is not a reference to it', async () => {
    await door.coll(S, 'entities').insertMany([build.entity(S, 'pe', 4, { name: 'Parent' }), build.entity(S, 'xx', 4)]);
    const fork = await seedFork(door, S, 'entity', 'pe', 4, FORK_KINDS.entity.alt);
    await door.coll(S, 'facts').insertOne(build.fact(S, fork._id, 4));
    await door.coll(S, 'edges').insertMany([edge(fork._id, 'xx', 'knows', undefined, undefined), edge(fork._id, 'xx', 'knows', 'fact', 'entity')]);
    const page = await forks.listForks([S], { kind: 'entity' });
    const row = page.forks.find(f => f.forkId === fork._id);
    assert.ok(row, 'the seeded fork is not listed');
    assert.equal(row.edgeCount, 1, 'the list counts the fact\'s edge as a reference to the fork entity');
  });

  it('the fork resolve of a FACT relinks the edges of that fact, not those of the entity with its id', async () => {
    const { e1, e2 } = await seed();
    await door.coll(S, 'facts').insertOne(build.fact(S, 'fp', 4));
    const now = new Date().toISOString();
    await tx.inHeldTransaction(S, 'test.relink', (session) =>
      relink.relinkEdgesOfRecord(S, { absorbedId: 'ab', survivorId: 'fp', kind: 'fact', moveForeign: true }, { now, session }));
    assert.ok(await stored(e1._id), 'the ENTITY ab\'s edge was relinked by a fact relink');
    assert.equal(await stored(e2._id), null, 'the FACT ab\'s edge was not relinked by a fact relink');
    assert.ok(await door.coll(S, 'edges').findOne({ from: 'fp', to: 'xx', label: 'knows', fromKind: 'fact' }), 'the fact\'s edge does not end at the survivor fact');
  });
});
