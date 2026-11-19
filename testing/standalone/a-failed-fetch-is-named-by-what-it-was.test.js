/**
 * A probe's fetch that failed is named by what it was: an abort is "no answer", anything else is a connection that failed (bundle-348).
 *
 * ## The defect it prevents
 *
 * The store-failure gate asked every door with an abort after `PER_DOOR_MS` and turned EVERY error its fetch threw into
 * "no answer within 20000 ms". A connection the server had closed (`ECONNRESET`, a few milliseconds after the send) read as a door that
 * hung for twenty seconds, and the report sent its reader to the about door instead of to the harness. `answerOfFailedFetch` is the one
 * place that says which it was; the abort's `TimeoutError` is the only thing that says "no answer".
 *
 * Run: node --test testing/standalone/a-failed-fetch-is-named-by-what-it-was.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answerOfFailedFetch } from './_failed-fetch-answer.mjs';

/** What undici throws for a socket the server closed: `TypeError: fetch failed`, the cause carrying the code. */
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

describe('a failed fetch is named by what it was', () => {
  it('an abort by the per-door timeout is no answer', () => {
    const answer = answerOfFailedFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    assert.equal(answer.timedOut, true);
    assert.equal(answer.connectionFailed, undefined);
    assert.equal(answer.status, 0);
  });

  it('a connection reset is a connection failure with its cause code, and not a timeout', () => {
    const answer = answerOfFailedFetch(reset());
    assert.equal(answer.timedOut, undefined, 'a reset was reported as a door that gave no answer');
    assert.equal(answer.connectionFailed, true);
    assert.equal(answer.causeCode, 'ECONNRESET');
    assert.match(answer.error, /ECONNRESET/);
  });

  it('a failure with no code still names its class, and a status the response had is kept', () => {
    const answer = answerOfFailedFetch(new TypeError('fetch failed'), { status: 200 });
    assert.equal(answer.connectionFailed, true);
    assert.equal(answer.causeCode, 'TypeError');
    assert.equal(answer.status, 200);
  });

  it('an abort that is not the timeout\'s (a user abort) is not "no answer" either', () => {
    const answer = answerOfFailedFetch(new DOMException('aborted', 'AbortError'));
    assert.equal(answer.timedOut, undefined);
    assert.equal(answer.connectionFailed, true);
    assert.equal(answer.causeCode, 'AbortError');
  });
});
