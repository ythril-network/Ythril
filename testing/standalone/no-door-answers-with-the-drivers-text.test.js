/**
 * No door's answer carries the driver's text — the store's failure is said in our words, with a stable code, and
 * the driver's own message goes to the log only (bundle-30 I8, pre-ship security lens).
 *
 * ## Why
 *
 * A network, server-selection or step-down failure arrives with a message that names internal hosts and ports
 * (`connection 5 to 172.16.0.9:27017 closed`, `getaddrinfo ENOTFOUND mongo-a.internal`). `/ready` and the sync push
 * doors already withheld it; the REST read routes, the MCP door and — new in this bundle — the global REST error
 * handler put it in the body, where any caller, including one the handler cannot identify, read it. The global
 * handler cannot tell an operator from an anonymous caller, so the only safe rule is one answer for every audience.
 *
 * Asserted on what each door SENDS, not on a spelling: the REST read sender, the sync push sender, and the one
 * answer the REST error handler and the MCP dispatcher put on the wire (`storeFailureAnswer`, whose `body.error`
 * the tool's text and `structuredContent` are built from). And the operator still gets the text: it is logged.
 *
 * Run: node --test testing/standalone/no-door-answers-with-the-drivers-text.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { storeFailureAnswer } = await import('../../server/dist/brain/store-failure.js');
const { sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js');
const { sendSyncWriteFailure } = await import('../../server/dist/api/sync/write-failure.js');
const { log } = await import('../../server/dist/util/log.js');

const mongoErr = (name, fields = {}) => Object.assign(new Error(fields.message ?? 'boom'), { name, ...fields });

/** Driver failures as the driver shapes them, each naming an internal host, address or port. */
const LEAKS = [
  ['a dropped socket', mongoErr('MongoNetworkError', { message: 'connection 5 to 172.16.0.9:27017 closed' })],
  ['no server to select', mongoErr('MongoServerSelectionError', { message: 'getaddrinfo ENOTFOUND mongo-a.internal' })],
  ['a step-down', mongoErr('MongoServerError', {
    message: 'Executor error during find command :: caused by :: not primary',
    code: 189, codeName: 'PrimarySteppedDown', cause: new Error('connection 9 to mongo-b.internal:27018 closed'),
  })],
];
const HOSTLIKE = /172\.16\.0\.9|27017|27018|mongo-a\.internal|mongo-b\.internal|ENOTFOUND|caused by/;

/** Run `fn` with the log captured, so a test can see what went to the operator rather than to the caller. */
function withLog(fn) {
  const lines = [];
  const saved = { warn: log.warn, error: log.error };
  log.warn = (...a) => { lines.push(a.map(x => (x instanceof Error ? `${x.message}` : String(x))).join(' ')); };
  log.error = (...a) => { lines.push(a.map(x => (x instanceof Error ? `${x.message}` : String(x))).join(' ')); };
  try { return { out: fn(), lines }; } finally { Object.assign(log, saved); }
}

function sent(door, err) {
  const out = { headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; },
    status: (s) => { out.status = s; return res; },
    json: (b) => { out.body = b; return res; },
  };
  door(res, err);
  return out;
}

describe('no door answers with the driver\'s text', () => {
  for (const [what, err] of LEAKS) {
    it(`${what}: the one answer (REST write handler, MCP tool) says it in our words, with the store's code`, () => {
      const { out: answer } = withLog(() => storeFailureAnswer(err));
      assert.ok(answer, 'a store failure must still be identified as the store\'s');
      assert.equal(answer.status, 503);
      assert.doesNotMatch(JSON.stringify(answer.body), HOSTLIKE,
        'the answer carries the driver\'s text, which names internal hosts and ports');
      if (err.code !== undefined) assert.equal(answer.body.code, err.code, 'the store\'s code is stable and stays');
    });

    it(`${what}: the REST read routes answer without it`, () => {
      const { out } = withLog(() => sent(sendReadFailure, err));
      assert.equal(out.status, 503);
      assert.doesNotMatch(JSON.stringify(out.body), HOSTLIKE);
    });

    it(`${what}: the sync push doors answer without it`, () => {
      const { out } = withLog(() => sent((res, e) => sendSyncWriteFailure(res, 'test push', e), err));
      assert.equal(out.status, 503);
      assert.doesNotMatch(JSON.stringify(out.body), HOSTLIKE);
    });

    it(`${what}: every audience gets the same answer — the one answer takes no audience`, () => {
      // An audience that is told more is the leak this rule closes; the REST handler cannot tell one from another.
      const a = withLog(() => storeFailureAnswer(err, { audience: 'caller' })).out;
      const b = withLog(() => storeFailureAnswer(err, { audience: 'peer' })).out;
      assert.deepEqual(a, b);
      assert.equal(storeFailureAnswer.length, 1, 'storeFailureAnswer grew a second parameter — an audience by another name?');
    });

    it(`${what}: the operator still reads the driver's text, in the log`, () => {
      const { lines } = withLog(() => storeFailureAnswer(err));
      assert.ok(lines.some(l => l.includes(err.message.split(' :: ')[0])),
        `the driver's message must reach the log — logged: ${JSON.stringify(lines)}`);
    });
  }

  it('the REST error handler logs nothing of its own for a store failure — the one answer logs it once', () => {
    const app = stripComments(readFileSync('server/src/app.ts', 'utf8'));
    const at = app.indexOf('storeFailureAnswer(err');
    assert.ok(at > 0, 'the REST error handler no longer answers through storeFailureAnswer — re-anchor');
    const block = app.slice(at, app.indexOf('return;', at));
    assert.doesNotMatch(block, /log\.(warn|error)/, 'a second log line for the one failure');
  });
});
