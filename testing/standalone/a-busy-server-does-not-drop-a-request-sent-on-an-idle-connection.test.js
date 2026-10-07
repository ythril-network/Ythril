/**
 * A server whose event loop was busy does not drop a request a client already sent on an idle connection (`Q-73`).
 *
 * Node closes an idle keep-alive connection after `keepAliveTimeout`, 5 s by default, and it checks that timer
 * BEFORE it reads what arrived on the socket. A client pools connections and reuses one it believes is fresh —
 * undici's own idle limit is 4 s. So when the loop is blocked for a few seconds (a text job, a large parse), the
 * server wakes, finds the connection idle past its limit, and closes it with the client's request unread: the
 * caller sees "other side closed" and nothing is logged. Two text-level integration requests died this way while a
 * text job ran on the same instance.
 *
 * Reproduced in a child process so the stall blocks the SERVER and not the client: connection 1 goes idle, a request
 * on connection 2 blocks the loop for 7 s, and 1 s into it the client sends on connection 1.
 *
 * Run: node --test testing/standalone/a-busy-server-does-not-drop-a-request-sent-on-an-idle-connection.test.js
 *      (after `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { sleep } from '../_shared/sleep.mjs';

const MODULE = pathToFileURL(join(REPO_ROOT, 'server', 'dist', 'http-connections.js')).href;
const CHILD = `
  import http from 'node:http';
  const { configureConnections } = await import(${JSON.stringify(MODULE)});
  const server = http.createServer((req, res) => {
    if (req.url === '/stall') { const until = Date.now() + 7000; while (Date.now() < until); }
    res.end('ok');
  });
  configureConnections(server);
  server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

let child, port;
before(async () => {
  child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    child.on('exit', code => reject(new Error(`the test server exited (${code})`)));
  });
});
after(() => child?.kill());

/** One request on a chosen connection, so the test decides which socket is reused. */
const request = (agent, path) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path, agent }, res => {
    res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200 }));
  });
  req.on('error', err => resolve({ ok: false, error: err.code ?? err.message }));
});

describe('a request on an idle keep-alive connection survives a stall', () => {
  it('connection 1 is reused during a 7 s stall and still answered', { timeout: 30_000 }, async () => {
    const idle = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const busy = new http.Agent({ keepAlive: true, maxSockets: 1 });
    assert.equal((await request(idle, '/')).ok, true, 'the first request must succeed');
    await sleep(500);
    const stall = request(busy, '/stall');
    await sleep(1_000);
    // The client sees a connection idle for 1.5 s; the server will see it idle for 8 s when it next looks.
    const reused = await request(idle, '/');
    await stall;
    idle.destroy(); busy.destroy();
    assert.deepEqual(reused, { ok: true }, 'the server closed a connection with a request already sent on it');
  });
});
