/**
 * `refusalText(err)`: the sentence an act puts in a REFUSAL — and the driver's words are never in it
 * (bundle-53 G1, Q-335 module half; SEC-1).
 *
 * ## The defect it prevents
 *
 * Three sites answered a caller with `err.message` after a failed lookup and decided by the WORDING whether the
 * answer was "not found" or "already exists". A `MongoServerError` the server raised for something else — whose
 * text happened to hold one of those words, and which names the internal collection, the index and the duplicated
 * values — was read as a refusal and put in the caller's hands. The store failing in the middle of the act was read
 * as the caller's mistake.
 *
 * ## What it is held to
 *
 * 1. **A store-side failure is rethrown, never worded.** The act's door answers it (503 / 500) as every door does.
 * 2. **Our own error's message is returned.** It is the act's refusal in the act's words.
 * 3. **A driver-raised error that is not store-side returns ONE generic sentence**, whatever its text says; the
 *    driver's text goes to the log, once, where an operator reads it and no caller does.
 * 4. **A file-system error answers our sentence with its code** (`ENOENT`, `EACCES`), never its message: the runtime
 *    puts the absolute data path in it. The path goes to the log, the same way.
 *
 * Run: node --test testing/standalone/refusal-text-never-answers-a-drivers-words.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { logLinesDuring } from './_log-lines.mjs';

const sf = await import('../../server/dist/brain/store-failure.js');
const driver = createRequire(path.resolve('server/package.json'))('mongodb');
const {
  MongoServerError, MongoNetworkError, MongoDriverError, MongoInvalidArgumentError, MongoParseError, MongoWriteConcernError,
} = driver;

const LEAKY = 'E11000 duplicate key error collection: ythril.space1_entities index: name_1 dup key: { name: "already exists" }';

const refusal = (err) => logLinesDuring(() => sf.refusalText(err));

describe('refusalText', () => {
  it('is exported, with the generic sentence it answers a driver refusal with', () => {
    assert.equal(typeof sf.refusalText, 'function');
    assert.equal(typeof sf.DRIVER_REFUSAL_MESSAGE, 'string');
    assert.ok(sf.DRIVER_REFUSAL_MESSAGE.length > 20);
  });

  it('returns our own error\'s message, untouched', async () => {
    const { result, lines } = await refusal(new Error('Space \'notes\' already exists'));
    assert.equal(result, 'Space \'notes\' already exists');
    assert.deepEqual(lines, [], 'our own refusal is not a driver text and logs nothing');
  });

  it('a thrown string or an object without a message is told as text, not lost', async () => {
    assert.equal((await refusal('plain words')).result, 'plain words');
  });

  for (const text of ['already exists', 'not found', LEAKY, 'no such namespace: ythril.space1_entities']) {
    it(`a non-store MongoServerError whose text holds ${JSON.stringify(text.slice(0, 40))} answers the generic sentence`, async () => {
      const err = new MongoServerError({ errmsg: text, code: 51091, codeName: 'Location51091' });
      assert.equal(sf.classifyReadFailure(err).status, 400, 'the fixture is not the shape under test: the server refused, no store condition');
      const { result, lines } = await refusal(err);
      assert.equal(result, sf.DRIVER_REFUSAL_MESSAGE);
      assert.doesNotMatch(String(result), /already exists|not found|ythril|E11000|namespace/i, 'the driver\'s words reached the caller');
      const logged = lines.join('\n');
      assert.ok(logged.includes(text.slice(0, 30)), `the driver's text did not reach the log: ${JSON.stringify(lines)}`);
    });
  }

  it('the driver\'s text is logged once, not once per part', async () => {
    const err = new MongoServerError({ errmsg: LEAKY, code: 11000, codeName: 'DuplicateKey' });
    const { lines } = await refusal(err);
    assert.equal(lines.join('\n').split('E11000').length - 1, 1, JSON.stringify(lines));
  });

  it('a driver refusal wrapped by one of ours is still the driver\'s: the wrapper\'s message is not the answer', async () => {
    const wrapped = new Error(`could not create: ${LEAKY}`, { cause: new MongoServerError({ errmsg: LEAKY, code: 11000 }) });
    const { result } = await refusal(wrapped);
    assert.equal(result, sf.DRIVER_REFUSAL_MESSAGE);
  });

  // A file-system error carries the absolute data path in its message (`ENOENT: no such file or directory, rename
  // 'C:\data\files\notes' -> ...`), and a space rename's directory move answered it in the 500 body (bundle-53 lens
  // sweep, security). Real errors from `fs`, so the shape is the runtime's, not a fixture's guess.
  const fsError = async () => {
    const missing = path.join(path.resolve('server'), 'no-such-dir-for-refusal-text', 'inner');
    try { await (await import('node:fs/promises')).rename(missing, `${missing}-moved`); } catch (err) { return { err, missing }; }
    throw new Error('the fixture rename did not fail');
  };

  it('a file-system error answers our sentence with its code, never its path; the detail is logged once', async () => {
    const { err, missing } = await fsError();
    assert.match(err.message, /no-such-dir-for-refusal-text/, 'the fixture is not the shape under test: the runtime error names its path');
    const { result, lines } = await refusal(err);
    assert.doesNotMatch(String(result), /no-such-dir-for-refusal-text|[A-Za-z]:\\|\/server\//, `a path reached the caller: ${result}`);
    assert.match(String(result), /ENOENT/, 'the error code is the useful part and carries no path');
    assert.equal(lines.join('\n').split('no-such-dir-for-refusal-text').length - 1 >= 1, true, `the path did not reach the log: ${JSON.stringify(lines)}`);
    assert.ok(missing.length > 0);
  });

  it('a file-system error wrapped by one of ours is still a file-system error: the wrapper\'s message is not the answer', async () => {
    const { err } = await fsError();
    const wrapped = new Error(`move failed: ${err.message}`, { cause: err });
    const { result } = await refusal(wrapped);
    assert.doesNotMatch(String(result), /no-such-dir-for-refusal-text/, `a path reached the caller: ${result}`);
  });

  it('a store-side error is rethrown, as the same object', () => {
    for (const err of [
      new MongoNetworkError('connection 5 to 172.16.0.9:27017 closed'),
      new MongoServerError({ errmsg: 'stepped down', code: 189 }),
      new MongoDriverError('an unrecognised driver fault'),
      new MongoParseError('bad uri'),
    ]) {
      assert.throws(() => sf.refusalText(err), (thrown) => thrown === err, `${err.name} was worded instead of rethrown`);
    }
  });

  it('an unsatisfiable write concern is rethrown (it answers 500 on every door), never worded', () => {
    const err = new MongoWriteConcernError({ writeConcernError: { code: 100, errmsg: 'Not enough data-bearing nodes' } });
    assert.throws(() => sf.refusalText(err), (thrown) => thrown === err);
  });

  it('no driver error class reaches the caller as its own text — it is rethrown or generic, never its message', async () => {
    const errs = [
      new MongoServerError({ errmsg: LEAKY, code: 11000 }),
      new MongoInvalidArgumentError(LEAKY),
      new MongoDriverError(LEAKY),
      new MongoParseError(LEAKY),
      new MongoNetworkError(LEAKY),
    ];
    assert.equal(typeof sf.refusalText, 'function');
    for (const err of errs) {
      let said;
      try { said = (await refusal(err)).result; } catch (thrown) {
        assert.equal(thrown, err, `${err.name}: refusalText threw something other than the error it was handed: ${thrown}`);
        continue;  // rethrown: the door answers it in our words
      }
      assert.doesNotMatch(String(said), /E11000|space1_entities/, `${err.name} reached the caller as its own text`);
    }
  });
});
