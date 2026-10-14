/**
 * What stands at a move's destination, relative to its source, is ONE pure decision over what the file system says
 * (bundle-44, D-29, Q-437; rulings 11, 20, 21, 39). It runs everywhere, on a case-sensitive file system too, which is why the rule is held
 * here and not only by the case-insensitive disk tests.
 *
 * ## The rule (`classifyDestination`, `files/stored-bytes.ts`)
 *
 * Asked of the two `lstat` records (inode, device, link count), of the two NAMES, and of whether a begun-move marker names this very pair:
 *
 *  - nothing at the destination: `free`;
 *  - another inode, another device, an inode the file system does not number (`0`), or a link count that is not a finite number:
 *    `occupied` — the answer fails CLOSED on every ambiguity, because the wrong guess either overwrites somebody's file or unlinks one;
 *  - the same inode and the two names the SAME NAME UNDER CASE FOLDING (a case-only rename in any path component, `Docs/a.txt` to
 *    `docs/a.txt`): one directory entry under two spellings, an `alias` — a rename, never an unlink. **The link count plays no part**: a
 *    converter holds a scratch hard link to the file while it runs, so a case-only rename of a file being converted meets two entries
 *    for one name and is still the same file;
 *  - the same inode under two DIFFERENT names is never an alias, whatever the file system numbers: a colliding or synthesised inode
 *    (FUSE, a network file system) must not read a different file as the source. A file with two or more entries and a begun-move marker
 *    for this pair is the move's own `half-linked` link; without a marker it is somebody's hard link, `occupied`; one entry under two
 *    names that do not fold to each other is `occupied`;
 *  - a directory has no second hard link, so a directory with the same inode under two different names is `occupied`.
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
const classify = (src, dst, begun, names) => {
  assert.equal(typeof stored.classifyDestination, 'function', 'files/stored-bytes.ts exports no classifyDestination');
  return stored.classifyDestination(src, dst, { begun, names });
};
const CROSS_DIRECTORY = { src: 'Docs/a.txt', dst: 'docs/a.txt' };
/** Two names that are one name under case folding, and two that are not. */
const FOLDED = { src: 'a.txt', dst: 'A.txt' };
const DIFFERENT = { src: 'a.txt', dst: 'b.txt' };

describe('a destination is classified by inode, link count, the names and the begun-move marker', () => {
  const TABLE = [
    ['nothing at the destination', rec(), null, false, DIFFERENT, 'free'],
    ['another inode', rec({ ino: 100n }), rec({ ino: 101n }), false, DIFFERENT, 'occupied'],
    ['another inode under names that fold alike (an unrelated file called A.txt)', rec({ ino: 100n }), rec({ ino: 101n }), false, FOLDED, 'occupied'],
    ['another inode, with a marker', rec({ ino: 100n }), rec({ ino: 101n }), true, DIFFERENT, 'occupied'],
    ['another device, the same inode number', rec({ dev: 1n }), rec({ dev: 2n }), false, FOLDED, 'occupied'],
    ['an inode the file system does not number (0)', rec({ ino: 0n }), rec({ ino: 0n }), true, FOLDED, 'occupied'],
    ['a file: one entry, names that fold alike (an alias)', rec({ nlink: 1n }), rec({ nlink: 1n }), false, FOLDED, 'alias'],
    ['a file: one entry, names that fold alike, with a marker (still an alias, never an unlink)', rec({ nlink: 1n }), rec({ nlink: 1n }), true, FOLDED, 'alias'],
    ['a file: a component other than the last differs in case (Docs/a.txt, docs/a.txt)', rec({ nlink: 1n }), rec({ nlink: 1n }), false, CROSS_DIRECTORY, 'alias'],
    ['a file: TWO entries (a converter\'s scratch link), names that fold alike: still an alias, the count plays no part', rec({ nlink: 2n }), rec({ nlink: 2n }), false, FOLDED, 'alias'],
    ['a file: two entries, names that fold alike, with a marker: still an alias, never half-linked', rec({ nlink: 2n }), rec({ nlink: 2n }), true, FOLDED, 'alias'],
    ['a file: a link count the file system does not give, names that fold alike', rec({ noLink: true }), rec({ noLink: true }), false, FOLDED, 'alias'],
    ['a file: ONE entry, two DIFFERENT names (a synthesised or colliding inode): never an alias', rec({ nlink: 1n }), rec({ nlink: 1n }), false, DIFFERENT, 'occupied'],
    ['a file: one entry, two different names, with a marker: still occupied', rec({ nlink: 1n }), rec({ nlink: 1n }), true, DIFFERENT, 'occupied'],
    ['a file: two entries, different names and a marker (the move\'s own half-made link)', rec({ nlink: 2n }), rec({ nlink: 2n }), true, DIFFERENT, 'half-linked'],
    ['a file: two entries, different names and NO marker (an operator\'s hard link)', rec({ nlink: 2n }), rec({ nlink: 2n }), false, DIFFERENT, 'occupied'],
    ['a file: many entries, different names and a marker', rec({ nlink: 3n }), rec({ nlink: 3n }), true, DIFFERENT, 'half-linked'],
    ['a file: a link count the file system does not give, different names and a marker', rec({ noLink: true }), rec({ noLink: true }), true, DIFFERENT, 'occupied'],
    ['a directory: the same inode, names that fold alike (an alias whatever its link count says)', rec({ dir: true, nlink: 5n }), rec({ dir: true, nlink: 5n }), false, FOLDED, 'alias'],
    ['a directory: the same inode under two DIFFERENT names', rec({ dir: true, nlink: 5n }), rec({ dir: true, nlink: 5n }), true, DIFFERENT, 'occupied'],
    ['a directory: another inode', rec({ dir: true, ino: 7n }), rec({ dir: true, ino: 8n }), false, FOLDED, 'occupied'],
    ['a directory onto a file', rec({ dir: true, ino: 7n }), rec({ ino: 8n }), false, FOLDED, 'occupied'],
    ['a file onto a directory', rec({ ino: 7n }), rec({ dir: true, ino: 8n }), false, FOLDED, 'occupied'],
  ];
  for (const [name, src, dst, begun, names, expected] of TABLE) {
    it(`${name}: ${expected}`, () => { assert.equal(classify(src, dst, begun, names), expected); });
  }

  it('the marker decides between an operator\'s link and the move\'s own, and nothing else does', () => {
    const pair = [rec({ nlink: 2n }), rec({ nlink: 2n })];
    assert.notEqual(classify(...pair, false, DIFFERENT), classify(...pair, true, DIFFERENT), 'the marker changes nothing: an operator\'s link and a half-made one read alike');
    const one = [rec({ nlink: 1n }), rec({ nlink: 1n })];
    assert.equal(classify(...one, false, FOLDED), classify(...one, true, FOLDED), 'the marker changed what a single entry under two spellings is');
  });

  it('the link count decides nothing about an alias: one entry and two entries under two spellings of one name answer alike', () => {
    for (const begun of [false, true]) {
      assert.equal(classify(rec({ nlink: 1n }), rec({ nlink: 1n }), begun, FOLDED), classify(rec({ nlink: 2n }), rec({ nlink: 2n }), begun, FOLDED));
    }
  });

  it('two paths are one name when every component folds alike, and only then', () => {
    const asked = (src, dst) => classify(rec({ nlink: 1n }), rec({ nlink: 1n }), false, { src, dst });
    assert.equal(asked('a/b/c.txt', 'A/b/C.txt'), 'alias', 'a path that differs in the case of two components is one name');
    assert.equal(asked('a/b/c.txt', 'a/b/d.txt'), 'occupied', 'a different last component is a different name');
    assert.equal(asked('a/b/c.txt', 'a/x/c.txt'), 'occupied', 'a different directory is a different name');
    assert.equal(asked('a/b/c.txt', 'a/b/c.txt.bak'), 'occupied', 'a prefix is not the same name');
  });

  it('a decision that is not given the names is refused, never read as "the same name"', () => {
    assert.throws(() => stored.classifyDestination(rec(), rec(), { begun: false }), undefined, 'a caller that drops the names was answered');
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
