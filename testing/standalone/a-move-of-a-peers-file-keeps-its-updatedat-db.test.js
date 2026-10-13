/**
 * Moving a file this instance did not author must not leave its row with a clock the author never wrote (bundle-89, Q-419,
 * the FORWARD half; plan rev 3 §C1 and §E3).
 *
 * ## The defect
 *
 * `updatedAt` is hashed and replicates, and a file's row is the AUTHOR's: a peer's version arrives at the author's `seq`
 * with the author's `updatedAt`. A move re-keys the row (a row's `_id` is immutable: a delete and an insert under the new id) and
 * it used to re-insert it with `updatedAt: now` while keeping the OLD `seq` and the OLD `author`. So a plain local move of a
 * peer-authored file produced a row that says "version 7, written by the peer, at THIS instance's wall clock" — the shape Q-419
 * reports, and one no heal can undo from the receiving side, because peers only ever see the moved path as a seq-0 placeholder
 * (`recordArrivedFile`), so the row differs from every peer's in seq, author AND content, and the equal-seq rule never reaches it.
 *
 * ## The rule this file states, and not the fix
 *
 * A move of a row this instance did not author leaves the stored `updatedAt` equal to the one it held, OR advances the
 * `seq` with it. The plan chooses the first (the path is the authored field, and the content did not change). This test
 * accepts either, because what is wrong is the PAIR — a newer `updatedAt` under a `seq` that stood still — not the choice
 * between the two honest ways out.
 *
 * Both moves are asked: the single rename and the directory move, each over a row a peer authored and one this instance
 * authored. The row this instance authored is the control: it proves the move happened and that the rule is about
 * authorship, and it is not held to the same rule (a local move of a local file is a local edit).
 *
 * ## Through the door, since bundle-44
 *
 * The cases drive the move itself (`moveFileCascade`, as the REST `PATCH` and the MCP `move_file` call it) over a file with its
 * bytes: the two private re-keys these cases used to call directly (`renameFileMeta`, `renameFileMetaByPrefix`) are gone, and a
 * rule about what a move stamps is a rule about the move, not about one function it happened to call.
 *
 * ## Seen red
 *
 * On the base (429e6d25): the peer-authored rows fail — the moved row's `updatedAt` is the time the test moved it, under
 * the peer's `seq` 7. The controls pass.
 *
 * Run: node --test testing/standalone/a-move-of-a-peers-file-keeps-its-updatedat-db.test.js
 * (requires a prior `npm run build` in server/, a reachable mongod, and a private IPv4 on the host: the doors helper binds one)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SPACE = 'peermoveclock';
const PEER = { instanceId: 'peer-instance', instanceLabel: 'Publisher' };
/** What the publisher wrote: a past instant, so "now" cannot be mistaken for it. */
const AUTHORED_AT = '2026-09-01T00:00:00.000Z';
const PEER_SEQ = 7;

let acts, cascade;

const row = (id) => acts.door.coll(SPACE, 'files').findOne({ _id: id });

/** What a row holds after a peer's version of it arrived: the peer's seq, author and clock, delivered by the peer. */
const peerFields = (extra = {}) => ({
  tags: ['moved'], description: 'the publisher wrote this', author: PEER,
  createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT, seq: PEER_SEQ, deliveredBy: PEER.instanceId, ...extra,
});
/** A row this instance wrote: the authorship of this instance, whatever it is configured as. */
const localFields = async () => ({ ...peerFields({ deliveredBy: '', description: 'written here', seq: 3 }), author: (await import('../../server/dist/config/author.js')).authorRef() });

/** A file with its bytes and its row, as a peer's version arrived (or as written here), and the row as stored. */
async function seed(id, fields) {
  await acts.seed(id, fields);
  return await row(id);
}

/**
 * The rule, as ONE question asked of every moved row: the clock moved only if the version moved with it. Returns the reason it
 * does not hold, or null.
 */
function clockWithoutVersion(before, after) {
  if (after.seq !== before.seq) return null;
  if (after.updatedAt === before.updatedAt) return null;
  return `updatedAt went from ${before.updatedAt} to ${after.updatedAt} while seq stood still at ${after.seq} (author ${after.author?.instanceId})`;
}

describe('a move of a file this instance did not author keeps the author\'s clock (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'peermoveclock', space: SPACE });
    cascade = await import('../../server/dist/files/move-cascade.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  it('the move is exported, so the cases below drive the code that moves a row', () => {
    assert.equal(typeof cascade.moveFileCascade, 'function', 'files/move-cascade.ts exports no moveFileCascade');
  });

  it('a single move of a peer-authored file does not leave its updatedAt newer than its seq allows', async () => {
    const before = await seed('docs/old.md', peerFields());
    await cascade.moveFileCascade(SPACE, 'docs/old.md', 'docs/new.md');

    assert.equal(await row('docs/old.md'), null, 'fixture: the row is still under its old id, so nothing moved');
    const moved = await row('docs/new.md');
    assert.ok(moved, 'fixture: the row was not written under its new id');
    assert.equal(moved.path, 'docs/new.md', 'the moved row\'s path is not its new id');
    assert.deepEqual(moved.tags, before.tags, 'fixture: the move changed the row\'s content');
    const wrong = clockWithoutVersion(before, moved);
    assert.equal(wrong, null,
      `a local move of a file the peer authored re-stamped its clock alone: ${wrong}. updatedAt and author are hashed and replicate, `
      + 'so this row now differs from the publisher\'s in a field nobody authored, and the equal-seq rule can never reach it');
  });

  it('a directory move does the same for every peer-authored file under it, at any depth', async () => {
    const rows = [];
    for (const id of ['dir/a.md', 'dir/sub/b.md', 'dir/sub/deeper/c.md']) rows.push(await seed(id, peerFields()));
    await cascade.moveFileCascade(SPACE, 'dir', 'moved');

    const wrong = [];
    for (const before of rows) {
      const id = `moved/${before._id.slice('dir/'.length)}`;
      assert.equal(await row(before._id), null, `fixture: ${before._id} is still under its old id`);
      const moved = await row(id);
      assert.ok(moved, `fixture: ${before._id} was not written under ${id}`);
      const why = clockWithoutVersion(before, moved);
      if (why) wrong.push(`${id}: ${why}`);
    }
    assert.deepEqual(wrong, [], 'a directory move re-stamped the clock of rows the peer authored, without their seq');
  });

  it('one directory move over peer-authored AND local rows holds only the peer-authored ones to the rule', async () => {
    const peer = await seed('mixed/peer.md', peerFields());
    const local = await seed('mixed/local.md', await localFields());
    await cascade.moveFileCascade(SPACE, 'mixed', 'elsewhere');

    const movedLocal = await row('elsewhere/local.md');
    const movedPeer = await row('elsewhere/peer.md');
    // The controls: both rows moved, and each keeps its authorship — the rule is about WHO authored, not about moving.
    assert.ok(movedLocal && movedPeer, 'fixture: a row of the directory did not move');
    assert.deepEqual(movedLocal.author, local.author, 'the move changed who authored a local row');
    assert.deepEqual(movedPeer.author, PEER, 'the move changed who authored a peer row');
    assert.equal(clockWithoutVersion(peer, movedPeer), null,
      `the peer-authored row of a mixed directory was re-stamped: ${clockWithoutVersion(peer, movedPeer)}`);
  });

  it('control: a single move of a file THIS instance authored still moves it (the rule is not "never touch updatedAt")', async () => {
    const mine = await seed('docs/mine.md', await localFields());
    await cascade.moveFileCascade(SPACE, 'docs/mine.md', 'docs/mine-too.md');
    assert.equal(await row('docs/mine.md'), null);
    const moved = await row('docs/mine-too.md');
    assert.ok(moved, 'a local file was not moved');
    assert.deepEqual(moved.author, mine.author);
    assert.equal(moved.description, 'written here');
  });
});
