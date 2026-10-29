/**
 * Change a directory tree that something else may still be holding or writing into — the one way a space's directories
 * are removed (`removeTree`) or moved (`moveTree`).
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
 * ## The move is the same question (Q-171)
 *
 * On Windows a directory cannot be renamed while any handle is open under it: `rename` answers `EPERM` at once, and a
 * download stream, a media read, ffmpeg or an indexer on the host holds one without being a counted writer. The rename of a
 * space moved `files/<old>` with a bare `fs.rename` and failed on it, and moved `.chunks/<old>` inside a `catch {}` and left
 * it behind while answering success. `moveTree` waits out the same holders by the same rule, so the two directions cannot
 * drift apart: one set of constants, one delay arithmetic. A second module would hold a second copy of that rule.
 *
 * What differs is only what each can meet. A move retries the codes a holder causes (`MOVE_RETRY_CODES`: node's own set
 * for a remove, without `ENOTEMPTY`, which a rename of a directory onto an existing one answers, plus `EACCES`, the other
 * answer a held directory gets). An existing destination fails at once and is never retried — Windows answers it with `EPERM`
 * too, and waiting five seconds for the same refusal helps nobody. A missing source answers `'absent'`, so a rename that
 * is resumed after its directory already moved is not an error.
 *
 * `mustExist` keeps a caller's `force: false` meaning — a folder delete that should report a missing folder.
 */
import fs from 'node:fs/promises';
import { bytesPresent, isMissingPath } from './stored-bytes.js';

/** Retries for what a concurrent holder causes; see the docblock for the arithmetic. */
export const TREE_RETRIES = 10;
export const TREE_RETRY_DELAY_MS = 100;

/** The codes a holder of a path causes a move: retried. Anything else (a missing source, a refusal that waiting cannot change) is final. */
const MOVE_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function removeTree(dir: string, opts: { mustExist?: boolean } = {}): Promise<void> {
  await fs.rm(dir, {
    recursive: true,
    force: !opts.mustExist,
    maxRetries: TREE_RETRIES,
    retryDelay: TREE_RETRY_DELAY_MS,
  });
}

/**
 * Move a directory tree to a path that does not exist yet, waiting out what holds it.
 *
 * `'absent'`: the source is not there (nothing to move, or it already moved). It throws when the destination exists, and
 * with the last error when a holder outlasts the retries.
 */
export async function moveTree(src: string, dst: string): Promise<'moved' | 'absent'> {
  if (!(await bytesPresent(src))) return 'absent';
  if (await bytesPresent(dst)) {
    throw Object.assign(new Error(`EEXIST: the destination already exists, rename '${src}' -> '${dst}'`), { code: 'EEXIST' });
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(src, dst);
      return 'moved';
    } catch (err) {
      const code = codeOf(err);
      if (isMissingPath(err)) return 'absent';
      if (code === undefined || !MOVE_RETRY_CODES.has(code) || attempt > TREE_RETRIES) throw err;
      await wait(TREE_RETRY_DELAY_MS * attempt);
    }
  }
}
