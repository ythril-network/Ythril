/**
 * The server's real Mongo layer, pointed at a database whose name starts with `b81tE_` (bundle-81, test slice E).
 *
 * ## Why this is not `openTestMongo`
 *
 * `openTestMongo(suite)` names its database `ythril_harness_<suite>`. The slice that wrote these tests was allowed only
 * databases whose names start with its own prefix on the shared harness Mongo, so each -db file here opens `b81tE_<suite>`
 * and drops it on entry and on exit. It reuses the harness's own URI builder, reachability probe and tuning, and imports the
 * server's `db/mongo.js` the same way, so what runs is production's Mongo layer against production's driver.
 *
 * It is a helper of this slice and is not read by any other file; when the bundle is merged a file that wants the generic
 * harness can switch to `openTestMongo` and lose nothing but the prefix.
 */
import { testMongoUri, tuneTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

export { mongoSkipReason };
export const B81E_PREFIX = 'b81tE_';

/** Connect the server's `db/mongo.js` to `b81tE_<suite>`, emptied. Call from `before()`. */
export async function openB81Mongo(suite) {
  process.env['MONGO_URI'] = testMongoUri(`${B81E_PREFIX}${suite}`);
  const mongo = await import('../../server/dist/db/mongo.js');
  mongo._resetDbName?.();
  await mongo.connectMongo();
  try {
    await tuneTestMongo();
    await mongo.getDb().dropDatabase();
  } catch (err) {
    await closeB81Mongo(mongo);
    throw err;
  }
  return mongo;
}

/** Drop the database and disconnect. Call from `after()`. */
export async function closeB81Mongo(mongo) {
  if (!mongo) return;
  try { await mongo.getDb().dropDatabase(); } catch { /* best-effort */ }
  await mongo.closeMongo();
}
