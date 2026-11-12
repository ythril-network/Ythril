/**
 * The restore check does not call a row "no bytes" for a path its walk may never have looked at (bundle-70, duplicate-rule pass).
 *
 * ## The defect
 *
 * A manifest names at most 1000 paths it could not look at and says when it cut the list (`unreadableTruncated`). Every other reader of the
 * pair treats a path the walk did not read as "possibly one of the cut ones" once the list is cut (the absent-bytes sweep, both legs of a file
 * sync). `classifyDiskAgainstRows` (the restore check, `files/disk-against-rows.ts`) asked only whether the path was NAMED, so on a cut list a
 * row whose bytes sat at an unnamed unreadable path was reported `row_without_bytes`, and the restore would ask for the bytes to be restored
 * over bytes that are there.
 *
 * ## The rule
 *
 * "Could not look at this path" has one spelling, `UnreadablePaths.couldNotLook` (`files/unreadable-paths.ts`), and the restore check asks it:
 * a row at a path the walk did not carry is in no class while the list is cut, and `row_without_bytes` again when it is whole. A row whose
 * path the walk DID carry is judged as ever, cut or not.
 *
 * Pure: `classifyDiskAgainstRows` reads no disk and no database. Run: node --test testing/standalone/a-cut-unreadable-list-puts-no-row-in-row-without-bytes.test.js
 * (requires `npm run build -w @ythril/server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const SHA = 'a'.repeat(64);
let classify;
let UnreadablePaths;

before(async () => {
  ({ classifyDiskAgainstRows: classify } = await import('../../server/dist/files/disk-against-rows.js'));
  ({ UnreadablePaths } = await import('../../server/dist/files/unreadable-paths.js'));
});

const row = (over = {}) => ({ sha256: SHA, embeddingStatus: 'done', ...over });

describe('the restore check and a cut list of unreadable paths', () => {
  const held = () => new Map([['here.txt', row()], ['never-looked.txt', row()], ['named/inside.txt', row()]]);
  const disk = [{ path: 'here.txt', sha256: SHA }];

  it('a whole list: a row whose path is neither on disk nor named is row_without_bytes', () => {
    const c = classify(disk, held(), ['named/'], false);
    assert.deepEqual(c.row_without_bytes, ['never-looked.txt'], 'the control: a path the walk looked at and did not find is gone');
  });

  it('a cut list: a row whose path the walk did not carry may be one of the cut ones, so it is in no class', () => {
    const c = classify(disk, held(), ['named/'], true);
    assert.deepEqual(c.row_without_bytes, [],
      'the list was cut: a path it does not name may be one it could not look at, and "no bytes" there would have the restore overwrite bytes that are there');
  });

  it('a cut list: a row whose path the walk carried is judged as ever', () => {
    const c = classify(disk, new Map([['here.txt', row({ sha256: 'b'.repeat(64) })]]), [], true);
    assert.deepEqual(c.stale_row, ['here.txt']);
  });

  it('the shared question: named or under a named directory, or (cut) not carried', () => {
    const names = new UnreadablePaths(['d/', 'locked.txt']);
    const carried = new Set(['seen.txt']);
    for (const [key, cut, expected] of [
      ['d/x', false, true], ['locked.txt', false, true], ['other.txt', false, false], ['dd/x', false, false],
      ['other.txt', true, true], ['seen.txt', true, false], ['seen.txt', false, false],
    ]) {
      assert.equal(names.couldNotLook(key, cut, carried), expected, `${key}, list cut: ${cut}`);
    }
  });
});
