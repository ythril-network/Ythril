/**
 * Recover a peer's file metadata onto the file row it was meant for, when that row was written by THIS instance by
 * default — the one write the stray-filemeta drain (`Q-219`) needs that no arrival does.
 *
 * ## Why a seq comparison cannot do it
 *
 * Through 5.5.x a receiver that pulled a peer's file bytes wrote the file row itself (`upsertFileMeta`), with its OWN
 * fresh seq, its own author, no description and empty tags. Q-143 stopped that in 5.6.0; the rows stayed. A counter
 * is bumped past every seq it has seen, so such a row outranks the peer's record, and a seq-accepted merge — what
 * 5.6.2's drain did — counts the peer's description as older and drops it.
 *
 * ## The rule
 *
 *  - **A row this instance made by default takes a FILL**: authored here, or naming no author, or at seq 0 (what
 *    `recordArrivedFile` writes when bytes land first). Each authored key the row lacks is set; nothing it has is
 *    changed, except that a machine-made description gives way to the publisher's human one and loses its machine
 *    label. Its seq, author and updatedAt are never touched: a receiver's write must not outrank the publisher's next
 *    edit, which is the Q-143 defect itself.
 *  - **Any other row was written by a peer** at a seq that peer stamped, so the normal seq accept applies: the record
 *    lands only over an older row. A field the publisher removed by a later, synced edit is therefore never restored.
 *  - **No row is ever created.** A stray record is old; a file with no row was usually deleted since.
 *
 * Every condition is in the update's own filter, so the store decides it at the write and a row deleted or edited
 * meanwhile is never overwritten. A merged file whose bytes are here is queued for embedding; the worker reads the
 * stored row, so a fill that retires the file from search removes its vector.
 *
 * Reached only through `writeArrivals` with `fillOnly`, the drain's call.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { authorRef } from '../config/author.js';
import { enqueueEmbedJob, EMBED_PRIORITY } from '../brain/embed-queue.js';
import { spillIdFromPath } from '../brain/spill-path.js';
import { IncomingFileMetaDoc } from '../api/sync/_shared.js';
import type { FileMetaDoc } from '../config/types.js';

/** What a stray record did to its file row. */
export type StrayFileMetaOutcome =
  /** It set at least one key. */
  | 'merged'
  /** The row this instance made already had everything the record could give it. */
  | 'complete'
  /** A peer-written row at or above the record's seq: the record is older. */
  | 'newer'
  /** There is no row for it, so nothing was written. */
  | 'no-file'
  /** A legacy read spill, which travels in neither direction. */
  | 'derived';

/** Long enough for any single-document write, short enough that one stuck write cannot hold the sweep cycle. */
const WRITE_MS = 30_000;
const MACHINE_SOURCES = ['generated', 'extracted'];

type Incoming = Record<string, unknown> & { _id: string; seq?: number };

/** A field's value only when the push door's own schema would accept it — no second copy of the schema. */
function accepted<K extends keyof typeof IncomingFileMetaDoc.shape>(key: K, value: unknown): boolean {
  return value !== undefined && IncomingFileMetaDoc.shape[key].safeParse(value).success;
}

const missing = (field: string) => ({ $eq: [{ $type: `$${field}` }, 'missing'] });

/** The aggregation-pipeline update that sets each authored key the row lacks, or null when the record has none. */
function fillUpdate(incoming: Incoming): object[] | null {
  const set: Record<string, unknown> = {};
  if (accepted('description', incoming['description'])) {
    const human = !accepted('descriptionSource', incoming['descriptionSource']);
    const take = { $or: [missing('description'), ...(human ? [{ $in: ['$descriptionSource', MACHINE_SOURCES] }] : [])] };
    set['description'] = { $cond: [take, { $literal: incoming['description'] }, '$description'] };
    // The label moves with the text, as `updateFileMeta` does: a human description carries none.
    set['descriptionSource'] = { $cond: [take, human ? '$$REMOVE' : { $literal: incoming['descriptionSource'] }, '$descriptionSource'] };
  }
  const tags = incoming['tags'];
  if (accepted('tags', tags) && (tags as unknown[]).length > 0) {
    set['tags'] = { $cond: [{ $eq: [{ $size: { $ifNull: ['$tags', []] } }, 0] }, { $literal: tags }, '$tags'] };
  }
  if (accepted('properties', incoming['properties'])) set['properties'] = { $ifNull: ['$properties', { $literal: incoming['properties'] }] };
  if (accepted('suppressEmbeddings', incoming['suppressEmbeddings'])) {
    set['suppressEmbeddings'] = { $ifNull: ['$suppressEmbeddings', { $literal: incoming['suppressEmbeddings'] }] };
  }
  return Object.keys(set).length > 0 ? [{ $set: set }] : null;
}

/** Recover one stray record onto its file row. See the module docblock for the rule. */
export async function fillFileMetaFromStray(spaceId: string, incoming: Incoming): Promise<StrayFileMetaOutcome> {
  if (spillIdFromPath(String(incoming._id))) return 'derived';
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const receiverMade = {
    $or: [
      { 'author.instanceId': authorRef().instanceId ?? null },
      { author: { $exists: false } },
      { seq: { $exists: false } },
      { seq: 0 },
    ],
  };
  const filled = await fillReceiverMadeRow(spaceId, incoming, receiverMade);
  if (filled) return filled;

  // A peer-written row: the normal accept, at the write — the record lands only over an older row.
  if (typeof incoming.seq === 'number') {
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) if (v !== undefined) $set[k] = v;
    const r = await files.updateOne(
      asFilter<FileMetaDoc>({ _id: incoming._id, seq: { $lt: incoming.seq } } as never),
      asUpdate<FileMetaDoc>({ $set }),
      { upsert: false, maxTimeMS: WRITE_MS },
    );
    if (r.matchedCount > 0) {
      await queueIfHeld(spaceId, incoming._id);
      return 'merged';
    }
  }
  const here = await files.findOne(asFilter<FileMetaDoc>({ _id: incoming._id }), { projection: { _id: 1 }, maxTimeMS: WRITE_MS });
  return here ? 'newer' : 'no-file';
}

/** The fill of a row this instance made, or null when no such row exists. */
async function fillReceiverMadeRow(spaceId: string, incoming: Incoming, receiverMade: object): Promise<StrayFileMetaOutcome | null> {
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const filter = asFilter<FileMetaDoc>({ _id: incoming._id, ...receiverMade } as never);
  const update = fillUpdate(incoming);
  if (!update) {
    return (await files.findOne(filter, { projection: { _id: 1 }, maxTimeMS: WRITE_MS })) ? 'complete' : null;
  }
  // A pipeline that changes nothing reports no modification, which is exactly "already complete".
  const r = await files.updateOne(filter, update as never, { upsert: false, maxTimeMS: WRITE_MS });
  if (r.matchedCount === 0) return null;
  if (r.modifiedCount === 0) return 'complete';
  await queueIfHeld(spaceId, incoming._id);
  return 'merged';
}

/**
 * Queue a merged file for embedding when its bytes are here. The job, not this function, reads the stored row, so a
 * fill that set `suppressEmbeddings` is honoured — and its vector removed — by the worker. Never throws: the queue's
 * own failure is logged there, and the fill has landed either way.
 */
async function queueIfHeld(spaceId: string, id: string): Promise<void> {
  const row = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .findOne(asFilter<FileMetaDoc>({ _id: id }), { projection: { sha256: 1, sizeBytes: 1 }, maxTimeMS: WRITE_MS });
  if (row?.sha256 === undefined && row?.sizeBytes === undefined) return;
  await enqueueEmbedJob(spaceId, 'file', id, { priority: EMBED_PRIORITY.background });
}
