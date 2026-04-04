import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getConfig } from '../config/loader.js';
import type { ChronoEntry, ChronoKind, ChronoStatus, TombstoneDoc } from '../config/types.js';

function authorRef() {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Derive the text to embed for a chrono entry (title + optional description). */
function chronoEmbedText(title: string, description?: string): string {
  return description ? `${title} ${description}` : title;
}

export async function createChrono(
  spaceId: string,
  fields: {
    title: string;
    kind: ChronoKind;
    startsAt: string;
    description?: string;
    endsAt?: string;
    status?: ChronoStatus;
    confidence?: number;
    tags?: string[];
    entityIds?: string[];
    memoryIds?: string[];
    recurrence?: ChronoEntry['recurrence'];
  },
): Promise<ChronoEntry> {
  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  // Embed title + description (best-effort)
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const embResult = await embed(chronoEmbedText(fields.title, fields.description));
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
  } catch { /* embedding unavailable — chrono stored without vector */ }

  const doc: ChronoEntry = {
    _id: uuidv4(),
    spaceId,
    title: fields.title,
    kind: fields.kind,
    startsAt: fields.startsAt,
    status: fields.status ?? 'upcoming',
    tags: fields.tags ?? [],
    entityIds: fields.entityIds ?? [],
    memoryIds: fields.memoryIds ?? [],
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    ...embeddingFields,
  };
  if (fields.description !== undefined) doc.description = fields.description;
  if (fields.endsAt !== undefined) doc.endsAt = fields.endsAt;
  if (fields.confidence !== undefined) doc.confidence = fields.confidence;
  if (fields.recurrence !== undefined) doc.recurrence = fields.recurrence;

  await col<ChronoEntry>(`${spaceId}_chrono`).insertOne(doc as never);
  return doc;
}

export async function updateChrono(
  spaceId: string,
  id: string,
  updates: Partial<Pick<ChronoEntry, 'title' | 'description' | 'kind' | 'startsAt' | 'endsAt' | 'status' | 'confidence' | 'tags' | 'entityIds' | 'memoryIds' | 'recurrence'>>,
): Promise<ChronoEntry | null> {
  const existing = await col<ChronoEntry>(`${spaceId}_chrono`).findOne({ _id: id, spaceId } as never) as ChronoEntry | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) $set[k] = v;
  }

  // Re-embed if title or description changes
  if (updates.title !== undefined || updates.description !== undefined) {
    const newTitle = updates.title ?? existing.title;
    const newDesc = updates.description !== undefined ? updates.description : existing.description;
    try {
      const embResult = await embed(chronoEmbedText(newTitle, newDesc));
      $set['embedding'] = embResult.vector;
      $set['embeddingModel'] = embResult.model;
    } catch { /* embedding unavailable — keep existing embedding */ }
  }

  await col<ChronoEntry>(`${spaceId}_chrono`).updateOne(
    { _id: id } as never,
    { $set } as never,
  );
  return { ...existing, ...($set as Partial<ChronoEntry>) } as ChronoEntry;
}

export async function getChronoById(spaceId: string, id: string): Promise<ChronoEntry | null> {
  return col<ChronoEntry>(`${spaceId}_chrono`).findOne({ _id: id, spaceId } as never) as Promise<ChronoEntry | null>;
}

export async function listChrono(
  spaceId: string,
  filter: Record<string, unknown> = {},
  limit = 50,
  skip = 0,
): Promise<ChronoEntry[]> {
  return col<ChronoEntry>(`${spaceId}_chrono`)
    .find({ ...filter, spaceId } as never)
    .sort({ startsAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray() as Promise<ChronoEntry[]>;
}

export async function deleteChrono(
  spaceId: string,
  chronoId: string,
): Promise<boolean> {
  const seq = await nextSeq(spaceId);
  const result = await col<ChronoEntry>(`${spaceId}_chrono`).deleteOne({
    _id: chronoId,
    spaceId,
  } as never);
  if (result.deletedCount === 0) return false;

  const tombstone: TombstoneDoc = {
    _id: chronoId,
    type: 'chrono',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    { _id: chronoId } as never,
    tombstone as never,
    { upsert: true },
  );
  return true;
}

/** Bulk-delete all chrono entries in a space, writing a tombstone per deleted doc. */
export async function bulkDeleteChrono(spaceId: string): Promise<number> {
  const coll = col<ChronoEntry>(`${spaceId}_chrono`);
  const ids = await coll.find({}, { projection: { _id: 1 } }).toArray();
  if (ids.length === 0) return 0;

  const now = new Date().toISOString();
  const instanceId = getConfig().instanceId;
  const tombstones: TombstoneDoc[] = [];

  for (const doc of ids) {
    const seq = await nextSeq(spaceId);
    tombstones.push({
      _id: doc._id,
      type: 'chrono',
      spaceId,
      deletedAt: now,
      instanceId,
      seq,
    });
  }

  const ops = tombstones.map(t => ({
    replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true },
  }));
  await col<TombstoneDoc>(`${spaceId}_tombstones`).bulkWrite(ops as never);
  await coll.deleteMany({});
  return ids.length;
}
