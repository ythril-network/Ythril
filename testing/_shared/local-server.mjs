/**
 * Start a server a test owns on this machine, and END it without waiting for a client that will never leave.
 *
 * ## The question it answers
 *
 * "How does a test start a throwaway server on loopback and reliably stop it?" - asked by the two fakes
 * (`fake-ythril-tool-server.mjs`, `fake-github-actions.mjs`), by the TCP relay (`standalone/_tcp-relay.mjs`) and by the
 * closed-port helper (`closed-port.mjs`). Each had written the same shell.
 *
 * ## What it prevents
 *
 * - **A `close()` that never finishes.** `server.close()` waits for every connection to end. An HTTP client's keep-alive
 *   socket, or a fake that deliberately never answers (`hang()`), keeps it waiting, and the test hangs at teardown
 *   instead of failing. Every accepted socket is remembered from the moment the server accepts it - the listener is
 *   attached BEFORE `listen`, so none is missed - and `close()` destroys them, then closes.
 * - **A server on the wrong interface.** It binds `127.0.0.1` only, never `0.0.0.0`: a fake that answers a token is
 *   not for the network, and a CI runner is a shared host.
 * - **A second `close()` throwing.** Teardown runs from a `finally` and from `after`; closing an already-closed server
 *   is a no-op here, not `ERR_SERVER_NOT_RUNNING`.
 *
 * ## What it is not
 *
 * Not the place a handler is written: it takes a server that is built and not yet listening (`http.createServer(fn)`,
 * `net.createServer(fn)`), and gives back where it is and how to end it.
 */

/**
 * @param {import('node:net').Server} server built, not listening
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>} `url` is `http://127.0.0.1:<port>`
 *   (the origin of an http server; a plain TCP server uses `port`)
 */
export async function listenOnLoopback(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      // The callback's error (the server was not running) is the answer to "already closed", not a failure.
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
