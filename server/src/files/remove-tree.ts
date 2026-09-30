/**
 * Remove a directory tree that something else may still be writing into — the one way a space's directories are
 * removed.
 *
 * ## Why this exists
 *
 * A space delete removed `/data/files/<space>` with `fs.rm(dir, { recursive: true, force: true })`, and `force`
 * forgives exactly one thing: a path that is already gone. A recursive remove lists a directory, removes its
 * children, then removes the directory — and a writer that creates an entry between the last two steps makes the
 * final `rmdir` fail with `ENOTEMPTY`. The media worker converting a transcript while its space was deleted did
 * exactly that (Docker integration run of bundle-27, 13:30:47Z); the delete stopped half done, kept its
 * `pendingSpaceOp` marker, and every later space delete and rename on the instance was refused behind it.
 *
 * Node retries the errors a concurrent writer causes — `ENOTEMPTY`, `EBUSY`, `EPERM`, `EMFILE`, `ENFILE` — when told
 * to, waiting `retryDelay × attempt` between tries. Ten tries at 100 ms is about five and a half seconds, far longer
 * than any writer that started before the space stopped taking writes (`spaces/space-write-gate.ts`) needs to finish.
 * The gate stops new writers; this outlasts the ones already in flight. Either alone leaves a window.
 *
 * `mustExist` keeps a caller's `force: false` meaning — a folder delete that should report a missing folder.
 */
import fs from 'node:fs/promises';

/** Retries for what a concurrent writer causes; see the docblock for the arithmetic. */
export const REMOVE_TREE_RETRIES = 10;
export const REMOVE_TREE_RETRY_DELAY_MS = 100;

export async function removeTree(dir: string, opts: { mustExist?: boolean } = {}): Promise<void> {
  await fs.rm(dir, {
    recursive: true,
    force: !opts.mustExist,
    maxRetries: REMOVE_TREE_RETRIES,
    retryDelay: REMOVE_TREE_RETRY_DELAY_MS,
  });
}
