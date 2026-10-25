/**
 * Every index a space's collections carry, declared ONCE, and the one way each is built (bundle-101, `Q-445`).
 *
 * ## What it prevents
 *
 * A space's indexes were built at fifteen sites in nine files, with four failure policies between them: `initSpace` built most of
 * them by hand, the background pass (`ensureQueryIndexes`) a different subset, the TTL sweep its own three, and the job, tombstone,
 * keyset and edge modules a part each. A restore that "builds every index" built whichever of those it remembered, which is how a
 * restored space came back without its TTL indexes (the sweep then read `_expireAt` by a collection scan until the next boot), and
 * how a unique index whose build failed was answered as `edgeIndexes: { failed: [] }` whatever happened. A new index added to one
 * site and not the others is the same defect arriving later.
 *
 * So {@link SPACE_INDEXES} is the list, and every builder reads it: `initSpace` (its boot-safe part at every boot, all of it for a
 * collection created now), the background pass (all of it, one unit per index), the restore (all of it, on the empty collections it
 * creates, then {@link assertUniqueIndexesStand}), the TTL sweep and a retention change ({@link ensureTtlIndexes}). No other module
 * calls `createIndex` on a space's collection except through a builder this one names (`buildKeysetIndex`, `ensureEdgeGuardIndex`),
 * and `every-per-space-index-build-reads-the-declaration` holds that.
 *
 * ## What an entry says
 *
 * - `part`, `keys`, `options`: the index, as `createIndex` takes it. An entry without `options.name` gets the store's own name.
 * - `policy`: what a failed build does where it can stop something - `throw` (the caller fails: the space does not initialise, the
 *   restore is tried again), `report` (said through the shared reporter with the space and the index named, and the caller goes on)
 *   or `best-effort` (a warning, and the caller goes on; what the space does without it is the entry's `withoutIt`). The background
 *   pass isolates every index whatever its policy: it has no caller to stop, so a failure there is always a named unit.
 * - `bootSafe`: built by `initSpace` at every boot on a collection that already exists. `false` for an index whose build reads the
 *   whole collection (the keyset compounds, the write guard, the TTL indexes): `initSpace` runs before the server listens, so such a
 *   build over a large collection is a boot that does not finish. Those are built for a collection created now (it is empty) and by
 *   the background pass. **An entry that does not say is NOT boot-safe**: the safe default for an index added later, and every index
 *   that existed before this declaration says so explicitly (`every-pre-existing-space-index-says-whether-it-is-boot-safe`).
 * - `builder`: an index whose build is more than `createIndex` - the keyset compounds (built, confirmed, and only then the bare
 *   `{ seq: 1 }` they replace dropped: `spaces/keyset-indexes.ts`), the write guard (a build over duplicate markers thins them
 *   and tries again: `spaces/edge-guard-index.ts`) and the edge identity (the partial unique index that replaces the full one: built beside
 *   it, confirmed, and only then the full one dropped, on a collection with no edge in it; one with edges is the owed job's:
 *   `spaces/edge-identity-index.ts`, `spaces/edge-identity-owed.ts`).
 *
 * ## What it does not cover
 *
 * Instance-wide collections (the audit log, the read spills, the webhook queue, the activity buckets) are not a space's and are
 * built by their own modules; the vector search indexes are search indexes, reconciled by `spaces/search-index-presence.ts`.
 */
import type { Document } from 'mongodb';
import { col } from '../db/mongo.js';
import { indexNamesOf } from '../db/index-names.js';
import { boundOperationMs, housekeepingOpMs } from '../db/write-bound.js';
import { StoreTimeout } from '../db/write-timeout.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { withinTimeBound, isTimeBoundEnded } from '../util/time-bound.js';
import { spaceCollection, SPACE_COLLECTIONS, type SpacePart } from '../db/space-collection.js';
import { log, peerText } from '../util/log.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { eachUnitOfSpace } from '../util/housekeeping-walk.js';
import { warnOnce } from '../util/warn-once.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { SEQ_KEYSET_INDEXES } from '../util/seq-keyset.js';
import { SEQ_CARRYING } from '../util/seq.js';
import { COLLECTION_SUFFIX } from '../config/types-knowledge.js';
import { buildKeysetIndex, type KeysetBuild } from './keyset-indexes.js';
import { EDGE_GUARD_INDEXES, ensureEdgeGuardIndex } from './edge-guard-index.js';
import {
  EDGE_IDENTITY_INDEX, EDGE_FROM_INDEX, ensurePartialEdgeIdentity, buildPartialEdgeIdentity, confirmPartialEdgeIdentity, dropFullEdgeIdentity,
  edgeIdentityState, edgesHoldNoRow, someEdgeIdentityStands,
} from './edge-identity-index.js';
import { VECTOR_INDEXED_COLLECTIONS } from './vector-index.js';
import { LINK_INDEXES } from '../brain/link-adjacency.js';
import { FORK_INDEXES, FORKING_FAMILIES } from '../sync/upsert-plan.js';
import { TTL_COLLECTIONS } from '../brain/ttl.js';
import { MEDIA_JOB_INDEXES } from '../files/media/job-queue.js';
import { EMBED_JOB_INDEXES } from '../brain/embed-queue.js';
import { FILE_TOMBSTONE_INDEXES, FILE_TOMBSTONE_PART } from '../files/tombstones.js';

/** What a failed build of an index does where it can stop something. See the module header. */
export type SpaceIndexPolicy = 'throw' | 'report' | 'best-effort';

/** The options a space index is built with: the ones that decide WHICH index it is, and nothing else. */
export interface SpaceIndexOptions {
  readonly name?: string;
  readonly unique?: boolean;
  readonly sparse?: boolean;
  readonly partialFilterExpression?: Document;
}

/** One declared index of a space's collection. See the module header for each field. */
export interface SpaceIndex {
  readonly part: SpacePart;
  readonly keys: Readonly<Record<string, 1 | -1 | 'text'>>;
  readonly options: SpaceIndexOptions;
  readonly policy: SpaceIndexPolicy;
  readonly bootSafe?: boolean;
  /** The index is built by a builder of its own rather than by a plain `createIndex`. */
  readonly builder?: 'keyset' | 'guard' | 'edge-identity';
  /** For a `best-effort` index: what the space does while it is missing, in the warning's words. */
  readonly withoutIt?: string;
  /** The index keeps the TTL sweep's queries cheap: built again by the sweep until it stands ({@link ensureTtlIndexes}). */
  readonly sweep?: true;
}

/**
 * `{ from: 1 }` on the edges: the partial identity index serves only a read that names `forkOf: null`, and the full one it replaces served every
 * `from`-prefixed read through its prefix (`edgesOfRecord`, the entity delete guard, the Brain lists). The swap drops the full index only once this stands
 * (`dropFullEdgeIdentity`). Not boot-safe: the build reads every edge. `report`: a space without it scans, slowly and correctly, and keeps its full identity index.
 */
const EDGE_FROM_ENTRY: SpaceIndex = { part: 'edges', keys: EDGE_FROM_INDEX.keys, options: { ...EDGE_FROM_INDEX.options }, policy: 'report', bootSafe: false };

/** An index every builder runs the same way: `throw` and built at every boot. */
const plain = (part: SpacePart, keys: SpaceIndex['keys'], options: SpaceIndexOptions = {}): SpaceIndex =>
  ({ part, keys, options, policy: 'throw', bootSafe: true });

/** The options of an entry declared elsewhere as `{ unique?, sparse? }`, without a key set to `undefined` (which the driver sends). */
const declaredOptions = (o: { unique?: boolean; sparse?: boolean }): SpaceIndexOptions =>
  ({ ...(o.unique ? { unique: true } : {}), ...(o.sparse ? { sparse: true } : {}) });

/**
 * The TTL sweep's indexes: plain (not `expireAfterSeconds`) indexes over the retention stamps, which only keep the sweep's queries
 * cheap - the sweep deletes through the normal delete path so the deletion tombstones and replicates. Sparse, so a space that sets
 * no retention carries empty ones. `report`: a space without them is swept by a collection scan, which is slow and still correct.
 */
const TTL_INDEXES: readonly SpaceIndex[] = [
  ...TTL_COLLECTIONS.map((part): SpaceIndex => ({
    part, keys: { _expireAt: 1 }, options: { name: 'ttl_expireAt', sparse: true }, policy: 'report', bootSafe: false, sweep: true,
  })),
  // Chrono only: the content-redaction pass has its own sweep query, and without an index it would scan the whole collection
  // every cycle on a space that never uses the feature.
  { part: 'chrono', keys: { _contentExpireAt: 1 }, options: { name: 'ttl_contentExpireAt', sparse: true }, policy: 'report', bootSafe: false, sweep: true },
  // Files only: the flagged-row repair (`stripFlaggedRowsOnce`) and the purge of deleted files' audit records (`flaggedPage`)
  // both ask `deletedAt: { $exists: true }` of every space every cycle. Sparse, so it holds the deleted files' records alone.
  { part: 'files', keys: { deletedAt: 1 }, options: { name: 'ttl_deletedAt', sparse: true }, policy: 'report', bootSafe: false, sweep: true },
];

/** The `(pos, _id)` index of one collection the position stream covers: see the comment where {@link SPACE_INDEXES} spreads it. */
const positionIndexOf = (part: SpacePart): SpaceIndex => ({ part, keys: { pos: 1, _id: 1 }, options: {}, policy: 'report', bootSafe: false });

/**
 * THE declaration of every per-space index, in the order `initSpace` builds them.
 *
 * Each group says the question its indexes answer; the lists declared beside their queries (`SEQ_KEYSET_INDEXES`, `LINK_INDEXES`,
 * `FORK_INDEXES`, `EDGE_GUARD_INDEXES`, the job and file tombstone lists) are read here, never copied.
 */
export const SPACE_INDEXES: readonly SpaceIndex[] = Object.freeze([
  // The seq keyset compounds: the sync pages, the push and the scanners read records in `(seq, _id)` order. Not boot-safe: a
  // compound over a large existing collection is the background pass's, which drops the bare `{ seq: 1 }` once it is confirmed.
  ...SEQ_KEYSET_INDEXES.map((ix): SpaceIndex => ({ part: ix.part, keys: ix.keys, options: {}, policy: 'throw', bootSafe: false, builder: 'keyset' })),
  /*
   * The position compound `(pos, _id)` on every collection the position stream covers (`SEQ_CARRYING`: the record collections and the tombstones),
   * and NOT PARTIAL (bundle-81, design rev 8 §3 step 7). The sync pages read after a position, every Brain list defaults to `LANDING_ORDER` (`pos` then `_id`,
   * descending), the fresh-write scan sorts by `pos` with no `$match`, and the carry looks up `pos: null`. MongoDB uses a PARTIAL index only for a query that
   * names its predicate, and none of these does, so a partial one would be ignored: each read would scan and sort a whole collection, and the fresh-write scan
   * swallows the sort-memory failure and answers `[]`. A non-partial index serves every `pos` sort and range (a row without `pos` indexes as null: last in a
   * descending read, outside every `afterPos` range). Non-unique: the legacy band has ties by nature (relayed rows share seqs), and the keyset takes them.
   * Not boot-safe: a build over a large existing collection reads every row, so it is the background pass's. `report`: a space without it is read by a scan that
   * is slow and correct, said through the shared reporter and tried again; `every-position-read-is-index-served-db` holds every reader to it.
   */
  ...SEQ_CARRYING.map((part): SpaceIndex => positionIndexOf(part)),
  plain('facts', { tags: 1 }),
  // The fork caps' indexes (`sync/upsert-plan.ts`), on the collection of EVERY family that forks. The facts one is as old as fact forks and is built at every
  // boot, as it was; the others are new on collections that may be large, so on an existing one they are the background pass's (built at init on a new one).
  ...FORKING_FAMILIES.flatMap(part => FORK_INDEXES.map((ix): SpaceIndex => ({ ...plain(part, ix.keys, declaredOptions(ix)), bootSafe: part === 'facts' }))),
  // `{ type: 1 }` on the four record collections. MEASURED, not assumed: every list endpoint exposes a `type` filter and `total`
  // counts with it, and `explain()` on a live instance returned COLLSCAN for `{type: …}` on facts, entities, edges and chrono.
  // Entities looked covered by `{ name: 1, type: 1 }` and are not: `type` is not a prefix of it. Quality-neutral by construction:
  // the same documents in the same order, only the plan changes. NOT ALL BRAIN COLLECTIONS, and two are missing for two different
  // reasons: `files` has no `type` field (a file's kind is its path and its media handling), and `links` cannot get one (a link's
  // kind IS its two endpoint kinds, which its unique index already covers). The four, from the map that defines them.
  ...Object.values(COLLECTION_SUFFIX).map(part => plain(part, { type: 1 })),
  plain('entities', { name: 1, type: 1 }),
  /*
   * The edges' identity: unique over `(from, to, label, fromKind, toKind)` OVER THE ROWS WHOSE `forkOf` IS NULL OR ABSENT (Q-624: a fork edge shares its subject's
   * five fields and sits outside the slot), the guarantee `edgeIdFor` derives an id from. NOT boot-safe and still `throw`: a new or empty collection is built here by
   * `initSpace` (the swap is free, and a failure is a space with no unique identity, which does not initialise); a collection with edges still on the full index is the
   * owed job's (`spaces/edge-identity-owed.ts`), which keeps the full index until the partial one is confirmed. The reader of the readiness is `edgeIdentityAdmitsForks`.
   *
   * `fromKind` and `toKind` joined the key in M-3: each collection assigns its own UUIDs, so a fact and an entity may hold the same
   * id, and `(X, Y, mentions)` with Y an entity and the same triplet with Y a fact are two relationships with two ids. Safe on an
   * existing collection: an entity endpoint stores nothing (`storedEdgeKind`), Mongo indexes a missing field as null, and every
   * edge written before M-1 keys as `(from, to, label, null, null)`, exactly what a new ordinary edge keys as. `initSpace` drops
   * the three-field index it replaced first (`dropSupersededEdgeIdentityIndex`), or that one would keep refusing the rows this allows.
   */
  EDGE_FROM_ENTRY,
  { part: 'edges', keys: EDGE_IDENTITY_INDEX.keys, options: { ...EDGE_IDENTITY_INDEX.options }, policy: 'throw', bootSafe: false, builder: 'edge-identity' },
  /*
   * The write guard of a strict functional label (`Q-439`), declared with its options in `EDGE_GUARD_INDEXES` and built through
   * `ensureEdgeGuardIndex`, which thins duplicate markers. Not boot-safe: the build reads every edge. `report`: a space whose
   * markers cannot be indexed is a space without a race guard, said and counted, never a space that does not initialise; the
   * planner's count still refuses a second edge under the label. A RESTORED edge arrives without its marker by design (`Q-439`,
   * `sync/arrivals.ts`), so the guard covers a subject once its edge is rewritten; the write-time count refuses meanwhile.
   */
  ...EDGE_GUARD_INDEXES.map((ix): SpaceIndex => ({ part: 'edges', keys: ix.keys, options: ix.options, policy: 'report', bootSafe: false, builder: 'guard' })),
  // `{ from: 1 }` above serves `from` and leaves `to` unindexed: "which entities does the graph touch" scanned
  // the inbound half. Completeness' unlinked-entity join asks it per entity; traversal per hop.
  plain('edges', { to: 1 }),
  plain('chrono', { startsAt: 1 }),
  plain('chrono', { status: 1 }),
  /*
   * Link records (`M-2`). The unique index is the deduplication: a link is `(from, fromKind, to, toKind)` and nothing else, so two
   * peers that notice the same connection wrote the same fact, and the second write is a duplicate rather than a fork. Both
   * directions are indexed because both are asked: what does this record concern, and what concerns this entity (the backlink scan
   * that blocks a delete). A space whose links collection came from the 4.x conversion's first insert had none of them, which is
   * why the background pass builds them too.
   */
  ...LINK_INDEXES.map(ix => plain('links', ix.keys, declaredOptions(ix))),
  plain('conflicts', { detectedAt: -1 }),
  // The list query: equality on `status`, sorted by score then recency.
  plain('dupeCandidates', { status: 1, score: -1, detectedAt: -1 }),
  // The Review list's query exactly (`.sort({ confidence: -1, detectedAt: -1 })` under a status filter), and the type filter of
  // the Review tab, which the per-type wipe deletes by.
  plain('contradictionCandidates', { status: 1, confidence: -1, detectedAt: -1 }),
  plain('contradictionCandidates', { type: 1 }),
  plain('files', { tags: 1 }),
  plain('files', { updatedAt: -1 }),
  // Chunk records point at their file through `parentFileId`: the chunk-grouping reads and completeness' "was this file chunked".
  plain('files', { parentFileId: 1 }),
  // The face gallery reads the LABELLED faces' ids (Q-102, `gallerySearch`). Partial: the few labelled faces and nothing else.
  plain('files', { faceEntityId: 1 }, { partialFilterExpression: { faceEntityId: { $exists: true } } }),
  // The media and embed job queues, polled every second per space: declared beside the queries they serve.
  ...MEDIA_JOB_INDEXES.map(keys => plain('mediaJobs', keys)),
  ...EMBED_JOB_INDEXES.map(keys => plain('embedJobs', keys)),
  // The file tombstones' settle, move-marker, per-path and paged questions (bundle-30 I16, bundle-51), declared in `files/tombstones.ts`.
  ...FILE_TOMBSTONE_INDEXES.map(ix => plain(FILE_TOMBSTONE_PART, ix.keys, ix.options)),
  /*
   * The lexical half of hybrid search (`brain/lexical-search.ts`), on `matchedText` ONLY: the exact pre-embedding string, so the
   * lexical channel reads precisely the text the vector channel embedded. MongoDB allows ONE text index per collection, so this
   * field choice is load-bearing. Best effort: a collection may carry a differently-shaped text index from a later release, and
   * retrieval degrades to vector-only on its own while it is absent.
   */
  ...VECTOR_INDEXED_COLLECTIONS.map((part): SpaceIndex => ({
    part, keys: { matchedText: 'text' }, options: { name: 'lexical_text' }, policy: 'best-effort', bootSafe: true,
    withoutIt: 'hybrid search falls back to vector-only for it',
  })),
  ...TTL_INDEXES,
]);

/**
 * The indexes the carry and the repair of a space's positions READ through: the `(seq, _id)` keyset compounds that chunk them, and the `(pos, _id)`
 * compounds that find rows without a position and serve every position read (`sync/positions-owed.ts`: built before any row is touched, retried by the
 * owed job every tick while one is missing).
 */
export const POSITION_WORK_INDEXES: readonly SpaceIndex[] = SPACE_INDEXES.filter(ix => ix.builder === 'keyset' || 'pos' in ix.keys);

/** The TTL sweep's part of {@link SPACE_INDEXES}. */
export const SWEEP_INDEXES: readonly SpaceIndex[] = SPACE_INDEXES.filter(ix => ix.sweep === true);

/** The step a failed build is said under where no walk is above it (`initSpace`, a retention change). */
export const SPACE_INDEX_STEP = declareStep('Space indexes');

/** The name the store gives the index: `options.name`, or `<field>_<dir>` joined by `_`. */
export const spaceIndexName = (ix: SpaceIndex): string => ix.options.name ?? Object.entries(ix.keys).map(([k, v]) => `${k}_${v}`).join('_');

/** The words that name one index in a line, a unit or an error: `index <name> on <collection suffix>`. */
export const spaceIndexUnit = (ix: SpaceIndex): string => `index ${spaceIndexName(ix)} on ${SPACE_COLLECTIONS[ix.part]}`;

/**
 * Build one declared index on one space. Idempotent: an index already there is a no-op. Throws what the build threw; the policy is
 * the caller's to apply. Answers what a keyset build did (for the background pass's line), nothing for the others.
 */
export async function buildSpaceIndex(
  spaceId: string, ix: SpaceIndex, hooks: { onKeysetBuild?: () => void } = {},
): Promise<KeysetBuild | undefined> {
  if (ix.builder === 'keyset') return buildKeysetIndex(spaceId, { part: ix.part, keys: ix.keys as Readonly<Record<string, 1>> }, { onBuild: hooks.onKeysetBuild });
  if (ix.builder === 'guard') { await ensureEdgeGuardIndex(spaceId); return undefined; }
  if (ix.builder === 'edge-identity') { await buildEdgeIdentityIndex(spaceId); return undefined; }
  await col(spaceCollection(spaceId, ix.part)).createIndex({ ...ix.keys }, { ...ix.options });
  return undefined;
}

/**
 * The edge identity swap as the owed job and the build run it: `{ from: 1 }` first (declared above, built by the one builder), then the three steps
 * (`ensurePartialEdgeIdentity`). Idempotent; a swap that stopped anywhere is finished by running it again.
 */
export async function swapEdgeIdentity(spaceId: string): Promise<void> {
  await buildSpaceIndex(spaceId, EDGE_FROM_ENTRY);
  await ensurePartialEdgeIdentity(spaceId);
}

/**
 * What a BUILD of the edge identity does (the declaration's builder), by what the collection holds:
 *  - no edge at all: the swap, which is free (the full index, on an existing empty collection, is dropped only once `{ from: 1 }` stands: the owed job's otherwise);
 *  - edges, and a unique identity index of either kind standing: nothing - the full one is swapped by the owed job (the background pass never does it), and the
 *    partial one is done;
 *  - edges and neither standing: the partial index, which throws over duplicates (a restore's check must say so).
 */
async function buildEdgeIdentityIndex(spaceId: string): Promise<void> {
  if (await edgesHoldNoRow(spaceId)) {
    await buildPartialEdgeIdentity(spaceId);
    await confirmPartialEdgeIdentity(spaceId);
    // A full index on an EMPTY existing collection goes only once `{ from: 1 }` stands. `{ from: 1 }` is a `report` index, so a refused build of it must not stop the
    // space initialising (this one is `throw`): uniqueness holds with both standing, and the owed job drops the full index once `{ from: 1 }` is there.
    const s = await edgeIdentityState(spaceId);
    if (!s.full || s.from) await dropFullEdgeIdentity(spaceId);
    return;
  }
  if (!(await someEdgeIdentityStands(spaceId))) await buildPartialEdgeIdentity(spaceId);
}

/** A failed build of an index whose policy is `throw`, naming the index and the space; the store's error is its `cause`. */
export class SpaceIndexNotBuilt extends Error {
  constructor(spaceId: string, ix: SpaceIndex, cause: unknown) {
    super(`${spaceIndexUnit(ix)} of space '${peerText(spaceId)}' was not built: ${peerText(cause)}`, { cause });
    this.name = 'SpaceIndexNotBuilt';
  }
}

/** What one build came to. */
export interface SpaceIndexOutcome {
  readonly index: SpaceIndex;
  readonly status: 'built' | 'failed' | 'skipped';
}

/**
 * `initSpace`'s run of the declaration: every boot-safe index, and every other one on a collection `isNew` says was created now
 * (it is empty, so the build is free). In declaration order; each failure is handled by its index's policy - `throw` stops the run
 * with {@link SpaceIndexNotBuilt}, `report` is said through the shared reporter and the run goes on, `best-effort` is a warning and
 * the run goes on.
 */
export async function buildSpaceIndexesAtInit(spaceId: string, isNew: (part: SpacePart) => boolean): Promise<SpaceIndexOutcome[]> {
  const outcomes: SpaceIndexOutcome[] = [];
  for (const ix of SPACE_INDEXES) {
    if (ix.bootSafe !== true && !isNew(ix.part)) { outcomes.push({ index: ix, status: 'skipped' }); continue; }
    try {
      await buildSpaceIndex(spaceId, ix);
      outcomes.push({ index: ix, status: 'built' });
    } catch (err) {
      if (ix.policy === 'throw') throw new SpaceIndexNotBuilt(spaceId, ix, err);
      if (ix.policy === 'report') reportSpaceFailure(SPACE_INDEX_STEP, spaceId, err, { unit: spaceIndexUnit(ix), when: 'next index pass' });
      else bestEffortMissing(spaceId, ix, err);
      outcomes.push({ index: ix, status: 'failed' });
      continue;
    }
    if (ix.policy === 'best-effort') bestEffortStands(spaceId, ix);
  }
  return outcomes;
}

/** The best-effort indexes said missing, by space and index: said once while missing, and again after one stood and went. */
const bestEffortSaid = warnOnce<string>();
const bestEffortKey = (spaceId: string, ix: SpaceIndex): string => `${spaceId}\u0000${ix.part}\u0000${spaceIndexName(ix)}`;

/**
 * Say a `best-effort` index that was not built: a warning naming the space and the index and what the space does without it, once
 * while it stays missing. Never a space failure, wherever it is built (`initSpace` or the background pass): the space works without
 * it, so a counted failure at every boot would be an alarm about a decision. A store that stopped answering is not the index's
 * failure: it is RETHROWN (`storeIsNotAnswering`), so the caller - inside a walk, the walk's verdict - hears it.
 */
function bestEffortMissing(spaceId: string, ix: SpaceIndex, err: unknown): void {
  // The store not answering is not the index's failure: it goes to the caller (inside a walk, the walk's verdict), whatever comes
  // after this index in the declaration, and it does not use up the warning a real refusal of the index needs.
  if (storeIsNotAnswering(err)) throw err;
  bestEffortSaid(bestEffortKey(spaceId, ix), () => log.warn(`Space '${peerText(spaceId)}': ${peerText(spaceIndexUnit(ix))} not built`
    + `${ix.withoutIt ? ` - ${peerText(ix.withoutIt)}` : ''} (${peerText(err)})`));
}

/**
 * Forget what this module said about a space: its best-effort warnings. Called when the space is deleted (`commitSpaceDeletion`), so
 * a deleted space keeps no slot, and a space created again under its id is warned about afresh.
 */
export function forgetSpaceIndexWarnings(spaceId: string): void {
  for (const ix of SPACE_INDEXES) if (ix.policy === 'best-effort') bestEffortSaid.forget(bestEffortKey(spaceId, ix));
}

/** A best-effort index stood: the next time it is missing is news. */
function bestEffortStands(spaceId: string, ix: SpaceIndex): void {
  bestEffortSaid.forget(bestEffortKey(spaceId, ix));
}

/**
 * Build `indexes` on one space, each its own unit (`eachUnitOfSpace`): a failure is said with the index named and the rest are
 * built; a store that stopped answering ends the run. Inside a walk of this space it is the walk's unit loop and step. A
 * `best-effort` index that is not built is not a unit failure: it is said once as a warning ({@link bestEffortMissing}).
 */
export function buildSpaceIndexUnits(
  spaceId: string, indexes: readonly SpaceIndex[], hooks: { onBuilt?: (ix: SpaceIndex, keyset: KeysetBuild | undefined) => void; onKeysetBuild?: () => void } = {},
): Promise<{ failed: { unit: string; reason: string }[] }> {
  return eachUnitOfSpace(spaceId, SPACE_INDEX_STEP, indexes, async (ix) => {
    let keyset: KeysetBuild | undefined;
    try {
      keyset = await buildSpaceIndex(spaceId, ix, { ...(hooks.onKeysetBuild ? { onKeysetBuild: hooks.onKeysetBuild } : {}) });
    } catch (err) {
      if (ix.policy !== 'best-effort') throw err;
      bestEffortMissing(spaceId, ix, err);
      return;
    }
    if (ix.policy === 'best-effort') bestEffortStands(spaceId, ix);
    hooks.onBuilt?.(ix, keyset);
  }, spaceIndexUnit);
}

/**
 * The TTL sweep's indexes on one space ({@link SWEEP_INDEXES}) that are not there now, each built as its own unit; answers which
 * did not build. Run by the sweep at every tick and by a retention change.
 *
 * It LOOKS before it builds - one `listIndexes` per collection the sweep indexes, and only a missing index is built - so it is cheap
 * enough to ask every tick of every space, and nothing remembers that a space "had" them. A remembered answer is what this
 * prevents: a restore drops and creates every collection of a space that stays configured, and when its sweep builds then fail
 * (policy `report`, so the restore completes) a space remembered as indexed was never looked at again until the next boot.
 */
export async function ensureTtlIndexes(spaceId: string): Promise<{ failed: { unit: string; reason: string }[] }> {
  const present = new Map<SpacePart, readonly string[]>();
  for (const part of new Set(SWEEP_INDEXES.map(ix => ix.part))) present.set(part, await indexNamesWithinBound(spaceCollection(spaceId, part)));
  const missing = SWEEP_INDEXES.filter(ix => !(present.get(ix.part) ?? []).includes(spaceIndexName(ix)));
  if (missing.length === 0) return { failed: [] };
  return buildSpaceIndexUnits(spaceId, missing);
}

/**
 * The names of a collection's indexes, waited for at most one operation's figure: the enclosing bound's (`boundOperationMs`, a
 * walk's per-operation figure) or the housekeeping one. A wait that ends is a {@link StoreTimeout}, so a walk judges it like any
 * operation that ran past its bound (the space times out; the store is pinged before the walk is stopped).
 *
 * Why it is bounded when the index calls are not (`db/write-bound.ts`): a listing is metadata, whatever the size of the collection,
 * so one figure is right for it - and the sweep lists every space's indexes at every tick, so one space whose listing hangs held the
 * tick and, through the job's single flight, every later one: retention stopped for every space. The builds stay unbounded.
 */
async function indexNamesWithinBound(collName: string): Promise<string[]> {
  const ms = boundOperationMs() ?? housekeepingOpMs();
  const what = `listing the indexes of ${collName}`;
  try {
    return await withinTimeBound(indexNamesOf(collName), ms, what);
  } catch (err) {
    if (isTimeBoundEnded(err)) throw new StoreTimeout(what, { cause: err });
    throw err;
  }
}

/**
 * The restore's check that every declared UNIQUE index stands on the restored space, before its hold lifts: each is built again
 * (idempotent), and every one that does not stand is named in ONE plain error - not an input failure, so the act stays owed and
 * is tried again, and the space stays held. A unique index is what refuses duplicates; a space restored without one would take
 * them from the first write after the hold.
 */
export async function assertUniqueIndexesStand(spaceId: string): Promise<void> {
  const failed: string[] = [];
  for (const ix of SPACE_INDEXES) {
    if (ix.options.unique !== true) continue;
    try { await buildSpaceIndex(spaceId, ix); }
    catch (err) { failed.push(`${spaceIndexUnit(ix)} (${peerText(err)})`); }
  }
  if (failed.length > 0) {
    throw new Error(`the unique index(es) of space '${peerText(spaceId)}' did not stand after the restore, so its hold is kept and the restore is tried again: ${failed.join('; ')}`);
  }
}
