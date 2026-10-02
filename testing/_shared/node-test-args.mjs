/**
 * The arguments every standalone test batch is run with — the ONE place both runners read them from.
 *
 * ## Why it is a module
 *
 * Two runners start the standalone batches: `scripts/preflight.mjs` before a push, and
 * `testing/_init/run-standalone.mjs` for `npm run test:standalone` in CI. A flag added to one and not the other is
 * a preflight that passes where CI hangs, or the reverse.
 *
 * ## `--test-force-exit`, and the hang it ends
 *
 * Node's runner waits for every test file's process to EXIT, not just to finish reporting. A file that still holds
 * an open handle after its last test — a Mongo client a failed setup never closed — keeps its process alive, and
 * the runner waits on it for ever, printing nothing. PR #1475's Build & Test sat in `test:standalone` for an hour
 * that way before it was cancelled to read the log. With the flag a file is ended once its tests have reported:
 * the failure that leaked the handle still shows as failing tests, and only the silent hang is gone.
 *
 * The harness modules close what they open on a failed setup too (`_mongo-harness.mjs`, `_push-door.mjs`, gated by
 * `a-failed-harness-setup-leaves-no-connection-open-db.test.js`); this flag is the backstop for a handle nobody has
 * found yet.
 */
export const NODE_TEST_ARGS = Object.freeze(['--test', '--test-force-exit']);
