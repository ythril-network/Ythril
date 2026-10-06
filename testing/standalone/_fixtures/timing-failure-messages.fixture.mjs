/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * Failures whose messages are the hard cases for a line a machine will store and a person will read later:
 * a long first line with a second line after it, secrets in the message / the test name / a skip reason, and a
 * message that is not a string. Every one of them FAILS on purpose.
 */
import { test } from 'node:test';
import { SECRETS, LONG_FIRST_LINE } from './timing-constants.mjs';

test('long multi-line failure', () => {
  throw new Error(`${LONG_FIRST_LINE}\nsecond line that must not be stored\n    at fake (frame.js:1:1)`);
});

test('short failure with a second line', () => {
  throw new Error('short first line\nsecond line of the short one\n    at fake (frame.js:2:2)');
});

test('failure that carries secrets', () => {
  throw new Error(`request failed with Authorization: ${SECRETS.bearer} and ${SECRETS.github} and ${SECRETS.ythril}`);
});

test(`a test named after ${SECRETS.githubFine}`, () => {});

test('a skip whose reason carries a secret', (t) => { t.skip(`no access with ${SECRETS.ythril}`); });

test('failure whose message is not a string', () => {
  const e = new Error('placeholder');
  e.message = 12345;
  throw e;
});
