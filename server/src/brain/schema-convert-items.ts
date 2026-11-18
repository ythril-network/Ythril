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
import { readMetaForWrite, carriedStampOf, SCHEMA_FINGERPRINT_FIELD } from '../spaces/schema-stamp.js';
import { TYPE_FIELD } from './ttl.js';
import { CHOSEN_VERSION_ROWS } from './chosen-versions.js';
import { pageMemberList, type ListPage, type ListPageRequest } from './list-page.js';
import { defaultBudgetChars } from './result-budget.js';
import { peerText } from '../util/log.js';
import { isPlainObject } from '../util/plain-object.js';
import { UNCONVERTED_REASONS, UNCONVERTED_DISMISS_MAX, type UnconvertedReason, type UnconvertedItem } from '../spaces/unconverted-terms.js';

// What an item is, its reason classes and the bulk dismissal's bound are terms the store, the acts and both doors share (`spaces/unconverted-terms.ts`);
// re-exported for the readers that name them here.
export { UNCONVERTED_REASONS, UNCONVERTED_DISMISS_MAX, type UnconvertedReason, type UnconvertedItem };

/** The most violations one item names. */
export const UNCONVERTED_VIOLATIONS_MAX = 20;
/** The most items one run writes; past it the run counts what it did not list (`unconvertedNotListed`). */
export const UNCONVERTED_ITEMS_PER_RUN_MAX = 10_000;
/** The most items one tick of the watcher judges in one space. */
export const UNCONVERTED_SWEEP_PER_TICK = 500;
/** The longest reason an item keeps for one violation. */
const REASON_MAX = 300;
/** Hex characters of an item id: half a sha-256, as unique per space as a record id needs. */
const ITEM_ID_HEX = 32;
/** The page size a list states none for, and the largest it serves. */
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

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
  return createHash('sha256').update(`${kind}|${recordId}`).digest('hex').slice(0, ITEM_ID_HEX);
}

/**
 * The hash of how `meta` defines type `type` of `kind`: the type's resolved definition and the space rules that govern the kind. Two metas
 * that give the type the same definition and the kind the same space rules hash alike; a change anywhere else does not move it.
 */
export function typeDefinitionOf(meta: SpaceMeta | undefined, kind: KnowledgeType, type: string): string {
  const types = isPlainObject(meta?.typeSchemas) ? (meta!.typeSchemas as Record<string, unknown>)[kind] : undefined;
  const definition = isPlainObject(types) ? (types as Record<string, unknown>)[type] ?? null : null;
  // A map, so the canonical text orders the rules by name whatever order the meta holds them in.
  const spaceRules = Object.fromEntries(rulesIn((meta as Record<string, unknown> | undefined)?.['rules'])
    .filter(([, r]) => spaceRuleKinds(r).includes(kind)));
  return createHash('sha256').update(String(canonicalJson({ definition, spaceRules }))).digest('hex');
}

const recordSeq = (record: { seq?: unknown }): number | null => (typeof record.seq === 'number' ? record.seq : null);
const recordStamp = (record: Record<string, unknown>): string | null => carriedStampOf(record) ?? null;
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

/** An item as a list gives it: the stored item and, when the caller's `enrich` found one, a part naming its record. */
export type ListedUnconvertedItem = UnconvertedItem & { record?: { summary: string } };

/** What a list of the items answers: the page, its fields, and how many rows are open and dismissed in the whole space. */
export type UnconvertedList =
  | { ok: true; items: ListedUnconvertedItem[]; fields: Record<string, unknown>; open: number; dismissed: number }
  | { ok: false; error: string };

/** What narrows a list of the items, and what a bulk dismiss takes: the one set of fields both read, so a count shown and a set dismissed are one question. */
export interface UnconvertedFilter {
  kind?: string;
  type?: string;
  reason?: UnconvertedReason;
  status?: UnconvertedItem['status'];
}

/** The stored-item filter of `f`: a field not given, or given empty, narrows nothing. */
const filterOf = (f: UnconvertedFilter): Record<string, unknown> => ({
  ...(f.status !== undefined ? { status: f.status } : {}),
  ...(typeof f.kind === 'string' && f.kind !== '' ? { kind: f.kind } : {}),
  ...(typeof f.type === 'string' && f.type !== '' ? { type: f.type } : {}),
  ...(f.reason !== undefined ? { reason: f.reason } : {}),
});

/**
 * The items of `spaceId`, newest first, narrowed by `kind`, `type`, `reason` and `status` (all of them when none is given, so the filter is the
 * caller's to state: the door's act states `open` by default), paged by the one list rule (`skip`, `limit`, the byte budget). Writes
 * nothing: a stale item is listed until the watcher's tick removes it. `transport` names the door, whose budget default applies.
 *
 * `enrich` adds to the rows read for the page before the byte budget is applied, so what it adds is counted in the bytes the answer reports
 * and in where the page is cut (the door's `record.summary`); it never changes which rows are listed, their order or the totals.
 */
export async function listUnconvertedItems(
  spaceId: string, req: ListPageRequest & UnconvertedFilter, transport: 'rest' | 'mcp' = 'rest',
  enrich?: (rows: UnconvertedItem[]) => Promise<ListedUnconvertedItem[]>,
): Promise<UnconvertedList> {
  const filter = filterOf(req);
  const page: ListPage<ListedUnconvertedItem> = await pageMemberList<ListedUnconvertedItem>({
    members: [spaceId],
    readMember: async (id, limit, skip) => {
      const rows = await items(id).find(asFilter<UnconvertedItem>(filter))
        .sort({ detectedAt: -1, _id: 1 }).skip(skip).limit(limit).toArray() as UnconvertedItem[];
      return enrich ? await enrich(rows) : rows;
    },
    countMember: id => items(id).countDocuments(asFilter<UnconvertedItem>(filter)),
    compare: (a, b) => b.detectedAt.localeCompare(a.detectedAt) || a._id.localeCompare(b._id),
    req,
    page: { defaultLimit: LIST_DEFAULT_LIMIT, maxLimit: LIST_MAX_LIMIT, budgetChars: defaultBudgetChars(transport) },
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

/** What a bulk dismiss answers: how many items it dismissed, or why it did none (`changed`: the open items the filter matches are not `expect`; `too_many`: more than `max`). */
export type DismissShownOutcome =
  | { ok: true; dismissed: number }
  | { ok: false; refusal: 'changed'; current: number }
  | { ok: false; refusal: 'too_many'; max: number };

/**
 * Dismiss every OPEN item `filter` matches (its `status` is ignored: only open items are dismissed), when there are exactly `expect` of them and
 * no more than `max`: the one question the list asks with `status: 'open'`, so a count a caller was shown and the set dismissed are the same
 * rows. The ids are read once and named in one update that dismisses only those still open, so an item that arrives after the read is never
 * dismissed by a count it was not part of; a refusal writes nothing. Answers how many the update dismissed (an item the sweep removed between
 * the read and the update is not counted).
 */
export async function dismissOpenUnconvertedItems(
  spaceId: string, filter: UnconvertedFilter, expect: number, max = UNCONVERTED_DISMISS_MAX,
): Promise<DismissShownOutcome> {
  const matching = { ...filterOf({ ...filter, status: 'open' }) };
  const rows = await items(spaceId).find(asFilter<UnconvertedItem>(matching), { projection: { _id: 1 } }).limit(max + 1).toArray();
  if (rows.length > max) return { ok: false, refusal: 'too_many', max };
  if (rows.length !== expect) return { ok: false, refusal: 'changed', current: rows.length };
  if (rows.length === 0) return { ok: true, dismissed: 0 };
  const done = await items(spaceId).updateMany(
    asFilter<UnconvertedItem>({ _id: { $in: rows.map(r => r._id) }, status: 'open' }),
    asUpdate<UnconvertedItem>({ $set: { status: 'dismissed' } }),
  );
  return { ok: true, dismissed: done.modifiedCount };
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
      { _id: 1, seq: 1, [SCHEMA_FINGERPRINT_FIELD]: 1 }, { filter: CHOSEN_VERSION_ROWS });   // an item names a record, never a fork row of one
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
