/**
 * The files each shard table is written for, by kind, and where the pure table lives (bundle-373, Q-977).
 *
 * One question: *which files do CI's text, pure and database kinds run, by repository path?* The answer is the split's own
 * (`splitStandalone`, `textOnlyFiles`), so `testing/_init/record-shard-seconds.mjs` writes its tables for exactly the files the
 * plans cut, and holds no second classification. It lives here and not in the writer because a script that imports the split
 * is a runner by the rule of `a-db-file-runs-in-a-capped-batch` (it must run the plan, with the timing reporter), and a writer of tables runs no test.
 */
import { splitStandalone, PURE_FILE_SECONDS_PATH } from './standalone-split.mjs';
import { textOnlyFiles } from './text-only-test.mjs';

export { PURE_FILE_SECONDS_PATH };

/**
 * @param {{ root?: string }} [opts] the checkout to list (default the working directory)
 * @returns {{ textKind: string[], pureKind: string[], dbKind: string[] }} repository paths under testing/standalone
 */
export function shardTableFiles({ root = process.cwd() } = {}) {
  const split = splitStandalone({ root });
  const path = (f) => `testing/standalone/${f}`;
  const text = new Set(textOnlyFiles(split, { root }));
  const pureAll = split.offlinePure.map(path);
  return {
    textKind: pureAll.filter((f) => text.has(f)),
    pureKind: pureAll.filter((f) => !text.has(f)),
    dbKind: split.offlineDb.map(path),
  };
}
