/**
 * A file row stored before bundle-71 under a spelling that is not its key is found by every door and put at its key (Q-413).
 *
 * ## The rule
 *
 * Before bundle-71 a file row's id was the caller's text: no Unicode normalisation, no collapse of `//`, `.` and `..`. Since then the id is the
 * path's key (`toDocId`) and every lookup is made by it, so the old row is invisible to every door here and refused by every upgraded peer.
 * The first door that needs a file's row id for a space adopts the row at its key (`files/legacy-file-keys.ts`): lazily, never at boot, writing
 * no tombstone. What it keeps is the version, author, creation time and metadata, and it takes a landing position of this instance's own stream.
 *
 *  1. Every door that turns a path into a row id finds the row at its key: the inspect read, MCP `update_file_meta`, REST upload and MCP
 *     `write_file` over it, REST and MCP delete, REST and MCP move, a peer's metadata push for the key, and a sync cycle.
 *  2. After a door, no row stands at the legacy id, the row at the key keeps its author (the PEER's) and its tags, and a re-key writes no file
 *     tombstone (a delete writes its own, at the key).
 *  3. A row already at the key: the higher version wins, the one at the key on a tie. A held tombstone that shadows the legacy row's version
 *     retires it locally instead.
 *  4. Nothing is read at boot: the index of legacy ids is built by the first lookup.
 *
 * ## Seen red
 *
 * On the base every door in 1 and 2 misses the planted row (the lookup is by the key, the row is at the legacy id), 3 keeps a legacy row nothing
 * reads, and 4 has no door to observe (it pins that the index is built by the first lookup and not before). The legacy rows are planted directly: the doors of the
 * base can no longer write them.
 *
 * The decomposed names are built with `normalize('NFD')`, never pasted.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-pre-bundle-71-file-row-is-found-and-rekeyed-by-every-door-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { build } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'legacykeys';
const PEER = 'push-door-peer';
const T0 = '2026-09-01T00:00:00.000Z';
const CONTENT = 'the bytes of the legacy file';

/** Each shape a pre-bundle-71 id could have, with the key it stands for. */
const SHAPES = [
  { name: 'a decomposed Latin name', legacy: 'Café.txt'.normalize('NFD'), key: 'Café.txt' },
  { name: 'a decomposed Hangul name', legacy: '한글.txt'.normalize('NFD'), key: '한글.txt' },
  { name: 'an empty segment', legacy: 'a//b.txt', key: 'a/b.txt' },
  { name: 'a dot segment', legacy: './c.txt', key: 'c.txt' },
  { name: 'a parent step', legacy: 'a/x/../d.txt', key: 'a/d.txt' },
];

let d, forgetLegacyIndex, fileRowIdFor, getFileMeta;
const rows = () => d.door.coll(S, 'files');

/** A pre-bundle-71 row, as the doors of the base wrote it: a PEER's file with a description and tags, at `seq` 7. */
const legacyRow = (id, extra = {}) => build.filemeta(S, id, 7, {
  description: 'the peer\'s description', tags: ['legacy', 'peer'], sizeBytes: Buffer.byteLength(CONTENT), createdAt: T0, updatedAt: T0, ...extra,
});

async function plant(shape, extra = {}) {
  await d.files.writeFile(S, shape.key, CONTENT);
  await rows().insertOne(legacyRow(shape.legacy, extra));
  forgetLegacyIndex(S);
}

async function expectAtKey(shape, { seq, description } = {}) {
  assert.equal(await rows().findOne({ _id: shape.legacy }), null, `the row is still at its legacy id '${shape.legacy}'`);
  const row = await rows().findOne({ _id: shape.key });
  assert.ok(row, `no row at the key '${shape.key}'`);
  assert.equal(row.path, shape.key);
  assert.equal(row.author?.instanceId, PEER, 'the row lost its author');
  assert.deepEqual(row.tags, ['legacy', 'peer'], 'the row lost its tags');
  assert.equal(row.createdAt, T0, 'the row lost its creation time');
  if (seq !== undefined) assert.equal(row.seq, seq, 'the re-key changed the version');
  if (description !== undefined) assert.equal(row.description, description);
  return row;
}

async function tombstonePaths() { return (await d.raw()).map(t => t.path).sort(); }

describe('a pre-bundle-71 file row is found and re-keyed by every door', { skip }, () => {
  before(async () => {
    d = await openFileActDoors({ suite: 'legacykeys', space: S, monitorCommands: true });
    ({ forgetLegacyIndex } = await import('../../server/dist/files/legacy-file-keys.js'));
    ({ fileRowIdFor, getFileMeta } = await import('../../server/dist/files/file-meta.js'));
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); forgetLegacyIndex(S); });

  for (const shape of SHAPES) {
    describe(`stored under ${shape.name}`, () => {
      it('the inspect read finds it at its key and WRITES NOTHING: a read never re-keys', async () => {
        await plant(shape);
        const meta = await getFileMeta(S, shape.key);
        assert.ok(meta, 'the read did not find the row');
        assert.equal(meta._id, shape.key);
        assert.equal(meta.seq, 7);
        assert.equal(meta.description, 'the peer\'s description');
        assert.ok(await rows().findOne({ _id: shape.legacy }), 'a read moved the row: a token holding only a read right caused a write');
        assert.deepEqual(await tombstonePaths(), []);
      });

      it('the inspect read finds it by the legacy spelling too (one key)', async () => {
        await plant(shape);
        assert.equal((await getFileMeta(S, shape.legacy))?._id, shape.key, 'the legacy spelling did not find the row');
      });

      it('MCP update_file_meta edits it in place', async () => {
        await plant(shape);
        const a = await d.mcp('update_file_meta', { path: shape.key, description: 'edited' });
        assert.equal(d.failed(a), false, a.text);
        await expectAtKey(shape, { description: 'edited' });
      });

      it('a REST upload over it keeps its author and tags', async () => {
        await plant(shape);
        const res = await d.post('upload', { query: { path: shape.key }, body: Buffer.from('new bytes'), headers: { 'content-type': 'application/octet-stream' } });
        assert.ok(res.code < 300, JSON.stringify(res.body));
        await expectAtKey(shape);
      });

      it('MCP write_file over it keeps its author and tags', async () => {
        await plant(shape);
        const a = await d.mcp('write_file', { path: shape.key, content: 'rewritten' });
        assert.equal(d.failed(a), false, a.text);
        await expectAtKey(shape);
      });

      for (const via of ['REST', 'MCP']) {
        it(`${via} delete removes it, and the only tombstone is the delete's own at the key`, async () => {
          await plant(shape);
          const a = await d.del(via, shape.key);
          assert.equal(d.failed(a), false, JSON.stringify(a.body ?? a.text));
          assert.equal(await rows().findOne({ _id: shape.legacy }), null, 'the legacy row survived the delete');
          assert.equal(await rows().findOne({ _id: shape.key }), null, 'the row survived the delete');
          assert.deepEqual(await tombstonePaths(), [shape.key], 'the delete left a tombstone at a path other than the key');
        });

        it(`${via} move carries it to its destination`, async () => {
          await plant(shape);
          const a = await d.move(via, shape.key, 'moved/there.txt');
          assert.equal(d.failed(a), false, JSON.stringify(a.body ?? a.text));
          assert.equal(await rows().findOne({ _id: shape.legacy }), null, 'the legacy row survived the move');
          assert.equal(await rows().findOne({ _id: shape.key }), null, 'the row stayed at the source');
          const moved = await rows().findOne({ _id: 'moved/there.txt' });
          assert.ok(moved, 'the row did not arrive at the destination');
          assert.equal(moved.author?.instanceId, PEER, 'the move lost the row\'s author');
          assert.deepEqual(moved.tags, ['legacy', 'peer']);
        });
      }

      it('a peer\'s metadata push for the key lands on the re-keyed row: one row, the newer version', async () => {
        await plant(shape);
        const r = await d.door.push('/batch-upsert', { filemeta: [build.filemeta(S, shape.key, 8, { description: 'newer', tags: ['legacy', 'peer'], sizeBytes: 3 })] }, { spaceId: S });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(await rows().findOne({ _id: shape.legacy }), null, 'the legacy row survived the arrival');
        const row = await rows().findOne({ _id: shape.key });
        assert.equal(row.seq, 8);
        assert.equal(row.description, 'newer');
        assert.equal(await rows().countDocuments({}), 1, 'the key has two rows');
      });

      it('a sync cycle re-keys it, so a peer stops refusing it', async () => {
        await plant(shape);
        await d.pushed();
        await expectAtKey(shape, { seq: 7 });
        assert.deepEqual(await tombstonePaths(), []);
      });
    });
  }

  describe('a row already at the key (3)', () => {
    const shape = SHAPES[2];
    const atKey = (seq, description) => build.filemeta(S, shape.key, seq, { description, tags: ['legacy', 'peer'], sizeBytes: 3, createdAt: T0, updatedAt: T0 });
    const settle = async () => { await fileRowIdFor(S, shape.key); return { legacy: await rows().findOne({ _id: shape.legacy }), key: await rows().findOne({ _id: shape.key }) }; };

    it('a legacy row of a HIGHER version replaces the one at the key', async () => {
      await plant(shape);
      await rows().insertOne(atKey(3, 'old canonical'));
      const { legacy, key } = await settle();
      assert.equal(legacy, null);
      assert.equal(key?.seq, 7);
      assert.equal(key?.description, 'the peer\'s description');
    });

    it('a legacy row of a LOWER version is dropped: the one at the key stands', async () => {
      await plant(shape);
      await rows().insertOne(atKey(9, 'newer canonical'));
      const { legacy, key } = await settle();
      assert.equal(legacy, null);
      assert.equal(key?.seq, 9);
      assert.equal(key?.description, 'newer canonical');
    });

    it('on an EQUAL version the one at the key stands', async () => {
      await plant(shape);
      await rows().insertOne(atKey(7, 'canonical at the same version'));
      const { legacy, key } = await settle();
      assert.equal(legacy, null);
      assert.equal(key?.description, 'canonical at the same version');
    });

    it('a held tombstone that shadows the legacy row retires it locally: no row, and no tombstone of the re-key\'s own', async () => {
      await plant(shape);
      await d.door.coll(S, 'file_tombstones').insertOne({ _id: `held-${shape.key}`, spaceId: S, path: shape.key, deletedAt: T0, positionAt: T0, rowSeq: 9, issuer: PEER });
      const { legacy, key } = await settle();
      assert.equal(legacy, null, 'a legacy row the tombstone shadows was kept');
      assert.equal(key, null, 'a legacy row the tombstone shadows was re-keyed');
      assert.equal((await d.raw()).length, 1, 'the re-key wrote a tombstone');
    });
  });

  describe('lazy, never at boot (4)', () => {
    it('the first lookup builds the index and a second one does not read for it again', async () => {
      const shape = SHAPES[0];
      await plant(shape);
      const finds = async (p) => (await d.door.commandsDuring(() => fileRowIdFor(S, p))).filter(c => c === `find ${S}_files`).length;
      const first = await finds('nothing-here.txt');
      const second = await finds('nothing-here-either.txt');
      assert.equal(first - second, 1, `the first lookup read ${first} times and the second ${second}: the index is built by the first lookup, once`);
    });
  });
});
