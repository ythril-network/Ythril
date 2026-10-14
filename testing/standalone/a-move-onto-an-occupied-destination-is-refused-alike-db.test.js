/**
 * A move onto anything that stands at its destination is refused, before anything moves, and every door says it alike
 * (bundle-44, D-29, Q-437).
 *
 * ## The rule
 *
 * A move never replaces anything. What a caller can NAME and REMOVE blocks it: BYTES at the destination (a file, a directory
 * empty or not), or a LIVE RECORD at the destination path (a peer's file whose bytes have not arrived, or a record left without
 * bytes by a delete a failure stopped), or the live records of another file at an id the move takes. The answer is the same on REST
 * `PATCH`, `POST /api/move_file` and MCP `move_file`: `409`, `code: destination_exists`, `path` the destination as requested, a
 * sentence that names the remedy (delete what stands there first, which is replicated, or choose another name) — and NOTHING changed:
 * not a byte, not a record, not a derived row, not a link, not a job, not a tombstone.
 *
 * What derives from nothing live is debris, not an occupant, and the move removes it: a sidecar of a file with neither bytes nor a
 * record, a derived row whose parent is absent or flagged. A flagged audit row is the destination's own, removed in the move's transaction.
 *
 * ## What it was
 *
 * A move onto an existing file REPLACED it: the destination's bytes were overwritten by the rename, its record by the move's, its
 * links dropped. Nothing said so, and a script that moved a file onto a name it believed free destroyed another file.
 *
 * ## What the cases hold
 *
 * Every case runs on all three doors against a fresh space and compares the state before and after with `deepEqual` over everything a
 * move can write (`_move-destination.mjs`), and compares the three answers to each other. A refusal case asserts the refusal's code
 * and path by value; a control (the destination is free, flagged, or held by debris) asserts the move HAPPENED and what is at each id.
 *
 * Run: node --test testing/standalone/a-move-onto-an-occupied-destination-is-refused-alike-db.test.js
 * (requires a prior `npm run build` in server/, the test MongoDB, and a private IPv4 on the host: the doors helper binds one)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { MOVE_DOORS, stateOf, sentenceOf } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'moveoccupied';
const T0 = '2026-09-01T00:00:00.000Z';

let acts;
const files = () => acts.door.coll(S, 'files');
const rowOf = (id) => files().findOne({ _id: id });
const abs = (p) => path.join(acts.root(), p);
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const put = (p, content) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), content); };

/** A derived row (a chunk, a converted Markdown) of `parent`, at `id`. */
const derivedRow = (id, parent, content) => ({
  _id: id, spaceId: S, path: id, parentFileId: parent, content, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: content.length,
});
/** A record with no bytes behind it: a delete a failure stopped, or a file whose content has not arrived from a peer. */
const bareRecord = (id, description) => ({ _id: id, spaceId: S, path: id, sizeBytes: 1, tags: [], description, createdAt: T0, updatedAt: T0 });

/**
 * The cases a move is REFUSED in. `setup` builds the space and returns the pair; `standing` is the sentence's key phrase, so a refusal
 * for the wrong reason (a sidecar named where the file is) does not pass for the right one.
 */
const REFUSED = [
  { name: 'a file onto an existing file', async setup() { await acts.seed('a.txt', { description: 'A' }); await acts.seed('b.txt', { description: 'B' }); return ['a.txt', 'b.txt']; }, says: /already exists/ },
  { name: 'a file onto an empty directory', async setup() { await acts.seed('a.txt'); fs.mkdirSync(abs('emptyd')); return ['a.txt', 'emptyd']; }, says: /already exists/ },
  { name: 'a file onto a directory that is not empty', async setup() { await acts.seed('a.txt'); put('fulld/x', 'X'); return ['a.txt', 'fulld']; }, says: /already exists/ },
  { name: 'a directory onto a file', async setup() { await acts.seed('f.txt'); put('srcdir/y', 'Y'); return ['srcdir', 'f.txt']; }, says: /already exists/ },
  { name: 'a directory onto an empty directory', async setup() { put('srcdir/y', 'Y'); fs.mkdirSync(abs('emptyd')); return ['srcdir', 'emptyd']; }, says: /already exists/ },
  { name: 'a directory onto a directory that is not empty', async setup() { put('srcdir/y', 'Y'); put('fulld/x', 'X'); return ['srcdir', 'fulld']; }, says: /already exists/ },
  {
    // `_converted/b.md` is, for the FILE `b`, its converted Markdown, and for the DIRECTORY `b.md/`, its converted tree: a directory
    // `b.md` standing beside `b` is a live thing the moved file's sidecar would land on.
    name: 'a file whose sidecar destination is the converted tree of a live directory',
    async setup() {
      await acts.seed('a', { description: 'A' });
      put('_converted/a.md', 'converted a');
      put('b.md/x.txt', 'X');
      put('_converted/b.md/x.txt.md', 'converted x');
      return ['a', 'b'];
    },
    says: /_converted\/b\.md/,
  },
  {
    name: 'a file onto a record that has no bytes (a delete a failure stopped, or content still arriving from a peer)',
    async setup() { await acts.seed('a.txt', { description: 'A' }); await files().insertOne(bareRecord('b.txt', 'bare')); return ['a.txt', 'b.txt']; },
    says: /file record but no bytes/,
  },
  {
    name: 'a source with bytes and NO record onto a record that has no bytes',
    async setup() { put('a.txt', 'content of a.txt'); await files().insertOne(bareRecord('b.txt', 'bare')); return ['a.txt', 'b.txt']; },
    says: /file record but no bytes/,
  },
  {
    name: 'a directory onto a path that has a record under it and no bytes',
    async setup() { put('srcdir/y', 'Y'); await files().insertOne(bareRecord('dstdir/z.txt', 'bare')); return ['srcdir', 'dstdir']; },
    says: /file record but no bytes/,
  },
  {
    name: 'a file whose derived row would land on the derived row of ANOTHER live file',
    async setup() {
      await acts.seed('a.txt', { description: 'A' });
      await acts.seed('z.txt', { description: 'Z' });
      await files().insertOne(derivedRow('_converted/a.txt.md', 'a.txt', 'converted a'));
      await files().insertOne(derivedRow('_converted/b.txt.md', 'z.txt', 'converted z'));
      return ['a.txt', 'b.txt'];
    },
    says: /records of another file/,
  },
];

/** One door's run of a case on a fresh space: what it answered, and that nothing changed. */
async function refusedOn(via, c) {
  await freshSpace();
  const [src, dst] = await c.setup();
  const before = await stateOf(acts, S);
  const answer = await acts.move(via, src, dst);
  const ans = acts.answerOf(answer);
  assert.equal(ans.status, 409, `${via}: answered ${ans.status}, not 409 — ${sentenceOf(answer)}`);
  assert.equal(ans.code, 'destination_exists', `${via}: ${sentenceOf(answer)}`);
  assert.equal(ans.path, dst, `${via}: the refusal names '${ans.path}', not the destination the caller asked for`);
  const said = sentenceOf(answer);
  assert.match(said, c.says, `${via}: the sentence does not say what stands there — ${said}`);
  assert.match(said, /[Dd]elete/, `${via}: the sentence does not name the remedy — ${said}`);
  assert.match(said, /another name/, `${via}: the sentence does not offer another name — ${said}`);
  assert.doesNotMatch(said, /[A-Za-z]:\\|\/data\//, `${via}: the sentence names the data root — ${said}`);
  assert.deepEqual(await stateOf(acts, S), before, `${via}: a refused move changed the bytes, the records, the links, the jobs or the tombstones`);
  return ans;
}

async function freshSpace() {
  await acts.reset();
  for (const part of ['links', 'media_jobs', 'entities', 'facts']) await acts.door.coll(S, part).deleteMany({});
}

describe('a move onto an occupied destination is refused alike on every door (real MongoDB)', { skip }, () => {
  before(async () => { acts = await openFileActDoors({ suite: 'moveoccupied', space: S }); });
  after(async () => { await acts?.close(); });
  beforeEach(freshSpace);

  for (const c of REFUSED) {
    it(`${c.name}: 409 destination_exists on REST, POST /api/move_file and MCP, and nothing changed`, async () => {
      const answers = [];
      for (const via of MOVE_DOORS) answers.push(await refusedOn(via, c));
      assert.deepEqual(answers[1], answers[0], 'POST /api/move_file answered differently from REST');
      assert.deepEqual(answers[2], answers[0], 'MCP answered differently from REST');
    });
  }

  describe('the remedy the sentence names works: delete what stands there, and the move happens', () => {
    for (const via of MOVE_DOORS) {
      it(`${via}: a record with no bytes is deleted by delete_file, and the move then succeeds`, async () => {
        await acts.seed('a.txt', { description: 'A' });
        await files().insertOne(bareRecord('b.txt', 'bare'));
        const refused = acts.answerOf(await acts.move(via, 'a.txt', 'b.txt'));
        assert.equal(refused.code, 'destination_exists', `fixture: the move was not refused (${JSON.stringify(refused)})`);

        const deleted = await acts.del(via, 'b.txt');
        assert.ok(!acts.failed(deleted), `delete_file on the record without bytes failed: ${sentenceOf(deleted)}`);
        assert.equal(await rowOf('b.txt'), null, 'the record without bytes is still there after its delete');

        const moved = await acts.move(via, 'a.txt', 'b.txt');
        assert.equal(acts.statusOf(moved), 200, `the move after the delete was refused: ${sentenceOf(moved)}`);
        assert.equal((await rowOf('b.txt'))?.description, 'A', 'the destination holds not the moved file\'s record');
        assert.equal(read('b.txt'), 'content of a.txt');
        assert.equal(acts.onDisk('a.txt'), false);
      });
    }
  });

  describe('controls: what is NOT an occupant is moved over, on every door', () => {
    /** The pair, and what must be true afterwards on top of "the file moved and its record is at the destination". */
    const CONTROLS = [
      { name: 'a destination nothing holds', async setup() { await acts.seed('a.txt', { description: 'A' }); return ['a.txt', 'dir/b.txt']; }, dst: 'dir/b.txt' },
      {
        name: 'a destination that holds only a FLAGGED audit row (the record a soft delete leaves)',
        async setup() {
          await acts.seed('a.txt', { description: 'A' });
          await files().insertOne({ ...bareRecord('b.txt', 'the deleted file'), deletedAt: '2026-08-01T00:00:00.000Z' });
          return ['a.txt', 'b.txt'];
        },
        dst: 'b.txt',
      },
      {
        name: 'a destination whose own sidecar is an ORPHAN (a converted file with neither bytes nor a record behind it)',
        async setup() {
          await acts.seed('a.txt', { description: 'A' });
          put('_converted/a.txt.md', 'converted a');
          put('_converted/b.txt.md', 'ORPHAN');
          return ['a.txt', 'b.txt'];
        },
        dst: 'b.txt',
        async also(why) {
          assert.equal(read('_converted/b.txt.md'), 'converted a', `${why}: the orphan sidecar was not removed for the moved file's`);
          assert.equal(acts.onDisk('_converted/a.txt.md'), false, `${why}: the moved file's sidecar is still at the source`);
        },
      },
      {
        // The case a move onto a converted file used to be (and failed on: a rename onto a non-empty extracted tree). What the destination
        // has is only the trace of a file that is gone, so there is nothing to refuse and nothing to keep.
        name: 'a converted file onto a destination whose only trace is an orphaned converted file and a non-empty extracted tree',
        async setup() {
          await acts.seed('src.pdf', { description: 'A' });
          put('_converted/src.pdf.md', 'converted markdown of src.pdf');
          put('_extracted/src.pdf/x.jpg', 'image of src.pdf');
          put('_converted/dst.pdf.md', 'ORPHAN converted');
          put('_extracted/dst.pdf/x.jpg', 'ORPHAN image');
          put('_extracted/dst.pdf/only-dst.jpg', 'ORPHAN extra');
          return ['src.pdf', 'dst.pdf'];
        },
        dst: 'dst.pdf',
        async also(why) {
          assert.equal(read('_converted/dst.pdf.md'), 'converted markdown of src.pdf', `${why}: the destination's converted Markdown is not the moved file's`);
          assert.equal(read('_extracted/dst.pdf/x.jpg'), 'image of src.pdf', `${why}: the destination's extracted image is not the moved file's`);
          assert.equal(acts.onDisk('_extracted/dst.pdf/only-dst.jpg'), false, `${why}: an image of the file that is gone was left under the moved file's extracted tree`);
          for (const gone of ['_converted/src.pdf.md', '_extracted/src.pdf']) assert.equal(acts.onDisk(gone), false, `${why}: ${gone} is still at the source`);
        },
      },
      {
        name: 'a destination whose derived row is an ORPHAN (its parent is absent)',
        async setup() {
          await acts.seed('a.txt', { description: 'A' });
          await files().insertOne(derivedRow('a.txt#chunk-0', 'a.txt', 'chunk of a'));
          await files().insertOne(derivedRow('b.txt#chunk-0', 'b.txt', 'orphan chunk'));
          await files().insertOne(derivedRow('_converted/b.txt.md', 'ghost.txt', 'orphan converted'));
          await files().insertOne(derivedRow('_converted/a.txt.md', 'a.txt', 'converted a'));
          return ['a.txt', 'b.txt'];
        },
        dst: 'b.txt',
        async also(why) {
          assert.equal((await rowOf('b.txt#chunk-0'))?.content, 'chunk of a', `${why}: the orphan chunk row was not replaced by the moved file's`);
          assert.equal((await rowOf('_converted/b.txt.md'))?.content, 'converted a', `${why}: the orphan converted row was not replaced by the moved file's`);
          assert.equal((await rowOf('_converted/b.txt.md'))?.parentFileId, 'b.txt');
        },
      },
      {
        name: 'a destination whose derived row hangs under a FLAGGED parent',
        async setup() {
          await acts.seed('a.txt', { description: 'A' });
          await files().insertOne(derivedRow('a.txt#chunk-0', 'a.txt', 'chunk of a'));
          await files().insertOne({ ...bareRecord('b.txt', 'the deleted file'), deletedAt: '2026-08-01T00:00:00.000Z' });
          await files().insertOne(derivedRow('b.txt#chunk-0', 'b.txt', 'chunk of the deleted file'));
          return ['a.txt', 'b.txt'];
        },
        dst: 'b.txt',
        async also(why) { assert.equal((await rowOf('b.txt#chunk-0'))?.content, 'chunk of a', `${why}: the flagged parent's chunk survived at a moved id`); },
      },
    ];

    for (const c of CONTROLS) {
      for (const via of MOVE_DOORS) {
        it(`${via}: ${c.name}`, async () => {
          const [src, dst] = await c.setup();
          const answer = await acts.move(via, src, dst);
          assert.equal(acts.statusOf(answer), 200, `the move was refused or failed: ${sentenceOf(answer)}`);
          assert.equal(read(dst), `content of ${src}`, 'the bytes at the destination are not the moved ones');
          assert.equal(acts.onDisk(src), false, 'the source still has its bytes');
          const moved = await rowOf(dst);
          assert.equal(moved?.description, 'A', 'the destination\'s record is not the moved file\'s');
          assert.equal(moved?.deletedAt, undefined, 'the record at the destination is still the flagged one');
          assert.equal(await rowOf(src), null, 'a record is still at the source');
          await c.also?.(`${via}`);
        });
      }
    }
  });
});
