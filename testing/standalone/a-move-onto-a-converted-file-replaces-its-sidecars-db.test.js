/**
 * A move onto a converted file replaces that file's sidecars with the moved file's, and finishes (bundle-44, preship).
 *
 * ## The defect
 *
 * A move carries a file's sidecar bytes after the file: `_converted/<src>.md` and the tree `_extracted/<src>/` are renamed to the
 * destination's. When the destination was itself a converted file, `_extracted/<dst>/` already existed and was not empty, and renaming
 * a directory onto a non-empty directory fails (`ENOTEMPTY`). The cascade then read a sidecar that could not move as "the move is not
 * finished" (`MoveStillOwed`) and said so on every retry, until housekeeping stranded the move: a rename onto a converted file with
 * extracted images could never complete. Before the cascade kept a failed sidecar owed, the failure was logged and the move finished.
 *
 * The destination's sidecars belong to the file the move REPLACES, so what is under them is replaced by the moved file's, and
 * the move finishes.
 *
 * ## What is asserted, on every door that reaches the move
 *
 * - The move onto a destination that has a converted Markdown and an extracted-images tree answers success, not `503`.
 * - The destination's sidecar paths hold the MOVED file's bytes; nothing is left at the source's; what the replaced file had extracted
 *   and the moved file did not is not left behind under the destination's tree.
 * - The records of the sidecars (the converted row, the extracted image's row) are the moved file's, at the destination.
 * - No marker is left: the move is finished and nothing is owed.
 * - A sidecar path that is NOT the destination's (a directory `<dst>.md/` beside a file `<dst>` owns `_converted/<dst>.md/`) is not
 *   removed on the destination's behalf.
 *
 * Run: node --test testing/standalone/a-move-onto-a-converted-file-replaces-its-sidecars-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'sidecarreplace';
const T0 = '2026-09-01T00:00:00.000Z';

let acts, tombstones;

const read = (p) => fs.readFileSync(path.join(acts.root(), p), 'utf8');
const row = (id) => acts.door.coll(S, 'files').findOne({ _id: id });

/** A converted file as a conversion leaves it: the original, its converted Markdown and an extracted image, each with its record. */
async function convertedFile(p, { extra = [] } = {}) {
  await acts.files.writeFile(S, p, `original of ${p}`);
  await acts.files.writeFile(S, `_converted/${p}.md`, `converted markdown of ${p}`);
  await acts.files.writeFile(S, `_extracted/${p}/x.jpg`, `image of ${p}`);
  for (const name of extra) await acts.files.writeFile(S, `_extracted/${p}/${name}`, `${name} of ${p}`);
  const derived = (id, extraFields = {}) => ({ _id: id, spaceId: S, path: id, parentFileId: p, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, ...extraFields });
  await acts.door.coll(S, 'files').insertMany([
    { _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0 },
    derived(`${p}#chunk-0`, { chunkIndex: 0, content: `a chunk of ${p}` }), derived(`_converted/${p}.md`), derived(`_extracted/${p}/x.jpg`),
  ]);
}

describe('a move onto a converted file replaces its sidecars and finishes', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'sidecarreplace', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  for (const via of ['REST', 'TOOL', 'MCP']) {
    it(`${via}: the destination's extracted tree and converted Markdown are replaced by the moved file's, and the move finishes`, async () => {
      await convertedFile('src.pdf');
      // The destination has an image the moved file does not: it belongs to the file being replaced.
      await convertedFile('dst.pdf', { extra: ['only-dst.jpg'] });

      const a = await acts.move(via, 'src.pdf', 'dst.pdf');
      assert.ok(!acts.failed(a), `the move onto a converted file was refused or left owed (${acts.statusOf(a)}): ${JSON.stringify(a.body ?? a.text)}`);

      assert.equal(read('dst.pdf'), 'original of src.pdf', 'the destination does not hold the moved file');
      assert.equal(read('_converted/dst.pdf.md'), 'converted markdown of src.pdf', 'the destination\'s converted Markdown is not the moved file\'s');
      assert.equal(read('_extracted/dst.pdf/x.jpg'), 'image of src.pdf', 'the destination\'s extracted image is not the moved file\'s');
      assert.equal(acts.onDisk('_extracted/dst.pdf/only-dst.jpg'), false, 'an image of the replaced file was left under the moved file\'s extracted tree');
      for (const gone of ['src.pdf', '_converted/src.pdf.md', '_extracted/src.pdf']) assert.equal(acts.onDisk(gone), false, `${gone} is still at the source`);

      assert.ok(await row('dst.pdf') && await row('_converted/dst.pdf.md') && await row('_extracted/dst.pdf/x.jpg'), 'a record did not reach the destination');
      for (const id of ['src.pdf', 'src.pdf#chunk-0', '_converted/src.pdf.md', '_extracted/src.pdf/x.jpg']) assert.equal(await row(id), null, `the record ${id} is still at the source`);
      assert.equal((await row('dst.pdf#chunk-0')).content, 'a chunk of src.pdf', 'the destination\'s chunk is not the moved file\'s');
      assert.equal((await tombstones.moveMarkerOf(S, 'src.pdf', 'dst.pdf')) !== undefined, false, 'the finished move left its marker: it is still owed');
    });
  }

  it('a converted file moved onto a file with no sidecars still finishes (the control: nothing stands where the sidecars go)', async () => {
    await convertedFile('src.pdf');
    await acts.seed('plain.pdf');
    const a = await acts.move('REST', 'src.pdf', 'plain.pdf');
    assert.ok(!acts.failed(a), `the move was refused (${acts.statusOf(a)}): ${JSON.stringify(a.body)}`);
    assert.equal(read('_extracted/plain.pdf/x.jpg'), 'image of src.pdf');
    assert.equal((await tombstones.moveMarkerOf(S, 'src.pdf', 'plain.pdf')) !== undefined, false);
  });

  it('a destination file with sidecars is left alone when the moved file has none (nothing is renamed onto them)', async () => {
    await acts.seed('bare.pdf');
    await convertedFile('dst.pdf');
    const a = await acts.move('REST', 'bare.pdf', 'dst.pdf');
    assert.ok(!acts.failed(a), `the move was refused (${acts.statusOf(a)}): ${JSON.stringify(a.body)}`);
    assert.equal(read('_converted/dst.pdf.md'), 'converted markdown of dst.pdf', 'a move that carries no sidecar removed the destination\'s');
  });

  it('a directory that stands where the destination\'s converted Markdown would go is not the destination\'s, and is not removed', async () => {
    // `_converted/g.md/` is the converted TREE of the directory `g.md`, which is exactly where the converted Markdown of a file `g` goes.
    await convertedFile('src.pdf');
    await acts.seed('g');
    await acts.seed('g.md/inner.txt');
    await acts.files.writeFile(S, '_converted/g.md/inner.txt.md', 'converted tree of the directory g.md');
    await acts.move('REST', 'src.pdf', 'g');
    assert.equal(read('_converted/g.md/inner.txt.md'), 'converted tree of the directory g.md', 'the move removed another path\'s converted tree');
  });
});
