/**
 * Moving this instance to another database ONLINE: a set of `migrate` acts, one per served space, whose ONE body copies the whole database
 * into the new URI under every space's hold, and whose completion saves the URI in the write that lifts the holds (bundle-157, Q-553;
 * design rev 2-5: R3.4, R4.4, R5.4, R5.7).
 *
 * ## What went wrong before it
 *
 * `POST /migrate` dumped the database to `<data>/migration-backup`, wrote a marker file, SAVED the new URI and exited. Nothing was copied:
 * the copy was left to a boot step that never existed, so the instance came back on an empty database. A `MONGO_URI` set to anything (the
 * compose default is an empty string) would have bypassed it anyway, and the marker would have outlived its use.
 *
 * ## The shape now
 *
 * - **The door** ({@link startMigrate}, called by `api/data.ts` after its refusals: an environment-sourced URI, an act standing on every
 *   space, a target that is not empty) registers a `migrate` act on every served space in ONE config write, the target URI sealed on the
 *   set's record and nowhere else ({@link sealTarget}). From that write every space is held and the instance is in maintenance.
 * - **The body** ({@link migrateInstance}) runs ONCE for the set (`wholeSet`): it dumps this database as a normal backup under the backups
 *   root (listed, pruned by retention, encrypted by the one backup setting), restores that backup into the target through the same
 *   replace code a restore uses (`restoreDatabase`: every collection dropped and reloaded), and builds every index of the source on the
 *   target. Re-run after a crash, it replaces what it copied, so a partly filled target is overwritten; the not-empty check is the door's.
 * - **The completion** is the runner's one write: every migrate entry leaves, and {@link saveTargetUri} saves the URI in that same write.
 *   Then {@link onMigrateEnd} puts this process in maintenance and ends it, so the next start connects to the new database.
 * - **A failure** of the copy is an input failure of the whole set: it ends the set, the old URI stays, every hold lifts, and the sentence
 *   names the backup. A store outage while dumping this database is retried, and so is a crash before the completion write.
 *
 * Receive marks are NOT forgotten: the data is the same data. The old database still holds every record until the operator removes it.
 */
import { MongoClient, type Db } from 'mongodb';
import { getDb } from './mongo.js';
import { restoreDatabase } from './restore.js';
import { runBackupNow } from './backup-scheduler.js';
import { dbNameFromUri } from './db-name.js';
import { mongoClientOptions } from './client-options.js';
import { isDuplicateKey } from './write-errors.js';
import { getConfig } from '../config/loader.js';
import { redactUri } from '../config/mongo-uri.js';
import { resolveMasterSecret, isEnvelope, encryptEnvelope, decryptEnvelope } from '../config/secretbox.js';
import { configuredSpaces } from '../spaces/space-lookup.js';
import {
  defineSpaceActBody, defineSpaceActSetHooks, registerSpaceActSet, runSpaceAct, instanceWideActStanding, spaceActSetTarget,
  SpaceActInputFailure, type SpaceActBodyContext, type SpaceActBodyOutcome,
} from '../spaces/space-act-runner.js';
import { setMaintenanceActive } from '../maintenance.js';
import { isStoreSide } from '../brain/store-failure.js';
import { answerForCaught } from '../util/answer-for-caught.js';
import type { Config, SpaceActKind, SpaceActSet } from '../config/types.js';
import { log, peerText } from '../util/log.js';

const KIND = 'migrate' satisfies SpaceActKind;

/** The client a migrate opens on the target: the whole-database copy's figures, and the operator's own where the URI names them. */
const targetClient = (uri: string): MongoClient =>
  new MongoClient(uri, mongoClientOptions(uri, { serverSelectionTimeoutMS: 15_000, connectTimeoutMS: 15_000 }));

// ── the target URI, sealed ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The target URI as the set's record stores it: an envelope under the master secret when one is configured, else the URI as given (the
 * config file that holds it is then as protected as the `mongo.uri` it becomes). It carries credentials, so it is stored nowhere else,
 * never projected by a report, and only ever logged through `redactUri`.
 */
export function sealTarget(uri: string): string {
  const secret = resolveMasterSecret();
  return secret ? encryptEnvelope(uri, secret) : uri;
}

/** The target URI back from its sealed form; THROWS {@link SpaceActInputFailure} when it was sealed under a secret no longer configured. */
function unsealTarget(sealed: string): string {
  if (!isEnvelope(sealed)) return sealed;
  const secret = resolveMasterSecret();
  try {
    if (!secret) throw new Error('no master secret');
    return decryptEnvelope(sealed, secret);
  } catch {
    throw new SpaceActInputFailure('the target URI was sealed with a master secret this process does not hold, so it cannot be read back.');
  }
}

// ── the door ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Does the database `uri` names hold any collection? Asked by the door before it registers anything, never by the body (a re-run
 * overwrites what it copied). The answer is a boolean: the target's collection names are not this instance's to repeat.
 */
export async function targetHoldsData(uri: string): Promise<boolean> {
  const client = targetClient(uri);
  try {
    await client.connect();
    const names = await client.db(dbNameFromUri(uri)).listCollections({}, { nameOnly: true }).toArray();
    return names.some(c => !c.name.startsWith('system.'));
  } finally {
    await client.close().catch(() => {});
  }
}

/** The answer of a migrate the door registered. */
export interface MigrateStarted { migrateId: string; spaces: string[] }

/**
 * Register a migrate to `uri` as one act per served space and start its one body; null when an instance-wide act stands (asked again
 * here, in the same turn as the registration, because the door awaited the target).
 */
export function startMigrate(uri: string): MigrateStarted | null {
  if (instanceWideActStanding() !== null) return null;
  const spaces = configuredSpaces().map(s => s.id);
  const { set, entryIds } = registerSpaceActSet({ kind: KIND, localIds: spaces, target: sealTarget(uri) });
  // Any member's run is the set's one run; the first is asked.
  if (entryIds[0]) void runSpaceAct(entryIds[0], { via: 'door' });
  log.info(`migrate ${peerText(set.id)} to ${peerText(redactUri(uri))} registered on ${spaces.length} space(s)`);
  return { migrateId: set.id, spaces };
}

// ── the body ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every index of the collections `names` on `source`, built on `target` (the `_id` index is the collection's own). */
async function copyIndexes(source: Db, target: Db, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const specs = (await source.collection(name).indexes())
      .filter(ix => ix.name !== '_id_')
      .map(({ v: _v, ns: _ns, ...spec }) => spec);
    if (specs.length > 0) await target.collection(name).createIndexes(specs as never);
  }
}

/** Our sentence for a failure, never a driver's text. */
const said = (err: unknown): string => answerForCaught(err, 'the migrate act', { refusals: true }).body.error;

/**
 * Copy this database into the set's target: dump it as a normal backup, restore that backup into the target (replacing whatever a
 * crashed attempt left there) and build the source's indexes on it. Every space is held by the set while this runs.
 */
async function migrateInstance(ctx: SpaceActBodyContext): Promise<SpaceActBodyOutcome> {
  const sealed = ctx.entry.setId ? spaceActSetTarget(ctx.entry.setId) : undefined;
  if (!sealed) throw new SpaceActInputFailure('the migrate names no target database.');
  const target = unsealTarget(sealed);

  let backup;
  try {
    backup = await runBackupNow({ underAct: KIND });
  } catch (err) {
    if (isStoreSide(err)) throw err;
    throw new SpaceActInputFailure(`the dump of this database failed: ${said(err)}`);
  }

  const client = targetClient(target);
  try {
    await restoreDatabase(target, backup.dir);
    await client.connect();
    await copyIndexes(getDb(), client.db(dbNameFromUri(target)), backup.manifest.collections.map(c => c.name));
  } catch (err) {
    const why = isDuplicateKey(err) ? 'an index of this database refuses records the new database now holds' : said(err);
    throw new SpaceActInputFailure(`copying backup '${backup.id}' into the new database failed: ${why}. The old database stays in use and `
      + `backup '${backup.id}' holds what was copied; the new database may hold part of it and must be emptied before another migrate.`);
  } finally {
    await client.close().catch(() => {});
  }
  return { report: { backupId: backup.id } };
}

// ── the completion and the end ────────────────────────────────────────────────────────────────────────────────

/** In the completion write that removes every migrate entry: the new URI becomes the configured one. */
function saveTargetUri(cfg: Config, set: Readonly<SpaceActSet>): void {
  if (!set.target) throw new SpaceActInputFailure('the migrate names no target database.');
  cfg.mongo = { ...cfg.mongo, uri: unsealTarget(set.target) };
}

/**
 * When the set ends, once. Completed: this process still holds a connection to the OLD database while every hold has lifted, so it goes
 * into maintenance (in memory, gone with the process) and ends; the next start connects to the saved URI. Under `NODE_ENV=test` it does
 * not end the process. Abandoned: the old URI stands, and the sentence names the backup.
 */
function onMigrateEnd(set: Readonly<SpaceActSet>): void {
  if (set.outcome === 'abandoned') {
    log.error(`migrate ${peerText(set.id)} ended without completing; the database URI is unchanged. ${peerText(set.lastError ?? '')}`);
    return;
  }
  const uri = getConfig().mongo?.uri ?? '';
  log.info(`migrate ${peerText(set.id)} completed: the database URI is now ${peerText(redactUri(uri))}. `
    + 'The old database still holds every record until the operator removes it.');
  setMaintenanceActive(true);
  if (process.env['NODE_ENV'] === 'test') {
    log.warn('migrate: NODE_ENV=test - the process is not ended; maintenance stays on');
    return;
  }
  log.info('migrate: ending the process so the next start connects to the new database');
  process.kill(process.pid, 'SIGTERM');
}

defineSpaceActBody(KIND, migrateInstance);
defineSpaceActSetHooks(KIND, { onSetEnd: onMigrateEnd, inCompletionWrite: saveTargetUri });
