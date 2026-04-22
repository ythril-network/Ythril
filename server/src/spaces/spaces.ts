import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { getDb, col } from '../db/mongo.js';
import { getConfig, saveConfig, getEmbeddingConfig, getDataRoot } from '../config/loader.js';
import { ensureSpaceFilesDir, writeFile as writeSpaceFile } from '../files/files.js';
import { log } from '../util/log.js';
import type { SpaceConfig, SpaceMeta, MemoryDoc, KnowledgeType } from '../config/types.js';

const SCHEMA_KTS: KnowledgeType[] = ['entity', 'edge', 'memory', 'chrono'];

/**
 * @deprecated Write per-type schema JSON files into the space's `schemas/` folder.
 * File name: `schemas/<spaceId>_<kt>_<typeName>.json`
 *
 * These files are **deprecated snapshots** — they are no longer written automatically
 * on boot and should NOT be treated as the source of truth.  The live schema lives
 * in `config.json` under `spaces[*].meta.typeSchemas`.  Do not edit these files to
 * change the live schema; use the API (PATCH /api/spaces/:id or
 * PUT /api/spaces/:id/meta/typeSchemas/:kt/:name) instead.
 *
 * This function is kept for callers that explicitly request a snapshot export;
 * it is no longer called automatically.
 */
export async function syncSchemaFiles(spaceId: string, meta: SpaceMeta | undefined): Promise<void> {
  if (!meta?.typeSchemas) return;
  try {
    for (const kt of SCHEMA_KTS) {
      const ktMap = meta.typeSchemas[kt];
      if (!ktMap) continue;
      for (const [typeName, typeSchema] of Object.entries(ktMap)) {
        const safeName = typeName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
        const filePath = `schemas/${spaceId}_${kt}_${safeName}.json`;
        const content = JSON.stringify(typeSchema, null, 2);
        await writeSpaceFile(spaceId, filePath, content);
      }
    }
  } catch (err) {
    log.warn(`syncSchemaFiles(${spaceId}): ${err}`);
  }
}

const SPACE_COLLECTIONS = ['memories', 'entities', 'edges', 'chrono', 'tombstones', 'conflicts', 'files'] as const;

// Collections that have vector search indexes for semantic recall
const VECTOR_INDEXED_COLLECTIONS = ['memories', 'entities', 'edges', 'chrono', 'files'] as const;
type VectorIndexedCollection = typeof VECTOR_INDEXED_COLLECTIONS[number];

// ── Embedding model mismatch tracking ──────────────────────────────────────
const _reindexNeeded = new Set<string>();

/** Returns true if the space has stored embeddings from a different model */
export function needsReindex(spaceId: string): boolean {
  return _reindexNeeded.has(spaceId);
}

/** Clear the reindex flag after a successful reindex */
export function clearReindexFlag(spaceId: string): void {
  _reindexNeeded.delete(spaceId);
}

/** Create all required MongoDB collections and indexes for a space */
export async function initSpace(spaceId: string): Promise<void> {
  const db = getDb();
  const embCfg = getEmbeddingConfig();

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

  // Regular indexes
  const memoriesColl = db.collection(`${spaceId}_memories`);
  const entitiesColl = db.collection(`${spaceId}_entities`);
  const edgesColl = db.collection(`${spaceId}_edges`);
  const chronoColl = db.collection(`${spaceId}_chrono`);
  const tombstonesColl = db.collection(`${spaceId}_tombstones`);

  await memoriesColl.createIndex({ spaceId: 1, seq: 1 });
  await memoriesColl.createIndex({ spaceId: 1, tags: 1 });
  await memoriesColl.createIndex({ spaceId: 1, entityIds: 1 });
  // Migration: drop the old unique entity index if it exists (name+type is not unique).
  // Uses listIndexes() once to check — after migration the non-unique index passes
  // createIndex() as a no-op, so zero overhead on subsequent boots.
  try {
    const indexes = await entitiesColl.listIndexes().toArray();
    if (indexes.some(i => i.name === 'spaceId_1_name_1_type_1' && i.unique)) {
      await entitiesColl.dropIndex('spaceId_1_name_1_type_1');
    }
  } catch { /* collection may not exist yet — createIndex below will handle it */ }
  await entitiesColl.createIndex({ spaceId: 1, name: 1, type: 1 });
  await entitiesColl.createIndex({ spaceId: 1, seq: 1 });
  await edgesColl.createIndex({ spaceId: 1, from: 1, to: 1, label: 1 }, { unique: true });
  await edgesColl.createIndex({ spaceId: 1, seq: 1 });
  await chronoColl.createIndex({ spaceId: 1, startsAt: 1 });
  await chronoColl.createIndex({ spaceId: 1, status: 1 });
  await chronoColl.createIndex({ spaceId: 1, seq: 1 });
  await tombstonesColl.createIndex({ spaceId: 1, seq: 1 });
  await db.collection(`${spaceId}_conflicts`).createIndex({ spaceId: 1, detectedAt: -1 });
  const filesColl = db.collection(`${spaceId}_files`);
  await filesColl.createIndex({ spaceId: 1, tags: 1 });
  await filesColl.createIndex({ spaceId: 1, updatedAt: -1 });

  // Vector search indexes (Atlas Local / Atlas)
  for (const suffix of VECTOR_INDEXED_COLLECTIONS) {
    await ensureVectorSearchIndex(spaceId, suffix, embCfg.dimensions, embCfg.similarity);
  }

  // Ensure files directory exists
  await ensureSpaceFilesDir(spaceId);

  // Check for embedding model mismatch — if stored memories use a different
  // model than configured, recall results would be semantically invalid.
  const embCfg2 = getEmbeddingConfig();
  const sample = await col<MemoryDoc>(`${spaceId}_memories`).findOne(
    {},
    { projection: { embeddingModel: 1 } },
  );
  if (sample?.embeddingModel && sample.embeddingModel !== embCfg2.model) {
    log.warn(
      `Space '${spaceId}': stored embeddings use model '${sample.embeddingModel}' ` +
      `but config specifies '${embCfg2.model}'. ` +
      `Semantic recall is disabled until re-indexed (POST /api/brain/spaces/${spaceId}/reindex).`,
    );
    _reindexNeeded.add(spaceId);
  } else {
    _reindexNeeded.delete(spaceId);
  }
}

/**
 * Create or validate the $vectorSearch index for a space collection.
 * Polls for READY status up to 60 seconds.
 */
async function ensureVectorSearchIndex(
  spaceId: string,
  collectionSuffix: VectorIndexedCollection,
  numDimensions: number,
  similarity: string,
): Promise<void> {
  const db = getDb();
  const coll = db.collection(`${spaceId}_${collectionSuffix}`);
  const indexName = `${spaceId}_${collectionSuffix}_embedding`;

  // List existing search indexes
  let indexes: Array<{ name: string; status?: string; latestDefinition?: { fields?: Array<{ numDimensions?: number }> } }> = [];
  try {
    indexes = await coll.listSearchIndexes().toArray() as typeof indexes;
  } catch {
    // If listSearchIndexes fails (e.g. not Atlas Local), skip vector search index creation
    log.warn(
      `Could not list search indexes for ${spaceId}_memories. ` +
        `Vector search may be unavailable. Use mongodb/mongodb-atlas-local for $vectorSearch support.`,
    );
    return;
  }

  const existing = indexes.find(i => i.name === indexName);

  if (existing) {
    const existingDims = existing.latestDefinition?.fields?.[0]?.numDimensions;
    if (existingDims === numDimensions) {
      log.debug(`Vector search index ${indexName} already exists`);
      return;
    }
    // Dimensions changed — drop and recreate
    log.warn(`Recreating vector search index ${indexName} (dimensions changed: ${existingDims} → ${numDimensions})`);
    try {
      await coll.dropSearchIndex(indexName);
      // Wait for drop to propagate
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      log.warn(`Failed to drop vector search index ${indexName}: ${err}`);
    }
  }

  log.debug(`Creating vector search index ${indexName} (${numDimensions}d, ${similarity})`);
  try {
    await coll.createSearchIndex({
      name: indexName,
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions,
            similarity,
          },
        ],
      },
    } as never);
  } catch (err) {
    log.warn(`Failed to create vector search index ${indexName}: ${err}. Semantic recall will be unavailable.`);
    return;
  }

  // Poll for READY status (up to 60 seconds)
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const current = await coll.listSearchIndexes(indexName).toArray() as typeof indexes;
      if (current[0]?.status === 'READY') {
        log.debug(`Vector search index ${indexName} is READY`);
        return;
      }
    } catch { /* ignore intermittent errors during polling */ }
  }
  log.warn(`Vector search index ${indexName} did not reach READY state within 60 seconds`);
}

/** Initialise all spaces defined in config */
export async function initAllSpaces(): Promise<void> {
  const cfg = getConfig();
  for (const space of cfg.spaces) {
    log.debug(`Initialising space: ${space.id}`);
    await initSpace(space.id);
    // syncSchemaFiles is deprecated and no longer called automatically.
    // The live schema source of truth is config.json; see syncSchemaFiles JSDoc.
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
  description?: string;
  folders?: string[];
  maxGiB?: number;
  proxyFor?: string[];
  meta?: SpaceMeta;
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
    description: opts.description,
    ...(opts.proxyFor ? { proxyFor: opts.proxyFor } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  cfg.spaces.push(space);
  saveConfig(cfg);
  // Proxy spaces are virtual — no DB collections or file directory needed
  if (!opts.proxyFor) {
    await initSpace(opts.id);
  }
  return space;
}

/** Delete a space: drops all MongoDB collections, removes files, then removes from config.
 *  Data cleanup runs first — config is only updated after all cleanup succeeds.
 *  If any cleanup step fails, the space remains in config so the operator can retry. */
export async function removeSpace(spaceId: string): Promise<boolean> {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return false;
  if (space.builtIn) throw new Error(`Cannot delete built-in space '${spaceId}'`);

  // Only real (non-proxy) spaces have DB collections and files
  if (!space.proxyFor) {
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

    // 2. Drop all MongoDB collections associated with this space
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

    // If any collection drops or file deletions failed, abort — leave the
    // space in config so the operator can investigate and retry.
    if (errors.length > 0) {
      throw new Error(
        `Space '${spaceId}' cleanup incomplete (${errors.length} error(s)). ` +
        `Space was NOT removed from config. Fix the underlying issue and retry. ` +
        `Errors: ${errors.join('; ')}`,
      );
    }
  }

  // 5. Remove the space from config — only reached when all cleanup succeeded
  cfg.spaces = cfg.spaces.filter(s => s.id !== spaceId);
  saveConfig(cfg);
  return true;
}

export type WipeCollectionType = 'memories' | 'entities' | 'edges' | 'chrono' | 'files';
export const WIPE_COLLECTION_TYPES: readonly WipeCollectionType[] = ['memories', 'entities', 'edges', 'chrono', 'files'];

export interface WipeResult {
  memories: number;
  entities: number;
  edges: number;
  chrono: number;
  files: number;
}

/** Wipe data from a space — by default wipes memories, entities, edges, chrono,
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
  const [memRes, entRes, edgeRes, chronoRes, fileRes] = await Promise.all([
    targets.has('memories') ? col(`${spaceId}_memories`).deleteMany({}) : zero,
    targets.has('entities') ? col(`${spaceId}_entities`).deleteMany({}) : zero,
    targets.has('edges') ? col(`${spaceId}_edges`).deleteMany({}) : zero,
    targets.has('chrono') ? col(`${spaceId}_chrono`).deleteMany({}) : zero,
    targets.has('files') ? col(`${spaceId}_files`).deleteMany({}) : zero,
  ]);

  // Clear tombstones for the wiped types.
  // Full wipe: drop everything (single deleteMany with no filter).
  // Partial wipe: filter by the `type` field present on brain tombstones.
  const TOMBSTONE_TYPE_MAP: Partial<Record<WipeCollectionType, string>> = {
    memories: 'memory',
    entities: 'entity',
    edges: 'edge',
    chrono: 'chrono',
  };
  if (isFullWipe) {
    await col(`${spaceId}_tombstones`).deleteMany({});
  } else {
    const tombstoneTypes = Array.from(targets)
      .map(t => TOMBSTONE_TYPE_MAP[t])
      .filter((t): t is string => t !== undefined);
    if (tombstoneTypes.length > 0) {
      await col(`${spaceId}_tombstones`).deleteMany({ type: { $in: tombstoneTypes } });
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

  const result: WipeResult = {
    memories: memRes.deletedCount ?? 0,
    entities: entRes.deletedCount ?? 0,
    edges: edgeRes.deletedCount ?? 0,
    chrono: chronoRes.deletedCount ?? 0,
    files: fileRes.deletedCount ?? 0,
  };
  const typesLabel = isFullWipe ? 'all' : Array.from(targets).join(', ');
  log.info(`Wiped space '${spaceId}' [${typesLabel}]: ${result.memories} memories, ${result.entities} entities, ${result.edges} edges, ${result.chrono} chrono, ${result.files} files`);
  return result;
}

/** Maximum number of previous meta versions kept for history. */
const META_VERSION_CAP = 20;

/** Update mutable fields (label, description, meta) of an existing space in config.
 *  When `meta` is provided the version counter is auto-incremented and the
 *  previous version is pushed to `previousVersions` (capped at META_VERSION_CAP).
 *  Returns the updated SpaceConfig, or null if the space was not found. */
export function updateSpace(
  spaceId: string,
  updates: { label?: string; description?: string; maxGiB?: number | null; meta?: SpaceMeta },
): SpaceConfig | null {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return null;
  if (typeof updates.label === 'string') space.label = updates.label;
  if (typeof updates.description === 'string') space.description = updates.description;
  if (updates.maxGiB !== undefined) {
    // null or non-positive clears the cap (unlimited); positive number sets the cap
    space.maxGiB = updates.maxGiB !== null && updates.maxGiB > 0 ? updates.maxGiB : undefined;
  }

  if (updates.meta !== undefined) {
    const now = new Date().toISOString();
    const prev = space.meta;
    const prevVersion = prev?.version ?? 0;
    const newVersion = prevVersion + 1;

    // Preserve previous version history (capped)
    const history = prev?.previousVersions ?? [];
    if (prev) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { previousVersions: _drop, ...snapshot } = prev;
      history.unshift({ version: prevVersion, meta: snapshot, updatedAt: prev.updatedAt ?? now });
      if (history.length > META_VERSION_CAP) history.length = META_VERSION_CAP;
    }

    space.meta = {
      ...updates.meta,
      version: newVersion,
      updatedAt: now,
      previousVersions: history.length > 0 ? history : undefined,
    };
  }

  saveConfig(cfg);
  // Fire-and-forget schema file sync
  syncSchemaFiles(spaceId, space.meta).catch(err => log.warn(`syncSchemaFiles: ${err}`));
  return space;
}

/** Reorder spaces in config to match the provided ordered list of IDs.
 *  IDs not present in the list are appended at the end (preserving relative order).
 *  Returns the reordered list of SpaceConfigs, or null if any provided ID is unknown. */
export function reorderSpaces(orderedIds: string[]): SpaceConfig[] | null {
  const cfg = getConfig();
  const idSet = new Set(orderedIds);
  // Validate all provided IDs exist
  for (const id of orderedIds) {
    if (!cfg.spaces.some(s => s.id === id)) return null;
  }
  // Build new order: provided IDs first (in given order), then any remaining spaces
  const reordered: SpaceConfig[] = [];
  for (const id of orderedIds) {
    reordered.push(cfg.spaces.find(s => s.id === id)!);
  }
  for (const space of cfg.spaces) {
    if (!idSet.has(space.id)) reordered.push(space);
  }
  cfg.spaces = reordered;
  saveConfig(cfg);
  return reordered;
}

/** Generate a URL-safe space ID from a label */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || uuidv4().slice(0, 8);
}

/** Rename a space: renames all MongoDB collections, moves file directory,
 *  updates config references (networks, tokens, proxy spaces).
 *  Returns the updated SpaceConfig on success. */
export async function renameSpace(oldId: string, newId: string): Promise<SpaceConfig> {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === oldId);
  if (!space) throw new Error(`Space '${oldId}' not found`);
  if (space.builtIn) throw new Error(`Cannot rename built-in space '${oldId}'`);
  if (cfg.spaces.some(s => s.id === newId)) throw new Error(`Space '${newId}' already exists`);

  const db = getDb();
  const errors: string[] = [];

  // 1. Rename MongoDB collections ({oldId}_* → {newId}_*)
  const existingColls = await db.listCollections().toArray();
  const prefix = `${oldId}_`;
  for (const coll of existingColls.filter(c => c.name.startsWith(prefix))) {
    const suffix = coll.name.slice(prefix.length);
    const newName = `${newId}_${suffix}`;
    try {
      await db.collection(coll.name).rename(newName);
      log.debug(`Renamed collection ${coll.name} → ${newName}`);
    } catch (err) {
      const msg = `Could not rename collection ${coll.name} → ${newName}: ${err}`;
      log.warn(msg);
      errors.push(msg);
    }
  }

  // 2. Move the files directory
  const dataRoot = getDataRoot();
  const oldDir = path.resolve(dataRoot, 'files', oldId);
  const newDir = path.resolve(dataRoot, 'files', newId);
  try {
    await fs.access(oldDir);
    await fs.rename(oldDir, newDir);
    log.debug(`Moved files directory ${oldDir} → ${newDir}`);
  } catch (err) {
    // If old dir doesn't exist, that's fine — space might have no files
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      const msg = `Could not move files directory: ${err}`;
      log.warn(msg);
      errors.push(msg);
    }
  }

  // 3. Move chunked-upload directory if it exists
  const oldChunks = path.resolve(dataRoot, '.chunks', oldId);
  const newChunks = path.resolve(dataRoot, '.chunks', newId);
  try {
    await fs.access(oldChunks);
    await fs.rename(oldChunks, newChunks);
  } catch { /* ignore — chunks dir may not exist */ }

  if (errors.length > 0) {
    throw new Error(
      `Space '${oldId}' rename incomplete (${errors.length} error(s)). ` +
      `Config was NOT updated. Fix the underlying issue and retry. ` +
      `Errors: ${errors.join('; ')}`,
    );
  }

  // 4. Update the space config entry
  space.id = newId;

  // 5. Update spaceId in all docs within renamed collections
  //    (embedded spaceId field stays as-is — it's the space the doc was
  //    originally written in, which is fine for provenance tracking.
  //    Local lookups use collection names, not the embedded field.)

  // 6. Update network references
  for (const net of cfg.networks) {
    const idx = net.spaces.indexOf(oldId);
    if (idx !== -1) {
      net.spaces[idx] = newId;
      // Record in spaceMap so peers using the old ID can still sync.
      // If a mapping already pointed at oldId, update its target.
      if (!net.spaceMap) net.spaceMap = {};
      // Check if there's an existing mapping where oldId is already the value (rare: chained renames)
      for (const [remote, local] of Object.entries(net.spaceMap)) {
        if (local === oldId) {
          net.spaceMap[remote] = newId;
        }
      }
      // Add direct mapping: oldId → newId (an old ID in peer spoke may reference this)
      // Only add if oldId isn't already the target of another mapping AND
      // doesn't conflict with an existing remote key that maps elsewhere.
      if (!net.spaceMap[oldId] || net.spaceMap[oldId] === oldId) {
        net.spaceMap[oldId] = newId;
      }
    }

    // Update member watermark keys (lastSeqReceived / lastSeqPushed)
    for (const member of net.members) {
      if (member.lastSeqReceived?.[oldId] !== undefined) {
        member.lastSeqReceived[newId] = member.lastSeqReceived[oldId]!;
        delete member.lastSeqReceived[oldId];
      }
      if (member.lastSeqPushed?.[oldId] !== undefined) {
        member.lastSeqPushed[newId] = member.lastSeqPushed[oldId]!;
        delete member.lastSeqPushed[oldId];
      }
    }
  }

  // 7. Update token scopes
  for (const tok of cfg.tokens) {
    if (tok.spaces) {
      const idx = tok.spaces.indexOf(oldId);
      if (idx !== -1) tok.spaces[idx] = newId;
    }
  }

  // 8. Update proxy space references
  for (const s of cfg.spaces) {
    if (s.proxyFor) {
      const idx = s.proxyFor.indexOf(oldId);
      if (idx !== -1) s.proxyFor[idx] = newId;
    }
  }

  saveConfig(cfg);
  log.info(`Renamed space '${oldId}' → '${newId}'`);
  return space;
}
