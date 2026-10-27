/**
 * What names a fork entity follows it when the fork is re-minted (Q-624 design §7, "What else follows the old fork id").
 *
 * ## What it prevents
 *
 * A fork entity is listed in Brain, so an edge or a link can name it (an edge end, a link target). An entity merge re-mints the absorbed
 * record's forks onto the survivor under NEW ids (the id derives from the subject, the version and the body) and removes the old id behind
 * a tombstone. The subject's own edges and links were relinked; the records that named a FORK were not, so they kept pointing at an id that
 * no longer exists: a dangling reference that the entity delete guard cannot see, and that a peer holding the old fork keeps resolving.
 *
 * ## What it holds
 *
 *  1. after the merge, no edge and no link names the old fork id, and each names the re-minted one;
 *  2. a fork body the survivor already held is not re-inserted, and what named the removed id names the holder (the survivor's own fork);
 *  3. the references count toward `MERGE_MAX_RELINKS`: a merge whose absorbed record has no references of its own, but whose fork has more than
 *     the bound, is refused before anything is written.
 *
 * Run: node --test testing/standalone/a-re-minted-fork-keeps-its-references-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { snapshotParts, changedParts, RECORD_PARTS } from './_space-snapshot.mjs';
import { FORK_KINDS, initForkFixtures, seedFork } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();
const S = 'q624refs';

describe('what names a re-minted fork entity follows it', { skip }, () => {
  let door; let merge; let edgeIdFor; let linkIdFor;
  before(async () => {
    door = await openPushDoor({ suite: 'q624_remintrefs', spaces: [{ id: S, label: 'Refs', folders: [], meta: {} }] });
    await initForkFixtures();
    merge = await import('../../server/dist/brain/merge.js');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  /** An edge from `fork` to `o1` (written HERE, so a relink re-keys it rather than writing it in place), and a link from fact `f1` to `fork`: the two ways a record names an entity. */
  async function nameTheFork(forkId) {
    await door.coll(S, 'entities').insertOne(build.entity(S, 'o1', 3));
    await door.coll(S, 'facts').insertOne(build.fact(S, 'f1', 3));
    await door.coll(S, 'edges').insertOne(build.edge(S, edgeIdFor(forkId, 'o1', 'about', 'entity', 'entity'), 6,
      { from: forkId, fromKind: 'entity', to: 'o1', toKind: 'entity', label: 'about', author: { instanceId: 'q624_remintrefs-receiver', instanceLabel: 'Receiver' } }));
    await door.coll(S, 'links').insertOne(build.link(S, linkIdFor('f1', 'fact', forkId, 'entity'), 6,
      { from: 'f1', fromKind: 'fact', to: forkId, toKind: 'entity' }));
  }
  const edgesNaming = (id) => door.coll(S, 'edges').find({ $or: [{ from: id }, { to: id }] }).toArray();
  const linksNaming = (id) => door.coll(S, 'links').find({ $or: [{ from: id }, { to: id }] }).toArray();

  it('an entity merge points what named the absorbed record\'s fork at the fork\'s new id', async () => {
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4, { name: 'Survivor' }), build.entity(S, 'ab', 5, { name: 'Absorbed' })]);
    const fork = await seedFork(door, S, 'entity', 'ab', 5, FORK_KINDS.entity.alt);
    await nameTheFork(fork._id);
    const merged = await merge.mergeEntities(S, 'sv', 'ab', []);
    assert.equal(merged.kind, 'merged', JSON.stringify(merged).slice(0, 300));
    const [remade] = await door.coll(S, 'entities').find({ forkOf: 'sv' }).toArray();
    assert.ok(remade, 'the fork was not re-minted onto the survivor');
    assert.notEqual(remade._id, fork._id);
    assert.deepEqual(await edgesNaming(fork._id), [], 'an edge still names the old fork id, which is gone');
    assert.deepEqual(await linksNaming(fork._id), [], 'a link still names the old fork id, which is gone');
    const edges = await edgesNaming(remade._id);
    assert.equal(edges.length, 1, 'no edge names the re-minted fork');
    assert.equal(edges[0]._id, edgeIdFor(remade._id, 'o1', 'about', 'entity', 'entity'), 'the relinked edge is not under the id its identity derives');
    const links = await linksNaming(remade._id);
    assert.equal(links.length, 1, 'no link names the re-minted fork');
    assert.equal(links[0]._id, linkIdFor('f1', 'fact', remade._id, 'entity'), 'the relinked link is not under the id its ends derive');
    for (const [coll, id] of [['edges', edgeIdFor(fork._id, 'o1', 'about', 'entity', 'entity')], ['links', linkIdFor('f1', 'fact', fork._id, 'entity')]]) {
      assert.equal((await door.coll(S, 'tombstones').findOne({ _id: id }))?.issuedHere, true, `${coll}: no tombstone issued here for the old id (a peer would re-create it)`);
    }
  });

  it('a fork body the survivor already held is not inserted again, and what named the removed fork names the holder', async () => {
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4, { name: 'Survivor' }), build.entity(S, 'ab', 5, { name: 'Absorbed' })]);
    const held = await seedFork(door, S, 'entity', 'sv', 4, FORK_KINDS.entity.alt);
    const dup = await seedFork(door, S, 'entity', 'ab', 5, FORK_KINDS.entity.alt);
    await nameTheFork(dup._id);
    const merged = await merge.mergeEntities(S, 'sv', 'ab', []);
    assert.equal(merged.kind, 'merged', JSON.stringify(merged).slice(0, 300));
    assert.equal(await door.coll(S, 'entities').countDocuments({ forkOf: 'sv' }), 1, 'the survivor holds the same body twice');
    assert.deepEqual(await edgesNaming(dup._id), [], 'an edge still names the removed fork id');
    assert.deepEqual(await linksNaming(dup._id), [], 'a link still names the removed fork id');
    assert.equal((await edgesNaming(held._id)).length, 1, 'the edge does not name the fork that already held the body');
    assert.equal((await linksNaming(held._id)).length, 1, 'the link does not name the fork that already held the body');
  });

  it('what names a fork counts toward the merge bound: a merge whose fork is named past it is refused, and nothing is written', async () => {
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4, { name: 'Survivor' }), build.entity(S, 'ab', 5, { name: 'Absorbed' })]);
    const fork = await seedFork(door, S, 'entity', 'ab', 5, FORK_KINDS.entity.alt);
    const n = merge.MERGE_MAX_RELINKS + 1;
    await door.coll(S, 'links').insertMany(Array.from({ length: n }, (_, i) => build.link(S, linkIdFor(`fx${i}`, 'fact', fork._id, 'entity'), 6,
      { from: `fx${i}`, fromKind: 'fact', to: fork._id, toKind: 'entity' })));
    const mongo = await import('../../server/dist/db/mongo.js');
    const before = await snapshotParts(mongo, S, RECORD_PARTS);
    await assert.rejects(() => merge.mergeEntities(S, 'sv', 'ab', []), (err) => err?.code === 'merge_too_large' || /relink/i.test(String(err?.message)),
      'a merge that relinks more than the bound (through its fork) was not refused');
    assert.deepEqual(changedParts(before, await snapshotParts(mongo, S, RECORD_PARTS)), [], 'a refused merge wrote something');
  });
});
