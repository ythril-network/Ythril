/**
 * CHARACTERIZATION (bundle-89): everything `renameFileMeta` and `renameFileMetaByPrefix` do today EXCEPT what they stamp — the id
 * re-keyed, the row carried whole, the local machinery reset, the links carried with a tombstone for the old ones, the directory
 * walk, and its limits. Written against the unmodified base 429e6d25 and green there.
 *
 * ## Why this is pinned, and what is deliberately left out
 *
 * Bundle-89 (plan rev 3, C1/E3 forward half) changes what a move STAMPS on a row this instance did not author: `updatedAt` today is
 * `now` under the old `seq`, and the fix makes it keep the stored value or advance the seq with it. The fix is a change to those
 * functions, and the neighbours a change like that takes with it are the ones this file holds: a fix that reshaped the delete-and-insert
 * into a single authored write could lose the links, keep `syncBase` or `deliveredBy` (a peer that delivered the old path could then
 * retire the new one), or stop walking a directory past its first level. None of those would be a type error.
 *
 * **Left out on purpose**, because bundle-89 changes them and a case here would turn red for the right reason:
 *   - `updatedAt` and `seq` of a moved row (what the move STAMPS; `a-move-of-a-peers-file-keeps-its-updatedat-db` states the new rule);
 *   - a move of a row flagged `deletedAt` (bundle-89's flagged-row work decides what a move does with one).
 *
 * `author` IS pinned: neither of the plan's two honest ways out (keep the stored `updatedAt`, or advance the seq with it) changes who
 * authored the content. If the second is chosen and the author must change with it, that is the one line to revisit, and it is
 * labelled below.
 *
 * Run: node --test testing/standalone/a-file-move-keeps-everything-but-the-stamp-db.test.js
 * (requires a prior `npm run build` in server/ and the test MongoDB)
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
const T0 = '2026-09-01T00:00:00.000Z';
/** What a file can link to. Entity, fact and chrono ids are UUID v4 under the default strict linkage. */
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const F1 = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89c-rename-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, meta, adjacency;

const files = () => mongo.col(`${SPACE}_files`);
const links = () => mongo.col(`${SPACE}_links`);
const tombstones = () => mongo.col(`${SPACE}_tombstones`);
const embedJobs = () => mongo.col(`${SPACE}_embed_jobs`);

/**
 * A fully loaded file row: every kind of field a move must carry, a local-machinery field of each tier, and the two fields a
 * move must RESET. `over` adds or replaces.
 */
const loaded = (id, over = {}) => ({
  _id: id, spaceId: SPACE, path: id, tags: ['a', 'b'], description: 'the publisher wrote this', descriptionSource: 'generated',
  excerpt: 'opening prose', properties: { k: 'v', n: 3 }, createdAt: T0, updatedAt: T0, sizeBytes: 123, sha256: 'ab'.repeat(32),
  author: PEER, seq: 7, deliveredBy: PEER.instanceId, syncBase: { sha256: 'cd'.repeat(32), seq: 7 },
  embedding: [0.1, 0.2, 0.3, 0.4], embeddingModel: 'm', matchedText: 'the matched text', embeddingStatus: 'complete', mediaType: 'text',
  chunkCount: 2, convertedFileId: `_converted/${id}.md`, _expireAt: new Date('2030-01-01T00:00:00.000Z'), suppressEmbeddings: true,
  ...over,
});
/** Every key a move re-writes on purpose: the id and path (the move itself), the two stamps (bundle-89's), and the two it resets. */
const MOVED_KEYS = ['_id', 'path', 'updatedAt', 'seq', 'deliveredBy', 'syncBase'];
const without = (doc, keys) => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));
const linkTargets = async (id) => (await adjacency.linksStartingFrom(SPACE, [id])).map(r => `${r.toKind}:${r.to}`).sort();

describe('a file move keeps everything but what it stamps (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { ...LOCAL, spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('b89c_rename');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    meta = await import('../../server/dist/files/file-meta.js');
    adjacency = await import('../../server/dist/brain/link-adjacency.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of [files(), links(), tombstones(), embedJobs(), mongo.col(`${SPACE}_entities`), mongo.col(`${SPACE}_facts`), mongo.col(`${SPACE}_chrono`)]) await c.deleteMany({});
  });

  /** Entities, facts and chrono entries a file can link to, so `strictLinkage` has something to resolve. */
  async function seedTargets() {
    const now = new Date().toISOString();
    await mongo.col(`${SPACE}_entities`).insertMany([
      { _id: E1, spaceId: SPACE, name: 'One', type: 'thing', tags: [], createdAt: now, seq: 1, author: LOCAL },
      { _id: E2, spaceId: SPACE, name: 'Two', type: 'thing', tags: [], createdAt: now, seq: 2, author: LOCAL },
    ]);
    await mongo.col(`${SPACE}_facts`).insertOne({ _id: F1, spaceId: SPACE, fact: 'a fact', tags: [], createdAt: now, seq: 3, author: LOCAL });
    await mongo.col(`${SPACE}_chrono`).insertOne({ _id: C1, spaceId: SPACE, title: 'an event', type: 'event', status: 'completed', tags: [], createdAt: now, seq: 4, author: LOCAL });
  }

  /** Link a file the way every door does: through `updateFileMeta`, which is the only writer of a file's links. */
  async function linkFile(id) {
    await seedTargets();
    await meta.updateFileMeta(SPACE, id, { linkEntities: [E1, E2], linkFacts: [F1], linkChronos: [C1] });
    await embedJobs().deleteMany({});
    assert.deepEqual(await linkTargets(id), [`chrono:${C1}`, `entity:${E1}`, `entity:${E2}`, `fact:${F1}`], 'fixture: the file is not linked');
  }

  describe('renameFileMeta', () => {
    it('re-keys the row: the old id is gone, the new id and path are the destination, and every other field is carried as it was', async () => {
      const before = loaded('docs/old.md');
      await files().insertOne(before);

      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new/renamed.md');

      assert.equal(await files().findOne({ _id: 'docs/old.md' }), null, 'the row is still under its old id');
      const moved = await files().findOne({ _id: 'docs/new/renamed.md' });
      assert.ok(moved, 'the row is not under its new id');
      assert.equal(moved.path, 'docs/new/renamed.md');
      assert.deepEqual(without(moved, MOVED_KEYS), without(before, MOVED_KEYS),
        'the move changed a field it does not own: it carries the row WHOLE — the authored half (author included), the vector, matchedText, processing state, retention stamp and the suppression flag');
      assert.equal(await files().countDocuments({}), 1);
    });

    it('resets the two fields that described the OLD identity: deliveredBy becomes the empty string (never absent) and syncBase is removed', async () => {
      await files().insertOne(loaded('docs/old.md'));
      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');
      const moved = await files().findOne({ _id: 'docs/new.md' });
      assert.equal(moved.deliveredBy, '', 'a moved row is nobody\'s delivery: a peer that delivered the old path must not be able to retire the new one');
      assert.ok(!('syncBase' in moved), 'syncBase records what was agreed with peers about the OLD path');
    });

    it('a row that had neither still gets deliveredBy \'\' — the key is never absent', async () => {
      await files().insertOne(loaded('docs/old.md', { deliveredBy: undefined, syncBase: undefined }));
      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');
      const moved = await files().findOne({ _id: 'docs/new.md' });
      assert.equal(moved.deliveredBy, '');
      assert.ok(!('syncBase' in moved));
    });

    it('a row this instance authored is carried the same way', async () => {
      const before = loaded('docs/old.md', { author: LOCAL, deliveredBy: '', seq: 3 });
      await files().insertOne(before);
      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');
      const moved = await files().findOne({ _id: 'docs/new.md' });
      assert.deepEqual(without(moved, MOVED_KEYS), without(before, MOVED_KEYS));
      assert.deepEqual(moved.author, LOCAL);
    });

    it('queues no embed job and leaves the derived rows hanging from the old path where they are (a move cascade re-roots them by parentFileId)', async () => {
      await files().insertOne(loaded('docs/old.md'));
      const chunk = { _id: 'docs/old.md#chunk0', spaceId: SPACE, path: 'docs/old.md#chunk0', parentFileId: 'docs/old.md', chunkIndex: 0, content: 'body', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 4, author: PEER };
      await files().insertOne(chunk);

      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');

      assert.equal(await embedJobs().countDocuments({}), 0, 'a rename re-queued an embed: the record\'s text did not change, its id did');
      assert.deepEqual(await files().findOne({ _id: 'docs/old.md#chunk0' }), chunk, 'the rename touched a derived row');
      assert.equal(await files().findOne({ _id: 'docs/new.md#chunk0' }), null);
    });

    it('is a no-op for the same path, and for a source that has no row (it does not invent one at the destination)', async () => {
      const before = loaded('docs/same.md');
      await files().insertOne(before);
      await meta.renameFileMeta(SPACE, 'docs/same.md', 'docs/same.md');
      assert.deepEqual(await files().findOne({ _id: 'docs/same.md' }), before);

      await meta.renameFileMeta(SPACE, 'docs/none.md', 'docs/elsewhere.md');
      assert.equal(await files().findOne({ _id: 'docs/elsewhere.md' }), null);
      assert.equal(await files().countDocuments({}), 1);
    });

    it('paths are normalised like every other file operation: a leading slash and a doubled slash name the same file', async () => {
      await files().insertOne(loaded('docs/old.md'));
      await meta.renameFileMeta(SPACE, '/docs//old.md', '/docs//new.md');
      assert.ok(await files().findOne({ _id: 'docs/new.md' }));
      assert.equal(await files().findOne({ _id: 'docs/old.md' }), null);
    });

    it('carries the file\'s links to the new path: every class re-created under the new id, none left under the old', async () => {
      await files().insertOne(loaded('docs/old.md', { author: LOCAL, deliveredBy: '' }));
      await linkFile('docs/old.md');

      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');

      assert.deepEqual(await linkTargets('docs/new.md'), [`chrono:${C1}`, `entity:${E1}`, `entity:${E2}`, `fact:${F1}`]);
      assert.deepEqual(await linkTargets('docs/old.md'), [], 'a link still names the old path');
      assert.equal(await links().countDocuments({ from: 'docs/old.md' }), 0);
      const carried = await links().find({ from: 'docs/new.md' }).toArray();
      assert.equal(carried.length, 4);
      for (const l of carried) assert.equal(l.fromKind, 'file');
    });

    it('the links the move removes leave a tombstone each, so a peer cannot restore them under the old path', async () => {
      await files().insertOne(loaded('docs/old.md', { author: LOCAL, deliveredBy: '' }));
      await linkFile('docs/old.md');
      const oldLinkIds = (await links().find({ from: 'docs/old.md' }).toArray()).map(l => l._id).sort();
      assert.equal(oldLinkIds.length, 4);
      await tombstones().deleteMany({});

      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');

      const made = (await tombstones().find({}).toArray()).map(t => t._id).sort();
      for (const id of oldLinkIds) assert.ok(made.some(t => t.includes(id)), `no tombstone for the removed link ${id}: ${JSON.stringify(made)}`);
    });

    it('the links it re-creates are attributed to the MOVED ROW\'s author, not to this instance, when they differ', async () => {
      // Pinned as it is today. The rows' own `author` is the AUTHOR of the file, and the links are written as that author: a
      // move by a non-author does not make this instance the author of the file's links.
      await files().insertOne(loaded('docs/old.md', { author: PEER }));
      await seedTargets();
      await meta.updateFileMeta(SPACE, 'docs/old.md', { linkEntities: [E1] });

      await meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/new.md');

      const carried = await links().find({ from: 'docs/new.md' }).toArray();
      assert.equal(carried.length, 1);
      assert.deepEqual(carried[0].author, PEER);
    });

    it('a destination that is already taken makes the insert fail AFTER the source row was deleted — today\'s stated limit of delete-then-insert', async () => {
      // A KNOWN LIMIT, pinned as it stands so a change to the move's write shape is a decision and not a side effect. If bundle-89's
      // fix reorders this (insert first), this is the one case to flip: the source must then survive.
      await files().insertOne(loaded('docs/old.md'));
      await files().insertOne(loaded('docs/taken.md', { description: 'already here' }));

      await assert.rejects(() => meta.renameFileMeta(SPACE, 'docs/old.md', 'docs/taken.md'), /duplicate key|E11000/);

      assert.equal(await files().findOne({ _id: 'docs/old.md' }), null, 'the source row is gone');
      assert.equal((await files().findOne({ _id: 'docs/taken.md' })).description, 'already here', 'the destination row is untouched');
    });
  });

  describe('renameFileMetaByPrefix', () => {
    const rowsOf = async () => (await files().find({}).sort({ _id: 1 }).toArray());

    it('moves every file row at any depth, re-keying id and path by replacing the prefix, and carries each row whole', async () => {
      const before = [loaded('dir/a.md'), loaded('dir/sub/b.md'), loaded('dir/sub/deeper/c.md')];
      await files().insertMany(before);

      await meta.renameFileMetaByPrefix(SPACE, 'dir', 'moved/here');

      assert.deepEqual((await rowsOf()).map(r => r._id), ['moved/here/a.md', 'moved/here/sub/b.md', 'moved/here/sub/deeper/c.md']);
      for (const b of before) {
        const id = `moved/here/${b._id.slice('dir/'.length)}`;
        const moved = await files().findOne({ _id: id });
        assert.equal(moved.path, id);
        assert.deepEqual(without(moved, MOVED_KEYS), without(b, MOVED_KEYS), `${id}: the walk changed a field beyond the id and path`);
        assert.equal(moved.deliveredBy, '');
        assert.ok(!('syncBase' in moved));
      }
    });

    it('moves FILES only: a derived row (anything with a parentFileId) under the prefix is left where it is for the move cascade to re-root', async () => {
      const chunk = { _id: 'dir/a.md#chunk0', spaceId: SPACE, path: 'dir/a.md#chunk0', parentFileId: 'dir/a.md', chunkIndex: 0, content: 'x', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 1, author: PEER };
      await files().insertMany([loaded('dir/a.md'), chunk]);
      await meta.renameFileMetaByPrefix(SPACE, 'dir', 'moved');
      assert.deepEqual(await files().findOne({ _id: 'dir/a.md#chunk0' }), chunk);
      assert.ok(await files().findOne({ _id: 'moved/a.md' }));
      assert.equal(await files().findOne({ _id: 'moved/a.md#chunk0' }), null);
    });

    it('matches the directory and nothing that merely starts like it: a sibling with the same leading text, a file with the directory\'s name, and a dot that is not a wildcard', async () => {
      const bystanders = [loaded('dir2/x.md'), loaded('dir.md'), loaded('dirX/y.md'), loaded('other/dir/z.md')];
      await files().insertMany([loaded('my.dir/a.md'), loaded('myXdir/b.md'), ...bystanders]);

      await meta.renameFileMetaByPrefix(SPACE, 'my.dir', 'moved');

      assert.deepEqual((await rowsOf()).map(r => r._id), ['dir.md', 'dir2/x.md', 'dirX/y.md', 'moved/a.md', 'myXdir/b.md', 'other/dir/z.md']);
    });

    it('tolerates a trailing slash on either side', async () => {
      await files().insertOne(loaded('dir/a.md'));
      await meta.renameFileMetaByPrefix(SPACE, 'dir/', 'moved/');
      assert.deepEqual((await rowsOf()).map(r => r._id), ['moved/a.md']);
    });

    it('is a no-op for the same prefix, an empty source, an empty destination, and a directory with no file rows', async () => {
      const before = [loaded('dir/a.md'), loaded('keep.md')];
      await files().insertMany(before);
      await meta.renameFileMetaByPrefix(SPACE, 'dir', 'dir/');
      await meta.renameFileMetaByPrefix(SPACE, '', 'moved');
      await meta.renameFileMetaByPrefix(SPACE, '/', 'moved');
      await meta.renameFileMetaByPrefix(SPACE, 'dir', '');
      await meta.renameFileMetaByPrefix(SPACE, 'nothing-here', 'moved');
      assert.deepEqual(await rowsOf(), before.sort((x, y) => (x._id < y._id ? -1 : 1)));
    });

    it('carries the links of EVERY moved file, as a single rename does', async () => {
      await files().insertMany([loaded('dir/a.md', { author: LOCAL }), loaded('dir/sub/b.md', { author: LOCAL })]);
      await seedTargets();
      await meta.updateFileMeta(SPACE, 'dir/a.md', { linkEntities: [E1], linkFacts: [F1] });
      await meta.updateFileMeta(SPACE, 'dir/sub/b.md', { linkChronos: [C1] });

      await meta.renameFileMetaByPrefix(SPACE, 'dir', 'moved');

      assert.deepEqual(await linkTargets('moved/a.md'), [`entity:${E1}`, `fact:${F1}`]);
      assert.deepEqual(await linkTargets('moved/sub/b.md'), [`chrono:${C1}`]);
      assert.deepEqual(await linkTargets('dir/a.md'), []);
      assert.deepEqual(await linkTargets('dir/sub/b.md'), []);
    });

    it('queues no embed job', async () => {
      await files().insertOne(loaded('dir/a.md'));
      await meta.renameFileMetaByPrefix(SPACE, 'dir', 'moved');
      assert.equal(await embedJobs().countDocuments({}), 0);
    });

    it('a destination that is already taken fails the insert after the sources were deleted — the same stated limit as a single rename', async () => {
      await files().insertMany([loaded('dir/a.md'), loaded('moved/a.md', { description: 'already here' })]);
      await assert.rejects(() => meta.renameFileMetaByPrefix(SPACE, 'dir', 'moved'), /duplicate key|E11000/);
      assert.equal(await files().findOne({ _id: 'dir/a.md' }), null, 'the source row is gone');
      assert.equal((await files().findOne({ _id: 'moved/a.md' })).description, 'already here');
    });
  });
});
