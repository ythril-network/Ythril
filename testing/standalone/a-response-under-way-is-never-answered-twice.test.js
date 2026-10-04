/**
 * A route that fails after its response is under way is not answered a second time: `sendCaughtFailure` reports the
 * failure and leaves the response as it was (bundle-30 I13, pre-ship testing F4).
 *
 * The guard lives in the one sender so "the next streaming route cannot forget it" — and nothing reached it: every
 * caller of `sendCaughtFailure` in the suite handed it a fresh response. Without it, a stream that fails after its
 * status line throws `ERR_HTTP_HEADERS_SENT` inside its own `catch`, the one place nothing recovers it.
 *
 * Asserted for a store failure and for any other failure, since the sender answers those two differently: neither
 * writes to a response whose headers are out, and both reach the operator's log.
 *
 * Run: node --test testing/standalone/a-response-under-way-is-never-answered-twice.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const { sendCaughtFailure } = await import('../../server/dist/api/send-failure.js');
const { log } = await import('../../server/dist/util/log.js');
const { MongoNetworkError } = createRequire(path.resolve('server/package.json'))('mongodb');

/** A response whose status line is already out: any further write is the defect, so each one throws. */
function streaming() {
  const refuse = (what) => () => { throw new Error(`ERR_HTTP_HEADERS_SENT: ${what} after the headers were sent`); };
  return { headersSent: true, status: refuse('status'), json: refuse('json'), setHeader: refuse('setHeader'), end: refuse('end') };
}

/** Every warn and error line logged while `fn` runs. */
function logged(fn) {
  const lines = [];
  const orig = { warn: log.warn, error: log.error };
  log.warn = (...a) => { lines.push(a.map(String).join(' ')); };
  log.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try { fn(); } finally { Object.assign(log, orig); }
  return lines;
}

describe('a response under way is never answered twice', () => {
  for (const [name, err] of [
    ['a store failure', new MongoNetworkError('connection 1 to 10.1.2.4:27017 closed')],
    ['any other failure', new Error('the export stream broke')],
  ]) {
    it(`${name}: nothing is written to the response, and the failure is reported`, () => {
      const lines = logged(() => sendCaughtFailure(streaming(), 'GET /api/export/probe', err));
      assert.ok(lines.some(l => l.includes('GET /api/export/probe')), `the failure was not reported under its route: ${lines}`);
    });
  }
});
