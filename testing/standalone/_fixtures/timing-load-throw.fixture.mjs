/**
 * Fixture for the timing-reporter gates — NOT a test of the repo (see `timing-pass.fixture.mjs`).
 *
 * A file that throws while it LOADS, before it registers a test. node reports one failure named after the file,
 * and sends no per-file summary. (The error text itself goes to stderr, not into the failure event.)
 */
import { test } from 'node:test';

throw new Error('top-level boom');

test('never registered', () => {});
