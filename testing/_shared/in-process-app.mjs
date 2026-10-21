/**
 * Start the Ythril application inside a test process, and end it so the process can exit (`Q-570`, `Q-474`).
 *
 * ## The question it answers
 *
 * "How does a test run the real application in-process and stop everything it started?" - asked by every test and
 * fixture that calls `createApp()`. The callers are not listed here; `one-door-starts-the-app-in-a-test.test.js` holds that
 * no other testing file imports `server/dist/app.js`.
 *
 * ## What it prevents
 *
 * `createApp()` starts the config watcher, and a reload the watcher triggers re-arms the cron schedulers. Each caller used to
 * tear down by closing its server and its database, and none stopped the watcher or the schedulers: a reload that re-armed
 * the sync cron during or after that teardown left node-cron's timers holding the process, and CI's database job ran into
 * its 30-minute limit and was cancelled (PR #1511, PR #1523). `close()` here ends with the server's own `closeScheduling()`,
 * the same step the shutdown handler takes, so the list of what "stop scheduling" means lives once, in the server.
 *
 * Closing scheduling closes cron ARMING for the rest of the process: a test that needs a cron task armed after an app
 * closed in the same file is asking a question this helper does not answer.
 *
 * Requires a prior `npm run build` in server/.
 */
import http from 'node:http';
import { listenOnLoopback } from './local-server.mjs';

/** How long close() waits for a config reload still running before closing arming anyway. */
const SETTLE_MS = 5_000;

async function endScheduling() {
  const { closeScheduling } = await import('../../server/dist/schedulers.js');
  await closeScheduling({ withinMs: SETTLE_MS });
}

/**
 * The application served on loopback.
 *
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>} `close()` ends the server, then scheduling;
 *   a second call is a no-op.
 */
export async function listenApp() {
  const { createApp } = await import('../../server/dist/app.js');
  const server = await listenOnLoopback(http.createServer(createApp()));
  let closed = false;
  return {
    url: server.url,
    port: server.port,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await endScheduling();
    },
  };
}

/**
 * The application as a router a test calls directly, with no server.
 *
 * @returns {Promise<{ router: import('express').Express, close: () => Promise<void> }>} `close()` ends scheduling; a second
 *   call is a no-op.
 */
export async function appRouter() {
  const { createApp } = await import('../../server/dist/app.js');
  const router = createApp();
  let closed = false;
  return {
    router,
    async close() {
      if (closed) return;
      closed = true;
      await endScheduling();
    },
  };
}
