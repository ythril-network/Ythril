/**
 * A store failure is recognised by what the driver says it IS — its class and its labels — and no driver error,
 * recognised or not, puts the driver's text in an answer (bundle-30 I12, from verify-drive-2 finding 1).
 *
 * ## The finding
 *
 * With the store paused, the request in flight when the driver cleared its connection pool was answered with
 *
 *     Connection pool for mongo-a.internal:27017 was cleared because another operation failed with:
 *     "connection <monitor> to 172.16.0.9:27017 timed out"
 *
 * — on MCP, and as a `400` on REST. The classifier matched `err.name` against a list, and the error's name is
 * `MongoPoolClearedError`: a class the driver does not even export, which IS a `MongoNetworkError` by inheritance.
 * A list of names cannot see a subclass, and the driver adds subclasses without telling anyone.
 *
 * ## Why the subjects are read out of the driver, never out of the classifier
 *
 * A gate that builds one error per name on the classifier's list concludes about "every store failure" while
 * checking exactly the names it already knew — the blind spot the defect lived in. So the set here is every class
 * in the installed driver whose prototype chain reaches `MongoError`, exported or internal, found by loading its
 * modules — and floored, because a walk that finds nothing passes every loop written over it.
 *
 * ## What each class is held to
 *
 * - **No driver-side class ever answers with its own text, and never as the caller's fault.** Recognised as a
 *   store condition it is a `503`; unrecognised it is a 5xx in our words — the driver's message names internal
 *   hosts, addresses and ports, and an unknown driver error is still not something the caller can fix.
 * - **A class the driver derives from a network or system failure is the store's**, whatever its own name.
 * - **What the SERVER refused stays the caller's**: a `MongoServerError` with a code the store-condition rules do
 *   not name is a malformed query or a validation refusal in the server's words, and keeps its `400` (null here).
 *
 * Run: node --test testing/standalone/a-store-failure-is-known-by-its-class.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { logLinesDuring } from './_log-lines.mjs';

const { storeFailureAnswer, storeFailureDetail } = await import('../../server/dist/brain/store-failure.js');

// The driver the SERVER loads — resolved from the server's own package, so the classes are the ones it throws.
const requireFromServer = createRequire(path.resolve('server/package.json'));
const driverEntry = requireFromServer.resolve('mongodb');
const driverLib = path.dirname(driverEntry);
const driver = requireFromServer('mongodb');
const { MongoError, MongoServerError, MongoNetworkError, MongoNetworkTimeoutError, MongoSystemError } = driver;

/** The text every constructed error carries: an internal host, a private address and a port. */
const HOST = 'mongo-a.internal:27017';
const ADDRESS = '172.16.0.9';
const SENTINEL = `connection 5 to ${ADDRESS}:27017 closed (${HOST})`;
const LEAK = /mongo-a\.internal|172\.16\.0\.9|27017/;

/** Every `.js` file under the driver's lib, by the filesystem: node_modules is not the repo, so git cannot list it. */
function driverModules(dir = driverLib) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...driverModules(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Every class in the driver whose chain reaches `MongoError` — exported from the package or not. */
function driverErrorClasses() {
  const found = new Set();
  for (const file of driverModules()) {
    let mod;
    try { mod = requireFromServer(file); } catch { continue; }  // an optional dependency the driver guards itself
    for (const value of Object.values(mod ?? {})) {
      if (typeof value === 'function' && value.prototype instanceof MongoError) found.add(value);
    }
  }
  found.add(MongoError);
  return [...found];
}

const CLASSES = driverErrorClasses();

/** One instance of `C` carrying {@link SENTINEL} as its message, however its constructor is shaped. */
function instanceOf(C) {
  const attempts = [
    () => new C(SENTINEL),
    () => new C({ errmsg: SENTINEL, message: SENTINEL }),
    () => new C({ message: SENTINEL }, {}),
    () => new C({ address: HOST, serverError: new MongoNetworkError(SENTINEL) }),
  ];
  let e = null;
  for (const make of attempts) {
    try { e = make(); break; } catch { /* the next shape */ }
  }
  if (!e) e = Object.create(C.prototype);
  if (!String(e.message ?? '').includes(ADDRESS)) {
    Object.defineProperty(e, 'message', { value: SENTINEL, writable: true, configurable: true, enumerable: false });
  }
  return e;
}

/** What the answer says, whoever answers it — every field a door puts on the wire. */
const said = (answer) => JSON.stringify(answer?.body ?? null);

/** The answer, with the log it wrote captured so the console stays quiet. */
async function answerFor(err) {
  const { result, lines } = await logLinesDuring(() => storeFailureAnswer(err));
  return { answer: result, lines };
}

describe('the driver\'s error classes, read out of the driver', () => {
  it('finds them at all — a walk that finds nothing passes every loop below', () => {
    assert.ok(CLASSES.length >= 45,
      `only ${CLASSES.length} MongoError classes found under ${driverLib} — the walk is broken, not the driver`);
    // The class the finding was about must be among them, or the walk cannot see internal classes at all.
    assert.ok(CLASSES.some(C => C.name === 'PoolClearedError'),
      'the walk did not find the driver\'s internal PoolClearedError — it only reads the package\'s exports');
  });

  for (const C of CLASSES) {
    if (C === MongoServerError || C.prototype instanceof MongoServerError) continue;  // the server's words: below
    it(`${C.name}: never answered with the driver's text, and never as the caller's fault`, async () => {
      const err = instanceOf(C);
      const { answer } = await answerFor(err);
      assert.ok(answer, `${C.name} is not recognised as the store's at all, so a door answers it with its own `
        + 'default — a 400 carrying the driver\'s message, which names internal hosts and ports');
      assert.ok(answer.status >= 500, `${C.name} answered ${answer.status}: a driver failure is not the caller's to fix`);
      assert.doesNotMatch(said(answer), LEAK, `${C.name}'s answer carries the driver's text: ${said(answer)}`);
    });
  }

  for (const C of CLASSES.filter(K => K === MongoNetworkError || K.prototype instanceof MongoNetworkError
    || K === MongoSystemError || K.prototype instanceof MongoSystemError)) {
    it(`${C.name}: a network or system failure by class is the store's condition — 503, retryable`, async () => {
      const { answer } = await answerFor(instanceOf(C));
      assert.equal(answer?.status, 503, `${C.name} is a ${C.prototype instanceof MongoNetworkError || C === MongoNetworkError
        ? 'MongoNetworkError' : 'MongoSystemError'} by class and was answered ${answer?.status}`);
      assert.equal(answer.body.retryable, true);
      assert.ok(answer.retryAfterSeconds > 0, 'and it says how long to wait');
    });
  }
});

describe('the reported error, built the way the driver builds it', () => {
  const PoolClearedError = CLASSES.find(C => C.name === 'PoolClearedError');
  const poolCleared = () => new PoolClearedError({
    address: HOST,
    serverError: new MongoNetworkTimeoutError(`connection <monitor> to ${ADDRESS}:27017 timed out`),
  });

  it('is what the drive saw: the driver\'s message names the host, the address and the port', () => {
    const err = poolCleared();
    assert.equal(err.name, 'MongoPoolClearedError', 'not the error the drive reported — re-anchor');
    assert.ok(err instanceof MongoNetworkError, 'the driver no longer derives it from MongoNetworkError — re-read the finding');
    assert.match(err.message, LEAK);
  });

  it('answers 503, retryable, in our words', async () => {
    const { answer } = await answerFor(poolCleared());
    assert.ok(answer, 'MongoPoolClearedError is not recognised as the store\'s — the reported leak');
    assert.equal(answer.status, 503);
    assert.equal(answer.body.retryable, true);
    assert.doesNotMatch(said(answer), LEAK);
  });

  it('and the operator reads the driver\'s text in the log — once, not once per part', async () => {
    const { lines } = await answerFor(poolCleared());
    const text = lines.join('\n');
    assert.equal(text.split(`${ADDRESS}:27017 timed out`).length - 1, 1,
      `the driver's text must reach the log exactly once; logged: ${JSON.stringify(lines)}`);
  });
});

describe('a store condition the driver marks with a label is the store\'s, whatever the code', () => {
  // The labels the driver attaches to "this failure is the connection's or the topology's, try again".
  for (const label of ['ResetPool', 'PoolRequestedRetry', 'RetryableWriteError', 'TransientTransactionError']) {
    it(`a MongoServerError labelled ${label} answers 503`, async () => {
      const err = new MongoServerError({ errmsg: SENTINEL, code: 999_999, codeName: 'SomethingNew' });
      err.addErrorLabel(label);
      const { answer } = await answerFor(err);
      assert.equal(answer?.status, 503, `labelled ${label}, answered ${answer?.status ?? 'as the caller\'s fault'}`);
      assert.doesNotMatch(said(answer), LEAK);
    });
  }
});

describe('what the server refused stays the caller\'s — the direction that must not break', () => {
  it('a MongoServerError with an unlisted code is not the store\'s: the door keeps its 400 and the server\'s words', async () => {
    const err = new MongoServerError({ errmsg: 'Regular expression is invalid: missing )', code: 51091, codeName: 'Location51091' });
    const { answer } = await answerFor(err);
    assert.equal(answer, null, 'a malformed query is the caller\'s to fix, and retrying it fails identically');
  });

  it('a plain Error is not the store\'s either', async () => {
    const { answer } = await answerFor(new Error('filter: unexpected property \'$where\''));
    assert.equal(answer, null);
  });
});

describe('the log line says each part once', () => {
  it('a part already in the message is not appended again', () => {
    const err = new MongoServerError({ errmsg: SENTINEL, code: 189, codeName: 'PrimarySteppedDown' });
    err.cause = new MongoNetworkError(SENTINEL);
    const detail = storeFailureDetail(err);
    assert.equal(detail.split(SENTINEL).length - 1, 1, `the line repeats the driver's text: ${detail}`);
    assert.match(detail, /PrimarySteppedDown/, 'and a part the message lacks is still added');
  });
});

describe('one message, true on every door', () => {
  it('a READ answered with the store message is not told about a write', async () => {
    // The same sentence answers a list load, a search and a save. "Nothing was confirmed written" is true of a save
    // and describes nothing the reader of a failed search did — so the one sentence is one true of both.
    const { answer } = await answerFor(new MongoNetworkError(SENTINEL));
    assert.ok(answer);
    assert.doesNotMatch(answer.body.error, /writ/i, `the one message speaks of a write: ${answer.body.error}`);
    assert.match(answer.body.error, /retry/i, 'and still says what to do');
  });
});
