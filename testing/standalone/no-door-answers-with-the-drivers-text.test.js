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
import { createRequire } from 'node:module';
import path from 'node:path';
import { stripComments } from './_strip-comments.mjs';

const { storeFailureAnswer } = await import('../../server/dist/brain/store-failure.js');
const { sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js');
// The sync push doors answer a caught failure through the one sender every route catch uses (bundle-30 I12).
const { sendCaughtFailure } = await import('../../server/dist/api/send-failure.js');
const { log } = await import('../../server/dist/util/log.js');
// Real driver errors, from the driver the server loads: the classifier recognises the CLASS (bundle-30 I12).
const { MongoNetworkError, MongoServerSelectionError, MongoServerError } = createRequire(path.resolve('server/package.json'))('mongodb');

/** Driver failures as the driver shapes them, each naming an internal host, address or port. */
const LEAKS = [
  ['a dropped socket', new MongoNetworkError('connection 5 to 172.16.0.9:27017 closed')],
  ['no server to select', new MongoServerSelectionError('getaddrinfo ENOTFOUND mongo-a.internal', {})],
  ['a step-down', Object.assign(new MongoServerError({
    errmsg: 'Executor error during find command :: caused by :: not primary', code: 189, codeName: 'PrimarySteppedDown',
  }), { cause: new Error('connection 9 to mongo-b.internal:27018 closed') })],
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
      const { out } = withLog(() => sent((res, e) => sendCaughtFailure(res, 'test push', e), err));
      assert.equal(out.status, 503);
      assert.doesNotMatch(JSON.stringify(out.body), HOSTLIKE);
    });

    it(`${what}: every audience gets the same answer — the one answer takes no audience`, () => {
      // An audience that is told more is the leak this rule closes; the REST handler cannot tell one from another.
      // Whatever is handed in beside the error — an old audience, the route a catch names for the LOG (bundle-30 I13)
      // — the answer is the same. Asserted on the answer rather than on the arity: the route name is a second
      // parameter that changes only the operator's line, and an arity check could not tell it from an audience.
      const answers = [undefined, { audience: 'caller' }, { audience: 'peer' }, 'GET /api/conflicts', 'sync POST edges']
        .map(second => withLog(() => storeFailureAnswer(err, second)).out);
      for (const a of answers.slice(1)) assert.deepEqual(a, answers[0], 'the answer depends on what is passed beside the error');
      assert.ok(storeFailureAnswer.length <= 2, 'storeFailureAnswer grew a third parameter — what does the answer depend on now?');
    });

    it(`${what}: the operator still reads the driver's text, in the log`, () => {
      const { lines } = withLog(() => storeFailureAnswer(err));
      assert.ok(lines.some(l => l.includes(err.message.split(' :: ')[0])),
        `the driver's message must reach the log — logged: ${JSON.stringify(lines)}`);
    });

    // A route's catch names its operation for a non-store failure; the store's line named nothing, and there is no
    // access log beside it (bundle-30 I13, pre-ship observability O2). One line, naming the route and the driver's text.
    it(`${what}: a route's catch logs it once, naming the route`, () => {
      const { lines } = withLog(() => sent((res, e) => sendCaughtFailure(res, 'GET /api/conflicts', e), err));
      const named = lines.filter(l => l.includes('GET /api/conflicts'));
      assert.equal(named.length, 1, `expected one line naming the route — logged: ${JSON.stringify(lines)}`);
      assert.ok(named[0].includes(err.message.split(' :: ')[0]), `the route's line does not carry the driver's text: ${named[0]}`);
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
