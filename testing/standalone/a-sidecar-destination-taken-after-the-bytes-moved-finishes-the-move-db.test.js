/**
 * A sidecar destination that something took AFTER the file's bytes moved does not keep the move owed for ever: the move finishes,
 * the occupant is untouched, and the file says it has no converted copy (bundle-113, Q-467; vet rulings reliability S12 / data S10,
 * observability S1, perf-ux U-S15, T-S15).
 *
 * ## The defect it prevents
 *
 * A move carries the bytes first and the records after, and its sidecars (`_converted/<path>.md`, the tree under `_extracted/`)
 * are placed between the two. The destination of a sidecar is checked free BEFORE the bytes move; something that lands there in
 * the window after (a conversion of an unrelated file whose name collides, a peer's arrival, an operator) used to make the sidecar's
 * placement fail, and ANY failed sidecar keeps the move owed: its marker stays, housekeeping retries it eight times and strands it,
 * and every retry meets the same occupant. Nothing a person can do finishes it but deleting the occupant, which is not theirs to
 * lose — and the move's records never carry, so the file is listed at the old path for ever.
 *
 * ## The rule
 *
 * **Occupied**, told from every other failure by the answer class `DestinationExists` alone, finishes the move:
 *  1. the move answers success, on every door (REST, `POST /api/<tool>`, MCP);
 *  2. the occupant is byte-identical afterwards — a sidecar never replaces what it finds;
 *  3. the moved file's own sidecar bytes at the SOURCE are removed: nothing else can ever move them, and left they are debris;
 *  4. the records are carried: the file row at the new id (its description with it), the rows derived from it, none at the old id;
 *  5. the row does NOT carry `convertedFileId`: it would point the extract view at the occupant's text instead of the file's own;
 *  6. nothing is owed: no marker, no pending tombstone, and `moveIsOwed` says no;
 *  7. it is SAID once and counted: `ythril_file_moves_finished_without_sidecar_total` moves by one, and one log line names it.
 * **Any other failure keeps the move owed** — a sidecar that fails with EIO (the existing pin in
 * `a-file-tombstone-is-published-after-its-own-bytes-db`) is the CONTROL here: counter unmoved, the stale sidecar still at the source.
 *
 * The same holds for a directory move's sidecar TREE, and a conversion that runs afterwards (a job the move held and released)
 * fails rather than writing into the occupied path: the occupant is still byte-identical afterwards, and a conversion of a file whose
 * converted copy IS its own (a row derived from it) still rewrites it (the control that the rule is about foreign occupants).
 *
 * ## The seam
 *
 * `setMoveStepsForTest({ beforeLink })` runs under the move's locks after a destination was classified free and before its bytes
 * are placed. Keyed on a `_converted` destination (T-S15): the file's own placement is left alone, and the occupant lands at the
 * sidecar's destination in exactly the window the plan names.
 *
 * Run: node --test testing/standalone/a-sidecar-destination-taken-after-the-bytes-moved-finishes-the-move-db.test.js
 * (requires a prior `npm run build:server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { MOVE_DOORS, sentenceOf } from './_move-destination.mjs';
import { seedClaim } from './_media-claim.mjs';
import { METRICS, metricValue } from './_leaked-rows-repair.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'sidecartaken';
const OCCUPANT = 'THE OCCUPANT: another file\'s converted text';

let acts, stored, tombstones, pipeline;
const files = () => acts.door.coll(S, 'files');
const abs = (p) => path.join(acts.root(), p);
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const isSidecarDestination = (dstAbs) => dstAbs.split(path.sep).join('/').split('/').includes('_converted');

/** The seam, or the plain failure that it does not exist — so a build without it fails these cases with the reason and not with a TypeError. */
function seam(steps) {
  assert.equal(typeof stored.setMoveStepsForTest, 'function', 'files/stored-bytes.ts exports no setMoveStepsForTest: the placing of a move\'s bytes has no seam');
  stored.setMoveStepsForTest(steps);
}
/** Something takes the sidecar's destination after it was classified free: a file, or — for a tree — a non-empty directory. */
const takenAtTheSidecar = () => seam({
  beforeLink: (_srcAbs, dstAbs) => {
    if (!isSidecarDestination(dstAbs)) return;
    if (fs.existsSync(dstAbs)) return;
    if (fs.statSync(path.dirname(dstAbs), { throwIfNoEntry: false })) fs.writeFileSync(dstAbs, OCCUPANT);
  },
});

/** A file with its row (carrying the pointer to its converted copy), the converted copy's bytes, and a chunk row derived from it. */
async function seedConverted(name, description = 'A') {
  await acts.seed(name, { description, convertedFileId: `_converted/${name}.md`, chunkCount: 1 });
  await acts.files.writeFile(S, `_converted/${name}.md`, `# converted text of ${name}`);
  await files().insertOne({ _id: `${name}#chunk0`, spaceId: S, path: `${name}#chunk0`, tags: [], sizeBytes: 5, content: 'chunk', parentFileId: name,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' });
}
const finishedWithoutSidecar = () => metricValue(METRICS.movesWithoutSidecar);
/** The counter as it reads, or 0 while it is not declared: the reading taken BEFORE the move (so a build without the counter fails on what the move did, not on a missing series), and the control that a failure that is not an occupant counts nothing. The reading AFTER a finished move is strict. */
const finishedWithoutSidecarOrZero = () => finishedWithoutSidecar().catch(() => 0);

describe('a sidecar destination taken after the bytes moved finishes the move (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'sidecartaken', space: S });
    stored = await import('../../server/dist/files/stored-bytes.js');
    tombstones = await import('../../server/dist/files/tombstones.js');
    pipeline = await import('../../server/dist/files/converters/pipeline.js');
  });
  after(async () => { stored?.setMoveStepsForTest?.(null); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });
  afterEach(() => { stored?.setMoveStepsForTest?.(null); });

  MOVE_DOORS.forEach((via, i) => {
    const [a, b] = [`m${i}-a.txt`, `m${i}-b.txt`];
    it(`${via}: the move finishes, the occupant is untouched, the stale sidecar is gone, the records are carried and it is counted`, async () => {
      await seedConverted(a);
      takenAtTheSidecar();
      const counted = await finishedWithoutSidecarOrZero();

      const { lines, result: answer } = await logLinesDuring(() => acts.move(via, a, b));

      assert.equal(acts.statusOf(answer), 200, `the move was answered ${acts.statusOf(answer)}: ${sentenceOf(answer)}`);
      assert.equal(read(`_converted/${b}.md`), OCCUPANT, 'the occupant of the sidecar destination was replaced or changed');
      assert.equal(acts.onDisk(`_converted/${a}.md`), false, 'the moved file\'s own sidecar bytes are still at the source: nothing can ever move them now');
      assert.equal(read(b), `content of ${a}`, 'the file itself did not move');
      assert.equal(acts.onDisk(a), false);

      const row = await files().findOne({ _id: b });
      assert.equal(row?.description, 'A', 'the file\'s record was not carried to the new id');
      assert.equal(await files().findOne({ _id: a }), null, 'a record stayed at the old id');
      assert.equal((await files().findOne({ _id: `${b}#chunk0` }))?.parentFileId, b, 'the rows derived from the file were not carried');
      assert.equal(await files().findOne({ _id: `${a}#chunk0` }), null);
      assert.equal(row && 'convertedFileId' in row, false, 'the moved row still points at a converted copy: the extract view would show the occupant\'s text as the file\'s own');

      assert.equal(await tombstones.moveIsOwed(S, a, b), false, 'the move is still owed');
      assert.deepEqual((await acts.raw()).filter(t => t.pending || t.move), [], 'a marker or a pending tombstone was left by a move that finished');
      assert.equal(await finishedWithoutSidecar(), counted + 1, 'the move that finished without its sidecar was not counted exactly once');
      const said = lines.filter(l => l.includes(b) && /sidecar/i.test(l));
      assert.equal(said.length, 1, `the move was said ${said.length} times, not once: ${lines.join(' | ')}`);
      assert.equal(lines.some(l => /\bowed\b/i.test(l) && l.includes(b)), false, 'the move was reported as owed');
    });
  });

  it('a directory move whose sidecar TREE destination was taken finishes the same way', async () => {
    await acts.seed('d1/f.txt', { description: 'F', convertedFileId: '_converted/d1/f.txt.md' });
    await acts.files.writeFile(S, '_converted/d1/f.txt.md', '# converted f');
    seam({ beforeLink: (_srcAbs, dstAbs) => {
      if (!isSidecarDestination(dstAbs) || fs.existsSync(dstAbs)) return;
      fs.mkdirSync(dstAbs, { recursive: true });
      fs.writeFileSync(path.join(dstAbs, 'x.md'), OCCUPANT);
    } });
    const counted = await finishedWithoutSidecarOrZero();

    const answer = await acts.move('REST', 'd1', 'd2');

    assert.equal(acts.statusOf(answer), 200, `the move was answered ${acts.statusOf(answer)}: ${sentenceOf(answer)}`);
    assert.equal(read('_converted/d2/x.md'), OCCUPANT, 'the occupant tree was changed');
    assert.equal(acts.onDisk('_converted/d1'), false, 'the moved directory\'s own sidecar tree is still at the source');
    assert.equal(read('d2/f.txt'), 'content of d1/f.txt');
    const row = await files().findOne({ _id: 'd2/f.txt' });
    assert.equal(row?.description, 'F', 'the records were not carried');
    assert.equal(row && 'convertedFileId' in row, false, 'the moved row still points at a converted copy that is the occupant\'s');
    assert.equal(await tombstones.moveIsOwed(S, 'd1', 'd2'), false);
    assert.equal(await finishedWithoutSidecar(), counted + 1);
  });

  it('CONTROL: a sidecar that fails with EIO still keeps the move owed, counts nothing and keeps the stale sidecar where it is', async () => {
    await seedConverted('eio-a.txt');
    seam({ link: async (src, dst) => {
      if (isSidecarDestination(dst)) throw Object.assign(new Error(`EIO: i/o error, link '${src}' -> '${dst}'`), { code: 'EIO' });
      await fsp.link(src, dst);
    } });
    const counted = await finishedWithoutSidecarOrZero();

    const answer = await acts.move('REST', 'eio-a.txt', 'eio-b.txt');

    assert.equal(acts.statusOf(answer), 503, `the move: ${sentenceOf(answer)}`);
    assert.equal(acts.answerOf(answer).code, 'move_still_owed', 'a sidecar that failed for a reason other than an occupant was read as one');
    assert.ok(acts.onDisk('_converted/eio-a.txt.md'), 'the sidecar was removed although it was not an occupant that stopped it');
    assert.equal(await tombstones.moveIsOwed(S, 'eio-a.txt', 'eio-b.txt'), true, 'the move is not owed after a failure that is not an occupied destination');
    assert.equal(await finishedWithoutSidecarOrZero(), counted, 'a failed sidecar was counted as a move finished without one');
  });

  it('a conversion that runs afterwards (a held job, released) fails rather than writing into the occupied path, and the occupant stays', async () => {
    await seedConverted('conv-a.txt');
    takenAtTheSidecar();
    const answer = await acts.move('REST', 'conv-a.txt', 'conv-b.txt');
    assert.equal(acts.statusOf(answer), 200, `fixture: the move did not finish (${sentenceOf(answer)}), so no job was released into an occupied path`);
    stored.setMoveStepsForTest(null);
    const claim = await seedClaim(S, 'conv-b.txt', { mediaType: 'text', mimeType: 'text/plain' });

    await assert.rejects(
      pipeline.storeConversionResults(S, 'conv-b.txt', [{ chunkIndex: 0, content: 'text of conv-b', headingText: '' }], '# THE FILE\'S NEW CONVERTED TEXT', [], { claim }),
      'the conversion wrote into a sidecar path somebody else holds and reported success',
    );

    assert.equal(read('_converted/conv-b.txt.md'), OCCUPANT, 'the conversion overwrote the occupant');
  });

  it('CONTROL: a conversion of a file whose converted copy is its OWN (a row derived from it) still rewrites it', async () => {
    await seedConverted('own.txt');
    await files().insertOne({ _id: '_converted/own.txt.md', spaceId: S, path: '_converted/own.txt.md', tags: [], sizeBytes: 5, parentFileId: 'own.txt',
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' });
    const claim = await seedClaim(S, 'own.txt', { mediaType: 'text', mimeType: 'text/plain' });

    await pipeline.storeConversionResults(S, 'own.txt', [{ chunkIndex: 0, content: 'text of own', headingText: '' }], '# REPROCESSED', [], { claim });

    assert.equal(read('_converted/own.txt.md'), '# REPROCESSED', 'a reprocess of a file no longer rewrites its own converted copy');
  });
});
