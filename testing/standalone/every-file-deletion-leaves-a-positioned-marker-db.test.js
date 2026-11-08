/**
 * Every act that takes a file out of view leaves a row at the path, carrying a position, so the change feed can say "deleted"
 * (bundle-255; plan `design-final.md` items 1 and 2, vet-returns challenge 1 and 3, vet-privacy).
 *
 * ## The defect it prevents
 *
 * A deletion that leaves nothing at the path cannot be paged: a feed that reads `files` by position never hears of it. The first design
 * hooked only the hard deletes; under `softDeleteFileMeta` the deletions go through the flag and the feed would have missed them, and
 * a move's source, a legacy re-key and a sidecar's retirement each remove a row by another road. The retirement and its position are
 * ONE write: the row itself is the deletion marker.
 *
 * ## The rule
 *
 * For every ACT that retires a file row (derived from the callers of `retireFileMeta`, `retireFileMetaMany` and `retireFileMetaUnder`,
 * plus a move's source and a legacy re-key, which remove a row without them):
 *
 *  1. with soft delete OFF the path holds a FEED MARKER: exactly `{ _id, spaceId, path, deletedAt, feedMarker: true, pos, posAtSeq }`,
 *     nothing a person wrote (no tags, description, author, properties), its `pos` above everything stamped before the act;
 *  2. with soft delete ON the row is flagged as today (`deletedAt`) and takes a position above everything before it, keeping its
 *     `seq` (`posAtSeq` equals it): the flag is a position-taking write, not a version;
 *  3. a write to a path holding a marker starts CLEAN: an upload or a byte arrival there makes a live row with none of the marker's
 *     fields and none of the deleted file's;
 *  4. a marker is never pushed and never pulled: the peer door `GET /api/sync/filemeta` does not serve it and the family's push filter
 *     rejects it (a deletion reaches a peer as the file tombstone only).
 *
 * ## The set is derived
 *
 * `callers()` reads the server source for every file that calls a retire function (outside `file-meta.ts`, which defines them); each must
 * be named by an act row below, and the floor says the derivation found them. A new caller without an act fails the coverage case, and an
 * act row names the act that drives it, so a new way to delete a file cannot arrive unmarked.
 *
 * Database `ythril_harness_fmarkers`.
 *
 * Red on d9e2738d: a hard delete leaves no row, a soft one leaves a flagged row with no position.
 *
 * Run: node --test testing/standalone/every-file-deletion-leaves-a-positioned-marker-db.test.js
 * (requires the harness Mongo and a prior `npm run build -w server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFeedDoors } from './_file-change-feed.mjs';
import { stripComments } from './_strip-comments.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

const skip = await mongoSkipReason();
const S = 'fmarkers';
const PEER = Object.freeze({ instanceId: 'marker-peer', instanceLabel: 'Marker peer' });
const MARKER_KEYS = Object.freeze(['_id', 'deletedAt', 'feedMarker', 'path', 'pos', 'posAtSeq', 'spaceId']);
const LEGACY = 'Café/legacy.txt';   // decomposed: the stored spelling of an old row
const KEY = LEGACY.normalize('NFC');
const LONG_PAST = new Date('2026-01-01T00:00:00.000Z');

/** The files that call a retire function, outside the module that defines them. Derived from the source. */
function callers() {
  const out = [];
  for (const file of trackedSources(['server/src'], { ext: ['.ts'], floor: 50 })) {
    if (file.replaceAll('\\', '/') === 'server/src/files/file-meta.ts') continue;
    const src = stripComments(fs.readFileSync(join(REPO_ROOT, file), 'utf8'));
    if (/\bretireFileMeta(Many|Under)?\(/.test(src)) out.push(file.replaceAll('\\', '/'));
  }
  return out.sort();
}

let d, meta, files, cascade, remover, spelling, rekey, ttl, mover, loader;
const rows = () => d.door.coll(S, 'files');
const rowOf = (id) => rows().findOne({ _id: id });

/** A live file with bytes and a row an author wrote (tags and a description a deletion must not leave behind). */
async function seed(p, extra = {}) {
  await files.writeFile(S, p, `content of ${p}`);
  await meta.upsertFileMeta(S, p, 20, { tags: ['secret-tag'], description: 'a private description', ...extra });
}

/** The highest position any file row of the space holds. */
async function head() {
  const top = await rows().find({ pos: { $type: 'number' } }).sort({ pos: -1 }).limit(1).next();
  return top?.pos ?? 0;
}

/**
 * The acts. `callers` names the retire callers an act drives (the coverage case needs every derived one named); `seed` makes the
 * rows; `marked` are the paths that must hold a marker afterwards; `run` is the act through its real function.
 */
const ACTS = () => [
  { name: 'a delete of one file', callers: ['server/src/files/delete-cascade.ts'],
    seed: () => seed('one/a.txt'), marked: ['one/a.txt'], run: () => cascade.deleteFileCascade(S, 'one/a.txt') },
  { name: 'a delete of a folder', callers: ['server/src/files/delete-cascade.ts'],
    seed: async () => { await seed('dir/a.txt'); await seed('dir/sub/b.txt'); }, marked: ['dir/a.txt', 'dir/sub/b.txt'],
    run: () => cascade.deleteDirectoryCascade(S, 'dir') },
  { name: 'a peer\'s deletion applied here', callers: ['server/src/files/remove-file-here.ts'],
    seed: () => seed('peer/a.txt'), marked: ['peer/a.txt'], run: () => remover.removeFileHere(S, 'peer/a.txt', { failure: 'throw' }) },
  { name: 'a peer\'s deletion of a spelling whose bytes another record stands on', callers: ['server/src/files/another-spelling-of-the-entry.ts'],
    seed: () => seed('spell/a.txt'), marked: ['spell/a.txt'], run: () => spelling.removeOnlyTheRecordNamed(S, 'spell/a.txt') },
  { name: 'a sidecar row an arrival made, retired with its file', callers: ['server/src/files/converters/pipeline.ts'],
    seed: async () => { await seed('sc/x.pdf'); await meta.upsertFileMeta(S, '_converted/sc/x.pdf.md', 5); },
    marked: ['sc/x.pdf', '_converted/sc/x.pdf.md'], run: () => cascade.deleteFileCascade(S, 'sc/x.pdf') },
  { name: 'the TTL sweep', callers: [],
    seed: async () => { await seed('ttl/a.txt'); await rows().updateOne({ _id: 'ttl/a.txt' }, { $set: { _expireAt: LONG_PAST } }); },
    marked: ['ttl/a.txt'], run: () => ttl.sweepExpired(new Date()) },
  { name: 'a move (the source path)', callers: [], moveLike: true,
    seed: () => seed('mv/src.txt'), marked: ['mv/src.txt'], live: ['mv/dst.txt'], run: () => mover.moveFileCascade(S, 'mv/src.txt', 'mv/dst.txt') },
  { name: 'a legacy re-key (the old spelling)', callers: [], moveLike: true,
    seed: async () => {
      const seq = (await rows().find({}).sort({ seq: -1 }).limit(1).next())?.seq ?? 0;
      await files.writeFile(S, KEY, 'legacy bytes');
      await rows().insertOne({ _id: LEGACY, spaceId: S, path: LEGACY, tags: ['secret-tag'], description: 'a private description', author: PEER,
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: seq + 1, pos: seq + 1, posAtSeq: seq + 1, sizeBytes: 12 });
    },
    marked: [LEGACY], live: [KEY], run: () => rekey.rekeyLegacy(S, KEY, [LEGACY]) },
];

describe('every act that takes a file out of view leaves a positioned marker (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openFeedDoors({ suite: 'fmarkers', spaces: [S] });
    loader = d.loader;
    meta = await import('../../server/dist/files/file-meta.js');
    files = await import('../../server/dist/files/files.js');
    cascade = await import('../../server/dist/files/delete-cascade.js');
    remover = await import('../../server/dist/files/remove-file-here.js');
    spelling = await import('../../server/dist/files/another-spelling-of-the-entry.js');
    rekey = await import('../../server/dist/files/legacy-file-rekey.js');
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    mover = await import('../../server/dist/files/move-cascade.js');
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => {
    for (const part of ['files', 'file_tombstones']) await d.door.coll(S, part).deleteMany({});
    fs.rmSync(join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true });
  });
  afterEach(() => { loader.getConfig().softDeleteFileMeta = false; });

  it('the derivation finds the callers of the retire functions, so an empty set cannot pass', () => {
    assert.ok(callers().length >= 4, `only ${callers().length} caller(s) derived: ${JSON.stringify(callers())}`);
  });

  it('every derived caller is driven by an act row here', () => {
    const named = new Set(ACTS().flatMap(a => a.callers));
    const missing = callers().filter(f => !named.has(f));
    assert.deepEqual(missing, [], 'a file that retires file rows has no act row: its deletions are not proven to leave a marker');
  });

  for (const act of ACTS()) {
    for (const soft of [false, true]) {
      it(`${act.name}, soft delete ${soft ? 'on' : 'off'}: ${soft ? 'the flagged row takes a position and keeps its version' : 'the path holds a feed marker and nothing the author wrote'}`, async () => {
        loader.getConfig().softDeleteFileMeta = soft;
        await act.seed();
        const before = await head();
        assert.ok(before > 0, 'fixture: the seeded rows carry no position');
        const versions = Object.fromEntries(await Promise.all(act.marked.map(async id => [id, (await rowOf(id))?.seq])));
        await act.run();
        for (const id of act.marked) {
          const row = await rowOf(id);
          assert.ok(row, `${id}: nothing is left at the path, so the feed cannot say it was deleted`);
          assert.equal(typeof row.deletedAt, 'string', `${id}: the row is not marked deleted: ${JSON.stringify(row)}`);
          assert.equal(typeof row.pos, 'number', `${id}: the deletion took no position: ${JSON.stringify(row)}`);
          assert.ok(row.pos > before, `${id}: its position ${row.pos} is not above everything stamped before the act (${before}), so a client past it would never hear`);
          if (soft && !act.moveLike) {
            assert.equal(row.seq, versions[id], `${id}: the flag changed the version: a deletion is a local position, not an edit`);
            assert.equal(row.posAtSeq, row.seq, `${id}: posAtSeq ${row.posAtSeq} is not the version ${row.seq} the position was taken for`);
          }
          if (!soft) {
            assert.deepEqual(Object.keys(row).sort(), [...MARKER_KEYS],
              `${id}: with soft delete off the marker holds only ${JSON.stringify(MARKER_KEYS)}: ${JSON.stringify(row)}`);
            assert.equal(row.feedMarker, true);
            assert.equal(row.spaceId, S);
            assert.equal(row.path, id);
            assert.equal(typeof row.posAtSeq, 'number');
          }
        }
        for (const id of act.live ?? []) assert.ok(await rowOf(id), `${id}: the act's live side is missing`);
      });
    }
  }

  it('a write to a path holding a marker starts clean: an upload and a byte arrival there carry nothing of the marker or the deleted file', async () => {
    loader.getConfig().softDeleteFileMeta = false;
    for (const how of ['upload', 'arrival']) {
      const p = `clean/${how}.txt`;
      await seed(p);
      await cascade.deleteFileCascade(S, p);
      const marker = await rowOf(p);
      assert.equal(marker?.feedMarker, true, `fixture: the delete left no feed marker at ${p}: ${JSON.stringify(marker)}`);
      if (how === 'upload') await meta.upsertFileMeta(S, p, 7, { tags: ['new'] });
      else await meta.recordArrivedFile(S, p, 40, 'c'.repeat(64), PEER);
      const row = await rowOf(p);
      assert.ok(row, `${how}: no row after the write`);
      assert.equal(row.feedMarker, undefined, `${how}: the live row is still a marker`);
      assert.equal(row.deletedAt, undefined, `${how}: the live row still says deleted`);
      assert.equal(row.description, undefined, `${how}: the live row carries the deleted file's description`);
      assert.deepEqual(row.tags, how === 'upload' ? ['new'] : [], `${how}: the live row carries the deleted file's tags`);
      assert.equal(row.sizeBytes, how === 'upload' ? 7 : 40);
    }
  });

  it('a marker is never pulled by a peer and never passes the push filter; a live control is and does', async () => {
    loader.getConfig().softDeleteFileMeta = false;
    await seed('gone/a.txt');
    await seed('kept/b.txt');
    await cascade.deleteFileCascade(S, 'gone/a.txt');
    const marker = await rowOf('gone/a.txt');
    assert.equal(marker?.feedMarker, true, `fixture: the delete left no feed marker: ${JSON.stringify(marker)}`);
    const pulled = await d.door.pull('/filemeta', { spaceId: S, afterPos: '0' });
    const ids = Object.values(pulled ?? {}).flat().filter(x => x && typeof x === 'object').map(x => x._id);
    assert.ok(ids.includes('kept/b.txt'), `control: the live file is not served to a peer: ${JSON.stringify(pulled)}`);
    assert.ok(!ids.includes('gone/a.txt'), 'the peer door served a feed marker: a deletion reaches a peer as the file tombstone only');
    const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
    const family = REPLICATED_FAMILIES.find(f => f.collection === 'files');
    assert.ok(family?.pushFilter, 'the files family has no push filter');
    assert.equal(await rows().countDocuments({ ...family.pushFilter, _id: 'gone/a.txt' }), 0, 'the push filter lets a feed marker through');
    assert.equal(await rows().countDocuments({ ...family.pushFilter, _id: 'kept/b.txt' }), 1, 'control: the push filter drops a live file');
  });
});
