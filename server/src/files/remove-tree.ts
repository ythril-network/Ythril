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
 * to, waiting `retryDelay × attempt` before each retry. Ten retries (eleven attempts) at 100 ms is about five and a half seconds, far longer
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
 * ## A destination that is not data
 *
 * A destination that exists is refused, and a caller that can PROVE what is there is not data says so (`replaceDestination`), here, so the
 * decision is made in one place and the refusal stays the default. `'if-empty'`: an empty directory is removed (`rmdir`, which cannot
 * remove one that gained an entry) and the move goes on. `'staging'`: a directory of any content is removed through `removeTree` first, for
 * a caller whose tree is upload staging that no configured space owns: a rename's `.chunks/<new>`, left by an old run or a late writer and
 * swept only after a day, which otherwise kept the rename's marker (and with it every other space operation) for that day. Never for a
 * tree that may hold a space's bytes: a non-empty `files/<new>` is refused. A destination that is not a directory is refused either way.
 *
 * The refusal is built as node builds one (`code`, `syscall`, `path`, `dest`) and its message names no path: a door words a file-system
 * error from its code alone (`util/fs-failure-words.ts`), which it can only do for an error that says it is one. Built with a `code` and no
 * `syscall`, it was answered as its message, which named the server's data root.
 *
 * `mustExist` keeps a caller's `force: false` meaning — a folder delete that should report a missing folder.
 */
import fs from 'node:fs/promises';
import { lstatIfPresent, isMissingPath } from './stored-bytes.js';

/** Retries (not attempts: one more attempt than this is made) for what a concurrent holder causes; see the docblock for the arithmetic. */
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

/** What a move may do about a destination that already exists: clear an empty directory, or clear upload staging of any content. Absent: refuse. */
export type ReplaceDestination = 'if-empty' | 'staging';

/**
 * Move a directory tree to a path that does not exist yet (or, by `replaceDestination`, to one that holds nothing worth keeping), waiting
 * out what holds it.
 *
 * `'absent'`: the source is not there (nothing to move, or it already moved). `'replaced'`: moved after a destination that held entries
 * was removed (`'staging'`; the caller says so in its log: an empty directory removed is `'moved'`). It throws when the destination exists
 * and may not be replaced, and with the last error when a holder outlasts the retries.
 */
export async function moveTree(
  src: string, dst: string, opts: { replaceDestination?: ReplaceDestination } = {},
): Promise<'moved' | 'absent' | 'replaced'> {
  if ((await lstatIfPresent(src)) === null) return 'absent';
  const cleared = await clearDestination(src, dst, opts.replaceDestination);
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(src, dst);
      return cleared ? 'replaced' : 'moved';
    } catch (err) {
      const code = codeOf(err);
      if (isMissingPath(err)) return 'absent';
      if (code === undefined || !MOVE_RETRY_CODES.has(code) || attempt > TREE_RETRIES) throw err;
      await wait(TREE_RETRY_DELAY_MS * attempt);
    }
  }
}

/** The refusal of a destination that exists, as node words its own (`syscall`), with a message that names no path. */
const destinationExists = (src: string, dst: string): Error =>
  Object.assign(new Error('EEXIST: file already exists, rename'), { code: 'EEXIST', syscall: 'rename', path: src, dest: dst });

/** Make room at `dst` when `policy` allows and what is there is not data; throws the refusal otherwise. True when entries were removed. */
async function clearDestination(src: string, dst: string, policy: ReplaceDestination | undefined): Promise<boolean> {
  const there = await lstatIfPresent(dst);
  if (there === null) return false;
  if (policy === undefined || !there.isDirectory()) throw destinationExists(src, dst);
  if ((await fs.readdir(dst)).length === 0) {
    // `rmdir` removes an empty directory and nothing else: a writer that put an entry there since the listing makes it fail, not lose it.
    try {
      await fs.rmdir(dst);
    } catch (err) {
      throw codeOf(err) === 'ENOTEMPTY' ? destinationExists(src, dst) : err;
    }
    return false;
  }
  if (policy !== 'staging') throw destinationExists(src, dst);
  await removeTree(dst);
  return true;
}
