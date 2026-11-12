/**
 * The record of a file whose bytes this instance lost — removed here, with no tombstone, once the due rule holds (bundle-70, Q-337; owner,
 * 2026-11-11: "remove meta with the file").
 *
 * ## The question it answers
 *
 * *"Which live file records of this space have no bytes on this disk, and which of them may go now?"* A record whose bytes are gone is counted
 * and cannot be listed, so a person cannot delete it. It goes with its bytes, on THIS instance only: {@link removeFileHere} retires the row
 * (a feed marker, or the soft flag) and writes no tombstone, and because file sync fetches any file this side lacks
 * (`sync/file-conflict.ts`, `decideFilePull`), a peer that still holds the bytes delivers them back as an ordinary arrival. The removal decides
 * nothing for any other instance.
 *
 * ## What it must never remove
 *
 * A record that only LOOKS like an orphan: bytes still arriving (a metadata-first row, with no sha256), a record a restore or an import brought
 * back, a re-upload or a same-hash arrival landing now, a record a move still carries, a delete in flight (a pending or published tombstone),
 * an open chunked upload, a space that is not taking writes, and every file of a space (or of one top-level directory) whose volume is not
 * mounted. Whether a stamped record may go is ONE pure question, {@link absentRowIsDue}, and its whole truth table is
 * `an-absent-bytes-row-is-due-by-one-predicate`.
 *
 * ## How a pass runs
 *
 * A step of the TTL sweep (`brain/ttl-sweep.ts`), with its own pages per tick, its own deadline and at most {@link ABSENT_BYTES_REMOVALS_PER_TICK}
 * removals per tick across the spaces, whose order rotates each tick so one large space cannot starve the rest. A pass under way resumes from its
 * cursor every tick; a pass that completed is not started again within {@link ABSENT_BYTES_RESCAN_AFTER_MS} (a day: the walk lists every
 * directory of the space, so it is not repeated every tick). Per space and tick of a pass:
 *
 * 1. **The walk**: the read-only manifest walk (`buildFileManifest(..., { listOnly: true })`: one listing per directory, nothing hashed, and the
 *    paths it could not look at named in `unreadable`), under {@link withinFsBound}: a walk the bound ends counts the space's pass as incomplete.
 * 2. **The rows**, a page at a time by `_id` (live top-level rows, not instance-local files): a row the walk found is present; one under an
 *    unreadable path is UNLOOKED; any other is confirmed by `bytesHeldAt` (every spelling the disk may keep), bounded the same way: present,
 *    absent, or unlooked when the look fails or hits its bound. An unlooked row is never stamped and never removed.
 * 3. **The stamp**: an absent row gets `bytesAbsentSince` (the pass's `now`, local: no seq, no updatedAt, never on the wire), a present row loses
 *    a stale one; both in one bulk write per page.
 * 4. **The removal**, for a row stamped by an EARLIER pass: the facts are gathered by code (holds, legs, the last complete pass's counts, the
 *    directory) and {@link absentRowIsDue} asked. A due row is re-checked under its path lock (bytes still absent, row still the one decided on),
 *    the lock released, and retired by `removeFileHere(..., { retireOnlyIf })`, whose filter carries the stamp, hash and update time: a row
 *    rewritten meanwhile is not taken, and only rows really taken are counted, audited and metered. A row the filter refused, still stamped, is
 *    stamped again at `now`.
 *
 * The mass-loss hold is judged on the LAST COMPLETE pass: a pass stamps and counts; removals happen in a later one.
 *
 * ## Where it keeps its state
 *
 * On the space's config entry (`absentBytesScan`, `filesRestoredAt`: local bookkeeping, never answered, synced or exported,
 * `spaces/space-for-wire.ts`), as the leaked-rows repair keeps its cursor. A restore and an import clear every stamp they bring back, start the
 * pass over and set `filesRestoredAt` ({@link restartAbsentBytesSweeps}), so every row of the space waits {@link WAIT_DAYS_FOR_BYTES} days.
 * The evidence of peers' legs is in memory (`sync/file-legs.ts`).
 *
 * ## What it says
 *
 * One audit entry per space per pass that retired anything ({@link FILES_ABSENT_BYTES_SWEEP_OPERATION}, no token, the paths capped at
 * {@link ABSENT_BYTES_AUDIT_PATHS}); `ythril_files_absent_bytes_removed_total`, `ythril_files_awaiting_bytes{space}` and
 * `ythril_files_absent_bytes_held{reason}`; one log line per space per pass that stamped or removed anything. It fires no webhook and no live
 * event: the change feed says `{ deleted: true, reason: 'bytes_lost' }`. An explicit delete of such a record (REST, MCP `delete_file`) is the
 * person's own act and keeps its tombstone.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { idKeysetPage } from '../db/id-keyset-page.js';
import { getConfig } from '../config/loader.js';
import { changeSpaceEntries } from '../config/change-space-entries.js';
import { logInternalAudit } from '../audit/audit.js';
import { FILES_ABSENT_BYTES_SWEEP_OPERATION } from '../audit/middleware.js';
import { admitSpaceWrite, isSpaceNotWritable, spaceWriteRefusal } from '../spaces/space-write-gate.js';
import { networksHolding } from '../spaces/wipe-vote.js';
import { exchangeDirections } from '../sync/space-exchange.js';
import { lastCompleteFileLeg, type FileLegEvidence } from '../sync/file-legs.js';
import { isInstanceLocalFile } from '../sync/file-conflict.js';
import { BYTES_ABSENT_SINCE } from '../sync/local-only-fields.js';
import { filesAbsentBytesHeldGauge, filesAbsentBytesRemovedTotal, filesAwaitingBytesGauge } from '../metrics/registry.js';
import { inChunks } from '../util/chunks.js';
import { log, peerText } from '../util/log.js';
import { withinFsBound } from '../util/time-bound.js';
import type { FileMetaDoc } from '../config/types.js';
import { LIVE_FILE_ROW, AWAITING_BYTES_ROW } from './live-file-row.js';
import { buildFileManifest } from './manifest.js';
import { UnreadablePaths } from './unreadable-paths.js';
import { bytesHeldAt, heldEntryOf, storedAbsOf } from './held-spelling.js';
import { withPathLock } from './stored-bytes.js';
import { pathsCarriedByOwedMoves } from './move-markers.js';
import { pathsWithAnyFileTombstone } from './tombstones.js';
import { underPrefix } from '../util/under-prefix.js';
import { chunkSessionOpenAt } from './chunks.js';
import { removeFileHere } from './remove-file-here.js';
import { WAIT_DAYS_FOR_BYTES, WAIT_FOR_BYTES_MS } from './bytes-wait.js';

declare module '../config/types.js' {
  interface SpaceConfig {
    /**
     * Where the absent-bytes sweep is in this space (`files/absent-bytes-sweep.ts`, Q-337): the running pass (its start, cursor and counts) and
     * the counts of the last complete one, which the mass-loss hold is judged on. Local bookkeeping about THIS disk, like `leakedRowScan`.
     * Declared here, beside its only reader, rather than in the frozen `types.ts`.
     */
    absentBytesScan?: AbsentBytesScan;
    /** When a restore or an import last brought this space's records back (ISO): every record then waits WAIT_DAYS_FOR_BYTES for its bytes. */
    filesRestoredAt?: string;
  }
}

/** How long a record that recorded bytes (a sha256) waits after its stamp, ms: a day of peers' cycles to deliver them back. */
export const ABSENT_BYTES_WINDOW_MS = 86_400_000;
/** Rows one page reads. */
export const ABSENT_BYTES_PAGE_SIZE = 500;
/** Pages one space reads in one tick; the cursor carries the rest to the next. */
export const ABSENT_BYTES_PAGES_PER_TICK = 20;
/** The most records the sweep removes in one tick, across every space; the rest wait for the next tick. */
export const ABSENT_BYTES_REMOVALS_PER_TICK = 200;
/** The most paths one audit entry names; past it the entry says how many it left out. */
export const ABSENT_BYTES_AUDIT_PATHS = 50;
/** How long the step may go on STARTING pages, ms. */
const STEP_BUDGET_MS = 30_000;
/** A pass that completed is not started again before this much time has passed, ms: the walk lists every directory of the space. */
export const ABSENT_BYTES_RESCAN_AFTER_MS = 24 * 3_600_000;
/** The bound on the walk of one space, ms. */
const WALK_BOUND_MS = 120_000;
/** The bound on one look at one path, ms. */
const LOOK_BOUND_MS = 10_000;

/** The counts of one pass of one space: rows read, and how many of them were present, absent and could not be looked at. */
export interface PassCounts { recorded: number; present: number; absent: number; unlooked: number }
/** The sweep's state on a space's config entry. */
export interface AbsentBytesScan {
  running?: { startedAt: string; after?: string; counts: PassCounts };
  last?: { completedAt: string; counts: PassCounts };
}

/** Why a stamped row is kept: the due rule's whole vocabulary. */
export const HOLD_REASONS = [
  'unstamped', 'no_complete_pass', 'mass_loss', 'mass_loss_directory', 'owed_move', 'tombstone', 'not_writable', 'chunk_session', 'window', 'legs',
] as const;
export type HoldReason = typeof HOLD_REASONS[number];

/** A member's leg as the due rule reads it ({@link absentRowIsDue}). */
export interface LegFact { manifestReadAt: number; complete: boolean; carriesUnreadable: boolean; namesPath: boolean; truncated: boolean }
/** What the sweep gathers by code for one stamped row. */
export interface DueFacts {
  now: number;
  spaceRestoredAt: number | null;
  members: ReadonlyArray<{ id: string; leg: LegFact | null }>;
  holds: Readonly<Partial<Record<'owedMove' | 'tombstone' | 'spaceNotWritable' | 'chunkSession', boolean>>>;
  lastPass: PassCounts | null;
  directory: { recorded: number; absent: number; gone: boolean } | null;
}

const held = (reason: HoldReason): { due: false; reason: HoldReason } => ({ due: false, reason });

/**
 * May this stamped row be removed NOW — the one pure question (the contract and the table: `an-absent-bytes-row-is-due-by-one-predicate`).
 * It reads no clock (`facts.now`) and changes nothing.
 *
 *  - Holds, each alone and at the ceiling too: an owed move, a tombstone, a space not taking writes, an open chunk session.
 *  - Mass loss from the last complete pass (none yet holds): nothing present with a row recorded, or (absent + unlooked) * 2 > recorded;
 *    exactly half is not held. Per top-level directory: every recorded row under it absent and the directory gone from disk.
 *  - The window from the stamp: {@link ABSENT_BYTES_WINDOW_MS} for a row with a sha256, {@link WAIT_DAYS_FOR_BYTES} days for one without, and for
 *    every row of a space restored or imported within the last WAIT_DAYS_FOR_BYTES days.
 *  - Evidence: every member we pull the space from has a complete leg whose manifest was read after the stamp, carries `unreadable`, does not
 *    name the path and was not cut. The ceiling (WAIT_DAYS_FOR_BYTES days after the stamp) releases this requirement and nothing else.
 */
export function absentRowIsDue(
  row: { path: string; sha256?: string; bytesAbsentSince?: string },
  facts: DueFacts,
): { due: boolean; reason: HoldReason | null } {
  const stamp = typeof row.bytesAbsentSince === 'string' ? Date.parse(row.bytesAbsentSince) : Number.NaN;
  if (!Number.isFinite(stamp)) return held('unstamped');
  const holds = facts.holds ?? {};
  if (holds.owedMove === true) return held('owed_move');
  if (holds.tombstone === true) return held('tombstone');
  if (holds.spaceNotWritable === true) return held('not_writable');
  if (holds.chunkSession === true) return held('chunk_session');
  const pass = facts.lastPass;
  if (pass === null || pass === undefined) return held('no_complete_pass');
  if ((pass.present === 0 && pass.recorded >= 1) || (pass.absent + pass.unlooked) * 2 > pass.recorded) return held('mass_loss');
  const dir = facts.directory;
  if (dir !== null && dir !== undefined && dir.gone && dir.recorded > 0 && dir.absent >= dir.recorded) return held('mass_loss_directory');
  const age = facts.now - stamp;
  const restoredLately = facts.spaceRestoredAt !== null && facts.spaceRestoredAt !== undefined && facts.now - facts.spaceRestoredAt < WAIT_FOR_BYTES_MS;
  const window = typeof row.sha256 === 'string' && row.sha256 !== '' && !restoredLately ? ABSENT_BYTES_WINDOW_MS : WAIT_FOR_BYTES_MS;
  if (!(age > window)) return held('window');
  if (age > WAIT_FOR_BYTES_MS) return { due: true, reason: null };
  for (const { leg } of facts.members) {
    if (leg === null || !leg.complete || !leg.carriesUnreadable || leg.namesPath || leg.truncated || !(leg.manifestReadAt > stamp)) return held('legs');
  }
  return { due: true, reason: null };
}

/** The seams a test narrows. Production passes none. */
interface SweepSteps {
  /** Runs after a batch was decided due and re-checked, before the retire is issued: the interval a re-upload can land in. */
  beforeRemove: (batch: { spaceId: string; paths: readonly string[] }) => void | Promise<void>;
  pageSize: number;
  pagesPerTick: number;
  /** Replaces the confirming look (a test's failing or hanging disk). */
  look: (spaceId: string, key: string) => Promise<boolean>;
  /** The bound on one look, ms. */
  lookBoundMs: number;
  /** How long a finished pass waits before the next starts, ms. */
  rescanAfterMs: number;
}
let steps: Partial<SweepSteps> | null = null;
/** A test seam only: `null` puts the real behaviour back. */
export function setAbsentBytesSweepStepsForTest(next: Partial<SweepSteps> | null): void { steps = next; }

/** What one tick of the step shares across its spaces: when it stops starting pages, how many removals are left, where it got to. */
export interface AbsentBytesTick { deadlineAt: number; removalsLeft: number; reached?: string }
/** Where the last tick got to: the next starts after it. */
let lastReached: string | undefined;

/** Whether a pass of a space is owed at `now`: one under way, none completed yet, or the last completed a day ago or more. */
function passIsOwed(state: AbsentBytesScan | undefined, now: Date): boolean {
  if (state?.running !== undefined || state?.last === undefined) return true;
  return now.getTime() - Date.parse(state.last.completedAt) >= (steps?.rescanAfterMs ?? ABSENT_BYTES_RESCAN_AFTER_MS);
}

/** A new tick's budget. */
export function absentBytesTick(from: number = Date.now()): AbsentBytesTick {
  return { deadlineAt: from + STEP_BUDGET_MS, removalsLeft: ABSENT_BYTES_REMOVALS_PER_TICK };
}

/** `spaces` rotated to start after the space the last tick reached, so one large space cannot starve the rest. */
export function absentBytesSpaceOrder<T extends { id: string }>(spaces: readonly T[]): T[] {
  const at = lastReached === undefined ? -1 : spaces.findIndex(s => s.id === lastReached);
  return [...spaces.slice(at + 1), ...spaces.slice(0, at + 1)];
}
/** Remember where a tick got to. */
export function endAbsentBytesTick(tick: AbsentBytesTick): void { if (tick.reached !== undefined) lastReached = tick.reached; }

/** Bumped by a restart, so a page already running does not write state over the one a restore or an import cleared. */
const generations = new Map<string, number>();
const generationOf = (spaceId: string): number => generations.get(spaceId) ?? 0;

/** Held rows by reason, per space, as of each space's last decision: the gauge is their sum. */
const heldBySpace = new Map<string, Map<HoldReason, number>>();
function publishHeld(): void {
  for (const reason of HOLD_REASONS) {
    let n = 0;
    for (const counts of heldBySpace.values()) n += counts.get(reason) ?? 0;
    filesAbsentBytesHeldGauge.labels({ reason }).set(n);
  }
}

function remember(spaceId: string, state: AbsentBytesScan): void {
  changeSpaceEntries([spaceId], entry => { entry.absentBytesScan = state; return true; }, { save: 'soon' });
}

/**
 * Start the sweep of these spaces over and put every record they hold back on the longest wait, before the caller answers: what a restore and
 * an import do. Every stamp is cleared (what was stamped before says nothing of the rows now there), `filesRestoredAt` is set, and the next
 * tick's pass looks again. A space whose stamps cannot be cleared is said and still restarted: its stamps keep their age, and `filesRestoredAt`
 * still holds every row of it to the longest window.
 */
export async function restartAbsentBytesSweeps(spaceIds: readonly string[], at: Date = new Date()): Promise<void> {
  for (const id of spaceIds) generations.set(id, generationOf(id) + 1);
  changeSpaceEntries(spaceIds, entry => {
    delete entry.absentBytesScan;
    entry.filesRestoredAt = at.toISOString();
    return true;
  });
  for (const id of spaceIds) {
    heldBySpace.delete(id);
    // A write to the space's files collection: it asks the write gate and is counted like every other (`admitSpaceWrite`). A space an act still
    // holds refuses it; its stamps keep their age, and `filesRestoredAt` still holds every row to the longest window.
    await admitSpaceWrite(id, 'files', async () => {
      await col<FileMetaDoc>(spaceCollection(id, 'files')).updateMany(asFilter<FileMetaDoc>({ [BYTES_ABSENT_SINCE]: { $exists: true } }), { $unset: { [BYTES_ABSENT_SINCE]: '' } } as never);
    })
      .catch(err => log.warn(`Absent-bytes sweep: the stamps of space '${peerText(id)}' could not be cleared after its records were brought back: ${peerText(err)}`));
  }
  publishHeld();
}

/** How many live file records of `spaceId` are waiting for their bytes (stamped): what `filesAwaitingBytes` answers. */
export async function filesAwaitingBytes(spaceId: string): Promise<number> {
  return col(spaceCollection(spaceId, 'files')).countDocuments({ ...AWAITING_BYTES_ROW });
}

type SweptRow = { _id: string; sha256?: string; updatedAt?: string; [BYTES_ABSENT_SINCE]?: string };

/** What one tick of one space did. */
export interface AbsentBytesOutcome { stamped: number; cleared: number; removed: string[]; unlooked: number; held: number; completed: boolean }

/** Whether the confirming look found the bytes, bounded: a look that fails or hits its bound throws (the row is unlooked). */
async function look(spaceId: string, key: string): Promise<boolean> {
  const ask = steps?.look ?? bytesHeldAt;
  return withinFsBound(() => ask(spaceId, key), steps?.lookBoundMs ?? LOOK_BOUND_MS, `the absent-bytes look at a file of ${spaceId}`);
}

/** The filter a retire is narrowed by: the row exactly as the sweep decided on it. */
const asDecided = (row: SweptRow): Record<string, unknown> => ({
  [BYTES_ABSENT_SINCE]: row[BYTES_ABSENT_SINCE],
  sha256: row.sha256 ?? { $exists: false },
  updatedAt: row.updatedAt ?? { $exists: false },
});

/** The members this instance pulls `spaceId` from, each with the evidence of its last complete leg. */
function pullingMembers(spaceId: string): Array<{ id: string; evidence: FileLegEvidence | undefined }> {
  const out = new Map<string, FileLegEvidence | undefined>();
  for (const net of networksHolding(spaceId)) {
    for (const member of net.members ?? []) {
      if (out.has(member.instanceId) || !exchangeDirections(net, member).shouldPull) continue;
      out.set(member.instanceId, lastCompleteFileLeg(spaceId, member.instanceId));
    }
  }
  return [...out].map(([id, evidence]) => ({ id, evidence }));
}

/** The top-level directory of a key, or null for a file at the root. */
const topOf = (key: string): string | null => (key.includes('/') ? key.slice(0, key.indexOf('/')) : null);

/** Decide the stamped rows of a page and remove those due. */
async function removeDue(spaceId: string, stamped: readonly SweptRow[], now: Date, last: PassCounts | null, tick: AbsentBytesTick, outcome: AbsentBytesOutcome): Promise<void> {
  if (stamped.length === 0) return;
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const keys = stamped.map(r => r._id);
  const owed = await pathsCarriedByOwedMoves(spaceId, keys);
  // Pending and published alike: a delete in flight owns the path, whether or not its act has happened.
  const tombstoned = await pathsWithAnyFileTombstone(spaceId, keys);
  // A fact for the due rule, read without asking for a write unit (the writes below each admit their own).
  const notWritable = spaceWriteRefusal(spaceId, 'files') !== null;
  const entry = getConfig().spaces.find(s => s.id === spaceId);
  const restoredAt = entry?.filesRestoredAt !== undefined ? Date.parse(entry.filesRestoredAt) : Number.NaN;
  const members = pullingMembers(spaceId);
  const dirs = new Map<string, { recorded: number; absent: number; gone: boolean }>();
  const directoryOf = async (top: string): Promise<{ recorded: number; absent: number; gone: boolean }> => {
    const known = dirs.get(top);
    if (known) return known;
    const under = { _id: underPrefix(`${top}/`) };   // every key under the directory, by the shared anchored prefix
    const recorded = await files.countDocuments(asFilter<FileMetaDoc>({ ...LIVE_FILE_ROW, ...under }));
    const absent = await files.countDocuments(asFilter<FileMetaDoc>({ ...AWAITING_BYTES_ROW, ...under }));
    // A directory that cannot be looked at is read as gone: the hold counts against removal, never for it.
    const gone = await withinFsBound(() => heldEntryOf(spaceId, top), LOOK_BOUND_MS, `the absent-bytes look at a directory of ${spaceId}`)
      .then(e => e === null, () => true);
    const facts = { recorded, absent, gone };
    dirs.set(top, facts);
    return facts;
  };

  const heldHere = heldBySpace.get(spaceId) ?? new Map<HoldReason, number>();
  heldBySpace.set(spaceId, heldHere);
  const due: SweptRow[] = [];
  for (const row of stamped) {
    const top = topOf(row._id);
    const verdict = absentRowIsDue({ path: row._id, ...(row.sha256 !== undefined ? { sha256: row.sha256 } : {}), ...(row[BYTES_ABSENT_SINCE] !== undefined ? { bytesAbsentSince: row[BYTES_ABSENT_SINCE] } : {}) }, {
      now: now.getTime(),
      spaceRestoredAt: Number.isFinite(restoredAt) ? restoredAt : null,
      members: members.map(m => ({
        id: m.id,
        leg: m.evidence === undefined ? null : {
          manifestReadAt: m.evidence.manifestReadAt, complete: true, carriesUnreadable: m.evidence.carriesUnreadable,
          namesPath: m.evidence.unreadable.paths.covers(row._id), truncated: m.evidence.unreadable.truncated,
        },
      })),
      holds: { owedMove: owed.has(row._id), tombstone: tombstoned.has(row._id), spaceNotWritable: notWritable, chunkSession: chunkSessionOpenAt(spaceId, row._id) },
      lastPass: last,
      directory: top === null ? null : await directoryOf(top),
    });
    if (verdict.due) due.push(row);
    else { outcome.held++; heldHere.set(verdict.reason!, (heldHere.get(verdict.reason!) ?? 0) + 1); }
  }

  // Re-checked under the path lock: the bytes still absent, the row still the one decided on. The lock is released before the retire
  // (`removeFileHere` takes none, and the lock is not re-entrant); the retire's own filter closes the interval after it.
  const confirmed: SweptRow[] = [];
  for (const row of due) {
    if (confirmed.length >= tick.removalsLeft) break;
    const still = await storedAbsOf(spaceId, row._id).then(abs => withPathLock(abs, async () => {
      if (await look(spaceId, row._id)) return false;
      return (await files.countDocuments(asFilter<FileMetaDoc>({ _id: row._id, ...LIVE_FILE_ROW, ...asDecided(row) }))) === 1;
    })).catch(() => false);
    if (still) confirmed.push(row);
  }
  if (confirmed.length === 0) return;
  await steps?.beforeRemove?.({ spaceId, paths: confirmed.map(r => r._id) });
  for (const row of confirmed) {
    if (tick.removalsLeft <= 0) break;
    const taken = await removeFileHere(spaceId, row._id, { failure: 'throw', retireOnlyIf: asDecided(row), retiredBy: 'bytes-lost' });
    if (taken) { outcome.removed.push(row._id); tick.removalsLeft--; continue; }
    // Rewritten since it was decided on: still stamped (its bytes still absent), its window starts again; cleared (bytes back), it is left alone.
    await admitSpaceWrite(spaceId, 'files', () => files.updateOne(asFilter<FileMetaDoc>({ _id: row._id, ...LIVE_FILE_ROW, [BYTES_ABSENT_SINCE]: { $exists: true } }), { $set: { [BYTES_ABSENT_SINCE]: now.toISOString() } } as never))
      .catch(err => log.warn(`Absent-bytes sweep: '${peerText(row._id)}' of space '${peerText(spaceId)}' could not be stamped again: ${peerText(err)}`));
  }
}

/**
 * One tick of the sweep for one space: walk, read pages from the cursor until the tick's budget is spent or the pass reaches its end, stamp,
 * clear and remove, and remember where it is after EACH page. Must run inside a walk of the spaces (`eachSpace`).
 */
export async function sweepAbsentBytes(spaceId: string, now: Date, tick: AbsentBytesTick): Promise<AbsentBytesOutcome> {
  const outcome: AbsentBytesOutcome = { stamped: 0, cleared: 0, removed: [], unlooked: 0, held: 0, completed: false };
  const entry = getConfig().spaces.find(s => s.id === spaceId);
  if (entry === undefined || Date.now() >= tick.deadlineAt) return outcome;
  // A complete pass per space at most once a day (the leaked-rows repair's cadence): a pass under way resumes every tick; a finished one waits.
  if (!passIsOwed(entry.absentBytesScan, now)) return outcome;
  tick.reached = spaceId;
  heldBySpace.set(spaceId, new Map());   // the held gauge says this space's latest decisions, never a sum over ticks
  const generation = generationOf(spaceId);
  const state: AbsentBytesScan = { ...(entry.absentBytesScan ?? {}) };
  const running = state.running ?? { startedAt: now.toISOString(), counts: { recorded: 0, present: 0, absent: 0, unlooked: 0 } };
  const last = state.last?.counts ?? null;
  const startedAt = Date.now();
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const stampNow = now.toISOString();
  try {
    const walk = await withinFsBound(() => buildFileManifest(spaceId, undefined, { listOnly: true }), WALK_BOUND_MS, `the absent-bytes walk of ${spaceId}`);
    const here = new Set(walk.entries.map(e => e.path));
    const unreadable = new UnreadablePaths(walk.unreadable);
    const lookedAway = (key: string): boolean => unreadable.covers(key) || (walk.unreadableTruncated && !here.has(key));

    for (let pages = 0; pages < (steps?.pagesPerTick ?? ABSENT_BYTES_PAGES_PER_TICK) && Date.now() < tick.deadlineAt; pages++) {
      const page = await idKeysetPage<SweptRow>({
        collection: spaceCollection(spaceId, 'files'),
        filter: { ...LIVE_FILE_ROW },
        projection: { _id: 1, sha256: 1, updatedAt: 1, [BYTES_ABSENT_SINCE]: 1 },
        size: steps?.pageSize ?? ABSENT_BYTES_PAGE_SIZE,
        hint: { _id: 1 },
      }, running.after);
      const toStamp: string[] = [];
      const toClear: string[] = [];
      const stampedBefore: SweptRow[] = [];
      for (const row of page.rows) {
        if (isInstanceLocalFile(row._id)) continue;
        running.counts.recorded++;
        let present: boolean | null;
        if (here.has(row._id)) present = true;
        else if (lookedAway(row._id)) present = null;
        else present = await look(spaceId, row._id).catch(() => null);
        if (present === null) { running.counts.unlooked++; outcome.unlooked++; continue; }
        if (present) {
          running.counts.present++;
          if (row[BYTES_ABSENT_SINCE] !== undefined) toClear.push(row._id);
          continue;
        }
        running.counts.absent++;
        if (row[BYTES_ABSENT_SINCE] === undefined) toStamp.push(row._id);
        else stampedBefore.push(row);
      }
      // One counted write unit per page (`admitSpaceWrite`: an act registering on the space drains it, and a space not taking writes refuses it,
      // which stamps and clears nothing this tick). One write per chunk each way, and nothing else on the row: the stamp is local bookkeeping.
      await admitSpaceWrite(spaceId, 'files', async () => {
        for (const part of inChunks(toStamp, 500)) {
          outcome.stamped += (await files.updateMany(asFilter<FileMetaDoc>({ _id: { $in: part }, ...LIVE_FILE_ROW, [BYTES_ABSENT_SINCE]: { $exists: false } }), { $set: { [BYTES_ABSENT_SINCE]: stampNow } } as never)).modifiedCount;
        }
        for (const part of inChunks(toClear, 500)) {
          outcome.cleared += (await files.updateMany(asFilter<FileMetaDoc>({ _id: { $in: part }, [BYTES_ABSENT_SINCE]: { $exists: true } }), { $unset: { [BYTES_ABSENT_SINCE]: '' } } as never)).modifiedCount;
        }
      }).catch((err: unknown) => { if (!isSpaceNotWritable(err)) throw err; });
      await removeDue(spaceId, stampedBefore, now, last, tick, outcome);
      if (generationOf(spaceId) !== generation) return outcome;
      if (page.end) {
        state.last = { completedAt: stampNow, counts: running.counts };
        delete state.running;
        outcome.completed = true;
        filesAwaitingBytesGauge.labels({ space: spaceId }).set(running.counts.absent);
      } else {
        running.after = page.last;
        state.running = running;
      }
      remember(spaceId, state);
      if (outcome.completed) break;
    }
  } finally {
    publishHeld();
    filesAbsentBytesRemovedTotal.inc(outcome.removed.length);
    // One entry per space per pass that retired anything, naming only the rows the retire really took.
    if (outcome.removed.length > 0) {
      const listed = outcome.removed.slice(0, ABSENT_BYTES_AUDIT_PATHS);
      logInternalAudit({
        method: 'SWEEP', path: 'internal:absent-bytes-sweep', spaceId, operation: FILES_ABSENT_BYTES_SWEEP_OPERATION, startedAt,
        changes: [
          { field: 'retiredPaths', added: listed },
          { field: 'removed', to: outcome.removed.length },
          ...(outcome.removed.length > listed.length ? [{ field: 'pathsNotListed', to: outcome.removed.length - listed.length }] : []),
        ],
      });
    }
  }
  const said = `Absent-bytes sweep of space '${peerText(spaceId)}': stamped ${outcome.stamped} record(s) whose bytes are gone, cleared ${outcome.cleared} whose bytes are back, `
    + `removed ${outcome.removed.length}, kept ${outcome.held} still waiting, ${outcome.unlooked} could not be looked at; ${outcome.completed ? 'the pass is complete' : 'the pass goes on next cycle'}`;
  if (outcome.stamped + outcome.removed.length > 0) log.info(said); else log.debug(said);
  return outcome;
}
