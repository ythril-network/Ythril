/**
 * A space-relative path has ONE key, whoever spelled it (bundle-71 lens fix, Q-404).
 *
 * ## The defect
 *
 * Bundle-71 made every door that takes a PEER's path key it by the resolved path (`peerFileKey`: NFC, `.` and empty segments
 * collapsed, relative to the space root) and made the arrival writer refuse a file-metadata document whose `_id` is not that
 * canonical key. This instance's OWN writes keyed a row by `toDocId(path)` — only backslashes and leading slashes — so a file
 * uploaded here under a decomposed (NFD) name, or as `a//b`, got a row id every upgraded peer refuses for ever: its metadata
 * never replicated. Two spellings of one rule, and the stricter one was the receiver's.
 *
 * ## The rule
 *
 * `toDocId` IS the canonical key: NFC, forward slashes, no leading slash, empty and `.` segments dropped, `..` collapsed
 * posix-style (a `..` that would climb above the root is left in place — a key is not a filesystem path). The key the peer
 * resolver derives is the same string, and it is derived WITHOUT the disk (`fileKeyOf`): a comparison of keys needs no
 * realpath walk, and a manifest of thousands of entries paid one per entry per cycle.
 *
 * ## What is asserted
 *
 *  - the canonical form of every spelling in the table below, over the whole set rather than one site;
 *  - the key is stable: a canonical key is its own canonical key;
 *  - `fileKeyOf` (the lexical half of the peer resolver) and `peerFileKey` (the same plus the symlink check) answer with the
 *    string `toDocId` gives, for every spelling that names a file inside the space;
 *  - a path that names the space itself is not a key, and one that leaves the space is refused.
 *
 * Run: node --test testing/standalone/a-space-relative-path-has-one-key.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// DATA_ROOT must be set before importing modules that read it at call time.
process.env.DATA_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'ythril-onekey-'));

const { toDocId } = await import('../../server/dist/util/paths.js');
const sandbox = await import('../../server/dist/files/sandbox.js');

const SPACE = 'onekey';
/** The same file as the decomposed spelling a macOS client sends: `e` + a combining acute accent. */
const NFD = 'café.txt';
const NFC = 'café.txt';

/** [spelling, its canonical key] — every one names a file INSIDE the space. */
const FILES = [
  ['a/b.txt', 'a/b.txt'],
  ['b.txt', 'b.txt'],
  [NFD, NFC],
  [`docs/${NFD}`, `docs/${NFC}`],
  ['a//b', 'a/b'],
  ['a///b//c', 'a/b/c'],
  ['./a', 'a'],
  ['././a', 'a'],
  ['a/./b', 'a/b'],
  ['a/x/../b', 'a/b'],
  ['a/b/../../c', 'c'],
  ['x/../victim', 'victim'],
  ['a\\b\\c', 'a/b/c'],
  ['.\\a\\.\\b', 'a/b'],
  ['/a/b', 'a/b'],
  ['///a', 'a'],
  ['/./a//b', 'a/b'],
  ['a/..b', 'a/..b'],
  ['a/.hidden', 'a/.hidden'],
];

/** Spellings that are no file: the space itself. `toDocId` gives '' for each. */
const NAMES_THE_SPACE = ['', '/', '.', './', 'a/..', 'a/b/../..', '//./'];

/** Spellings that climb out of the space: the key keeps the `..`, the filesystem door refuses. */
const LEAVES_THE_SPACE = ['../x', 'a/../../x', '/../x'];

describe('a space-relative path has one key', () => {
  describe('toDocId is the canonical key', () => {
    for (const [spelling, key] of FILES) {
      it(`${JSON.stringify(spelling)} is keyed ${JSON.stringify(key)}`, () => {
        assert.equal(toDocId(spelling), key);
      });
    }

    it('a canonical key is its own canonical key', () => {
      for (const [, key] of FILES) assert.equal(toDocId(key), key, `${JSON.stringify(key)} moved when keyed again`);
    });

    it('a path that names the space is the empty key', () => {
      for (const spelling of NAMES_THE_SPACE) assert.equal(toDocId(spelling), '', JSON.stringify(spelling));
    });

    it('a `..` that would climb above the root is left in place, not swallowed', () => {
      assert.equal(toDocId('../x'), '../x');
      assert.equal(toDocId('a/../../x'), '../x');
      assert.equal(toDocId('/../x'), '../x');
    });

    it('a trailing slash is kept as one slash, and the callers that want a bare directory still strip it', () => {
      assert.equal(toDocId('a/b/'), 'a/b/');
      assert.equal(toDocId('a//b//'), 'a/b/');
      assert.equal(toDocId('/docs/'), 'docs/');
      assert.equal(toDocId('docs/').replace(/\/+$/, ''), 'docs');
    });
  });

  describe('the peer resolver derives the same key, and the lexical half needs no disk', () => {
    it('the lexical half is exported', () => {
      assert.equal(typeof sandbox.fileKeyOf, 'function', 'sandbox.fileKeyOf is the key derivation with no disk');
    });

    for (const [spelling, key] of FILES) {
      it(`${JSON.stringify(spelling)}: fileKeyOf and peerFileKey both answer ${JSON.stringify(key)}`, async () => {
        assert.equal(sandbox.fileKeyOf(SPACE, spelling).key, key, 'the lexical key');
        assert.equal((await sandbox.peerFileKey(SPACE, spelling)).key, key, 'the checked key');
        assert.equal(sandbox.fileKeyOf(SPACE, spelling).key, toDocId(spelling), 'the key a local write makes');
      });
    }

    it('fileKeyOf and peerFileKey agree on the absolute path they resolve to', async () => {
      for (const [spelling] of FILES) {
        assert.equal(sandbox.fileKeyOf(SPACE, spelling).abs, (await sandbox.peerFileKey(SPACE, spelling)).abs, JSON.stringify(spelling));
      }
    });

    it('a path that names the space is no key, on both', async () => {
      for (const spelling of NAMES_THE_SPACE) {
        assert.throws(() => sandbox.fileKeyOf(SPACE, spelling), sandbox.PathNamesTheSpaceError, `fileKeyOf ${JSON.stringify(spelling)}`);
        await assert.rejects(() => sandbox.peerFileKey(SPACE, spelling), sandbox.PathNamesTheSpaceError, `peerFileKey ${JSON.stringify(spelling)}`);
      }
    });

    it('a path that leaves the space is refused, on both', async () => {
      for (const spelling of LEAVES_THE_SPACE) {
        assert.throws(() => sandbox.fileKeyOf(SPACE, spelling), RangeError, `fileKeyOf ${JSON.stringify(spelling)}`);
        await assert.rejects(() => sandbox.peerFileKey(SPACE, spelling), RangeError, `peerFileKey ${JSON.stringify(spelling)}`);
      }
    });

    it('fileKeyOf touches no disk: it answers for a space whose directory does not exist and a path under a symlink-free root alike', () => {
      assert.equal(sandbox.fileKeyOf('no-such-space-dir', 'a//b').key, 'a/b');
    });
  });
});
