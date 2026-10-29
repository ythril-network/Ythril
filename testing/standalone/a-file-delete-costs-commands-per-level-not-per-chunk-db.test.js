/**
 * A file's delete costs a store command per LEVEL of what it left, not per chunk, and takes a peer's arrived sidecar rows in one write
 * (bundle-88, Q-412).
 *
 * ## The defect
 *
 * `deleteRowsDerivedFrom` ran `deleteMany({ parentFileId: { $in } })` per 500 ids over every id the walk (`rowsDerivedFrom`) reached,
 * leaves included: a document of 1 200 chunks and a converted sidecar of 600 more were four commands and grew with the chunks. And the
 * rows an ARRIVED sidecar made (top-level rows, no `parentFileId`: a peer that never converted delivers its sidecars as ordinary files)
 * were retired one write per row.
 *
 * ## The rule this file states
 *
 * The delete runs over the PARENTS the walk found (the ids that have children), so its commands do not depend on how many chunks a
 * parent holds, and arrived sidecar rows are retired in one write per chunk of ids (`retireFileMetaMany`), flagged or removed
 * (`softDeleteFileMeta`), however many there are.
 *
 * ## Seen red
 *
 * On the base (1e430410c): the large document issues more `delete` commands than the small one, and 50 arrived sidecar rows cost 45
 * more writes than 5 in both settings.
 *
 * Run: node --test testing/standalone/a-file-delete-costs-commands-per-level-not-per-chunk-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'delcmds';
const FILES = `${S}_files`;
const T0 = '2026-09-01T00:00:00.000Z';

let acts, loader;

const chunkRows = (parent, n) => Array.from({ length: n }, (_, i) => ({ _id: `${parent}#chunk${i}`, spaceId: S, path: `${parent}#chunk${i}`, parentFileId: parent,
  sizeBytes: 1, tags: [], createdAt: T0, updatedAt: T0 }));
const sidecarRow = (id, parent) => ({ _id: id, spaceId: S, path: id, parentFileId: parent, sizeBytes: 1, tags: [], createdAt: T0, updatedAt: T0 });
const rows = () => acts.door.coll(S, 'files').find({}, { projection: { _id: 1, deletedAt: 1 } }).toArray();

/** A document with `n` chunks and a converted sidecar with `m`: the rows a conversion leaves. */
async function seedConverted(n, m) {
  await acts.seed('doc.txt');
  await acts.door.coll(S, 'files').insertMany([
    ...chunkRows('doc.txt', n),
    sidecarRow('_converted/doc.txt.md', 'doc.txt'),
    ...chunkRows('_converted/doc.txt.md', m),
  ]);
}

const filesCommands = (commands, name) => commands.filter(c => c === `${name} ${FILES}`).length;

describe('a file delete costs commands per level, not per chunk', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'delcmds', space: S, monitorCommands: true });
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => { loader.getConfig().softDeleteFileMeta = false; await acts?.close(); });
  beforeEach(async () => { loader.getConfig().softDeleteFileMeta = false; await acts.reset(); });

  it('a document of 1 200 chunks with a sidecar of 600 deletes in the commands a document of 10 does', async () => {
    const counts = {};
    for (const [n, m] of [[10, 5], [1_200, 600]]) {
      await acts.reset();
      await seedConverted(n, m);
      const commands = await acts.door.commandsDuring(async () => {
        const del = await acts.del('REST', 'doc.txt');
        assert.ok(!acts.failed(del), `the delete was refused: ${JSON.stringify(del.body ?? del.text)}`);
      });
      assert.deepEqual((await rows()).map(r => r._id), [], `rows of the ${n}-chunk document survived its delete`);
      counts[n] = filesCommands(commands, 'delete');
    }
    assert.equal(counts[1_200], counts[10],
      `deleting 1 200 chunks issued ${counts[1_200]} delete commands on the files, 10 chunks issued ${counts[10]}: the cost follows the chunks`);
  });

  for (const soft of [false, true]) {
    it(`arrived sidecar rows (no parent) are retired in one write, whatever their number (softDeleteFileMeta: ${soft})`, async () => {
      const counts = {};
      for (const n of [5, 50]) {
        await acts.reset();
        loader.getConfig().softDeleteFileMeta = soft;
        await acts.seed('doc.txt');
        await acts.door.coll(S, 'files').insertMany(Array.from({ length: n }, (_, i) => ({ _id: `_extracted/doc.txt/p${i}.txt`, spaceId: S,
          path: `_extracted/doc.txt/p${i}.txt`, sizeBytes: 1, tags: [], createdAt: T0, updatedAt: T0 })));
        const commands = await acts.door.commandsDuring(async () => {
          const del = await acts.del('REST', 'doc.txt');
          assert.ok(!acts.failed(del), `the delete was refused: ${JSON.stringify(del.body ?? del.text)}`);
        });
        const left = await rows();
        const arrived = left.filter(r => r._id.startsWith('_extracted/'));
        if (soft) assert.ok(arrived.every(r => typeof r.deletedAt === 'string') && arrived.length === n, `soft: ${n} arrived rows should all be flagged, found ${JSON.stringify(arrived)}`);
        else assert.deepEqual(arrived, [], `hard: the ${n} arrived sidecar rows survived`);
        counts[n] = filesCommands(commands, 'update') + filesCommands(commands, 'delete');
      }
      assert.equal(counts[50], counts[5], `retiring 50 arrived sidecar rows cost ${counts[50]} writes, 5 cost ${counts[5]}: one write per row`);
    });
  }
});
