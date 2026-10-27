/**
 * Re-keying a subject re-mints its forks under ids that verify; nothing is lost, duplicated or left pointing at the old id
 * (Q-624 design §7, test 6).
 *
 * ## What it prevents
 *
 * A fork row's `_id` is `forkIdFor(forkOf, seq, authoredContentHash(family, row).text)` and a receiver recomputes it (§3, M3). A re-key
 * changes the subject's id, so a fork left pointing at the old subject is an orphan, and a fork edited in place to point at the new one
 * (`forkOf`, and for an edge its endpoints) no longer recomputes: every peer would refuse it as `invalidFork`. So re-pointing is a
 * RE-MINT: a new row under `forkIdFor(newSubject, newSeq, body')`, the old id removed behind an issued-here tombstone, in the same
 * transaction as the subject's re-key.
 *
 * ## The cases
 *
 * Each re-key path, and in each: the fork follows its subject (`forkOf` is the new id, none names the old one); the fork's id recomputes
 * from its stored `(forkOf, seq, body)`; the same row pushed to another space, as a peer would receive it, is accepted and is not an
 * `invalidFork`; the old fork id is gone with a tombstone issued here; a re-keyed SUBJECT carries no `forkOf`.
 *
 *  - an entity merge with absorbed forks (`mergeEntities`);
 *  - an edge relabel (`updateEdgeById`), where the fork keeps its OWN label because it is authored body;
 *  - a subject edge deleted as a duplicate by a merge: its forks follow the surviving holder;
 *  - a body the receiving subject already holds is not duplicated;
 *  - a merge past `MAX_FORKS_PER_RECORD` is refused with a 409 and nothing is written;
 *  - an edge re-key whose duplicate holder would pass the cap aborts inside the transaction, and the store is unchanged.
 *
 * Not driven here, and why: the pre-existing row at the derived id (R8's stub) needs a seam the design does not name; the mesh peer that
 * wrote the subject (the in-place case, old fork stays marked beside the re-minted one) needs three instances and is held by
 * `a-fork-resolved-elsewhere-is-decided-here-mesh-db.test.js`.
 *
 * Run: node --test testing/standalone/a-re-key-re-mints-its-forks-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { snapshotParts, changedParts, RECORD_PARTS } from './_space-snapshot.mjs';
import { FORK_KINDS, initForkFixtures, assertCoversForkingFamilies, bodyText, forkIdOfBody, seedFork, reviewDoors } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();
const S = 'q624rekey';
const PEER_SPACE = 'q624rekeypeer';

describe('a re-key re-mints its forks under ids that verify', { skip }, () => {
  let door; let mods; let edgeIdFor; let CAP;
  const edgeRow = (id, seq, from, to, label, extra = {}) => FORK_KINDS.edge.row(S, id, seq, { from, to, label, ...extra });

  before(async () => {
    door = await openPushDoor({ suite: 'q624t3_rekey', spaces: [{ id: S, label: 'Rekey', folders: [], meta: {} }, { id: PEER_SPACE, label: 'Peer', folders: [], meta: {} }] });
    await initForkFixtures();
    mods = {
      merge: await import('../../server/dist/brain/merge.js'),
      edges: await import('../../server/dist/brain/edges.js'),
    };
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ MAX_FORKS_PER_RECORD: CAP } = await import('../../server/dist/sync/upsert-plan.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); await door.wipe(PEER_SPACE); });

  /** Every row of `family` that names `forkOf`, and a tombstone issued here for `id`. */
  const forksOf = (family, subject) => door.coll(S, family).find({ forkOf: subject }).toArray();
  const tombstoneIssuedHere = async (id) => (await door.coll(S, 'tombstones').findOne({ _id: id }))?.issuedHere === true;

  /** The row as a peer would be sent it: accepted by the receiving space, and not refused as a malformed fork. */
  async function assertAcceptedAtAPeer(family, row, what) {
    const { forkOf, ...rest } = row;
    const sent = { ...rest, forkOf, spaceId: PEER_SPACE };
    delete sent.pos; delete sent.posAtSeq; delete sent.deliveredBy; delete sent.syncBase;
    const r = await door.push('/batch-upsert', { [family]: [sent] }, { spaceId: PEER_SPACE });
    assert.equal(r.code, 200, `${what}: ${JSON.stringify(r.body)}`);
    const stats = r.body[family] ?? {};
    assert.ok(!stats.invalidFork, `${what}: a peer refused the re-minted fork as malformed (its id does not recompute from forkOf, seq and body): ${JSON.stringify(stats)}`);
    assert.equal(await door.coll(PEER_SPACE, family).countDocuments({ _id: row._id }), 1, `${what}: the peer did not store the re-minted fork: ${JSON.stringify(stats)}`);
  }

  /** The re-minted fork of `subject`: its `forkOf` is the new subject, its id recomputes, a peer takes it, the old id is gone and tombstoned. */
  async function assertReminted({ kind, subject, oldForkId, body, what }) {
    const k = FORK_KINDS[kind];
    const rows = await forksOf(k.family, subject);
    assert.equal(rows.length, 1, `${what}: ${rows.length} fork(s) of the new subject '${subject}', expected the one re-minted fork`);
    const [fork] = rows;
    assert.equal(fork[k.main], body[k.main], `${what}: the re-minted fork lost its body (${k.main})`);
    assert.equal(fork._id, forkIdOfBody(k.family, subject, fork), `${what}: the re-minted fork's id does not recompute from (forkOf, seq, body): every peer refuses it`);
    assert.notEqual(fork._id, oldForkId, `${what}: the fork kept its old id, so it was edited in place`);
    assert.equal(await door.coll(S, k.family).countDocuments({ _id: oldForkId }), 0, `${what}: the old fork id is still stored`);
    assert.ok(await tombstoneIssuedHere(oldForkId), `${what}: no tombstone issued here for the old fork id`);
    await assertAcceptedAtAPeer(k.family, fork, what);
    return fork;
  }

  it('the fixture table covers every forking family (FORKING_FAMILIES is declared)', () => { assertCoversForkingFamilies(); });

  it('an entity merge re-mints the absorbed entity\'s forks onto the survivor', async () => {
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4, { name: 'Survivor' }), build.entity(S, 'ab', 5, { name: 'Absorbed' })]);
    const fork = await seedFork(door, S, 'entity', 'ab', 5, FORK_KINDS.entity.alt);
    const merged = await mods.merge.mergeEntities(S, 'sv', 'ab', []);
    assert.equal(merged.kind, 'merged', JSON.stringify(merged).slice(0, 300));
    assert.deepEqual(await forksOf('entities', 'ab'), [], 'a fork of the absorbed record still names it: it is an orphan of a deleted entity');
    await assertReminted({ kind: 'entity', subject: 'sv', oldForkId: fork._id, body: FORK_KINDS.entity.alt, what: 'entity merge' });
    assert.equal((await door.coll(S, 'entities').findOne({ _id: 'sv' })).forkOf, undefined, 'the survivor became a fork');
  });

  it('a relabel re-mints the subject\'s fork edges onto the re-keyed subject, and the fork keeps its own label', async () => {
    const subject = edgeIdFor('a1', 'b1', 'knows', 'entity', 'entity');
    await door.coll(S, 'entities').insertMany([build.entity(S, 'a1', 1), build.entity(S, 'b1', 1)]);
    // Written HERE: only an edge this instance wrote is re-keyed by a relabel (`rekeyEdges`); a peer's is relabelled in place and keeps its id.
    await door.coll(S, 'edges').insertOne(edgeRow(subject, 5, 'a1', 'b1', 'knows', { description: 'mine', author: { instanceId: 'q624t3_rekey-receiver', instanceLabel: 'Receiver' } }));
    const fork = await seedFork(door, S, 'edge', subject, 5, { from: 'a1', to: 'b1', label: 'knows', ...FORK_KINDS.edge.alt });
    await mods.edges.updateEdgeById(S, subject, { label: 'employs' });
    const renamed = edgeIdFor('a1', 'b1', 'employs', 'entity', 'entity');
    const subjectNow = await door.coll(S, 'edges').findOne({ _id: renamed });
    assert.ok(subjectNow, 'the relabel did not re-key the subject to its new derived id');
    assert.equal(subjectNow.forkOf, undefined, 'a re-keyed SUBJECT carries forkOf');
    const [remade] = await Promise.all([assertReminted({ kind: 'edge', subject: renamed, oldForkId: fork._id, body: FORK_KINDS.edge.alt, what: 'relabel' })]);
    assert.equal(remade.label, 'knows', 'the re-minted fork\'s label was rewritten: it is authored body, only the subject follows the relabel');
    assert.deepEqual(await forksOf('edges', subject), [], 'a fork edge still names the old subject id');
  });

  it('a subject edge deleted as a duplicate by a merge hands its forks to the surviving holder', async () => {
    const holder = edgeIdFor('sv', 'o1', 'cites', 'entity', 'entity');
    const dup = edgeIdFor('ab', 'o1', 'cites', 'entity', 'entity');
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4), build.entity(S, 'ab', 4), build.entity(S, 'o1', 4)]);
    await door.coll(S, 'edges').insertMany([edgeRow(holder, 5, 'sv', 'o1', 'cites', { description: 'holder' }), edgeRow(dup, 5, 'ab', 'o1', 'cites', { description: 'duplicate' })]);
    const fork = await seedFork(door, S, 'edge', dup, 5, { from: 'ab', to: 'o1', label: 'cites', ...FORK_KINDS.edge.alt });
    const merged = await mods.merge.mergeEntities(S, 'sv', 'ab', []);
    assert.equal(merged.kind, 'merged', JSON.stringify(merged).slice(0, 300));
    assert.ok(merged.deletedDuplicateEdgeIds.includes(dup), 'fixture check: the absorbed edge was not deleted as a duplicate of the holder');
    const remade = await assertReminted({ kind: 'edge', subject: holder, oldForkId: fork._id, body: FORK_KINDS.edge.alt, what: 'duplicate edge' });
    assert.equal(remade.from, 'sv', 'the re-minted fork edge\'s endpoint was not moved to the survivor');
  });

  it('a fork body the receiving subject already holds is not inserted twice, and the old id still goes', async () => {
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4, { name: 'Survivor' }), build.entity(S, 'ab', 5, { name: 'Absorbed' })]);
    const held = await seedFork(door, S, 'entity', 'sv', 4, FORK_KINDS.entity.alt);
    const dupBody = await seedFork(door, S, 'entity', 'ab', 5, FORK_KINDS.entity.alt);
    await mods.merge.mergeEntities(S, 'sv', 'ab', []);
    const rows = await forksOf('entities', 'sv');
    assert.deepEqual(rows.map(r => bodyText('entities', r)), [bodyText('entities', held)], `the survivor holds ${rows.length} forks of one body: the re-mint duplicated a body it already had`);
    assert.equal(await door.coll(S, 'entities').countDocuments({ _id: dupBody._id }), 0, 'the old fork id is still stored');
    assert.ok(await tombstoneIssuedHere(dupBody._id), 'no tombstone issued here for the old fork id');
  });

  it('a merge past the fork cap is a 409 naming the count, and nothing is written', async () => {
    const [sv, ab] = [randomUUID(), randomUUID()];
    await door.coll(S, 'entities').insertMany([build.entity(S, sv, 4, { name: 'Survivor' }), build.entity(S, ab, 5, { name: 'Absorbed' })]);
    for (let i = 0; i < 6; i++) await seedFork(door, S, 'entity', sv, 4, { name: `survivor version ${i}` });
    for (let i = 0; i < 6; i++) await seedFork(door, S, 'entity', ab, 5, { name: `absorbed version ${i}` });
    const before = await snapshotParts((await import('../../server/dist/db/mongo.js')), S, RECORD_PARTS);
    const { mcp } = await reviewDoors(door, S);
    const r = await mcp('graph_merge', { space: S, survivorId: sv, absorbedId: ab, resolutions: [] });
    assert.equal(r.ok, false, `a merge that leaves ${6 + 6} unresolved versions on one record (cap ${CAP}) was accepted`);
    assert.match(r.sentence ?? r.text, new RegExp(`unresolved versions together, more than ${CAP}`), `the refusal does not name the rule: ${r.sentence ?? r.text}`);
    const after = await snapshotParts((await import('../../server/dist/db/mongo.js')), S, RECORD_PARTS);
    assert.deepEqual(changedParts(before, after), [], 'a refused merge wrote something');
  });

  it('an edge re-key whose duplicate holder would pass the cap aborts inside the transaction and leaves the store as it was', async () => {
    const holder = edgeIdFor('sv', 'o1', 'cites', 'entity', 'entity');
    const dup = edgeIdFor('ab', 'o1', 'cites', 'entity', 'entity');
    await door.coll(S, 'entities').insertMany([build.entity(S, 'sv', 4), build.entity(S, 'ab', 4), build.entity(S, 'o1', 4)]);
    await door.coll(S, 'edges').insertMany([edgeRow(holder, 5, 'sv', 'o1', 'cites', { description: 'holder' }), edgeRow(dup, 5, 'ab', 'o1', 'cites', { description: 'duplicate' })]);
    for (let i = 0; i < 6; i++) await seedFork(door, S, 'edge', holder, 5, { from: 'sv', to: 'o1', label: 'cites', description: `holder version ${i}` });
    for (let i = 0; i < 6; i++) await seedFork(door, S, 'edge', dup, 5, { from: 'ab', to: 'o1', label: 'cites', description: `duplicate version ${i}` });
    const mongo = await import('../../server/dist/db/mongo.js');
    const before = await snapshotParts(mongo, S, RECORD_PARTS);
    await assert.rejects(() => mods.merge.mergeEntities(S, 'sv', 'ab', []), /unresolved versions|more than/,
      `an edge re-key that hands ${6 + 6} forks to a holder (cap ${CAP}) did not abort`);
    assert.deepEqual(changedParts(before, await snapshotParts(mongo, S, RECORD_PARTS)), [], 'the aborted transaction left rows behind');
  });
});
