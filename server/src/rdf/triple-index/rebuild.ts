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
 *    id and form, `appliedPos` one below the cap read at the start, `catching-up`; and deletes the journal rows marked as this build's. The
 *    build's collections are then renamed onto the live names, the read indexes are built on them, and the status is set `ready`.
 *
 * ## What it prevents
 *
 * - **A query reading half of two builds (finding F5).** A query pins the build id it read (`read.ts`) and checks it at its end; the id
 *   changes in the swap's first transaction, before any collection is renamed, so a query that read across the swap reads its records again.
 * - **A write lost to the swap.** A positioned write above the start's cap is applied by the follower after the swap (`appliedPos` is
 *   below it); a journaled write not done at the start keeps its row, which the follower clears after the swap. While a build runs the
 *   follower clears no journal row (`store.ts`), so no change is cleared from the journal after the build read its record.
 * - **Two builds.** One build row, one holder; a late batch of a build that lost it is refused by the fence.
 */
import { randomBytes } from 'node:crypto';
import type { Document } from 'mongodb';
import { getDb, col, asFilter, asUpdate } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { inBoundedTransaction } from '../../db/bounded-transaction.js';
import { idKeysetPage } from '../../db/id-keyset-page.js';
import { buildSpaceIndex, TRIPLE_INDEX_INDEXES } from '../../spaces/space-indexes.js';
import { settledPositionCap } from '../../util/position-clock.js';
import { recordPositions } from '../../sync/record-position-stream.js';
import { log, outsideRequest, peerText } from '../../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../../util/warn-once.js';
import { detachedWrite } from '../../db/write-bound.js';
import { RDF_KIND_COLLECTIONS } from '../rdf-members.js';
import type { RdfRecordKind } from '../record-triples.js';
import {
  applyRecordChanges, buildCollectionsOf, claimTripleIndexBuild, fenceTripleIndexBuild, formKeyOf, liveCollections, readTripleIndexState,
  releaseTripleIndexBuild, releaseTripleIndexLease, runningTripleIndexBuild, setBuiltStatus, takeTripleIndexLease, writeBuiltState,
  RebuildFenced, type IndexCollections, type RecordChange, type TripleIndexStatus,
} from './store.js';
import { formMetaOf, projectionOf, statementsOf } from './follow.js';

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

/** What a rebuild did: `built` (swapped in), `busy` (another build holds the row), `no-form` (RDF off or unsettled), `form-changed`. */
export interface RebuildResult { outcome: 'built' | 'busy' | 'no-form' | 'form-changed'; buildId?: string; records?: number }

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
  const startCap = await settledPositionCap(recordPositions, spaceId);
  const startedAt = Date.now();
  await col<Document>(spaceCollection(spaceId, 'rdfDirty')).updateMany(asFilter<Document>({ done: true, at: { $lte: startedAt } }), asUpdate<Document>({ $set: { seenBy: buildId } }));
  return { spaceId, buildId, formKey: formKeyOf(meta), startCap, startedAt, leaseMs, target: buildCollectionsOf(spaceId, buildId) };
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
  try {
    for (let i = 0; i < SWAP_LEASE_TRIES && !leased; i++) {
      leased = await takeTripleIndexLease(spaceId, owner, build.leaseMs);
      if (!leased) await new Promise(resolve => setTimeout(resolve, SWAP_LEASE_WAIT_MS));
    }
    if (!leased) throw new Error(`the triple index of space '${spaceId}' could not take the follower's lease for its swap`);
    await inBoundedTransaction(async (session) => {
      await fenceTripleIndexBuild(spaceId, buildId, build.leaseMs, session);
      await writeBuiltState(spaceId, { appliedPos: Math.max(0, build.startCap - 1), formKey: build.formKey, status: 'catching-up', buildId }, session);
      await col<Document>(spaceCollection(spaceId, 'rdfDirty')).deleteMany(asFilter<Document>({ seenBy: buildId }), { session });
    });
    const live = liveCollections(spaceId);
    for (const part of ['terms', 'quads', 'records'] as const) {
      await ensureCollection(build.target[part]);
      await getDb().renameCollection(build.target[part], live[part], { dropTarget: true });
    }
    for (const ix of TRIPLE_INDEX_INDEXES) await buildSpaceIndex(spaceId, ix);
    await inBoundedTransaction(async (session) => {
      await fenceTripleIndexBuild(spaceId, buildId, build.leaseMs, session);
      await setBuiltStatus(spaceId, buildId, 'ready', session);
    });
  } catch (err) {
    await dropBuildCollections(build);
    throw err;
  } finally {
    if (leased) await releaseTripleIndexLease(spaceId, owner);
    await releaseTripleIndexBuild(spaceId, buildId);
  }
}

/** Create `name` when no write has (a space whose records state nothing has no rows), so a rename finds it. */
async function ensureCollection(name: string): Promise<void> {
  const exists = (await getDb().listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) await getDb().createCollection(name);
}

/** Drop the collections of a build that ended without a swap (or after one: a renamed collection is gone already). */
async function dropBuildCollections(build: TripleIndexBuild): Promise<void> {
  for (const name of Object.values(build.target)) {
    await getDb().collection(name).drop().catch(() => false);
  }
}

/** Rebuild `spaceId`'s index whole: begin, fill, swap (see the module docblock). */
export async function rebuildTripleIndex(spaceId: string, opts: { leaseMs?: number } = {}): Promise<RebuildResult> {
  if (formMetaOf(spaceId) === null) return { outcome: 'no-form' };
  const build = await beginTripleIndexBuild(spaceId, opts);
  if (build === null) return { outcome: formMetaOf(spaceId) === null ? 'no-form' : 'busy' };
  try {
    const records = await fillTripleIndexBuild(build);
    await swapTripleIndexBuild(build);
    log.info(`Triple index of space '${peerText(spaceId)}': rebuilt from ${records} record(s) (build ${build.buildId})`);
    return { outcome: 'built', buildId: build.buildId, records };
  } catch (err) {
    await releaseTripleIndexBuild(spaceId, build.buildId);
    if (err instanceof FormChanged) return { outcome: 'form-changed' };
    throw err;
  }
}

/** Per space: the rebuild this process runs now, which every caller arriving meanwhile shares. */
const running = new Map<string, Promise<RebuildResult>>();

/**
 * Rebuild `spaceId`'s index once in this process: a call while one runs shares it. What the upkeep job and the admin door call. Resolves
 * with its result, rejects with its failure.
 */
export function requestTripleIndexRebuild(spaceId: string): Promise<RebuildResult> {
  const now = running.get(spaceId);
  if (now) return now;
  const run = rebuildTripleIndex(spaceId).finally(() => { if (running.get(spaceId) === run) running.delete(spaceId); });
  running.set(spaceId, run);
  return run;
}

/** Whether this process runs a rebuild of `spaceId` now. */
export const rebuildRunsHere = (spaceId: string): boolean => running.has(spaceId);

/** The status of one space's index, as the admin door reads it (`space_rdf_index`). */
export interface TripleIndexStatusView {
  spaceId: string;
  /** `absent`: no index (RDF off, or never started); otherwise its state row's status. */
  status: TripleIndexStatus | 'absent';
  /** The build the live index came from (`null`: none, or one the follower started and no rebuild wrote). */
  buildId: string | null;
  appliedPos: number | null;
  /** A rebuild holds the build row now (in this process or another). */
  rebuilding: boolean;
}

/** The status of `spaceId`'s index now. */
export async function tripleIndexStatusOf(spaceId: string): Promise<TripleIndexStatusView> {
  const state = await readTripleIndexState(spaceId);
  const building = rebuildRunsHere(spaceId) || (await runningTripleIndexBuild(spaceId)) !== null;
  return { spaceId, status: state?.status ?? 'absent', buildId: state?.buildId ?? null, appliedPos: state?.appliedPos ?? null, rebuilding: building };
}

/** What the admin door's start answers: started (or one runs already), or refused because the space has no RDF form now. */
export type RebuildStart = { ok: true; status: 'started' | 'running'; spaceId: string } | { ok: false; status: 409; code: 'rdf_off'; error: string };

/**
 * Start a rebuild of `spaceId`'s index in the background (the admin door): answered at once, the rebuild runs outside the request that
 * asked for it, each of its operations bounded as a detached write. A space with RDF off or unsettled names is refused.
 */
export function startTripleIndexRebuild(spaceId: string): RebuildStart {
  if (formMetaOf(spaceId) === null) {
    return { ok: false, status: 409, code: 'rdf_off', error: `Space '${peerText(spaceId)}' has RDF off or names that are not settled, so it has no triple index to rebuild` };
  }
  const already = rebuildRunsHere(spaceId);
  outsideRequest(() => {
    detachedWrite(() => requestTripleIndexRebuild(spaceId)).catch((err: unknown) => rebuildFailed(spaceId,
      () => log.warn(`Triple index of space '${peerText(spaceId)}': the rebuild an admin started failed: ${peerText(String(err))}`)));
  });
  return { ok: true, status: already ? 'running' : 'started', spaceId };
}

/** A failed rebuild the door started is said once per window and space. */
const rebuildFailed = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });
