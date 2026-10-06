/**
 * Where the published test Mongo listens: host and port, from the environment or the stack's defaults.
 *
 * Its own module, and imported by `testing/standalone/_mongo-harness.mjs`, so a PURE test can ask for the address
 * without importing the harness. Importing the harness is what makes a standalone file a database file
 * (`testing/_shared/standalone-split.mjs`, `DB_HARNESS`), and the database job installs only what database files
 * need: a compose-reading gate that took the port from the harness ran there and failed to load `js-yaml`
 * (bundle-53, PR #1489 CI).
 */
export const TEST_MONGO_HOST = process.env['YTHRIL_TEST_MONGO_HOST'] ?? '127.0.0.1';
export const TEST_MONGO_PORT = Number(process.env['YTHRIL_TEST_MONGO_PORT'] ?? 27117);
