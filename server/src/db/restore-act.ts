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
 *   disk), the counter floor is taken after the drain, the space's collections are dropped and created again with every index (on empty
 *   collections, so the unique indexes refuse a duplicate the backup holds at the insert), the backup's records are loaded, the counter is
 *   written to at least the floor, and the vector indexes are reconciled. A broken backup or a duplicate is an INPUT failure: not retried,
 *   the space stays held until an operator abandons ({@link abandonRestore}). A store outage is retried.
 * - **The completion** is the runner's write: it removes the entry, forgets the RECEIVE marks the registration named (`forgetReceived`),
 *   marks the space done on the set with its index results, and - for the last one - ends the set, after which {@link onRestoreEnd} tells
 *   every cache the database was replaced, restarts the leaked-row scans and writes the outcome's audit row.
 *
 * ## Not restored, on purpose
 *
 * Only space collections and each space's own counter doc. The audit log records what happened, the restore included, and rolling it
 * back would erase that record; `space_activity`, the webhook subscriptions and queues and the other instance collections are this
 * instance's own running state.
 */
import { getDb, reportDatabaseReplaced } from './mongo.js';
import { backupIsWhole, backupLoader, backupRecords, BackupNotWhole, type BackupCollection } from './restore.js';
import { backupDirOf } from './backup-location.js';
import { parseSpaceCollection } from './space-collection.js';
import { isDuplicateKey } from './write-errors.js';
import { configuredSpaces } from '../spaces/space-lookup.js';
import { initSpace, ensureEdgeIdentityIndex } from '../spaces/lifecycle.js';
import { ensureEdgeGuardIndex } from '../spaces/edge-guard-index.js';
import { reconcileSpaceSearchIndexes } from '../spaces/search-index-presence.js';
import { restartLeakedRowScans } from '../files/leaked-rows-repair.js';
import {
  defineSpaceActBody, defineSpaceActSetHooks, registerSpaceActSet, runSpaceAct, abandonSpaceActSet, instanceWideActStanding,
  spaceActSetOf, entriesOfSet, SpaceActInputFailure, type SpaceActBodyContext, type SpaceActBodyOutcome,
} from '../spaces/space-act-runner.js';
import { SPACE_ACT_KINDS } from '../config/types-space-acts.js';
import type { SpaceActKind, SpaceActSet } from '../config/types.js';
import { seqFloor, bumpSeq } from '../util/seq.js';
import { logInternalAudit } from '../audit/audit.js';
import { RESTORE_ABANDONED_OPERATION, RESTORE_COMPLETED_OPERATION } from '../audit/restore-operations.js';
import { log, peerText } from '../util/log.js';

const KIND = 'restore' satisfies SpaceActKind;
const COUNTERS = 'ythril_counters';

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

/** The refusal of a restore while an act that stands on every space stands: the code its kind refuses writes with. */
export function restoreStandingRefusal(kind: SpaceActKind): { error: string; code: string } {
  return { error: `A restore cannot start: ${SPACE_ACT_KINDS[kind].writeRefusalWhy({})}.`, code: SPACE_ACT_KINDS[kind].writeRefusalCode };
}

// ── the report ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One space of the report: where its restore stands and what it reported. */
export interface RestoreSpaceReport {
  id: string;
  state: 'owed' | 'running' | 'done' | 'restore_abandoned';
  attempts: number;
  lastError?: string;
  retryAt?: string;
  needsAbandon?: true;
  completedAt?: string;
  edgeIndexes?: unknown;
  vectorIndexes?: unknown;
}

/** The restore standing, or the last one; `{ restore: null }` when none ever ran here. */
export interface RestoreReport {
  restoreId: string; backupId?: string; state: 'running' | 'completed' | 'abandoned';
  startedAt: string; endedAt?: string; done: number; total: number;
  spaces: RestoreSpaceReport[]; emptied: string[]; leftOut: string[];
}

/** The report of the restore standing or the last one: per space its state, attempts, our sentence for its last failure, its index results. */
export function restoreReport(): RestoreReport | null {
  const set = spaceActSetOf(KIND);
  if (!set) return null;
  const entries = new Map(entriesOfSet(set.id).map(e => [e.localId, e]));
  const spaces = Object.entries(set.members).map(([id, m]): RestoreSpaceReport => {
    if (m.state === 'done') return { id, state: 'done', attempts: 0, ...(m.completedAt ? { completedAt: m.completedAt } : {}), ...(m.report ?? {}) };
    const e = entries.get(id);
    if (m.state === 'abandoned') return { id, state: 'restore_abandoned', attempts: e?.attempts ?? 0 };
    return {
      id, state: e?.state === 'running' ? 'running' : 'owed', attempts: e?.attempts ?? 0,
      ...(e?.lastError ? { lastError: e.lastError } : {}),
      ...(e?.retryAt ? { retryAt: e.retryAt } : {}),
      ...(e?.needsAbandon ? { needsAbandon: true as const } : {}),
    };
  });
  return {
    restoreId: set.id, ...(set.backupId ? { backupId: set.backupId } : {}),
    state: set.endedAt ? (set.outcome ?? 'completed') : 'running',
    startedAt: set.startedAt, ...(set.endedAt ? { endedAt: set.endedAt } : {}),
    done: spaces.filter(s => s.state === 'done').length, total: spaces.length,
    spaces, emptied: set.emptied ?? [], leftOut: set.leftOut ?? [],
  };
}

/** What an abandon answered. */
export type RestoreAbandon =
  | { abandoned: true; restoreId: string; backupId?: string; halfRestored: string[]; completed: string[] }
  | { abandoned: false; reason: 'none_standing' | 'running'; running?: string[] };

/**
 * Abandon the standing restore: every space whose act has not completed is released in one write and keeps whatever its act reached - a
 * space may be half restored, and the answer names those spaces in those words. Refused while a space's body runs.
 */
export async function abandonRestore(): Promise<RestoreAbandon> {
  const r = await abandonSpaceActSet(KIND);
  if (!r.abandoned) return r;
  const completed = Object.entries(r.set.members).filter(([, m]) => m.state === 'done').map(([id]) => id).sort();
  return { abandoned: true, restoreId: r.set.id, ...(r.set.backupId ? { backupId: r.set.backupId } : {}), halfRestored: r.left, completed };
}

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
    log.info(`restore of backup '${peerText(set.backupId ?? '')}' completed for ${Object.keys(set.members).length} space(s)`);
  }
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

  // The edges' unique indexes stand before the hold lifts (`Q-439`, `Q-445`): built on the empty collection above, asserted here.
  try {
    await ensureEdgeIdentityIndex(spaceId);
    await ensureEdgeGuardIndex(spaceId);
  } catch (err) {
    throw inputFailure(err, `${spaceId}_edges`) ?? err;
  }

  // The vector indexes of each collection that now holds a record (`Q-165`); a failure is reported, never a failed restore.
  let vectorIndexes: 'rebuilding' | 'failed';
  try {
    await reconcileSpaceSearchIndexes(spaceId, { waitForReady: false, force: true });
    vectorIndexes = 'rebuilding';
  } catch (err) {
    log.error(`restore: failed to rebuild vector indexes for space '${peerText(spaceId)}': ${peerText(err)}`);
    vectorIndexes = 'failed';
  }
  return { report: { edgeIndexes: { failed: [] }, vectorIndexes } };
}

defineSpaceActBody(KIND, restoreSpace);
defineSpaceActSetHooks(KIND, { onSetEnd: onRestoreEnd });
