import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/mongo.js';
import { getConfig, saveConfig, getEmbeddingConfig } from '../config/loader.js';
import { ensureSpaceFilesDir } from '../files/files.js';
import { log } from '../util/log.js';
import type { SpaceConfig } from '../config/types.js';

const SPACE_COLLECTIONS = ['memories', 'entities', 'edges', 'tombstones'] as const;

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
      log.info(`Created collection ${name}`);
    }
  }

  // Regular indexes
  const memoriesColl = db.collection(`${spaceId}_memories`);
  const entitiesColl = db.collection(`${spaceId}_entities`);
  const edgesColl = db.collection(`${spaceId}_edges`);
  const tombstonesColl = db.collection(`${spaceId}_tombstones`);

  await memoriesColl.createIndex({ spaceId: 1, seq: 1 });
  await memoriesColl.createIndex({ spaceId: 1, tags: 1 });
  await memoriesColl.createIndex({ spaceId: 1, entityIds: 1 });
  await entitiesColl.createIndex({ spaceId: 1, name: 1, type: 1 }, { unique: true });
  await entitiesColl.createIndex({ spaceId: 1, seq: 1 });
  await edgesColl.createIndex({ spaceId: 1, from: 1, to: 1, label: 1 }, { unique: true });
  await edgesColl.createIndex({ spaceId: 1, seq: 1 });
  await tombstonesColl.createIndex({ spaceId: 1, seq: 1 });

  // Vector search index (Atlas Local / Atlas)
  await ensureVectorSearchIndex(spaceId, embCfg.dimensions, embCfg.similarity);

  // Ensure files directory exists
  await ensureSpaceFilesDir(spaceId);
}

/**
 * Create or validate the $vectorSearch index for a space's memories collection.
 * Polls for READY status up to 60 seconds.
 */
async function ensureVectorSearchIndex(
  spaceId: string,
  numDimensions: number,
  similarity: string,
): Promise<void> {
  const db = getDb();
  const coll = db.collection(`${spaceId}_memories`);
  const indexName = `${spaceId}_memories_embedding`;

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
    log.info(`Recreating vector search index ${indexName} (dimensions changed: ${existingDims} → ${numDimensions})`);
    try {
      await coll.dropSearchIndex(indexName);
      // Wait for drop to propagate
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      log.warn(`Failed to drop vector search index ${indexName}: ${err}`);
    }
  }

  log.info(`Creating vector search index ${indexName} (${numDimensions}d, ${similarity})`);
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
        log.info(`Vector search index ${indexName} is READY`);
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
    log.info(`Initialising space: ${space.id}`);
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
  folders?: string[];
  minGiB?: number;
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
  };
  cfg.spaces.push(space);
  saveConfig(cfg);
  await initSpace(opts.id);
  return space;
}

/** Delete a space (config only — data retained unless explicitly purged) */
export async function removeSpace(spaceId: string): Promise<boolean> {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return false;
  if (space.builtIn) throw new Error(`Cannot delete built-in space '${spaceId}'`);
  cfg.spaces = cfg.spaces.filter(s => s.id !== spaceId);
  saveConfig(cfg);
  return true;
}

/** Generate a URL-safe space ID from a label */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || uuidv4().slice(0, 8);
}
