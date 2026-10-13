/**
 * A move takes with it everything a delete of the same file would remove — and does it in a bounded number of commands
 * (bundle-44, Q-314 and Q-212).
 *
 * ## The defect
 *
 * A file is more than its row. A conversion leaves derived rows: a chunk, a converted Markdown, extracted images, and — written by
 * the media worker — the caption and face rows UNDER each image, whose `parentFileId` is the image and not the file. A peer that
 * never converted may hold an arrived sidecar as an ordinary top-level row (no `parentFileId`) with children of its own. The delete
 * removes all of them: one selection, `removeWhatSidecarsLeft`. The move selected differently — the rows whose `parentFileId`
 * matches a path regex (`parentIdsUnder`) plus an id-prefix walk for the files — so:
 *
 *  - the caption and face rows of an extracted image stayed at the OLD id, their `parentFileId` naming an image that moved
 *    (a delete of the moved file then found nothing to remove and left them, searchable, belonging to nothing);
 *  - an arrived sidecar's top-level row, and the rows beneath it, stayed at the old id;
 *  - each derived row cost an `updateMany` on `convertedFileId` (a field with no index: a collection scan per derived row), and was
 *    stamped `updatedAt: now` against the rule that a write which stamps no version must not move the timestamp read beside it.
 *
 * ## The rules, on both doors a file is moved by (REST PATCH, MCP `move_file`: one cascade), for a file and for a directory
 *
 *  1. no row of the file's set is left at an old id; every row is at its moved id with its `parentFileId` re-rooted; nothing of a
 *     name-prefix neighbour moves
 *  2. THE SET A MOVE CARRIES IS THE SET A DELETE REMOVES: two identical seeds, one deleted and one moved, both read from the store
 *     afterwards. The two used to be selected by two implementations, and the weaker one won silently
 *  3. a move of a file with N derived rows issues a number of database commands that does not grow with N, and writes no
 *     `updateMany` on `convertedFileId` (the parent's pointer is still right afterwards)
 *  4. a derived row keeps its stored `updatedAt` across the move
 *
 * Run: node --test testing/standalone/a-move-takes-everything-a-delete-would-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { fileWithEverything } from './_file-with-everything.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'moveeverything';
const STORED_UPDATED_AT = '2026-03-05T10:00:00.000Z';

let acts, door, loader;
const { derived, seedFileWithEverything, seedNeighbour } = fileWithEverything(S, () => acts);

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
/** The id `id` has once `src` is at `dst`: the first occurrence of the old path, under the path itself or a sidecar root. Spelled here, not read from `movedId`. */
const movedTo = (id, src, dst) => id.replace(src, dst);

/**
 * The files a shape's set is made of, each seeded with everything: one file, or two files at different depths under a directory.
 * `root(name)` is the path acted on. `seed` returns one `ids` per file, the kinds `seedFileWithEverything` returns.
 */
const SHAPES = {
  file: {
    async seed(root, opts) { return [await seedFileWithEverything(root, opts)]; },
    remove: (root) => acts.del('REST', root),
    root: (name) => `docs/${name}.txt`,
    neighbour: (root) => `${root}x`,                       // `docs/a.txtx`
    bytesAt: (root) => root,
    minRows: 7,
  },
  directory: {
    async seed(root, opts) {
      return [await seedFileWithEverything(`${root}/f.txt`, opts), await seedFileWithEverything(`${root}/sub/k.txt`, opts)];
    },
    remove: (root) => acts.rest('DELETE', { path: root }, { confirm: true }),
    root: (name) => `docs/d-${name}`,
    neighbour: (root) => `${root}2/g.txt`,                 // `docs/d-a2/g.txt`
    bytesAt: (root) => `${root}/f.txt`,
    minRows: 14,
  },
};
const VARIANTS = {
  'derived sidecars': {},
  'arrived sidecars, with a child under an arrived image': { arrivedSidecars: true, arrivedChild: true },
};
const DOORS = ['REST', 'MCP'];

/** Every id of every file of a set, labelled by file and kind so a failure names what was left. */
const labelled = (set) => set.flatMap((ids, i) => Object.entries(ids).map(([kind, id]) => ({ label: `${i}:${kind}`, id })));

describe('a move takes everything a delete would, and does it in a bounded number of commands', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'moveeverything', space: S, monitorCommands: true });
    ({ door } = acts);
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => {
    if (loader) loader.getConfig().softDeleteFileMeta = false;
    await acts?.close();
  });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['media_jobs', 'file_hashes']) await door.coll(S, part).deleteMany({});
    loader.getConfig().softDeleteFileMeta = false;
  });

  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    for (const [variantName, opts] of Object.entries(VARIANTS)) {
      for (const via of DOORS) {
        it(`${via}, a ${shapeName}, ${variantName}: every row of the set is at its moved id with its parent re-rooted, none at an old id, and a neighbour's rows stay`, async () => {
          const src = shape.root('a');
          const dst = shape.root('moved');
          const set = await shape.seed(src, opts);
          const nb = await seedNeighbour(shape.neighbour(src));
          const subjects = labelled(set);
          const before = new Map();
          for (const s of subjects) before.set(s.id, await rowOf(s.id));
          assert.ok([...before.values()].every(r => r !== null), 'fixture: a seeded row is missing');
          assert.ok(subjects.length >= shape.minRows, `fixture: the set does not have everything it is meant to (${subjects.length})`);

          const a = await acts.move(via, src, dst);
          assert.ok(!acts.failed(a), `${via} move: ${JSON.stringify(a.body ?? a.text)}`);
          assert.ok(acts.onDisk(shape.bytesAt(dst)), 'the bytes did not move: the cascade did not run');

          const problems = [];
          for (const s of subjects) {
            const old = before.get(s.id);
            if (await rowOf(s.id)) problems.push(`${s.label}: a row is still at the OLD id ${s.id}`);
            const newId = movedTo(s.id, src, dst);
            const moved = await rowOf(newId);
            if (!moved) { problems.push(`${s.label}: no row at the moved id ${newId}`); continue; }
            if (moved.path !== newId) problems.push(`${s.label}: path ${moved.path} is not its id ${newId}`);
            const wantParent = old.parentFileId === undefined ? undefined : movedTo(old.parentFileId, src, dst);
            if (moved.parentFileId !== wantParent) problems.push(`${s.label}: parentFileId ${moved.parentFileId} should be ${wantParent}`);
          }
          assert.deepEqual(problems, [], 'what a move of the file left behind, or did not re-root');

          const neighbourLost = [];
          for (const id of nb.ids) if (!(await rowOf(id))) neighbourLost.push(id);
          assert.deepEqual(neighbourLost, [], 'the move took rows of a path that only starts with the same letters');
        });
      }

      it(`a ${shapeName}, ${variantName}: the rows a move carries are the rows a delete of the same seed removes`, async () => {
        const doomed = shape.root('doomed');
        const carried = shape.root('carried');
        const moved = shape.root('carried-to');
        const deleteSet = await shape.seed(doomed, opts);
        const moveSet = await shape.seed(carried, opts);

        const del = await shape.remove(doomed);
        assert.ok(!acts.failed(del), `delete: ${JSON.stringify(del.body)}`);
        const mv = await acts.move('REST', carried, moved);
        assert.ok(!acts.failed(mv), `move: ${JSON.stringify(mv.body)}`);

        // Both read from the store, by the same labels, and never from the code that selected them.
        const removed = [];
        for (const s of labelled(deleteSet)) if (!(await rowOf(s.id))) removed.push(s.label);
        const movedLabels = [];
        for (const s of labelled(moveSet)) if (!(await rowOf(s.id)) && (await rowOf(movedTo(s.id, carried, moved)))) movedLabels.push(s.label);

        assert.deepEqual(removed, labelled(deleteSet).map(s => s.label),
          'fixture: the delete did not remove everything of the seed (the reference set is not the whole file)');
        assert.deepEqual(movedLabels, removed,
          'the set the move carried differs from the set the delete removed: one selection of "what a file leaves" must serve both');
      });
    }
  }

  describe('the cost of a move does not grow with the rows it carries', () => {
    /** A converted file with `n` further chunk rows, its parent pointing at its converted Markdown. */
    async function seedWithChunks(f, n) {
      const ids = await seedFileWithEverything(f, { derivedUpdatedAt: STORED_UPDATED_AT });
      await door.coll(S, 'files').updateOne({ _id: f }, { $set: { convertedFileId: ids.converted } });
      if (n > 0) await door.coll(S, 'files').insertMany(Array.from({ length: n }, (_, i) => derived(`${f}#chunk-extra-${i}`, f, { updatedAt: STORED_UPDATED_AT })));
      return ids;
    }
    const histogram = (cmds) => cmds.reduce((h, c) => { h[c] = (h[c] ?? 0) + 1; return h; }, {});

    it('the number of commands a file move issues is the same whatever the number of derived rows it carries', async () => {
      const counts = [];
      for (const n of [2, 12, 40]) {
        const f = `docs/n${n}.txt`;
        await seedWithChunks(f, n);
        const cmds = await door.commandsDuring(async () => {
          const a = await acts.move('REST', f, `docs/moved-n${n}.txt`);
          assert.ok(!acts.failed(a), JSON.stringify(a.body));
        });
        counts.push({ n, commands: cmds.length, histogram: histogram(cmds) });
      }
      const [few, , many] = counts;
      assert.ok(many.commands - few.commands <= 2,
        `a move of a file with ${many.n} derived rows issued ${many.commands} commands, one with ${few.n} issued ${few.commands}: the cost grows with the rows. ${JSON.stringify(counts)}`);
    });

    it('a move writes no updateMany on convertedFileId, and the parent\'s convertedFileId names the moved sidecar', async () => {
      const f = 'docs/p.txt';
      const ids = await seedWithChunks(f, 5);
      // The wire, not the call: every `update` statement the server sends whose filter is a `convertedFileId` match.
      const pointerWrites = [];
      const listen = (ev) => {
        if (ev.commandName !== 'update') return;
        for (const u of ev.command?.updates ?? []) if (u?.q && 'convertedFileId' in u.q) pointerWrites.push(JSON.stringify(u.q));
      };
      door.mongo.getMongo().on('commandStarted', listen);
      try {
        const a = await acts.move('REST', f, 'docs/q.txt');
        assert.ok(!acts.failed(a), JSON.stringify(a.body));
      } finally { door.mongo.getMongo().off('commandStarted', listen); }

      assert.deepEqual(pointerWrites, [], 'a derived row\'s move wrote the parent\'s pointer by a scan on convertedFileId (the field has no index): one collection scan per derived row');
      assert.equal((await rowOf('docs/q.txt'))?.convertedFileId, movedTo(ids.converted, f, 'docs/q.txt'),
        'the moved file\'s convertedFileId does not name its moved converted Markdown');
    });

    it('a derived row keeps its stored updatedAt across the move', async () => {
      const f = 'docs/u.txt';
      await seedWithChunks(f, 3);
      const derivedIds = (await door.coll(S, 'files').find({ parentFileId: { $exists: true } }, { projection: { _id: 1 } }).toArray()).map(r => r._id);
      assert.ok(derivedIds.length >= 6, 'fixture: the file has no derived rows');
      const a = await acts.move('REST', f, 'docs/v.txt');
      assert.ok(!acts.failed(a), JSON.stringify(a.body));

      const found = [];
      const restamped = [];
      for (const id of derivedIds) {
        const row = await rowOf(movedTo(id, f, 'docs/v.txt'));
        if (!row) continue;                                  // a row the move did not carry is the first test's finding
        found.push(row._id);
        if (row.updatedAt !== STORED_UPDATED_AT) restamped.push(`${row._id}: ${row.updatedAt}`);
      }
      assert.ok(found.length >= 5, `fixture: only ${found.length} derived rows reached their moved id`);
      assert.deepEqual(restamped, [], 'a move stamped `updatedAt: now` on derived rows it did not rewrite: a write that stamps no version must not move the timestamp read beside it');
    });
  });
});
