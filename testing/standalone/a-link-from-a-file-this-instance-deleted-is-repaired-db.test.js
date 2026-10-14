/**
 * A link a file's own delete left behind is removed by the repair, and only a link this instance can prove it owes the removal of
 * (bundle-113, Q-465 link branch; vet rulings: data S2, security S9 / PRIV-S4a-b, integration S6, owner decision D-31 parked).
 *
 * ## The defect it prevents
 *
 * Releases before Q-464 deleted a file and left the links FROM it: link rows whose source is a path nothing is at any more. They
 * are never selected again, and a file uploaded later at the same path inherits them. The repair removes them — and the rule is
 * narrow on purpose, because a link is somebody's statement and the repair deletes with a tombstone that travels to peers.
 *
 * ## The rule: a link goes only when ALL of these hold, and each row below breaks exactly one
 *
 *  1. the file tombstone for its source path was ISSUED BY THIS INSTANCE (`issuer`): the tombstone proves the file was deleted
 *     here, by us. A path with no tombstone is an EARLY ARRIVAL (a link that reached this instance before its file's bytes, or whose
 *     file is still being uploaded) and is not leaked. A tombstone a peer issued proves nothing about what this instance wrote,
 *     and each peer repairs its own leaks (ADR 05: links other instances wrote stay with them; D-31 is the owner's to widen);
 *  2. the link was WRITTEN BY THIS INSTANCE (`author.instanceId`): a link another instance wrote stays with its author;
 *  3. no live row at the path (the file was uploaded again);
 *  4. no bytes at the path (a row-less file still on disk is somebody's);
 *  5. no owed move from the path (the links of a move whose records are still being carried are the move's, and its housekeeping
 *     finish is held off here by the marker's `nextAttemptAt`, so the move is still owed when the repair looks).
 *
 * A removed link is removed THROUGH the link writer, so it writes the tombstone peers honour (`${space}_tombstones`, type `link`),
 * and `ythril_leaked_rows_removed_total{kind=link}` counts it.
 *
 * Run: node --test testing/standalone/a-link-from-a-file-this-instance-deleted-is-repaired-db.test.js
 * (requires a prior `npm run build:server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { runPass, repairCounters, repairCountersOrZero, counterDelta, spaceEntry, addedKeys, fileRow } from './_leaked-rows-repair.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'leaklinks';
const T0 = '2026-08-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PEER = 'some-other-instance';

let acts, SELF, linkIdFor, knownKeys, seq;
const links = () => acts.door.coll(S, 'links');
const linkTombstones = () => acts.door.coll(S, 'tombstones');

/** A file tombstone as this instance stores one it PUBLISHED itself, or one a peer's delete relayed here. */
const tombstoneOf = (p, { issuer, origin = 'own', move } = {}) => ({
  _id: randomUUID(), spaceId: S, path: p, deletedAt: T0, positionAt: T0, writtenAt: T0, origin, issuer,
  ...(origin === 'relayed' ? { storedVia: issuer } : {}), ...(move ? { move } : {}),
});
/** A link FROM a file, to an entity, written by `author`. */
function linkFrom(p, to, author) {
  return { _id: linkIdFor(p, 'file', to, 'entity'), spaceId: S, from: p, fromKind: 'file', to, toKind: 'entity',
    author: { instanceId: author, instanceLabel: author }, createdAt: T0, updatedAt: T0, seq: seq++ };
}

/**
 * What each source path is, and what the repair must do about its links. A FIXTURE, literal on purpose: the table is the rule, each
 * row failing exactly one of the five conditions. `removed` rows satisfy all five.
 */
async function seed() {
  const rows = [
    // all five hold: removed (two links, so the removal is not one-of-one)
    { path: 'del-own.txt', tombstone: tombstoneOf('del-own.txt', { issuer: SELF }), authors: [SELF, SELF], removed: true },
    // 2 fails: another instance wrote the link
    { path: 'del-other-author.txt', tombstone: tombstoneOf('del-other-author.txt', { issuer: SELF }), authors: [PEER], removed: false },
    // 1 fails: no tombstone at all (an early arrival)
    { path: 'early.txt', authors: [SELF], removed: false },
    // 1 fails: a PEER issued the tombstone
    { path: 'peer-deleted.txt', tombstone: tombstoneOf('peer-deleted.txt', { issuer: PEER, origin: 'relayed' }), authors: [SELF], removed: false },
    // 3 fails: the file was uploaded again
    { path: 'back.txt', tombstone: tombstoneOf('back.txt', { issuer: SELF }), authors: [SELF], live: true, removed: false },
    // 4 fails: bytes at the path and no row
    { path: 'bytes.txt', tombstone: tombstoneOf('bytes.txt', { issuer: SELF }), authors: [SELF], bytes: true, removed: false },
    // 5 fails: a move from the path is owed (its bytes are at the destination, and housekeeping is held off by the marker)
    { path: 'move-src.txt', authors: [SELF], removed: false,
      tombstone: tombstoneOf('move-src.txt', { issuer: SELF, move: { from: 'move-src.txt', to: 'move-dst.txt', attempts: 1, nextAttemptAt: FUTURE } }) },
  ];
  for (const r of rows) {
    if (r.tombstone) await acts.door.coll(S, 'file_tombstones').insertOne(r.tombstone);
    if (r.live) await acts.door.coll(S, 'files').insertOne(fileRow(S, r.path));
    if (r.bytes) await acts.files.writeFile(S, r.path, 'bytes of a file with no row');
    r.links = r.authors.map((a, i) => linkFrom(r.path, `entity-${i}`, a));
    await links().insertMany(r.links);
  }
  await acts.files.writeFile(S, 'move-dst.txt', 'the moved bytes');
  return rows;
}

describe('a link from a file this instance deleted is repaired (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'leaklinks', space: S });
    SELF = (await import('../../server/dist/config/author.js')).authorRef().instanceId;
    ({ linkIdFor } = await import('../../server/dist/brain/links.js'));
    knownKeys = Object.keys(await spaceEntry(S));
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    const entry = await spaceEntry(S);
    for (const k of addedKeys(entry, knownKeys)) delete entry[k];
    seq = 1;
  });

  it('fixture: this instance has an id, a peer\'s is another, and the owed move is owed', async () => {
    assert.ok(SELF && SELF !== PEER, `the instance id is '${SELF}'`);
    await seed();
    const markers = await import('../../server/dist/files/move-markers.js');
    assert.equal(await markers.moveIsOwed(S, 'move-src.txt', 'move-dst.txt'), true, 'the owed move the fifth row stands for is not owed: its row proves nothing');
  });

  it('removes the links of a path whose tombstone this instance issued, written by this instance, with nothing at the path, and no other', async () => {
    const table = await seed();

    await runPass();

    const left = new Set((await links().find({}).toArray()).map(l => String(l._id)));
    const wronglyKept = table.filter(r => r.removed).flatMap(r => r.links).filter(l => left.has(l._id)).map(l => l.from);
    const wronglyRemoved = table.filter(r => !r.removed).flatMap(r => r.links).filter(l => !left.has(l._id)).map(l => l.from);
    assert.deepEqual(wronglyKept, [], 'a link this instance owes the removal of (its tombstone, its author, nothing at the path) was kept');
    assert.deepEqual([...new Set(wronglyRemoved)], [], 'a link was removed that the repair cannot prove it owes: another instance\'s, an early arrival\'s, a peer\'s tombstone\'s, a re-uploaded file\'s, a file with bytes, or a move\'s');
  });

  it('removes through the link writer: each removed link has its tombstone, and a kept link has none', async () => {
    const table = await seed();

    await runPass();

    const tombed = new Set((await linkTombstones().find({ type: 'link' }).toArray()).map(t => String(t._id)));
    for (const r of table) for (const l of r.links) {
      assert.equal(tombed.has(l._id), r.removed, `${l._id} (${r.path}): ${r.removed ? 'removed without the tombstone peers honour' : 'a tombstone for a link that was kept'}`);
    }
  });

  it('counts the links it removed as removed{kind=link}', async () => {
    const table = await seed();
    const before = await repairCountersOrZero();

    await runPass();

    const removedLinks = table.filter(r => r.removed).flatMap(r => r.links).length;
    assert.equal(counterDelta(before, await repairCounters())['removed.link'], removedLinks);
  });

  it('a second pass removes nothing more and counts nothing', async () => {
    await seed();
    await runPass();
    const first = (await links().find({}).sort({ _id: 1 }).toArray()).map(l => l._id);
    assert.equal(await links().countDocuments({ from: 'del-own.txt' }), 0, 'fixture: the first pass removed no link, so a second has nothing to leave alone');
    const before = await repairCountersOrZero();

    await runPass();

    assert.deepEqual((await links().find({}).sort({ _id: 1 }).toArray()).map(l => l._id), first);
    assert.deepEqual(counterDelta(before, await repairCounters()), {}, 'a second pass counted a removal or a keep: the scan\'s completion was not recorded');
  });
});
