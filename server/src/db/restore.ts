/**
 * Reading a backup back: whether it holds at its manifest ({@link backupManifestHolds}, the restore door's check) and whether it is whole
 * ({@link backupIsWhole}, every record), loading one of its collections
 * ({@link backupLoader}), and replacing a whole database with it ({@link restoreDatabase}).
 *
 * Reads NDJSON files produced by dumpDatabase(). A restore REPLACES: every collection the dump names is dropped
 * and reloaded (one it recorded as empty comes back empty), and a space's collection the dump does not name is
 * dropped, so the database afterwards is the backup and not the backup laid over what was there (bundle-157,
 * Q-554). The online restore of a running instance does not call `restoreDatabase`: it is a set of space acts
 * (`db/restore-act.ts`), each replacing its own space's collections through {@link backupLoader} under the
 * space's hold. `restoreDatabase` is the whole-database copy, on a client of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { MongoClient, type Db } from 'mongodb';
import { EJSON } from 'bson';
import type { DumpManifest } from './dump.js';
import {
  isEnvelope, decryptWithKey, deriveKeyForSalt, resolveMasterSecret,
  type MasterSecret, type DerivedKey,
} from '../config/secretbox.js';
import { log } from '../util/log.js';
import { RequestRefusal } from '../util/errors.js';
import { dbNameFromUri } from './db-name.js';
import { boundedClientOptions, closeWithinBound } from './bounded-client-options.js';
import { isNamespaceExists, isNamespaceNotFound } from './namespace-answers.js';
import { parseSpaceCollection } from './space-collection.js';

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
        throw new BackupNotWhole(
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

/** Rows one insert sends: a restore's records, far below the one-command limit at this count. */
const INSERT_BATCH_SIZE = 500;

/**
 * A backup that cannot be restored as it is: a manifest that does not parse, a file it names that is missing, a file holding another
 * count of records than the manifest says, a line that does not decrypt or parse. Our sentence, naming the collection and never a
 * path or a driver's text; a door answers it `400`, and a restore act that meets it is not retried (it needs an abandon).
 */
export class BackupNotWhole extends RequestRefusal {
  override name = 'BackupNotWhole';
}

/** One collection a manifest names, with the count of records it says the file holds. */
export type BackupCollection = DumpManifest['collections'][number];

function readManifest(dir: string): DumpManifest {
  let manifest: DumpManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as DumpManifest;
  } catch {
    throw new BackupNotWhole('the backup has no readable manifest.json');
  }
  if (!manifest || !Array.isArray(manifest.collections)
    || !manifest.collections.every(c => c && typeof c.name === 'string' && Number.isInteger(c.count) && c.count >= 0)) {
    throw new BackupNotWhole('the backup\'s manifest.json does not list its collections');
  }
  return manifest;
}

/**
 * One non-empty backup line as plain text: an envelope decrypted, anything else as it is.
 *
 * Encryption is DETECTED, not configured. There is deliberately no "was this encrypted?" setting on restore. `isEnvelope` recognises our
 * own envelope by its unambiguous `ythrilEnc` marker, so an operator restoring a backup never has to remember how it was written - which
 * removes a whole class of "restored it the wrong way" error on the most stressful operation they ever perform. It also means a dump
 * restores correctly with the manifest lost or hand-edited, and that a MIXED file (some lines encrypted, some not) still works. The key
 * is derived lazily, once, from the first envelope's own salt - not per line, which would be one scrypt per record; `decryptLine` owns
 * that, see its definition.
 */
const plainLineOf = (trimmed: string, decryptLine: (raw: string) => string): string => isEnvelope(trimmed) ? decryptLine(trimmed) : trimmed;

/** The non-empty lines of a backup file, decrypted when they are envelopes and parsed as Extended JSON, in file order. */
async function* recordsOf(file: string, decryptLine: (raw: string) => string): AsyncGenerator<Record<string, unknown>> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Extended JSON, matching the dump. On a pre-existing plain-JSON dump this behaves exactly as
    // `JSON.parse` did — EJSON only reinterprets the `$date`/`$oid` wrappers it wrote itself — so older
    // backups still restore, with their old (string-dated) semantics rather than a hard failure.
    yield EJSON.parse(plainLineOf(trimmed, decryptLine)) as Record<string, unknown>;
  }
}

/** The first non-empty line of a backup file, or null for a file with none; reads no further than it. */
async function firstLineOf(file: string): Promise<string | null> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) { const trimmed = line.trim(); if (trimmed) return trimmed; }
    return null;
  } finally { rl.close(); stream.destroy(); }
}

/**
 * Does the backup in `dir` hold together AT ITS MANIFEST: the manifest parses and lists its collections, every file it names is present, and
 * the first line of each file decrypts (an envelope with no secret to open it, or the wrong one, is refused here)? Returns the manifest, or
 * THROWS {@link BackupNotWhole}.
 *
 * ## What it prevents
 *
 * The restore door used to answer only after {@link backupIsWhole} had decrypted, parsed and counted EVERY record of the backup, so a
 * large backup outlasted a proxy's timeout while the server went on (Q-565). This is the door's whole check: its cost is the number of
 * collections, never of records, and it reads no record: one line of each file, decrypted and never parsed. A broken record, or a count that is
 * not the manifest's, is found by {@link backupIsWhole} once per restore set before any space is replaced (`wholeBackupOfSet`,
 * `restore-act.ts`) - that is where a backup is checked whole, and it is not here.
 */
export async function backupManifestHolds(dir: string): Promise<DumpManifest> {
  const manifest = readManifest(dir);
  const decryptLine = makeLineDecryptor();
  for (const { name } of manifest.collections) {
    const file = path.join(dir, `${name}.ndjson`);
    if (!fs.existsSync(file)) throw new BackupNotWhole(`the backup names collection '${name}' and holds no file for it`);
    try {
      const first = await firstLineOf(file);
      if (first !== null) plainLineOf(first, decryptLine);
    } catch (err) {
      if (err instanceof BackupNotWhole) throw err;
      throw new BackupNotWhole(`a record of collection '${name}' in the backup cannot be read`);
    }
  }
  return manifest;
}

/**
 * Is the backup in `dir` whole and readable, for the collections `only` selects (every one when absent)? Returns its manifest, or
 * THROWS {@link BackupNotWhole}: the manifest parses, every selected collection's file is present, holds exactly the count the manifest
 * says, and every line of it decrypts and parses.
 *
 * ## What it prevents
 *
 * The restore used to find a missing file only by skipping it with a warning, and a short file only in a debug line - after it had
 * dropped the collection. A restore over a broken backup emptied what it could not reload and reported success. This is THE rule for
 * "this backup can be restored": the first act of a restore set asks it for the whole backup before any space is replaced
 * (`wholeBackupOfSet`, `restore-act.ts`), and each act asks it again for its own space before it replaces a collection, because the
 * backup can change on disk between the two. A migrate's `restoreDatabase` asks it too. It reads every selected record once, which is the
 * price of knowing before dropping rather than after - and why the restore DOOR does not ask it ({@link backupManifestHolds}).
 */
export async function backupIsWhole(dir: string, { only }: { only?: (name: string) => boolean } = {}): Promise<DumpManifest> {
  const manifest = readManifest(dir);
  const decryptLine = makeLineDecryptor();
  for (const { name, count } of manifest.collections) {
    if (only && !only(name)) continue;
    const file = path.join(dir, `${name}.ndjson`);
    if (!fs.existsSync(file)) throw new BackupNotWhole(`the backup names collection '${name}' and holds no file for it`);
    let n = 0;
    try {
      for await (const _record of recordsOf(file, decryptLine)) n++;
    } catch (err) {
      if (err instanceof BackupNotWhole) throw err;
      throw new BackupNotWhole(`a record of collection '${name}' in the backup cannot be read`);
    }
    if (n !== count) throw new BackupNotWhole(`the backup's file for collection '${name}' holds ${n} record(s) and its manifest says ${count}`);
  }
  return manifest;
}

/** The records of one backup collection, decrypted and parsed, for a reader that wants a few of them (a space's counter doc). */
export function backupRecords(dir: string, name: string): AsyncGenerator<Record<string, unknown>> {
  return recordsOf(path.join(dir, `${name}.ndjson`), makeLineDecryptor());
}

/** Load one backup collection into `db` (which the caller emptied); returns the count loaded. */
export type BackupLoad = (db: Db, dir: string, collection: BackupCollection) => Promise<number>;

/**
 * A loader of backup collections sharing ONE decryptor, so its key derivation is shared across every collection rather than repeated
 * per file. It resolves the master secret lazily: a plaintext dump never touches it. It inserts into the collection as it stands -
 * dropping it is the caller's, who knows what else the collection needs first (its indexes, so a duplicate the backup holds is refused
 * at the insert) - and THROWS {@link BackupNotWhole} when the file is missing or the count loaded is not the manifest's.
 */
export function backupLoader(): BackupLoad {
  const decryptLine = makeLineDecryptor();
  return async (db, dir, { name, count: expectedCount }) => {
    const srcFile = path.join(dir, `${name}.ndjson`);
    if (!fs.existsSync(srcFile)) throw new BackupNotWhole(`the backup names collection '${name}' and holds no file for it`);
    const col = db.collection(name);
    let batch: Record<string, unknown>[] = [];
    let insertedCount = 0;
    for await (const doc of recordsOf(srcFile, decryptLine)) {
      batch.push(doc);
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
    if (insertedCount !== expectedCount) {
      throw new BackupNotWhole(`the backup's file for collection '${name}' loaded ${insertedCount} record(s) and its manifest says ${expectedCount}`);
    }
    log.debug(`restore: ${name} → ${insertedCount} docs`);
    return insertedCount;
  };
}

/**
 * Replace the database at `uri` with the backup in `srcDir`, on a client of its own: every collection the manifest names is dropped and
 * reloaded (one it recorded as EMPTY comes back empty, never kept with what arrived after the backup), and every space collection the
 * manifest does not name is dropped, so a space created after the backup holds nothing afterwards. A collection that is neither (a read
 * spill, which a dump leaves out) is left alone. The backup is checked whole first ({@link backupIsWhole}), so a broken one drops nothing.
 */
export async function restoreDatabase(uri: string, srcDir: string): Promise<void> {
  const manifest = await backupIsWhole(srcDir);
  const { collections } = manifest;
  const load = backupLoader();

  // Inside a bound scope (a migrate's act) every operation of this client carries the scope's per-operation figure; a write the client's
  // clock ended may still land, which a retry overwrites because it drops and reloads every collection (`bounded-client-options.ts`).
  const client = new MongoClient(uri, boundedClientOptions(uri, { serverSelectionTimeoutMS: 15_000, connectTimeoutMS: 15_000 }));

  try {
    await client.connect();
    const db = client.db(dbNameFromUri(uri));
    const named = new Set(collections.map(c => c.name));

    // Only the store's "not there" and "already there" are tolerated below; anything else - a timeout of a target that stopped answering
    // above all - is thrown, so the attempt ends at the first failed operation instead of paying a bound for each one after it (Q-564).
    for (const entry of collections) {
      // A collection a fresh database does not have yet.
      await db.collection(entry.name).drop().catch((err: unknown) => { if (!isNamespaceNotFound(err)) throw err; });
      // A collection the dump recorded as EMPTY still has to come back: skipping it left the restored instance without it. One a
      // concurrent writer created is empty either way.
      await db.createCollection(entry.name).catch((err: unknown) => { if (!isNamespaceExists(err)) throw err; });
      await load(db, srcDir, entry);
    }

    // A space's collection the backup does not hold was written after it: dropped, so the database is the backup.
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (!named.has(name) && parseSpaceCollection(name)) {
        await db.collection(name).drop().catch((err: unknown) => { if (!isNamespaceNotFound(err)) throw err; });
      }
    }

    log.info(`restore: complete — ${collections.length} collections restored from ${srcDir}`);
  } finally {
    await closeWithinBound(client);
  }
}
