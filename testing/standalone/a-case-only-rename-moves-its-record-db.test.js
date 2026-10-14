/**
 * A rename that changes only the case of a name moves the file's record with it (bundle-44, D-29, Q-437; ruling 2).
 *
 * ## The rule
 *
 * On a case-insensitive file system `a.txt` and `A.txt` are ONE directory entry under two spellings, so `A.txt` is not an occupied
 * destination: moving `a.txt` to `A.txt` is a rename of the file onto itself, and it carries what a move carries — the record at the new
 * id, the bytes under the new spelling, a tombstone for the spelling left behind — exactly as on a case-sensitive file system. The same
 * holds for ANY path component (`Docs/a.txt` to `docs/a.txt`) and for a directory.
 *
 * ## What it was
 *
 * The cascade finishes a move by carrying the records of every file whose bytes are not at the source any more, and it asked "are the
 * bytes at the source" by name. On a case-insensitive file system the old spelling still names the file, so the question answered
 * "yes", the record was read as a re-upload at the old path and left where it was: the bytes moved to `A.txt` and the record stayed at
 * `a.txt` — a listed file with no bytes, and bytes with no record. Measured on NTFS.
 *
 * ## Where it runs
 *
 * A case-insensitive file system is needed to see the alias at all; this development machine (NTFS) has one and the local preflight
 * runs these cases for real. On a case-sensitive host (the Linux CI runner) every case here skips and says why: there the spelling is a
 * different entry, the move is an ordinary move, and the RULE is held by the pure classification test
 * (`a-destination-is-classified-by-inode-link-count-and-marker`), which asserts the branch and not the operating system.
 *
 * What it holds about tombstones: a record id is case-SENSITIVE and a peer may run on a case-sensitive host, so the old id must be told to
 * go whether or not the old spelling still names bytes here. A peer that is not told keeps `a.txt` and receives `A.txt`: two files, for
 * ever. The file's own tombstone is published by its act; the sidecars' are settled from the disk, which asked "do bytes answer at the old
 * spelling" and dropped them. The settle's question for a move is "is the old ID still this file's id", so an old id that is the same
 * directory entry as its new one (an alias) is published. And a repeat of the finished request is a first attempt (the old spelling still has bytes), answered 200 and doing nothing.
 *
 * Run: node --test testing/standalone/a-case-only-rename-moves-its-record-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { caseInsensitiveAt, sentenceOf } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'caseonly';
const T0 = '2026-09-01T00:00:00.000Z';

let acts, tombstones, insensitive;
const files = () => acts.door.coll(S, 'files');
const rowOf = (id) => files().findOne({ _id: id });
const abs = (p) => path.join(acts.root(), p);
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const namesIn = (dir) => fs.readdirSync(abs(dir)).sort();
const SKIPPED = 'the file system under the files tree is case-sensitive: `a` and `A` are different entries, the move is an ordinary one, and the rule is held by a-destination-is-classified-by-inode-link-count-and-marker (pure)';

describe('a case-only rename moves its record (real MongoDB, case-insensitive file systems)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'caseonly', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    insensitive = caseInsensitiveAt(acts.root());
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });

  it('a FILE, a.txt to A.txt: the record is at the new id, the bytes under the new spelling, nothing is owed, and the repeat is a first attempt', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('case.txt', { description: 'C' });
    await acts.files.writeFile(S, '_converted/case.txt.md', '# converted');
    await files().insertOne({ _id: 'case.txt#chunk-0', spaceId: S, path: 'case.txt#chunk-0', parentFileId: 'case.txt', content: 'chunk', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5 });

    const answer = await acts.move('REST', 'case.txt', 'Case.txt');

    assert.equal(acts.statusOf(answer), 200, `a case-only rename failed: ${sentenceOf(answer)}`);
    assert.deepEqual(namesIn('.').filter(n => n !== '_converted'), ['Case.txt'], 'the bytes are not under the new spelling');
    assert.equal(read('Case.txt'), 'content of case.txt');
    assert.equal((await rowOf('Case.txt'))?.description, 'C', 'the record did not follow the file to the new spelling: it was read as a re-upload at the old one');
    assert.equal(await rowOf('case.txt'), null, 'the record is stranded at the old spelling');
    assert.equal((await rowOf('Case.txt#chunk-0'))?.parentFileId, 'Case.txt', 'the derived row did not follow');
    assert.equal(await rowOf('case.txt#chunk-0'), null);
    assert.equal(await tombstones.moveIsOwed(S, 'case.txt', 'Case.txt'), false, 'a finished case-only move is read as owed');
    assert.deepEqual((await acts.raw()).filter(r => r.pending), [], 'a tombstone is left pending');
    assert.equal(await tombstones.moveMarkerOf(S, 'case.txt', 'Case.txt'), undefined, 'the finished move kept its marker');
    assert.deepEqual(await acts.published(), { served: ['_converted/case.txt.md', 'case.txt'], pushed: ['_converted/case.txt.md', 'case.txt'] },
      'a peer is not told the old ids are gone (the sidecar tombstone was dropped because bytes still answer at the old spelling): on a case-sensitive peer both ids would stay');

    const again = await acts.move('REST', 'case.txt', 'Case.txt');
    assert.equal(acts.statusOf(again), 200, `the repeat of a case-only rename is a first attempt and answers 200: ${sentenceOf(again)}`);
    assert.equal((await rowOf('Case.txt'))?.description, 'C', 'the repeat disturbed the record');
  });

  it('a DIRECTORY, adir to ADIR: its files\' records are at the new ids', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('adir/x.txt', { description: 'X' });
    await acts.files.writeFile(S, '_converted/adir/x.txt.md', '# converted');

    const answer = await acts.move('REST', 'adir', 'ADIR');

    assert.equal(acts.statusOf(answer), 200, `a case-only directory rename failed: ${sentenceOf(answer)}`);
    assert.deepEqual(namesIn('.').filter(n => n !== '_converted'), ['ADIR'], 'the directory is not under its new spelling');
    assert.equal((await rowOf('ADIR/x.txt'))?.description, 'X', 'the record did not follow its directory');
    assert.equal(await rowOf('adir/x.txt'), null, 'a record is stranded under the old spelling');
    assert.deepEqual((await acts.raw()).filter(r => r.pending), []);
    assert.deepEqual(await acts.published(), { served: ['_converted/adir/x.txt.md', 'adir/x.txt'], pushed: ['_converted/adir/x.txt.md', 'adir/x.txt'] },
      'a peer is not told the old ids under the old spelling of the directory are gone');
  });

  it('a CROSS-DIRECTORY alias, Docs/a.txt to docs/a.txt (a directory component differs in case): the record follows', async (t) => {
    if (!insensitive) { t.skip(SKIPPED); return; }
    await acts.seed('Docs/a.txt', { description: 'D' });

    const answer = await acts.move('REST', 'Docs/a.txt', 'docs/a.txt');

    assert.equal(acts.statusOf(answer), 200, `a rename that differs in a directory component's case failed: ${sentenceOf(answer)}`);
    assert.equal(read('docs/a.txt'), 'content of Docs/a.txt', 'the file is not readable under the new spelling');
    assert.equal((await rowOf('docs/a.txt'))?.description, 'D', 'the record did not follow the file to the new spelling');
    assert.equal(await rowOf('Docs/a.txt'), null, 'the record is stranded at the old spelling');
  });
});
