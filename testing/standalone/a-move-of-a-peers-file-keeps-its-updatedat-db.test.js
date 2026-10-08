/**
 * Moving a file this instance did not author must not leave its row with a clock the author never wrote (bundle-89, Q-419,
 * the FORWARD half; plan rev 3 §C1 and §E3).
 *
 * ## The defect
 *
 * `updatedAt` is hashed and replicates, and a file's row is the AUTHOR's: a peer's version arrives at the author's `seq`
 * with the author's `updatedAt`. `renameFileMeta` and `renameFileMetaByPrefix` (`files/file-meta.ts`) move a row by
 * deleting it and inserting it again under the new id, and they re-insert it with `updatedAt: now` while keeping the OLD
 * `seq` and the OLD `author`. So a plain local move of a peer-authored file produces, today, a row that says "version 7,
 * written by the peer, at THIS instance's wall clock" — the shape Q-419 reports, and one no heal can undo from the
 * receiving side, because peers only ever see the moved path as a seq-0 placeholder (`recordArrivedFile`), so the row
 * differs from every peer's in seq, author AND content, and the equal-seq rule never reaches it.
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
 * ## Seen red
 *
 * On the base (429e6d25): the peer-authored rows fail — the moved row's `updatedAt` is the time the test moved it, under
 * the peer's `seq` 7. The controls pass.
 *
 * Run: node --test testing/standalone/a-move-of-a-peers-file-keeps-its-updatedat-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const PEER = { instanceId: 'peer-instance', instanceLabel: 'Publisher' };
/** What the publisher wrote: a past instant, so "now" cannot be mistaken for it. */
const AUTHORED_AT = '2026-09-01T00:00:00.000Z';
const PEER_SEQ = 7;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-move-peer-file-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, meta;

const files = () => mongo.col(`${SPACE}_files`);

/** A row as it stands after a peer's version of it arrived: the peer's seq, author and clock, delivered by the peer. */
const peerRow = (id, extra = {}) => ({
  _id: id, spaceId: SPACE, path: id, tags: ['moved'], description: 'the publisher wrote this', author: PEER,
  createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT, seq: PEER_SEQ, deliveredBy: PEER.instanceId, sizeBytes: 12, ...extra,
});
/** A row this instance wrote. */
const localRow = (id) => peerRow(id, { author: LOCAL, deliveredBy: '', description: 'written here', seq: 3 });

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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { ...LOCAL, spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('b89_e35_move');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    meta = await import('../../server/dist/files/file-meta.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
  });

  it('the two moves are exported, so the cases below drive the code that moves a row', () => {
    assert.equal(typeof meta.renameFileMeta, 'function', 'files/file-meta.ts exports no renameFileMeta');
    assert.equal(typeof meta.renameFileMetaByPrefix, 'function', 'files/file-meta.ts exports no renameFileMetaByPrefix');
  });

  it('a single move of a peer-authored file does not leave its updatedAt newer than its seq allows', async () => {
    const before = peerRow('docs/old.md');
    await files().insertOne(before);
    await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');

    assert.equal(await files().findOne({ _id: 'docs/old.md' }), null, 'fixture: the row is still under its old id, so nothing moved');
    const moved = await files().findOne({ _id: 'docs/new.md' });
    assert.ok(moved, 'fixture: the row was not written under its new id');
    assert.equal(moved.path, 'docs/new.md', 'the moved row\'s path is not its new id');
    assert.deepEqual(moved.tags, before.tags, 'fixture: the move changed the row\'s content');
    const wrong = clockWithoutVersion(before, moved);
    assert.equal(wrong, null,
      `a local move of a file the peer authored re-stamped its clock alone: ${wrong}. updatedAt and author are hashed and replicate, `
      + 'so this row now differs from the publisher\'s in a field nobody authored, and the equal-seq rule can never reach it');
  });

  it('a directory move does the same for every peer-authored file under it, at any depth', async () => {
    const rows = [peerRow('dir/a.md'), peerRow('dir/sub/b.md'), peerRow('dir/sub/deeper/c.md')];
    await files().insertMany(rows);
    await meta.renameFileMetaByPrefix(SPACE, 'dir', 'moved');

    const wrong = [];
    for (const before of rows) {
      const id = `moved/${before._id.slice('dir/'.length)}`;
      assert.equal(await files().findOne({ _id: before._id }), null, `fixture: ${before._id} is still under its old id`);
      const moved = await files().findOne({ _id: id });
      assert.ok(moved, `fixture: ${before._id} was not written under ${id}`);
      const why = clockWithoutVersion(before, moved);
      if (why) wrong.push(`${id}: ${why}`);
    }
    assert.deepEqual(wrong, [], 'a directory move re-stamped the clock of rows the peer authored, without their seq');
  });

  it('one directory move over peer-authored AND local rows holds only the peer-authored ones to the rule', async () => {
    const peer = peerRow('mixed/peer.md');
    const local = localRow('mixed/local.md');
    await files().insertMany([peer, local]);
    await meta.renameFileMetaByPrefix(SPACE, 'mixed', 'elsewhere');

    const movedLocal = await files().findOne({ _id: 'elsewhere/local.md' });
    const movedPeer = await files().findOne({ _id: 'elsewhere/peer.md' });
    // The controls: both rows moved, and the local one keeps its authorship — the rule is about WHO authored, not about moving.
    assert.ok(movedLocal && movedPeer, 'fixture: a row of the directory did not move');
    assert.deepEqual(movedLocal.author, LOCAL, 'the move changed who authored a local row');
    assert.deepEqual(movedPeer.author, PEER, 'the move changed who authored a peer row');
    assert.equal(clockWithoutVersion(peer, movedPeer), null,
      `the peer-authored row of a mixed directory was re-stamped: ${clockWithoutVersion(peer, movedPeer)}`);
  });

  it('control: a single move of a file THIS instance authored still moves it (the rule is not "never touch updatedAt")', async () => {
    await files().insertOne(localRow('docs/mine.md'));
    await meta.renameFileMeta(SPACE, 'docs/mine.md', 'docs/mine-too.md');
    assert.equal(await files().findOne({ _id: 'docs/mine.md' }), null);
    const moved = await files().findOne({ _id: 'docs/mine-too.md' });
    assert.ok(moved, 'a local file was not moved');
    assert.deepEqual(moved.author, LOCAL);
    assert.equal(moved.description, 'written here');
  });
});
