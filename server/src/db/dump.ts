/**
 * Database dump utility.
 *
 * Streams all collections from the MongoDB database specified in the URI to a
 * directory as NDJSON files (one JSON document per line). Writes a manifest.json
 * describing the dump.
 *
 * Designed to be reusable by both the DB migration flow and the manual backup
 * feature (issue #82). Accepts any valid MongoDB URI — does not reuse the
 * server's live connection singleton so it can dump from any instance.
 *
 * Output layout:
 *   <destDir>/manifest.json          — metadata
 *   <destDir>/<collection>.ndjson    — one per collection
 *
 * Note: Only MongoDB data is dumped. Files stored in /data/files are NOT
 * included. A complete backup requires a separate copy of the /data/files
 * directory.
 */
import fs from 'node:fs';
import { FILE_MODE, mkdirPrivateSync } from '../util/fs-modes.js';
import { resolveMasterSecret, deriveKey, encryptWithKey, type DerivedKey } from '../config/secretbox.js';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { EJSON } from 'bson';
import { log } from '../util/log.js';
import { dbNameFromUri } from './db-name.js';

const MANIFEST_VERSION = 1 as const;
const CURSOR_BATCH_SIZE = 500;

export interface DumpManifest {
  version: typeof MANIFEST_VERSION;
  ythrilVersion: string;
  createdAt: string;
  sourceUriRedacted: string;
  collections: Array<{ name: string; count: number }>;
  /**
   * True when every record line in this dump is an encryption envelope.
   *
   * `restoreDatabase` does not rely on this — it detects an envelope per line, so a dump restores correctly
   * even if the manifest is lost or hand-edited, and a mixed file still works. The flag exists so an
   * OPERATOR (and the UI) can tell what a directory holds without opening a data file and reading ciphertext.
   */
  encrypted?: boolean;
}

/** Options for {@link dumpDatabase}. */
export interface DumpOptions {
  /**
   * Encrypt every record line with the configured master secret.
   *
   * **Measured cost:** roughly 1.4x on large records and up to 3x on a database of very small ones (the fixed
   * envelope header dominates). Per-line is still the right shape — per-file would make restore load an entire
   * collection into fact, which is unbounded rather than merely large.
   *
   * Default **false** — plaintext, which is the owner's chosen default: a backup you cannot restore is not a
   * backup, and encrypting by default makes disaster recovery onto a fresh instance depend on having the old
   * key to hand *before* the restore.
   */
  encrypt?: boolean;
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@]+@/, '//[credentials]@');
}

/**
 * Dump all collections from the given MongoDB URI into destDir.
 * Creates destDir if it does not exist.
 * Returns the manifest describing the dump.
 */
export async function dumpDatabase(uri: string, destDir: string, opts: DumpOptions = {}): Promise<DumpManifest> {
  // Derive the key ONCE for the whole dump, before any collection is opened.
  //
  // This hoist is the entire reason `deriveKey`/`encryptWithKey` exist. `encryptEnvelope` derives inside every
  // call, so encrypting per record through it would run one scrypt (N=16384, tens of milliseconds) PER RECORD —
  // a hundred thousand records is hours and the backup would look like a hang. One derivation, one salt, a
  // fresh IV per line.
  //
  // Resolved up front so "encryption was asked for and no secret is configured" fails BEFORE a single byte is
  // written, rather than leaving a half-plaintext directory behind.
  let dk: DerivedKey | null = null;
  if (opts.encrypt) {
    const secret = resolveMasterSecret();
    if (!secret) {
      throw new Error(
        'Backup encryption is enabled but no master secret is configured. Set YTHRIL_MASTER_KEY or '
        + 'YTHRIL_MASTER_PASSPHRASE, or turn encryption off. Note that losing the secret makes the backup '
        + 'unrecoverable — back it up somewhere other than the instance it protects.',
      );
    }
    dk = deriveKey(secret);
  }

  // 0700, and 0600 on every file below.
  //
  // A dump is a COMPLETE PLAINTEXT COPY of the database — every fact, entity, edge, chrono entry, file-meta
  // record and audit entry, as NDJSON. It is written by reading THROUGH mongod, so an encrypted `mongod` (the
  // mitigation `02-hosting.md` recommends for brain data) protects nothing here: the dump comes out decrypted.
  //
  // These directories were created with default permissions — typically 0755, with 0644 files — while the app's
  // own state files have always been written 0600. So the least sensitive thing on the volume was the best
  // protected. Found by the Privacy audit lens.
  //
  // This is a tightening only: the owning process is the sole reader, and `restoreDatabase` runs as the same user.
  mkdirPrivateSync(destDir);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });

  try {
    await client.connect();
    const db = client.db(dbNameFromUri(uri));

    const collectionInfos = await db.listCollections().toArray();
    const collectionNames = collectionInfos
      .map(c => c.name)
      .filter(n => !n.startsWith('system.'))
      .sort();

    const manifestCollections: DumpManifest['collections'] = [];

    for (const name of collectionNames) {
      const col = db.collection(name);
      const destFile = path.join(destDir, `${name}.ndjson`);
      const stream = fs.createWriteStream(destFile, { encoding: 'utf8', mode: FILE_MODE });

      let count = 0;
      const cursor = col.find({}).batchSize(CURSOR_BATCH_SIZE);

      try {
        for await (const doc of cursor) {
          // Extended JSON, not `JSON.stringify`.
          //
          // NDJSON has no date type, so a plain stringify wrote `_expireAt` as a string — and on restore it came
          // back a string. The TTL index only matches BSON dates, so every record the operator asked to expire
          // silently became permanent, for as long as that instance ran. Nothing errors; the retention policy
          // just stops applying, and only after a restore.
          //
          // `EJSON.stringify` in relaxed mode keeps numbers and strings looking like ordinary JSON (so a dump
          // stays readable and greppable) while wrapping the types JSON cannot express — `{"$date": …}` for a
          // Date, `{"$oid": …}` for an ObjectId. `EJSON.parse` reverses it, and on a pre-existing plain-JSON dump
          // it behaves exactly as `JSON.parse` did, so old backups still restore with their old semantics.
          //
          // Encryption, when enabled, wraps this ONE line — per record, not per file. Per-file would mean
          // `restoreDatabase` loading an entire collection into fact to decrypt it, which is unbounded and
          // only bites once the database is large. `dk` is derived once above, so this is a cheap AES call plus
          // a fresh IV, not a key derivation.
          const line = EJSON.stringify(doc, { relaxed: true });
          stream.write((dk ? encryptWithKey(line, dk) : line) + '\n');
          count++;
        }
      } finally {
        await cursor.close().catch(() => {});
      }

      // Flush the write stream
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });

      manifestCollections.push({ name, count });
      log.debug(`dump: ${name} → ${count} docs`);
    }

    const ythrilVersion = process.env['npm_package_version'] ?? 'unknown';

    const manifest: DumpManifest = {
      version: MANIFEST_VERSION,
      ythrilVersion,
      createdAt: new Date().toISOString(),
      sourceUriRedacted: redactUri(uri),
      collections: manifestCollections,
      ...(dk ? { encrypted: true } : {}),
    };

    fs.writeFileSync(
      path.join(destDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    log.info(`dump: complete — ${manifestCollections.length} collections in ${destDir}`);
    return manifest;
  } finally {
    await client.close().catch(() => {});
  }
}
