/**
 * The records a schema conversion run could not convert, as review items (Q-746 writes them, Q-919 lists and dismisses them): written, judged
 * stale, swept, listed and dismissed, in `<space>_schema_convert_items`.
 *
 * ## What it prevents
 *
 * - **A record listed twice, or listed again after it was dismissed.** One item per record (`_id` is a hash of its kind and id), and an item
 *   dismissed for one `(record version, target fingerprint)` is never re-opened by a run that meets the same version toward the same target.
 * - **A list that empties on every schema write, or keeps items nobody can act on** (design S9). An item is stale when its record is gone, written
 *   since (its version is not the item's), carries the space's fingerprint now, or its TYPE is defined differently now than when the item was
 *   written: judged per type, so a change to another type, a library edit of another entry or a layer pull of another type leaves it.
 * - **A read that writes** (design N5). Stale items are removed only by {@link sweepStaleUnconvertedItems}, which the run module's watcher tick
 *   calls; {@link listUnconvertedItems} reads.
 * - **A value of a record copied into a finding.** An item names the violated fields and the reasons, never a stored value, and holds at most
 *   {@link UNCONVERTED_VIOLATIONS_MAX} of them.
 *
 * Local: never synced, never hashed, exempt from the write gate (a restore drops it and never loads it, `db/restore-act.ts`), so a record no
 * member can convert is listed on each member that holds it.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, spaceRuleKinds, rulesIn } from '@ythril-network/schema/internal';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { idKeysetPage } from '../db/id-keyset-page.js';
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { COLLECTION_SUFFIX } from '../config/types-knowledge.js';
import type { KnowledgeType, SpaceMeta } from '../config/types.js';
import { readMetaForWrite } from '../spaces/schema-stamp.js';
import { TYPE_FIELD } from './ttl.js';
import { pageMemberList, type ListPage, type ListPageRequest } from './list-page.js';
import { defaultBudgetChars } from './result-budget.js';
import { peerText } from '../util/log.js';
import { isPlainObject } from '../util/plain-object.js';

/** Why a record was not converted. `could_not_evaluate` is a split condition the engine could not answer on the record (its own class). */
export type UnconvertedReason =
  | 'not_conforming' | 'no_case_matched' | 'both_set' | 'could_not_evaluate'
  | 'relationship_exists' | 'functional_taken' | 'version_ceiling' | 'fork' | 'step_refused';

/** The most violations one item names. */
export const UNCONVERTED_VIOLATIONS_MAX = 20;
/** The most items one run writes; past it the run counts what it did not list (`unconvertedNotListed`). */
export const UNCONVERTED_ITEMS_PER_RUN_MAX = 10_000;
/** The most items one tick of the watcher judges in one space. */
export const UNCONVERTED_SWEEP_PER_TICK = 500;
/** The longest reason an item keeps for one violation. */
const REASON_MAX = 300;

/** One record a conversion could not convert, as stored. */
export interface UnconvertedItem {
  _id: string;
  kind: KnowledgeType;
  recordId: string;
  type: string;
  /** The record's version when the run read it (`null`: it carried none). */
  seq: number | null;
  /** The stamp the record carried when the run read it. */
  fromFp: string | null;
  /** The fingerprint the run converted toward. */
  toFp: string;
  /** What the record's type was under `toFp`: the hash its staleness is judged by ({@link typeDefinitionOf}). */
  typeDefinition: string;
  reason: UnconvertedReason;
  violations: { field: string; reason: string }[];
  /** What the steps would have made of it: the new type, and the property names set and removed. */
  proposed: { type?: string; set: string[]; unset: string[] };
  status: 'open' | 'dismissed';
  detectedAt: string;
}

/** What a run hands in for one record it could not convert. */
export interface UnconvertedInput {
  kind: KnowledgeType;
  record: { _id: string; seq?: unknown; [field: string]: unknown };
  toFp: string;
  reason: UnconvertedReason;
  violations?: readonly { field: string; reason: string }[];
  proposed?: { type?: string; set?: Record<string, unknown> | readonly string[]; unset?: readonly string[] };
}

const items = (spaceId: string) => col<UnconvertedItem>(spaceCollection(spaceId, 'schemaConvertItems'));

/** The id of the one item of record `recordId` of `kind`: the same record is always the same item. */
export function unconvertedItemId(kind: KnowledgeType, recordId: string): string {
  return createHash('sha256').update(`${kind}|${recordId}`).digest('hex').slice(0, 32);
}

/**
 * The hash of how `meta` defines type `type` of `kind`: the type's resolved definition and the space rules that govern the kind. Two metas
 * that give the type the same definition and the kind the same space rules hash alike; a change anywhere else does not move it.
 */
export function typeDefinitionOf(meta: SpaceMeta | undefined, kind: KnowledgeType, type: string): string {
  const types = isPlainObject(meta?.typeSchemas) ? (meta!.typeSchemas as Record<string, unknown>)[kind] : undefined;
  const definition = isPlainObject(types) ? (types as Record<string, unknown>)[type] ?? null : null;
  const spaceRules = rulesIn((meta as Record<string, unknown> | undefined)?.['rules'])
    .filter(([, r]) => spaceRuleKinds(r).includes(kind))
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(String(canonicalJson({ definition, spaceRules }))).digest('hex');
}

const recordSeq = (record: { seq?: unknown }): number | null => (typeof record.seq === 'number' ? record.seq : null);
const recordStamp = (record: Record<string, unknown>): string | null => (typeof record['schemaFingerprint'] === 'string' ? record['schemaFingerprint'] : null);
const recordType = (kind: KnowledgeType, record: Record<string, unknown>): string => String(record[TYPE_FIELD[kind]] ?? '');

/**
 * Write the item of a record a run could not convert, against the meta the run converted toward (`meta`, resolved).
 *
 * @returns `written` (a new or an updated open item), `kept` (the same open item for the same version and target was already there) or
 *   `dismissed` (an operator dismissed this record at this version toward this target: it stays dismissed).
 */
export async function recordUnconvertedItem(spaceId: string, input: UnconvertedInput, meta: SpaceMeta | undefined): Promise<'written' | 'kept' | 'dismissed'> {
  const id = unconvertedItemId(input.kind, input.record._id);
  const seq = recordSeq(input.record);
  const held = await items(spaceId).findOne(asFilter<UnconvertedItem>({ _id: id })) as UnconvertedItem | null;
  if (held && held.seq === seq && held.toFp === input.toFp) return held.status === 'dismissed' ? 'dismissed' : 'kept';
  const type = recordType(input.kind, input.record);
  const set = input.proposed?.set;
  const doc: UnconvertedItem = {
    _id: id,
    kind: input.kind,
    recordId: input.record._id,
    type,
    seq,
    fromFp: recordStamp(input.record),
    toFp: input.toFp,
    typeDefinition: typeDefinitionOf(meta, input.kind, type),
    reason: input.reason,
    violations: (input.violations ?? []).slice(0, UNCONVERTED_VIOLATIONS_MAX)
      .map(v => ({ field: peerText(v.field, { max: REASON_MAX }), reason: peerText(v.reason, { max: REASON_MAX }) })),
    proposed: {
      ...(input.proposed?.type !== undefined ? { type: input.proposed.type } : {}),
      set: Array.isArray(set) ? [...set] : Object.keys(set ?? {}),
      unset: [...(input.proposed?.unset ?? [])],
    },
    status: 'open',
    detectedAt: new Date().toISOString(),
  };
  await items(spaceId).replaceOne(asFilter<UnconvertedItem>({ _id: id }), doc, { upsert: true });
  return 'written';
}

/** What a list of the items answers: the page, its fields, and how many rows are open and dismissed in the whole space. */
export type UnconvertedList =
  | { ok: true; items: UnconvertedItem[]; fields: Record<string, unknown>; open: number; dismissed: number }
  | { ok: false; error: string };

/**
 * The items of `spaceId`, newest first, narrowed by `kind` and `type`, paged by the one list rule (`skip`, `limit`, the byte budget). Writes
 * nothing: a stale item is listed until the watcher's tick removes it. `transport` names the door, whose budget default applies.
 */
export async function listUnconvertedItems(
  spaceId: string, req: ListPageRequest & { kind?: string; type?: string }, transport: 'rest' | 'mcp' = 'rest',
): Promise<UnconvertedList> {
  const filter: Record<string, unknown> = {
    ...(typeof req.kind === 'string' && req.kind !== '' ? { kind: req.kind } : {}),
    ...(typeof req.type === 'string' && req.type !== '' ? { type: req.type } : {}),
  };
  const page: ListPage<UnconvertedItem> = await pageMemberList<UnconvertedItem>({
    members: [spaceId],
    readMember: async (id, limit, skip) => await items(id).find(asFilter<UnconvertedItem>(filter))
      .sort({ detectedAt: -1, _id: 1 }).skip(skip).limit(limit).toArray() as UnconvertedItem[],
    countMember: id => items(id).countDocuments(asFilter<UnconvertedItem>(filter)),
    compare: (a, b) => b.detectedAt.localeCompare(a.detectedAt) || a._id.localeCompare(b._id),
    req,
    page: { defaultLimit: 100, maxLimit: 500, budgetChars: defaultBudgetChars(transport) },
    ceiling: UNCONVERTED_ITEMS_PER_RUN_MAX,
  });
  if (!page.ok) return page;
  const [open, dismissed] = await Promise.all([
    items(spaceId).countDocuments(asFilter<UnconvertedItem>({ status: 'open' })),
    items(spaceId).countDocuments(asFilter<UnconvertedItem>({ status: 'dismissed' })),
  ]);
  return { ok: true, items: page.rows, fields: page.fields, open, dismissed };
}

/** Dismiss item `itemId` of `spaceId`: it stays, `dismissed`, and is not re-opened for the same record version and target. `null`: no such item. */
export async function dismissUnconvertedItem(spaceId: string, itemId: string): Promise<UnconvertedItem | null> {
  return await items(spaceId).findOneAndUpdate(
    asFilter<UnconvertedItem>({ _id: itemId }),
    asUpdate<UnconvertedItem>({ $set: { status: 'dismissed' } }),
    { returnDocument: 'after' },
  ) as UnconvertedItem | null;
}

/** Per space, the last item id a sweep judged when it stopped at its bound (in memory: a restart judges from the start). */
const sweptUpTo = new Map<string, string>();

/** How many items `spaceId` holds (any status): what the watcher asks before it judges a space's items at all. */
export async function hasUnconvertedItems(spaceId: string): Promise<boolean> {
  return (await items(spaceId).countDocuments(asFilter<UnconvertedItem>({}), { limit: 1 })) > 0;
}

/**
 * Remove the stale items of `spaceId`, open or dismissed, at most `limit` judged: an item whose record is gone, whose record's version is not
 * the item's, whose record carries the space's fingerprint now, or whose type is defined differently now ({@link typeDefinitionOf}). One read
 * of the items, one of their records per kind, one delete. Answers how many it removed.
 */
export async function sweepStaleUnconvertedItems(spaceId: string, limit = UNCONVERTED_SWEEP_PER_TICK): Promise<number> {
  // Where the last tick stopped in this space, so a space with more items than one tick judges has every item judged in turn; from the start
  // again once a tick reaches the end.
  const judged = await idKeysetPage<Pick<UnconvertedItem, '_id' | 'kind' | 'recordId' | 'type' | 'seq' | 'typeDefinition'>>({
    collection: spaceCollection(spaceId, 'schemaConvertItems'), filter: {},
    projection: { _id: 1, kind: 1, recordId: 1, type: 1, seq: 1, typeDefinition: 1 }, size: limit,
  }, sweptUpTo.get(spaceId));
  if (judged.end || judged.last === undefined) sweptUpTo.delete(spaceId); else sweptUpTo.set(spaceId, judged.last);
  const page = judged.rows;
  if (page.length === 0) return 0;
  const now = readMetaForWrite(spaceId);
  const definitionNow = new Map<string, string>();
  const stale: string[] = [];
  const byKind = new Map<KnowledgeType, typeof page>();
  for (const item of page) (byKind.get(item.kind) ?? byKind.set(item.kind, []).get(item.kind)!).push(item);
  for (const [kind, kindItems] of byKind) {
    const byId = await readStoredById<Record<string, unknown>>(spaceCollection(spaceId, COLLECTION_SUFFIX[kind]), kindItems.map(i => i.recordId),
      { _id: 1, seq: 1, schemaFingerprint: 1 });
    for (const item of kindItems) {
      const record = byId.get(item.recordId);
      const key = `${kind}\u0000${item.type}`;
      if (!definitionNow.has(key)) definitionNow.set(key, typeDefinitionOf(now.meta, kind, item.type));
      if (!record
        || recordSeq(record) !== item.seq
        || recordStamp(record) === now.stamp.fp
        || definitionNow.get(key) !== item.typeDefinition) stale.push(item._id);
    }
  }
  if (stale.length === 0) return 0;
  const done = await items(spaceId).deleteMany(asFilter<UnconvertedItem>({ _id: { $in: stale } }));
  return done.deletedCount;
}
