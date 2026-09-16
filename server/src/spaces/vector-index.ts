/**
 * Atlas $vectorSearch index management for a space's collections.
 *
 * Lifted out of spaces/spaces.ts (A17.7): building/diffing each collection's vector index, polling
 * it to READY, and deriving the filter fields that let a recall use native ANN pre-filtering instead
 * of an exhaustive ENN scan. Cohesive and self-contained — it does not reach back into space
 * lifecycle; spaces.ts calls in, not the other way round.
 */
import { getDb, asDoc } from '../db/mongo.js';
import { FACE_DESCRIPTOR_DIMS } from '../files/media/face-descriptor.js';
import { getConfig, mutateConfig, getEmbeddingConfig, getFaceRecognitionConfig } from '../config/loader.js';
import { resolveMetaRefs } from './schema-validation.js';
import { log } from '../util/log.js';
import type { KnowledgeType } from '../config/types.js';

// Collections that have vector search indexes for semantic recall
/*
 * NOT ALL BRAIN COLLECTIONS — and this is the list that proves the sets are different.
 *
 * A vector index is built for a collection whose documents carry an `embedding`. Every knowledge collection
 * does today, so this list and `BRAIN_COLLECTIONS` are equal — and they stop being equal the moment a
 * collection holds records with no content to embed.
 *
 * `M-2` brings the first: a link record says that one record concerns another and nothing else. Embedded, it
 * would enter every ranked list as a content-free competitor at one record per link, and `suppressEmbeddings`
 * would not be enough — that removes the VECTOR channel only, and two suppressed edges were measured
 * appearing in a 7-record space's top 5 through the lexical channel of hybrid search.
 *
 * So this list is written out rather than derived, on purpose. Deriving it would give a link collection a
 * vector index it must never have, which is a defect a refactor would have introduced silently.
 */
export const VECTOR_INDEXED_COLLECTIONS = ['facts', 'entities', 'edges', 'chrono', 'files'] as const;
export type VectorIndexedCollection = typeof VECTOR_INDEXED_COLLECTIONS[number];

/**
 * The fixed (non-`properties`) fields declared as `$vectorSearch` filter fields per collection, so
 * that a recall filtering on them uses native ANN pre-filtering instead of the exhaustive ENN scan
 * (P6). Only fields that (a) exist on the document type and (b) are reachable through the recall
 * filter API (`ALLOWED_FILTER_KEY_PREFIXES` in brain/fact.ts: tags/type/name/status/label) are
 * listed. `properties.<key>` paths are added dynamically from the space's schema — see
 * `deriveVectorFilterFields`.
 */
const FIXED_VECTOR_FILTER_FIELDS: Record<VectorIndexedCollection, string[]> = {
  facts: ['tags', 'type'],
  entities: ['tags', 'type', 'name'],
  edges: ['tags', 'type', 'label'],
  chrono: ['tags', 'type', 'status'],
  files: ['tags'],
};

/** Map a per-space collection suffix to the KnowledgeType whose schema governs its `properties`. */
const COLLECTION_KNOWLEDGE_TYPE: Partial<Record<VectorIndexedCollection, KnowledgeType>> = {
  facts: 'fact',
  entities: 'entity',
  edges: 'edge',
  chrono: 'chrono',
  // files carry no per-type schema (file is not a KnowledgeType), so no `properties.*` filter paths
};

/**
 * The full set of `$vectorSearch` filter-field paths for a collection: the fixed fields above, plus
 * one `properties.<key>` path for every property key declared in the space's schema for the
 * matching knowledge type (union across sub-types). Declaring the schema property paths is what lets
 * a `properties.*` filter take the fast ANN path on a schema-defined space — dynamic property keys
 * that no schema declares still fall back to ENN, which is correct, just slower.
 */
export function deriveVectorFilterFields(spaceId: string, collectionSuffix: VectorIndexedCollection): string[] {
  const fields = [...(FIXED_VECTOR_FILTER_FIELDS[collectionSuffix] ?? [])];
  const kt = COLLECTION_KNOWLEDGE_TYPE[collectionSuffix];
  if (!kt) return fields;

  const rawMeta = getConfig().spaces.find(s => s.id === spaceId)?.meta;
  if (!rawMeta?.typeSchemas) return fields;
  const meta = resolveMetaRefs(rawMeta);
  const ktMap = meta.typeSchemas?.[kt];
  if (!ktMap) return fields;

  const propKeys = new Set<string>();
  for (const typeSchema of Object.values(ktMap)) {
    for (const key of Object.keys(typeSchema.propertySchemas ?? {})) {
      // Guard against a schema key that would break the dot-path or duplicate a fixed field.
      if (key && !key.includes('.') && !key.includes('$')) propKeys.add(`properties.${key}`);
    }
  }
  return [...fields, ...propKeys];
}

/** The exported list of filter fields a recall query may safely push into `$vectorSearch.filter`
 *  for a given collection. Mirrors what `ensureVectorSearchIndex` declares, so recall routing and
 *  index definition never drift. */
export function vectorFilterFieldsFor(spaceId: string, collectionSuffix: string): string[] {
  if (!(VECTOR_INDEXED_COLLECTIONS as readonly string[]).includes(collectionSuffix)) return [];
  return deriveVectorFilterFields(spaceId, collectionSuffix as VectorIndexedCollection);
}

interface SearchIndexField { type?: string; path?: string; numDimensions?: number }

/**
 * Wait — ONCE per process — for the database's search component to answer.
 *
 * `mongot` (the search process inside mongodb-atlas-local) starts AFTER mongod accepts connections, and
 * compose's `depends_on: service_healthy` waits on mongod only. On a cold start, index calls can fail
 * purely because search is not listening yet. The old code treated any such failure as "not Atlas Local",
 * skipped index creation and never retried — permanent, silent loss of semantic recall for the life of
 * that deployment.
 *
 * This gate is deliberately shared and memoized. An earlier version of the fix retried inside
 * `ensureVectorSearchIndex`, which runs once per collection per space — so a cold boot paid the full
 * backoff five times per space and delayed startup enough to break crash-recovery. Waiting once bounds
 * the cost to a single window no matter how many spaces exist.
 */
let searchReadyProbe: Promise<boolean> | null = null;

export function resetSearchReadyProbe(): void { searchReadyProbe = null; }

/**
 * Ask the database whether search is answering, retrying past a cold start.
 *
 * `probe` and `sleep` are injectable so the retry-and-cache contract can be tested without a
 * database and without waiting out 12 seconds of real backoff. Defaults are the production ones —
 * callers pass nothing.
 *
 * Exported for that test. The behaviour worth pinning is the CACHE: this used to be awaited from
 * `ensureVectorSearchIndex`, which runs once per collection per space, so an unmemoised probe made a
 * cold boot pay the full backoff five times per space and delayed startup enough to break crash
 * recovery. One probe per process, whatever the answer.
 */
export async function searchAvailable(
  probe: () => Promise<unknown> = () => getDb().collection('_vectorsearch_probe').listSearchIndexes().toArray(),
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<boolean> {
  if (searchReadyProbe) return searchReadyProbe;
  searchReadyProbe = (async () => {
    const ATTEMPTS = 6;
    const BACKOFF_MS = 2_000;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        // Any collection will do — this asks "is search answering at all?", not "does this index exist".
        await probe();
        return true;
      } catch (err) {
        lastErr = err;
        if (attempt < ATTEMPTS) await sleep(BACKOFF_MS);
      }
    }
    log.warn(
      `Database search (\`mongot\`) did not answer after ${ATTEMPTS} attempts ` +
        `(${Math.round((ATTEMPTS * BACKOFF_MS) / 1000)}s): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
        `SEMANTIC RECALL WILL RETURN EMPTY until vector indexes are built — rebuild them from ` +
        `Settings → Space → Danger Zone, or POST /api/spaces/<space>/rebuild-indexes. ` +
        `Use mongodb/mongodb-atlas-local for $vectorSearch support.`,
    );
    return false;
  })();
  return searchReadyProbe;
}

/**
 * Create or validate the $vectorSearch index for a space collection.
 *
 * The index declares the vector field plus a set of `type:"filter"` fields (P6) so recall can
 * pre-filter natively on the ANN path. When an index already exists, its live definition is compared
 * against the desired one (dimensions AND the filter-field set); a difference triggers an in-place
 * `updateSearchIndex` (falling back to drop+recreate), so a schema change that adds/removes a
 * filterable property re-shapes the index without manual intervention.
 *
 * When `waitForReady` (default), polls for READY status up to 60 seconds; pass false to return
 * immediately and let Atlas finish the build in the background (B1 — the caller confirms READY
 * asynchronously via pollVectorIndexReady).
 */
export async function ensureVectorSearchIndex(
  spaceId: string,
  collectionSuffix: VectorIndexedCollection,
  numDimensions: number,
  similarity: string,
  vectorPath: string = 'embedding',
  indexSuffix: string = 'embedding',
  waitForReady: boolean = true,
  filterFields: string[] = [],
  opts: { force?: boolean; refuseWidthChange?: boolean } = {},
): Promise<void> {
  const db = getDb();
  const coll = db.collection(`${spaceId}_${collectionSuffix}`);
  const indexName = `${spaceId}_${collectionSuffix}_${indexSuffix}`;

  const definition = {
    fields: [
      { type: 'vector', path: vectorPath, numDimensions, similarity },
      ...filterFields.map(path => ({ type: 'filter', path })),
    ],
  };

  // List existing search indexes
  let indexes: Array<{ name: string; status?: string; latestDefinition?: { fields?: SearchIndexField[] } }> = [];
  // One shared wait for search to come up (see searchAvailable) rather than a backoff per collection.
  if (!(await searchAvailable())) return;
  try {
    indexes = await coll.listSearchIndexes().toArray() as typeof indexes;
  } catch (err) {
    // Search answered the probe but not for this collection — report it against the collection that
    // actually failed. The old message hardcoded `_facts` for all five, which sent the diagnosis
    // in the wrong direction for a long time.
    log.warn(
      `Could not list search indexes for ${spaceId}_${collectionSuffix}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Semantic recall will return empty for it until the index is built — rebuild from ` +
        `Settings → Space → Danger Zone, or POST /api/spaces/${spaceId}/rebuild-indexes.`,
    );
    return;
  }

  const existing = indexes.find(i => i.name === indexName);

  if (existing) {
    const existingFields = existing.latestDefinition?.fields ?? [];
    const existingDims = existingFields.find(f => f.type === 'vector')?.numDimensions
      ?? existingFields[0]?.numDimensions; // tolerate older single-field definitions
    const existingFilters = new Set(existingFields.filter(f => f.type === 'filter').map(f => f.path));
    const desiredFilters = new Set(filterFields);
    const dimsMatch = existingDims === numDimensions;
    const filtersMatch = existingFilters.size === desiredFilters.size
      && [...desiredFilters].every(p => existingFilters.has(p));
    // `force`: a caller that has just dropped and recreated the collection (restore) cannot trust this
    // diff. mongot's bookkeeping lags the drop, so the OLD index can still be listed here — the diff
    // then says "already correct", we skip creating, and mongot garbage-collects the stale entry
    // moments later. Result: no index, no error, nothing logged, and recall silently returns empty
    // forever. Measured: that is exactly what happened on the first attempt at the restore fix.
    if (dimsMatch && filtersMatch && !opts.force) {
      log.debug(`Vector search index ${indexName} already up to date`);
      return;
    }

    // Some indexes must NOT be silently re-dimensioned, and the face gallery is the one that exists today.
    //
    // Rebuilding a TEXT index at a new width is recoverable: the records are re-embedded and the vectors
    // catch up. The face gallery has no such path. Its vectors live on `faceEmbedding` in already-stored
    // face-chunk records, and nothing re-derives them — so widening the index leaves 128-wide vectors
    // indexed as if they were 512-wide. Cosine search then ranks nothing correctly **and reports no error
    // at all**, which is precisely the failure the shared width constant and its guards exist to prevent.
    // Reintroducing it through the feature meant to make the width configurable would be the worst version
    // of it, because the operator would have just been told the width is theirs to choose.
    //
    // So this refuses and keeps the existing width. Moving a POPULATED gallery to a new width means
    // re-embedding every face, which is a decision about the data, not a config edit.
    if (existing && !dimsMatch && opts.refuseWidthChange) {
      log.error(
        `REFUSING to change ${indexName} from ${existingDims} to ${numDimensions} dimensions. `
        + `The vectors already stored in this space are ${existingDims}-wide and nothing re-derives them, `
        + `so rebuilding the index at ${numDimensions} would leave every similarity score wrong with no `
        + `error reported. The index keeps its current width. To move a populated gallery, re-embed its `
        + `records at the new width first; to build a new space at ${numDimensions}, create it fresh.`,
      );
      if (filtersMatch) return;
      // Filter fields may still legitimately need updating. Re-issue the definition at the width the
      // index ALREADY has, so the filter change lands without touching the part that would destroy data.
      definition.fields = [
        { type: 'vector', path: vectorPath, numDimensions: existingDims as number, similarity },
        ...filterFields.map(path => ({ type: 'filter', path })),
      ];
    }

    // Definition changed (dimensions or filter fields). Prefer an in-place update — Atlas keeps
    // serving the old definition until the rebuilt one is READY, so recall never goes dark.
    log.warn(
      `Updating vector search index ${indexName} (dims ${existingDims}→${numDimensions}, ` +
      `filter fields ${existingFilters.size}→${desiredFilters.size})`,
    );
    try {
      await coll.updateSearchIndex(indexName, definition);
      if (waitForReady) {
        const ready = await pollVectorIndexReady(spaceId, collectionSuffix, indexName,
          { vectorPath, dims: numDimensions });
        if (!ready) log.warn(`Vector search index ${indexName} did not reach READY within 60s after update`);
      }
      return;
    } catch (err) {
      // updateSearchIndex may be unsupported (older Atlas Local) or reject a dims change — fall
      // back to drop + recreate. This one path DOES leave a brief INITIAL_SYNC gap during which
      // recall on this collection returns empty (handled by the recall error-swallow), which is
      // acceptable for the rare dims change.
      log.warn(`updateSearchIndex failed for ${indexName} (${err}); dropping and recreating`);
      try {
        await coll.dropSearchIndex(indexName);
        await new Promise(r => setTimeout(r, 2000));
      } catch (dropErr) {
        log.warn(`Failed to drop vector search index ${indexName}: ${dropErr}`);
      }
    }
  }

  log.debug(`Creating vector search index ${indexName} (${numDimensions}d, ${similarity}, path: ${vectorPath}, ${filterFields.length} filter field(s))`);
  try {
    await coll.createSearchIndex(asDoc({
      name: indexName,
      type: 'vectorSearch',
      definition,
    }));
  } catch (err) {
    log.warn(`Failed to create vector search index ${indexName}: ${err}. Semantic recall will be unavailable.`);
    return;
  }

  // Poll for READY status (unless the caller will confirm asynchronously — B1).
  if (waitForReady) {
    const ready = await pollVectorIndexReady(spaceId, collectionSuffix, indexName,
      { vectorPath, dims: numDimensions });
    if (!ready) log.warn(`Vector search index ${indexName} did not reach READY state within 60 seconds`);
  }
}

/**
 * Does this index actually serve a `$vectorSearch`?
 *
 * The question the `status` field was only ever a proxy for. A backend that does not report lifecycle
 * fields still answers this one, and it answers it about the thing recall depends on rather than about
 * the index's metadata.
 *
 * Cheap and content-free: a UNIT vector, `limit: 1`, no filter, result discarded. An empty result is a
 * perfectly good answer — only whether the query was *served* matters.
 *
 * ## Why a unit vector, and not the zero vector this shipped with
 *
 * A zero vector cannot be scored against a cosine index, and mongot says so outright:
 *
 *     Executor error … caused by :: Cosine similarity cannot be calculated against a zero vector.
 *
 * So the probe threw **every single time, on every backend** — verified locally against Atlas Local, not
 * inferred. It was never backend-specific: on a backend that reports `status`/`queryable` the cheap path
 * returns first and the probe is never reached, which is exactly why our own testing never saw it. The one
 * deployment that DID reach it — a self-hosted replica set with no lifecycle fields — got a permanent,
 * deterministic failure dressed up as "not ready yet", 600 s per index, 65 indexes.
 *
 * A unit vector (`[1, 0, 0, …]`) is a valid query against any similarity function. It matches nothing in
 * particular, which is still the point.
 *
 * `numCandidates: 10` rather than 1: `numCandidates >= limit` is the documented contract, and 1 sat on the
 * boundary for no benefit.
 *
 * ## Why the error is returned instead of swallowed
 *
 * This used to be `catch { return false }`. That discarded the single most useful fact in the entire
 * incident — the reason — and left the operator reading "probe query did not serve yet" for ten minutes
 * with no way to learn what the backend had actually said. The caller now logs it, and can tell a query
 * that will NEVER work from an index that is still building.
 */
type ProbeOutcome =
  | { serves: true }
  /** `permanent` = the backend rejected the query itself, so waiting cannot help. */
  | { serves: false; error: string; permanent: boolean };

/**
 * Errors that mean "this query is not valid here", as opposed to "not yet".
 *
 * Matched on the message because that is what the driver surfaces for an executor error; each entry is a
 * refusal of the REQUEST, and no amount of polling turns one into a success.
 */
export const PERMANENT_PROBE_ERRORS = [
  /zero vector/i,               // cosine cannot score it — what shipped in #585
  /numCandidates/i,             // outside the accepted range for this backend
  /queryVector/i,               // wrong dimensionality or malformed
  /\$vectorSearch is not allowed/i,
  /unrecognized pipeline stage/i,   // no vector search on this deployment at all
];

/**
 * The probe's query vector: a unit vector of the configured width.
 *
 * Exported so a test can assert the SHAPE rather than grep for it. The previous test asserted the probe was
 * "a real vector query, cheap" — both true of the zero vector that could never be scored. A regex over
 * source cannot know that cosine similarity is undefined at the origin; an assertion on the value can.
 */
export function probeQueryVector(dims: number): number[] {
  const v = new Array(dims).fill(0);
  v[0] = 1;   // valid under cosine, dotProduct and euclidean alike
  return v;
}

/** `numCandidates` for the probe. Must be >= `limit`; 1 sat on the boundary for no benefit. */
export const PROBE_NUM_CANDIDATES = 10;

/**
 * What to ask an index about: the field it indexes, and the width it was built at.
 *
 * ## Why this is a parameter and not two constants
 *
 * The probe used to hardcode `path: 'embedding'` and take its width from `getEmbeddingConfig().dimensions`.
 * Both are correct for the five text indexes and both are WRONG for the face gallery, which indexes
 * `faceEmbedding` at 128. So the probe queried a field that index does not index, with a vector of the wrong
 * width, and MongoDB answered — every second, for the full 600 s window, on every space:
 *
 *     Vector search index <space>_files_faceEmbedding: gave up after 600s
 *       — probe did not serve: Executor error during aggregate command ...
 *         :: caused by :: embedding is not indexed as vector
 *
 * **The probe could never succeed, so its answer carried no information at all.** The canary operator read
 * those lines off a live pod on 2026-08-20, concluded from them that no face index had ever been built, and
 * stopped a configuration change on the strength of it. The index may well have been READY throughout; the
 * only instrument that could have said was the broken one.
 *
 * Two costs. A READY gallery is reported as failed, so the one diagnostic this feature has always reads red —
 * the trap the same reporters named to us about space badges: *"a red badge that is always red on a working
 * system trains an operator to stop reading red badges."* And each miss burns the whole window: fourteen
 * spaces at 600 s each is exactly the boot-time starvation the `maxTimeMS` comment in `indexServes` warns
 * about, arriving through the one path that comment did not cover.
 *
 * `ensureVectorSearchIndex` knew both values — it built the definition with them — and simply did not pass
 * them on. That is the shape worth naming: the caller had the answer and the callee guessed.
 *
 * Face is the only non-`embedding` path today, so this is one instance. The parameter is what stops the next
 * one, and `probe-asks-the-indexed-field.test.js` refuses a caller that does not name its target.
 */
export interface ProbeTarget {
  /** The `path` in the index definition — `embedding` for the five text indexes, `faceEmbedding` for faces. */
  vectorPath: string;
  /** `numDimensions` as the index was built. A probe vector of any other width is rejected outright. */
  dims: number;
}

async function indexServes(
  coll: ReturnType<ReturnType<typeof getDb>['collection']>,
  indexName: string,
  /**
   * The path this index actually indexes, and the width it was built at.
   *
   * Both used to be assumed here — `path: 'embedding'` and the TEXT embedding width — and both are wrong for
   * the one index whose path is not `embedding`. See the note above `ProbeTarget`.
   */
  target: ProbeTarget,
): Promise<ProbeOutcome> {
  try {
    await coll.aggregate([{
      $vectorSearch: {
        index: indexName,
        path: target.vectorPath,
        queryVector: probeQueryVector(target.dims),
        numCandidates: PROBE_NUM_CANDIDATES,
        limit: 1,
      },
    }, { $limit: 1 }, { $project: { _id: 1 } }], {
      // A probe must never be the thing that blocks. Without a cap, a mongot that accepts the query and
      // then stalls holds this call — and 65 of those at boot is a plausible way to starve the event loop
      // that answers /health, which is what the reporting fleet saw as kubelet restarts.
      maxTimeMS: 5_000,
    }).toArray();
    return { serves: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { serves: false, error, permanent: PERMANENT_PROBE_ERRORS.some(re => re.test(error)) };
  }
}

/**
 * How long "the index is not in the list" must hold before it counts as terminal rather than as lag.
 *
 * 15 s against a `createSearchIndex` that has already returned. The one legitimate reason for a create to be
 * followed by an empty listing is mongot's catalogue lagging the write, and the drop path one function up
 * budgets 2 s for the same bookkeeping — so this is generous by more than seven times, and it is still two
 * orders of magnitude below the 600 s boot window it replaces.
 */
const ABSENT_IS_TERMINAL_AFTER = 15;

/**
 * Is this space still in the configuration?
 *
 * Reads the in-memory config, so it costs nothing per poll iteration. **A throw means "cannot tell", and that
 * must read as `true`** — `getConfig()` throws before the first successful load, and a poll running during early
 * boot must not conclude its space was deleted and abandon a build that is fine.
 */
function spaceStillExists(spaceId: string): boolean {
  try { return getConfig().spaces.some(s => s.id === spaceId); }
  catch { return true; }
}

/** Poll a single vector-search index for READY status, up to ~60 seconds.
 *  Returns true once READY, false if it never became READY in the window. */
export async function pollVectorIndexReady(
  spaceId: string,
  collectionSuffix: VectorIndexedCollection,
  indexName: string,
  /**
   * REQUIRED, and deliberately not defaulted to the text index's shape.
   *
   * A default here would be the bug again: the face caller would silently inherit `embedding`/768 and go on
   * reporting a working index as failed. Making it required means a new index whose path nobody thought about
   * fails to compile rather than fails to probe.
   */
  target: ProbeTarget,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const coll = getDb().collection(`${spaceId}_${collectionSuffix}`);
  const attempts = Math.max(1, Math.round((opts.timeoutMs ?? 60_000) / 1000));
  let lastSeen = 'nothing yet';
  /** Consecutive reads where the backend answered about this collection and this index was not in the list. */
  let absentFor = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise(r => setTimeout(r, 1000));
    /*
     * THE SPACE IS GONE — stop, rather than waiting out the window for indexes nobody will ever create.
     *
     * `finalizeSpaceIndexReady` already knows about this case and handles it at the WRITE: *"space was deleted
     * while its indexes built"*. The polling that precedes the write did not, so a space deleted early in its
     * own build kept up to six pollers alive, each issuing a `listSearchIndexes` every second, for the whole
     * window — 600 s of it on the boot path, three spaces at a time.
     *
     * Measured in CI on 2026-08-19: twelve consecutive 60-second give-ups for two `gov-…` spaces, every one
     * reporting `index not present (saw: none)`, which is what an empty catalogue looks like after the
     * collections have been dropped.
     *
     * It is also the case the terminal-absence guard below deliberately does NOT cover: that one requires the
     * backend to have listed OTHER indexes on this collection, so it can tell "not there" from "not asked yet".
     * An empty listing stays ambiguous — unless the space itself is gone, which settles it outright.
     *
     * Safe against creation, checked rather than assumed: `createSpace` builds indexes BEFORE pushing the space
     * into config, but passes `waitForVectorReady: false`, so it never reaches this poll. Every path that does
     * poll — `initSpace` at boot, `initSpace('general')`, `finalizeSpaceIndexReady` — runs with the space
     * already committed.
     */
    if (!spaceStillExists(spaceId)) {
      log.debug(`Vector search index ${indexName}: space '${spaceId}' no longer exists — abandoning the poll`);
      return false;
    }
    try {
      // List ALL indexes and match by name, rather than `listSearchIndexes(indexName)`.
      //
      // This is the fix for a poll that never succeeded. A deployment reported ~67 SECONDS PER INDEX
      // on an instance with almost no data — the same cost as one with thirteen full spaces. A build
      // that is genuinely instant cannot take a fixed 67s; that is the timeout expiring every single
      // time, which means the poll was never observing READY at all.
      //
      // The name-filtered overload is the difference. `ensureVectorIndex` above lists WITHOUT a filter
      // and finds by name, and that call demonstrably works — it is how an existing index is detected
      // for the update path. Only the two callers that used the filtered form misbehaved. Listing all
      // and matching here is a strict superset of the filtered behaviour, so it cannot be worse.
      const all = await coll.listSearchIndexes().toArray() as Array<{ name?: string; status?: string; queryable?: boolean }>;
      const current = all.find(i => i.name === indexName);

      if (!current) {
        lastSeen = `index not present (saw: ${all.map(i => i.name).join(', ') || 'none'})`;
        /*
         * NOT PRESENT IS A TERMINAL STATE, once the backend has demonstrably answered about this collection.
         *
         * Nothing inside this loop creates an index. If `listSearchIndexes` returns OTHER indexes on the same
         * collection, then mongot is answering and it holds this collection's catalogue — our index simply is
         * not in it, and it will not appear while all we do is ask again. Every remaining second is spent
         * waiting for a caller that already ran and returned.
         *
         * This is the same argument the `probe.permanent` branch below already makes, and it was written for
         * the same measured cost: 600 s per index, then working spaces marked failed. That fix covered the
         * index that EXISTS and cannot be probed; the absent index kept the old behaviour, and
         * `ensureVectorSearchIndex` has four paths that return without creating one — search unavailable,
         * `listSearchIndexes` throwing, `createSearchIndex` throwing, and a refused width change.
         *
         * The grace period is what keeps this correct rather than merely fast. `ensureVectorSearchIndex` polls
         * immediately after `createSearchIndex`, and mongot's catalogue lags a create by a moment — that is
         * the same bookkeeping lag the `force` flag exists for, one function up. So absence only becomes
         * terminal after it has held for ABSENT_IS_TERMINAL_AFTER consecutive reads.
         */
        if (all.length > 0) absentFor++;
        if (absentFor >= ABSENT_IS_TERMINAL_AFTER) {
          log.warn(
            `Vector search index ${indexName} does not exist and nothing here creates it — giving up after `
            + `${absentFor}s instead of ${attempts}s. The backend is answering: it listed `
            + `${all.map(i => i.name).join(', ')} on this collection. Something refused or failed to create `
            + `this index; look upstream for a "Failed to create vector search index" or "REFUSING to change" `
            + `line, or rebuild from Settings → Space → Danger Zone.`,
          );
          return false;
        }
      } else {
        absentFor = 0;
        lastSeen = `status=${current.status ?? 'undefined'} queryable=${current.queryable ?? 'undefined'}`;
        // `queryable` counts as ready too: it is the property recall actually depends on, and a
        // deployment whose mongot reports it without a READY status would otherwise poll forever.
        if (current.status === 'READY' || current.queryable === true) {
          log.debug(`Vector search index ${indexName} is READY (${lastSeen})`);
          return true;
        }

        /**
         * Neither lifecycle field is present — so ASK the index instead of reading about it.
         *
         * A self-hosted replica set returns the index document without `status` or `queryable`: found by
         * name, no lifecycle fields at all. Confirmed against MongoDB 8.2.6 Community with a mongot
         * sidecar (`buildInfo.modules: []`) — the standard self-managed search topology. Its document is
         * identity plus `latestDefinition` (fields, dimensions, similarity, versions) and nothing else:
         * there is no other key that means "usable", so there is nothing cheaper to read than the probe.
         * The loop above can then never exit, so after 600 s every
         * space on a five-instance fleet was marked failed while recall was returning genuine scores and
         * `/ready` was passing. Absence of a status field is not evidence of an unready index — the same
         * mistake the model-enumeration check used to make one layer up, where "not listed" was read as
         * "not present".
         *
         * `indexServes` runs the query recall would run. It answers the question the status field was
         * only ever a proxy for, and it is the same instinct as Verify: send one real request rather
         * than infer from metadata.
         *
         * Only reached when both fields are absent, so a backend that does report them pays nothing —
         * which matters at 65 indexes on one boot.
         */
        if (current.status === undefined && current.queryable === undefined) {
          const probe = await indexServes(coll, indexName, target);
          if (probe.serves) {
            log.debug(`Vector search index ${indexName} serves queries (no lifecycle fields on this backend)`);
            return true;
          }
          // A rejected QUERY is not an unready index. Waiting cannot fix it, and the previous version spent
          // 600 s per index doing exactly that — then marked working spaces failed. Stop, say what the
          // backend said, and treat readiness as unknown rather than false: absence of evidence is not
          // evidence of absence, which is the rule this whole probe exists to honour.
          if (probe.permanent) {
            log.warn(
              `Vector search index ${indexName}: cannot be probed on this backend — ${probe.error}. `
              + 'Treating it as usable: the index exists and this deployment reports no lifecycle fields, '
              + 'so there is nothing left to wait for. Recall will report the truth if it is not.',
            );
            return true;
          }
          lastSeen += ` — no lifecycle fields on this backend; probe did not serve: ${probe.error}`;
        }
      }
    } catch (err) {
      lastSeen = `listSearchIndexes threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Say what is actually being observed, periodically. The previous version swallowed everything and
    // reported only "did not reach READY within 60s", which is why two rounds of this bug produced no
    // evidence about WHY — the operator could see the cost and never the cause.
    if (attempt === 4 || attempt % 30 === 29) {
      log.warn(`Vector search index ${indexName}: still waiting after ${attempt + 1}s — ${lastSeen}`);
    }
  }
  log.warn(`Vector search index ${indexName}: gave up after ${attempts}s — last seen: ${lastSeen}`);
  return false;
}

/** Create every $vectorSearch index a space needs (per-type embedding indexes plus
 *  the optional face index). `waitForReady` is threaded to each — false creates them
 *  and returns without polling (B1). */
export async function buildSpaceVectorIndexes(
  spaceId: string,
  waitForReady: boolean,
  opts: { force?: boolean } = {},
): Promise<void> {
  const embCfg = getEmbeddingConfig();
  // Iterate every vector-indexed collection unconditionally. They always exist by this point:
  // initSpace() creates them explicitly precisely so indexes can be built on them. An earlier revision
  // of this fix created any that were missing — which was redundant, and broke space RENAME, because
  // MongoDB refuses renameCollection when the target namespace already exists. The collections were
  // never the problem; the missing indexes came from the mongot cold-start race handled above.
  for (const suffix of VECTOR_INDEXED_COLLECTIONS) {
    const filterFields = deriveVectorFilterFields(spaceId, suffix);
    await ensureVectorSearchIndex(spaceId, suffix, embCfg.dimensions, embCfg.similarity, 'embedding', 'embedding', waitForReady, filterFields, opts);
  }
  const faceCfg = getFaceRecognitionConfig();
  if (faceCfg.enabled) {
    // The width comes from the same constant the embedders check against. It was a literal here and a
    // literal in each embedding path — three copies of a number that MUST agree, because an index built at
    // one width and vectors written at another produce a cosine search that silently ranks nothing
    // correctly. One copy now, which is also the precondition for making it configurable.
    // `refuseWidthChange`: the face gallery is the one index whose vectors nothing re-derives, so a width
    // change must never be applied silently to an existing space. See the guard in ensureVectorSearchIndex.
    // The space's own width, chosen at creation. `refuseWidthChange` then makes it permanent: an existing
    // gallery is never re-dimensioned, because nothing re-derives the vectors already stored in it.
    const configuredDims = getConfig().spaces.find(s => s.id === spaceId)?.faceDescriptorDims
      ?? FACE_DESCRIPTOR_DIMS;
    await ensureVectorSearchIndex(spaceId, 'files', configuredDims, 'cosine', 'faceEmbedding', 'faceEmbedding', waitForReady, undefined, { ...opts, refuseWidthChange: true });
  }
}

/**
 * Poll all of a space's vector-search indexes until READY. Returns true only if every index the space's
 * SEARCH depends on reached READY within the window.
 *
 * ## The face gallery is polled and does NOT get a vote
 *
 * The canary operator 2026-08-17T1540Z §8: fourteen spaces, three showing a red *"Index build failed"* and
 * eleven *"Preparing indexes…"*, on an instance whose search worked normally. The three and the eleven are one
 * number — `FINALIZE_CONCURRENCY` is 3, so those were simply the first batch to reach the end of a 600 s
 * window while the rest were still queued behind it.
 *
 * The verdict here is what writes `indexStatus`, and `indexStatus: 'failed'` is what paints the badge red. So
 * a space with five READY indexes and an absent face gallery was reported as a failed space — and their line
 * is the argument: *"a red badge that is always red on a working system trains an operator to stop reading red
 * badges."*
 *
 * **The face gallery is not part of what a space's search depends on.** Recall, traversal, hybrid text, every
 * read a caller makes — all of them work with the gallery absent. It serves one optional capability, and on
 * their fleet `FACE_RECOGNITION_ENABLED=true` is set with no `faceRecognition.externalModel` and no manually
 * placed model files, so nothing can write a face vector at all. Letting it decide the space's status meant an
 * unconfigured optional feature could condemn a working space, permanently, on every boot.
 *
 * It is still polled, and its outcome is still logged with a name and a reason. Withholding the vote is not
 * withholding the information — a gallery that genuinely fails to build is something an operator should read
 * about, just not as *"this space's indexes failed"*.
 */
export async function waitForSpaceIndexesReady(
  spaceId: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  // Poll CONCURRENTLY. These builds run independently inside the database, so waiting on them one after
  // another only adds up their timeouts: five collections at a 60s ceiling each meant a space could sit
  // at indexStatus='building' for five minutes when every index was in fact ready in seconds. That was
  // masked for as long as only `facts` was ever indexed — fixing that made the serial wait visible.
  const required = VECTOR_INDEXED_COLLECTIONS.map(suffix =>
    // The five text indexes: path `embedding`, at the configured embedding width.
    pollVectorIndexReady(spaceId, suffix, `${spaceId}_${suffix}_embedding`,
      { vectorPath: 'embedding', dims: getEmbeddingConfig().dimensions ?? 768 }, opts),
  );
  // Started alongside the required ones so it costs no extra wall-clock, and awaited separately so its answer
  // cannot reach the verdict. Kicked off before the await below for that reason — sequencing it after would
  // add its window to the total.
  const faceIndexName = `${spaceId}_files_faceEmbedding`;
  // The path AND the width, from the same two places `initSpace` builds the index from. Passing neither is
  // what made this poll uninformative for five releases: it probed `embedding` at the text width against an
  // index that indexes `faceEmbedding` at 128, so it could only ever report failure. See `ProbeTarget`.
  const faceDims = getConfig().spaces.find(sp => sp.id === spaceId)?.faceDescriptorDims
    ?? FACE_DESCRIPTOR_DIMS;
  const face = getFaceRecognitionConfig().enabled
    ? pollVectorIndexReady(spaceId, 'files', faceIndexName,
        { vectorPath: 'faceEmbedding', dims: faceDims }, opts)
    : null;

  const results = await Promise.all(required);
  if (face) {
    // Never allowed to throw into the verdict either: an optional index cannot be the reason a working space
    // reports an error, and that has to hold for a rejected promise as much as for a `false`.
    const faceReady = await face.catch(() => false);
    if (!faceReady) {
      log.warn(
        `Space '${spaceId}': the optional face gallery index (${faceIndexName}) is not ready. This does NOT `
        + `affect recall, traversal or text search, and the space's index status is unchanged by it. Face `
        + `recognition is enabled for this instance; if that was not intended, unset FACE_RECOGNITION_ENABLED, `
        + `and if it was, note that a face vector also needs either faceRecognition.externalModel or the model `
        + `files placed under DATA_ROOT.`,
      );
    }
  }
  return results.every(Boolean);
}

/** Background step kicked off by createSpace: wait for the deferred vector-index
 *  builds to reach READY, then flip the space's indexStatus to 'ready' (or 'failed').
 *  A crash before this completes is recovered on the next boot by initAllSpaces. */
export async function finalizeSpaceIndexReady(
  spaceId: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  let ok = false;
  try {
    ok = await waitForSpaceIndexesReady(spaceId, opts);
  } catch (err) {
    log.warn(`Space '${spaceId}': error awaiting vector index readiness: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Re-read before writing: the poll above may have run for a minute, and saving the
  // snapshot we started with would erase anything written to config.json since — a
  // pendingSpaceOp crash marker being the case that bites, since losing it strands a
  // half-finished rename with no record that it was ever in flight.
  let found = true;
  mutateConfig(cfg => {
    const space = cfg.spaces.find(s => s.id === spaceId);
    if (!space) { found = false; return; } // space was deleted while its indexes built
    space.indexStatus = ok ? 'ready' : 'failed';
  });
  if (!found) return ok;
  log.info(`Space '${spaceId}': vector indexes ${ok ? 'ready' : 'did not reach READY (marked failed)'}`);
  // Returned so the caller's summary can state what actually happened. It used to return void and
  // print `readiness confirmed for all spaces` unconditionally — directly after this line had said
  // the opposite about two of them.
  return ok;
}

// ── Face descriptor width, resolved per space ────────────────────────────────────────────────────────────

/**
 * The width a given space's face gallery was built at.
 *
 * ## Why this is read from the INDEX rather than from config
 *
 * The number that matters is not "what does this instance prefer" but "what are this space's stored vectors,
 * and what is its index expecting" — and those two were created together at `initSpace`. Reading the index
 * makes a space self-consistent by construction: a gallery built at 128 keeps rejecting 512 descriptors even
 * after an operator changes the configured default, which is the correct answer, because its stored vectors
 * are still 128 wide.
 *
 * This is the shape the requesting operator asked for: *"the number exists as configuration in one place and
 * the validator could read it instead of a literal."* The alternative they offered — a second
 * `externalModel.dimensions` setting — is a second place to write the width down, and the two would drift.
 *
 * ## The cache, and why a miss is not cached
 *
 * One `listSearchIndexes` round trip per space, held for the process. Face embedding runs per image in a
 * background job, so an uncached read would put a mongot call in front of every one.
 *
 * A space whose index cannot be read right now — mid-creation, mongot lagging, a transient error — falls back
 * to `FACE_DESCRIPTOR_DIMS` and is **deliberately not cached**. Caching a fallback would pin a guess for the
 * life of the process, and the guess is wrong precisely for the spaces this feature exists to serve: the ones
 * built at a different width.
 */
const faceDimsBySpace = new Map<string, number>();

export function resetFaceDimsCache(): void { faceDimsBySpace.clear(); }

/**
 * The width the face index is BUILT at, or `null` when there is no such index.
 *
 * ## Why this is not `faceDescriptorDimsFor`
 *
 * They read the same index and answer different questions, and the difference is the whole reason both exist.
 * `faceDescriptorDimsFor` answers *"what width should I validate a descriptor against"*, so a miss must
 * produce a usable number and it falls back to `FACE_DESCRIPTOR_DIMS`. That is right for its caller and fatal
 * here: this function's caller needs to distinguish **no index** from **an index that happens to be 128**, and
 * a fallback makes those two the same answer.
 *
 * That conflation is what a width-change guard cannot afford. "No index exists, so building one at 512 is
 * free" and "an index exists at 128, so moving to 512 is a rebuild" are opposite verdicts, and the fallback
 * reports the second as the first.
 *
 * Deliberately UNCACHED, for the same reason and one more: it is called once per width change, not once per
 * image, so there is nothing to amortise — and a cached answer would be the stalest possible input to a
 * decision about whether an index exists.
 *
 * `null` on a read error too, and that is the conservative direction here: the caller treats `null` as "no
 * index at a conflicting width", so a transient failure permits the change rather than refusing it. That is
 * safe because `ensureVectorSearchIndex` still holds `refuseWidthChange` — a real index at another width is
 * refused at build time whatever this said, so the worst a wrong `null` produces is a stored number the index
 * declines to adopt, which is logged loudly rather than silent.
 */
export async function faceIndexWidth(spaceId: string): Promise<number | null> {
  const indexName = `${spaceId}_files_faceEmbedding`;
  try {
    const coll = getDb().collection(`${spaceId}_files`);
    const indexes = await coll.listSearchIndexes().toArray() as Array<{
      name?: string; latestDefinition?: { fields?: SearchIndexField[] };
    }>;
    const found = indexes.find(i => i.name === indexName);
    if (!found) return null;
    const fields = found.latestDefinition?.fields ?? [];
    const dims = fields.find(f => f.type === 'vector')?.numDimensions ?? fields[0]?.numDimensions;
    return typeof dims === 'number' && dims > 0 ? dims : null;
  } catch (err) {
    log.debug(`Could not read ${indexName} to establish its width `
      + `(${err instanceof Error ? err.message : String(err)}); treating it as absent`);
    return null;
  }
}

export async function faceDescriptorDimsFor(spaceId: string): Promise<number> {
  const hit = faceDimsBySpace.get(spaceId);
  if (hit !== undefined) return hit;

  const indexName = `${spaceId}_files_faceEmbedding`;
  try {
    const coll = getDb().collection(`${spaceId}_files`);
    const indexes = await coll.listSearchIndexes().toArray() as Array<{
      name?: string; latestDefinition?: { fields?: SearchIndexField[] };
    }>;
    const fields = indexes.find(i => i.name === indexName)?.latestDefinition?.fields ?? [];
    const dims = fields.find(f => f.type === 'vector')?.numDimensions ?? fields[0]?.numDimensions;
    if (typeof dims === 'number' && dims > 0) {
      faceDimsBySpace.set(spaceId, dims);
      return dims;
    }
    log.debug(`Face index ${indexName} reports no dimension; using the built-in default this call only`);
  } catch (err) {
    log.debug(`Could not read ${indexName} (${err instanceof Error ? err.message : String(err)}); `
      + 'using the built-in default this call only');
  }
  return FACE_DESCRIPTOR_DIMS;
}
