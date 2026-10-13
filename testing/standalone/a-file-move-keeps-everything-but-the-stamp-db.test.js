/**
 * CHARACTERIZATION (bundle-89), re-aimed at the move itself (bundle-44): everything a file move does to a file's ROW EXCEPT what it
 * re-keys — the id re-keyed, the row carried whole, the local machinery reset, the links carried with a tombstone for the old ones,
 * the directory walk, and its limits. Written against the unmodified base 429e6d25 and green there, through the two private re-keys
 * (`renameFileMeta`, `renameFileMetaByPrefix`) that bundle-44 removed; the same cases now drive `moveFileCascade`, the one move.
 *
 * ## Why this is pinned, and what changed with the re-aim
 *
 * A change to how a move writes its rows is a change to the neighbours this file holds: a fix that reshaped the delete-and-insert
 * could lose the links, keep `syncBase` or `deliveredBy` (a peer that delivered the old path could then retire the new one), or stop
 * walking a directory past its first level. None of those would be a type error.
 *
 * **What the move does now that the private re-keys did not, and which cases say so:**
 *   - the rows derived from the file move WITH it (they used to be left for a second step): the chunk, with its parent re-rooted;
 *   - the file's `convertedFileId` names the moved converted Markdown (it named the old path);
 *   - a destination that is already taken no longer costs the moved file its record (it used to fail the insert AFTER the delete —
 *     the "known limit" two cases pinned): the moved record is the one at the destination;
 *   - a move onto itself, a source with no bytes and an empty path are refused and change nothing (they used to be silent no-ops of
 *     the row step); a move needs the file's bytes, which is what the doors always required.
 *
 * `updatedAt` and `seq` are pinned CARRIED here (`a-move-of-a-peers-file-keeps-its-updatedat-db` states the rule they follow).
 *
 * Run: node --test testing/standalone/a-file-move-keeps-everything-but-the-stamp-db.test.js
 * (requires a prior `npm run build` in server/, the test MongoDB, and a private IPv4 on the host: the doors helper binds one)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SPACE = 'movekeeps';
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const PEER = { instanceId: 'peer-instance', instanceLabel: 'Publisher' };
const T0 = '2026-09-01T00:00:00.000Z';
/** What a file can link to. Entity, fact and chrono ids are UUID v4 under the default strict linkage. */
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const F1 = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';

let acts, meta, adjacency, cascade;

const coll = (part) => acts.door.coll(SPACE, part);
const files = () => coll('files');
const links = () => coll('links');
const tombstones = () => coll('tombstones');
const embedJobs = () => coll('embed_jobs');

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
/** A file with its bytes and the loaded row. */
async function put(id, over = {}) {
  const row = loaded(id, over);
  await acts.files.writeFile(SPACE, id, `bytes of ${id}`);
  await files().insertOne(row);
  return row;
}
/** Every key a move re-writes on purpose: the id and path (the move itself), the pointer to the converted Markdown (re-rooted with it), and the two it resets. */
const MOVED_KEYS = ['_id', 'path', 'convertedFileId', 'deliveredBy', 'syncBase'];
const without = (doc, keys) => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));
const linkTargets = async (id) => (await adjacency.linksStartingFrom(SPACE, [id])).map(r => `${r.toKind}:${r.to}`).sort();
const move = (src, dst) => cascade.moveFileCascade(SPACE, src, dst);

describe('a file move keeps everything but what it re-keys (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'movekeeps', space: SPACE });
    meta = await import('../../server/dist/files/file-meta.js');
    adjacency = await import('../../server/dist/brain/link-adjacency.js');
    cascade = await import('../../server/dist/files/move-cascade.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'tombstones', 'embed_jobs', 'entities', 'facts', 'chrono']) await coll(part).deleteMany({});
  });

  /** Entities, facts and chrono entries a file can link to, so `strictLinkage` has something to resolve. */
  async function seedTargets() {
    const now = new Date().toISOString();
    await coll('entities').insertMany([
      { _id: E1, spaceId: SPACE, name: 'One', type: 'thing', tags: [], createdAt: now, seq: 1, author: LOCAL },
      { _id: E2, spaceId: SPACE, name: 'Two', type: 'thing', tags: [], createdAt: now, seq: 2, author: LOCAL },
    ]);
    await coll('facts').insertOne({ _id: F1, spaceId: SPACE, fact: 'a fact', tags: [], createdAt: now, seq: 3, author: LOCAL });
    await coll('chrono').insertOne({ _id: C1, spaceId: SPACE, title: 'an event', type: 'event', status: 'completed', tags: [], createdAt: now, seq: 4, author: LOCAL });
  }

  /** Link a file the way every door does: through `updateFileMeta`, which is the only writer of a file's links. */
  async function linkFile(id) {
    await seedTargets();
    await meta.updateFileMeta(SPACE, id, { linkEntities: [E1, E2], linkFacts: [F1], linkChronos: [C1] });
    await embedJobs().deleteMany({});
    assert.deepEqual(await linkTargets(id), [`chrono:${C1}`, `entity:${E1}`, `entity:${E2}`, `fact:${F1}`], 'fixture: the file is not linked');
  }

  describe('a single file', () => {
    it('re-keys the row: the old id is gone, the new id and path are the destination, and every other field is carried as it was', async () => {
      const before = await put('docs/old.md');

      await move('docs/old.md', 'docs/new/renamed.md');

      assert.equal(await files().findOne({ _id: 'docs/old.md' }), null, 'the row is still under its old id');
      const moved = await files().findOne({ _id: 'docs/new/renamed.md' });
      assert.ok(moved, 'the row is not under its new id');
      assert.equal(moved.path, 'docs/new/renamed.md');
      assert.deepEqual(without(moved, MOVED_KEYS), without(before, MOVED_KEYS),
        'the move changed a field it does not own: it carries the row WHOLE — the authored half (author included), the vector, matchedText, processing state, retention stamp and the suppression flag');
      assert.equal(moved.convertedFileId, '_converted/docs/new/renamed.md.md', 'the pointer to the converted Markdown still names the old path');
      assert.equal(await files().countDocuments({}), 1);
    });

    it('resets the two fields that described the OLD identity: deliveredBy becomes the empty string (never absent) and syncBase is removed', async () => {
      await put('docs/old.md');
      await move('docs/old.md', 'docs/new.md');
      const moved = await files().findOne({ _id: 'docs/new.md' });
      assert.equal(moved.deliveredBy, '', 'a moved row is nobody\'s delivery: a peer that delivered the old path must not be able to retire the new one');
      assert.ok(!('syncBase' in moved), 'syncBase records what was agreed with peers about the OLD path');
    });

    it('a row that had neither still gets deliveredBy \'\' — the key is never absent', async () => {
      await put('docs/old.md', { deliveredBy: undefined, syncBase: undefined });
      await move('docs/old.md', 'docs/new.md');
      const moved = await files().findOne({ _id: 'docs/new.md' });
      assert.equal(moved.deliveredBy, '');
      assert.ok(!('syncBase' in moved));
    });

    it('a row this instance authored is carried the same way', async () => {
      const before = await put('docs/old.md', { author: LOCAL, deliveredBy: '', seq: 3 });
      await move('docs/old.md', 'docs/new.md');
      const moved = await files().findOne({ _id: 'docs/new.md' });
      assert.deepEqual(without(moved, MOVED_KEYS), without(before, MOVED_KEYS));
      assert.deepEqual(moved.author, LOCAL);
    });

    it('queues no embed job, and the rows derived from the file move WITH it, their parent re-rooted (they used to be left for a second step)', async () => {
      await put('docs/old.md');
      const chunk = { _id: 'docs/old.md#chunk0', spaceId: SPACE, path: 'docs/old.md#chunk0', parentFileId: 'docs/old.md', chunkIndex: 0, content: 'body', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 4, author: PEER };
      await files().insertOne(chunk);

      await move('docs/old.md', 'docs/new.md');

      assert.equal(await embedJobs().countDocuments({}), 0, 'a rename re-queued an embed: the record\'s text did not change, its id did');
      assert.equal(await files().findOne({ _id: 'docs/old.md#chunk0' }), null, 'the derived row stayed at the old id');
      assert.deepEqual(await files().findOne({ _id: 'docs/new.md#chunk0' }),
        { ...chunk, _id: 'docs/new.md#chunk0', path: 'docs/new.md#chunk0', parentFileId: 'docs/new.md', deliveredBy: '' },
        'the derived row did not arrive whole under the new id, or its updatedAt moved');
    });

    it('a move onto itself, onto its own subtree, from a path with no bytes or from an empty path is refused and changes nothing', async () => {
      const before = await put('docs/same.md');
      await assert.rejects(() => move('docs/same.md', 'docs/same.md'), (e) => e.name === 'PathBlocked');
      assert.deepEqual(await files().findOne({ _id: 'docs/same.md' }), before);

      await assert.rejects(() => move('docs/none.md', 'docs/elsewhere.md'), (e) => e.name === 'NotFoundError');
      assert.equal(await files().findOne({ _id: 'docs/elsewhere.md' }), null, 'a move invented a record at the destination');
      for (const [s, d] of [['', 'moved'], ['/', 'moved'], ['docs/same.md', '']]) await assert.rejects(() => move(s, d), undefined, `${JSON.stringify(s)} → ${JSON.stringify(d)}`);
      assert.equal(await files().countDocuments({}), 1);
      assert.deepEqual(await acts.raw(), [], 'a refused move left a tombstone');
    });

    it('paths are normalised like every other file operation: a leading slash and a doubled slash name the same file', async () => {
      await put('docs/old.md');
      await move('/docs//old.md', '/docs//new.md');
      assert.ok(await files().findOne({ _id: 'docs/new.md' }));
      assert.equal(await files().findOne({ _id: 'docs/old.md' }), null);
    });

    it('carries the file\'s links to the new path: every class re-created under the new id, none left under the old', async () => {
      await put('docs/old.md', { author: LOCAL, deliveredBy: '' });
      await linkFile('docs/old.md');

      await move('docs/old.md', 'docs/new.md');

      assert.deepEqual(await linkTargets('docs/new.md'), [`chrono:${C1}`, `entity:${E1}`, `entity:${E2}`, `fact:${F1}`]);
      assert.deepEqual(await linkTargets('docs/old.md'), [], 'a link still names the old path');
      assert.equal(await links().countDocuments({ from: 'docs/old.md' }), 0);
      const carried = await links().find({ from: 'docs/new.md' }).toArray();
      assert.equal(carried.length, 4);
      for (const l of carried) assert.equal(l.fromKind, 'file');
    });

    it('the links the move removes leave a tombstone each, so a peer cannot restore them under the old path', async () => {
      await put('docs/old.md', { author: LOCAL, deliveredBy: '' });
      await linkFile('docs/old.md');
      const oldLinkIds = (await links().find({ from: 'docs/old.md' }).toArray()).map(l => l._id).sort();
      assert.equal(oldLinkIds.length, 4);
      await tombstones().deleteMany({});

      await move('docs/old.md', 'docs/new.md');

      const made = (await tombstones().find({}).toArray()).map(t => t._id).sort();
      for (const id of oldLinkIds) assert.ok(made.some(t => t.includes(id)), `no tombstone for the removed link ${id}: ${JSON.stringify(made)}`);
    });

    it('the links it re-creates are attributed to the MOVED ROW\'s author, not to this instance, when they differ', async () => {
      // The rows' own `author` is the AUTHOR of the file, and the links are written as that author: a move by a non-author does not make
      // this instance the author of the file's links.
      await put('docs/old.md', { author: PEER });
      await seedTargets();
      await meta.updateFileMeta(SPACE, 'docs/old.md', { linkEntities: [E1] });

      await move('docs/old.md', 'docs/new.md');

      const carried = await links().find({ from: 'docs/new.md' }).toArray();
      assert.equal(carried.length, 1);
      assert.deepEqual(carried[0].author, PEER);
    });

    it('a destination that is already taken costs the moved file nothing: its record is the one at the destination, the occupant\'s is replaced (the stated limit of delete-then-insert is gone)', async () => {
      const mine = await put('docs/old.md');
      await put('docs/taken.md', { description: 'already here' });

      await move('docs/old.md', 'docs/taken.md');

      assert.equal(await files().findOne({ _id: 'docs/old.md' }), null, 'the source row is still there');
      const at = await files().findOne({ _id: 'docs/taken.md' });
      assert.ok(at, 'the destination has no record: the moved file lost its own');
      assert.equal(at.description, mine.description, 'the destination holds the occupant\'s record, not the moved file\'s');
      assert.equal(await files().countDocuments({}), 1);
    });
  });

  describe('a directory', () => {
    const rowsOf = async () => (await files().find({}).sort({ _id: 1 }).toArray());

    it('moves every file row at any depth, re-keying id and path by replacing the prefix, and carries each row whole', async () => {
      const before = [await put('dir/a.md'), await put('dir/sub/b.md'), await put('dir/sub/deeper/c.md')];

      await move('dir', 'moved/here');

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

    it('moves the rows derived from the files under it too, re-rooted by their parent', async () => {
      const chunk = { _id: 'dir/a.md#chunk0', spaceId: SPACE, path: 'dir/a.md#chunk0', parentFileId: 'dir/a.md', chunkIndex: 0, content: 'x', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 1, author: PEER };
      await put('dir/a.md');
      await files().insertOne(chunk);
      await move('dir', 'moved');
      assert.equal(await files().findOne({ _id: 'dir/a.md#chunk0' }), null);
      assert.ok(await files().findOne({ _id: 'moved/a.md' }));
      assert.equal((await files().findOne({ _id: 'moved/a.md#chunk0' }))?.parentFileId, 'moved/a.md');
    });

    it('matches the directory and nothing that merely starts like it: a sibling with the same leading text, a file with the directory\'s name, and a dot that is not a wildcard', async () => {
      for (const id of ['dir2/x.md', 'dir.md', 'dirX/y.md', 'other/dir/z.md']) await put(id);
      await put('my.dir/a.md');
      await put('myXdir/b.md');

      await move('my.dir', 'moved');

      assert.deepEqual((await rowsOf()).map(r => r._id), ['dir.md', 'dir2/x.md', 'dirX/y.md', 'moved/a.md', 'myXdir/b.md', 'other/dir/z.md']);
    });

    it('tolerates a trailing slash on either side', async () => {
      await put('dir/a.md');
      await move('dir/', 'moved/');
      assert.deepEqual((await rowsOf()).map(r => r._id), ['moved/a.md']);
    });

    it('a move onto its own path or into itself, an empty source or destination and a directory that is not there change nothing', async () => {
      await put('dir/a.md');
      await put('keep.md');
      const before = await rowsOf();
      await assert.rejects(() => move('dir', 'dir/'), (e) => e.name === 'PathBlocked');
      await assert.rejects(() => move('dir', 'dir/inside'), (e) => e.name === 'PathBlocked');
      await assert.rejects(() => move('', 'moved'));
      await assert.rejects(() => move('/', 'moved'));
      await assert.rejects(() => move('dir', ''));
      await assert.rejects(() => move('nothing-here', 'moved'), (e) => e.name === 'NotFoundError');
      assert.deepEqual(await rowsOf(), before);
      assert.deepEqual(await acts.raw(), [], 'a refused move left a tombstone');
    });

    it('carries the links of EVERY moved file, as a single rename does', async () => {
      await put('dir/a.md', { author: LOCAL });
      await put('dir/sub/b.md', { author: LOCAL });
      await seedTargets();
      await meta.updateFileMeta(SPACE, 'dir/a.md', { linkEntities: [E1], linkFacts: [F1] });
      await meta.updateFileMeta(SPACE, 'dir/sub/b.md', { linkChronos: [C1] });

      await move('dir', 'moved');

      assert.deepEqual(await linkTargets('moved/a.md'), [`entity:${E1}`, `fact:${F1}`]);
      assert.deepEqual(await linkTargets('moved/sub/b.md'), [`chrono:${C1}`]);
      assert.deepEqual(await linkTargets('dir/a.md'), []);
      assert.deepEqual(await linkTargets('dir/sub/b.md'), []);
    });

    it('queues no embed job', async () => {
      await put('dir/a.md');
      await move('dir', 'moved');
      assert.equal(await embedJobs().countDocuments({}), 0);
    });
  });
});
