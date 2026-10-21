/**
 * "Give me an empty target a migrate can start on" - asked by every test that migrates into a database of the harness Mongo.
 *
 * ## What a hand-written `dropDatabase()` drops
 *
 * **The end of the drop.** `dropDatabase` answers before the drop has finished on the harness's replica set: for a moment the database
 * is DROP PENDING, and a create in it answers `DatabaseDropPending` (215) while an index build on it is aborted (`IndexBuildAborted`,
 * 276, "caused by :: dropDatabase command"). A migrate started at once met both (Full run 39645546710, migrate-db row 5), so a row
 * about resuming a crashed copy failed on the fixture's own drop, by timing. The server now retries both as the store's condition
 * (`STORE_ERROR_CODES`); a fixture that hands a test a target still dropping makes the row about that retry instead of its own subject.
 *
 * So this drops, then waits until the database takes a create - the one probe that cannot pass while the drop is pending - and drops
 * the probe again, leaving the database empty (no collection: a migrate's not-empty check passes). Bounded by `waitFor`, which names
 * what never held.
 */
import { waitFor } from '../_shared/wait-for.mjs';

const PROBE = 'migrate_target_probe';

/** Drop `dbName` through `client` and resolve once the drop has finished and the database is empty. */
export async function emptyTarget(client, dbName, { timeout = 30_000 } = {}) {
  const db = client.db(dbName);
  await db.dropDatabase();
  await waitFor(async () => {
    try {
      await db.createCollection(PROBE);
    } catch (err) {
      if (err?.code === 215 || err?.code === 48) return false;   // still dropping; or a probe from a try whose drop is pending
      throw err;
    }
    await db.collection(PROBE).drop();
    return true;
  }, timeout, 50, undefined, { what: `the drop of ${dbName} to finish` });
}
