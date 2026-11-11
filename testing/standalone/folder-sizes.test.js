/**
 * Standalone tests for `rollUpDirRows` — the merged-listing roll-up.
 *
 * From the file-level FileMeta records under a directory it produces two things the Files list shows:
 *   • folderSizes — a folder's size is the sum of every file beneath it (nested files roll up).
 *   • fileMeta    — for files sitting DIRECTLY in the listed directory, their status + tags.
 * Chunk/derived records are excluded upstream (the DB query), so this pure step just pins the grouping:
 * nesting, loose files, the path prefix (root vs a sub-dir), and cross-member accumulation.
 *
 * Run: node --test testing/standalone/folder-sizes.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rollUpDirRows } from '../../server/dist/files/merged-listing.js';

const row = (path, sizeBytes, embeddingStatus, tags) => ({ path, sizeBytes, embeddingStatus, tags });

describe('rollUpDirRows', () => {
  it('at root: folders sum nested files; loose files carry their own metadata', () => {
    const rows = [
      row('docs/a.txt', 100),
      row('docs/sub/b.txt', 250),       // nested → rolls into `docs`
      row('images/x.png', 400),
      row('readme.md', 999, 'complete', ['top']),  // loose file at root
    ];
    const { folderSizes, fileMeta } = rollUpDirRows(rows, '');
    assert.equal(folderSizes.get('docs'), 350);   // 100 + 250
    assert.equal(folderSizes.get('images'), 400);
    assert.equal(fileMeta.get('readme.md').embeddingStatus, 'complete');
    assert.deepEqual(fileMeta.get('readme.md').tags, ['top']);
    assert.equal(fileMeta.has('docs'), false);    // a folder, not a direct file
  });

  it('under a sub-directory: prefix stripped; groups by IMMEDIATE child; direct files get metadata', () => {
    const rows = [
      row('docs/sub/b.txt', 250),
      row('docs/sub/deep/c.txt', 50),   // immediate child of docs/ is `sub`, not `deep`
      row('docs/loose.txt', 10, 'failed', ['x']),  // direct file in docs/
    ];
    const { folderSizes, fileMeta } = rollUpDirRows(rows, 'docs/');
    assert.equal(folderSizes.get('sub'), 300);    // 250 + 50 both under sub
    assert.equal(folderSizes.has('deep'), false); // deep is nested under sub
    assert.equal(fileMeta.get('loose.txt').embeddingStatus, 'failed');
    assert.deepEqual(fileMeta.get('loose.txt').tags, ['x']);
  });

  it('accumulates across calls (merging member spaces)', () => {
    const fs = new Map(), fm = new Map();
    rollUpDirRows([row('a/one.txt', 100)], '', fs, fm);
    rollUpDirRows([row('a/two.txt', 50), row('b.txt', 0, 'skipped', [])], '', fs, fm);
    assert.equal(fs.get('a'), 150);
    assert.equal(fm.get('b.txt').embeddingStatus, 'skipped');
  });

  it('empty input → empty maps (folders render 0 B, files show no status)', () => {
    const { folderSizes, fileMeta } = rollUpDirRows([], '');
    assert.equal(folderSizes.size, 0);
    assert.equal(fileMeta.size, 0);
  });
});
