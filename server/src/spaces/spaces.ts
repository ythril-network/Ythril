import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { getDb, col } from '../db/mongo.js';
import { getConfig, saveConfig, getEmbeddingConfig, getDataRoot } from '../config/loader.js';
import { ensureSpaceFilesDir } from '../files/files.js';
import { log } from '../util/log.js';
import type { SpaceConfig, MemoryDoc } from '../config/types.js';

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
  await entitiesColl.createIndex({ spaceId: 1, name: 1, type: 1 }, { unique: true });
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
  minGiB?: number;
  proxyFor?: string[];
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
    minGiB: opts.minGiB,
    description: opts.description,
    ...(opts.proxyFor ? { proxyFor: opts.proxyFor } : {}),
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

export interface WipeResult {
  memories: number;
  entities: number;
  edges: number;
  chrono: number;
  files: number;
}

/** Wipe all data from a space — memories, entities, edges, chrono, file metadata,
 *  and the physical files directory — while preserving the space itself (label,
 *  description, config, OIDC mappings, quota settings).
 *
 *  Idempotent: wiping an already-empty space returns all-zero counts without error.
 *  Scoped strictly to the target space — no cross-space side effects.
 *
 *  The returned counts reflect the number of documents actually deleted.
 *  Tombstones are also cleared (internal sync state) but not included in the result.
 */
export async function wipeSpace(spaceId: string): Promise<WipeResult> {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) throw new Error(`Space '${spaceId}' not found`);

  // Guard: spaceId must match the safe pattern used during creation so it is
  // safe to embed in a filesystem path (same constraint as removeSpace).
  if (!/^[a-z0-9-]+$/.test(spaceId)) {
    throw new Error(`Invalid spaceId '${spaceId}'`);
  }

  const [memRes, entRes, edgeRes, chronoRes, fileRes] = await Promise.all([
    col(`${spaceId}_memories`).deleteMany({}),
    col(`${spaceId}_entities`).deleteMany({}),
    col(`${spaceId}_edges`).deleteMany({}),
    col(`${spaceId}_chrono`).deleteMany({}),
    col(`${spaceId}_files`).deleteMany({}),
  ]);
  // Tombstones are internal sync state — clear them too but don't report the count
  await col(`${spaceId}_tombstones`).deleteMany({});

  // Delete the physical files directory, then recreate it empty
  const filesDir = path.resolve(getDataRoot(), 'files', spaceId);
  try {
    await fs.rm(filesDir, { recursive: true, force: true });
    await fs.mkdir(filesDir, { recursive: true });
  } catch (err) {
    log.warn(`wipeSpace: could not clear files directory for '${spaceId}': ${err}`);
  }

  const result: WipeResult = {
    memories: memRes.deletedCount,
    entities: entRes.deletedCount,
    edges: edgeRes.deletedCount,
    chrono: chronoRes.deletedCount,
    files: fileRes.deletedCount,
  };
  log.info(`Wiped space '${spaceId}': ${result.memories} memories, ${result.entities} entities, ${result.edges} edges, ${result.chrono} chrono, ${result.files} files`);
  return result;
}

/** Update mutable fields (label, description) of an existing space in config.
 *  Returns the updated SpaceConfig, or null if the space was not found. */
export function updateSpace(
  spaceId: string,
  updates: { label?: string; description?: string },
): SpaceConfig | null {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return null;
  if (typeof updates.label === 'string') space.label = updates.label;
  if (typeof updates.description === 'string') space.description = updates.description;
  saveConfig(cfg);
  return space;
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
