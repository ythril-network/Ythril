/**
 * A compile-cache folder a killed entry-module run left behind is removed by the next run (Q-871, bundle-316 sweep F12).
 *
 * ## The defect this refuses
 *
 * `loadAll` makes one `NODE_COMPILE_CACHE` folder under the scratch root and removes it in `finally`. When the batch bound SIGKILLs the test process, `finally`
 * never runs and the folder stays outside the checkout for ever (never read again: each run makes its own, so no stale entry is used, but a developer's
 * scratch root piles up). The next `loadAll` sweeps the folders of its own prefix that are older than the longest a run may take, and leaves a younger one alone,
 * because a shard running beside it owns that folder.
 *
 * Run: node --test testing/standalone/the-entry-module-load-sweeps-an-old-compile-cache-folder.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from './_entry-module-load.mjs';

describe('loadAll', () => {
  it('removes an old compile-cache folder of its own prefix, leaves a young one and an unrelated folder, and leaves none of its own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cache-sweep-'));
    const before = process.env['YTHRIL_TEMP_ROOT'];
    process.env['YTHRIL_TEMP_ROOT'] = root;
    try {
      const old = join(root, 'entry-module-compile-cache-old');
      const young = join(root, 'entry-module-compile-cache-young');
      const other = join(root, 'something-else-old');
      for (const dir of [old, young, other]) mkdirSync(dir);
      const longAgo = new Date(Date.now() - 48 * 3_600_000);
      for (const dir of [old, other]) utimesSync(dir, longAgo, longAgo);
      await loadAll([], { parallel: 1 });
      assert.equal(existsSync(old), false, 'an old compile-cache folder of a killed run is still there');
      assert.equal(existsSync(young), true, 'a young folder (a shard running beside this one) was removed');
      assert.equal(existsSync(other), true, 'a folder that is not a compile cache was removed');
      assert.deepEqual(readdirSync(root).sort(), ['entry-module-compile-cache-young', 'something-else-old'], 'the run left its own folder behind');
    } finally {
      if (before === undefined) delete process.env['YTHRIL_TEMP_ROOT']; else process.env['YTHRIL_TEMP_ROOT'] = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
