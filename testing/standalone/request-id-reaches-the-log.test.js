/**
 * Every log line written while handling a request carries that request's id.
 *
 * ## The defect this pins
 *
 * `X-Request-Id` is returned on every response, and two doc pages described it as *"logged server-side"* *"for
 * log correlation"*. It reached exactly ONE log line — the unhandled-error handler. So a caller reporting a
 * failure handed over an id that matched nothing in the log unless the failure happened to be an unhandled
 * exception, and every HANDLED failure logged with nothing to join on: a 507 quota refusal, a 503 readiness
 * answer, a WARN from the media worker mid-request. Those are the lines an operator actually goes looking for.
 *
 * ## Why the leak direction matters as much
 *
 * A set-and-forget id is worse than no id: a line stamped with the PREVIOUS request's id sends whoever is
 * reading it to the wrong request, confidently. `AsyncLocalStorage` scopes it to the call tree, and both
 * directions are asserted — inside a request the id is there, outside it there is none, and two concurrent
 * requests never see each other's.
 *
 * Run: node --test testing/standalone/request-id-reaches-the-log.test.js
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { sleep } from '../_shared/sleep.mjs';

let log, runWithRequestId, currentRequestId, subscribe;

/** Capture the lines a body emits, through the real subscriber path the log viewer uses. */
function capture(body) {
  const lines = [];
  const unsub = subscribe(l => lines.push(l));
  try { return { lines, result: body() }; } finally { unsub(); }
}

describe('the id is ambient for the duration of a request', () => {
  before(async () => {
    const mod = await import('../../server/dist/util/log.js');
    ({ log, runWithRequestId, currentRequestId } = mod);
    // The ring buffer's subscriber hook is what the SSE log stream uses; asserting through it rather than
    // through console means this tests the line an operator actually reads.
    subscribe = mod.subscribeLogLines;
    assert.ok(typeof subscribe === 'function', 'subscribeLogLines is gone — re-anchor this gate');
  });

  beforeEach(() => {
    assert.equal(currentRequestId(), undefined, 'a previous test leaked its request context');
  });

  it('a line emitted inside a request carries the id', () => {
    const { lines } = capture(() => runWithRequestId('req-alpha', () => log.info('inside a request')));
    assert.equal(lines.length, 1, `expected one line, got ${lines.length}`);
    assert.match(lines[0], /\[req-alpha\]/, 'the line must carry the id the caller was given');
    assert.match(lines[0], /inside a request/, 'and still carry the message');
  });

  it('a line emitted OUTSIDE a request carries no id, and keeps its old shape', () => {
    /*
     * Boot lines, the TTL sweep, the background usage walk — none of them belong to a request, and stamping
     * them with a placeholder would make a grep for a real id match them.
     */
    const { lines } = capture(() => log.info('outside any request'));
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /\[req-/, 'a line outside a request must not claim one');
    assert.match(lines[0], /^\[[^\]]+\] \[INFO \] outside any request$/,
      'the existing `[ts] [LEVEL] msg` shape must be unchanged outside a request');
  });

  it('the id does not survive the request that set it', () => {
    // The leak direction. A stamped-with-the-previous-request line is worse than an unstamped one.
    runWithRequestId('req-beta', () => log.info('during'));
    const { lines } = capture(() => log.info('after'));
    assert.doesNotMatch(lines[0], /req-beta/, 'the id leaked past the request that set it');
  });

  it('two concurrent requests do not see each other\'s id', async () => {
    /*
     * The case a module-level variable gets wrong and a test with one request never notices. Both bodies await
     * before logging, so their continuations interleave on the event loop — which is exactly what happens when
     * two API calls are in flight.
     */
    const seen = [];
    const one = runWithRequestId('req-one', async () => {
      await sleep(5);
      seen.push(['one', currentRequestId()]);
    });
    const two = runWithRequestId('req-two', async () => {
      await sleep(1);
      seen.push(['two', currentRequestId()]);
    });
    await Promise.all([one, two]);
    assert.deepEqual(seen.sort(), [['one', 'req-one'], ['two', 'req-two']],
      'each request must see its own id after awaiting');
  });

  it('redaction still applies to a line that carries an id', () => {
    // Two features on one line, and the order they are applied in decides whether either works.
    const { lines } = capture(() => runWithRequestId('req-secret', () =>
      log.warn('upstream said Bearer abc123def')));
    assert.match(lines[0], /\[req-secret\]/);
    assert.doesNotMatch(lines[0], /abc123def/, 'stamping the id must not bypass redaction');
    assert.match(lines[0], /Bearer \[redacted\]/);
  });
});

describe('the middleware is what enters the context', () => {
  const APP = stripComments(readFileSync('server/src/app.ts', 'utf8'));

  it('the request-id middleware wraps next() rather than setting a variable', () => {
    assert.match(APP, /runWithRequestId\(id, next\)/,
      'the id must scope the whole request, or a line written after an await loses it');
    assert.doesNotMatch(APP, /req\.requestId\s*=/,
      'a property with one writer and no reader gets re-implemented by whoever needs it next');
  });

  it('it is mounted before the routes, so /mcp is covered too', () => {
    /*
     * MCP is an express router on this same app, and an MCP call is the case where "which request produced
     * this line" is hardest to answer by eye — a model makes many of them quickly. Position is the whole
     * claim: middleware mounted after a router does not run for it.
     */
    const idAt = APP.indexOf('runWithRequestId(id, next)');
    const mcpAt = APP.indexOf("app.use('/mcp'");
    assert.ok(idAt > -1 && mcpAt > -1, 're-anchor this gate');
    assert.ok(idAt < mcpAt, 'the request-id middleware is mounted after /mcp, so MCP lines carry no id');
  });

  it('the unhandled-error handler no longer spells the id out itself', () => {
    // It would print twice on the one line that already had it — and the duplicate is how somebody concludes
    // the ambient stamping is not working.
    assert.doesNotMatch(APP, /Unhandled error \[\$\{/,
      'the id is ambient now; writing it again duplicates it on that line');
  });
});
