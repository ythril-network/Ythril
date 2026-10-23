/**
 * The online restore of a running instance: a set of space acts, one per served space, that replaces each space's data with the backup's
 * under the space's hold, and forgets only what the space RECEIVED (bundle-157, Q-552, Q-554; design rev 2-5).
 *
 * ## What went wrong before it
 *
 * `POST /restore` turned maintenance on and dropped and reloaded every collection inline. Maintenance stops HTTP callers that are not
 * admins and nothing else: an exchange this instance started, a timer's write, an admin's write all landed while collections were dropped
 * and reloaded. A collection the backup held empty kept what arrived after it, a space created after the backup kept its records, the
 * counter came back below seqs already handed out, the receive marks still said "read up to" a seq the database no longer held (so what
 * arrived after the backup was never asked for again), and a crash half-way left nothing on disk saying a restore was owed.
 *
 * ## The shape now
 *
 * - **The door** ({@link planRestore}, {@link startRestore}) checks the backup whole before it registers anything, refuses a backup that
 *   names a space this instance does not serve unless the operator leaves it out, and registers a `restore` act on EVERY served space in
 *   one config write (`registerSpaceActSet`). From that write every space is held (writes refused, exchanges held) and the instance is in
 *   maintenance (`maintenance.ts`), and both last until the last act ends.
 * - **The body** ({@link restoreSpace}), per space, inside the runner's bound: the backup is checked again for this space (it can change on
 *   disk), the counter floor is taken after the drain, the space's collections are dropped and created again with every declared index
 *   (`spaces/space-indexes.ts`, the TTL ones included: every collection is created now, so the ones not built at boot are built too; on
 *   empty collections, so the unique indexes refuse a duplicate the backup holds at the insert), the backup's records are loaded, the
 *   counter is written to at least the floor, every declared UNIQUE index is asserted to stand, and the vector indexes are reconciled. A
 *   broken backup or a duplicate is an INPUT failure: not retried, the space stays held until an operator abandons
 *   (`POST /api/admin/data/restore/abandon`, `spaces/act-set-abandon.ts`). A store outage, and a unique index that does not stand (named in
 *   the failure), are retried.
 * - **The file report** ({@link filesReportOfSpace}) closes the body, still under the hold: a backup carries the database and not the bytes under
 *   `<DATA_ROOT>/files`, so the restored rows describe the backup's moment over the bytes of THIS one. Each space's files are read against its
 *   rows (`files/disk-against-rows.ts`, the classifier the pull shares) and the space's report says which no longer match, by class. It reports
 *   and repairs nothing - a tombstone written by a restore would delete a peer's copy - and it can never fail the restore: a check that throws or
 *   outlasts the file-system bound is `files: { checked: false, reasonCode, reason }` and the restore goes on, because a throw would make the runner drop and
 *   reload the space again.
 * - **The completion** is the runner's write: it removes the entry, forgets the RECEIVE marks the registration named (`forgetReceived`),
 *   marks the space done on the set with its index results, and - for the last one - ends the set, after which {@link onRestoreEnd} tells
 *   every cache the database was replaced, restarts the leaked-row scans and writes the outcome's audit row.
 *
 * ## Not restored, on purpose
 *
 * Only space collections and each space's own counter doc - and not the bytes under `<DATA_ROOT>/files`, which the file report above names
 * where they no longer match. The audit log records what happened, the restore included, and rolling it
 * back would erase that record; `space_activity`, the webhook subscriptions and queues and the other instance collections are this
 * instance's own running state.
 */
import { getDb, reportDatabaseReplaced } from './mongo.js';
import { backupIsWhole, backupLoader, backupRecords, BackupNotWhole, type BackupCollection } from './restore.js';
import { backupDirOf } from './backup-location.js';
import { parseSpaceCollection } from './space-collection.js';
import { isDuplicateKey } from './write-errors.js';
import { configuredSpaces } from '../spaces/space-lookup.js';
import { initSpace } from '../spaces/lifecycle.js';
import { assertUniqueIndexesStand } from '../spaces/space-indexes.js';
import { reconcileSpaceSearchIndexes } from '../spaces/search-index-presence.js';
import { restartLeakedRowScans } from '../files/leaked-rows-repair.js';
import {
  defineSpaceActBody, defineSpaceActSetHooks, registerSpaceActSet, runSpaceAct, instanceWideActStanding, spaceActSetOf, spaceActKnob,
  SpaceActInputFailure, type SpaceActBodyContext, type SpaceActBodyOutcome,
} from '../spaces/space-act-runner.js';
import type { SpaceActKind, SpaceActSet } from '../config/types.js';
import { seqFloor, bumpSeq } from '../util/seq.js';
import { logInternalAudit } from '../audit/audit.js';
import { RESTORE_ABANDONED_OPERATION, RESTORE_COMPLETED_OPERATION } from '../audit/act-set-operations.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { isTimeBoundEnded } from '../util/time-bound.js';
import { readDiskAgainstRows, FILE_MISMATCH_CLASSES, type FileMismatchClass } from '../files/disk-against-rows.js';

const KIND = 'restore' satisfies SpaceActKind;
const COUNTERS = 'ythril_counters';

// ── what a restore says about a space's files ───────────────────────────────────────────────────────────────────────

/** The most paths one class of one space names in the report. */
export const REPORT_PATHS_PER_CLASS = 10;
/**
 * The most paths the report of a whole restore names, over every space and class. The report is kept on the restore set in the config file
 * until the next restore, so it is bounded by this and not by the number of spaces: each space's share is this divided by the spaces of the
 * set, which is fixed before any space runs (a share taken from a running total would depend on which space ended first).
 */
export const REPORT_PATHS_PER_RESTORE = 200;
/** The longest one reported path is quoted (`peerText`): a name a peer chose is bounded and its escapes written out. */
const REPORT_PATH_MAX = 256;

/** One class of the files report: how many files, and at most a share of their paths. */
export interface FileClassReport { count: number; paths: string[] }

/**
 * Why a space's files were not checked: `timeout` (the file-system bound ended the check; `limitMs` is that bound) or `failed` (it could not
 * run; the cause is in the server log). A client words each code in its own language; `reason` is the same in English, for a reader of the raw
 * report, and names what to do.
 */
export const FILES_NOT_CHECKED_CODES = ['timeout', 'failed'] as const;
export type FilesNotCheckedCode = typeof FILES_NOT_CHECKED_CODES[number];

/** What a restored space reports of its files. */
export type RestoreFilesReport =
  | { checked: true; classes: Partial<Record<FileMismatchClass, FileClassReport>> }
  | { checked: false; reasonCode: FilesNotCheckedCode; limitMs?: number; reason: string };

/**
 * The per-class report of `classes` within `allowance` paths for the whole space: only the classes that have a file, each with its exact count
 * and an equal share of the allowance (at most {@link REPORT_PATHS_PER_CLASS}), every path quoted bounded. The allowance is shared by class so
 * one large class cannot leave the others naming nothing.
 */
export function filesReportOf(classes: Readonly<Record<FileMismatchClass, readonly string[]>>, allowance: number): RestoreFilesReport {
  const named = FILE_MISMATCH_CLASSES.filter(c => classes[c].length > 0);
  const share = named.length === 0 ? 0 : Math.max(0, Math.min(REPORT_PATHS_PER_CLASS, Math.floor(allowance / named.length)));
  return {
    checked: true,
    classes: Object.fromEntries(named.map(c => [c, {
      count: classes[c].length,
      paths: classes[c].slice(0, share).map(p => peerText(p, { max: REPORT_PATH_MAX })),
    } satisfies FileClassReport])),
  };
}

/** Says once per restore and space why that space's files were not checked: the cause belongs in the log, never in the report. */
const checkFailureSaid = warnOnce<string>({ max: 1_000 });

/**
 * The files report of one restored space, which can never throw: a failure of the check is `checked: false` with a reason of ours (no driver
 * text, which can carry a connection string), the cause said once through {@link checkFailureSaid}.
 */
async function filesReportOfSpace(ctx: SpaceActBodyContext, spaceId: string): Promise<RestoreFilesReport> {
  try {
    const spaces = Object.keys(spaceActSetOf(KIND)?.members ?? {}).length;
    const classes = await readDiskAgainstRows(spaceId, ctx.fileTree);
    const report = filesReportOf(classes, Math.floor(REPORT_PATHS_PER_RESTORE / Math.max(1, spaces)));
    await countFilesOutOfStep(classes);
    return report;
  } catch (err) {
    checkFailureSaid(`${ctx.entry.setId ?? ctx.entry.id}\0${spaceId}`,
      () => log.warn(`restore: the file check of space '${peerText(spaceId)}' failed: ${peerText(err)}`));
    const again = 'restoring the backup again repeats the check';
    if (isTimeBoundEnded(err)) {
      const ms = spaceActKnob('SPACE_ACT_FS_MS');
      return { checked: false, reasonCode: 'timeout', limitMs: ms, reason: `the check of the files took longer than ${ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`} `
        + `and was left unfinished, so the files of this space were not compared with its restored records; ${again}` };
    }
    return { checked: false, reasonCode: 'failed', reason: 'the check of the files could not run (the server log names the cause), so the files of this '
      + `space were not compared with its restored records; ${again}` };
  }
}

/** Count the files of each class (`ythril_restore_files_out_of_step_total`); the registry is loaded here, as the runner loads it, never at import. */
async function countFilesOutOfStep(classes: Readonly<Record<FileMismatchClass, readonly string[]>>): Promise<void> {
  const { restoreFilesOutOfStepTotal } = await import('../metrics/registry.js');
  for (const c of FILE_MISMATCH_CLASSES) if (classes[c].length > 0) restoreFilesOutOfStepTotal.labels({ class: c }).inc(classes[c].length);
}

/** The space a backup collection belongs to, or null for an instance collection. */
const spaceOfCollection = (name: string): string | null => parseSpaceCollection(name)?.spaceId ?? null;

// ── the door ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the door decided before registering anything. */
export type RestorePlan =
  | { ok: true; backupId: string; spaces: string[]; emptied: string[]; leftOut: string[] }
  /** The backup holds spaces this instance does not serve and the request did not leave them out. */
  | { ok: false; unserved: string[] };

/**
 * Plan a restore of backup `backupId` in `dir`: THROWS {@link BackupNotWhole} when the backup is not whole (nothing is registered), and
 * answers which spaces it restores, which it empties (served, not in the backup) and which it leaves out (in the backup, not served, and
 * named in `leaveOut`). A space the backup holds that this instance does not serve was renamed or deleted after the backup: restoring
 * "equal to the backup" cannot place its data, so it is refused unless the operator acknowledges that it is not restored.
 */
export async function planRestore(backupId: string, dir: string, leaveOut: readonly string[]): Promise<RestorePlan> {
  const manifest = await backupIsWhole(dir);
  const served = configuredSpaces().map(s => s.id);
  const inBackup = new Set(manifest.collections.map(c => spaceOfCollection(c.name)).filter((s): s is string => s !== null));
  const unserved = [...inBackup].filter(s => !served.includes(s)).sort();
  const notLeft = unserved.filter(s => !leaveOut.includes(s));
  if (notLeft.length > 0) return { ok: false, unserved: notLeft };
  return {
    ok: true, backupId, spaces: [...served],
    emptied: served.filter(s => !inBackup.has(s)).sort(),
    leftOut: unserved,
  };
}

/** The answer of a restore the door registered. */
export interface RestoreStarted { restoreId: string; backupId: string; spaces: string[]; emptied: string[]; leftOut: string[] }

/**
 * Register the planned restore as one act per served space and start them; null when an instance-wide act stands (asked again here, in
 * the same turn as the registration, because the plan awaited the backup check).
 */
export function startRestore(plan: Extract<RestorePlan, { ok: true }>): RestoreStarted | null {
  if (instanceWideActStanding() !== null) return null;
  const { set, entryIds } = registerSpaceActSet({
    kind: KIND, localIds: plan.spaces, backupId: plan.backupId, emptied: plan.emptied, leftOut: plan.leftOut,
  });
  for (const id of entryIds) void runSpaceAct(id, { via: 'door' });
  return { restoreId: set.id, backupId: plan.backupId, spaces: plan.spaces, emptied: plan.emptied, leftOut: plan.leftOut };
}


// ── the end ────────────────────────────────────────────────────────────────────────────────────────────────────
// (The report of a restore is the act-set report, `spaces/act-set-report.ts`, and its abandon the act-set abandon,
// `spaces/act-set-abandon.ts`; a migrate shares both.)

/**
 * When the set ends, once: every cache is told the database was replaced (`Q-95`), the leaked-row scan of every space starts again (the
 * rows now there were never read), and the outcome is one audit row naming the backup.
 */
function onRestoreEnd(set: Readonly<SpaceActSet>): void {
  reportDatabaseReplaced();
  restartLeakedRowScans(Object.keys(set.members));
  logInternalAudit({
    method: 'RESTORE', path: `internal:restore:${set.backupId ?? ''}:${set.id}`,
    operation: set.outcome === 'abandoned' ? RESTORE_ABANDONED_OPERATION : RESTORE_COMPLETED_OPERATION,
    startedAt: Date.parse(set.startedAt),
  });
  const left = Object.entries(set.members).filter(([, m]) => m.state === 'abandoned').map(([id]) => id);
  if (set.outcome === 'abandoned') {
    log.warn(`restore of backup '${peerText(set.backupId ?? '')}' abandoned; possibly half restored: ${left.map(s => `'${peerText(s)}'`).join(', ') || 'none'}`);
  } else {
    const out = filesOutOfStepOf(set);
    log.info(`restore of backup '${peerText(set.backupId ?? '')}' completed for ${Object.keys(set.members).length} space(s); files out of step with their records: ${out.total}`
      + (out.total > 0 ? ` (${FILE_MISMATCH_CLASSES.filter(c => out.byClass[c] > 0).map(c => `${c} ${out.byClass[c]}`).join(', ')})` : ''));
    if (out.notChecked.length > 0) {
      log.warn(`restore of backup '${peerText(set.backupId ?? '')}': files not checked for ${out.notChecked.length} space(s): ${out.notChecked.map(s => `'${peerText(s)}'`).join(', ')}; the report names the reason of each`);
    }
  }
}

/** What the members' file reports add up to: the files out of step by class and in all, and the spaces whose files were not checked. */
function filesOutOfStepOf(set: Readonly<SpaceActSet>): { total: number; byClass: Record<FileMismatchClass, number>; notChecked: string[] } {
  const byClass = Object.fromEntries(FILE_MISMATCH_CLASSES.map(c => [c, 0])) as Record<FileMismatchClass, number>;
  const notChecked: string[] = [];
  for (const [id, member] of Object.entries(set.members)) {
    const files = member.report?.['files'] as RestoreFilesReport | undefined;
    if (!files) continue;
    if (!files.checked) { notChecked.push(id); continue; }
    for (const c of FILE_MISMATCH_CLASSES) byClass[c] += files.classes[c]?.count ?? 0;
  }
  return { total: FILE_MISMATCH_CLASSES.reduce((n, c) => n + byClass[c], 0), byClass, notChecked };
}

// ── the body ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An input failure, in our words, from what the backup check or the load said. */
function inputFailure(err: unknown, collection?: string): SpaceActInputFailure | null {
  if (err instanceof BackupNotWhole) return new SpaceActInputFailure(err.message.endsWith('.') ? err.message : `${err.message}.`);
  if (isDuplicateKey(err)) {
    return new SpaceActInputFailure(`the backup holds records of collection '${collection ?? ''}' that one of its unique indexes refuses.`);
  }
  return null;
}

/** The counter the backup holds for `spaceId` (0 when none): one doc of `ythril_counters`, never the collection. */
async function backupCounterOf(dir: string, counters: BackupCollection | undefined, spaceId: string): Promise<number> {
  if (!counters) return 0;
  let found = 0;
  // One doc per space, so the file is small; its wholeness was checked with the space's own files.
  for await (const doc of backupRecords(dir, counters.name)) {
    if (doc['_id'] === spaceId && typeof doc['seq'] === 'number') found = Math.max(found, doc['seq']);
  }
  return found;
}

/**
 * Replace one space's data with the backup's. See the module header for the order; every store operation is bounded by the runner.
 */
async function restoreSpace(ctx: SpaceActBodyContext): Promise<SpaceActBodyOutcome> {
  const spaceId = ctx.entry.localId;
  const dir = ctx.entry.backupId ? backupDirOf(ctx.entry.backupId) : null;
  if (!dir) throw new SpaceActInputFailure(`backup '${ctx.entry.backupId ?? ''}' is no longer in the backups directory.`);
  const mine = (name: string): boolean => spaceOfCollection(name) === spaceId;

  // The backup again, for this space: it can have changed on disk since the door checked it. Nothing is dropped before this holds.
  let manifest;
  try { manifest = await backupIsWhole(dir, { only: n => mine(n) || n === COUNTERS }); }
  catch (err) { throw inputFailure(err) ?? err; }

  // The floor, after the drain: no write of this space is in flight now, so no seq above it can still be handed out.
  const floor = await seqFloor(spaceId);

  const db = getDb();
  const present = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(mine);
  const fromBackup = manifest.collections.filter(c => mine(c.name));
  for (const name of new Set([...present, ...fromBackup.map(c => c.name)])) await db.collection(name).drop();

  // Every collection of the space again, empty, with every index - the unique ones included, so the load below meets them.
  await initSpace(spaceId, { waitForVectorReady: false });

  const load = backupLoader();
  for (const c of fromBackup) {
    try { await load(db, dir, c); }
    catch (err) { throw inputFailure(err, c.name) ?? err; }
  }

  // The counter: at least the floor, the backup's own counter and every seq now stored.
  const counters = manifest.collections.find(c => c.name === COUNTERS);
  const target = Math.max(floor, await backupCounterOf(dir, counters, spaceId), await seqFloor(spaceId));
  await bumpSeq(spaceId, target);

  // Every declared unique index stands before the hold lifts (`Q-439`, `Q-445`): built on the empty collections above, asserted
  // here. One that does not is a plain error naming it - not an input failure: the act stays owed, the space held, and it is
  // tried again.
  await assertUniqueIndexesStand(spaceId);

  // The vector indexes of each collection that now holds a record (`Q-165`); a failure is reported, never a failed restore.
  let vectorIndexes: 'rebuilding' | 'failed';
  try {
    await reconcileSpaceSearchIndexes(spaceId, { waitForReady: false, force: true });
    vectorIndexes = 'rebuilding';
  } catch (err) {
    log.error(`restore: failed to rebuild vector indexes for space '${peerText(spaceId)}': ${peerText(err)}`);
    vectorIndexes = 'failed';
  }

  // The files against the restored rows: last, so nothing after it can fail the body (a retry drops and loads the space again).
  const files = await filesReportOfSpace(ctx, spaceId);
  // `edgeIndexes: { failed: [] }` says every declared unique index stood on the restored space: one that did not failed the act
  // above, so a completed restore never names one. Kept under its name for the callers that read it.
  return { report: { edgeIndexes: { failed: [] }, vectorIndexes, files } };
}

defineSpaceActBody(KIND, restoreSpace);
defineSpaceActSetHooks(KIND, { onSetEnd: onRestoreEnd });
