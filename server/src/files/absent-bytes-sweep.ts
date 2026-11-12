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
 * cursor every tick; a pass that completed is not started again within `SWEEP_RESCAN_AFTER_MS` (`files/sweep-pass.ts`; a day: the walk lists every
 * directory of the space, so it is not repeated every tick). Per space and tick of a pass:
 *
 * 1. **The walk**, ONCE per pass: the read-only manifest walk (`buildFileManifest(..., { listOnly: true })`: one listing per directory, nothing
 *    hashed, and the paths it could not look at named in `unreadable`), under {@link withinFsBound}. What it found is kept in memory for the
 *    ticks that follow, so a walk longer than a tick's budget costs that one tick and the pages go on from the next: the paths kept, across
 *    every space, are at most {@link ABSENT_BYTES_WALK_KEPT_PATHS}; a walk that would pass that keeps none, and each of its rows is then
 *    confirmed alone (step 2). A walk the bound ends is not repeated within the pass: the space waits, and once `SWEEP_RESCAN_AFTER_MS` has
 *    passed since the pass began, that pass is given up and a new one walks again. A restart of the process walks again once.
 * 2. **The rows**, a page at a time by `_id` (live top-level rows, not instance-local files): a row the walk found is present; one under an
 *    unreadable path is UNLOOKED; any other is confirmed by `bytesHeldAt` (every spelling the disk may keep), bounded the same way: present,
 *    absent, or unlooked when the look fails or hits its bound. An unlooked row is never stamped and never removed.
 * 3. **The stamp**: an absent row gets `bytesAbsentSince` (the pass's `now`, local: no seq, no updatedAt, never on the wire), a present row loses
 *    a stale one; both in one bulk write per page.
 * 4. **The removal**, for a row stamped by an EARLIER pass: the facts are gathered by code (holds, legs, the last complete pass's counts, the
 *    directory) and {@link absentRowIsDue} asked. A due row is re-checked under its path lock (bytes still absent, row still the one decided on),
 *    the lock released, and retired by `removeFileHere(..., { retireOnlyIf })`, whose filter carries the stamp, hash and update time: a row
 *    rewritten meanwhile is not taken, and only rows really taken are counted, audited and metered. A row the filter refused, still stamped, is
 *    stamped again at `now`. A page whose due rows the tick's removal cap cut short is NOT passed by the cursor: the tick ends for the space
 *    there, its counts are not taken, and the next tick reads the page again (what was stamped or removed stays so).
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
 * One audit entry per space per pass that retired anything, written when the pass completes ({@link FILES_ABSENT_BYTES_SWEEP_OPERATION}, no
 * token, the paths capped at {@link ABSENT_BYTES_AUDIT_PATHS}): what the pass did is added up on its `running` state tick by tick (`said`,
 * bounded by the same cap). `ythril_files_absent_bytes_removed_total`, `ythril_files_awaiting_bytes{space}` (after every tick of a pass and every
 * restart, the count {@link filesAwaitingBytes} answers) and `ythril_files_absent_bytes_held{reason}`; one log line per space per pass that
 * stamped or removed anything, when it completes (a tick's own line is debug). It fires no webhook and no live
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
import { PassGenerations, passIsOwed, rememberPass, sweepStepDeadline, SWEEP_RESCAN_AFTER_MS } from './sweep-pass.js';
import { randomUUID } from 'node:crypto';
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
/**
 * The most records the sweep removes in one tick, across every space. The rest wait for the next tick: the page that holds them is not passed by
 * the cursor, so the next tick reads it again.
 */
export const ABSENT_BYTES_REMOVALS_PER_TICK = 200;
/** The most paths one audit entry names; past it the entry says how many it left out. */
export const ABSENT_BYTES_AUDIT_PATHS = 50;
/**
 * The most file paths the walks kept between the ticks of their passes hold, across every space: about a hundred bytes each, so tens of MB at
 * most. A walk that would pass it keeps no paths, and each row of its pass is confirmed alone.
 */
export const ABSENT_BYTES_WALK_KEPT_PATHS = 200_000;
/** The bound on the walk of one space, ms. */
const WALK_BOUND_MS = 120_000;
/** The bound on one look at one path, ms. */
const LOOK_BOUND_MS = 10_000;

/** The counts of one pass of one space: rows read, and how many of them were present, absent and could not be looked at. */
export interface PassCounts { recorded: number; present: number; absent: number; unlooked: number }
/** What a pass did, added up over its ticks, for the one audit entry and the one log line it writes when it completes. */
export interface PassSaid { stamped: number; cleared: number; removed: number; held: number; paths: string[] }
/** The sweep's state on a space's config entry. `id` names the pass, so a walk kept in memory is used by the pass that made it and no other. */
export interface AbsentBytesScan {
  running?: { id?: string; startedAt: string; after?: string; counts: PassCounts; said?: PassSaid };
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
  /** Replaces the walk of a space (a test's slow or failing disk). */
  walk: (spaceId: string) => Promise<WalkFound>;
  /** How long a tick goes on starting pages, ms (a test's short tick). */
  tickBudgetMs: number;
}
/** What the walk of a space found: the paths on disk, those it could not look at, and whether that list was cut. */
interface WalkFound { entries: ReadonlyArray<{ path: string }>; unreadable: readonly string[]; unreadableTruncated: boolean }
let steps: Partial<SweepSteps> | null = null;
/** A test seam only: `null` puts the real behaviour back. */
export function setAbsentBytesSweepStepsForTest(next: Partial<SweepSteps> | null): void { steps = next; }

/** What one tick of the step shares across its spaces: when it stops starting pages, how many removals are left, where it got to. */
export interface AbsentBytesTick { deadlineAt: number; removalsLeft: number; reached?: string }
/** Where the last tick got to: the next starts after it. */
let lastReached: string | undefined;

/** Whether a pass of a space is owed at `now`: one under way, none completed yet, or the last completed a day ago or more. */
const scanIsOwed = (state: AbsentBytesScan | undefined, now: Date): boolean =>
  passIsOwed({ running: state?.running !== undefined, completedAt: state?.last?.completedAt }, now, steps?.rescanAfterMs);

/** A new tick's budget. */
export function absentBytesTick(from: number = Date.now()): AbsentBytesTick {
  return { deadlineAt: steps?.tickBudgetMs !== undefined ? from + steps.tickBudgetMs : sweepStepDeadline(from), removalsLeft: ABSENT_BYTES_REMOVALS_PER_TICK };
}

/** `spaces` rotated to start after the space the last tick reached, so one large space cannot starve the rest. */
export function absentBytesSpaceOrder<T extends { id: string }>(spaces: readonly T[]): T[] {
  const at = lastReached === undefined ? -1 : spaces.findIndex(s => s.id === lastReached);
  return [...spaces.slice(at + 1), ...spaces.slice(0, at + 1)];
}
/** Remember where a tick got to. */
export function endAbsentBytesTick(tick: AbsentBytesTick): void { if (tick.reached !== undefined) lastReached = tick.reached; }

/** Bumped by a restart, so a page already running does not write state over the one a restore or an import cleared. */
const generations = new PassGenerations();

/** Held rows by reason, per space, as of each space's last decision: the gauge is their sum. */
const heldBySpace = new Map<string, Map<HoldReason, number>>();
function publishHeld(): void {
  for (const reason of HOLD_REASONS) {
    let n = 0;
    for (const counts of heldBySpace.values()) n += counts.get(reason) ?? 0;
    filesAbsentBytesHeldGauge.labels({ reason }).set(n);
  }
}

/**
 * Start the sweep of these spaces over and put every record they hold back on the longest wait, before the caller answers: what a restore and
 * an import do. Every stamp is cleared (what was stamped before says nothing of the rows now there), `filesRestoredAt` is set, and the next
 * tick's pass looks again. A space an act still holds refuses the stamp clear; that is said and the space is still restarted: its stamps keep
 * their age, and `filesRestoredAt` still holds every row of it to the longest window.
 *
 * **A store failure is never swallowed here**: it rejects, so an import answers it as every other door answers a failing store
 * (`a-store-failure-answers-alike-on-every-door-db`) instead of 200 with nothing done. Every space is restarted in memory and in config before the
 * first store write, so a failure leaves no space half restarted there. A caller with no door to answer (the restore's end) catches it.
 */
export async function restartAbsentBytesSweeps(spaceIds: readonly string[], at: Date = new Date()): Promise<void> {
  generations.bump(spaceIds);
  changeSpaceEntries(spaceIds, entry => {
    delete entry.absentBytesScan;
    entry.filesRestoredAt = at.toISOString();
    return true;
  });
  for (const id of spaceIds) { heldBySpace.delete(id); keptWalks.delete(id); }
  publishHeld();
  for (const id of spaceIds) {
    // A write to the space's files collection: it asks the write gate and is counted like every other (`admitSpaceWrite`). A space an act still
    // holds refuses it, and only that refusal is passed over; a store failure rejects.
    await admitSpaceWrite(id, 'files', async () => {
      await col<FileMetaDoc>(spaceCollection(id, 'files')).updateMany(asFilter<FileMetaDoc>({ [BYTES_ABSENT_SINCE]: { $exists: true } }), { $unset: { [BYTES_ABSENT_SINCE]: '' } } as never);
    }).catch((err: unknown) => {
      if (!isSpaceNotWritable(err)) throw err;
      log.warn(`Absent-bytes sweep: the stamps of space '${peerText(id)}' were not cleared after its records were brought back, an act holds it: ${peerText(err)}`);
    });
    filesAwaitingBytesGauge.labels({ space: id }).set(await filesAwaitingBytes(id));
  }
}

/** How many live file records of `spaceId` are waiting for their bytes (stamped): what `filesAwaitingBytes` answers. */
export async function filesAwaitingBytes(spaceId: string): Promise<number> {
  return col(spaceCollection(spaceId, 'files')).countDocuments({ ...AWAITING_BYTES_ROW });
}

/** Set `ythril_files_awaiting_bytes{space}` to what {@link filesAwaitingBytes} answers now, so the gauge and the stats never say two numbers. */
async function publishAwaiting(spaceId: string): Promise<void> {
  await filesAwaitingBytes(spaceId).then(n => { filesAwaitingBytesGauge.labels({ space: spaceId }).set(n); })
    .catch(err => log.debug(`Absent-bytes sweep: the awaiting-bytes count of space '${peerText(spaceId)}' could not be read: ${peerText(err)}`));
}

/**
 * The walks kept between the ticks of their passes, by space ({@link ABSENT_BYTES_WALK_KEPT_PATHS} paths at most across them): `here` is null
 * when the walk did not fit, `failed` when its bound ended it. Forgotten when the pass completes or is restarted.
 */
interface KeptWalk { passId: string; here: ReadonlySet<string> | null; unreadable: UnreadablePaths; cut: boolean; failed?: true }
const keptWalks = new Map<string, KeptWalk>();
const keptPaths = (): number => [...keptWalks.values()].reduce((n, w) => n + (w.here?.size ?? 0), 0);

/** Walk `spaceId` for the pass `passId` and keep what it found; a walk its bound ends is kept as failed, and thrown. */
async function walkFor(spaceId: string, passId: string): Promise<KeptWalk> {
  keptWalks.delete(spaceId);
  let found: WalkFound;
  try {
    found = await withinFsBound(() => (steps?.walk ?? ((id: string) => buildFileManifest(id, undefined, { listOnly: true })))(spaceId), WALK_BOUND_MS, `the absent-bytes walk of ${spaceId}`);
  } catch (err) {
    keptWalks.set(spaceId, { passId, here: null, unreadable: new UnreadablePaths(), cut: true, failed: true });
    throw err;
  }
  const fits = keptPaths() + found.entries.length <= ABSENT_BYTES_WALK_KEPT_PATHS;
  const kept: KeptWalk = { passId, here: fits ? new Set(found.entries.map(e => e.path)) : null, unreadable: new UnreadablePaths(found.unreadable), cut: found.unreadableTruncated };
  keptWalks.set(spaceId, kept);
  return kept;
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

/** Decide the stamped rows of a page and remove those due. Answers whether the tick's removal cap left due rows of the page untried. */
async function removeDue(spaceId: string, stamped: readonly SweptRow[], now: Date, last: PassCounts | null, tick: AbsentBytesTick, outcome: AbsentBytesOutcome): Promise<boolean> {
  if (stamped.length === 0) return false;
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
  let capped = false;
  for (const row of due) {
    if (confirmed.length >= tick.removalsLeft) { capped = true; break; }
    const still = await storedAbsOf(spaceId, row._id).then(abs => withPathLock(abs, async () => {
      if (await look(spaceId, row._id)) return false;
      return (await files.countDocuments(asFilter<FileMetaDoc>({ _id: row._id, ...LIVE_FILE_ROW, ...asDecided(row) }))) === 1;
    })).catch(() => false);
    if (still) confirmed.push(row);
  }
  if (confirmed.length === 0) return capped;
  await steps?.beforeRemove?.({ spaceId, paths: confirmed.map(r => r._id) });
  for (const row of confirmed) {
    if (tick.removalsLeft <= 0) break;
    const taken = await removeFileHere(spaceId, row._id, { failure: 'throw', retireOnlyIf: asDecided(row), retiredBy: 'bytes-lost' });
    if (taken) { outcome.removed.push(row._id); tick.removalsLeft--; continue; }
    // Rewritten since it was decided on: still stamped (its bytes still absent), its window starts again; cleared (bytes back), it is left alone.
    await admitSpaceWrite(spaceId, 'files', () => files.updateOne(asFilter<FileMetaDoc>({ _id: row._id, ...LIVE_FILE_ROW, [BYTES_ABSENT_SINCE]: { $exists: true } }), { $set: { [BYTES_ABSENT_SINCE]: now.toISOString() } } as never))
      .catch(err => log.warn(`Absent-bytes sweep: '${peerText(row._id)}' of space '${peerText(spaceId)}' could not be stamped again: ${peerText(err)}`));
  }
  return capped;
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
  if (!scanIsOwed(entry.absentBytesScan, now)) return outcome;
  tick.reached = spaceId;
  heldBySpace.set(spaceId, new Map());   // the held gauge says this space's latest decisions, never a sum over ticks
  const generation = generations.of(spaceId);
  const state: AbsentBytesScan = { ...(entry.absentBytesScan ?? {}) };
  const newPass = (): NonNullable<AbsentBytesScan['running']> =>
    ({ id: randomUUID(), startedAt: now.toISOString(), counts: { recorded: 0, present: 0, absent: 0, unlooked: 0 } });
  let running = state.running ?? newPass();
  running.id ??= randomUUID();
  const last = state.last?.counts ?? null;
  const startedAt = Date.now();
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const stampNow = now.toISOString();
  // What of `outcome` is already added to the pass's `said`: each page adds what it did since, and so does a tick that throws.
  const noted = { stamped: 0, cleared: 0, removed: 0, held: 0 };
  const noteSaid = (): void => {
    const said = running.said ?? { stamped: 0, cleared: 0, removed: 0, held: 0, paths: [] };
    said.stamped += outcome.stamped - noted.stamped;
    said.cleared += outcome.cleared - noted.cleared;
    said.held += outcome.held - noted.held;
    const fresh = outcome.removed.slice(noted.removed);
    said.removed += fresh.length;
    said.paths = [...said.paths, ...fresh].slice(0, ABSENT_BYTES_AUDIT_PATHS);
    Object.assign(noted, { stamped: outcome.stamped, cleared: outcome.cleared, removed: outcome.removed.length, held: outcome.held });
    running.said = said;
  };
  let saidOfPass: PassSaid | null = null;
  try {
    let walk = keptWalks.get(spaceId);
    if (walk !== undefined && walk.passId !== running.id) walk = undefined;
    if (walk?.failed === true) {
      // The walk of this pass hit its bound: not walked again within the pass. A day after the pass began it is given up, and a new one walks.
      if (now.getTime() - Date.parse(running.startedAt) < (steps?.rescanAfterMs ?? SWEEP_RESCAN_AFTER_MS)) return outcome;
      running = newPass();
      walk = undefined;
    }
    if (walk === undefined) {
      // The pass is written down before its walk, so a walk that fails is known by the pass's id on the next tick.
      state.running = running;
      rememberPass(spaceId, 'absentBytesScan', state);
      walk = await walkFor(spaceId, running.id!);
      if (generations.of(spaceId) !== generation) return outcome;   // a restore or an import restarted the pass during the walk
    }
    const { here, unreadable, cut } = walk;
    const lookedAway = (key: string): boolean => (here === null ? unreadable.covers(key) || cut : unreadable.couldNotLook(key, cut, here));

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
      // The page's counts, taken into the pass only when the cursor passes the page.
      const counts: PassCounts = { recorded: 0, present: 0, absent: 0, unlooked: 0 };
      for (const row of page.rows) {
        if (isInstanceLocalFile(row._id)) continue;
        counts.recorded++;
        let present: boolean | null;
        if (here?.has(row._id) === true) present = true;
        else if (lookedAway(row._id)) present = null;
        else present = await look(spaceId, row._id).catch(() => null);
        if (present === null) { counts.unlooked++; outcome.unlooked++; continue; }
        if (present) {
          counts.present++;
          if (row[BYTES_ABSENT_SINCE] !== undefined) toClear.push(row._id);
          continue;
        }
        counts.absent++;
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
      const heldBefore = outcome.held;
      const capped = await removeDue(spaceId, stampedBefore, now, last, tick, outcome);
      if (generations.of(spaceId) !== generation) return outcome;
      if (capped) {
        // Due rows the cap left are on this page: the cursor stays before it and its counts are not taken, so the next tick reads it again.
        // What was stamped, cleared and removed is done and is said; what was held is decided again then.
        outcome.held = heldBefore;
        noteSaid();
        state.running = running;
        rememberPass(spaceId, 'absentBytesScan', state);
        break;
      }
      for (const k of ['recorded', 'present', 'absent', 'unlooked'] as const) running.counts[k] += counts[k];
      noteSaid();
      if (page.end) {
        state.last = { completedAt: stampNow, counts: running.counts };
        delete state.running;
        outcome.completed = true;
        saidOfPass = running.said ?? null;
        keptWalks.delete(spaceId);
      } else {
        running.after = page.last;
        state.running = running;
      }
      rememberPass(spaceId, 'absentBytesScan', state);
      if (outcome.completed) break;
    }
  } finally {
    // A tick that threw still says what it did: added to the pass, when the pass is still this one.
    if (!outcome.completed && generations.of(spaceId) === generation && (outcome.stamped + outcome.cleared + outcome.removed.length > noted.stamped + noted.cleared + noted.removed)) {
      noteSaid();
      state.running = running;
      rememberPass(spaceId, 'absentBytesScan', state);
    }
    publishHeld();
    filesAbsentBytesRemovedTotal.inc(outcome.removed.length);
    await publishAwaiting(spaceId);
  }
  if (saidOfPass !== null) sayPass(spaceId, saidOfPass, running.counts.unlooked, startedAt);
  const tickLine = `Absent-bytes sweep of space '${peerText(spaceId)}', one tick: stamped ${outcome.stamped}, cleared ${outcome.cleared}, removed ${outcome.removed.length}, `
    + `kept ${outcome.held}, ${outcome.unlooked} could not be looked at; ${outcome.completed ? 'the pass is complete' : 'the pass goes on next cycle'}`;
  log.debug(tickLine);
  return outcome;
}

/** What a completed pass did: one audit entry when it retired anything, naming only the rows the retire really took, and one log line. */
function sayPass(spaceId: string, said: PassSaid, unlooked: number, startedAt: number): void {
  if (said.removed > 0) {
    logInternalAudit({
      method: 'SWEEP', path: 'internal:absent-bytes-sweep', spaceId, operation: FILES_ABSENT_BYTES_SWEEP_OPERATION, startedAt,
      changes: [
        { field: 'retiredPaths', added: said.paths },
        { field: 'removed', to: said.removed },
        ...(said.removed > said.paths.length ? [{ field: 'pathsNotListed', to: said.removed - said.paths.length }] : []),
      ],
    });
  }
  const line = `Absent-bytes sweep of space '${peerText(spaceId)}': stamped ${said.stamped} record(s) whose bytes are gone, cleared ${said.cleared} whose bytes are back, `
    + `removed ${said.removed}, kept ${said.held} still waiting, ${unlooked} could not be looked at; the pass is complete`;
  if (said.stamped + said.removed > 0) log.info(line); else log.debug(line);
}
