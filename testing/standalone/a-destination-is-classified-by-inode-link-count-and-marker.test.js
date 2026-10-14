/**
 * What stands at a move's destination, relative to its source, is ONE pure decision over what the file system says
 * (bundle-44, D-29, Q-437; rulings 11, 20, 21). It runs everywhere, on a case-sensitive file system too, which is why the rule is held here
 * and not only by the case-insensitive disk tests.
 *
 * ## The rule (`classifyDestination`, `files/stored-bytes.ts`)
 *
 * Asked of the two `lstat` records (inode, device, link count) and of whether a begun-move marker names this very pair:
 *
 *  - nothing at the destination: `free`;
 *  - another inode, another device, an inode the file system does not number (`0`), or a link count that is not a finite number:
 *    `occupied` — the answer fails CLOSED on every ambiguity, because the wrong guess either overwrites somebody's file or unlinks one;
 *  - the same inode, the source a FILE: one directory entry (`nlink` 1) under two spellings is an `alias` (a case-only rename in any path
 *    component, `Docs/a.txt` to `docs/a.txt`): a rename, never an unlink. Two entries (`nlink` >= 2) and a marker is a `half-linked`
 *    pair — the move's own link whose removal of the source name did not happen. Two entries and NO marker is an operator's hard link:
 *    `occupied`;
 *  - the same inode, the source a DIRECTORY: `alias` (a directory has no second hard link, and its link count is a count of
 *    subdirectories on some file systems, never a reliable 1).
 *
 * The same question is asked by the pre-check, by the step that places the bytes under the locks, and by the marker's reading of "the
 * bytes have moved", so it cannot be answered two ways.
 *
 * ## The cascade's guard against the alias (`cameBackAtSource`)
 *
 * A move carries the records of the files whose bytes are NOT at the source again (a re-upload after the move is a new file whose
 * records stay). On a case-insensitive file system the old spelling still names the moved file, so a case-only rename would read as
 * "came back" and strand its record. Asked of an alias, it answers nothing came back.
 *
 * Run: node --test testing/standalone/a-destination-is-classified-by-inode-link-count-and-marker.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-classify-'));
process.env['DATA_ROOT'] = root;

let stored, cascade;
before(async () => {
  stored = await import('../../server/dist/files/stored-bytes.js');
  cascade = await import('../../server/dist/files/move-cascade.js');
});
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

/** An `lstat(..., { bigint: true })` record, as the classifier reads it. `nlink` may be left out: a file system that does not say. */
const rec = ({ dev = 1n, ino = 100n, nlink = 1n, noLink = false, dir = false } = {}) => ({ dev, ino, ...(noLink ? {} : { nlink }), isDirectory: () => dir });
const classify = (src, dst, begun = false) => {
  assert.equal(typeof stored.classifyDestination, 'function', 'files/stored-bytes.ts exports no classifyDestination');
  return stored.classifyDestination(src, dst, { begun });
};

describe('a destination is classified by inode, link count and the begun-move marker', () => {
  const TABLE = [
    ['nothing at the destination', rec(), null, false, 'free'],
    ['another inode', rec({ ino: 100n }), rec({ ino: 101n }), false, 'occupied'],
    ['another inode, with a marker', rec({ ino: 100n }), rec({ ino: 101n }), true, 'occupied'],
    ['another device, the same inode number', rec({ dev: 1n }), rec({ dev: 2n }), false, 'occupied'],
    ['an inode the file system does not number (0)', rec({ ino: 0n }), rec({ ino: 0n }), true, 'occupied'],
    ['a file: one entry under two spellings (an alias)', rec({ nlink: 1n }), rec({ nlink: 1n }), false, 'alias'],
    ['a file: one entry under two spellings, with a marker (still an alias, never an unlink)', rec({ nlink: 1n }), rec({ nlink: 1n }), true, 'alias'],
    ['a file: two entries and a marker (the move\'s own half-made link)', rec({ nlink: 2n }), rec({ nlink: 2n }), true, 'half-linked'],
    ['a file: two entries and NO marker (an operator\'s hard link)', rec({ nlink: 2n }), rec({ nlink: 2n }), false, 'occupied'],
    ['a file: many entries and a marker', rec({ nlink: 3n }), rec({ nlink: 3n }), true, 'half-linked'],
    ['a file: a link count the file system does not give', rec({ noLink: true }), rec({ noLink: true }), true, 'occupied'],
    ['a directory: the same inode (an alias whatever its link count says)', rec({ dir: true, nlink: 5n }), rec({ dir: true, nlink: 5n }), false, 'alias'],
    ['a directory: another inode', rec({ dir: true, ino: 7n }), rec({ dir: true, ino: 8n }), false, 'occupied'],
    ['a directory onto a file', rec({ dir: true, ino: 7n }), rec({ ino: 8n }), false, 'occupied'],
    ['a file onto a directory', rec({ ino: 7n }), rec({ dir: true, ino: 8n }), false, 'occupied'],
  ];
  for (const [name, src, dst, begun, expected] of TABLE) {
    it(`${name}: ${expected}`, () => { assert.equal(classify(src, dst, begun), expected); });
  }

  it('the marker decides between an operator\'s link and the move\'s own, and nothing else does', () => {
    const pair = [rec({ nlink: 2n }), rec({ nlink: 2n })];
    assert.notEqual(classify(...pair, false), classify(...pair, true), 'the marker changes nothing: an operator\'s link and a half-made one read alike');
    const one = [rec({ nlink: 1n }), rec({ nlink: 1n })];
    assert.equal(classify(...one, false), classify(...one, true), 'the marker changed what a single entry under two spellings is');
  });
});

describe('a case-only rename is not a re-upload at the source (cameBackAtSource)', () => {
  const plan = (kind, src) => ({ src, dst: src.toUpperCase(), kind, rows: [], flaggedAtDestination: new Set(), replacedAtDestination: new Set(), refusedAtDestination: [], linkFiles: [], jobIds: [] });

  it('an ALIAS: nothing came back, for a file and for a directory', async () => {
    assert.equal(typeof cascade.cameBackAtSource, 'function', 'files/move-cascade.ts exports no cameBackAtSource: the guard has no seam');
    // The bytes ARE at the source (that is what an alias is: the old spelling still names the file), so without the guard they would read as a re-upload.
    fs.mkdirSync(path.join(root, 'files', 'general', 'adir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'general', 'case.txt'), 'x');
    fs.writeFileSync(path.join(root, 'files', 'general', 'adir', 'x.txt'), 'x');
    assert.deepEqual([...await cascade.cameBackAtSource('general', plan('file', 'case.txt'), async () => true)], []);
    assert.deepEqual([...await cascade.cameBackAtSource('general', plan('directory', 'adir'), async () => true)], []);
  });

  it('NOT an alias: a file whose bytes are at the source again came back; one whose bytes are not did not', async () => {
    fs.mkdirSync(path.join(root, 'files', 'general'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'general', 'again.txt'), 'x');
    assert.deepEqual([...await cascade.cameBackAtSource('general', plan('file', 'again.txt'), async () => false)], ['again.txt']);
    assert.deepEqual([...await cascade.cameBackAtSource('general', plan('file', 'gone.txt'), async () => false)], []);
  });
});
