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
 * The server keeps connections the way the product's does (`configureConnections`, which `server/src/index.ts` applies to the server it
 * creates): without its 95 s keep-alive the test server closes an idle connection after Node's default 5 s, and a client that reuses a
 * pooled connection after a busy gap in this same process (a case's assertions, a loaded machine) has a request reset a few
 * milliseconds after it is sent. A caller cannot drop the setting: it is applied here, before the server listens.
 *
 * @returns {Promise<{ url: string, port: number, httpServer: import('node:http').Server, close: () => Promise<void> }>} `close()` ends
 *   the server, then scheduling; a second call is a no-op.
 */
export async function listenApp() {
  const { createApp } = await import('../../server/dist/app.js');
  const { configureConnections } = await import('../../server/dist/http-connections.js');
  const httpServer = http.createServer(createApp());
  configureConnections(httpServer);
  const server = await listenOnLoopback(httpServer);
  let closed = false;
  return {
    url: server.url,
    port: server.port,
    httpServer,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await endScheduling();
    },
  };
}

/**
 * An express app a test BUILT (the product's routers mounted on an `express()` of its own) served on loopback.
 *
 * The question it answers is `listenApp`'s for a test whose subject is a router or a middleware and not the whole application, and
 * what it prevents is the same: a server made with `http.createServer(app)` keeps Node's 5 s keep-alive, closes an idle connection after
 * it, and a client that reuses a pooled connection after a busy gap in this process (a case's assertions, a loaded machine) has a request
 * reset a few milliseconds after it is sent. The product's `configureConnections` is applied here, before the server listens, so no
 * caller can drop it. It starts no scheduling and so has none to end; `close()` ends the server and its open sockets, as `listenOnLoopback`
 * does, and a second call is a no-op.
 *
 * Not for the application itself (`listenApp`), and not for a fake peer or a stub the code under test calls: those are not the
 * product's server and have no connection settings of the product's to keep.
 *
 * @param {import('express').Express} app built, not yet served
 * @returns {Promise<{ url: string, port: number, httpServer: import('node:http').Server, close: () => Promise<void> }>}
 */
export async function listenRouterApp(app) {
  const { configureConnections } = await import('../../server/dist/http-connections.js');
  const httpServer = http.createServer(app);
  configureConnections(httpServer);
  const server = await listenOnLoopback(httpServer);
  return { url: server.url, port: server.port, httpServer, close: server.close };
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
