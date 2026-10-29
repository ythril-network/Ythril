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
 * ## What is keyed by the paths besides the rows (bundle-111, Q-459; design rev 3 step 5, V-S2, V-S4, V-S9, rev 3.1)
 *
 * The hash cache (`<space>_file_hashes`, keyed by the on-disk spelling) and the embed queue (one job per row id). A move re-keyed
 * neither: the old path's cache entry stayed, the moved file kept the OLD path's vector (its embed text is built from its path) with no
 * job at its new id, and the old id's job answered `gone`. A delete left every embed job of the file and its derived rows.
 *
 *  5. (a) after a move of a file or a directory with sidecars: every moved TOP-LEVEL row is queued at its new id whether or not it had
 *     a job, every row that had a job has one at its new id, no job and no cache entry is left at an old id, and the cache entry is
 *     CARRIED — the next manifest answers the sentinel hash the entry holds, which the bytes do not have;
 *     (b) a cache entry a manifest build wrote at the destination between the bytes and the carry does not stop the move, and is
 *     replaced by the carried one;
 *     (c) an owed move whose first attempt committed one batch is finished — by a request retry and by housekeeping — with the rows of
 *     the batch committed EARLIER queued too;
 *     (d) a delete (file, directory, and the media worker's reconcile of a source gone from disk) leaves no embed job of any row of the
 *     file; a file literally named `<name>#1.md` is not a derived row of `<name>` and keeps its job through the delete and a move;
 *     (e) a failed job left at a destination, whose file was deleted, does not stop a move onto it;
 *     (f) an NFD-named file (its cache key the on-disk NFD spelling, its row id NFC) — its cache entry follows a move of its directory;
 *     and a store that fails after the commit leaves the move finished and says so once.
 *
 * Run: node --test testing/standalone/a-move-takes-everything-a-delete-would-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { fileWithEverything, sentinelSha, BYTE_KINDS } from './_file-with-everything.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'moveeverything';
const STORED_UPDATED_AT = '2026-03-05T10:00:00.000Z';

let acts, door, loader;
const { derived, fileRow, seedFileWithEverything, seedNeighbour } = fileWithEverything(S, () => acts);

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
    for (const part of ['media_jobs', 'file_hashes', 'embed_jobs']) await door.coll(S, part).deleteMany({});
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

  describe('an orphan derived row under a directory: the roots of what a directory holds are one answer', () => {
    /**
     * A derived row whose parent has no row (the file it came from is gone) and whose id is under neither the directory nor its
     * sidecar trees — only its `parentFileId` names the directory, so only a root taken from the parents reaches it.
     */
    const orphanOf = (dir) => ({ id: `orphans-of/${dir}/gone.txt#chunk-0`, parent: `${dir}/gone.txt` });
    const seedWithOrphan = async (dir) => {
      const set = [await seedFileWithEverything(`${dir}/f.txt`), await seedFileWithEverything(`${dir}/sub/k.txt`)];
      const o = orphanOf(dir);
      await door.coll(S, 'files').insertOne(derived(o.id, o.parent));
      return { set, orphan: o };
    };

    it('a directory delete removes an orphan derived row, as the move carried it', async () => {
      const src = 'docs/d-orphan';
      const dst = 'docs/d-orphan-moved';
      const { set, orphan } = await seedWithOrphan(src);

      const mv = await acts.move('REST', src, dst);
      assert.ok(!acts.failed(mv), `move: ${JSON.stringify(mv.body ?? mv.text)}`);
      const carried = await rowOf(orphan.id);
      assert.ok(carried, 'the move did not carry the orphan derived row: it stands at its old id');
      assert.equal(carried.parentFileId, `${dst}/gone.txt`, 'the carried orphan names the moved directory\'s path as its parent');

      const del = await acts.rest('DELETE', { path: dst }, { confirm: true });
      assert.ok(!acts.failed(del), `delete: ${JSON.stringify(del.body)}`);
      const left = [];
      for (const s of labelled(set)) if (await rowOf(movedTo(s.id, src, dst))) left.push(s.label);
      assert.deepEqual(left, [], 'the delete left rows of the moved files');
      assert.equal(await rowOf(orphan.id), null, 'the directory delete did not remove an orphan derived row the move had carried');
    });

    it('a directory delete without a move removes the same orphan', async () => {
      const dir = 'docs/d-orphan-direct';
      const { orphan } = await seedWithOrphan(dir);
      const del = await acts.rest('DELETE', { path: dir }, { confirm: true });
      assert.ok(!acts.failed(del), `delete: ${JSON.stringify(del.body)}`);
      assert.equal(await rowOf(orphan.id), null, 'the directory delete left an orphan derived row that names the directory');
    });
  });

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

  describe('what is keyed by the paths besides the rows: the hash cache and the embed jobs (Q-459)', () => {
    let queue, manifest, timing, finish, walk, mediaQueue, worker;
    const embedJobs = () => door.coll(S, 'embed_jobs');
    const hashes = () => door.coll(S, 'file_hashes');
    const jobOf = (id) => embedJobs().findOne({ _id: queue.embedJobId('file', id) });
    const cacheAt = (key) => hashes().findOne({ _id: key });
    /** What the next manifest walk answers, `path -> sha256`. */
    const manifestNow = async () => new Map((await manifest.buildFileManifest(S)).map(e => [e.diskPath, e.sha256]));
    const LATER = () => new Date(Date.now() + 24 * 3_600_000);

    /** The Nth `insertMany` on the files collection runs `act` first (or throws `act` when it is an Error). The batch's rows are written by it. */
    function onFilesInsert(n, act) {
      const proto = Object.getPrototypeOf(door.mongo.col('probe'));
      const original = proto.insertMany;
      let calls = 0;
      let fired = 0;
      proto.insertMany = async function hooked(...args) {
        if (this.collectionName === `${S}_files` && ++calls === n) {
          fired++;
          if (act instanceof Error) throw act;
          await act();
        }
        return original.apply(this, args);
      };
      return { restore: () => { proto.insertMany = original; }, fired: () => fired };
    }

    /** One housekeeping pass over the space, inside a walk as production runs it. */
    async function housekeeping() {
      let outcome;
      const runner = walk.createHousekeepingWalk({ storeAnswers: async () => true });
      await runner.eachSpace('TTL sweep: finishing interrupted file moves', [{ id: S }], async () => { outcome = await finish.finishOwedMoves(S, LATER()); });
      return outcome;
    }

    before(async () => {
      queue = await import('../../server/dist/brain/embed-queue.js');
      manifest = await import('../../server/dist/files/manifest.js');
      timing = await import('../../server/dist/files/move-timing.js');
      finish = await import('../../server/dist/files/finish-owed-moves.js');
      walk = await import('../../server/dist/util/housekeeping-walk.js');
      mediaQueue = await import('../../server/dist/files/media/job-queue.js');
      worker = await import('../../server/dist/files/media/worker.js');
    });
    afterEach(() => { timing.setMoveTimingForTest(null); worker.stopMediaEmbeddingWorker(); });

    for (const shapeName of ['file', 'directory']) {
      const shape = SHAPES[shapeName];
      for (const queued of [true, false]) {
        it(`(a) a ${shapeName}, ${queued ? 'every row queued' : 'nothing queued'}: every moved top-level row is queued at its new id, nothing is left at an old id, and the cache entry is carried, not re-hashed`, async () => {
          const src = shape.root('a');
          const dst = shape.root('moved');
          const set = await shape.seed(src, { queued, cached: true });
          const subjects = labelled(set);
          const withBytes = set.flatMap(ids => BYTE_KINDS.map(kind => ids[kind]));
          if (queued) for (const s of subjects) assert.ok(await jobOf(s.id), `fixture: ${s.label} was not queued`);
          for (const id of withBytes) assert.ok(await cacheAt(id), `fixture: no cache entry for ${id}`);
          const before = new Map();
          for (const id of withBytes) before.set(id, fs.statSync(path.join(acts.root(), id)));

          const a = await acts.move('REST', src, dst);
          assert.ok(!acts.failed(a), `move: ${JSON.stringify(a.body ?? a.text)}`);

          const leftAtOld = [];
          for (const s of subjects) if (await jobOf(s.id)) leftAtOld.push(`${s.label}: an embed job at the old id ${s.id}`);
          for (const id of withBytes) if (await cacheAt(id)) leftAtOld.push(`a hash cache entry at the old path ${id}`);
          assert.deepEqual(leftAtOld, [], 'the move left what is keyed by the old paths behind');

          const notQueued = [];
          for (const s of subjects) {
            const newId = movedTo(s.id, src, dst);
            const row = await rowOf(newId);
            const topLevel = row && row.parentFileId === undefined;
            if ((topLevel || queued) && !(await jobOf(newId))) notQueued.push(`${s.label}${topLevel ? ' (top level)' : ''}: no embed job at ${newId}`);
          }
          assert.deepEqual(notQueued, [], 'a moved row is not queued at its new id: it keeps the vector its OLD path\'s text was embedded from');

          const notCarried = [];
          for (const id of withBytes) {
            const newId = movedTo(id, src, dst);
            const entry = await cacheAt(newId);
            if (entry?.sha256 !== sentinelSha(id)) notCarried.push(`${newId}: the cache entry at the new path is ${JSON.stringify(entry)}, not the one carried from ${id}`);
          }
          assert.deepEqual(notCarried, [], 'the move did not carry the hash cache entry to the moved path');
          const kept = [];
          for (const id of withBytes) {
            const st = fs.statSync(path.join(acts.root(), movedTo(id, src, dst)));
            if (st.size !== before.get(id).size || st.mtimeMs !== before.get(id).mtimeMs) kept.push(id);
          }
          assert.deepEqual(kept, [], 'fixture: the move rewrote the bytes (size or mtime changed), so no cache entry could be reused');
          const m = await manifestNow();
          const rehashed = withBytes.filter(id => m.get(movedTo(id, src, dst)) !== sentinelSha(id));
          assert.deepEqual(rehashed, [], 'the next manifest re-read the moved bytes instead of reusing the carried entry');
        });
      }
    }

    it('(b) a cache entry a manifest build wrote at the destination after the bytes moved and before the carry: the move finishes, and the carried entry replaces it', async () => {
      const src = 'docs/stale-src.txt';
      const dst = 'docs/stale-dst.txt';
      await seedFileWithEverything(src, { cached: true });
      const hook = onFilesInsert(1, () => hashes().replaceOne({ _id: dst }, { _id: dst, size: 1, mtimeMs: 1, sha256: 'a manifest build in the window' }, { upsert: true }));
      let a;
      try { a = await acts.move('REST', src, dst); } finally { hook.restore(); }
      assert.equal(hook.fired(), 1, 'fixture: the hook never ran: the move does not write its rows with insertMany');
      assert.ok(!acts.failed(a), `a stale cache entry at the destination stopped the move: ${JSON.stringify(a.body ?? a.text)}`);
      assert.ok(await rowOf(dst), 'the record did not reach the destination');
      assert.equal((await cacheAt(dst))?.sha256, sentinelSha(src), 'the entry at the destination is not the one carried from the source');
      assert.equal(await cacheAt(src), null, 'the source\'s entry was left behind');
    });

    for (const retry of ['a request retry', 'housekeeping (finishOwedMoves)']) {
      it(`(c) an owed move whose first attempt committed one batch, finished by ${retry}: every moved row is queued, the earlier batch's too`, async () => {
        timing.setMoveTimingForTest({ txnBytes: 1 });
        for (const n of ['a', 'b', 'c']) await acts.seed(`owed/${n}.txt`);
        const fault = onFilesInsert(2, new Error('the store failed between the batches'));
        let first;
        try { first = await acts.move('REST', 'owed', 'owed-moved'); } finally { fault.restore(); }
        assert.equal(fault.fired(), 1, 'fixture: the fault never fired: the move does not write a batch per file');
        assert.equal(acts.statusOf(first), 503, `fixture: the stopped move was not owed: ${JSON.stringify(first.body ?? first.text)}`);
        assert.ok(await rowOf('owed-moved/a.txt'), 'fixture: batch 1 did not commit in the first attempt');

        if (retry === 'a request retry') {
          const again = await acts.move('REST', 'owed', 'owed-moved');
          assert.ok(!acts.failed(again), `the retry did not finish the move: ${JSON.stringify(again.body ?? again.text)}`);
        } else {
          const outcome = await housekeeping();
          assert.equal(outcome?.finished, 1, `housekeeping did not finish the move: ${JSON.stringify(outcome)}`);
        }
        const problems = [];
        for (const n of ['a', 'b', 'c']) {
          if (!(await rowOf(`owed-moved/${n}.txt`))) problems.push(`${n}: no record at the destination`);
          if (!(await jobOf(`owed-moved/${n}.txt`))) problems.push(`${n}: no embed job at the moved id`);
          if (await jobOf(`owed/${n}.txt`)) problems.push(`${n}: an embed job at the old id`);
        }
        assert.deepEqual(problems, [], 'the finished move did not queue every moved row: a batch an earlier attempt committed is not in the retry\'s plan, so it is read from the rows at the destination or it is never re-embedded');
      });
    }

    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      it(`(d) a ${shapeName} delete leaves no embed job of any row of the file: its own, its chunk, its sidecars and the rows under them`, async () => {
        const root = shape.root('gone');
        const set = await shape.seed(root, { queued: true });
        for (const s of labelled(set)) assert.ok(await jobOf(s.id), `fixture: ${s.label} was not queued`);
        const del = await shape.remove(root);
        assert.ok(!acts.failed(del), `delete: ${JSON.stringify(del.body)}`);
        const left = [];
        for (const s of labelled(set)) if (await jobOf(s.id)) left.push(`${s.label}: ${s.id}`);
        assert.deepEqual(left, [], 'the delete left embed jobs of rows it removed: each answers `gone` when claimed, and one at a later move\'s destination is in that move\'s way');
      });
    }

    it('(d) the media worker, finding a job\'s source gone from disk, removes the file\'s embed jobs with its rows', async () => {
      const loader2 = await import('../../server/dist/config/loader.js');
      const saved = loader2.getConfig().mediaEmbedding;
      loader2.getConfig().mediaEmbedding = {
        levels: { images: 'caption' }, visionProvider: 'local', workerPollIntervalMs: 100, workerMaxPollIntervalMs: 200, faceRecognition: { enabled: false },
      };
      try {
        const f = 'pics/vanished.png';
        const ids = await seedFileWithEverything(f, { queued: true });
        await door.coll(S, 'media_jobs').deleteMany({});
        await mediaQueue.enqueueMediaJob(S, f, 'image/png', 'image');
        fs.rmSync(path.join(acts.root(), f));               // the source is gone; no move owes it
        worker.startMediaEmbeddingWorker();
        await waitFor(async () => (await rowOf(f)) === null, 30_000, 50,
          async () => `the worker never reconciled the vanished source: ${JSON.stringify(await door.coll(S, 'media_jobs').findOne({ _id: f }))}`);
        worker.stopMediaEmbeddingWorker();
        const left = [];
        for (const [kind, id] of Object.entries(ids)) if (await jobOf(id)) left.push(`${kind}: ${id}`);
        assert.deepEqual(left, [], 'the reconcile removed the rows of a vanished file and left their embed jobs');
      } finally {
        worker.stopMediaEmbeddingWorker();
        loader2.getConfig().mediaEmbedding = saved;
      }
    });

    for (const act of ['delete', 'move']) {
      it(`(d) a file literally named '<name>#1.md' is not a derived row of '<name>': a ${act} of '<name>' leaves its job and its record`, async () => {
        const name = 'docs/hash.txt';
        const lookalike = `${name}#1.md`;
        await acts.seed(name);
        await acts.seed(lookalike);
        await door.coll(S, 'files').insertOne(derived(`${name}#chunk-0`, name));
        await queue.enqueueEmbedJobs(S, 'file', [name, `${name}#chunk-0`, lookalike], { priority: queue.EMBED_PRIORITY.background });

        const a = act === 'delete' ? await acts.del('REST', name) : await acts.move('REST', name, 'docs/hash-moved.txt');
        assert.ok(!acts.failed(a), `${act}: ${JSON.stringify(a.body ?? a.text)}`);

        assert.ok(await rowOf(lookalike), `the ${act} took the record of a file whose name merely starts with '${name}#'`);
        assert.ok(await jobOf(lookalike), `the ${act} took the embed job of '${lookalike}': derived ids were matched by an id prefix, not read from the rows`);
        const gone = [];
        for (const id of [name, `${name}#chunk-0`]) if (await jobOf(id)) gone.push(id);
        assert.deepEqual(gone, [], `the ${act} left the embed jobs of '${name}' and its chunk at their old ids`);
        if (act === 'move') assert.ok(await jobOf('docs/hash-moved.txt'), 'the moved file is not queued at its new id');
      });
    }

    it('(e) a failed embed job left at a destination whose file was deleted does not stop a move onto it, and the moved row is queued afresh', async () => {
      const src = 'docs/e-src.txt';
      const dst = 'docs/e-dst.txt';
      await acts.seed(src);
      await acts.seed(dst);
      await queue.enqueueEmbedJobs(S, 'file', [dst], { priority: queue.EMBED_PRIORITY.background });
      await embedJobs().updateOne({ _id: queue.embedJobId('file', dst) }, { $set: { status: 'failed', attempts: 5, lastError: 'the old content failed' } });
      const del = await acts.del('REST', dst);
      assert.ok(!acts.failed(del), `delete: ${JSON.stringify(del.body)}`);

      const a = await acts.move('REST', src, dst);
      assert.ok(!acts.failed(a), `a leftover job at the destination stopped the move: ${JSON.stringify(a.body ?? a.text)}`);
      assert.ok(await rowOf(dst), 'the record did not reach the destination');
      const job = await jobOf(dst);
      assert.equal(job?.status, 'pending', `the moved row's job at the destination is ${JSON.stringify(job)}: the deleted file's failed job was left there, so the moved file is never embedded`);
      assert.equal(job?.attempts, 0, 'the moved row inherited the deleted file\'s spent attempts');
    });

    it('(f) an NFD-named file (cache key the on-disk spelling, row id NFC): its cache entry follows a move of its directory', async () => {
      const nfd = 'café.txt';
      const nfc = nfd.normalize('NFC');
      assert.notEqual(nfd, nfc, 'fixture: the two spellings are one');
      const abs = path.join(acts.root(), 'nfd-dir', nfd);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'bytes placed by something that spells names in NFD');
      assert.equal(fs.readdirSync(path.dirname(abs))[0], nfd, 'fixture: this file system does not keep an NFD name as written (premise P2): the test asks nothing here');
      await door.coll(S, 'files').insertOne(fileRow(`nfd-dir/${nfc}`, 'bytes placed by something that spells names in NFD'));
      const st = fs.statSync(abs);
      await hashes().insertOne({ _id: `nfd-dir/${nfd}`, size: st.size, mtimeMs: st.mtimeMs, sha256: sentinelSha('nfd'), plainSize: st.size });

      const a = await acts.move('REST', 'nfd-dir', 'nfd-moved');
      assert.ok(!acts.failed(a), `move: ${JSON.stringify(a.body ?? a.text)}`);
      assert.ok(fs.existsSync(path.join(acts.root(), 'nfd-moved', nfd)), 'fixture: the bytes did not move');

      const old = (await hashes().find({}).toArray()).map(d => d._id).filter(k => k.startsWith('nfd-dir/'));
      assert.deepEqual(old, [], 'the cache entry at the old NFD spelling was left: carry and forget reached only the NFC row id');
      assert.equal((await cacheAt(`nfd-moved/${nfd}`))?.sha256, sentinelSha('nfd'), 'the cache entry did not follow the file under the spelling the manifest keys it by');
      assert.equal((await manifestNow()).get(`nfd-moved/${nfd}`), sentinelSha('nfd'), 'the next manifest re-read the moved bytes instead of reusing the carried entry');
    });

    it('(f) the store failing after the commit: the move finishes, is not owed, and the failure is said once', async () => {
      timing.setMoveTimingForTest({ txnBytes: 1 });
      for (const n of ['a', 'b', 'c']) await acts.seed(`late/${n}.txt`);
      const proto = Object.getPrototypeOf(door.mongo.col('probe'));
      const original = proto.bulkWrite;
      let fired = 0;
      proto.bulkWrite = async function failing(...args) {
        if (this.collectionName === `${S}_embed_jobs`) { fired++; throw new Error('the store failed after the commit'); }
        return original.apply(this, args);
      };
      let a;
      let lines;
      try {
        ({ lines, result: a } = await logLinesDuring(() => acts.move('REST', 'late', 'late-moved')));
      } finally { proto.bulkWrite = original; }
      assert.ok(fired >= 1, 'the store was never asked to queue the moved rows after the commit: the move re-queues nothing');
      assert.ok(!acts.failed(a), `a failure after the commit failed the move: ${JSON.stringify(a.body ?? a.text)}`);
      for (const n of ['a', 'b', 'c']) assert.ok(await rowOf(`late-moved/${n}.txt`), `${n}: the record did not reach the destination`);
      assert.equal(await (await import('../../server/dist/files/move-markers.js')).moveIsOwed(S, 'late', 'late-moved'), false, 'the move was left owed over a best-effort step after its commit');
      const said = lines.filter(l => /embed/i.test(l) && l.includes(S));
      assert.equal(said.length, 1, `the failure after the commit was said ${said.length} times, not once: ${JSON.stringify(said)}`);
    });
  });
});
