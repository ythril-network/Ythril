/**
 * `mutateConfig` for a writer that runs in the background and must not give up on a read a concurrent writer
 * spoiled.
 *
 * ## Why it exists
 *
 * `mutateConfig` re-reads config.json before applying a change, so an edit made in the meantime is merged rather
 * than erased. On Docker Desktop the file is a bind mount, and a read that lands while the host is rewriting it
 * fails with `ENODATA` — not a fault, a moment. `finalizeSpaceIndexReady` took that first failure as final, so a
 * new space stayed `building` until the next restart (found verifying `Q-99` part 3, 2026-10-01, by
 * `config-write-safety`'s readiness case). A request handler can let such an error reach its caller, who retries;
 * a background writer has no caller, so the retry has to be here.
 *
 * ## What is retried, and what is not
 *
 * Only the errors a concurrent writer causes, and a bounded number of times: a real fault — a permission, a
 * corrupt file — is thrown at once, because retrying it only delays the report. The bound is about a second and
 * a half in all, far longer than a host write of a config file takes.
 */
import { mutateConfig } from './loader.js';
import type { Config } from './types.js';

/** The read errors a concurrent writer causes on a bind-mounted file. */
const TRANSIENT_READ_CODES: ReadonlySet<string> = new Set(['ENODATA', 'EBUSY', 'EAGAIN']);

export const CONFIG_WRITE_ATTEMPTS = 6;
const RETRY_DELAY_MS = 100;

export async function mutateConfigRetrying(apply: (config: Config) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      mutateConfig(apply);
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== 'string' || !TRANSIENT_READ_CODES.has(code) || attempt >= CONFIG_WRITE_ATTEMPTS) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}
