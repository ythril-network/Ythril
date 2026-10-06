/**
 * MongoDB connection test utility.
 *
 * Opens a transient connection to the given URI, runs a ping, and closes.
 * Returns { ok: true } on success, { ok: false, error: string } on failure.
 * Uses a short timeout (5 s) so the UI doesn't hang waiting.
 *
 * ## What is tested is what boots
 *
 * The client is built by `mongoClientOptions`, the same module `connectMongo` builds the live client from, so a
 * connection string that names `connectTimeoutMS` is tested under the figure the operator wrote and the same URI is
 * judged by the same rules at the test and at the boot. The short figures are this caller's DEFAULTS, not overrides: a
 * string that names the option wins over them, here as at the boot (a URI that says `serverSelectionTimeoutMS=500` is
 * tested at 500 ms, where it used to be tested at 5 s whatever it said).
 *
 * `socketTimeoutMS` is not one of the liveness options `mongoClientOptions` owns, so it is added here, and only when the
 * string does not name it: the same "the string wins" rule, applied by the one reader of the string's query.
 */
import { MongoClient } from 'mongodb';
import { mongoClientOptions, uriQueryOptions } from './client-options.js';

const TEST_TIMEOUT_MS = 5_000;

export async function testConnection(uri: string): Promise<{ ok: boolean; error?: string }> {
  const client = new MongoClient(uri, {
    ...mongoClientOptions(uri, { connectTimeoutMS: TEST_TIMEOUT_MS, serverSelectionTimeoutMS: TEST_TIMEOUT_MS }),
    ...(uriQueryOptions(uri).has('sockettimeoutms') ? {} : { socketTimeoutMS: TEST_TIMEOUT_MS }),
  });

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.close().catch(() => {});
  }
}
