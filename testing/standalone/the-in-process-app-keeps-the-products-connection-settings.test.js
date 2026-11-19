/**
 * The application a test serves in-process keeps connections the way the product's server does (`Q-73`; bundle-348).
 *
 * ## The defect it prevents
 *
 * `server/src/index.ts` applies `configureConnections` to the server it creates: a 95 s keep-alive, so the server is the side that gives up
 * on an idle connection last. `listenApp()` built its server with `http.createServer(createApp())` and applied nothing, so a test's server
 * closed an idle connection after Node's default 5 s. A client reuses a pooled connection it believes is fresh; when the process was busy for
 * more than that (a case's assertions, `freshSpace()`, a loaded machine) the server woke, found the connection idle past its limit by its own
 * clock, and closed it with a request already sent on it. The store-failure gate saw `ECONNRESET` a few milliseconds after the first door of
 * every case from the second on, and reported every door that way as "no answer within 20000 ms".
 *
 * ## What it holds
 *
 * 1. The server `listenApp()` hands back carries the keep-alive and header timeouts of a server `configureConnections` configured, read
 *    from the product's own module and never typed here, and a bare server's differ (so the comparison cannot hold for nothing).
 * 2. The race itself, in the shape of `a-busy-server-does-not-drop-a-request-sent-on-an-idle-connection`: a connection goes idle, this
 *    process is busy for longer than a bare server's keep-alive, and a request sent on that connection straight after is answered.
 *
 * Run: node --test testing/standalone/the-in-process-app-keeps-the-products-connection-settings.test.js (a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenApp } from '../_shared/in-process-app.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance } from './_vote-round-instance.mjs';

/** One request on a chosen agent, so the test decides which socket is reused. */
const request = (agent, url) => new Promise((resolve) => {
  const req = http.get(url, { agent }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
  req.on('error', (err) => resolve({ error: err.code ?? err.message }));
});

describe('the in-process application keeps the product\'s connection settings', () => {
  let dir; let app; let configureConnections;

  before(async () => {
    dir = tempInstanceDir('ythril-b348-connections-');
    await bootInstance(dir, { instanceId: 'cccccccc-0000-4000-8000-00000000b348' });
    ({ configureConnections } = await import('../../server/dist/http-connections.js'));
    app = await listenApp();
  });
  after(async () => { await app?.close(); removeInstanceDir(dir); });

  it('its server has the keep-alive and header timeouts the product gives its own', () => {
    assert.ok(app.httpServer instanceof http.Server, 'listenApp() does not hand back the http server it started');
    const bare = http.createServer();
    const product = http.createServer();
    configureConnections(product);
    assert.notEqual(bare.keepAliveTimeout, product.keepAliveTimeout, 'configureConnections changes nothing on a bare server: the comparison below would hold for nothing');
    assert.equal(app.httpServer.keepAliveTimeout, product.keepAliveTimeout, 'the keep-alive timeout is not the product\'s');
    assert.equal(app.httpServer.headersTimeout, product.headersTimeout, 'the header timeout is not the product\'s');
  });

  it('a request sent on an idle connection after this process was busy for longer than a bare server\'s keep-alive is answered', { timeout: 30_000 }, async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      assert.deepEqual(await request(agent, `${app.url}/health`), { status: 200 }, 'the first request must be answered');
      // Busy, not asleep: a server that was idle when its timer fired closes the connection cleanly and the client learns of it; a server whose
      // loop was held finds the connection idle past its limit when it next looks, with the client's next request already sent on it.
      const until = Date.now() + new http.Server().keepAliveTimeout + 1_000;
      while (Date.now() < until);
      assert.deepEqual(await request(agent, `${app.url}/health`), { status: 200 },
        'the server closed an idle connection with a request already sent on it: its keep-alive is shorter than the product\'s');
    } finally { agent.destroy(); }
  });
});
