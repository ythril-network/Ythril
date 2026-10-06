/**
 * A TCP relay in front of a test service is written ONCE, `testing/standalone/_tcp-relay.mjs` (bundle-56 dedup, item 9).
 *
 * ## What this prevents
 *
 * `driverWriteFailures` (`_write-faults.mjs`) wrote a pass-through relay to the test MongoDB: listen, connect each
 * client to the real port, pipe both ways, remember the sockets so the relay can be torn down. `_delayed-write-relay.mjs`
 * (Q-372) wrote it again, with message framing and a delay on top. The shell is the half a copy gets wrong:
 *
 * - **An `'error'` on either socket with no listener** is an uncaught exception that ends the test process. A relay
 *   exists to be reset on purpose, so every socket it holds swallows its own error.
 * - **One half closing and not the other.** A relay whose upstream is gone and whose client is still connected makes
 *   the client wait for an answer that cannot come, and the driver's "the store went away" shape is never produced.
 * - **A write after the upstream died** (a delayed forward whose timer fires late) is an `ERR_STREAM_DESTROYED`.
 * - **`close()` that leaves connections open**, so the port is not free and the driver keeps a live connection.
 *
 * What differs between the two relays is only what happens to the client's bytes on their way to the server, and that is
 * the one hook: `clientToServer`. A third use (`_freezable-relay.mjs`, bundle-53) must also stop the SERVER's bytes - a store
 * that has frozen says nothing, with its sockets open - so there is a symmetrical, optional `serverToClient`. It is a hook
 * on this module because the gate below refuses a second relay: the alternative was a second `net.createServer`.
 *
 * Run: node --test testing/standalone/a-tcp-relay-is-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const MODULE = 'testing/standalone/_tcp-relay.mjs';
const load = () => import(pathToFileURL(resolve(REPO_ROOT, MODULE)).href);

const within = (promise, what, ms = 3000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref()),
]);

/** A real TCP service to relay to: echoes every byte, and keeps its live sockets so a test can break them. */
async function startEcho() {
  const sockets = new Set();
  const local = await listenOnLoopback(net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    s.pipe(s);
  }));
  return { ...local, sockets };
}

/** A client connected to `port`; `received()` is everything read so far, `closed` settles when the connection ends. */
async function connect(port) {
  const socket = net.connect(port, '127.0.0.1');
  let text = '';
  socket.on('data', (d) => { text += d; });
  socket.on('error', () => {});
  const closed = new Promise((r) => socket.once('close', r));
  await within(new Promise((r) => socket.once('connect', r)), 'a client to connect');
  return { socket, closed, received: () => text, send: (t) => socket.write(t) };
}

const until = (what, predicate) => waitFor(predicate, 3000, 5, undefined, { what });

describe('startTcpRelay', () => {
  it('carries bytes both ways to the service it is pointed at, on a port of its own', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    const relay = await startTcpRelay({ host: '127.0.0.1', port: echo.port });
    try {
      assert.notEqual(relay.port, echo.port);
      assert.equal(relay.address, `127.0.0.1:${relay.port}`);
      const client = await connect(relay.port);
      client.send('hello');
      await until('the echo to come back through the relay', () => client.received() === 'hello');
    } finally { await relay.close(); await echo.close(); }
  });

  it('lets the caller shape the client-to-server bytes: the hook is built once per connection and sees every chunk', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    let connections = 0;
    const relay = await startTcpRelay({
      host: '127.0.0.1',
      port: echo.port,
      clientToServer: (forward) => { connections += 1; return (chunk) => forward(Buffer.from(chunk.toString('utf8').toUpperCase())); },
    });
    try {
      const a = await connect(relay.port);
      const b = await connect(relay.port);
      a.send('one'); b.send('two');
      await until('both echoes', () => a.received() === 'ONE' && b.received() === 'TWO');
      assert.equal(connections, 2, 'the hook is per connection: state it keeps must not leak across clients');
    } finally { await relay.close(); await echo.close(); }
  });

  it('lets the caller shape the server-to-client bytes too: built once per connection, sees every reply, and can drop one', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    let connections = 0;
    const seen = [];
    const relay = await startTcpRelay({
      host: '127.0.0.1',
      port: echo.port,
      // The reply hook is what lets a relay FREEZE a store: dropping what the server says while both sockets stay open.
      serverToClient: (forward) => {
        connections += 1;
        return (chunk) => { seen.push(chunk.toString('utf8')); if (!chunk.toString('utf8').startsWith('drop')) forward(chunk); };
      },
    });
    try {
      const a = await connect(relay.port);
      const b = await connect(relay.port);
      a.send('keep-a');
      await until('a reply to come back through the hook', () => a.received() === 'keep-a');
      a.send('drop-this');
      await until('the hook to see the reply it drops', () => seen.includes('drop-this'));
      a.send('keep-again');
      await until('a later reply to pass', () => a.received() === 'keep-akeep-again');
      assert.ok(!a.received().includes('drop'), 'the reply the hook dropped reached the client');
      assert.equal(a.socket.destroyed, false, 'dropping a reply must leave the connection open');
      b.send('keep-b');
      await until('the second connection to be served', () => b.received() === 'keep-b');
      assert.equal(connections, 2, 'the reply hook is per connection: state it keeps must not leak across clients');
    } finally { await relay.close(); await echo.close(); }
  });

  it('with no reply hook the server\'s bytes pass untouched and whole, and both ends still close together', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    const relay = await startTcpRelay({ host: '127.0.0.1', port: echo.port, clientToServer: (forward) => forward });
    try {
      const client = await connect(relay.port);
      const big = 'x'.repeat(200_000);
      client.send(big);
      await until('a payload larger than one chunk to come back whole', () => client.received() === big);
      for (const s of echo.sockets) s.destroy();
      await within(client.closed, 'the client to be closed when the service went');
    } finally { await relay.close(); await echo.close(); }
  });

  it('a forward made after the service went away is dropped, not thrown', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    let held;
    const relay = await startTcpRelay({ host: '127.0.0.1', port: echo.port, clientToServer: (forward) => { held = forward; return (chunk) => forward(chunk); } });
    try {
      const client = await connect(relay.port);
      client.send('x');
      await until('the first byte to arrive', () => client.received() === 'x');
      for (const s of echo.sockets) s.destroy();
      await within(client.closed, 'the client to be closed when the service went');
      assert.doesNotThrow(() => held(Buffer.from('late')));
    } finally { await relay.close(); await echo.close(); }
  });

  it('when the service resets a connection the relay survives, and the client is closed with it', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    const relay = await startTcpRelay({ host: '127.0.0.1', port: echo.port });
    try {
      const first = await connect(relay.port);
      first.send('x');
      await until('the first connection to be established', () => first.received() === 'x');
      for (const s of echo.sockets) s.resetAndDestroy();
      await within(first.closed, 'the client to be closed after a reset upstream');
      const second = await connect(relay.port);
      second.send('again');
      await until('a new connection to work', () => second.received() === 'again');
    } finally { await relay.close(); await echo.close(); }
  });

  it('when the client goes the service sees its connection close', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    const relay = await startTcpRelay({ host: '127.0.0.1', port: echo.port });
    try {
      const client = await connect(relay.port);
      client.send('x');
      await until('the service to hold a connection', () => echo.sockets.size === 1);
      client.socket.destroy();
      await until('the service to see it close', () => echo.sockets.size === 0);
    } finally { await relay.close(); await echo.close(); }
  });

  it('close() resets every live connection, frees the port, and is safe twice', async () => {
    const { startTcpRelay } = await load();
    const echo = await startEcho();
    const relay = await startTcpRelay({ host: '127.0.0.1', port: echo.port });
    try {
      const client = await connect(relay.port);
      client.send('x');
      await until('the connection to carry a byte', () => client.received() === 'x');
      await within(relay.close(), 'close() to finish');
      await within(client.closed, 'the live client to be reset');
      await relay.close();
      const code = await new Promise((r) => { const s = net.connect(relay.port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r('connected'); }); s.once('error', (e) => r(e.code)); });
      assert.equal(code, 'ECONNREFUSED', 'the relay still accepts connections after close()');
    } finally { await relay.close(); await echo.close(); }
  });
});

describe('no helper writes its own relay', () => {
  /*
   * Derived, never listed: every tracked helper (non-test source) under testing/. A hand-written relay is a TCP server
   * that opens a client connection of its own for each client it accepts - `net.createServer(` and `net.connect(` in one
   * file. A fake that only serves, or only dials, has one of them.
   */
  it('only the relay module accepts a connection and dials a second one', () => {
    const files = trackedSources(['testing'], { ext: ['.mjs', '.js'], floor: 500, exclude: [MODULE] }).filter((f) => !f.endsWith('.test.js'));
    assert.ok(files.length >= 100, `the scan saw only ${files.length} helpers`);
    const copies = files.filter((f) => {
      const text = stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
      return /\bnet\.createServer\(/.test(text) && /\bnet\.connect\(/.test(text);
    });
    assert.deepEqual(copies, [], `these relay TCP themselves; use startTcpRelay from ${MODULE}`);
  });

  it('the two relays to MongoDB import the module', () => {
    for (const f of ['testing/standalone/_delayed-write-relay.mjs', 'testing/standalone/_write-faults.mjs']) {
      assert.match(readFileSync(resolve(REPO_ROOT, f), 'utf8'), /_tcp-relay\.mjs/, `${f} does not import the relay`);
    }
  });
});
