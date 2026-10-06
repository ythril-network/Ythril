/**
 * A server a test starts on this machine is started, and ended, by ONE helper, `testing/_shared/local-server.mjs`; and
 * "a port nothing listens on" is asked of one helper, `testing/_shared/closed-port.mjs` (bundle-56 dedup, item 9).
 *
 * ## What this prevents
 *
 * The two fake servers (`fake-ythril-tool-server.mjs`, `fake-github-actions.mjs`) each wrote the same shell: bind
 * `127.0.0.1:0`, remember every socket the server accepts, and on `close()` destroy the sockets and then close.
 * The sockets are the guard: an HTTP server holding a keep-alive connection (or one the fake deliberately never
 * answers, `hang()`) does not finish `server.close()` while a socket is open, so a test that forgot them hangs at
 * teardown instead of failing. Two relays to MongoDB then wanted the same shell. And the test of a refused
 * connection wrote "bind, read the port, release" twice, inline.
 *
 * What stays separate: roughly twenty older tests start their own throwaway `http` server inline. They share the
 * spelling and ask the same question; they are not converted here (each is a test-local server whose handler is the
 * subject), and a new helper or fake must use the module. The gate below is scoped to helpers (non-test sources).
 *
 * Run: node --test testing/standalone/local-servers-and-closed-ports-are-shared.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SERVER_MODULE = 'testing/_shared/local-server.mjs';
const PORT_MODULE = 'testing/_shared/closed-port.mjs';
const load = (rel) => import(pathToFileURL(resolve(REPO_ROOT, rel)).href);

const refused = (port) => new Promise((resolveConnect) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolveConnect('connected'); });
  s.once('error', (err) => resolveConnect(err.code));
});

describe('listenOnLoopback', () => {
  it('binds 127.0.0.1 on a free port and says where: port and a ready http url', async () => {
    const { listenOnLoopback } = await load(SERVER_MODULE);
    const server = http.createServer((req, res) => res.end('hello'));
    const local = await listenOnLoopback(server);
    try {
      assert.equal(server.address().address, '127.0.0.1');
      assert.equal(local.port, server.address().port);
      assert.equal(local.url, `http://127.0.0.1:${local.port}`);
      assert.equal(await (await fetch(local.url)).text(), 'hello');
    } finally { await local.close(); }
  });

  it('close() ends while a client still holds an open connection, and that connection is closed', async () => {
    const { listenOnLoopback } = await load(SERVER_MODULE);
    const local = await listenOnLoopback(http.createServer(() => { /* never answers */ }));
    const held = net.connect(local.port, '127.0.0.1');
    held.on('error', () => {}); // the server resets it; that is the point
    await new Promise((r) => held.once('connect', r));
    held.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    const closedByServer = new Promise((r) => held.once('close', r));
    await Promise.race([
      local.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close() waited for a socket that was still open')), 3000).unref()),
    ]);
    await Promise.race([closedByServer, new Promise((_, reject) => setTimeout(() => reject(new Error('the held connection was left open')), 3000).unref())]);
  });

  it('close() is safe to call twice and after the server is already gone', async () => {
    const { listenOnLoopback } = await load(SERVER_MODULE);
    const local = await listenOnLoopback(http.createServer((req, res) => res.end()));
    await local.close();
    await local.close();
    assert.equal(await refused(local.port), 'ECONNREFUSED');
  });

  it('serves a plain TCP server too: the shell is not about http', async () => {
    const { listenOnLoopback } = await load(SERVER_MODULE);
    const local = await listenOnLoopback(net.createServer((socket) => socket.end('pong')));
    try {
      const got = await new Promise((r) => { const c = net.connect(local.port, '127.0.0.1'); let t = ''; c.on('data', (d) => { t += d; }); c.on('close', () => r(t)); });
      assert.equal(got, 'pong');
    } finally { await local.close(); }
  });
});

describe('closedLoopbackPort', () => {
  it('returns a port a connection to is refused', async () => {
    const { closedLoopbackPort } = await load(PORT_MODULE);
    const port = await closedLoopbackPort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `port ${port}`);
    assert.equal(await refused(port), 'ECONNREFUSED');
  });
});

describe('no helper keeps its own server shell', () => {
  /*
   * Derived, never listed: every tracked non-test source under testing/ and scripts/. A hand-written shell tracks the
   * accepted sockets (`.on('connection', ...)`); a hand-written closed-port is "read the port, then close at once".
   */
  const helpers = (exclude) => trackedSources(['testing', 'scripts'], { ext: ['.mjs', '.js'], floor: 500, exclude })
    .filter((f) => !f.endsWith('.test.js'));

  it('only the server module tracks accepted sockets', () => {
    const files = helpers([SERVER_MODULE]);
    assert.ok(files.length >= 100, `the scan saw only ${files.length} helpers`);
    const copies = files.filter((f) => /\.on\(\s*['"]connection['"]/.test(stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(copies, [], `these track sockets themselves; use listenOnLoopback from ${SERVER_MODULE}`);
  });

  it('nothing but the port module (and its tests) reads a port and closes the listener at once', () => {
    const files = trackedSources(['testing', 'scripts'], { ext: ['.mjs', '.js'], floor: 500, exclude: [PORT_MODULE, 'testing/standalone/local-servers-and-closed-ports-are-shared.test.js'] });
    const copies = files.filter((f) => /\.address\(\)[^;]*;\s*await new Promise\([^)]*\.close\(/.test(stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(copies, [], `these write "a port nothing listens on" themselves; use closedLoopbackPort from ${PORT_MODULE}`);
  });

  it('the two fakes import the server module', () => {
    for (const f of ['testing/_shared/fake-ythril-tool-server.mjs', 'testing/_shared/fake-github-actions.mjs']) {
      assert.match(readFileSync(resolve(REPO_ROOT, f), 'utf8'), /local-server\.mjs/, `${f} does not import the module`);
    }
  });
});
