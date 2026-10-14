/**
 * What a file this instance deleted left behind — the recurring repair of derived rows and links that nothing else reaches (Q-465).
 *
 * ## The question it answers
 *
 * *"Which rows of this space hang off a file that is not there, and may this instance remove them?"* A file delete used to read one level
 * of `parentFileId` and a move re-rooted only the rows its plan named, so for years a delete or a move left chunk, converted, extracted,
 * caption and face rows whose chain ends at a file with no row, a flagged one, or a file the row's own id does not name; and a delete
 * left the links FROM the file. They are searchable, belong to nothing, and no later delete selects them again (a file uploaded at the
 * same path inherits them). The delete and the move were fixed going forward (Q-349, Q-464); the rows already there need this.
 *
 * ## What it removes, and the one thing each half needs to know
 *
 * **A derived row** (one with a `parentFileId`) whose chain, followed by the one walk (`files/ancestry.ts`), ends at a parent that has no
 * live row, or at a live file that is not the one the row's own id belongs to (`a.pdf#chunk0` under `b.pdf`). A chain the walk cannot
 * follow to its end (more than `MAX_ANCESTRY` levels) is KEPT: a row that cannot be explained is not removed. So is a row newer than the
 * scan's stamp, and **the stamp is in the DELETE's filter** (`createdAt` and `updatedAt` not after it), so a row a re-upload writes between
 * the decision and the delete survives it: the check cannot be separated from the removal.
 *
 * **A link** whose source is a path that has no live row, no bytes and no owed move, and for which THIS instance published the file's
 * tombstone, written by THIS instance. Each condition is the proof of one thing: the tombstone that the file was deleted (a link with
 * none is an early arrival, whose file's bytes have not landed), that it was deleted here and by us (a peer's tombstone proves nothing
 * about what this instance wrote, and each peer repairs its own leaks), that the file has not come back, and that a move is not still
 * carrying the links. The removal is the delete's own (`removeFileLinksThisInstanceWrote`, `brain/links.ts`): "written by this
 * instance" is the one reading the delete uses, so a link with no author (written here before authorship was stamped) is ours to remove
 * here as it is there, and each link is tombstoned so peers drop theirs. A link another instance
 * wrote stays with its author (ADR 05; whether it should go is the owner's, D-31).
 *
 * It removes nothing a person can still reach and nothing authored: rows derived from a file that is already deleted, and links from one.
 * That is irreversible, and a rollback to a build without it is harmless (it ignores the cursor key).
 *
 * ## How it runs, and why the cursor is on the config entry
 *
 * A step of the TTL sweep (`brain/ttl-sweep.ts`), one pass per tick: a bounded number of pages per space, inside a time budget, resuming
 * where the last tick stopped. The scan reads the derived rows by `_id` (a kept row never blocks a page: the cursor passes it), then the
 * links by `from`, then it is complete, and **it starts again no sooner than a day after it completed**. Where it has got to is
 * `SpaceConfig.leakedRowScan`, never the space's meta: meta replicates, and a cursor is bookkeeping about this disk (the precedent is
 * `deliveredByBackfilled`). **A restore and an import clear it before they answer** ({@link restartLeakedRowScans}), because the rows
 * they bring were never read, and do not run the scan themselves: the next tick does, at the ordinary pace.
 *
 * Everything it removes is counted (`ythril_leaked_rows_removed_total`, and what it read and kept `ythril_leaked_rows_kept_total`) and the
 * spaces still owing a scan are a gauge; one log line per space per pass says the counts (at info when the pass removed anything or kept a
 * row it could not explain, at debug when it met only the rows of live files), and a pass that removed anything writes one audit entry
 * (`file.leaked_rows.repair`, no token). A failure of a space, or of looking at a path, is the walk's to say (`eachSpace`): the cursor has
 * been advanced past what was done, so the next tick resumes after it. **A scan is complete only when every path of its last pass was
 * looked at**: a final page with a path whose bytes could not be looked at does not complete it.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { READ_CHUNK, readStoredById } from '../db/read-by-id.js';
import { idKeysetPage } from '../db/id-keyset-page.js';
import { getConfig } from '../config/loader.js';
import { changeSpaceEntries } from '../config/change-space-entries.js';
import { authorRef } from '../config/author.js';
import { logInternalAudit } from '../audit/audit.js';
import { LEAKED_ROWS_REPAIR_OPERATION } from '../audit/middleware.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { removeFileLinksThisInstanceWrote } from '../brain/links.js';
import { fileLinkSourcesAfter } from '../brain/link-adjacency.js';
import { leakedRowsKeptTotal, leakedRowsRemovedTotal, leakedRowsRepairPendingSpaces } from '../metrics/registry.js';
import { inChunks } from '../util/chunks.js';
import { log, peerText } from '../util/log.js';
import type { FileMetaDoc, SpaceConfig } from '../config/types.js';
import { walkUpFileChains } from './ancestry.js';
import { LIVE_FILE_ROW } from './live-file-row.js';
import { cancelMediaJobs } from './media/job-queue.js';
import { pathsCarriedByOwedMoves } from './move-markers.js';
import { belongsTo } from './moved-paths.js';
import { owningFilesOf } from './derived-rows.js';
import { bytesPresentAt } from './stored-bytes.js';
import { heldFileTombstones } from './tombstones.js';

/** Rows (and link sources) one page reads. */
export const REPAIR_PAGE_SIZE = 500;
/** The most pages one space reads in one tick of the sweep; the cursor carries the rest to the next. */
export const REPAIR_PAGES_PER_TICK = 20;
/** How long the step may go on STARTING pages, ms. A page already running is never interrupted. */
const REPAIR_STEP_BUDGET_MS = 30_000;
/** A scan that completed is not started again before this much time has passed, ms. */
export const REPAIR_RESCAN_AFTER_MS = 24 * 3_600_000;

/** The instant after which the step starts no new page, for a step beginning at `from` (default now). */
export const leakedRowsDeadline = (from: number = Date.now()): number => from + REPAIR_STEP_BUDGET_MS;

/** The seams a test narrows. Production passes none. */
interface RepairSteps {
  /** Runs after a page's leaked set was decided, claims revoked, and before the delete is issued: the interval a re-upload can land in. */
  beforeRemove: (page: { spaceId: string; ids: readonly string[] }) => void | Promise<void>;
  /** Rows (and link sources) per page. */
  pageSize: number;
  /** Pages one tick reads (the seam of "what is the cursor after ONE page"). */
  pagesPerTick: number;
}
let steps: Partial<RepairSteps> | null = null;
/** A test seam only: `null` puts the real behaviour back. */
export function setRepairStepsForTest(next: Partial<RepairSteps> | null): void { steps = next; }

type ScanState = NonNullable<SpaceConfig['leakedRowScan']>;

/** What one pass of one space did. */
export interface RepairOutcome {
  derivedRemoved: number;
  linksRemoved: number;
  kept: { depth: number; recent: number; live: number };
  /** The scan reached its end in this pass. */
  completed: boolean;
}

/** Whether the scan of a space is owed at `now`: running, never completed, or completed a day ago or more. */
const scanIsOwed = (state: ScanState | undefined, now: Date): boolean =>
  state?.phase !== undefined || state?.completedAt === undefined || now.getTime() - Date.parse(state.completedAt) >= REPAIR_RESCAN_AFTER_MS;

/** Bumped by a restart, so a page already running does not write a cursor over the one the restart cleared. */
const generations = new Map<string, number>();
const generationOf = (spaceId: string): number => generations.get(spaceId) ?? 0;

/**
 * Where the scan of a space is, set on its LIVE config entry (read at once by the next page) and written down SOON: coalesced with the
 * next ones (`saveConfigSoon`), so a tick of many pages is not a config write per page. A crash costs the progress since the last write,
 * and the pages are idempotent.
 */
function remember(spaceId: string, state: ScanState): void {
  changeSpaceEntries([spaceId], entry => { entry.leakedRowScan = state; return true; }, { save: 'soon' });
}

/**
 * Start the scan of these spaces again from the beginning, before the caller answers: what a restore and an import do, because the rows
 * they put there were never read and a scan that had completed would sit out its day over them. Nothing runs here: the next tick of the
 * sweep scans. A space with no scan state costs nothing.
 */
export function restartLeakedRowScans(spaceIds: readonly string[]): void {
  for (const id of spaceIds) generations.set(id, generationOf(id) + 1);
  changeSpaceEntries(spaceIds, entry => {
    if (entry.leakedRowScan === undefined) return false;
    delete entry.leakedRowScan;
    return true;
  });
}

/** Write the gauge: how many concrete spaces still owe a scan at `now`. Every pass writes it, so a pass that did not is visible. */
export function publishLeakedRowScansOwed(now: Date): void {
  leakedRowsRepairPendingSpaces.set(concreteSpaces().filter(s => scanIsOwed(s.leakedRowScan, now)).length);
}

/** What the scan stamp is compared with: a row written after it is a re-upload writing now. Mirrors {@link notAfter}, the delete's filter. */
const writtenAfter = (row: { createdAt?: unknown; updatedAt?: unknown }, stamp: string): boolean =>
  (typeof row.createdAt === 'string' && row.createdAt > stamp) || (typeof row.updatedAt === 'string' && row.updatedAt > stamp);
const notAfter = (stamp: string) => ({ createdAt: { $not: { $gt: stamp } }, updatedAt: { $not: { $gt: stamp } } });

interface Page { last?: string; end: boolean; failure?: Error }

/** The row ids a leaked row's media jobs are keyed by: the row itself and the derived rows above it. Never the path of the file that is gone. */
interface Leaked { id: string; jobIds: string[] }

/**
 * Remove the rows `leaked` names — **claims first**, then the delete, whose filter carries the stamp. The jobs of the rows and of every
 * derived row above them (never the live file at the top of a foreign chain: that file is somebody's) are taken first, so a run that read its
 * parent live writes nothing after the children went (`every-remover-of-file-rows-revokes-claims-first`), in one batched cancel for the page.
 *
 * **The job at the gone file's own path is not taken**: nothing here says that path is still dead, and a file uploaded there since has a
 * queued job of its own, which a cancel would take from it. The delete that made the file gone took that job.
 */
async function removeLeakedRows(spaceId: string, leaked: readonly Leaked[], stamp: string): Promise<number> {
  if (leaked.length === 0) return 0;
  const ids = leaked.map(l => l.id);
  await cancelMediaJobs(spaceId, leaked.flatMap(l => l.jobIds));
  await steps?.beforeRemove?.({ spaceId, ids });
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  let removed = 0;
  for (const part of inChunks(ids, READ_CHUNK)) {
    removed += (await files.deleteMany(asFilter<FileMetaDoc>({ _id: { $in: part }, parentFileId: { $type: 'string' }, ...notAfter(stamp) }))).deletedCount;
  }
  return removed;
}

/** One page of the derived rows by `_id`: decide each row, remove the leaked ones, count what was kept. */
async function derivedRowsPage(spaceId: string, after: string | undefined, stamp: string, size: number, outcome: RepairOutcome): Promise<Page> {
  // The next `size` rows by `_id` of ANY kind, and the derived ones picked out of them here: a page whose query said "has a parent" could
  // examine a long run of rows with none (the files, before the first derived row) and, on a timeout, never advance. A page of rows read
  // is bounded by its size, and the cursor passes the last row READ whether or not it was derived, so the scan cannot wedge on a gap.
  const { rows: read, last, end } = await idKeysetPage<{ _id: string; parentFileId?: unknown; deletedAt?: unknown; createdAt?: string; updatedAt?: string }>({
    collection: spaceCollection(spaceId, 'files'),
    filter: {},
    projection: { _id: 1, parentFileId: 1, deletedAt: 1, createdAt: 1, updatedAt: 1 }, size,
    // By `_id` and no other index: the cursor is the id, and the planner left to choose could read every row to sort a page.
    hint: { _id: 1 },
  }, after);
  const rows = read.filter((r): r is typeof r & { parentFileId: string } => typeof r.parentFileId === 'string' && !('deletedAt' in r));

  const settled = rows.filter(r => !writtenAfter(r, stamp));
  outcome.kept.recent += rows.length - settled.length;
  const chains = await walkUpFileChains(spaceId, new Map(settled.map(r => [r._id, r.parentFileId])));
  const leaked: Leaked[] = [];
  for (const row of settled) {
    const { ancestors, result } = chains.get(row._id)!;
    if (result.end === 'too-deep') outcome.kept.depth++;
    else if (result.end === 'gone') leaked.push({ id: row._id, jobIds: [row._id, ...ancestors.map(a => a._id)] });
    else if (result.end === 'top' && !belongsTo(row._id, result.at)) leaked.push({ id: row._id, jobIds: [row._id, ...ancestors.slice(0, -1).map(a => a._id)] });
    else outcome.kept.live++;
  }
  outcome.derivedRemoved += await removeLeakedRows(spaceId, leaked, stamp);
  return { ...(last !== undefined ? { last } : {}), end };
}

/**
 * The sources among `froms` whose links the repair may remove: this instance published the file's tombstone, nothing is at the path (no live row,
 * no bytes) and no move is carrying it. A path whose bytes cannot be looked at is neither: it is kept and named in `unlooked`.
 *
 * **A derived source is asked about its FILE** (`owningFilesOf`): `a.jpg#face-chunk0` has no tombstone of its own — the delete wrote one for
 * `a.jpg` — so asked as itself it read "no tombstone" and its links stayed for ever, though the delete's own step takes them.
 */
async function leakedLinkSources(spaceId: string, froms: readonly string[]): Promise<{ sources: string[]; unlooked: Array<{ path: string; err: unknown }> }> {
  const self = authorRef().instanceId;
  const owner = await owningFilesOf(spaceId, froms);
  const owners = [...new Set(owner.values())];
  const held = await heldFileTombstones(spaceId, owners);
  const deletedHere = owners.filter(p => held.get(p)?.some(t => t.issuer === self));
  const live = new Set((await readStoredById<{ _id: string }>(spaceCollection(spaceId, 'files'), deletedHere, { _id: 1 }, { filter: LIVE_FILE_ROW })).keys());
  const unmoved = deletedHere.filter(p => !live.has(p));
  const carried = await pathsCarriedByOwedMoves(spaceId, unmoved);
  const gone = new Set<string>();
  const unlooked: Array<{ path: string; err: unknown }> = [];
  for (const path of unmoved.filter(p => !carried.has(p))) {
    try { if (!await bytesPresentAt(spaceId, path)) gone.add(path); } catch (err) { unlooked.push({ path, err }); }
  }
  return { sources: froms.filter(f => gone.has(owner.get(f)!)), unlooked };
}

/** One page of the links FROM files, by `from`: remove those a deleted file left, which this instance wrote. */
async function deletedFileLinksPage(spaceId: string, after: string | undefined, stamp: string, size: number, outcome: RepairOutcome): Promise<Page> {
  const { froms, last, rows } = await fileLinkSourcesAfter(spaceId, after, size);
  const { sources, unlooked } = await leakedLinkSources(spaceId, froms);
  // Written before the stamp only: a link a re-upload's author saved since is not one this page decided on.
  outcome.linksRemoved += await removeFileLinksThisInstanceWrote(spaceId, sources, { createdUntil: stamp });
  return {
    ...(last !== undefined ? { last } : {}), end: rows < size,
    ...(unlooked.length > 0 ? { failure: new Error(`${unlooked.length} link source path(s) could not be looked at, so their links were kept (first: ${peerText(unlooked[0]!.path)}: ${peerText(unlooked[0]!.err)})`) } : {}),
  };
}

/**
 * One tick of the repair for one space: resume the scan where the last tick stopped, read pages until the tick's budget is spent or the scan
 * reaches its end, and remember where it is after EACH page. Must run inside a walk of the spaces (`eachSpace`).
 *
 * @param deadlineAt epoch ms after which no new page starts: the step's own, shared by the spaces of a tick
 */
export async function repairLeakedRows(spaceId: string, now: Date, opts: { deadlineAt?: number } = {}): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { derivedRemoved: 0, linksRemoved: 0, kept: { depth: 0, recent: 0, live: 0 }, completed: false };
  const state = getConfig().spaces.find(s => s.id === spaceId)?.leakedRowScan;
  if (!scanIsOwed(state, now)) return outcome;
  const deadlineAt = opts.deadlineAt ?? leakedRowsDeadline();
  const size = steps?.pageSize ?? REPAIR_PAGE_SIZE;
  const stamp = now.toISOString();
  const startedAt = Date.now();
  const generation = generationOf(spaceId);

  let at: ScanState = state?.phase !== undefined ? state : { phase: 'rows' };
  let failure: Error | undefined;
  try {
    for (let pages = 0; pages < (steps?.pagesPerTick ?? REPAIR_PAGES_PER_TICK) && Date.now() < deadlineAt; pages++) {
      const phase = at.phase ?? 'rows';
      const page = await (phase === 'rows' ? derivedRowsPage : deletedFileLinksPage)(spaceId, at.after, stamp, size, outcome);
      // A restore or an import cleared the scan while this page ran: what it read is not what the space holds now, so it records nothing.
      if (generationOf(spaceId) !== generation) return outcome;
      // A final page with a path it could not look at is NOT the end of the scan: nothing is recorded as complete while a path of the pass
      // was unlooked, so the gauge and the daily wait never claim a scan that did not see every path. The cursor passes the page, and the
      // next tick (an empty final page, if nothing else arrived) completes it.
      if (!page.end || (page.failure && phase === 'links')) at = { phase, ...(page.last !== undefined ? { after: page.last } : {}) };
      else if (phase === 'rows') at = { phase: 'links' };
      else at = { completedAt: now.toISOString() };
      remember(spaceId, at);
      outcome.completed = at.phase === undefined;
      if (page.failure) failure = page.failure;
      if (outcome.completed || failure) break;
    }
  } finally {
    leakedRowsRemovedTotal.labels({ kind: 'derived' }).inc(outcome.derivedRemoved);
    leakedRowsRemovedTotal.labels({ kind: 'link' }).inc(outcome.linksRemoved);
    for (const reason of ['depth', 'recent', 'live'] as const) leakedRowsKeptTotal.labels({ reason }).inc(outcome.kept[reason]);
    // One entry per space per pass that removed anything — in the `finally`, so rows removed by pages before a failing one are audited too.
    if (outcome.derivedRemoved + outcome.linksRemoved > 0) {
      logInternalAudit({ method: 'SWEEP', path: 'internal:leaked-rows-repair', spaceId, operation: LEAKED_ROWS_REPAIR_OPERATION, startedAt });
    }
  }
  const said = `Leaked-rows repair of space '${peerText(spaceId)}': removed ${outcome.derivedRemoved} row(s) derived from files that are gone and ${outcome.linksRemoved} link(s) of deleted files; `
    + `kept ${outcome.kept.live} of live files, ${outcome.kept.recent} newer than the scan, ${outcome.kept.depth} too deep to follow; ${outcome.completed ? 'the scan is complete' : 'the scan goes on next cycle'}`;
  // Info when the pass removed anything or kept a row for a reason an operator may want to know (newer than the scan, too deep to follow);
  // a pass that met only the rows of live files, which is every pass of a healthy space, says it at debug.
  if (outcome.derivedRemoved + outcome.linksRemoved + outcome.kept.recent + outcome.kept.depth > 0) log.info(said); else log.debug(said);
  if (failure) throw failure;
  return outcome;
}
