/**
 * An edge or link written while its entity is deleted or merged does not survive the removal (Q-305), in a strictLinkage space.
 *
 * ## The race
 *
 * Every door reads an entity's references, THEN deletes it; every edge or link write reads that its entity ends exist, THEN writes. The two touch
 * different documents, so Mongo reports no conflict (write skew): the edge lands against an entity the delete has just removed, or the merge
 * relinked its edges a moment before one arrived. Both sides therefore check AFTER their own write (`brain/gone-entity-references.ts`): the
 * remover settles what was written to the entity since it looked, the writer takes back what names an entity that is gone.
 *
 * ## How the interleavings are built
 *
 * From the real functions, with the in-between state written raw, which is exactly what the race produces: the remover's case inserts the late edge
 * before calling the remover (the writer's commit that landed after the blocker read), the merge's case runs the merge and then inserts the late edge
 * and calls the settle step `executeMerge` runs after its commit, and the writer's cases plan against a present entity, delete it raw with its
 * tombstone and only then commit. A non-strict control shows the rule is the space's own (a space that opted out allows dangling ends).
 *
 * Run: node --test testing/standalone/an-edge-racing-an-entity-removal-never-survives-it-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'q305strict';
const N = 'q305loose';
const PEER = 'q305-some-peer';
/** A real entity id: the link input is held to the id shape. */
const ENT_UUID = '0d3f6c1e-5b0a-4c53-9a7e-2f1d8b6a9c10';

describe('an edge or link racing an entity removal never survives it', { skip }, () => {
  let door; let author; let entities; let merge; let cascade; let commit; let readSet; let planEdgeMod; let planFactMod; let edgeIdFor; let linkIdFor; let gone;

  before(async () => {
    door = await openPushDoor({ suite: 'q305', spaces: [
      // `completeLinkage`: the space has been through the link conversion, which the blockers' read refuses to run without.
      { id: S, label: 'Q305 strict', folders: [], completeLinkage: true, meta: { strictLinkage: true, suppressEmbeddings: true } },
      { id: N, label: 'Q305 loose', folders: [], meta: { strictLinkage: false, suppressEmbeddings: true } },
    ] });
    ({ authorRef: author } = await import('../../server/dist/config/author.js'));
    entities = await import('../../server/dist/brain/entities.js');
    merge = await import('../../server/dist/brain/merge.js');
    cascade = await import('../../server/dist/brain/entity-delete-cascade.js');
    commit = await import('../../server/dist/brain/write-plan/commit.js');
    readSet = await import('../../server/dist/brain/write-plan/read-set.js');
    planEdgeMod = await import('../../server/dist/brain/write-plan/plan-edge.js');
    planFactMod = await import('../../server/dist/brain/write-plan/plan-fact.js');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
    // Absent before Q-305: the merge cases then fail on their own line rather than the whole file failing to load.
    gone = await import('../../server/dist/brain/gone-entity-references.js').catch(() => ({ settleReferencesToRemovedEntity: () => { throw new Error('brain/gone-entity-references.ts does not exist'); } }));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); await door.wipe(N); });

  /** An edge this instance wrote: its own author, no delivery. What a write that landed after a remover's read looks like. */
  const localEdge = (space, from, to, label = 'knows', seq = 9) =>
    build.edge(space, edgeIdFor(from, to, label), seq, { from, to, label, author: author() });
  /** An edge a peer delivered: another author, and the delivery stamp. */
  const peerEdge = (space, from, to, label = 'knows', seq = 9) =>
    build.edge(space, edgeIdFor(from, to, label), seq, { from, to, label, deliveredBy: PEER });
  const edgesNaming = (space, id) => door.coll(space, 'edges').find({ $or: [{ from: id }, { to: id }] }).toArray();
  const tombstoneOf = (space, id) => door.coll(space, 'tombstones').findOne({ _id: id });
  const seed = (space, ...ids) => door.coll(space, 'entities').insertMany(ids.map(id => build.entity(space, id, 4)));

  describe('the remover side', () => {
    it('a plain delete takes back an edge this instance wrote after the door read the blockers, with its tombstone', async () => {
      await seed(S, 'ent-e', 'ent-x');
      const late = localEdge(S, 'ent-x', 'ent-e');
      await door.coll(S, 'edges').insertOne(late);
      assert.equal(await entities.deleteEntity(S, 'ent-e'), true);
      assert.equal(await door.coll(S, 'entities').countDocuments({ _id: 'ent-e' }), 0, 'the entity was not deleted');
      assert.deepEqual(await edgesNaming(S, 'ent-e'), [], 'an edge written to the entity while it was being deleted still names it');
      const tomb = await tombstoneOf(S, late._id);
      assert.ok(tomb, 'the edge was taken back without a tombstone: the next pull from a peer that holds it would bring it back');
      assert.equal(tomb.originalSeq, late.seq, 'the tombstone does not carry the edge\'s own version');
    });

    it('a link this instance wrote to the entity is taken back with its tombstone too', async () => {
      await seed(S, 'ent-e');
      await door.coll(S, 'facts').insertOne(build.fact(S, 'fact-f', 4));
      const id = linkIdFor('fact-f', 'fact', 'ent-e', 'entity');
      await door.coll(S, 'links').insertOne(build.link(S, id, 6, { from: 'fact-f', fromKind: 'fact', to: 'ent-e', toKind: 'entity', author: author() }));
      assert.equal(await entities.deleteEntity(S, 'ent-e'), true);
      assert.equal(await door.coll(S, 'links').countDocuments({ to: 'ent-e' }), 0, 'a link to the deleted entity survived');
      assert.equal((await tombstoneOf(S, id))?.originalSeq, 6, 'the link\'s tombstone is missing or does not carry its version');
    });

    it('a cascade whose list moved after its preview is refused and removes nothing (pinned)', async () => {
      await seed(S, 'ent-e', 'ent-x', 'ent-y');
      await door.coll(S, 'edges').insertOne(localEdge(S, 'ent-x', 'ent-e'));
      const preview = await cascade.previewEntityCascade(S, 'ent-e');
      assert.equal(preview.removes.length, 1);
      await door.coll(S, 'edges').insertOne(localEdge(S, 'ent-y', 'ent-e'));
      const result = await cascade.deleteEntityCascade(S, 'ent-e', preview.token);
      assert.equal(result.ok, false);
      assert.equal(await door.coll(S, 'entities').countDocuments({ _id: 'ent-e' }), 1);
      assert.equal((await edgesNaming(S, 'ent-e')).length, 2);
    });

    it('a cascade takes back an edge that lands after its token check, through the delete it ends with', async () => {
      await seed(S, 'ent-e', 'ent-x', 'ent-y');
      await door.coll(S, 'edges').insertOne(localEdge(S, 'ent-x', 'ent-e'));
      const preview = await cascade.previewEntityCascade(S, 'ent-e');
      // The window between the cascade's edge removal and its delete: the edge the cascade never saw. Raced for real by a write that
      // lands as the cascade's first transaction commits.
      const late = localEdge(S, 'ent-y', 'ent-e');
      const { removeRecords } = await import('../../server/dist/brain/record-removal.js');
      await removeRecords(S, 'edge', preview.removes.map(b => b._id));
      await door.coll(S, 'edges').insertOne(late);
      await entities.deleteEntity(S, 'ent-e');
      assert.deepEqual(await edgesNaming(S, 'ent-e'), [], 'an edge that landed between the cascade\'s edge removal and its delete survived the entity');
      assert.ok(await tombstoneOf(S, late._id), 'the late edge was taken back without a tombstone');
    });

    it('an edge a peer delivered is NOT touched, and no tombstone is written for it (my instance = my data)', async () => {
      await seed(S, 'ent-e', 'ent-x');
      const theirs = peerEdge(S, 'ent-x', 'ent-e');
      await door.coll(S, 'edges').insertOne(theirs);
      assert.equal(await entities.deleteEntity(S, 'ent-e'), true);
      assert.ok(await door.coll(S, 'edges').findOne({ _id: theirs._id }), 'a peer\'s edge was removed by this instance\'s delete');
      assert.equal(await tombstoneOf(S, theirs._id), null, 'a tombstone was written for a peer\'s edge');
    });

    it('control: in a space without strictLinkage the same late edge is left alone (dangling ends are allowed there)', async () => {
      await seed(N, 'ent-e', 'ent-x');
      const late = localEdge(N, 'ent-x', 'ent-e');
      await door.coll(N, 'edges').insertOne(late);
      assert.equal(await entities.deleteEntity(N, 'ent-e'), true);
      assert.ok(await door.coll(N, 'edges').findOne({ _id: late._id }), 'a space that opted out of strict linkage had its edge removed');
    });
  });

  describe('the merge side', () => {
    it('an edge written to the absorbed entity after the merge relinked is moved to the survivor, and its old id is tombstoned', async () => {
      await seed(S, 'ent-s', 'ent-a', 'ent-x', 'ent-y');
      await door.coll(S, 'edges').insertOne(localEdge(S, 'ent-x', 'ent-a'));
      const out = await merge.mergeEntities(S, 'ent-s', 'ent-a', []);
      assert.equal(out.kind, 'merged', JSON.stringify(out).slice(0, 300));
      const late = localEdge(S, 'ent-y', 'ent-a');
      await door.coll(S, 'edges').insertOne(late);
      const settled = await gone.settleReferencesToRemovedEntity(S, 'ent-a', { survivorId: 'ent-s' });
      assert.equal(settled.relinked, 1);
      assert.deepEqual(await edgesNaming(S, 'ent-a'), [], 'an edge still names the merged-away entity');
      assert.ok(await door.coll(S, 'edges').findOne({ from: 'ent-y', to: 'ent-s', label: 'knows' }), 'the late edge was not moved to the survivor');
      assert.ok(await tombstoneOf(S, late._id), 'the late edge\'s old id has no tombstone');
    });

    it('a link written to the absorbed entity after the merge is re-keyed onto the survivor', async () => {
      await seed(S, 'ent-s', 'ent-a');
      await door.coll(S, 'facts').insertOne(build.fact(S, 'fact-f', 4));
      const merged = await merge.mergeEntities(S, 'ent-s', 'ent-a', []);
      assert.equal(merged.kind, 'merged');
      const oldId = linkIdFor('fact-f', 'fact', 'ent-a', 'entity');
      await door.coll(S, 'links').insertOne(build.link(S, oldId, 6, { from: 'fact-f', fromKind: 'fact', to: 'ent-a', toKind: 'entity', author: author() }));
      await gone.settleReferencesToRemovedEntity(S, 'ent-a', { survivorId: 'ent-s' });
      assert.equal(await door.coll(S, 'links').countDocuments({ to: 'ent-a' }), 0);
      assert.ok(await door.coll(S, 'links').findOne({ _id: linkIdFor('fact-f', 'fact', 'ent-s', 'entity') }), 'the link was not moved to the survivor');
      assert.ok(await tombstoneOf(S, oldId));
    });

    it('settling an entity that is stored again (re-created) touches nothing', async () => {
      await seed(S, 'ent-s', 'ent-a', 'ent-x');
      const edge = localEdge(S, 'ent-x', 'ent-a');
      await door.coll(S, 'edges').insertOne(edge);
      await gone.settleReferencesToRemovedEntity(S, 'ent-a', { survivorId: 'ent-s' });
      assert.ok(await door.coll(S, 'edges').findOne({ _id: edge._id }), 'an edge of an entity that still exists was moved');
    });
  });

  describe('the writer side', () => {
    async function planEdgeThenRemoveEnd(space, from, to) {
      const input = { from, to, label: 'knows' };
      const view = new readSet.ReadSet(space);
      await view.load(planEdgeMod.edgeWant(space, input));
      const planned = await planEdgeMod.planEdge(space, input, view);
      // The entity is deleted between the plan and the commit: raw, with its tombstone, as a door's delete leaves it.
      await door.coll(space, 'entities').deleteOne({ _id: to });
      await door.coll(space, 'tombstones').insertOne(build.tombstone(space, to, 'entity', 5, { instanceId: author().instanceId }));
      return planned.plan;
    }

    it('an edge whose entity end was deleted between plan and commit is refused 409 endpoint_removed and not stored', async () => {
      await seed(S, 'ent-e', 'ent-x');
      const plan = await planEdgeThenRemoveEnd(S, 'ent-x', 'ent-e');
      const [outcome] = await commit.commitPlans(S, [plan]);
      assert.equal(outcome.ok, false, 'an edge to a deleted entity was reported written');
      assert.equal(outcome.code, 'endpoint_removed');
      assert.match(outcome.reason, /'ent-e'/);
      assert.deepEqual(await edgesNaming(S, 'ent-e'), [], 'the edge to the deleted entity is stored');
    });

    it('through the single-record door the refusal is thrown with its code and status', async () => {
      const errors = await import('../../server/dist/util/errors.js');
      const answer = await import('../../server/dist/brain/write-validation.js');
      const err = new errors.EndpointRemoved('ent-e', 'to');
      assert.equal(err.code, 'endpoint_removed');
      const a = answer.connectionRefusalAnswer(err, 'create');
      assert.equal(a.status, 409);
      assert.equal(a.body.code, 'endpoint_removed');
      assert.equal(a.body.error, err.message);
    });

    it('a fact written with a link to an entity deleted between plan and commit is stored, its link is taken back, and the commit says so', async () => {
      await seed(S, ENT_UUID);
      const input = { fact: 'a fact about e', linkEntities: [ENT_UUID] };
      const view = new readSet.ReadSet(S);
      await view.load(planFactMod.factWant(input));
      const planned = await planFactMod.planFact(S, input, view);
      await door.coll(S, 'entities').deleteOne({ _id: ENT_UUID });
      const [outcome] = await commit.commitPlans(S, [planned.plan]);
      assert.equal(outcome.ok, true, 'the fact itself is valid and stays written');
      assert.deepEqual(outcome.linksTakenBack, [ENT_UUID], 'the outcome does not name the entity whose link was taken back');
      assert.ok(await door.coll(S, 'facts').findOne({ _id: planned.plan.id }), 'the fact was not stored');
      assert.equal(await door.coll(S, 'links').countDocuments({ to: ENT_UUID }), 0, 'a link to the deleted entity is stored');
    });

    it('the taken-back link reaches the door as a link_target_removed warning on the write\'s own validation channel, beside the schema warnings', () => {
      let seen;
      const w = gone.takenBackLinkWarnings((check) => { seen = check; });
      w.onValidation({ blocked: false, introduced: [], preExisting: [], all: [], warnings: [{ field: 'x', value: 1, reason: 'a schema warning' }], message: '' });
      w.announce([ENT_UUID]);
      assert.equal(seen.warnings.length, 2, 'the schema warning or the new one was lost');
      assert.match(seen.warnings[1].reason, /^link_target_removed: /);
      assert.equal(seen.warnings[1].value, ENT_UUID);
      const quiet = gone.takenBackLinkWarnings(undefined);
      assert.equal(quiet.onValidation, undefined);
      quiet.announce([ENT_UUID]);
    });

    it('a patch that changes an end\'s kind to entity, onto an entity that is gone, is refused endpoint_removed and the edge is taken back', async () => {
      await seed(S, 'ent-x');
      const id = edgeIdFor('ent-x', 'file-gone', 'knows', undefined, 'file');
      await door.coll(S, 'edges').insertOne(build.edge(S, id, 5, { from: 'ent-x', to: 'file-gone', toKind: 'file', label: 'knows', author: author() }));
      const edges = await import('../../server/dist/brain/edges.js');
      await assert.rejects(() => edges.updateEdgeById(S, id, { toKind: 'entity' }), (err) => err.code === 'endpoint_removed');
      assert.equal(await door.coll(S, 'edges').countDocuments({ to: 'file-gone' }), 0, 'the edge now ending at a gone entity is stored');
    });

    it('control: in a space without strictLinkage an edge to an entity deleted between plan and commit is stored', async () => {
      await seed(N, 'ent-e', 'ent-x');
      const plan = await planEdgeThenRemoveEnd(N, 'ent-x', 'ent-e');
      const [outcome] = await commit.commitPlans(N, [plan]);
      assert.equal(outcome.ok, true);
      assert.equal((await edgesNaming(N, 'ent-e')).length, 1);
    });
  });
});
