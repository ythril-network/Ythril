/**
 * Start `_media-job-child.mjs` and talk to it: the parent's half of "run a media job in a process of its own" (bundle-89, Q-425).
 *
 * What it settles once, so no test spells it differently: the child's temp directory is a private one (`tmp`, handed back), its
 * environment is the runner's scrubbed one (`testChildEnv`) plus the harness Mongo address, and every message the child sends is
 * kept in order so a test can wait for one by type and still read the ones before it.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '_media-job-child.mjs');

/**
 * @param {object} scenario  what `_media-job-child.mjs` reads (`scenario`, `suite`, ...)
 * @returns {{ tmp: string, messages: object[], waitForMessage: (type: string, ms?: number) => Promise<object>, kill: () => Promise<void>,
 *   exited: Promise<number|null>, cleanup: () => void }}
 */
export function startMediaJobChild(scenario) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89-child-'));
  const messages = [];
  const child = fork(CHILD, [], {
    env: testChildEnv({ B89_CHILD: JSON.stringify(scenario), TEMP: tmp, TMP: tmp, TMPDIR: tmp }),
    // The memory scenarios need a runtime that reports its own peak; nothing else is wanted of the child's flags.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', (m) => messages.push(m));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    tmp, messages, exited,
    async waitForMessage(type, ms = 120_000) {
      await waitFor(() => messages.some(m => m.type === type || m.type === 'error'), ms, 100,
        () => `the child never said ${type}: ${JSON.stringify(messages)}`);
      const err = messages.find(m => m.type === 'error');
      if (err) throw new Error(`the child failed: ${err.message}`);
      return messages.find(m => m.type === type);
    },
    /** End it the way an out-of-memory kill does: no handler runs, nothing is cleaned up. */
    async kill() { child.kill('SIGKILL'); await exited; },
    cleanup() { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}
