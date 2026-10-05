/**
 * `isMaxTimeExpired` answers "did the store abort this because its deadline passed", never "does the message name the
 * option" (`db/max-time.ts`; main's bundle-30 I6 D1, carried to 5.6.x).
 *
 * ## The rule
 *
 * The question is asked by recall (`RecallSearchTimeout`), predicate recall (`search_timeout`), the row graphs and the
 * face gallery (`GalleryIncompleteError`, "ran out of time"). Its fallback is a message match, for an error that lost
 * its code on the way (a wrapper). The fallback read the word `maxTimeMS` as a deadline, and the store NAMES that option
 * whenever it refuses a misplaced one: `cannot set maxTimeMS on getMore command for a non-awaitData cursor` is a
 * BadValue (code 2) — a defect in the bound — and read as a deadline it is reported as "the search ran out of time" and
 * retried as one. The fallback matches what the store says when a deadline PASSED (`exceeded time limit`), not the
 * option's name.
 *
 * ## Scope on the release line
 *
 * Only the keyword. Main also answers `false` for ANY numeric code other than 50 and 262 whatever the message says, and
 * answers `true` for 262 by code; that is a wider change to a question four callers ask, and the patch takes the fix
 * the defect needs (drop the keyword) and nothing else. So the cases that pin today's answers stay pinned: a code 262
 * with the store's words is a deadline (as it is today, by its message), and so is a wrapper that lost the code and kept
 * the words.
 *
 * Built from the REAL driver classes (`MongoServerError`, `MongoInvalidArgumentError`), never a plain `Error` wearing a
 * `name`, so the question is asked of what the driver raises.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): the BadValue that names `maxTimeMS` is answered `true`.
 *
 * Run: node --test testing/standalone/a-misused-bound-is-not-a-deadline-the-store-missed.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError, MongoInvalidArgumentError, MongoNetworkError } from 'mongodb';

let isMaxTimeExpired;
before(async () => { ({ isMaxTimeExpired } = await import('../../server/dist/db/max-time.js')); });

const serverError = (doc) => new MongoServerError(doc);

/** Raised by the store or the driver because a bound was MISUSED — a defect in the bound, never a deadline. */
const MISUSE = [
  ['the store refuses maxTimeMS on a getMore of a non-awaitData cursor (BadValue, code 2)',
    () => serverError({ code: 2, codeName: 'BadValue', errmsg: 'cannot set maxTimeMS on getMore command for a non-awaitData cursor' })],
  ['the store refuses a negative maxTimeMS (BadValue, code 2)',
    () => serverError({ code: 2, codeName: 'BadValue', errmsg: 'maxTimeMS value must be non-negative' })],
  ['the store refuses maxTimeMS too large to represent (code 2)',
    () => serverError({ code: 2, codeName: 'BadValue', errmsg: 'maxTimeMS value 9999999999999 is out of range' })],
  ['MongoInvalidArgumentError: timeoutMS inside a withTransaction that has one',
    () => new MongoInvalidArgumentError('An operation cannot be given a timeoutMS setting when inside a withTransaction call that has a timeoutMS setting')],
  ['MongoInvalidArgumentError: a negative Timeout',
    () => new MongoInvalidArgumentError('Cannot create a Timeout with a negative duration')],
  ['a wrapper that lost the code and kept only the option\'s name',
    () => new Error('Executor error during getMore command: cannot set maxTimeMS on getMore command')],
];

/** The deadline passing, in every spelling it reaches the callers in today. */
const DEADLINES = [
  ['MongoServerError 50 MaxTimeMSExpired', () => serverError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'operation exceeded time limit' })],
  ['MongoServerError 50 whose words are gone', () => serverError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'x' })],
  ['MongoServerError 262 ExceededTimeLimit with the store\'s words', () => serverError({ code: 262, codeName: 'ExceededTimeLimit', errmsg: 'operation exceeded time limit' })],
  ['a wrapper that lost the code and kept the store\'s words',
    () => new Error('Executor error during find command :: caused by :: operation exceeded time limit')],
  ['a wrapper whose words are only "exceeded time limit"', () => new Error('exceeded time limit')],
];

/** Controls: failures that are not deadlines for other reasons, so "everything is a deadline" cannot pass. */
const NOT_DEADLINES = [
  ['a duplicate key', () => serverError({ code: 11000, codeName: 'DuplicateKey', errmsg: 'E11000 duplicate key error collection: x index: _id_' })],
  ['a step-down', () => serverError({ code: 11602, codeName: 'InterruptedDueToReplStateChange', errmsg: 'operation was interrupted' })],
  ['a dropped connection', () => new MongoNetworkError('connection 3 to 127.0.0.1:27017 closed')],
  ['a plain Error', () => new Error('upstream timed out')],
];

describe('the readers\' deadline question', () => {
  it('derived its cases from the driver\'s real classes', () => {
    for (const [, make] of [...MISUSE, ...DEADLINES, ...NOT_DEADLINES]) {
      const err = make();
      assert.ok(err instanceof Error);
    }
    assert.ok(serverError({ code: 50, errmsg: 'x' }) instanceof MongoServerError);
    assert.equal(typeof isMaxTimeExpired, 'function', 'db/max-time.js exports no isMaxTimeExpired');
  });

  it('a misused bound is not a deadline the store missed — whatever words it uses to say so', () => {
    const asDeadline = MISUSE.filter(([, make]) => isMaxTimeExpired(make()) !== false).map(([label]) => label);
    assert.deepEqual(asDeadline, [],
      'an error that names maxTimeMS because the option was misplaced is a defect in the bound: read as a deadline it is '
      + 'reported as "ran out of time" (search_timeout, GalleryIncompleteError) and retried as one');
  });

  it('PIN: every spelling of the deadline passing is still a deadline', () => {
    const missed = DEADLINES.filter(([, make]) => isMaxTimeExpired(make()) !== true).map(([label]) => label);
    assert.deepEqual(missed, [], 'a deadline that is not recognised surfaces as a 500, or as an empty answer');
  });

  it('PIN: failures that are not deadlines are not called deadlines', () => {
    const wrong = NOT_DEADLINES.filter(([, make]) => isMaxTimeExpired(make()) !== false).map(([label]) => label);
    assert.deepEqual(wrong, []);
  });

  it('PIN: it never throws on what it is handed', () => {
    for (const v of [undefined, null, 'x', 7, {}, { code: 50 }]) {
      assert.doesNotThrow(() => isMaxTimeExpired(v), `threw on ${String(v)}`);
    }
    assert.equal(isMaxTimeExpired({ code: 50 }), true);
  });
});
