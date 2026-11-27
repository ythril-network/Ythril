/**
 * The rebuild of a space's triple index: every record read whole into collections named by the build's id, then swapped in, fenced so
 * that only the build holding the build row lands (bundle-273, Q-764 S4; design-r2 R5; contract rows 1 and 4).
 *
 * ## The question it answers
 *
 * "Make this space's index exactly what its records state now, whatever the index holds." The follower (`follow.ts`) keeps an index up by
 * position and by the journal; it cannot repair one that is missing, built for another form, marked `stale`, or that drifted. A rebuild
 * is what makes such an index ready again. The upkeep job (`verify.ts`) and the admin door start it.
 *
 * ## How
 *
 * 1. **Claim.** The build row of `rdf_state` is taken for a fresh 16-hex build id with a lease ({@link BUILD_LEASE_MS}); a row another build
 *    holds refuses the start (`busy`). The records stream's settled cap is read FIRST, then the journal rows done before the start are
 *    marked as this build's (`seenBy`): each such write landed before any record is read.
 * 2. **Fill.** Every record of the six record collections is read by `_id` pages, rows without a `pos` included (the follower never reads
 *    those), and applied into `<space>_rdf_b<buildId>_{terms,quads,records}` (`store.ts` `applyRecordChanges`, the follower's one write)
 *    in one transaction per page. Each transaction is fenced first (`fenceTripleIndexBuild`, as `files/media/lease.ts` fences a job): a build
 *    whose lease ran out, or whose row another build took, writes nothing and stops (`RebuildFenced`), and its collections are dropped. A
 *    form change during the fill abandons the build (`form-changed`).
 * 3. **Swap.** Under the follower's lease (so no follower batch runs across it) and fenced, one transaction writes the state: this build's
 *    id and form, `appliedPos` one below the cap read at the start, status `stale`; deletes the journal rows marked as this build's and the
 *    verify's cursors. The build's collections are then renamed onto the live names and the read indexes are built on them, each step
 *    renewing the build's lease first (and refused once the build lost its row); a last fenced transaction sets the status `ready`. A swap
 *    that stops anywhere between the two transactions, or fails after the first, leaves the index `stale`: no query reads it, the follower
 *    leaves it, and the upkeep rebuilds it (findings F2 and F6, review point U1).
 *
 * ## What it prevents
 *
 * - **A query reading half of two builds (finding F5).** A query pins the build id it read (`read.ts`) and checks it at its end; the id
 *   changes in the swap's first transaction, before any collection is renamed, so a query that read across the swap reads its records again.
 * - **A write lost to the swap.** A positioned write above the start's cap is applied by the follower after the swap (`appliedPos` is
 *   below it); a journaled write not done at the start keeps its row, which the follower clears after the swap. While a build runs the
 *   follower clears no journal row (`store.ts`), so no change is cleared from the journal after the build read its record.
 * - **Two builds.** One build row, one holder; a late batch of a build that lost it is refused by the fence.
 * - **A mixed index marked ready (finding F2).** The state is `stale` from the swap's first transaction until its last, so a rename that
 *   throws, a process that stops, or a build stalled past its lease and overtaken by another leaves an index no query reads.
 * - **A rebuild cut by the shutdown.** The fill stops at its next page once the shutdown began, and the shutdown awaits the rebuilds in
 *   flight ({@link awaitTripleIndexRebuilds}) before it closes the database.
 */
import { randomBytes } from 'node:crypto';
import type { Document } from 'mongodb';
import { getDb, col, asFilter, asUpdate } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { inBoundedTransaction } from '../../db/bounded-transaction.js';
import { idKeysetPage } from '../../db/id-keyset-page.js';
import { buildDeclaredIndexOn, buildSpaceIndex, TRIPLE_INDEX_INDEXES } from '../../spaces/space-indexes.js';
import { settledPositionCap } from '../../util/position-clock.js';
import { recordPositions } from '../../sync/record-position-stream.js';
import { log, outsideRequest, peerText } from '../../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../../util/warn-once.js';
import { detachedWrite } from '../../db/write-bound.js';
import { rdfIndexRebuildsTotal } from '../../metrics/rdf-index-metrics.js';
import { isShuttingDown } from '../../lifecycle.js';
import { RDF_KIND_COLLECTIONS } from '../rdf-members.js';
import type { RdfRecordKind } from '../record-triples.js';
import {
  applyRecordChanges, buildCollectionsOf, claimTripleIndexBuild, dropOrphanBuildCollections, fenceTripleIndexBuild, formKeyOf, liveCollections,
  markTripleIndexStale, readTripleIndexState, releaseTripleIndexBuild, releaseTripleIndexLease, runningTripleIndexBuild, setBuiltStatus,
  takeTripleIndexLease, writeBuiltState, RebuildFenced, type IndexCollections, type RecordChange, type TripleIndexStatus,
} from './store.js';
import { formMetaOf, projectionOf, statementsOf } from './follow.js';
import { journalRowAbandonedMs } from './journal.js';

export { RebuildFenced };

/** How long a build holds its row without a batch; renewed by every fenced batch. */
export const BUILD_LEASE_MS = 120_000;
/** The records one fenced transaction of a fill applies. */
export const REBUILD_BATCH_RECORDS = 500;
/** How often, and how long apart, a swap asks for the follower's lease before it gives up (the follower holds it for one run). */
const SWAP_LEASE_TRIES = 100;
const SWAP_LEASE_WAIT_MS = 50;
/** The bytes of a build id (16 hex characters). */
const BUILD_ID_BYTES = 8;

/** One build in progress: what `beginTripleIndexBuild` took. */
export interface TripleIndexBuild {
  spaceId: string;
  buildId: string;
  /** The form the build states (`formKeyOf` of the meta at its start). */
  formKey: string;
  /** The records stream's settled cap read before any record: every record below it was visible to the fill. */
  startCap: number;
  startedAt: number;
  leaseMs: number;
  target: IndexCollections;
}

/**
 * What a rebuild did: `built` (swapped in), `busy` (another build holds the row), `no-form` (RDF off or unsettled), `form-changed`,
 * `stopped` (the process began to shut down: none starts, and a fill stops at its next page).
 */
export interface RebuildResult { outcome: 'built' | 'busy' | 'no-form' | 'form-changed' | 'stopped'; buildId?: string; records?: number }

/** Why an index is rebuilt (the upkeep's reasons, `verify.ts`). */
export type RebuildReason = 'missing' | 'stale' | 'journal' | 'form' | 'verify' | 'unused-terms';
/** Who started a rebuild, for its counter: the upkeep with its reason, or `admin` (the door, or a call by hand). */
export type RebuildTrigger = RebuildReason | 'admin';

/**
 * Start a build of `spaceId`: claim the build row, read the cap, mark the journal rows done before now as the build's. `null` when another
 * build holds the row or the space has no form now.
 */
export async function beginTripleIndexBuild(spaceId: string, opts: { leaseMs?: number } = {}): Promise<TripleIndexBuild | null> {
  const meta = formMetaOf(spaceId);
  if (meta === null) return null;
  const leaseMs = opts.leaseMs ?? BUILD_LEASE_MS;
  const buildId = randomBytes(BUILD_ID_BYTES).toString('hex');
  if (!(await claimTripleIndexBuild(spaceId, buildId, leaseMs))) return null;
  const target = buildCollectionsOf(spaceId, buildId);
  try {
    // The row is held, so no other build of the space writes: every other build collection is one an earlier build left (review point U3).
    await dropOrphanBuildCollections(spaceId, buildId);
    const startCap = await settledPositionCap(recordPositions, spaceId);
    const startedAt = Date.now();
    // The rows this build answers: done before its start, and the rows of a writer that died (older than `journalRowAbandonedMs`, as the
    // follower clears them): a `*` row nobody marks done is otherwise never cleared and asks for a rebuild at every tick (finding F1).
    const abandonedBefore = startedAt - journalRowAbandonedMs();
    await col<Document>(spaceCollection(spaceId, 'rdfDirty')).updateMany(
      asFilter<Document>({ at: { $lte: startedAt }, $or: [{ done: true }, { at: { $lt: abandonedBefore } }] }), asUpdate<Document>({ $set: { seenBy: buildId } }));
    // The fill looks terms up by `k` for every page: the unique key is on the build's dictionary before the first page (finding F3), where it
    // would otherwise be built after the swap and every lookup scan the dictionary so far.
    const termsIndex = TRIPLE_INDEX_INDEXES.find(ix => ix.part === 'rdfTerms');
    if (termsIndex === undefined) throw new Error('the triple index declares no index on its dictionary');
    await buildDeclaredIndexOn(spaceId, termsIndex, target.terms);
    return { spaceId, buildId, formKey: formKeyOf(meta), startCap, startedAt, leaseMs, target };
  } catch (err) {
    // A start that failed after it claimed the row gives it back, or the space answers `busy` for the whole lease (finding F7).
    await dropBuildCollections({ spaceId, buildId, target });
    await releaseTripleIndexBuild(spaceId, buildId).catch(() => undefined);
    throw err;
  }
}

/**
 * Read every record of the build's space into its collections, a fenced transaction per page. Answers the records read; throws
 * {@link RebuildFenced} (its collections dropped) when the build lost its row, and a `FormChanged` when the space's form changed.
 */
export async function fillTripleIndexBuild(build: TripleIndexBuild): Promise<number> {
  try {
    let records = 0;
    for (const { kind, collection } of RDF_KIND_COLLECTIONS) {
      let after: string | undefined;
      for (;;) {
        // The shutdown awaits this rebuild before the database closes: the fill stops at a page, never runs on into the close.
        if (isShuttingDown()) throw new RebuildStopped();
        const page = await idKeysetPage<{ _id: string } & Record<string, unknown>>(
          { collection: spaceCollection(build.spaceId, collection), filter: {}, projection: projectionOf(kind), size: REBUILD_BATCH_RECORDS }, after);
        await writeBatch(build, kind, page.rows);
        records += page.rows.length;
        if (page.end || page.last === undefined) break;
        after = page.last;
      }
    }
    return records;
  } catch (err) {
    await dropBuildCollections(build);
    throw err;
  }
}

/** The process began to shut down while the fill ran: the build is given up. */
class RebuildStopped extends Error {
  constructor() { super('the process is shutting down: the triple index rebuild stopped at its next page'); this.name = 'RebuildStopped'; }
}

/** The form of a space changed while its build ran: the build states the old one, and is given up. */
class FormChanged extends Error {
  constructor() { super('the space\'s form changed while its triple index was rebuilt'); this.name = 'FormChanged'; }
}

/** One page of records of `kind` stated into the build's collections, in one fenced transaction. */
async function writeBatch(build: TripleIndexBuild, kind: RdfRecordKind, docs: ReadonlyArray<Record<string, unknown> & { _id: string }>): Promise<void> {
  const meta = formMetaOf(build.spaceId);
  if (meta === null || formKeyOf(meta) !== build.formKey) throw new FormChanged();
  const changes: RecordChange[] = docs.map(doc => ({
    kind, id: String(doc._id), pos: typeof doc['pos'] === 'number' ? doc['pos'] : 0, statements: statementsOf(meta, kind, doc),
  }));
  await inBoundedTransaction(async (session) => {
    await fenceTripleIndexBuild(build.spaceId, build.buildId, build.leaseMs, session);
    await applyRecordChanges(build.spaceId, changes, session, build.target);
  });
}

/**
 * Swap the build in: see the module docblock, step 3. Throws {@link RebuildFenced} when the build lost its row before its state was written
 * (the index is left as it was, and the build's collections are dropped).
 */
export async function swapTripleIndexBuild(build: TripleIndexBuild): Promise<void> {
  const { spaceId, buildId } = build;
  const owner = `rebuild-${buildId}`;
  let leased = false;
  // True once the first transaction committed: from then on the live collections may be part of this build, part of the index before it.
  let stated = false;
  // Renew the build's lease and refuse when the build lost its row: before each step that may take long, and before each rename (review
  // points U1 and finding F6: the lease was last renewed by the first transaction, so a swap whose index builds outlasted it was fenced).
  const stillHeld = (): Promise<void> => fenceTripleIndexBuild(spaceId, buildId, build.leaseMs);
  try {
    for (let i = 0; i < SWAP_LEASE_TRIES && !leased; i++) {
      leased = await takeTripleIndexLease(spaceId, owner, build.leaseMs);
      if (!leased) await new Promise(resolve => setTimeout(resolve, SWAP_LEASE_WAIT_MS));
    }
    if (!leased) throw new Error(`the triple index of space '${spaceId}' could not take the follower's lease for its swap`);
    await inBoundedTransaction(async (session) => {
      await fenceTripleIndexBuild(spaceId, buildId, build.leaseMs, session);
      // `stale` until the last transaction: the collections are renamed one by one, and an index that stops between two renames must be
      // read by nobody (finding F2). The follower leaves a stale index alone, queries read the records, and the upkeep rebuilds it.
      await writeBuiltState(spaceId, { appliedPos: Math.max(0, build.startCap - 1), formKey: build.formKey, status: 'stale', buildId }, session);
      await col<Document>(spaceCollection(spaceId, 'rdfDirty')).deleteMany(asFilter<Document>({ seenBy: buildId }), { session });
    });
    stated = true;
    const live = liveCollections(spaceId);
    for (const part of ['terms', 'quads', 'records'] as const) {
      await stillHeld();
      if (await collectionExists(build.target[part])) await getDb().renameCollection(build.target[part], live[part], { dropTarget: true });
      // A space whose records state nothing wrote no row, so the build made no collection: its index is empty, the live one dropped.
      else if (await collectionExists(live[part])) await getDb().dropCollection(live[part]);
    }
    for (const ix of TRIPLE_INDEX_INDEXES) {
      await stillHeld();
      await buildSpaceIndex(spaceId, ix);
    }
    await inBoundedTransaction(async (session) => {
      await fenceTripleIndexBuild(spaceId, buildId, build.leaseMs, session);
      await setBuiltStatus(spaceId, buildId, 'ready', session);
    });
  } catch (err) {
    await dropBuildCollections(build);
    // A build that stopped after its state was written may have renamed between the renames of the build that took its row over (review
    // point U1): whatever the state names now, the index is not known whole. Marked stale, it is read from the records and rebuilt.
    if (stated) await markTripleIndexStale(spaceId).catch((markErr: unknown) => rebuildFailed(spaceId,
      () => log.warn(`Triple index of space '${peerText(spaceId)}': a swap that failed could not mark the index stale: ${peerText(String(markErr))}`)));
    throw err;
  } finally {
    if (leased) await releaseTripleIndexLease(spaceId, owner);
    await releaseTripleIndexBuild(spaceId, buildId);
  }
}

/** Whether the collection `name` exists (a build's collection exists only once a write made it). */
async function collectionExists(name: string): Promise<boolean> {
  return (await getDb().listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
}

/** Drop the collections of a build that ended without a swap (or after one: a renamed collection is gone already). */
async function dropBuildCollections(build: Pick<TripleIndexBuild, 'spaceId' | 'buildId' | 'target'>): Promise<void> {
  for (const name of Object.values(build.target)) {
    try {
      if (await collectionExists(name)) await getDb().dropCollection(name);
    } catch (err) {
      // The build's own failure is what its caller reports, so this one never replaces it; a collection left behind is said once.
      rebuildFailed(build.spaceId, () => log.warn(`Triple index of space '${peerText(build.spaceId)}': a collection of build ${peerText(build.buildId)} `
        + `could not be dropped: ${peerText(String(err))}`));
    }
  }
}

/**
 * Rebuild `spaceId`'s index whole: begin, fill, swap (see the module docblock). `onClaimed(true)` is called once the build row is held,
 * `onClaimed(false)` when the rebuild ends without it (the outcome says why): the admin door answers after that call.
 */
export async function rebuildTripleIndex(spaceId: string, opts: { leaseMs?: number; onClaimed?: (claimed: boolean) => void; reason?: RebuildTrigger } = {}): Promise<RebuildResult> {
  const reason = opts.reason ?? 'admin';
  try {
    const result = await buildTripleIndex(spaceId, opts);
    rdfIndexRebuildsTotal.inc({ reason, outcome: result.outcome });
    return result;
  } catch (err) {
    rdfIndexRebuildsTotal.inc({ reason, outcome: 'failed' });
    throw err;
  }
}

/** One rebuild's work (see {@link rebuildTripleIndex}, which counts its outcome). */
async function buildTripleIndex(spaceId: string, opts: { leaseMs?: number; onClaimed?: (claimed: boolean) => void }): Promise<RebuildResult> {
  const refused = (outcome: 'no-form' | 'busy' | 'stopped'): RebuildResult => { opts.onClaimed?.(false); return { outcome }; };
  if (isShuttingDown()) return refused('stopped');
  if (formMetaOf(spaceId) === null) return refused('no-form');
  const build = await beginTripleIndexBuild(spaceId, opts);
  if (build === null) return refused(formMetaOf(spaceId) === null ? 'no-form' : 'busy');
  opts.onClaimed?.(true);
  try {
    const records = await fillTripleIndexBuild(build);
    await swapTripleIndexBuild(build);
    log.info(`Triple index of space '${peerText(spaceId)}': rebuilt from ${records} record(s) (build ${peerText(build.buildId)})`);
    return { outcome: 'built', buildId: build.buildId, records };
  } catch (err) {
    await releaseTripleIndexBuild(spaceId, build.buildId);
    if (err instanceof FormChanged) return { outcome: 'form-changed' };
    if (err instanceof RebuildStopped) return { outcome: 'stopped' };
    throw err;
  }
}

/** One rebuild in this process: its result, and whether it holds the build row (`false`: it ended without, and its result says why). */
export interface TripleIndexRebuildRun { result: Promise<RebuildResult>; claimed: Promise<boolean> }

/** Per space: the rebuild this process runs now, which every caller arriving meanwhile shares. */
const running = new Map<string, TripleIndexRebuildRun>();

/** The rebuild of `spaceId` this process runs, started when none runs: `joined` says it ran already. */
function runOf(spaceId: string, reason: RebuildTrigger): { run: TripleIndexRebuildRun; joined: boolean } {
  const now = running.get(spaceId);
  if (now) return { run: now, joined: true };
  let resolveClaim!: (claimed: boolean) => void;
  let rejectClaim!: (err: unknown) => void;
  const claimed = new Promise<boolean>((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject; });
  // Nobody may be waiting for the claim (the upkeep's start): its rejection is the result's, which the caller handles.
  claimed.catch(() => undefined);
  const result = rebuildTripleIndex(spaceId, { onClaimed: resolveClaim, reason }).then(
    r => { resolveClaim(false); return r; },
    (err: unknown) => { rejectClaim(err); throw err; },
  ).finally(() => { if (running.get(spaceId)?.result === result) running.delete(spaceId); });
  const run = { result, claimed };
  running.set(spaceId, run);
  return { run, joined: false };
}

/**
 * Rebuild `spaceId`'s index once in this process: a call while one runs shares it. Resolves with its result, rejects with its failure.
 */
export function requestTripleIndexRebuild(spaceId: string, reason: RebuildTrigger = 'admin'): Promise<RebuildResult> {
  return runOf(spaceId, reason).run.result;
}

/** Whether this process runs a rebuild of `spaceId` now. */
export const rebuildRunsHere = (spaceId: string): boolean => running.has(spaceId);

/** Whether this process runs a rebuild of any space now. */
export const anyRebuildRunsHere = (): boolean => running.size > 0;

/**
 * Wait for every rebuild this process runs to end, at most `ms`: `false` when one still ran then. The shutdown calls it before it closes the
 * database, after `beginShutdown` made each fill stop at its next page; a swap in progress is not cut (it is a few renames), and one the
 * database closes under is left stale, which the upkeep rebuilds after the next start.
 */
export async function awaitTripleIndexRebuilds(ms: number): Promise<boolean> {
  const ending = [...running.values()].map(r => r.result.then(() => undefined, () => undefined));
  if (ending.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([Promise.all(ending).then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start a rebuild of `spaceId` outside the caller's request or tick, each of its operations bounded as a detached write (the admin door
 * and the upkeep tick call it). Answers at once with the handle: `claimed` settles when the build row is held or the rebuild ended
 * without it, `result` when the rebuild ends. A failure is said once per window and space, whoever waits; `joined` says one ran already.
 */
export function launchTripleIndexRebuild(spaceId: string, who: string, reason: RebuildTrigger): Promise<{ run: TripleIndexRebuildRun; joined: boolean }> {
  return outsideRequest(() => detachedWrite(async () => {
    const started = runOf(spaceId, reason);
    if (!started.joined) {
      started.run.result.catch((err: unknown) => rebuildFailed(spaceId,
        () => log.warn(`Triple index of space '${peerText(spaceId)}': the rebuild ${peerText(who)} started failed: ${peerText(String(err))}`)));
    }
    return started;
  }));
}

/** The status of one space's index, as the admin door reads it (`space_rdf_index`). */
export interface TripleIndexStatusView {
  spaceId: string;
  /**
   * `absent`: no index (RDF off, or none built yet); `unbuilt`: a state no rebuild wrote (it names no build, so queries read the records,
   * whatever its own status says); otherwise its state row's status, which only a built index has.
   */
  status: TripleIndexStatus | 'absent' | 'unbuilt';
  /** The build the live index came from (`null`: none, or a state no rebuild wrote). */
  buildId: string | null;
  appliedPos: number | null;
  /** A rebuild holds the build row now (in this process or another). */
  rebuilding: boolean;
}

/** The status of `spaceId`'s index now. */
export async function tripleIndexStatusOf(spaceId: string): Promise<TripleIndexStatusView> {
  const state = await readTripleIndexState(spaceId);
  const building = rebuildRunsHere(spaceId) || (await runningTripleIndexBuild(spaceId)) !== null;
  const buildId = state?.buildId ?? null;
  const status = state === null ? 'absent' : buildId === null ? 'unbuilt' : state.status;
  return { spaceId, status, buildId, appliedPos: state?.appliedPos ?? null, rebuilding: building };
}

/** The codes the admin door's start refuses with: the one list `space_rdf_rebuild`'s description names them from. */
export const TRIPLE_INDEX_REBUILD_REFUSAL_CODES = ['rdf_off', 'rebuild_busy', 'shutting_down'] as const;
/** The status of a refusal by the space's state: it has no RDF form now (`rdf_off`), or another instance's build holds its row (`rebuild_busy`). */
const REBUILD_REFUSED_STATUS = 409 as const;
/** The status of a refusal by the process: it is shutting down and starts no rebuild. */
const REBUILD_SHUTTING_DOWN_STATUS = 503 as const;

/** What the admin door's start answers: started (or one runs already), or refused (the codes above). */
export type RebuildStart = { ok: true; status: 'started' | 'running'; spaceId: string }
  | { ok: false; status: typeof REBUILD_REFUSED_STATUS | typeof REBUILD_SHUTTING_DOWN_STATUS; code: typeof TRIPLE_INDEX_REBUILD_REFUSAL_CODES[number]; error: string };

/**
 * Start a rebuild of `spaceId`'s index in the background (the admin door): the rebuild runs outside the request that asked for it, each of
 * its operations bounded as a detached write, but the answer waits for its claim of the build row: `started` only for a rebuild that holds
 * it, `rebuild_busy` when another instance's build does (finding F11). A space with RDF off or unsettled names is refused.
 */
export async function startTripleIndexRebuild(spaceId: string): Promise<RebuildStart> {
  if (formMetaOf(spaceId) === null) {
    return { ok: false, status: REBUILD_REFUSED_STATUS, code: 'rdf_off', error: `Space '${peerText(spaceId)}' has RDF off or names that are not settled, so it has no triple index to rebuild` };
  }
  const { run, joined } = await launchTripleIndexRebuild(spaceId, 'an admin', 'admin');
  if (joined || await run.claimed) return { ok: true, status: joined ? 'running' : 'started', spaceId };
  // Not claimed: the rebuild ended at once, and its outcome says why.
  const outcome = (await run.result).outcome;
  if (outcome === 'stopped') {
    return { ok: false, status: REBUILD_SHUTTING_DOWN_STATUS, code: 'shutting_down', error: 'The instance is shutting down and starts no triple index rebuild' };
  }
  if (outcome === 'busy') {
    return { ok: false, status: REBUILD_REFUSED_STATUS, code: 'rebuild_busy',
      error: `The triple index of space '${peerText(spaceId)}' is being rebuilt by another instance: its build holds the build row. Poll space_rdf_index, or ask again when it has ended` };
  }
  return { ok: false, status: REBUILD_REFUSED_STATUS, code: 'rdf_off', error: `Space '${peerText(spaceId)}' has RDF off or names that are not settled, so it has no triple index to rebuild` };
}

/** A failed rebuild the door started is said once per window and space. */
const rebuildFailed = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });
