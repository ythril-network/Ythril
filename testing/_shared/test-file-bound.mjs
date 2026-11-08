/**
 * How long one standalone test, and one test FILE, may run before the runner calls it failed: the bound every `node --test` the standalone runner
 * starts carries (`testing/_init/run-standalone.mjs`).
 *
 * ## What it prevents
 *
 * A test that waits for something that never comes ran for SEVEN HOURS in the Docker runner (bundle-255, 2026-11-08): a case of
 * a-derived-write-racing-a-delete-or-a-move-leaves-no-row-db parked a driver call (`updateMany`) that the changed delete no longer made, so its
 * `await flag.reached` never settled, nothing failed, and nothing named the file. With the bound it fails in minutes and the report names the test.
 *
 * Two bounds, because they catch two different hangs (probed in the runner image, node 24):
 *  - `--test-timeout` fails a test, or a hook, that is still pending after {@link TEST_FILE_TIMEOUT_MS}: the case above;
 *  - a wall-clock limit on the child process ({@link batchTimeoutMs}) ends a file whose tests all finished but which never exits (a handle left open:
 *    a worker, a server, an interval), which `--test-timeout` does not reach.
 *
 * The one place the numbers live, so no spawn site can start a child without them: `boundedTestArgs` puts the flag first, and the gate
 * every-standalone-test-run-is-time-bounded refuses a `--test` in the runner that does not come through it.
 */

/** One test's, and one file's, limit: well above the slowest file the suite has (a -db file alone runs for a few minutes). */
export const TEST_FILE_TIMEOUT_MS = 15 * 60 * 1000;

/** `node --test` with the per-test bound, then the caller's flags and files. */
export function boundedTestArgs(...rest) {
  return ['--test', `--test-timeout=${TEST_FILE_TIMEOUT_MS}`, ...rest];
}

/** The wall-clock limit for one child running `fileCount` files one after another: one file's bound each, never less than one. */
export function batchTimeoutMs(fileCount) {
  return TEST_FILE_TIMEOUT_MS * Math.max(1, fileCount);
}
