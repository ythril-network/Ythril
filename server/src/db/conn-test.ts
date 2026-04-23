/**
 * MongoDB connection test utility.
 *
 * Opens a transient connection to the given URI, runs a ping, and closes.
 * Returns { ok: true } on success, { ok: false, error: string } on failure.
 * Uses a short timeout (5 s) so the UI doesn't hang waiting.
 */
import { MongoClient } from 'mongodb';

const TEST_TIMEOUT_MS = 5_000;

export async function testConnection(uri: string): Promise<{ ok: boolean; error?: string }> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: TEST_TIMEOUT_MS,
    connectTimeoutMS: TEST_TIMEOUT_MS,
    socketTimeoutMS: TEST_TIMEOUT_MS,
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
