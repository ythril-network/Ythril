/**
 * Shutdown waits for in-flight requests, and cannot be held open by an idle connection.
 *
 * ## The bug
 *
 * `server.close()` is asynchronous: it stops accepting new connections and calls back once the existing
 * ones have finished. It was called without being awaited, so everything after it ran immediately —
 * `closeMongo()` and then `process.exit(0)`, while requests were still running. A container restart
 * during a file upload or a brain write would pull the database connection out from under it mid-write,
 * and the process would exit 0 as if nothing had happened.
 *
 * ## Why this test drives a real server
 *
 * The property is a race, and a source grep cannot see a race. These tests stand up an actual HTTP
 * server with a deliberately slow handler, signal shutdown while that request is in flight, and check
 * whether the response completed before the close resolved. That is the behaviour, not a proxy for it.
 *
 * The counterpart matters just as much: a keep-alive socket sitting idle must NOT be able to hold the
 * shutdown open, or a graceful stop degrades into waiting for the orchestrator's SIGKILL. So the second
 * test opens exactly that and asserts the drain gives up on schedule.
 *
 * Run: node --test testing/standalone/graceful-shutdown-drain.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import net from 'node:net';

/** The drain used by `index.ts`, reproduced here so the test exercises the shape, not the file. */
function drain(server, drainMs) {
  return new Promise(resolve => {
    const forced = setTimeout(() => { server.closeAllConnections(); resolve('forced'); }, drainMs);
    forced.unref();
    server.close(() => { clearTimeout(forced); resolve('drained'); });
  });
}

const listen = server => new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));

describe('shutdown drains in-flight work', () => {
  it('waits for a slow request to finish before the close resolves', async () => {
    let finished = false;
    const server = createServer((_req, res) => {
      setTimeout(() => { finished = true; res.end('done'); }, 300);
    });
    const port = await listen(server);

    const inFlight = fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
    await new Promise(r => setTimeout(r, 50));      // ensure the request is actually in flight

    const how = await drain(server, 5_000);
    assert.equal(how, 'drained', 'the drain should complete normally, not be forced');
    assert.equal(finished, true, 'the in-flight request must have completed BEFORE the close resolved');
    assert.equal(await inFlight, 'done');
  });

  it('an idle keep-alive connection cannot hold the shutdown open', async () => {
    // Without the forced phase this hangs until the orchestrator SIGKILLs the process — a graceful
    // stop that is graceful in name only.
    const server = createServer((_req, res) => res.end('ok'));
    const port = await listen(server);

    // Wait for the SERVER to register the socket, not just for the client to finish connecting.
    //
    // `sock.once('connect')` resolves on the client side; the server may not have accepted the
    // connection yet. If `close()` is called in that gap it finds nothing to wait for and resolves
    // 'drained' immediately, so the assertion below flips — intermittently, and only under the load of a
    // full sequential batch, which is the worst way for a gate to fail. Waiting on the server's own
    // `connection` event removes the race instead of widening a timeout around it.
    const sock = net.connect(port, '127.0.0.1');
    await Promise.all([
      new Promise(r => sock.once('connect', r)),
      new Promise(r => server.once('connection', r)),
    ]);

    const started = Date.now();
    const how = await drain(server, 300);
    const took = Date.now() - started;

    assert.equal(how, 'forced', 'an idle socket must trigger the forced phase');
    // The invariant is BOUNDEDNESS, not latency: without the forced phase this hangs until the
    // orchestrator SIGKILLs the process. A tight ceiling measures the scheduler instead — at 2s it
    // flaked once inside a 140-file sequential batch and passed on the retry, which is the worst kind of
    // gate. 10s still fails an unbounded wait instantly and cannot be tripped by load.
    assert.ok(took < 10_000, `the drain must be bounded, took ${took}ms`);
    sock.destroy();
  });
});

describe('the shutdown handler in index.ts', () => {
  const src = readFileSync('server/src/index.ts', 'utf8');

  it('awaits the close before closing Mongo', () => {
    const body = src.slice(src.indexOf('const shutdown ='), src.indexOf('process.on(\'SIGTERM\''));
    const closeAt = body.indexOf('server.close(');
    const mongoAt = body.indexOf('closeMongo(');
    assert.ok(closeAt > 0 && mongoAt > 0);
    assert.ok(closeAt < mongoAt, 'the server must be closed before the database connection is dropped');
    assert.match(body, /await new Promise/,
      'the close must be awaited — an unawaited server.close() lets exit race the requests');
  });

  it('is re-entrant-safe, so a second signal cannot race the first', () => {
    assert.match(src, /if \(shuttingDown\) return;/);
  });

  it('bounds the drain rather than waiting forever', () => {
    assert.match(src, /closeAllConnections\(\)/);
  });

  it('stops the reindex watcher before the drain, so a tick cannot start a sweep over the closing database (bundle-53 G15)', () => {
    const body = src.slice(src.indexOf('const shutdown ='), src.indexOf("process.on('SIGTERM'"));
    const stopAt = body.indexOf('stopReindexWatcher(');
    const closeAt = body.indexOf('server.close(');
    assert.ok(stopAt > 0, 'the shutdown handler never stops the reindex watcher: its 5 s tick keeps resuming runs while the process drains');
    assert.ok(stopAt < closeAt, 'the watcher must be stopped before the drain starts, with the other timers');
    assert.match(body, /import\('\.\/brain\/reindex\.js'\)/, 'and it is the reindex module\'s own stop that is called');
  });
});

/**
 * Readiness fails FIRST, before the drain — the step that stops new work arriving.
 *
 * #537 made shutdown wait for in-flight requests. That finishes what is already running; it does not
 * stop more from arriving. `server.close()` refuses new *connections*, but a load balancer holding an
 * established keep-alive connection keeps using it — and kept getting `200` from `/ready`, because the
 * probe only knew about MongoDB. So a draining instance advertised itself as healthy and accepted work
 * it was about to abandon at exit.
 *
 * Liveness deliberately stays 200 throughout: a `/health` that fails on SIGTERM invites the
 * orchestrator to SIGKILL the process mid-drain, which is the opposite of the intent.
 */
describe('readiness reports not-ready as soon as shutdown begins', () => {
  it('flips on beginShutdown, and liveness is unaffected', async () => {
    const { isShuttingDown, beginShutdown, resetLifecycleForTests } =
      await import('../../server/dist/lifecycle.js');

    resetLifecycleForTests();
    assert.equal(isShuttingDown(), false, 'a running instance is not shutting down');

    beginShutdown();
    assert.equal(isShuttingDown(), true);
    beginShutdown();
    assert.equal(isShuttingDown(), true, 'idempotent — the signal handler may be re-entered');

    resetLifecycleForTests();
  });

  it('the /ready handler checks it BEFORE the dependency probes', () => {
    // Order matters: a draining instance is not ready even when MongoDB is perfectly healthy, and the
    // check must not be able to be skipped by a slow or throwing probe.
    const app = readFileSync('server/src/app.ts', 'utf8');
    const handler = app.slice(app.indexOf("app.get('/ready'"), app.indexOf("app.use('/metrics'"));
    const shutAt = handler.indexOf('isShuttingDown()');
    const probeAt = handler.indexOf('getReadiness()');
    assert.ok(shutAt > 0, '/ready must consult the shutdown flag');
    assert.ok(shutAt < probeAt, 'the shutdown check must come before the dependency probes');
  });

  it('liveness has no shutdown check at all', () => {
    const app = readFileSync('server/src/app.ts', 'utf8');
    const health = app.slice(app.indexOf("app.get('/health'"), app.indexOf("app.get('/ready'"));
    assert.ok(!health.includes('isShuttingDown'),
      '/health must keep returning 200 — failing liveness on SIGTERM invites a SIGKILL mid-drain');
  });

  it('shutdown marks not-ready before it closes the server', () => {
    const src = readFileSync('server/src/index.ts', 'utf8');
    const body = src.slice(src.indexOf('const shutdown ='), src.indexOf("process.on('SIGTERM'"));
    const markAt = body.indexOf('beginShutdown()');
    const closeAt = body.indexOf('server.close(');
    assert.ok(markAt > 0 && closeAt > 0);
    assert.ok(markAt < closeAt,
      'readiness must go false before the drain starts, or the drain races new arrivals');
  });
});
