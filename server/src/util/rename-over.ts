/**
 * Rename a freshly written file over the one it replaces, riding out the moment another handle holds the target open.
 *
 * ## What it prevents
 *
 * Every state file this server owns (`config.json`, the secrets file, the schema library and catalogues) is saved by writing a
 * temporary file and renaming it over the real one. On Windows that rename is refused (`EPERM`, `EACCES`, `EBUSY`) for as long as
 * anything has the target open, a reader of the same file included, and a refusal there failed the save: the vote-round expiry
 * logged "the config could not be saved" and retried a tick later, and the test of it failed in preflight runs on a Windows host.
 * A refusal of that kind is retried here a few times, a few milliseconds apart, and only then thrown. On Linux, where a rename over
 * an open file always succeeds, the first attempt is the only one.
 *
 * It stays synchronous on purpose: the config flush checks the generation and renames in ONE synchronous step (Q-638), and an
 * await between them would let an older snapshot land over a newer save.
 */
import fs from 'node:fs';

/** The refusals a rename over a file another handle holds open answers on Windows; anything else is thrown at once. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 20;

/** A synchronous pause that blocks no other thread's work and arms no timer. */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `fs.renameSync(src, dst)`, retrying a transient refusal (see the module docblock). Throws the last error when every attempt is refused. */
export function renameOverSync(src: string, dst: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      pauseSync(RENAME_RETRY_MS);
    }
  }
}
