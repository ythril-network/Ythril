/**
 * The records a schema conversion could not convert, listed and dismissed (Q-919, bundle-284 design r5 sections 2.3 and 6): the acts behind
 * `GET /api/spaces/:id/schema-convert/items`, `POST .../items/:itemId/dismiss` and MCP `list_unconverted` and `dismiss_unconverted`, so both
 * doors take the same parameters, ask the same rights and give the same answers and refusals.
 *
 * ## What each answers
 *
 * - {@link listUnconvertedAct}: `{ items, count, total, limit, skip, truncated, nextSkip?, ...the budget figures, counts: { open, dismissed } }`,
 *   newest first, narrowed by `kind`, `type` and `status` (`open` unless `dismissed` is asked). `counts` are those of the whole space, whatever
 *   the filters. A row is the stored item (`itemId` for its id; its internal staleness hash is not served) and, when the record is still stored,
 *   `record: { summary }`: the record's own name or summary, the one line the duplicate list gives for it ({@link summariseRecall}), read for
 *   the page's rows only. A read never writes: a row whose record was written, deleted or converted since is left to the watcher's tick
 *   (`sweepStaleUnconvertedItems`).
 * - {@link dismissUnconvertedAct}: `{ item }`, the row as listed, now `dismissed`. The record is not touched, and a run that meets the same
 *   record version toward the same target does not open the item again (`recordUnconvertedItem`).
 * - {@link dismissShownUnconvertedAct}: `{ dismissed }`, every open item a `kind`/`type`/`reason` filter lists (the list takes the same filter, so
 *   a count shown and the set dismissed are one question), when the caller was shown exactly `expect` of them; bounded, one write, refused
 *   with the current number when the count moved. The list's `record.summary` is part of the rows the byte budget counts.
 *
 * ## What it prevents
 *
 * - **A door that forgets the rights.** `knowledge: read` for the list and `knowledge: write` for the dismiss are asked HERE, after the space
 *   exists and before anything else, so a router or a tool that mounts these acts cannot serve an unauthorised caller by leaving a guard out.
 *   A read-only token is refused on the dismiss; a token with no matrix holds no rung and is refused on both. The sentence is the area guard's
 *   (`rungRefusal`), so the act and the guard say it alike.
 * - **A property value in a row.** A row carries the stored item, which names violated fields and reasons and never a stored value, and the
 *   record's name or summary (never a property). The record is read with a projection of the fields that line is made from.
 * - **Two doors with two grammars.** The parameters are {@link UnconvertedListParams} and the paging rule is the list module's; every refusal
 *   has a code ({@link UNCONVERTED_REFUSAL_CODES}) that the tool names in its text and the route sends in its body.
 * - **A personal view read as a space.** The act names one configured space: a view id, an unknown id and a retired id are answered by the one
 *   existence rule (`unknownSpaceAnswer`), as every door that writes or administers does.
 *
 * Whether a caller may read ONE record is not asked: `knowledge: read` on the space is the right to read every record of it, so a row for a
 * record of the space is never left out for a caller that holds the rung (the forks list narrows a personal view's members by the same rung).
 */
import { z } from 'zod';
import { KNOWLEDGE_TYPES, COLLECTION_SUFFIX, type KnowledgeType } from '../config/types-knowledge.js';
import { TYPE_NAME_MAX } from '@ythril-network/schema/internal';
import type { TokenRights } from '../config/rights-shape.js';
import { holdsRung, rungRefusal } from '../auth/reachable-spaces.js';
import {
  listUnconvertedItems, dismissUnconvertedItem, dismissOpenUnconvertedItems, UNCONVERTED_REASONS,
  type UnconvertedItem, type ListedUnconvertedItem,
} from '../brain/schema-convert-items.js';
import { CHOSEN_VERSION_ROWS } from '../brain/chosen-versions.js';
import { mapToRecallResult } from '../brain/recall-result.js';
import { summariseRecall } from '../brain/recall-shape.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { NAME_QUOTED, peerText, refusalOfParse } from '../util/log.js';
import { unknownSpaceAnswer } from './unknown-space.js';

/** The statuses the acts answer: the contract both doors carry. */
const OK = 200;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const GONE = 410;
const CONFLICT = 409;

/**
 * What an act answers: a body, or a refusal with its status and code. A refusal may carry `detail`, whole numbers a door sends beside `error`
 * and `code` (`current` of a changed count, `max` of a call that names too many): both doors build their body from the one {@link refusalBody}.
 */
export type UnconvertedActResult =
  | { status: typeof OK; body: Record<string, unknown> }
  | { status: typeof BAD_REQUEST | typeof FORBIDDEN | typeof NOT_FOUND | typeof GONE | typeof CONFLICT; error: string; code?: string; detail?: Readonly<Record<string, number>> };

/** The body a door sends for a refusal: `{ error, code?, ...detail }`. */
export const refusalBody = (r: Extract<UnconvertedActResult, { error: string }>): Record<string, unknown> =>
  ({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.detail ?? {}) });

/** Who is asking: the rights the rung is judged from (`null` or absent: no matrix, no rung) and the door, whose byte-budget default applies. */
export interface UnconvertedCaller {
  readonly rights: TokenRights | null | undefined;
  readonly transport: 'rest' | 'mcp';
}

/**
 * The codes the two acts refuse with, one list: the acts answer from it, and the tool's description and the parity gates read it.
 * The rung and the unknown-space refusals of a door's own guard are not here; `unconverted_rung` is the act's own, answered when a caller
 * reaches the act without the rung (a door that mounts it with no guard, or a guard row that is wrong).
 */
export const UNCONVERTED_REFUSAL_CODES = [
  'unconverted_bad_kind', 'unconverted_bad_status', 'unconverted_bad_type', 'unconverted_bad_paging', 'unconverted_bad_item_id',
  'unconverted_item_not_found', 'unconverted_rung',
  // The bulk dismiss.
  'unconverted_bad_reason', 'unconverted_bad_expect', 'unconverted_changed', 'unconverted_too_many',
] as const;
const [BAD_KIND, BAD_STATUS, BAD_TYPE, BAD_PAGING, BAD_ITEM_ID, ITEM_NOT_FOUND, RUNG, BAD_REASON, BAD_EXPECT, CHANGED, TOO_MANY] = UNCONVERTED_REFUSAL_CODES;

/** The statuses an item holds, and the one the list shows unless another is asked. */
export const UNCONVERTED_STATUSES = ['open', 'dismissed'] as const;

/** An item id is a hash, bounded like every name a caller sends in a path or an argument. */
const ITEM_ID_MAX = TYPE_NAME_MAX;

/** The longest `record.summary`: a name or a title is the writer's text and a row must not double in size by it (a fact is cut shorter by `summariseRecall`). */
const SUMMARY_MAX = 160;

/** An empty value is no value: the one rule every list of the Brain reads a blank filter by (`kind=` in a query string). */
const blankIsAbsent = (v: unknown): unknown => (v === '' ? undefined : v);

/**
 * The filters both doors take, parsed by this one schema so the route's query and the tool's arguments cannot state different bounds.
 * `skip` and `limit` are the list module's (`resolveListPaging`) and are not parsed here.
 */
export const UnconvertedFilterParams = z.object({
  kind: z.preprocess(blankIsAbsent, z.enum(KNOWLEDGE_TYPES).optional()),
  type: z.preprocess(blankIsAbsent, z.string().max(TYPE_NAME_MAX).optional()),
  reason: z.preprocess(blankIsAbsent, z.enum(UNCONVERTED_REASONS).optional()),
});

/** The list's parameters: the filter the bulk dismiss shares, and the `status` only a list chooses. */
export const UnconvertedListParams = UnconvertedFilterParams.extend({
  status: z.preprocess(blankIsAbsent, z.enum(UNCONVERTED_STATUSES).optional()),
});

/** The bulk dismiss's parameters: the same filter, and `expect`, the number of open items the caller was shown (required, a whole number). */
export const UnconvertedDismissShownParams = UnconvertedFilterParams.extend({
  expect: z.number().int().min(0),
});

/** The row one item is listed as: the stored item under its public names, and the record part when the record is stored. */
export type UnconvertedRow = Omit<UnconvertedItem, '_id' | 'typeDefinition'> & { itemId: string; record?: { summary: string } };

const rowOf = (item: ListedUnconvertedItem): UnconvertedRow => {
  const { _id, typeDefinition: _definition, record, ...rest } = item;
  return { itemId: _id, ...rest, ...(record ? { record } : {}) };
};

/** The fields the summary line of each kind is made from, and no others: a read of a record for this list never reads a property. */
const SUMMARY_FIELDS: Readonly<Record<KnowledgeType, Readonly<Record<string, 1>>>> = {
  entity: { name: 1, type: 1 },
  fact: { fact: 1, type: 1 },
  edge: { from: 1, to: 1, label: 1, type: 1 },
  chrono: { title: 1, type: 1, startsAt: 1, endsAt: 1, status: 1 },
};

const clip = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text);

/** The summary of each record the page's rows name, one read per kind: `kind` and `recordId` to the line. A record not stored (or only a fork row of one) has none. */
async function summariesOf(spaceId: string, rows: readonly UnconvertedItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of KNOWLEDGE_TYPES) {
    const ids = rows.filter(r => r.kind === kind).map(r => r.recordId);
    if (ids.length === 0) continue;
    const stored = await readStoredById<Record<string, unknown>>(spaceCollection(spaceId, COLLECTION_SUFFIX[kind]), ids, SUMMARY_FIELDS[kind], { filter: CHOSEN_VERSION_ROWS });
    for (const [id, doc] of stored) out.set(`${kind}\u0000${id}`, clip(summariseRecall(mapToRecallResult({ ...doc, spaceId }, kind))));
  }
  return out;
}

const spaceSentence = (id: string): string => peerText(id, { max: NAME_QUOTED });

/** The refusal of a missing space or a missing rung, or `null` when the caller may go on: the first two questions of both acts, in one order. */
function refusedBefore(spaceId: string, caller: UnconvertedCaller, needs: 'read' | 'write'): UnconvertedActResult | null {
  const unknown = unknownSpaceAnswer(null, spaceId);
  if (unknown) return { status: unknown.status, error: unknown.body.error, ...(unknown.body.code ? { code: unknown.body.code } : {}) };
  if (!caller.rights || !holdsRung(caller.rights, spaceId, 'knowledge', needs)) {
    return { status: FORBIDDEN, error: caller.rights ? rungRefusal(needs, 'knowledge', spaceId) : rungRefusal(needs, 'knowledge'), code: RUNG };
  }
  return null;
}

const FILTER_CODES: Readonly<Record<string, string>> = { kind: BAD_KIND, type: BAD_TYPE, status: BAD_STATUS, reason: BAD_REASON, expect: BAD_EXPECT };

/**
 * One page of the space's unconverted items (needs `knowledge: read`), refused in this order: an unknown space (404, or 410 for a retired
 * id), a missing rung (403 `unconverted_rung`), a malformed `kind`, `type` or `status` (400 by its own code), a malformed `skip` or `limit`
 * or byte budget (400 `unconverted_bad_paging`).
 */
export async function listUnconvertedAct(spaceId: string, params: Record<string, unknown>, caller: UnconvertedCaller): Promise<UnconvertedActResult> {
  const before = refusedBefore(spaceId, caller, 'read');
  if (before) return before;
  const parsed = UnconvertedListParams.safeParse({ kind: params['kind'], type: params['type'], reason: params['reason'], status: params['status'] });
  if (!parsed.success) {
    const refusal = refusalOfParse(parsed.error);
    const field = String(refusal.issues[0]?.path[0] ?? '');
    return { status: BAD_REQUEST, error: refusal.error, code: FILTER_CODES[field] ?? BAD_KIND };
  }
  const { kind, type, reason, status } = parsed.data;
  // The record part is added before the byte budget is applied, so the bytes the answer reports and the page it cuts count it.
  const withSummaries = async (rows: UnconvertedItem[]): Promise<ListedUnconvertedItem[]> => {
    const summaries = await summariesOf(spaceId, rows);
    return rows.map(item => {
      const summary = summaries.get(`${item.kind}\u0000${item.recordId}`);
      return summary === undefined ? item : { ...item, record: { summary } };
    });
  };
  const listed = await listUnconvertedItems(spaceId, {
    skip: params['skip'], limit: params['limit'], maxChars: params['maxChars'], maxBytes: params['maxBytes'], maxTokens: params['maxTokens'],
    status: status ?? 'open', ...(kind !== undefined ? { kind } : {}), ...(type !== undefined ? { type } : {}), ...(reason !== undefined ? { reason } : {}),
  }, caller.transport, withSummaries);
  if (!listed.ok) return { status: BAD_REQUEST, error: listed.error, code: BAD_PAGING };
  return {
    status: OK,
    body: {
      items: listed.items.map(rowOf),
      ...listed.fields,
      counts: { open: listed.open, dismissed: listed.dismissed },
    },
  };
}

/**
 * Dismiss item `itemId` of the space (needs `knowledge: write`): refused for an unknown space, a missing rung (a read-only token included),
 * an `itemId` that is not a bounded text (400 `unconverted_bad_item_id`) and an item the space holds none of (404 `unconverted_item_not_found`).
 * Dismissing a dismissed item answers the same row: it stays dismissed.
 */
export async function dismissUnconvertedAct(spaceId: string, itemId: unknown, caller: UnconvertedCaller): Promise<UnconvertedActResult> {
  const before = refusedBefore(spaceId, caller, 'write');
  if (before) return before;
  if (typeof itemId !== 'string' || itemId === '' || itemId.length > ITEM_ID_MAX) {
    return { status: BAD_REQUEST, error: `itemId must be the id of an unconverted item: a text of at most ${ITEM_ID_MAX} characters, as \`list_unconverted\` lists it`, code: BAD_ITEM_ID };
  }
  const item = await dismissUnconvertedItem(spaceId, itemId);
  if (!item) {
    return { status: NOT_FOUND, error: `Space '${spaceSentence(spaceId)}' holds no unconverted item '${peerText(itemId, { max: NAME_QUOTED })}'`, code: ITEM_NOT_FOUND };
  }
  return { status: OK, body: { item: rowOf(item) } };
}

/**
 * Dismiss every OPEN item the filter (`kind`, `type`, `reason`) lists, in one call (needs `knowledge: write`), when the caller was shown exactly
 * `expect` of them. Refused in this order: an unknown space, a missing rung (a read-only token included), a malformed filter or an `expect` that
 * is not a whole number of at least zero (400, by its own code), more than `UNCONVERTED_DISMISS_MAX` matches (400 `unconverted_too_many`, with
 * `max`: narrow the filter), a count that is not `expect` (409 `unconverted_changed`, with `current`: nothing is dismissed, so a confirmation of
 * one number never dismisses another). The guard is here, inside the act, where no door can drop it. Answers `{ dismissed }`.
 *
 * Not built, on purpose: a personal view as the space. The act names one configured space, as every act of this module does.
 */
export async function dismissShownUnconvertedAct(spaceId: string, params: Record<string, unknown>, caller: UnconvertedCaller): Promise<UnconvertedActResult> {
  const before = refusedBefore(spaceId, caller, 'write');
  if (before) return before;
  const parsed = UnconvertedDismissShownParams.safeParse({ kind: params['kind'], type: params['type'], reason: params['reason'], expect: params['expect'] });
  if (!parsed.success) {
    const refusal = refusalOfParse(parsed.error);
    const field = String(refusal.issues[0]?.path[0] ?? '');
    return { status: BAD_REQUEST, error: refusal.error, code: FILTER_CODES[field] ?? BAD_EXPECT };
  }
  const { expect, kind, type, reason } = parsed.data;
  const done = await dismissOpenUnconvertedItems(spaceId, { ...(kind !== undefined ? { kind } : {}), ...(type !== undefined ? { type } : {}), ...(reason !== undefined ? { reason } : {}) }, expect);
  if (done.ok) return { status: OK, body: { dismissed: done.dismissed } };
  if (done.refusal === 'too_many') {
    return { status: BAD_REQUEST, error: `This filter matches more than ${done.max} open unconverted items, the most one call dismisses: narrow it by kind, type or reason. Nothing was dismissed`, code: TOO_MANY, detail: { max: done.max } };
  }
  return {
    status: CONFLICT, code: CHANGED, detail: { current: done.current },
    error: `The space now holds ${done.current} open unconverted items for this filter, not the ${expect} you were shown. Nothing was dismissed: list again and confirm the new number`,
  };
}
