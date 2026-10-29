/**
 * Space lifecycle — init, create, remove, wipe, and pending-op crash recovery.
 *
 * Split out of spaces.ts (A17.7 step 2). Mutates live `Config` and coordinates with
 * `PendingSpaceOp` so a crash mid-create/remove/rename is reconciled on next boot — which is why
 * `reconcilePendingSpaceOp` lives here yet reaches into rename.ts: it recovers rename ops too.
 */
import fs from 'fs/promises';
import { BRAIN_COLLECTIONS, TOMBSTONE_TYPE_OF, type BrainCollection, type TombstoneType } from '../config/types.js';
import path from 'path';
import { getDb, col, asFilter } from '../db/mongo.js';
import { getConfig, saveConfig, mutateConfig, getEmbeddingConfig, getDataRoot } from '../config/loader.js';
import { ensureSpaceFilesDir } from '../files/files.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { log, peerList, peerText } from '../util/log.js';
import type { Config, SpaceConfig, FactDoc } from '../config/types.js';
import type { ParsedSpaceMeta } from './body-schemas.js';
import { VECTOR_INDEXED_COLLECTIONS, finalizeSpaceIndexReady, dropCollectionSearchIndexes } from './vector-index.js';
import { spaceActKnob } from './space-act-contract.js';
import { withinTimeBound } from '../util/time-bound.js';
import { armSearchIndexPresence, reconcileSpaceSearchIndexes, forgetSpaceSearchIndexWaiters } from './search-index-presence.js';
import { afterSearchUp, forgetSearchWaiter } from './search-readiness.js';
import { SPACE_COLLECTIONS, repairStaleSpaceIds, dropLegacyPrefixedIndexes, dropSupersededEdgeIdentityIndex, pendingOpConflictMessage, pendingOpStillFailingMessage, setReindexNeeded } from './_shared.js';
import {
  runSpaceAct, registerOwnSpaceAct, releaseSpaceActWaiter, defineSpaceActBody, spaceActRunning, SpaceActsClosedError, canonicalWipeTypes,
  type SpaceActRequest, type SpaceRoundSettled, type SpaceActBodyContext, type SpaceActBodyOutcome,
} from './space-act-runner.js';
import { moveSpaceData, applySpaceRenameToConfig } from './rename.js';
import { configuredSpaceIds } from './space-lookup.js';
import { assertNotRetiredSpaceId, unknownSpaceSentence } from './unknown-space.js';
import { dropSpaceFromViews } from '../config/views.js';
import { removeTree } from '../files/remove-tree.js';
import { unlabelAllFaces } from '../brain/entities.js';
import { forgetMerkleLeaves } from '../brain/merkle.js';
import { forgetSpaceShape } from '../brain/space-shape.js';
import { cancelEveryJobOfSpace } from '../files/media/job-queue.js';
import { dropReplacedFileTombstoneIndexes, forgetFileTombstonesOf } from '../files/tombstones.js';
import { forgetPathKeyedCache } from '../files/path-keyed-cache.js';
import { retireEmbedWorkOfRemovedRows } from '../files/file-embed-work.js';
import { buildSpaceIndexesAtInit, forgetSpaceIndexWarnings } from './space-indexes.js';
import { edgesHoldNoRow } from './edge-identity-index.js';
import { RECORD_TYPE_OF } from '../sync/replicated-families.js';
import { envInt } from '../config/env-num.js';
import { spaceCollection } from '../db/space-collection.js';
import { eachSpace, type WalkResult } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { trackSearchIndexDrop, settleSearchIndexDropsOf } from './search-index-drops-in-flight.js';
import { refusalText, storeFailureAnswer, throwIfStoreSide } from '../brain/store-failure.js';
import { grantCreatorAdmin } from '../auth/creator-grant.js';
import { createReadyCounter, finishPositionsOf } from '../sync/positions-owed.js';
import { forgetVersionMark } from '../util/version-mark.js';
import { builtInRefusal } from './built-in-space.js';
import { logInternalAudit } from '../audit/audit.js';
import { CREATOR_GRANT_OPERATION } from '../audit/middleware.js';

/**
 * Create a space's collections and indexes, and check what a boot checks of it. Runs for EVERY space at EVERY boot, before the
 * server listens, for a space created now, and for a restored one (whose collections were all dropped first, so each is created now).
 *
 * The indexes are the declaration's (`spaces/space-indexes.ts`, `buildSpaceIndexesAtInit`): every boot-safe index, and every other
 * one on a collection created just now - a not-boot-safe index on an existing collection is the background pass's
 * (`ensureQueryIndexes`), because its build reads the whole collection. A failed build follows the index's policy: the identity
 * index, the link pair and the plain indexes stop the space initialising, the write guard and the TTL indexes are said and
 * skipped, the text index is a warning. The steps that are not builds stay here, in their order: the legacy prefixed indexes and
 * the superseded edge identity are dropped before the declaration runs, the replaced file tombstone index after it.
 */
export async function initSpace(
  spaceId: string,
  opts: { waitForVectorReady?: boolean } = {},
): Promise<void> {
  const waitForVectorReady = opts.waitForVectorReady ?? true;
  const db = getDb();
  // Before anything reads a collection: from here on every write to a record collection is followed, so the
  // reconcile below cannot miss one that lands while it runs. See `spaces/search-index-presence.ts`.
  armSearchIndexPresence();

  // Ensure collections exist (MongoDB creates them lazily on first insert,
  // but we create them explicitly to enable index creation)
  const existingColls = await db.listCollections().toArray();
  const existing = new Set(existingColls.map(c => c.name));

  const createdNow = new Set<string>();
  for (const suffix of SPACE_COLLECTIONS) {
    const name = `${spaceId}_${suffix}`;
    if (!existing.has(name)) {
      await db.createCollection(name);
      createdNow.add(name);
      log.debug(`Created collection ${peerText(name)}`);
    }
  }

  // Self-heal data left invisible by an older rename / aliased sync (see above).
  await repairStaleSpaceIds(spaceId);

  // Regular indexes.
  //
  // P10 migration: these collections are ALREADY per-space (`{spaceId}_facts`, …), so every
  // document in them carries the same `spaceId` value. Leading that field in a compound index adds
  // write cost and index bytes with zero selectivity. The indexes below are de-prefixed
  // (`{tags:1}` not `{spaceId:1, tags:1}`); `dropLegacyPrefixedIndexes` removes any old
  // `spaceId`-leading index left over from before the migration. It is idempotent: after the first
  // boot rebuilds them, no `spaceId`-leading index remains, so the drop loop finds nothing and the
  // builds are no-ops. (The former standalone entity-unique-index migration is folded
  // in here — a stale `spaceId_1_name_1_type_1` unique index simply gets dropped like any other.)
  const memoriesColl = db.collection(spaceCollection(spaceId, 'facts'));
  const entitiesColl = db.collection(spaceCollection(spaceId, 'entities'));
  const edgesColl = db.collection(spaceCollection(spaceId, 'edges'));
  const chronoColl = db.collection(spaceCollection(spaceId, 'chrono'));
  const tombstonesColl = db.collection(spaceCollection(spaceId, 'tombstones'));
  const conflictsColl = db.collection(spaceCollection(spaceId, 'conflicts'));
  const dupeColl = db.collection(spaceCollection(spaceId, 'dupeCandidates'));
  const contraColl = db.collection(spaceCollection(spaceId, 'contradictionCandidates'));
  const filesColl = db.collection(spaceCollection(spaceId, 'files'));

  await Promise.all([
    dropLegacyPrefixedIndexes(memoriesColl), dropLegacyPrefixedIndexes(entitiesColl),
    dropLegacyPrefixedIndexes(edgesColl), dropLegacyPrefixedIndexes(chronoColl),
    dropLegacyPrefixedIndexes(tombstonesColl), dropLegacyPrefixedIndexes(conflictsColl),
    dropLegacyPrefixedIndexes(dupeColl), dropLegacyPrefixedIndexes(contraColl),
    dropLegacyPrefixedIndexes(filesColl),
    // Before the identity build below. See `dropSupersededEdgeIdentityIndex`.
    dropSupersededEdgeIdentityIndex(edgesColl),
  ]);

  // Every declared index (`spaces/space-indexes.ts`): the boot-safe ones on every collection, the rest on a collection created just
  // now. Before the build, above: the legacy prefixed indexes and the superseded edge identity are gone, or the old three-field
  // unique index would sit beside the widened one and keep refusing the rows it exists to allow. The media job queue, the most
  // polled collection in the product, is in it: its indexes are declared beside its queries (`files/media/job-queue.ts`).
  // An edges collection that holds no row is as free to build as a new one: the partial edge identity index replaces the full one there at once (Q-624);
  // one WITH edges stays on the full index until the owed job's swap (`spaces/edge-identity-owed.ts`).
  const edgesEmpty = createdNow.has(spaceCollection(spaceId, 'edges')) || await edgesHoldNoRow(spaceId);
  await buildSpaceIndexesAtInit(spaceId, part => createdNow.has(spaceCollection(spaceId, part)) || (part === 'edges' && edgesEmpty));
  // After it: the file tombstone index a later release replaced, maintained on every pending write for nothing.
  await dropReplacedFileTombstoneIndexes(spaceId);

  // Vector search indexes (Atlas Local / Atlas) — only on the collections that hold a record (Q-165): a
  // populated collection's are created or validated here, an empty one's are dropped, which is also how an
  // existing space heals on upgrade. READY is polled unless the caller defers it (createSpace, so the API
  // responds without waiting — B1).
  await reconcileSpaceSearchIndexes(spaceId, { waitForReady: waitForVectorReady });

  // Ensure files directory exists
  await ensureSpaceFilesDir(spaceId);

  // Check for embedding model mismatch — if stored facts use a different
  // model than configured, recall results would be semantically invalid.
  const embCfg2 = getEmbeddingConfig();
  const sample = await col<FactDoc>(spaceCollection(spaceId, 'facts')).findOne(
    {},
    { projection: { embeddingModel: 1 } },
  );
  if (sample?.embeddingModel && sample.embeddingModel !== embCfg2.model) {
    log.warn(
      `Space '${peerText(spaceId)}': stored embeddings use model '${peerText(sample.embeddingModel)}' ` +
      `but config specifies '${peerText(embCfg2.model)}'. ` +
      `Semantic recall is disabled until re-indexed (POST /api/brain/spaces/${peerText(spaceId)}/reindex).`,
    );
    setReindexNeeded(spaceId, true);
  } else {
    // A reindex run that began with the flag asserted keeps it asserted until the run ends, whatever the one sampled
    // fact says: a boot mid-run can sample a record already rebuilt, and recall would reopen over mixed vectors.
    // Read here, in the step that computes the flag, so there is no window in which it reads false.
    const { reindexRunFlags } = await import('../brain/reindex.js');
    setReindexNeeded(spaceId, await reindexRunFlags(spaceId));
  }
}

/**
 * How long the background pass waits for one space's indexes, in ms.
 *
 * Ten minutes, not the 60 seconds the boot path used. The old ceiling existed because boot was blocked
 * on it, so it had to be short — and being short is exactly why it always expired on a real migration
 * and reported `failed` for indexes that were building perfectly well. Off the boot path nothing is
 * waiting on this but a status label, so it can afford to be long enough to be TRUE.
 */
const STARTUP_INDEX_READY_TIMEOUT_MS = envInt('INDEX_READY_TIMEOUT_MS', 10 * 60_000);

/** How many spaces confirm their index builds at once, once boot has already finished. */
const FINALIZE_CONCURRENCY = 3;

/** The step names the walks below report under (`util/housekeeping-walk.ts`), declared once so their counters start at 0. */
const SPACE_INIT_STEP = declareStep('space init');
const INDEX_CONFIRMATION_STEP = declareStep('index confirmation');
/** A deleted space's search-index drop (`dropSpaceData`), said through the shared reporter and not a line of its own: once per window, and counted. */
const INDEX_DROP_STEP = declareStep('space delete search-index drop');
const INDEX_DROP_RETRIED = 'by the collection drop that follows';

/**
 * The spaces a config reload owes an init: added by a reload and not yet initialised, or initialised and failed.
 *
 * ## What it prevents
 *
 * The reload merges an added space into the config BEFORE it initialises it, so the next reload finds the space in its
 * "before" list and no longer sees it as added. A space whose init threw was therefore never initialised again until a restart,
 * and nothing said so. The debt is kept here, by id, until an init of the space lands; the next reload pays it together with
 * whatever that reload adds (Q-274). In memory only, deliberately: a restart initialises every space (`initAllSpaces`), so
 * what a restart forgets it also repays.
 */
const owedInit = new Set<string>();

/** The ids a reload owes an init, in the order they became owed. A copy. */
export function spacesOwedInit(): string[] {
  return [...owedInit];
}

/**
 * Record that these spaces were added to the config and owe an init. Idempotent. `applyConfigFromDisk` calls it as soon as it
 * has the diff, so a reload that throws BEFORE its init step (the built-in space, a pending-op resume) still owes them.
 */
export function markSpacesOwedInit(ids: readonly string[]): void {
  for (const id of ids) owedInit.add(id);
}

/** What `initAddedSpaces` is handed that belongs to the reload and not to the lifecycle: the audit write and the scheduler re-arm. */
export interface AddedSpacesInit {
  /** The spaces the reload added; those owed from earlier reloads are initialised with them. */
  added: readonly string[];
  /**
   * The retired proxy ids reserved BEFORE the reload. The reload's migration lifts a reservation a live space now holds (a live space wins,
   * plan rev 3.2 int 7), so by the time the added spaces are initialised the config no longer says which of them took a reserved id.
   */
  reservedBefore: readonly string[];
  /** Write the per-space audit entry (`CONFIG_RELOAD_OPERATIONS.added`) with the status the init really had. */
  audit: (spaceId: string, status: number) => void;
  /** Re-arm the cron-captured schedulers; never throws. Runs whether or not every space initialised. */
  rearm: () => Promise<void>;
}

/** What one pass over the owed spaces did. */
interface OwedInitPass {
  /** The concrete spaces the pass tried to initialise, in order. */
  toInit: string[];
  /** The ones whose init landed: no longer owed, marked `building`, and handed to the index confirmation. */
  landed: ReadonlySet<string>;
  /** The init failure of each space that threw. */
  failures: ReadonlyMap<string, unknown>;
  walk: WalkResult<void>;
}

/**
 * Initialise every space this process owes an init — the ONE init walk, for boot (`initAllSpaces`) and for a reload
 * (`initAddedSpaces`) alike.
 *
 * ## What it prevents
 *
 * Boot and reload each wrote their own loop over `initSpace`, and neither had what the other had: boot was a bare `for`, so one space
 * that threw kept every space after it from being initialised or confirmed and left `initAllSpaces` itself (the rest of the boot's
 * init with it); the reload isolated, reported and retried, but a space it initialised was never handed to the index confirmation, so
 * it had no `indexStatus` and no readiness line. Two loops is how each came to lack the other's half.
 *
 * ## What it does, for each owed space
 *
 *  - **its own walk step** (`eachSpace`): a failure is said once through the shared reporter (`space init failed for space '<id>': …
 *    — retried next reload`), the others are still initialised, and a store that is not answering ends the walk once;
 *  - **owed until it lands**: a failed space stays in {@link spacesOwedInit} and the next reload initialises it again;
 *  - **confirmed**: every space whose init landed is marked `building` and handed to `confirmSpaceIndexesInBackground`, which settles it
 *    to `ready`/`failed` (or defers it while search is down). Initialisation never waits for the index builds (`initAllSpaces`
 *    explains why), so the confirmation is how a space gets a verdict, whichever of the three ways it was initialised.
 *
 * Never throws for a space's failure: a caller that must say so reads `failures` and `walk`. A space the config no longer holds owes nothing
 * (removed, or renamed, between the reload that added it and this one).
 */
async function initOwedSpaces(): Promise<OwedInitPass> {
  const configured = new Set(getConfig().spaces.map(s => s.id));
  for (const id of [...owedInit]) if (!configured.has(id)) owedInit.delete(id);

  const toInit = [...owedInit];
  const failures = new Map<string, unknown>();
  const walk = await eachSpace(SPACE_INIT_STEP, toInit, async (spaceId) => {
    log.debug(`Initialising space: ${spaceId}`);
    try {
      // Collections, regular indexes and the vector-index create/update are awaited here; only the READY *poll* is deferred to the
      // confirmation below — the schema work must be done before the instance serves traffic, and it is fast.
      await initSpace(spaceId, { waitForVectorReady: false });
    } catch (err) {
      failures.set(spaceId, err);
      throw err;   // the walk reports it, once per window, and decides whether the store is the reason
    }
  }, { when: 'next reload' });

  const landed = new Set(walk.outcomes.filter(o => o.status === 'ok').map(o => o.spaceId));
  for (const id of landed) owedInit.delete(id);
  // A space the walk never reached (it stopped, or the space is in quarantine) was not tried: still owed.

  if (landed.size > 0) {
    // Ids, not space objects: a config reload during these awaits replaces cfg.spaces and every held object becomes an orphan —
    // status flips would then be written to detached records and lost, leaving spaces stuck reporting 'building' forever.
    const ids = [...landed];
    mutateConfig(fresh => {
      for (const spaceId of ids) {
        const live = fresh.spaces.find(s => s.id === spaceId);
        if (live) live.indexStatus = 'building';
      }
    });
    log.info(`Initialised ${ids.length} space(s); confirming vector index readiness in the background.`);
    void confirmSpaceIndexesInBackground(ids);
  }
  return { toInit, landed, failures, walk };
}

/**
 * Initialise the spaces a config reload added — and every space an earlier reload could not — and say, once, which still are not.
 *
 * The reload's guarantees (bundle-53 G21; the init walk itself is `initOwedSpaces`, which boot shares), each of which the bare loop it
 * replaced lacked:
 *
 *  - **isolation.** Each space is initialised inside its own walk step (`eachSpace`): one space's failure is reported and the
 *    next is still initialised; a store that is not answering ends the walk once instead of once per space.
 *  - **honest audit.** The `space.reload_added` entry is written AFTER the init, with its real status: 200 only for a space
 *    whose init landed. It used to be written before, so a space that then threw was audited as applied.
 *  - **retried.** A space whose init failed (or was not reached) stays owed, and the next reload initialises it again — the
 *    reload that added it had already merged it into the config, so nothing else would.
 *
 * Then the schedulers are re-armed (they must not be left on their old schedule by one bad space) and, when any space is still
 * owed, ONE `AggregateError` is thrown naming them. Its members are the per-space failures, so `errorChain` still sees a
 * store-side member: a route answers `503` + `Retry-After` for it, `500` in our words otherwise, and a watcher records a failed
 * reload. The message holds ids and our words only; the driver's text is in the log and in the members.
 *
 */
export async function initAddedSpaces({ added, audit, rearm, reservedBefore }: AddedSpacesInit): Promise<void> {
  markSpacesOwedInit(added);
  // A hand-edited added space under a retired proxy id, judged against the reservations as they stood BEFORE the reload: by now the
  // migration has lifted them (a live space wins, plan rev 3.2 int 7), so asked against the live config this could never fire. The space
  // is initialised as the operator wrote it, and the lifted reservation is said, never silent - rows synced or imported under the old id
  // may still sit in its collections.
  const before = { spaces: [], retiredSpaceIds: reservedBefore };
  const reserved = added.filter(id => { try { assertNotRetiredSpaceId(id, before); return false; } catch { return true; } });
  if (reserved.length > 0) {
    log.warn(`Added space(s) ${peerList(reserved, ', ')} took an id a retired proxy reserved; the reservation is lifted (a live space wins), and rows `
      + 'synced or imported under the old id may still be in its collections');
  }
  const { toInit, landed, failures, walk } = await initOwedSpaces();
  for (const id of toInit) {
    if (landed.has(id)) audit(id, 200);
    else if (failures.has(id)) audit(id, storeFailureAnswer(failures.get(id), 'config reload')?.status ?? 500);
    // A space the walk never reached (it stopped, or the space is in quarantine) was not tried: nothing to audit, still owed.
  }

  await rearm();

  const stillOwed = [...owedInit];
  if (stillOwed.length === 0) return;
  const why = walk.storeDown ? ' The database is not answering.' : walk.stalled ? ' The database looks stalled.' : '';
  throw new AggregateError([...failures.values()],
    `Space init failed for ${peerList(stillOwed, ', ')}.${why} ${stillOwed.length === 1 ? 'It is' : 'They are'} initialised again by the next reload.`);
}

/** The key a space's deferred confirmation waits under (`afterSearchUp`): one per space, removed with the space. */
const confirmWaiterKey = (spaceId: string): string => `confirm-space:${spaceId}`;

/**
 * Initialise all spaces defined in config.
 *
 * ## Boot does not wait for index builds any more
 *
 * It used to. `initSpace` defaulted to `waitForVectorReady: true`, which polls each index for READY with
 * a 60-second ceiling — **serially, per index, per space**. An upgrade that reshapes existing indexes
 * (2.0.0 added filter fields to them) therefore paid that ceiling on every index it touched:
 *
 *     13 spaces x ~5 indexes x 60s  ≈  65 minutes of blocking startup
 *
 * Reported from a real deployment, where it exceeded a 60-minute Kubernetes `startupProbe` budget. The
 * container was killed mid-migration and a completely healthy upgrade presented as a crash loop.
 *
 * The wait was also buying nothing. Every poll in that report timed out — logged a warning and continued
 * regardless — so the cost was certain and the guarantee was not. A wait whose failure path is "carry on
 * anyway" is not a guarantee, it is a delay.
 *
 * ## What replaces it
 *
 * Exactly the path `createSpace` has used since B1: create or update the indexes, mark the space
 * `building`, return, and let a background task flip it to `ready`/`failed` when the builds actually
 * finish. Nothing here is new machinery — the previous code even said so, in the comment explaining that
 * `initAllSpaces` is what recovers a space left `building` by a crash. It now recovers it the same way
 * it was created.
 *
 * Recall on a still-building index returns empty rather than failing, which is the pre-existing
 * behaviour and is why deferring is safe: the ceiling was never protecting correctness, only tidiness.
 *
 * ## One space that cannot be initialised does not stop the boot (bundle-53 G32)
 *
 * The loop was bare, so the first space to throw left every space after it un-initialised and unconfirmed, and left this function —
 * the boot's next init steps did not run — with only the boot's catch-all line, which names a driver error and not the space. The
 * boot serves either way ("background services will still start"), so stopping was never what happened: it was half an init, said
 * badly. Now each space is its own step in `initOwedSpaces`, which the reload shares: a failed space is said once and retried by the
 * next reload, and the others are initialised and confirmed. The boot's catch is for what is not one space's failure.
 */
export async function initAllSpaces(): Promise<void> {
  markSpacesOwedInit(configuredSpaceIds());
  // The reload's own init walk (`initOwedSpaces`): each space in its own step, so a space that cannot be initialised is said once
  // and stays owed to the next reload while the others are initialised and confirmed. It used to stop the boot's init at that space.
  await initOwedSpaces();
}

/**
 * Confirm index readiness after boot, a few spaces at a time.
 *
 * Bounded because the alternative is unbounded: one `finalizeSpaceIndexReady` per space, each polling
 * every collection's index once a second. Thirteen spaces would be ~65 pollers hitting
 * `listSearchIndexes` every second for as long as the builds take — replacing a startup stall with a
 * self-inflicted load spike on the database that is doing the building.
 *
 * Deliberately not awaited by the caller, and deliberately never throwing: nothing downstream of boot
 * depends on the outcome, and an unhandled rejection here would take down a process whose only pending
 * work is a status label.
 */
async function confirmSpaceIndexesInBackground(spaceIds: readonly string[]): Promise<void> {
  const failed: string[] = [];
  const deferred: string[] = [];
  /*
   * One walk, `FINALIZE_CONCURRENCY` spaces at a time (`eachSpace`, `limit`): a space's failure is reported in the walk's own
   * line and the others are still confirmed, and a store that is not answering ends the pass once instead of costing one
   * bound per space. The POLLING inside `finalizeSpaceIndexReady` keeps its own deadline (`STARTUP_INDEX_READY_TIMEOUT_MS`) —
   * it waits on a build, which is not an operation a per-op bound can be right for — and `listSearchIndexes` / `createIndex`
   * are the stated exemptions to the housekeeping bound (`db/write-bound.ts`).
   */
  const walk = await eachSpace(INDEX_CONFIRMATION_STEP, spaceIds, async (spaceId) => {
    const verdict = await finalizeSpaceIndexReady(spaceId, { timeoutMs: STARTUP_INDEX_READY_TIMEOUT_MS });
    if (verdict === 'deferred') deferred.push(spaceId);
    else if (!verdict) failed.push(spaceId);
  }, { limit: FINALIZE_CONCURRENCY, when: 'next boot' });
  // A space that threw, was in quarantine, or sat behind a stop was not confirmed: it did not reach ready.
  const answered = new Set(walk.outcomes.filter(o => o.status === 'ok').map(o => o.spaceId));
  for (const spaceId of spaceIds) if (!answered.has(spaceId) && !failed.includes(spaceId)) failed.push(spaceId);

  /*
   * A space whose confirmation was DEFERRED (database search was not answering, Q-113) is neither confirmed nor
   * failed: it stays `building` and is confirmed again when the service returns. The late run is THIS function,
   * so it goes through the same `eachSpace(…, { limit: FINALIZE_CONCURRENCY })` walk and, as a waiter, the same three at a
   * time; it runs on the same `STARTUP_INDEX_READY_TIMEOUT_MS`, which therefore starts at the confirmation and
   * not at boot (a service back after eleven minutes must not find every waiting space already past its window).
   * It builds first — boot's `initSpace` could not, search was down — and the polling that follows would
   * otherwise wait for an index nobody is going to create.
   */
  for (const spaceId of deferred) {
    if (!getConfig().spaces.some(s => s.id === spaceId)) continue;   // deleted while the verdict was coming
    afterSearchUp(confirmWaiterKey(spaceId), async () => {
      if (!getConfig().spaces.some(s => s.id === spaceId)) return;
      await reconcileSpaceSearchIndexes(spaceId);
      await confirmSpaceIndexesInBackground([spaceId]);
    });
  }

  // Say what happened, rather than announcing success unconditionally.
  //
  // This line used to read `Vector index readiness confirmed for all spaces.` no matter the outcome —
  // and on a deployment where every space failed it printed IMMEDIATELY AFTER the lines saying so. A
  // reporter quoted all three together. Two log lines a paragraph apart that contradict each other do
  // not just fail to inform; they teach an operator that this log is not worth reading.
  if (deferred.length > 0) {
    log.warn(
      `Vector index readiness is deferred for ${deferred.length} of ${spaceIds.length} space(s): database search is `
      + 'not answering yet. They stay "building" and are confirmed by themselves when it returns.'
      + (failed.length > 0 ? ` ${failed.length} other(s) did not reach ready: ${peerList(failed, ', ')}.` : ''),
    );
  } else if (failed.length === 0) {
    log.info(`Vector index readiness confirmed for all ${spaceIds.length} space(s).`);
  } else {
    log.warn(
      `Vector indexes did not reach ready for ${failed.length} of ${spaceIds.length} space(s): ` +
      `${peerList(failed, ', ')}. Recall may still work — check the per-index lines above for what was ` +
      'actually observed, and Settings → Space → Danger Zone can rebuild them.',
    );
  }
}

/** Ensure the built-in 'general' space exists in config and MongoDB */
export async function ensureGeneralSpace(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === 'general')) {
    // The built-in id is never a proxy's; a reservation of it would be a corrupt config, and says so here rather than serving a space on top of it.
    assertNotRetiredSpaceId('general', cfg);
    cfg.spaces.push({
      id: 'general',
      label: 'General',
      builtIn: true,
      folders: [],
      // Converted from birth, for the reason written out in `createSpace`.
      completeLinkage: true,
    });
    saveConfig(cfg);
  }
  await initSpace('general');
}

/**
 * Who a created space is credited to (`Q-134`) — REQUIRED, so a door cannot leave it out by accident. `tokenId: null`
 * says out loud, at the call, that nobody is credited; a reviewer sees it there.
 */
export interface SpaceCreator { tokenId: string | null }

/**
 * Create a new space and persist to config. The creating token is made admin of it in the same config write
 * (`grantCreatorAdmin`), and the grant is audited — owner, 2026-09-28: *"Creator of a space gets space admin."*
 */
export async function createSpace(opts: {
  id: string;
  label: string;
  folders?: string[];
  maxGiB?: number;
  /** The initial meta, parsed (`Q-216`): a space is stored with the schema it was created with, so it is a store like the others. */
  meta?: ParsedSpaceMeta;
  /** Face descriptor width for this space. Create-only — see `SpaceConfig.faceDescriptorDims`. */
  faceDescriptorDims?: number;
}, creator: SpaceCreator): Promise<SpaceConfig> {
  const cfg = getConfig();
  // A pre-6.0 proxy's id stays reserved until an instance admin purges what it still holds: a new space under it would meet that data.
  assertNotRetiredSpaceId(opts.id);
  // A delete of this id whose search-index drop is still running (its bound ended, the call did not) would drop the index this space is
  // about to build: wait for it, or refuse as retryable (`SpaceStillBeingRemoved`), before anything is written. Asked first, so the
  // "already exists" below is judged after the wait.
  await settleSearchIndexDropsOf(opts.id);
  if (cfg.spaces.some(s => s.id === opts.id)) {
    throw new Error(`Space '${opts.id}' already exists`);
  }
  const space: SpaceConfig = {
    id: opts.id,
    label: opts.label,
    builtIn: false,
    folders: opts.folders ?? [],
    maxGiB: opts.maxGiB,
    /*
     * CONVERTED FROM BIRTH, because there is nothing to convert FROM.
     *
     * The marker used to mean "somebody has run the conversion over this space", and the conversion runs
     * at BOOT — so a space created afterwards kept the 4.x array shape until the next restart. 5.0 removed
     * the arrays, so a new space's links are records from its first write and the marker is simply true.
     *
     * Without this a space made between two boots would be refused by `assertLinkRecords` — correctly, by
     * a rule meant for a space whose conversion FAILED, applied to one that never needed it.
     */
    completeLinkage: true,
    // Omitted rather than defaulted when absent, so an existing space and a new one at the built-in width
    // are the same shape on disk — a stored `128` would read as a deliberate choice nobody made.
    ...(opts.faceDescriptorDims ? { faceDescriptorDims: opts.faceDescriptorDims } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  // Initialize MongoDB collections/indexes before committing to config so the space
  // always has a backing DB (prevents the old "in config but no collections" race).
  // The (slow) $vectorSearch READY poll is DEFERRED so the API responds in seconds
  // instead of blocking up to minutes past the client timeout (B1): the indexes are
  // created here, the space is returned as indexStatus 'building', and a background
  // task flips it to 'ready'/'failed' once the builds finish.
  await initSpace(opts.id, { waitForVectorReady: false });
  // An empty space owes no positions: its counter document is written ready, so it never reads as one a 5.6 build left (`sync/positions-owed.ts`).
  await createReadyCounter(opts.id);
  // An id reused over a counter document a deleted space left behind (kept on purpose, so the id continues above every version it
  // handed out) may still owe that space's first carry: done inline, as a restore does, so the space is ready before the create
  // answers rather than at the next tick (Q-648). A space that owes nothing costs the one read.
  await finishPositionsOf(opts.id);
  space.indexStatus = 'building';
  // Safe to commit the `cfg` captured before the await, and worth knowing why, because the same
  // shape is NOT safe a few functions down: `cfg` is a TOP-LEVEL reference, and a reload refreshes
  // that object in place, so it stays current. `space` is a newly built object being added — not a
  // record looked up before the await. The dangerous version is holding a reference INTO the config
  // (one entry out of `cfg.spaces`) across an await and then mutating it; see `renameSpace` and
  // `reconcilePendingSpaceOp`, which both re-resolve by id inside the write for that reason.
  cfg.spaces.push(space);
  const grant = grantCreatorAdmin(cfg, creator.tokenId, opts.id);
  saveConfig(cfg);
  if (grant === 'granted') {
    logInternalAudit({
      method: 'CREATE', path: 'internal:creator-grant', spaceId: opts.id, tokenId: creator.tokenId,
      operation: CREATOR_GRANT_OPERATION,
    });
  } else if (grant === 'not-stored') {
    // An OIDC session: its rights come from the identity provider's mapping, so the grant has nowhere to live.
    log.warn(`Space '${peerText(opts.id)}' was created by a session with no stored rights; its creator reaches it only if its identity mapping does`);
  }
  // The same confirmation boot runs: a space created while search is down is deferred, not failed, and is
  // confirmed when the service returns.
  void confirmSpaceIndexesInBackground([opts.id]);
  return space;
}

/** Physically drop a real space's MongoDB collections, vector indexes, and file
 *  directories. Idempotent — re-running after a partial run is safe (dropping a
 *  missing collection / removing an absent directory are both no-ops). Returns the
 *  list of hard errors encountered (empty on full success). */
export async function dropSpaceData(
  spaceId: string, fileTree: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<string[]> {
  const db = getDb();
  const errors: string[] = [];

  // 1. Drop every search index of every indexed collection (best-effort, and bounded).
  //
  // Through `dropCollectionSearchIndexes`, the one function that does it: it names an index by the collection's prefix, so the face
  // gallery and a `__swap` stand-in go with the embedding index. This step used to be a weaker copy that dropped `_embedding` only and
  // left the rest to the collection drop, where an index lingers (3 to 30 s on atlas-local) and is listed again on a collection
  // recreated under the same name. Its two calls (list, drop) are mongot's and no store bound ends them, so each collection is bounded
  // by `SPACE_ACT_SEARCH_INDEX_MS` here, inside the function that every delete and every resumed delete runs: whatever mongot is doing,
  // the delete waits for it that long and no longer (Q-176). A failure or a timeout is non-fatal — the collection drop below cleans up.
  //
  // A bound does not cancel the call. Each drop is registered for as long as it RUNS (`trackSearchIndexDrop`), so a create or a rename into
  // this id waits for it, or is refused as retryable, instead of building an index the orphaned drop then removes (it names by prefix).
  await Promise.all(VECTOR_INDEXED_COLLECTIONS.map(suffix => withinTimeBound(
    trackSearchIndexDrop(spaceId, dropCollectionSearchIndexes(spaceId, suffix)), spaceActKnob('SPACE_ACT_SEARCH_INDEX_MS'), `the search indexes of ${spaceId}_${suffix}`,
  ).then(done => {
    // A collection whose indexes could not be listed or dropped answers false (and says why at debug): the collection drop below cleans
    // up, but a delete that loses its index step without a word is the weaker of the two old ones, so it is said here (Q-176 review, D4).
    if (!done) {
      reportSpaceFailure(INDEX_DROP_STEP, spaceId, new Error(`the search indexes of ${spaceId}_${suffix} could not all be listed or dropped, or a swap is running on the collection`), { unit: suffix, when: INDEX_DROP_RETRIED });
    }
  }, err => {
    reportSpaceFailure(INDEX_DROP_STEP, spaceId, err, { unit: suffix, when: INDEX_DROP_RETRIED });
  })));

  // 2. Drop all MongoDB collections associated with this space.
  //
  // **This is a prefix match with no boundary check, and it DROPS.** It is safe only because a space id is
  // validated `^[a-z0-9-]+$` everywhere one is accepted (`api/spaces.ts` create + rename,
  // `api/networks/join.ts`), so `_` can never appear inside an id and is therefore an unambiguous
  // separator: a sibling space `work-archive` owns `work-archive_facts`, which does not start with
  // `work_`. Relax that charset to permit `_` and deleting `work` would silently drop `work_archive`'s
  // collections — another space's data, with no confirmation and no recovery outside a backup.
  // `space-id-prefix-safety.test.js` pins the pattern for exactly this reason.
  const prefix = `${spaceId}_`;
  const existingColls = await db.listCollections().toArray();
  for (const coll of existingColls.filter(c => c.name.startsWith(prefix))) {
    try {
      await db.collection(coll.name).drop();
      log.debug(`Dropped collection ${peerText(coll.name)}`);
    } catch (err) {
      // In OUR words (`refusalText`): this sentence is joined into the refusal a caller reads (`pendingOpStillFailingMessage`, the
      // delete's "cleanup incomplete"), so a driver refusal — which names the collection, the index and the values — never goes
      // into it, and a failure on the store's side stops the drop here and reaches the door as the store's (bundle-53 G21).
      const msg = `Could not drop collection ${coll.name}: ${refusalText(err)}`;
      log.warn(peerText(msg));
      errors.push(msg);
    }
  }

  // 2b. Forget its usage rows.
  //
  // The prefix drop above cannot reach them: `space_activity` is instance-wide, keyed `<space>:<hour>`.
  // Left behind, they outlive the space for up to the retention window — and a space recreated with the
  // same id would inherit usage it never served.
  try {
    const { purgeSpaceActivity } = await import('../metrics/space-activity-store.js');
    const purged = await purgeSpaceActivity(spaceId);
    if (purged > 0) log.debug(`Purged ${purged} activity bucket(s) for space '${peerText(spaceId)}'`);
  } catch (err) {
    const msg = `Could not purge activity for '${spaceId}': ${err}`;
    log.warn(peerText(msg));
    errors.push(msg);
  }

  // 2c. Drop every read spill holding this space's records (Q-92). The prefix drop cannot reach them either:
  // the spill store is instance-wide. Here rather than in `removeSpace`, so a resumed delete does it too.
  try {
    const { dropSpillsForSpace } = await import('../brain/read-spill-store.js');
    await dropSpillsForSpace(spaceId);
  } catch (err) {
    const msg = `Could not drop read spills for '${spaceId}': ${err}`;
    log.warn(peerText(msg));
    errors.push(msg);
  }
  // 3. Delete the space files directory
  const filesDir = path.resolve(getDataRoot(), 'files', spaceId);
  try {
    // Through `removeTree`: a writer that started before this space stopped taking writes may still be adding
    // entries, and a bare recursive rm loses that race with ENOTEMPTY (see the helper).
    // Bounded when an act runs it (`fileTree`): a stuck mount fails the attempt instead of holding the lane.
    await fileTree(() => removeTree(filesDir));
    log.debug(`Deleted files directory ${peerText(filesDir)}`);
  } catch (err) {
    const msg = `Could not delete files directory ${filesDir}: ${err}`;
    log.warn(peerText(msg));
    errors.push(msg);
  }

  // 4. Delete any stale chunked-upload directories for this space
  const chunksDir = path.resolve(getDataRoot(), '.chunks', spaceId);
  try {
    await fileTree(() => removeTree(chunksDir));
    log.debug(`Deleted chunk uploads directory ${peerText(chunksDir)}`);
  } catch (err) {
    const msg = `Could not delete chunk uploads directory ${chunksDir}: ${err}`;
    log.warn(peerText(msg));
    errors.push(msg);
  }

  invalidateUsageCache(); // a dropped space frees disk — honour it in the next quota check
  return errors;
}

/** Delete a space: drops all MongoDB collections and files, then removes it from
 *  config. Crash-safe: a `pendingSpaceOp` marker is persisted BEFORE the drops and
 *  cleared only once the space leaves config, so a crash mid-delete is completed on
 *  the next boot by reconcilePendingSpaceOp() (deletion is forward-only — the data
 *  is already going away). If any drop fails, the marker is kept so the operator can
 *  retry (or the next boot resumes) rather than leaving a half-deleted space silently. */
export async function removeSpace(spaceId: string): Promise<boolean> {
  return runSpaceAct(registerOwnSpaceAct(soloRemoval(spaceId)), { waiter: true }).then(settled => actAnswer(settled, () => settled.removedHere === true));
}

/** This instance's own deletion of `spaceId`, refused before anything is registered when the space may never be deleted. */
function soloRemoval(spaceId: string): SpaceActRequest {
  const refusal = builtInRefusal(getConfig().spaces.find(s => s.id === spaceId), 'delete');
  if (refusal) throw refusal;
  return { kind: 'delete', localId: spaceId };
}

/**
 * What a caller of `removeSpace`/`wipeSpace` is answered from the act's run: its value when it completed, else the failure the body
 * threw (a store failure stays the store's, so the door answers it as every door does). The door's wait ends either way.
 */
function actAnswer<T>(settled: SpaceRoundSettled, value: () => T): T {
  releaseSpaceActWaiter(settled.entryId);
  if (settled.ok) return value();
  if (settled.interrupted) throw new SpaceActsClosedError();
  throw settled.cause ?? new Error(settled.error ?? 'the space act did not complete');
}

/**
 * The removal body, run by the runner: a deletion's network half (the space leaves the network its round belongs to), then this
 * instance's own copy — for its own deletion, or for a round it proposed once no network carries the space any more.
 */
async function removeSpaceUnqueued(ctx: SpaceActBodyContext): Promise<SpaceActBodyOutcome> {
  const { entry } = ctx;
  const spaceId = entry.localId;
  if (entry.networkId) {
    const { removeSpaceFromNetwork } = await import('../networks/network-spaces.js');
    removeSpaceFromNetwork(entry.networkId, spaceId, `space_deletion round(s) ${entry.rounds.map(r => r.roundId).join(', ')} passed`);
    const cfgNow = getConfig();
    const proposedHere = entry.rounds.some(r => cfgNow.networks.find(n => n.id === r.networkId)?.pendingRounds
      .find(x => x.roundId === r.roundId)?.proposedHere === true);
    if (!proposedHere) return { removedHere: false };
    if (cfgNow.networks.some(n => n.spaces.includes(spaceId))) {
      log.info(`'${peerText(spaceId)}' left network ${peerText(entry.networkId)} and is still in another network: kept until that round passes`);
      return { removedHere: false };
    }
  }
  if (!getConfig().spaces.some(s => s.id === spaceId)) return { absent: !entry.networkId, removedHere: false };
  return { removedHere: await removeOwnCopy(spaceId, ctx) };
}

async function removeOwnCopy(spaceId: string, ctx: SpaceActBodyContext): Promise<boolean> {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return false;
  const builtIn = builtInRefusal(space, 'delete');
  if (builtIn) throw builtIn;

  const resuming = cfg.pendingSpaceOp?.type === 'delete' && cfg.pendingSpaceOp.spaceId === spaceId;
  if (cfg.pendingSpaceOp && !resuming) {
    // Another op's marker: finish it first, or refuse with why it still cannot be finished.
    await settlePendingSpaceOpBefore(`delete space '${spaceId}'`);
    if (!getConfig().spaces.some(s => s.id === spaceId)) return false;   // the op it finished took this space too
  }

  // Write-ahead: record the intent (atomically) before touching MongoDB/fs.
  if (!resuming) {
    cfg.pendingSpaceOp = { type: 'delete', spaceId, startedAt: new Date().toISOString() };
    saveConfig(cfg);
  }

  const errors = await dropSpaceData(spaceId, ctx.fileTree);
  if (errors.length > 0) {
    // Keep the marker — the delete is incomplete and forward-only, so a retry or the
    // next boot resumes it. Do NOT remove the space from config yet.
    throw new Error(
      `Space '${spaceId}' cleanup incomplete (${errors.length} error(s)). ` +
      `Deletion will be resumed on retry or next restart. ` +
      `Errors: ${errors.join('; ')}`,
    );
  }

  // Commit: drop done — remove from config and clear the marker in one atomic write, then forget it.
  commitSpaceDeletion(spaceId, apply => { apply(cfg); saveConfig(cfg); });
  return true;
}

/**
 * Take `spaceId` out of a config inside the caller's write: out of `spaces`, and out of every personal view that listed it, so a recreated
 * id never silently rejoins one. The ONE removal every place a space leaves config makes (a delete, a resumed delete, a reload whose file
 * names it in `removeSpaces`); a no-op for a space already gone from `spaces`, which is how the reload finds it.
 */
export function removeSpaceFromConfig(cfg: Config, spaceId: string): void {
  cfg.spaces = cfg.spaces.filter(s => s.id !== spaceId);
  dropSpaceFromViews(cfg, spaceId);
}

/**
 * Commit a deletion whose data is dropped: remove the space from config and clear the marker in ONE write (`write` runs it - the direct
 * delete on the config it holds, the resumed delete through `mutateConfig`), then forget what this process keeps for it. Both delete paths
 * end here, so the resumed one cannot leave behind what the direct one forgets: nothing waits for a space that no longer exists (its
 * deferred confirmation, its collections' index waiters), and no Merkle leaves or space shape outlive it (both caches are bounded; a
 * deleted space's entry would only take a slot).
 */
function commitSpaceDeletion(spaceId: string, write: (apply: (cfg: Config) => void) => void): void {
  write(cfg => {
    removeSpaceFromConfig(cfg, spaceId);
    delete cfg.pendingSpaceOp;
    // Only here, with the collections already dropped: a space created later under the id starts without a mark of the old one.
    forgetVersionMark(cfg, spaceId);
  });
  forgetSearchWaiter(confirmWaiterKey(spaceId));
  forgetSpaceSearchIndexWaiters(spaceId);
  forgetMerkleLeaves(spaceId);
  forgetSpaceShape(spaceId);
  forgetSpaceIndexWarnings(spaceId);
}

/** What a wipe clears: every knowledge collection, so a new one cannot be left behind by one. */
export type WipeCollectionType = BrainCollection;

export const WIPE_COLLECTION_TYPES: readonly WipeCollectionType[] = BRAIN_COLLECTIONS;

/**
 * Which types a wipe covers, read ONE way (design v5 §2.2 (4), W23): deduplicated, in `WIPE_COLLECTION_TYPES` order, all of them for
 * an absent or empty list — or `'refused'` for a value outside them or a list longer than they are.
 *
 * What it prevents: the admin route took `types` uncapped and undeduplicated while the tool's schema capped them, so the same wipe was
 * stored, signed and keyed in two spellings, and a repeat of it was not recognised as one. Every reader asks it — both REST doors and
 * the tool before any round opens, so the round's `wipeTypes` (and the signature over them), the act's key and the hold all read one
 * canonical list. The canonicalising itself is the runner's (`canonicalWipeTypes`), which the runner's key reads too.
 */
export function wipeTypesOf(types?: unknown): WipeCollectionType[] | 'refused' {
  if (types === undefined || types === null) return [...WIPE_COLLECTION_TYPES];
  if (!Array.isArray(types) || types.length > WIPE_COLLECTION_TYPES.length || types.some(t => typeof t !== 'string')) return 'refused';
  try {
    return canonicalWipeTypes(types as string[]) ?? [...WIPE_COLLECTION_TYPES];
  } catch {
    return 'refused';
  }
}

/**
 * Which review-finding `type` values a partial wipe should clear.
 *
 * A finding is a claim about two records; once those records are wiped the claim is not just stale, it is
 * unopenable — the Review tab lists it and following it leads nowhere. Both `dupe_candidates` and
 * `contradiction_candidates` key their rows by the same singular vocabulary, so one map serves both.
 *
 * Pure, and exported, because it is the part with a decision in it: the collection-name plural
 * (`facts`) and the finding `type` (`fact`) are different vocabularies, and a missing entry here
 * silently orphans findings rather than failing.
 */
export function candidateTypesForWipe(targets: ReadonlySet<WipeCollectionType>): string[] {
  /*
   * TOTAL over the wipeable collections, with `null` where a collection has no findings — not `Partial`.
   *
   * `Partial` was the shape, and it cannot tell "this collection has no findings" from "somebody forgot".
   * `links` legitimately has none — a link is two ids and their kinds, so there is nothing to find a duplicate of
   * and nothing to contradict — and under `Partial` that reads as the omission the gate exists to catch.
   *
   * It is `RECORD_TYPE_OF` (`sync/replicated-families.ts`), the one total table from a collection to the record
   * type it holds, with `null` for links; a hand copy of it here was the same table twice (dup pass of `Q-107`).
   * Derived from `RECORD_COLLECTION`, so a collection added later is a compiler error there, once.
   */
  const MAP: Readonly<Record<WipeCollectionType, string | null>> = RECORD_TYPE_OF;
  return Array.from(targets).map(t => MAP[t]).filter((t): t is string => t !== null && t !== undefined);
}

export interface WipeResult {
  facts: number;
  entities: number;
  edges: number;
  chrono: number;
  files: number;
  /** Link records (`M-2`). A wipe that left these behind would leave a space's graph edges pointing at nothing. */
  links: number;
}

/** Wipe data from a space — by default wipes facts, entities, edges, chrono,
 *  file metadata, and the physical files directory — while preserving the space
 *  itself (label, description, config, OIDC mappings, quota settings).
 *
 *  @param types  Optional list of collection types to wipe.  When omitted (or
 *                when all five types are supplied) all collections are wiped and
 *                tombstones are cleared.  When a subset is supplied only those
 *                collections are cleared and only the matching tombstone records
 *                are removed, leaving the rest of the space intact.
 *
 *  Idempotent: wiping an already-empty space returns all-zero counts without error.
 *  Scoped strictly to the target space — no cross-space side effects.
 *
 *  The returned counts reflect the number of documents actually deleted.
 */
export async function wipeSpace(spaceId: string, types?: WipeCollectionType[]): Promise<WipeResult> {
  return runSpaceAct(registerOwnSpaceAct(soloWipe(spaceId, types)), { waiter: true }).then(settled => actAnswer(settled, () => wipeResultOf(settled.counts)));
}

/** This instance's own wipe of `spaceId`, refused before anything is registered when the space is not here or its id is unsafe. */
function soloWipe(spaceId: string, types?: WipeCollectionType[]): SpaceActRequest {
  if (!getConfig().spaces.some(s => s.id === spaceId)) throw new Error(unknownSpaceSentence(spaceId));
  // The id is embedded in a filesystem path, so it must match the pattern every id is created with (as for removeSpace).
  if (!/^[a-z0-9-]+$/.test(spaceId)) throw new Error(`Invalid spaceId '${spaceId}'`);
  return { kind: 'wipe', localId: spaceId, ...(types && types.length > 0 ? { types } : {}) };
}

/** The DELETE filter of one wipe batch: the ids the runner read for it. Not a read of stored copies. */
function byIds(ids: unknown[]): ReturnType<typeof asFilter<object>> {
  return asFilter<object>({ _id: { $in: ids } });
}

/**
 * A wipe's per-collection counts as a complete {@link WipeResult}: every collection a wipe covers present, a missing one zero, anything
 * else in `counts` left out. The one place that writes the result's keys — they come from the collection list, so a collection added
 * to a space is never a key some zero-literal forgot (a hand-listed zero made the door answer `undefined` for it, and a sum over such
 * literals dropped its column silently).
 */
export function wipeResultOf(counts?: { readonly [K in WipeCollectionType]?: number }): WipeResult {
  const result = {} as WipeResult;
  for (const t of WIPE_COLLECTION_TYPES) result[t] = counts?.[t] ?? 0;
  return result;
}

/**
 * The wipe body, run by the runner: every covered collection emptied in bounded batches, then what hangs off them. Its entry is its
 * write-ahead (it exists before any delete), so it writes no marker; a space no longer here is `absent` (nothing to wipe).
 */
async function wipeSpaceUnqueued(ctx: SpaceActBodyContext): Promise<SpaceActBodyOutcome> {
  const { entry } = ctx;
  const spaceId = entry.localId;
  if (!getConfig().spaces.some(s => s.id === spaceId)) return { absent: true, counts: {} };
  const own = { except: entry.id };

  // Resolve which types to wipe — default to all when not specified.
  const types = entry.types;
  const targets: Set<WipeCollectionType> = new Set(types && types.length > 0 ? types : WIPE_COLLECTION_TYPES);
  const isFullWipe = WIPE_COLLECTION_TYPES.every(t => targets.has(t));

  /*
   * THE JOBS GO FIRST WHEN THE FILE ROWS DO, and this is the guard a hand-written wipe drops.
   *
   * A media run writes the rows it derives from a file under its claim (`files/media/lease.ts`), and that only orders the run against
   * a removal that revokes the claims BEFORE it removes. A wipe removes every file row of the space, so it takes every job first: a run
   * that has not yet written finds its claim gone and writes nothing, and one that is writing is waited for, so the removal below finds
   * what it wrote. Without it a run that read its parent live wrote a derived row after the wipe had removed the parent, under files
   * that no longer existed.
   */
  if (targets.has('files')) await ctx.claimWait(() => cancelEveryJobOfSpace(spaceId));

  // Each covered collection in bounded batches, one after another: a wipe of any size is a sequence of operations each far below
  // the per-operation bound, and one that the bound ends after progress is run again rather than failing the attempt.
  const counts: Record<string, number> = {};
  for (const t of WIPE_COLLECTION_TYPES) {
    // The file rows go with the rest of the file tree below, after the claims were revoked above.
    if (t !== 'files' && targets.has(t)) {
      counts[t] = await ctx.deleteInBatches(spaceCollection(spaceId, t), {}, ids => col(spaceCollection(spaceId, t)).deleteMany(byIds(ids)));
    }
  }

  /*
   * WIPING ENTITIES UNLABELS EVERY FACE, and this is the guard a hand-written wipe drops.
   *
   * A face descriptor is not a record in a face collection — it is a file-meta record carrying
   * `faceEmbedding` and, once labelled, `faceEntityId` pointing at the person. Deleting the entities
   * collection therefore leaves every labelled face pointing at a person who no longer exists: the label
   * still renders, the link goes nowhere, and nothing reports it.
   *
   * **It is here because it was somewhere else.** `bulkDeleteEntities` passed `unlabelAllFaces` as an
   * `afterDelete` to `wipeSpaceCollection`, so the five per-collection `DELETE` routes did this and the
   * TOOL never did. When the routes collapsed into the tool at 5.0 the cascade would have gone with them
   * — the one door left being the one that never had it. Two implementations of one rule, and the
   * survivor was the weaker one, which is this repo's commonest defect arriving from the other direction.
   *
   * Unlabel, never delete: the face record belongs to the FILE, which the operator did not ask to remove.
   * A full wipe takes the files too, so this matters most for `types: ['entities']`.
   */
  if (targets.has('entities')) await unlabelAllFaces(spaceId, own);

  // A read spill holding this space's records outlives a wipe of them otherwise (Q-92): the one-day lifetime
  // bounds it, but a wipe is an operator saying "gone now". Any wipe, since a spill mixes record kinds.
  const { dropSpillsForSpace } = await import('../brain/read-spill-store.js');
  await dropSpillsForSpace(spaceId);

  // A reindex run is a promise about the records a full wipe just removed. Left behind, it would hold the space's
  // reindex refusal and its recall flag for work that no longer exists, and a boot would resume it.
  if (isFullWipe) await col(spaceCollection(spaceId, 'reindexRun')).deleteMany({});

  // Clear tombstones for the wiped types, in batches like the records.
  // Full wipe: every tombstone. Partial wipe: filter by the `type` field present on brain tombstones.
  // DERIVED. This was a four-entry copy of the collection-to-type mapping, in the same function as a second
  // copy for the review findings — the seventh and eighth of that map in the codebase. `files` is absent from
  // the derived one for the reason it was absent from this one: a deleted file has `FileTombstoneDoc`.
  if (isFullWipe) {
    await ctx.deleteInBatches(spaceCollection(spaceId, 'tombstones'), {}, ids => col(spaceCollection(spaceId, 'tombstones')).deleteMany(byIds(ids)));
  } else {
    const tombstoneTypes = Array.from(targets)
      .map(t => TOMBSTONE_TYPE_OF[t])
      .filter((t): t is TombstoneType => t !== undefined);
    if (tombstoneTypes.length > 0) {
      await ctx.deleteInBatches(spaceCollection(spaceId, 'tombstones'), { type: { $in: tombstoneTypes } },
        ids => col(spaceCollection(spaceId, 'tombstones')).deleteMany(byIds(ids)));
    }
  }
  // Clear review findings that reference the wiped types — BOTH candidate collections. See
  // `candidateTypesForWipe` for the mapping.
  //
  // A finding is a claim about two records. Once those records are gone the claim is not merely stale, it
  // is unopenable: the Review tab lists it, and following it leads nowhere. Contradictions were missed here
  // when the collection was added, so wiping a space's facts left its contradiction queue intact and
  // pointing at nothing.
  if (isFullWipe) {
    await col(spaceCollection(spaceId, 'dupeCandidates')).deleteMany({});
    await col(spaceCollection(spaceId, 'contradictionCandidates')).deleteMany({});
  } else {
    const dupeTypes = candidateTypesForWipe(targets);
    if (dupeTypes.length > 0) {
      // Both collections key their rows by the same `type` vocabulary, so one map serves both.
      await col(spaceCollection(spaceId, 'dupeCandidates')).deleteMany({ type: { $in: dupeTypes } });
      await col(spaceCollection(spaceId, 'contradictionCandidates')).deleteMany({ type: { $in: dupeTypes } });
    }
  }

  // File tombstones live in a separate collection — clear them when files is wiped.
  if (targets.has('files')) {
    // Through the tombstones module, which marks the wipe: a publish in flight would otherwise write its tombstone again into
    // the emptied space (Q-406).
    counts['files'] = await ctx.deleteInBatches(spaceCollection(spaceId, 'files'), {}, ids => col(spaceCollection(spaceId, 'files')).deleteMany(byIds(ids)));
    await forgetFileTombstonesOf(spaceId, own);
    // What hangs off the file rows: their conflict copies, what is keyed by their paths (the hash cache) and their embed jobs (a wiped
    // file's job answered `gone`, and a failed one stayed for ever) — each in the wipe's bounded batches.
    await ctx.deleteInBatches(spaceCollection(spaceId, 'conflicts'), {}, ids => col(spaceCollection(spaceId, 'conflicts')).deleteMany(byIds(ids)));
    const inBatches = (coll: string, filter: Record<string, unknown>): Promise<number> => ctx.deleteInBatches(coll, filter, ids => col(coll).deleteMany(byIds(ids)));
    await forgetPathKeyedCache(spaceId, { everyPath: inBatches });
    await retireEmbedWorkOfRemovedRows(spaceId, { everyRow: inBatches });

    // Delete the physical files directory, then recreate it empty; and the space's staged chunk uploads.
    // Validate the resolved path stays within the expected data root to guard
    // against any unexpected traversal (defence-in-depth alongside the regex above).
    const dataRoot = getDataRoot();
    const filesDir = path.resolve(dataRoot, 'files', spaceId);
    const boundary = path.resolve(dataRoot, 'files') + path.sep;
    if (!filesDir.startsWith(boundary)) {
      throw new Error(`wipeSpace: resolved path '${filesDir}' escapes expected data root`);
    }
    // NOT swallowed (W2): a tree that could not be cleared fails the attempt, and the act stays owed with the space closed —
    // a wipe that reported success over files still on disk is the defect this replaced.
    await ctx.fileTree(async () => {
      await removeTree(filesDir);
      await fs.mkdir(filesDir, { recursive: true });
      await removeTree(path.resolve(dataRoot, '.chunks', spaceId));
    });
  }
  invalidateUsageCache(); // a wipe frees disk + shrinks brain — honour it in the next quota check

  const result = wipeResultOf(counts);
  const typesLabel = isFullWipe ? 'all' : Array.from(targets).join(', ');
  log.info(`Wiped space '${peerText(spaceId)}' [${peerText(typesLabel)}]: ${result.facts} facts, ${result.entities} entities, ${result.edges} edges, ${result.chrono} chrono, ${result.files} files, ${result.links} links`);
  return { counts: { ...result } };
}

defineSpaceActBody('delete', removeSpaceUnqueued);
defineSpaceActBody('wipe', wipeSpaceUnqueued);

/** Complete a space rename/delete that was interrupted (e.g. by a crash or restart)
 *  after its `pendingSpaceOp` marker was written but before it committed. Called once
 *  at startup, before the workers start. Rolls the operation FORWARD — the operator
 *  asked for it and the physical steps are idempotent — then clears the marker. If a
 *  step still fails, the marker is kept and a loud error is logged for the operator;
 *  the next boot tries again. */
export async function reconcilePendingSpaceOp(): Promise<void> {
  await resumePendingSpaceOp();
}

/**
 * Before a rename or delete refuses because ANOTHER op's marker is pending, resume that op — and proceed if it
 * completes.
 *
 * Why (Docker integration run of bundle-27, 13:30:47Z): one delete that failed on a racy file write kept its
 * marker, and since the marker was only resumed at BOOT, every space rename and delete on the instance was refused
 * behind it until a restart. The marker is forward-only — resuming a delete or a rename is always what was asked
 * for — so the next space operation is as good a moment to finish it as a boot. Throws the refusal, with the
 * reason, only when the resume still cannot complete.
 */
export async function settlePendingSpaceOpBefore(attempted: string): Promise<void> {
  const pending = getConfig().pendingSpaceOp;
  if (!pending) return;
  const result = await resumePendingSpaceOp();
  if (result.completed) return;
  // The store's own failure is not a reason to put in a sentence: the door answers it (503, Retry-After), as it answers every store failure.
  if (result.cause !== undefined) throwIfStoreSide(result.cause);
  throw new Error(result.reason === 'in-flight'
    ? pendingOpConflictMessage(pending, attempted)
    : pendingOpStillFailingMessage(pending, attempted, result.reason));
}

/** What a resume did: finished (or found nothing to do), or did not, and why. */
type ResumeResult = { completed: true } | { completed: false; reason: string; cause?: unknown };

/**
 * A resume that threw: the reason in OUR words, and the error itself as `cause`.
 *
 * The reason is a sentence a caller reads (`settlePendingSpaceOpBefore`), so it goes through `refusalText` and never carries
 * the driver's text. `refusalText` rethrows a failure on the store's side, which a reason cannot be — so that failure rides
 * along as `cause`, and the caller that can answer it (`settlePendingSpaceOpBefore`) rethrows it for the door; the one that
 * cannot (`reconcilePendingSpaceOp`, at boot and on a reload) keeps the marker and carries on, as it always did.
 */
function resumeThrew(err: unknown): ResumeResult {
  let reason: string;
  try { reason = refusalText(err); } catch { reason = 'the database did not answer'; }
  return { completed: false, reason, cause: err };
}

async function resumePendingSpaceOp(): Promise<ResumeResult> {
  const cfg = getConfig();
  const op = cfg.pendingSpaceOp;
  if (!op) return { completed: true };

  // A live operation in THIS process is not an interrupted one. The marker is written BEFORE the collection
  // work, and this function also runs on the config-reload path — so a reload during a rename would start a
  // second `moveSpaceData` over the same collections, and whichever call loses the race reports
  // `Source collection … does not exist` on a rename that actually succeeded. Nothing is lost by standing
  // aside: if the running op dies, its marker survives and the next boot recovers it, which is the only
  // situation this function exists for.
  //
  // Asked by KEY: is the marker's OWN op running now? A count would let a long wipe of an unrelated space make every rename and
  // delete that meets a marker refuse.
  if (spaceActRunning(op.spaceId)) {
    log.debug(`Pending space ${op.type} for '${peerText(op.spaceId)}' is being performed right now — recovery stands aside`);
    return { completed: false, reason: 'in-flight' };
  }

  const target = op.type === 'rename' ? `'${op.spaceId}' → '${op.newId}'` : `'${op.spaceId}'`;
  log.warn(`Resuming interrupted space ${op.type} ${peerText(target)} (started ${peerText(op.startedAt)})`);

  try {
    if (op.type === 'rename' && op.newId) {
      const space = cfg.spaces.find(s => s.id === op.spaceId);
      if (!space) {
        // The space is no longer under its old id — the commit already happened and
        // only the marker survived. Just clear it.
        log.warn(`Pending rename target '${peerText(op.spaceId)}' not found in config — clearing stale marker`);
        delete cfg.pendingSpaceOp;
        saveConfig(cfg);
        return { completed: true };
      }
      const errors = await moveSpaceData(op.spaceId, op.newId);
      if (errors.length > 0) {
        log.error(`Could not complete pending rename ${peerText(target)}; marker kept for the next space op or restart. Errors: ${peerList(errors, '; ')}`);
        return { completed: false, reason: errors.join('; ') };
      }
      // Re-resolve inside the write. `space` was looked up before `moveSpaceData`, which renames
      // every collection and takes seconds; a config reload in that window replaces cfg.spaces and
      // leaves it orphaned, so committing it would move the data, clear the marker, and keep the OLD
      // id — the same silent half-rename this recovery path exists to repair. This one runs ON the
      // reload path, so a reload is not just possible here, it is nearby by construction.
      // Capture before the callback: the `op.newId` narrowing from the guard above does not survive
      // into a closure.
      const { spaceId: fromId, newId: toId } = { spaceId: op.spaceId, newId: op.newId };
      mutateConfig(fresh => {
        const live = fresh.spaces.find(sp => sp.id === fromId);
        if (live) applySpaceRenameToConfig(fresh, live, fromId, toId);
        delete fresh.pendingSpaceOp;
      });
      log.info(`Completed interrupted rename ${peerText(target)}`);
      return { completed: true };
    } else if (op.type === 'delete') {
      const errors = await dropSpaceData(op.spaceId);
      if (errors.length > 0) {
        log.error(`Could not complete pending delete ${peerText(target)}; marker kept for the next space op or restart. Errors: ${peerList(errors, '; ')}`);
        return { completed: false, reason: errors.join('; ') };
      }
      // Same treatment: `dropSpaceData` is slow, so re-read before committing (`mutateConfig`) rather than writing
      // a spaces array captured before it - and the same commit as the direct delete, forgetting included.
      commitSpaceDeletion(op.spaceId, mutateConfig);
      log.info(`Completed interrupted deletion ${peerText(target)}`);
      return { completed: true };
    } else {
      log.error(`Unknown pendingSpaceOp type '${op.type}' — clearing marker`);
      delete cfg.pendingSpaceOp;
      saveConfig(cfg);
      return { completed: true };
    }
  } catch (err) {
    log.error(`reconcilePendingSpaceOp for ${peerText(target)} failed; marker kept for the next space op or restart: ${peerText(err)}`);
    return resumeThrew(err);
  }
}
