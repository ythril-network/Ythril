/**
 * Database restore utility.
 *
 * Reads NDJSON files produced by dumpDatabase() and restores them into the
 * target MongoDB instance. Each collection is dropped before being restored so
 * the operation is idempotent.
 *
 * Reusable by both the DB migration flow (restore into new instance) and the
 * manual restore feature. Accepts any valid MongoDB URI.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { MongoClient } from 'mongodb';
import { EJSON } from 'bson';
import type { DumpManifest } from './dump.js';
import {
  isEnvelope, decryptWithKey, deriveKeyForSalt, resolveMasterSecret,
  type MasterSecret, type DerivedKey,
} from '../config/secretbox.js';
import { log, peerText } from '../util/log.js';
import { dbNameFromUri } from './db-name.js';

/**
 * Decrypt one record line, resolving the master secret at most once per restore.
 *
 * The obvious implementation — `decryptEnvelope(line, secret)` per line — is correct and derives the key from
 * each envelope's own salt on **every call**. With a passphrase that is one scrypt per record, so a large
 * collection would take hours: the same trap the write side avoids with `deriveKey`, waiting to be
 * reintroduced on the read side.
 *
 * A dump writes ONE salt for the whole file, so every line after the first re-derives on identical inputs.
 * This derives per distinct salt instead — once, in practice — and then uses `decryptWithKey`.
 *
 * A raw-key secret has no derivation cost, so this only matters for the passphrase case. That is also the case
 * where getting it wrong is measured in hours rather than milliseconds.
 */
function makeLineDecryptor(): (raw: string) => string {
  let secret: MasterSecret | null | undefined;
  // The derived KEY, cached on the salt it was derived from. Caching a closure that called
  // `decryptEnvelope` — the first version of this — memoised nothing: that function derives from each
  // envelope’s own salt on every call, which is precisely the per-record scrypt this design exists to avoid.
  let cached: { salt: string; dk: DerivedKey } | null = null;

  return (line: string): string => {
    if (secret === undefined || secret === null) {
      // Re-resolving after a null is deliberate: it cannot succeed, and the throw below is the point — every
      // encrypted line must fail with the actionable message, not just the first one.
      secret = resolveMasterSecret();
      if (secret === null) {
        throw new Error(
          'This backup is encrypted but no master secret is configured. Set the YTHRIL_MASTER_KEY or '
          + 'YTHRIL_MASTER_PASSPHRASE this dump was written with, then restore again. Without it the data '
          + 'cannot be recovered — that is by design.',
        );
      }
    }
    const saltB64 = (JSON.parse(line) as { salt?: string }).salt ?? '';
    if (cached?.salt !== saltB64) {
      // One derivation per DISTINCT salt. A normal dump has exactly one for the whole file, so this runs
      // once; a hand-merged file with several still pays per salt rather than per record.
      cached = { salt: saltB64, dk: deriveKeyForSalt(secret, saltB64 ? Buffer.from(saltB64, 'base64') : null) };
    }
    return decryptWithKey(line, cached.dk);
  };
}

const INSERT_BATCH_SIZE = 500;

/**
 * Restore all collections from srcDir into the given MongoDB URI.
 * Reads manifest.json to determine the collection list and order.
 * Each collection is dropped before inserting the restored documents.
 */
export async function restoreDatabase(uri: string, srcDir: string): Promise<void> {
  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DumpManifest;
  const { collections } = manifest;

  // One decryptor for the whole restore, so its key derivation is shared across every collection rather than
  // repeated per file. It resolves the master secret lazily — a plaintext dump never touches it, so a restore
  // on an instance with no master secret configured works exactly as it did before.
  const decryptLine = makeLineDecryptor();

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });

  try {
    await client.connect();
    const db = client.db(dbNameFromUri(uri));

    for (const { name, count: expectedCount } of collections) {
      const srcFile = path.join(srcDir, `${name}.ndjson`);
      if (!fs.existsSync(srcFile)) {
        log.warn(`restore: ${peerText(name)}.ndjson not found — skipping`);
        continue;
      }

      // A collection the dump recorded as EMPTY still has to come back.
      //
      // Skipping it left the restored instance without the collection at all: a dump→drop→restore round trip
      // returned three of four collections and reported success. `initSpace` recreates the per-space ones on the
      // next boot, which is why this was survivable and therefore invisible — but a restore that silently
      // returns less than it took is not something to leave resting on a later repair.
      if (expectedCount === 0) {
        await db.createCollection(name).catch(() => {
          // Already there (a restore over a live database) — nothing to do.
        });
        log.debug(`restore: ${peerText(name)} ← 0 docs (collection created)`);
        continue;
      }

      // Drop existing data before restoring
      await db.collection(name).drop().catch(() => {
        // Ignore "ns not found" — collection may not exist yet on a fresh DB
      });

      const col = db.collection(name);

      let batch: Record<string, unknown>[] = [];
      let insertedCount = 0;

      const rl = readline.createInterface({
        input: fs.createReadStream(srcFile, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Encryption is DETECTED, not configured.
        //
        // There is deliberately no "was this encrypted?" setting on restore. `isEnvelope` recognises our own
        // envelope by its unambiguous `ythrilEnc` marker, so an operator restoring a backup never has to
        // remember how it was written — which removes a whole class of "restored it the wrong way" error on
        // the most stressful operation they ever perform. It also means a dump restores correctly with the
        // manifest lost or hand-edited, and that a MIXED file (some lines encrypted, some not) still works.
        //
        // The key is derived lazily, once, from the first envelope's own salt — not per line, which would be
        // one scrypt per record. `decryptLine` owns that; see its definition.
        const plain = isEnvelope(trimmed) ? decryptLine(trimmed) : trimmed;
        // Extended JSON, matching the dump. On a pre-existing plain-JSON dump this behaves exactly as
        // `JSON.parse` did — EJSON only reinterprets the `$date`/`$oid` wrappers it wrote itself — so older
        // backups still restore, with their old (string-dated) semantics rather than a hard failure.
        batch.push(EJSON.parse(plain) as Record<string, unknown>);

        if (batch.length >= INSERT_BATCH_SIZE) {
          await col.insertMany(batch, { ordered: false });
          insertedCount += batch.length;
          batch = [];
        }
      }

      if (batch.length > 0) {
        await col.insertMany(batch, { ordered: false });
        insertedCount += batch.length;
      }

      log.debug(`restore: ${peerText(name)} → ${insertedCount} docs (expected ${expectedCount})`);
    }

    log.info(`restore: complete — ${collections.length} collections restored from ${peerText(srcDir)}`);
  } finally {
    await client.close().catch(() => {});
  }
}
