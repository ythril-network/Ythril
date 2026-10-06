/**
 * Strings the timing fixtures and the timing-reporter gates must agree on — a leaf module with no imports, so a
 * fixture never depends on the helper whose behaviour it is there to exercise.
 *
 * The token-shaped strings are BUILT here so no source line in the repo is itself token-shaped (a secret scanner
 * reads the source, not the run). Fixtures use them, the gates assert they never reach a timing file.
 */
export const SECRETS = Object.freeze({
  github: 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  githubFine: 'github' + '_pat_' + '11ABCDEFG0abcdefghijkl_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx',
  ythril: 'ythril' + '_' + '7Zk3Qp9XvB2mTn5Ls8Wc1Yd4Hf6Jr0GaEuNiOx',
  bearer: 'Bearer ' + 'eyJhbGciOiJIUzI1NiJ9abcDEF123456',
});

/** The first line of the long failure in `timing-failure-messages.fixture.mjs`: 29 + 500 characters, past any cap. */
export const LONG_FIRST_LINE = 'first line of a long failure ' + 'x'.repeat(500);

/** What `timing-slow.fixture.mjs` prints once its second test is under way. */
export const READY = 'TIMING-FIXTURE-READY';

