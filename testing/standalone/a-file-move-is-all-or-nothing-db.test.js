/**
 * A file move is all or nothing, and a destination that something already stands at is refused before anything is written
 * (bundle-44, Q-342, Q-212, Q-437; plan rev 3 D1, D3; D-29).
 *
 * ## The rule
 *
 * Moving a file or a directory leaves each moved thing wholly at its old path or wholly at its new one — the file's row,
 * the rows derived from it, its jobs and its links — and a destination something already stands at refuses the move
 * BEFORE anything is written. What the destination holds decides the outcome, the same on every door:
 *
 *  - nothing there: the move happens;
 *  - only a FLAGGED row there (the audit record a soft delete leaves, local state): the move happens, the moved record is
 *    the live row at the destination and the flagged one is gone — writing a path clears its flag;
 *  - a LIVE file there: `409 destination_exists` — a move never replaces anything, so the occupant's bytes, record, derived rows
 *    and links are untouched and the source is whole;
 *  - rows of ANOTHER file at an id the move would take: the same `409 destination_exists`, bytes still at the source, no
 *    tombstone, nothing overwritten.
 *
 * ## What it was
 *
 * `renameFileMeta` deleted the source row and inserted the destination row. A destination row that was already there made
 * the insert fail `E11000` AFTER the delete, the failure was not the store's so the cascade swallowed it, and the door
 * answered 200 with the moved file's record gone from both paths (pinned as a "known limit" by
 * `a-file-move-keeps-everything-but-the-stamp-db` until this bundle). A directory move did the same for every child from the
 * first collision on (`renameFileMetaByPrefix`, ordered insert after a delete of all of them). The derived rows were
 * deleted by id at the old AND the new ids, so another file's row at a derived id was overwritten without a word.
 *
 * ## What the cases hold
 *
 * Every assertion names the identity it expects (which row is at which id, whose description it carries, which link targets
 * a path holds), never a count: a count passes when the query looks in the wrong place. The doors are the real REST handler,
 * the real MCP `callTool` and the cascade itself (`moveFileCascade`); a case that asserts a status is asserted on the doors
 * and a case about the cascade's own outcome says so.
 *
 * Run: node --test testing/standalone/a-file-move-is-all-or-nothing-db.test.js
 * (requires a prior `npm run build` in server/, the test MongoDB, and a private IPv4 on the host: the doors helper binds one)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'moveatomic';
const T0 = '2026-09-01T00:00:00.000Z';
const AUTHOR = { instanceId: 'move-atomic', instanceLabel: 'Move atomic' };
/** What a file can link to: entity and fact ids are UUID v4 under the default strict linkage. */
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';
const F1 = '44444444-4444-4444-8444-444444444444';

let acts, door, meta, adjacency, cascade;

const files = () => door.coll(S, 'files');
const rowOf = (id) => files().findOne({ _id: id });
const onDisk = (p) => acts.onDisk(p);
/** The ids, among `ids`, that hold a row — live or flagged. */
const rowsAmong = async (ids) => (await files().find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
const linkTargets = async (id) => (await adjacency.linksStartingFrom(S, [id])).map(r => `${r.toKind}:${r.to}`).sort();

/** A file's record as a person left it: every field a move has to carry, each naming its own file. */
const rich = (id, extra = {}) => ({
  tags: [`tag-of-${id}`], description: `description of ${id}`, properties: { owner: id }, sizeBytes: `content of ${id}`.length, ...extra,
});

/** Entities and a fact a file can link to, so `strictLinkage` has something to resolve. */
async function seedTargets() {
  const entity = (_id, name, seq) => ({ _id, spaceId: S, name, type: 'thing', tags: [], createdAt: T0, seq, author: AUTHOR });
  await door.coll(S, 'entities').insertMany([entity(E1, 'One', 1), entity(E2, 'Two', 2), entity(E3, 'Three', 3)]);
  await door.coll(S, 'facts').insertOne({ _id: F1, spaceId: S, fact: 'a fact', tags: [], createdAt: T0, seq: 4, author: AUTHOR });
}
/** Link a file through the one writer of a file's links, as every door does. */
async function link(id, { entities = [], facts = [] }) {
  await meta.updateFileMeta(S, id, { ...(entities.length ? { linkEntities: entities } : {}), ...(facts.length ? { linkFacts: facts } : {}) });
}

/** A file with its bytes, a rich record, a chunk row and a converted-Markdown row derived from it, and links. */
async function seedFile(p, { entities = [E1], facts = [F1], chunk = true } = {}) {
  await acts.seed(p, rich(p));
  if (chunk) {
    await files().insertOne({ _id: `${p}#chunk-0`, spaceId: S, path: `${p}#chunk-0`, parentFileId: p, chunkIndex: 0, content: `chunk of ${p}`,
      tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, author: AUTHOR });
  }
  await link(p, { entities, facts });
}
/** The audit record a soft delete leaves at `p`: flagged, with nothing the file's bytes made. */
async function seedFlagged(p) {
  await files().insertOne({ _id: p, spaceId: S, path: p, tags: [], description: `the deleted file at ${p}`, createdAt: T0, updatedAt: T0, sizeBytes: 3,
    deletedAt: '2026-08-01T00:00:00.000Z' });
}
/** The links a deleted file left behind: a file's delete does not remove them, so a path can hold links and no row. */
async function seedStrandedLinks(p, link_) {
  await files().insertOne({ _id: p, spaceId: S, path: p, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 1 });
  await link(p, link_);
  await files().deleteOne({ _id: p });
}

/** One move through `via`: the cascade itself, the REST handler or MCP `move_file`. */
async function moveVia(via, src, dst) {
  if (via === 'cascade') {
    try { await cascade.moveFileCascade(S, src, dst); return { status: 200 }; } catch (error) { return { status: undefined, error }; }
  }
  const answer = await acts.move(via, src, dst);
  return { status: acts.statusOf(answer), answer };
}
const bodyOf = (r) => r.answer?.body ?? r.answer?.sc ?? {};

describe('a file move is all or nothing (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'moveatomic', space: S });
    ({ door } = acts);
    meta = await import('../../server/dist/files/file-meta.js');
    adjacency = await import('../../server/dist/brain/link-adjacency.js');
    cascade = await import('../../server/dist/files/move-cascade.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'entities', 'facts', 'media_jobs', 'embed_jobs', 'tombstones']) await door.coll(S, part).deleteMany({});
    await seedTargets();
  });

  describe('the destination holds only a FLAGGED row: the moved record is the live row there, on every door', () => {
    for (const via of ['cascade', 'REST', 'MCP']) {
      it(`${via}: the moved file's record, derived rows and links arrive; the flagged row is gone`, async () => {
        await seedFile('a.txt');
        await seedFlagged('b.txt');
        const before = await rowOf('a.txt');
        assert.ok(before, 'fixture: the source has no record');

        const r = await moveVia(via, 'a.txt', 'b.txt');

        assert.equal(r.status, 200, `the move was refused or failed: ${r.error?.message ?? JSON.stringify(bodyOf(r))}`);
        assert.ok(onDisk('b.txt') && !onDisk('a.txt'), 'the bytes did not move');
        const moved = await rowOf('b.txt');
        assert.ok(moved, 'the moved file has NO record at its destination: the flagged row made the re-key fail after the source row was deleted (E11000), and nothing put it back');
        assert.equal(moved.deletedAt, undefined, 'the row at the destination is still the flagged one: the moved file\'s record was lost');
        assert.equal(moved.description, 'description of a.txt', 'the destination row is not the moved file\'s record');
        assert.deepEqual(moved.tags, ['tag-of-a.txt']);
        assert.deepEqual(moved.properties, { owner: 'a.txt' });
        assert.deepEqual(await rowsAmong(['a.txt', 'a.txt#chunk-0']), [], 'a row of the moved file is still at the source');
        const chunk = await rowOf('b.txt#chunk-0');
        assert.ok(chunk, 'the derived chunk row did not follow the file');
        assert.equal(chunk.parentFileId, 'b.txt');
        assert.deepEqual(await linkTargets('b.txt'), [`entity:${E1}`, `fact:${F1}`], 'the moved file\'s links are not at its destination');
        assert.deepEqual(await linkTargets('a.txt'), [], 'a link still names the source');
      });
    }
  });

  describe('the destination holds a LIVE file: the move is refused, and nothing of either file changes', () => {
    for (const via of ['cascade', 'REST', 'MCP']) {
      it(`${via}: 409 destination_exists; the occupant's bytes, record, derived row and links and the source's are exactly as they were`, async () => {
        await seedFile('a.txt', { entities: [E1], facts: [F1] });
        await seedFile('b.txt', { entities: [E2, E3], facts: [] });
        assert.deepEqual(await linkTargets('b.txt'), [`entity:${E2}`, `entity:${E3}`], 'fixture: the occupant is not linked');
        const before = {
          a: await rowOf('a.txt'), aChunk: await rowOf('a.txt#chunk-0'), b: await rowOf('b.txt'), bChunk: await rowOf('b.txt#chunk-0'),
          aLinks: await linkTargets('a.txt'), bLinks: await linkTargets('b.txt'),
        };

        const r = await moveVia(via, 'a.txt', 'b.txt');

        if (via === 'cascade') {
          assert.equal(r.error?.name, 'DestinationExists', `the cascade did not refuse a move onto an existing file: ${r.error?.message ?? r.status}`);
          assert.equal(r.error.path, 'b.txt');
        } else {
          assert.equal(r.status, 409, `answered ${r.status}: ${JSON.stringify(bodyOf(r))} — a move onto an existing file must be refused`);
          assert.equal(bodyOf(r).code, 'destination_exists', JSON.stringify(bodyOf(r)));
          assert.equal(bodyOf(r).path, 'b.txt');
        }
        assert.equal(fs.readFileSync(path.join(acts.root(), 'b.txt'), 'utf8'), 'content of b.txt', 'the occupant\'s bytes were replaced');
        assert.equal(fs.readFileSync(path.join(acts.root(), 'a.txt'), 'utf8'), 'content of a.txt', 'the source\'s bytes changed');
        assert.deepEqual(await rowOf('a.txt'), before.a, 'the source\'s record changed');
        assert.deepEqual(await rowOf('a.txt#chunk-0'), before.aChunk, 'the source\'s chunk row changed');
        assert.deepEqual(await rowOf('b.txt'), before.b, 'the occupant\'s record changed');
        assert.deepEqual(await rowOf('b.txt#chunk-0'), before.bChunk, 'the occupant\'s chunk row was replaced');
        assert.deepEqual(await linkTargets('a.txt'), before.aLinks, 'the source lost its links to a refused move');
        assert.deepEqual(await linkTargets('b.txt'), before.bLinks, 'the occupant\'s links changed');
        assert.deepEqual(await acts.raw(), [], 'a refused move left a tombstone');
      });
    }
  });

  describe('the destination holds rows of ANOTHER file at an id the move would take: refused before anything is written', () => {
    /** `a.txt` with its converted Markdown, and a stale converted row at `b.txt`'s id whose parent is a different file. */
    async function seedCollision() {
      await seedFile('a.txt');
      await acts.seed('z.txt', rich('z.txt'));
      await files().insertOne({ _id: '_converted/a.txt.md', spaceId: S, path: '_converted/a.txt.md', parentFileId: 'a.txt', content: 'converted a',
        tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 11, author: AUTHOR });
      await files().insertOne({ _id: '_converted/b.txt.md', spaceId: S, path: '_converted/b.txt.md', parentFileId: 'z.txt', content: 'converted z',
        tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 11, author: AUTHOR });
    }

    for (const via of ['cascade', 'REST', 'MCP']) {
      it(`${via}: nothing moves, nothing is tombstoned and the other file's row is untouched`, async () => {
        await seedCollision();
        const before = { a: await rowOf('a.txt'), converted: await rowOf('_converted/a.txt.md'), other: await rowOf('_converted/b.txt.md') };

        const r = await moveVia(via, 'a.txt', 'b.txt');

        if (via === 'cascade') assert.ok(r.error, 'the cascade completed a move onto rows of another file');
        else {
          assert.equal(r.status, 409, `answered ${r.status}: ${JSON.stringify(bodyOf(r))} — a move that overwrites another file's derived row must be refused`);
          assert.equal(bodyOf(r).code, 'destination_exists', JSON.stringify(bodyOf(r)));
        }
        assert.ok(onDisk('a.txt') && !onDisk('b.txt'), 'the bytes moved although the move was refused');
        assert.deepEqual(await acts.raw(), [], 'a refused move left a tombstone for a path that did not go');
        assert.deepEqual(await rowOf('a.txt'), before.a, 'the source record changed');
        assert.deepEqual(await rowOf('_converted/a.txt.md'), before.converted, 'the source\'s derived row changed');
        assert.deepEqual(await rowOf('_converted/b.txt.md'), before.other,
          'the other file\'s derived row was overwritten by the moved file\'s: a move takes only what its own file owns');
        assert.equal(await rowOf('b.txt'), null, 'a record appeared at the destination of a refused move');
        assert.deepEqual(await linkTargets('a.txt'), [`entity:${E1}`, `fact:${F1}`], 'the source lost its links to a refused move');
        assert.deepEqual(await linkTargets('b.txt'), []);
      });
    }

    it('a DIRECTORY move is refused whole when one child collides: no child is moved, tombstoned or relinked', async () => {
      await seedFile('src/c1.txt');
      await seedFile('src/c2.txt');
      await files().insertOne({ _id: '_converted/src/c2.txt.md', spaceId: S, path: '_converted/src/c2.txt.md', parentFileId: 'src/c2.txt', content: 'c2',
        tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 2, author: AUTHOR });
      await acts.seed('z.txt', rich('z.txt'));
      await files().insertOne({ _id: '_converted/moved/c2.txt.md', spaceId: S, path: '_converted/moved/c2.txt.md', parentFileId: 'z.txt', content: 'z',
        tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 1, author: AUTHOR });
      const other = await rowOf('_converted/moved/c2.txt.md');

      const r = await moveVia('REST', 'src', 'moved');

      assert.equal(r.status, 409, `answered ${r.status}: ${JSON.stringify(bodyOf(r))}`);
      assert.equal(bodyOf(r).code, 'destination_exists');
      assert.ok(onDisk('src/c1.txt') && onDisk('src/c2.txt') && !onDisk('moved/c1.txt'), 'a child moved although the directory move was refused');
      assert.deepEqual(await acts.raw(), [], 'a refused directory move left tombstones');
      assert.deepEqual(await rowsAmong(['src/c1.txt', 'src/c2.txt', 'src/c1.txt#chunk-0', 'src/c2.txt#chunk-0']),
        ['src/c1.txt', 'src/c1.txt#chunk-0', 'src/c2.txt', 'src/c2.txt#chunk-0'], 'a moved child\'s rows left the source');
      assert.deepEqual(await rowOf('_converted/moved/c2.txt.md'), other, 'the other file\'s derived row was overwritten');
      assert.deepEqual(await linkTargets('src/c1.txt'), [`entity:${E1}`, `fact:${F1}`]);
    });
  });

  describe('a directory move where one child collides with a flagged row and the rest do not', () => {
    for (const via of ['cascade', 'REST']) {
      it(`${via}: every child arrives with its own record and links — the colliding one too, and none is lost`, async () => {
        for (const c of ['c1', 'c2', 'c3']) await seedFile(`src/${c}.txt`, { entities: [E1] , facts: [] });
        await seedFlagged('moved/c2.txt');

        const r = await moveVia(via, 'src', 'moved');

        assert.equal(r.status, 200, `the directory move failed: ${r.error?.message ?? JSON.stringify(bodyOf(r))}`);
        for (const c of ['c1', 'c2', 'c3']) {
          const moved = await rowOf(`moved/${c}.txt`);
          assert.ok(moved, `moved/${c}.txt has no record: the ordered re-insert stopped at the colliding child and everything after it was lost`);
          assert.equal(moved.deletedAt, undefined, `moved/${c}.txt is still the flagged row`);
          assert.equal(moved.description, `description of src/${c}.txt`, `moved/${c}.txt carries somebody else's record`);
          assert.equal((await rowOf(`moved/${c}.txt#chunk-0`))?.parentFileId, `moved/${c}.txt`, `the chunk of ${c} did not follow its file`);
          assert.ok(onDisk(`moved/${c}.txt`) && !onDisk(`src/${c}.txt`));
        }
        for (const c of ['c1', 'c2', 'c3']) {
          assert.deepEqual(await linkTargets(`moved/${c}.txt`), [`entity:${E1}`], `the links of ${c} did not follow it`);
          assert.deepEqual(await linkTargets(`src/${c}.txt`), [], `a link still names src/${c}.txt`);
        }
        assert.deepEqual(await rowsAmong(['src/c1.txt', 'src/c2.txt', 'src/c3.txt', 'src/c1.txt#chunk-0', 'src/c2.txt#chunk-0', 'src/c3.txt#chunk-0']), [],
          'a row of the moved directory is left at the source');
      });
    }
  });

  describe('after a move the destination\'s link set EQUALS the source\'s', () => {
    it('a source with links onto a path that holds the stale links of a deleted file: the stale ones are gone (control: the source\'s arrive)', async () => {
      await seedFile('a.txt', { entities: [E1], facts: [] });
      await seedStrandedLinks('b.txt', { entities: [E2, E3], facts: [F1] });
      assert.deepEqual(await linkTargets('b.txt'), [`entity:${E2}`, `entity:${E3}`, `fact:${F1}`], 'fixture: the path holds no stale links');

      const r = await moveVia('cascade', 'a.txt', 'b.txt');

      assert.equal(r.status, 200, r.error?.message);
      assert.deepEqual(await linkTargets('b.txt'), [`entity:${E1}`]);
      assert.deepEqual(await linkTargets('a.txt'), []);
    });

    for (const via of ['cascade', 'REST', 'MCP']) {
      it(`${via}: a source WITHOUT links onto a path that holds a previous occupant's links leaves it linked to nothing`, async () => {
        await seedFile('a.txt', { entities: [], facts: [] });
        await seedStrandedLinks('b.txt', { entities: [E2, E3], facts: [F1] });
        assert.deepEqual(await linkTargets('a.txt'), [], 'fixture: the source has links');

        const r = await moveVia(via, 'a.txt', 'b.txt');

        assert.equal(r.status, 200, `the move failed: ${r.error?.message ?? JSON.stringify(bodyOf(r))}`);
        assert.ok(await rowOf('b.txt'), 'the moved record is not at the destination');
        assert.deepEqual(await linkTargets('b.txt'), [],
          'the file inherited the people, facts and chrono its previous occupant was linked to — what face auto-labelling reads');
      });
    }
  });

  describe('control: a destination nothing holds', () => {
    for (const via of ['cascade', 'REST', 'MCP']) {
      it(`${via}: the record, its derived rows and its links move whole`, async () => {
        await seedFile('a.txt');
        const before = await rowOf('a.txt');
        const r = await moveVia(via, 'a.txt', 'dir/b.txt');
        assert.equal(r.status, 200, `the move failed: ${r.error?.message ?? JSON.stringify(bodyOf(r))}`);
        const moved = await rowOf('dir/b.txt');
        assert.equal(moved?.description, before.description);
        assert.deepEqual(moved?.properties, before.properties);
        assert.deepEqual(await rowsAmong(['a.txt', 'a.txt#chunk-0']), []);
        assert.deepEqual(await rowsAmong(['dir/b.txt', 'dir/b.txt#chunk-0']), ['dir/b.txt', 'dir/b.txt#chunk-0']);
        assert.deepEqual(await linkTargets('dir/b.txt'), [`entity:${E1}`, `fact:${F1}`]);
        assert.deepEqual(await linkTargets('a.txt'), []);
      });
    }
  });
});
