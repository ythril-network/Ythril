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
import { getDb, col } from '../db/mongo.js';
import { getConfig, saveConfig, mutateConfig, getEmbeddingConfig, getDataRoot } from '../config/loader.js';
import { ensureSpaceFilesDir } from '../files/files.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { log } from '../util/log.js';
import type { SpaceConfig, SpaceMeta, FactDoc } from '../config/types.js';
import { VECTOR_INDEXED_COLLECTIONS, buildSpaceVectorIndexes, finalizeSpaceIndexReady } from './vector-index.js';
import { SPACE_COLLECTIONS, repairStaleSpaceIds, dropLegacyPrefixedIndexes, dropSupersededEdgeIdentityIndex, pendingOpConflictMessage , setReindexNeeded, beginSpaceOp, endSpaceOp, spaceOpInFlight } from './_shared.js';
import { moveSpaceData, applySpaceRenameToConfig } from './rename.js';
import { ensureMediaJobIndexes } from '../files/media/job-queue.js';
import { ensureEmbedJobIndexes } from '../brain/embed-queue.js';
import { LINK_CLASSES } from '../brain/link-adjacency.js';
import { envInt } from '../config/env-num.js';

export async function initSpace(
  spaceId: string,
  opts: { waitForVectorReady?: boolean } = {},
): Promise<void> {
  const waitForVectorReady = opts.waitForVectorReady ?? true;
  const db = getDb();

  // Ensure collections exist (MongoDB creates them lazily on first insert,
  // but we create them explicitly to enable index creation)
  const existingColls = await db.listCollections().toArray();
  const existing = new Set(existingColls.map(c => c.name));

  for (const suffix of SPACE_COLLECTIONS) {
    const name = `${spaceId}_${suffix}`;
    if (!existing.has(name)) {
      await db.createCollection(name);
      log.debug(`Created collection ${name}`);
    }
  }

  // Self-heal data left invisible by an older rename / aliased sync (see above).
  await repairStaleSpaceIds(spaceId);

  // Regular indexes.
  //
  // P10 migration: these collections are ALREADY per-space (`{spaceId}_facts`, …), so every
  // document in them carries the same `spaceId` value. Leading that field in a compound index adds
  // write cost and index bytes with zero selectivity. The indexes below are de-prefixed
  // (`{seq:1}` not `{spaceId:1, seq:1}`); `dropLegacyPrefixedIndexes` removes any old
  // `spaceId`-leading index left over from before the migration. It is idempotent: after the first
  // boot rebuilds them, no `spaceId`-leading index remains, so the drop loop finds nothing and the
  // `createIndex` calls are no-ops. (The former standalone entity-unique-index migration is folded
  // in here — a stale `spaceId_1_name_1_type_1` unique index simply gets dropped like any other.)
  const memoriesColl = db.collection(`${spaceId}_facts`);
  const entitiesColl = db.collection(`${spaceId}_entities`);
  const edgesColl = db.collection(`${spaceId}_edges`);
  const chronoColl = db.collection(`${spaceId}_chrono`);
  const linksColl = db.collection(`${spaceId}_links`);
  const tombstonesColl = db.collection(`${spaceId}_tombstones`);
  const conflictsColl = db.collection(`${spaceId}_conflicts`);
  const dupeColl = db.collection(`${spaceId}_dupe_candidates`);
  const contraColl = db.collection(`${spaceId}_contradiction_candidates`);
  const filesColl = db.collection(`${spaceId}_files`);

  await Promise.all([
    dropLegacyPrefixedIndexes(memoriesColl), dropLegacyPrefixedIndexes(entitiesColl),
    dropLegacyPrefixedIndexes(edgesColl), dropLegacyPrefixedIndexes(chronoColl),
    dropLegacyPrefixedIndexes(tombstonesColl), dropLegacyPrefixedIndexes(conflictsColl),
    dropLegacyPrefixedIndexes(dupeColl), dropLegacyPrefixedIndexes(contraColl),
    dropLegacyPrefixedIndexes(filesColl),
    // Before the createIndex below: the old three-field unique index would otherwise sit beside the widened
    // one and keep refusing the rows it exists to allow. See `dropSupersededEdgeIdentityIndex`.
    dropSupersededEdgeIdentityIndex(edgesColl),
  ]);

  await memoriesColl.createIndex({ seq: 1 });
  await memoriesColl.createIndex({ tags: 1 });
  // `{ type: 1 }` on all four record collections. MEASURED, not assumed: every list endpoint exposes a `type`
  // filter and `total` counts with it, and `explain()` on a live instance returned COLLSCAN for
  // `{type: …}` on facts, entities, edges and chrono. Entities looked covered by `{ name: 1, type: 1 }` and
  // are not — `type` is not a prefix of it, so that index cannot serve a query on `type` alone.
  //
  // Quality-neutral by construction: the same documents come back in the same order, the counts are identical,
  // and only the plan changes. This is the cheapest load reduction available on the read path.
  await memoriesColl.createIndex({ type: 1 });
  await entitiesColl.createIndex({ name: 1, type: 1 });
  await entitiesColl.createIndex({ seq: 1 });
  await entitiesColl.createIndex({ type: 1 });
  /*
   * Unique within the (already per-space) collection — the leading constant `spaceId` distinguished no
   * documents, so dropping it preserved the identical guarantee.
   *
   * `fromKind` and `toKind` joined the key in M-3. Each collection assigns its own UUIDs, so a fact and an
   * entity may hold the same id: `(X, Y, mentions)` with Y an entity and the same triplet with Y a fact are
   * two relationships, and `edgeIdFor` derives two ids for them. Without the kinds here the index would refuse
   * the second as a duplicate — an id that is free and a row that cannot be stored, which is the identity
   * expressed two ways and disagreeing.
   *
   * Safe on an existing collection: an entity endpoint stores NOTHING (`storedEdgeKind` normalises `'entity'`
   * to absent), Mongo indexes a missing field as null, and every edge written before M-1 keys as `(from, to,
   * label, null, null)` — exactly what a new ordinary edge keys as. So the guarantee for the ordinary case is
   * unchanged and only the widened cases become storable.
   */
  await edgesColl.createIndex({ from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 }, { unique: true });
  // The compound index above serves `from` through its prefix but leaves `to` unindexed, so any
  // "which entities does the graph touch" question scanned the whole collection on the inbound half.
  // Completeness' unlinked-entity join asks it per entity; traversal asks it per hop.
  await edgesColl.createIndex({ to: 1 });
  await edgesColl.createIndex({ seq: 1 });
  await edgesColl.createIndex({ type: 1 });
  await chronoColl.createIndex({ startsAt: 1 });
  await chronoColl.createIndex({ status: 1 });
  await chronoColl.createIndex({ seq: 1 });
  await chronoColl.createIndex({ type: 1 });
  /*
   * Link records (`M-2`), and every one of these answers a question that would otherwise be a scan.
   *
   * **The unique index is the deduplication**, and it is why a link needs no conflict resolution at all. A
   * link is `(from, fromKind, to, toKind)` and nothing else — no label, no content — so two peers that both
   * notice the same connection have written the same fact. With a deterministic id they collide on `_id`;
   * with this index they collide even if an id is ever generated some other way. Either way the second write
   * is a duplicate rather than a fork, which is what lets the ingest path drop fork resolution entirely.
   *
   * Both directions are indexed separately because both are asked. From a record: what does this concern.
   * From an entity: what concerns this — the backlink scan that blocks a delete, once per candidate.
   *
   * `seq` for the sync page, exactly as every other replicated collection has it: `pageBySeq` orders on it,
   * and without the index every page a peer asks for sorts the whole collection.
   */
  await linksColl.createIndex({ from: 1, fromKind: 1, to: 1, toKind: 1 }, { unique: true });
  await linksColl.createIndex({ to: 1, toKind: 1 });
  await linksColl.createIndex({ seq: 1 });
  await tombstonesColl.createIndex({ seq: 1 });
  await conflictsColl.createIndex({ detectedAt: -1 });
  // Serves the list query: equality on `status` (now the leading field) + sort by (score desc,
  // detectedAt desc).
  await dupeColl.createIndex({ status: 1, score: -1, detectedAt: -1 });
  // Mirrors the Review list's query exactly: filter on status, then sort by confidence and recency
  // (`api/contradictions.ts` — `.sort({ confidence: -1, detectedAt: -1 })`). Without it that endpoint was a
  // collection scan plus an in-memory sort on every load, because this collection had no indexes at all.
  await contraColl.createIndex({ status: 1, confidence: -1, detectedAt: -1 });
  // The type filter in the Review tab narrows on this, and the per-type wipe below deletes by it.
  await contraColl.createIndex({ type: 1 });
  await filesColl.createIndex({ tags: 1 });
  await filesColl.createIndex({ updatedAt: -1 });
  // Chunk records point at their file through `parentFileId`. Both the chunk-grouping reads and
  // completeness' "was this file ever chunked" join go through it.
  await filesColl.createIndex({ parentFileId: 1 });

  // ── The media job queue: the most-polled collection in the product, and it had no index at all ──
  //
  // Nine collections above get indexes and this one did not, while the worker asks it a question **every
  // second**. Three queries carry all of the traffic:
  //
  //   claimNextJob      { status, $or:[claimableAfter …] }  sort { createdAt: 1 }   — per space, per tick
  //   resetStalledJobs  { status, progressAt < cutoff }      sort { claimedAt: 1 }   — per space, per sweep
  //   the /metrics collectors                                                        — four reads per scrape
  //
  // Every one of them was a collection scan followed by an in-memory sort. And the collection is not
  // transient: `completeJob` sets `status: 'complete'` and nothing prunes it, so it holds one document per
  // file ever uploaded. The scan therefore grows with the AGE of the instance, not with its backlog — a
  // queue with nothing in it costs more to poll every month it stays up.
  //
  // Local, non-synced state (job records do not replicate), so a boot-time idempotent create is the right
  // shape here rather than a self-healing read path.
  // The key patterns are declared next to the queries they serve, in job-queue.ts, and created by its own
  // function — so this cannot drift from them and the database-level test exercises the same call.
  /*
   * The field every LINK scan reads, one index per link CLASS, derived from `LINK_CLASSES`.
   *
   * `linkedRecordsAtFrontier` asks "which records of this class point at the frontier" once per class, per
   * member space, per hop — so an unindexed class is a collection scan on every hop of every traversal.
   *
   * **It used to be three hand-placed `{ entityIds: 1 }` calls, and a link is a (collection, FIELD) pair.**
   * The first version of this fixed the collections and left the field written out, which was right while
   * `entityIds` was the only link field. M-2 gave a chrono entry `memoryIds` and a file `memoryIds` and
   * `chronoIds`: three classes whose scans had no index at all. Nothing reported it, because an unindexed
   * scan returns the correct answer — slowly, and only visibly on a space large enough to feel it.
   *
   * Deduplicated because a collection can carry several link fields, and each needs its own index.
   */
  for (const key of new Set(LINK_CLASSES.map(c => `${c.collection}.${c.field}`))) {
    const [collection, field] = key.split('.');
    await db.collection(`${spaceId}_${collection}`).createIndex({ [field!]: 1 });
  }

  await ensureMediaJobIndexes(spaceId);
  await ensureEmbedJobIndexes(spaceId);

  // Lexical retrieval index — the BM25-family half of hybrid search (`brain/lexical-search.ts`).
  //
  // On `matchedText` ONLY, on purpose: it is the exact pre-embedding source string, so the lexical
  // channel reads precisely the text the vector channel embedded. Indexing display fields instead would
  // let a record be findable through text that was never part of its vector.
  //
  // MongoDB allows exactly ONE text index per collection, so this field choice is load-bearing — a later
  // feature wanting a different field set collides with it rather than adding to it.
  //
  // Best-effort: an existing collection may already carry a differently-shaped text index from a future
  // change, and a failure here must not stop a space initialising. Retrieval degrades to vector-only on
  // its own when the index is absent.
  for (const collName of VECTOR_INDEXED_COLLECTIONS) {
    try {
      await col(`${spaceId}_${collName}`).createIndex({ matchedText: 'text' }, { name: 'lexical_text' });
    } catch (err) {
      log.warn(`Space '${spaceId}': lexical text index on ${collName} not created — hybrid search will fall back to vector-only for it (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Vector search indexes (Atlas Local / Atlas). Created here; READY is polled unless
  // the caller defers it (createSpace, so the API responds without waiting — B1).
  await buildSpaceVectorIndexes(spaceId, waitForVectorReady);

  // Ensure files directory exists
  await ensureSpaceFilesDir(spaceId);

  // Check for embedding model mismatch — if stored facts use a different
  // model than configured, recall results would be semantically invalid.
  const embCfg2 = getEmbeddingConfig();
  const sample = await col<FactDoc>(`${spaceId}_facts`).findOne(
    {},
    { projection: { embeddingModel: 1 } },
  );
  if (sample?.embeddingModel && sample.embeddingModel !== embCfg2.model) {
    log.warn(
      `Space '${spaceId}': stored embeddings use model '${sample.embeddingModel}' ` +
      `but config specifies '${embCfg2.model}'. ` +
      `Semantic recall is disabled until re-indexed (POST /api/brain/spaces/${spaceId}/reindex).`,
    );
    setReindexNeeded(spaceId, true);
  } else {
    setReindexNeeded(spaceId, false);
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
 */
export async function initAllSpaces(): Promise<void> {
  // Collect ids, not space objects: a config reload during these awaits replaces cfg.spaces and every
  // held object becomes an orphan — status flips would then be written to detached records and lost,
  // leaving spaces stuck reporting 'building' forever with nothing to explain it.
  const spaceIds = getConfig().spaces.map(s => s.id);

  for (const spaceId of spaceIds) {
    log.debug(`Initialising space: ${spaceId}`);
    // Collections, regular indexes and the vector-index create/update all still happen here and are
    // still awaited. Only the READY *poll* is deferred — the schema work must be done before the
    // instance serves traffic, and it is fast.
    await initSpace(spaceId, { waitForVectorReady: false });
  }

  // Every space is now either genuinely ready or building; say so, and let the background pass settle it.
  mutateConfig(fresh => {
    for (const spaceId of spaceIds) {
      const live = fresh.spaces.find(s => s.id === spaceId);
      if (live) live.indexStatus = 'building';
    }
  });

  log.info(`Initialised ${spaceIds.length} space(s); confirming vector index readiness in the background.`);
  void confirmSpaceIndexesInBackground(spaceIds);
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
  const queue = [...spaceIds];
  const failed: string[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const spaceId = queue.shift();
      if (!spaceId) return;
      try {
        if (!await finalizeSpaceIndexReady(spaceId, { timeoutMs: STARTUP_INDEX_READY_TIMEOUT_MS })) {
          failed.push(spaceId);
        }
      } catch (err) {
        failed.push(spaceId);
        log.warn(`Space '${spaceId}': index readiness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FINALIZE_CONCURRENCY, queue.length) }, worker));

  // Say what happened, rather than announcing success unconditionally.
  //
  // This line used to read `Vector index readiness confirmed for all spaces.` no matter the outcome —
  // and on a deployment where every space failed it printed IMMEDIATELY AFTER the lines saying so. A
  // reporter quoted all three together. Two log lines a paragraph apart that contradict each other do
  // not just fail to inform; they teach an operator that this log is not worth reading.
  if (failed.length === 0) {
    log.info(`Vector index readiness confirmed for all ${spaceIds.length} space(s).`);
  } else {
    log.warn(
      `Vector indexes did not reach ready for ${failed.length} of ${spaceIds.length} space(s): ` +
      `${failed.join(', ')}. Recall may still work — check the per-index lines above for what was ` +
      'actually observed, and Settings → Space → Danger Zone can rebuild them.',
    );
  }
}

/** Ensure the built-in 'general' space exists in config and MongoDB */
export async function ensureGeneralSpace(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === 'general')) {
    cfg.spaces.push({
      id: 'general',
      label: 'General',
      builtIn: true,
      folders: [],
    });
    saveConfig(cfg);
  }
  await initSpace('general');
}

/** Create a new space and persist to config */
export async function createSpace(opts: {
  id: string;
  label: string;
  folders?: string[];
  maxGiB?: number;
  proxyFor?: string[];
  meta?: SpaceMeta;
  /** Face descriptor width for this space. Create-only — see `SpaceConfig.faceDescriptorDims`. */
  faceDescriptorDims?: number;
}): Promise<SpaceConfig> {
  const cfg = getConfig();
  if (cfg.spaces.some(s => s.id === opts.id)) {
    throw new Error(`Space '${opts.id}' already exists`);
  }
  const space: SpaceConfig = {
    id: opts.id,
    label: opts.label,
    builtIn: false,
    folders: opts.folders ?? [],
    maxGiB: opts.maxGiB,
    // Omitted rather than defaulted when absent, so an existing space and a new one at the built-in width
    // are the same shape on disk — a stored `128` would read as a deliberate choice nobody made.
    ...(opts.faceDescriptorDims ? { faceDescriptorDims: opts.faceDescriptorDims } : {}),
    ...(opts.proxyFor ? { proxyFor: opts.proxyFor } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  // Initialize MongoDB collections/indexes before committing to config so the space
  // always has a backing DB (prevents the old "in config but no collections" race).
  // The (slow) $vectorSearch READY poll is DEFERRED so the API responds in seconds
  // instead of blocking up to minutes past the client timeout (B1): the indexes are
  // created here, the space is returned as indexStatus 'building', and a background
  // task flips it to 'ready'/'failed' once the builds finish.
  if (!opts.proxyFor) {
    await initSpace(opts.id, { waitForVectorReady: false });
    space.indexStatus = 'building';
  }
  // Safe to commit the `cfg` captured before the await, and worth knowing why, because the same
  // shape is NOT safe a few functions down: `cfg` is a TOP-LEVEL reference, and a reload refreshes
  // that object in place, so it stays current. `space` is a newly built object being added — not a
  // record looked up before the await. The dangerous version is holding a reference INTO the config
  // (one entry out of `cfg.spaces`) across an await and then mutating it; see `renameSpace` and
  // `reconcilePendingSpaceOp`, which both re-resolve by id inside the write for that reason.
  cfg.spaces.push(space);
  saveConfig(cfg);
  if (!opts.proxyFor) {
    void finalizeSpaceIndexReady(opts.id);
  }
  return space;
}

/** Physically drop a real space's MongoDB collections, vector indexes, and file
 *  directories. Idempotent — re-running after a partial run is safe (dropping a
 *  missing collection / removing an absent directory are both no-ops). Returns the
 *  list of hard errors encountered (empty on full success). */
export async function dropSpaceData(spaceId: string): Promise<string[]> {
  const db = getDb();
  const errors: string[] = [];

  // 1. Drop vector search indexes on all indexed collections (best-effort)
  for (const suffix of VECTOR_INDEXED_COLLECTIONS) {
    const indexName = `${spaceId}_${suffix}_embedding`;
    try {
      const coll = db.collection(`${spaceId}_${suffix}`);
      const indexes = await coll.listSearchIndexes().toArray() as Array<{ name?: string }>;
      if (indexes.some(i => i.name === indexName)) {
        await coll.dropSearchIndex(indexName);
        log.debug(`Dropped vector search index ${indexName}`);
      }
    } catch (err) {
      log.warn(`Could not drop vector search index ${indexName}: ${err}`);
      // Vector index failure is non-fatal — the collection drop below will clean it up
    }
  }

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
      log.debug(`Dropped collection ${coll.name}`);
    } catch (err) {
      const msg = `Could not drop collection ${coll.name}: ${err}`;
      log.warn(msg);
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
    if (purged > 0) log.debug(`Purged ${purged} activity bucket(s) for space '${spaceId}'`);
  } catch (err) {
    const msg = `Could not purge activity for '${spaceId}': ${err}`;
    log.warn(msg);
    errors.push(msg);
  }
  // 2c. Forget who wrote its legacy link arrays.
  //
  // The SAME reason as 2b, and finding that out is why 2b's comment is worth keeping rather than trimming:
  // `_legacy_array_writers` is instance-wide, keyed by `spaceId`, so the prefix drop above cannot reach it
  // either. A space recreated with the same id would have its conversion pre-flight report writers that
  // wrote to its predecessor -- a wrong answer that looks like a right one, to an operator about to decide
  // something on it.
  try {
    const { purgeLegacyArrayWriters } = await import('../brain/legacy-array-writers.js');
    const purged = await purgeLegacyArrayWriters(spaceId);
    if (purged > 0) log.debug(`Purged ${purged} legacy array-writer note(s) for space '${spaceId}'`);
  } catch (err) {
    const msg = `Could not purge legacy array-writer notes for '${spaceId}': ${err}`;
    log.warn(msg);
    errors.push(msg);
  }
  // 3. Delete the space files directory
  const filesDir = path.resolve(getDataRoot(), 'files', spaceId);
  try {
    await fs.rm(filesDir, { recursive: true, force: true });
    log.debug(`Deleted files directory ${filesDir}`);
  } catch (err) {
    const msg = `Could not delete files directory ${filesDir}: ${err}`;
    log.warn(msg);
    errors.push(msg);
  }

  // 4. Delete any stale chunked-upload directories for this space
  const chunksDir = path.resolve(getDataRoot(), '.chunks', spaceId);
  try {
    await fs.rm(chunksDir, { recursive: true, force: true });
    log.debug(`Deleted chunk uploads directory ${chunksDir}`);
  } catch (err) {
    const msg = `Could not delete chunk uploads directory ${chunksDir}: ${err}`;
    log.warn(msg);
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
  // Same reason as renameSpace: this writes a pendingSpaceOp marker before dropping anything, and the
  // reconciler that acts on that marker also runs on the config-reload path. See beginSpaceOp.
  beginSpaceOp();
  try {
    return await removeSpaceInner(spaceId);
  } finally {
    endSpaceOp();
  }
}

async function removeSpaceInner(spaceId: string): Promise<boolean> {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return false;
  if (space.builtIn) throw new Error(`Cannot delete built-in space '${spaceId}'`);

  // Proxy spaces have no DB collections or files — a pure config removal, atomic
  // via the single saveConfig, so no write-ahead marker is needed.
  if (space.proxyFor) {
    cfg.spaces = cfg.spaces.filter(s => s.id !== spaceId);
    saveConfig(cfg);
    return true;
  }

  const resuming = cfg.pendingSpaceOp?.type === 'delete' && cfg.pendingSpaceOp.spaceId === spaceId;
  if (cfg.pendingSpaceOp && !resuming) {
    throw new Error(pendingOpConflictMessage(cfg.pendingSpaceOp, `delete space '${spaceId}'`));
  }

  // Write-ahead: record the intent (atomically) before touching MongoDB/fs.
  if (!resuming) {
    cfg.pendingSpaceOp = { type: 'delete', spaceId, startedAt: new Date().toISOString() };
    saveConfig(cfg);
  }

  const errors = await dropSpaceData(spaceId);
  if (errors.length > 0) {
    // Keep the marker — the delete is incomplete and forward-only, so a retry or the
    // next boot resumes it. Do NOT remove the space from config yet.
    throw new Error(
      `Space '${spaceId}' cleanup incomplete (${errors.length} error(s)). ` +
      `Deletion will be resumed on retry or next restart. ` +
      `Errors: ${errors.join('; ')}`,
    );
  }

  // Commit: drop done — remove from config and clear the marker in one atomic write.
  cfg.spaces = cfg.spaces.filter(s => s.id !== spaceId);
  delete cfg.pendingSpaceOp;
  saveConfig(cfg);
  return true;
}

/** What a wipe clears: every knowledge collection, so a new one cannot be left behind by one. */
export type WipeCollectionType = BrainCollection;

export const WIPE_COLLECTION_TYPES: readonly WipeCollectionType[] = BRAIN_COLLECTIONS;

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
   * The gate over this function asserted every wipeable type is mapped, which was true only while all five
   * had findings; `links` legitimately has none — a link is two ids and their kinds, so there is nothing to
   * find a duplicate of and nothing to contradict — and under `Partial` that reads as the omission the gate
   * exists to catch.
   *
   * Spelled `null`, so a collection added later is a compiler error here and its author has to say which
   * of the two it is.
   */
  const MAP: Record<WipeCollectionType, string | null> = {
    facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', files: 'file',
    links: null,
  };
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
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) throw new Error(`Space '${spaceId}' not found`);

  // Guard: spaceId must match the safe pattern used during creation so it is
  // safe to embed in a filesystem path (same constraint as removeSpace).
  if (!/^[a-z0-9-]+$/.test(spaceId)) {
    throw new Error(`Invalid spaceId '${spaceId}'`);
  }

  // Resolve which types to wipe — default to all when not specified.
  const targets: Set<WipeCollectionType> = new Set(
    types && types.length > 0 ? types : WIPE_COLLECTION_TYPES,
  );
  const isFullWipe = WIPE_COLLECTION_TYPES.every(t => targets.has(t));

  // Run all applicable deletes in parallel.
  const zero = Promise.resolve({ deletedCount: 0 });
  const [memRes, entRes, edgeRes, chronoRes, fileRes, linkRes] = await Promise.all([
    targets.has('facts') ? col(`${spaceId}_facts`).deleteMany({}) : zero,
    targets.has('entities') ? col(`${spaceId}_entities`).deleteMany({}) : zero,
    targets.has('edges') ? col(`${spaceId}_edges`).deleteMany({}) : zero,
    targets.has('chrono') ? col(`${spaceId}_chrono`).deleteMany({}) : zero,
    targets.has('files') ? col(`${spaceId}_files`).deleteMany({}) : zero,
    targets.has('links') ? col(`${spaceId}_links`).deleteMany({}) : zero,
  ]);

  // Clear tombstones for the wiped types.
  // Full wipe: drop everything (single deleteMany with no filter).
  // Partial wipe: filter by the `type` field present on brain tombstones.
  // DERIVED. This was a four-entry copy of the collection-to-type mapping, in the same function as a second
  // copy for the review findings — the seventh and eighth of that map in the codebase. `files` is absent from
  // the derived one for the reason it was absent from this one: a deleted file has `FileTombstoneDoc`.
  if (isFullWipe) {
    await col(`${spaceId}_tombstones`).deleteMany({});
  } else {
    const tombstoneTypes = Array.from(targets)
      .map(t => TOMBSTONE_TYPE_OF[t])
      .filter((t): t is TombstoneType => t !== undefined);
    if (tombstoneTypes.length > 0) {
      await col(`${spaceId}_tombstones`).deleteMany({ type: { $in: tombstoneTypes } });
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
    await col(`${spaceId}_dupe_candidates`).deleteMany({});
    await col(`${spaceId}_contradiction_candidates`).deleteMany({});
  } else {
    const dupeTypes = candidateTypesForWipe(targets);
    if (dupeTypes.length > 0) {
      // Both collections key their rows by the same `type` vocabulary, so one map serves both.
      await col(`${spaceId}_dupe_candidates`).deleteMany({ type: { $in: dupeTypes } });
      await col(`${spaceId}_contradiction_candidates`).deleteMany({ type: { $in: dupeTypes } });
    }
  }

  // File tombstones live in a separate collection — clear them when files is wiped.
  if (targets.has('files')) {
    await col(`${spaceId}_file_tombstones`).deleteMany({});

    // Delete the physical files directory, then recreate it empty.
    // Validate the resolved path stays within the expected data root to guard
    // against any unexpected traversal (defence-in-depth alongside the regex above).
    const dataRoot = getDataRoot();
    const filesDir = path.resolve(dataRoot, 'files', spaceId);
    const boundary = path.resolve(dataRoot, 'files') + path.sep;
    if (!filesDir.startsWith(boundary)) {
      throw new Error(`wipeSpace: resolved path '${filesDir}' escapes expected data root`);
    }
    try {
      await fs.rm(filesDir, { recursive: true, force: true });
      await fs.mkdir(filesDir, { recursive: true });
    } catch (err) {
      log.warn(`wipeSpace: could not clear files directory for '${spaceId}': ${err}`);
    }
  }
  invalidateUsageCache(); // a wipe frees disk + shrinks brain — honour it in the next quota check

  const result: WipeResult = {
    facts: memRes.deletedCount ?? 0,
    entities: entRes.deletedCount ?? 0,
    edges: edgeRes.deletedCount ?? 0,
    chrono: chronoRes.deletedCount ?? 0,
    files: fileRes.deletedCount ?? 0,
    links: linkRes.deletedCount ?? 0,
  };
  const typesLabel = isFullWipe ? 'all' : Array.from(targets).join(', ');
  log.info(`Wiped space '${spaceId}' [${typesLabel}]: ${result.facts} facts, ${result.entities} entities, ${result.edges} edges, ${result.chrono} chrono, ${result.files} files, ${result.links} links`);
  return result;
}

/** Complete a space rename/delete that was interrupted (e.g. by a crash or restart)
 *  after its `pendingSpaceOp` marker was written but before it committed. Called once
 *  at startup, before the workers start. Rolls the operation FORWARD — the operator
 *  asked for it and the physical steps are idempotent — then clears the marker. If a
 *  step still fails, the marker is kept and a loud error is logged for the operator;
 *  the next boot tries again. */
export async function reconcilePendingSpaceOp(): Promise<void> {
  const cfg = getConfig();
  const op = cfg.pendingSpaceOp;
  if (!op) return;

  // A live operation in THIS process is not an interrupted one. The marker is written BEFORE the collection
  // work, and this function also runs on the config-reload path — so a reload during a rename would start a
  // second `moveSpaceData` over the same collections, and whichever call loses the race reports
  // `Source collection … does not exist` on a rename that actually succeeded. Nothing is lost by standing
  // aside: if the running op dies, its marker survives and the next boot recovers it, which is the only
  // situation this function exists for.
  if (spaceOpInFlight()) {
    log.debug(`Pending space ${op.type} for '${op.spaceId}' is being performed right now — recovery stands aside`);
    return;
  }

  const target = op.type === 'rename' ? `'${op.spaceId}' → '${op.newId}'` : `'${op.spaceId}'`;
  log.warn(`Resuming interrupted space ${op.type} ${target} (started ${op.startedAt})`);

  try {
    if (op.type === 'rename' && op.newId) {
      const space = cfg.spaces.find(s => s.id === op.spaceId);
      if (!space) {
        // The space is no longer under its old id — the commit already happened and
        // only the marker survived. Just clear it.
        log.warn(`Pending rename target '${op.spaceId}' not found in config — clearing stale marker`);
        delete cfg.pendingSpaceOp;
        saveConfig(cfg);
        return;
      }
      const errors = await moveSpaceData(op.spaceId, op.newId);
      if (errors.length > 0) {
        log.error(`Could not complete pending rename ${target}; marker kept for next restart. Errors: ${errors.join('; ')}`);
        return;
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
      log.info(`Completed interrupted rename ${target}`);
    } else if (op.type === 'delete') {
      const errors = await dropSpaceData(op.spaceId);
      if (errors.length > 0) {
        log.error(`Could not complete pending delete ${target}; marker kept for next restart. Errors: ${errors.join('; ')}`);
        return;
      }
      // Same treatment: `dropSpaceData` is slow, so re-read before committing rather than writing
      // a spaces array captured before it.
      mutateConfig(fresh => {
        fresh.spaces = fresh.spaces.filter(sp => sp.id !== op.spaceId);
        delete fresh.pendingSpaceOp;
      });
      log.info(`Completed interrupted deletion ${target}`);
    } else {
      log.error(`Unknown pendingSpaceOp type '${op.type}' — clearing marker`);
      delete cfg.pendingSpaceOp;
      saveConfig(cfg);
    }
  } catch (err) {
    log.error(`reconcilePendingSpaceOp for ${target} failed; marker kept for next restart: ${err}`);
  }
}
