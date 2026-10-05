/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * A suite whose `before` hook throws. node reports the suite as failed and its two tests as CANCELLED, and its own
 * summary then reads `fail 0` with exit status 1 — the failure is only in the events.
 */
import { test, describe, before } from 'node:test';

describe('hook suite', () => {
  before(() => { throw new Error('before hook boom'); });
  test('never runs one', () => {});
  test('never runs two', () => {});
});
