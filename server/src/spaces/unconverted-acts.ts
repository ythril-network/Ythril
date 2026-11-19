/**
 * The records a schema conversion could not convert, listed and dismissed (Q-919, bundle-284 design r5 sections 2.3 and 6): the acts behind
 * `GET /api/spaces/:id/schema-convert/items`, `POST .../items/:itemId/dismiss` and MCP `list_unconverted` and `dismiss_unconverted`, so both
 * doors take the same parameters, ask the same rights and give the same answers and refusals.
 *
 * ## What each answers
 *
 * - {@link listUnconvertedAct}: `{ items, count, total, limit, skip, truncated, nextSkip?, ...the budget figures, counts: { open, dismissed, openBy,
 *   openByCut? } }`, newest first, narrowed by `kind`, `type`, `reason` (one, or a list: the items of any) and `status` (`open` unless `dismissed` or `all`,
 *   both together in the one newest-first order, is asked). `counts` are those of the whole space, whatever the filters; `openBy` groups the open items by kind, type and reason (`{ kind, type,
 *   reason, n }`, in that order, at most `UNCONVERTED_OPEN_BY_MAX`, `openByCut: true` when there were more). A row is the stored item (`itemId` for its id; its internal staleness hash is not served) and, when the record is still stored,
 *   `record: { summary }`: the record's own name or summary, the one line the duplicate list gives for it ({@link summariseRecall}), read for
 *   the page's rows only. A read never writes: a row whose record was written, deleted or converted since is left to the watcher's tick
 *   (`sweepStaleUnconvertedItems`).
 * - {@link dismissUnconvertedAct}: `{ item }`, the row as listed, now `dismissed`. The record is not touched, and a run that meets the same
 *   record version toward the same target does not open the item again (`recordUnconvertedItem`).
 * - {@link dismissShownUnconvertedAct}: `{ dismissed }`, every open item a `kind`/`type`/`reason` filter lists (the list takes the same filter, so
 *   a count shown and the set dismissed are one question; `reason` may be a list, and `expect` and `current` count over all of its reasons), when
 *   the caller was shown exactly `expect` of them; bounded, one write, refused with the current number when the count moved. The list's `record.summary` is part of the rows the byte budget counts.
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
 * - **A personal view read as a space.** The list is a read, so it takes the caller's own view as every derived read door does: the members its
 *   door's guard accepted it for (`viewRead`) are listed together, newest first, each row naming its space, the counts summed. The dismissals
 *   write, so they name one configured space: a view id, an unknown id and a retired id are answered by the one existence rule
 *   (`unknownSpaceAnswer`), as every door that writes or administers does.
 *
 * Whether a caller may read ONE record is not asked: `knowledge: read` on the space is the right to read every record of it, so a row for a
 * record of the space is never left out for a caller that holds the rung (the forks list narrows a personal view's members by the same rung).
 */
import { KNOWLEDGE_TYPES, COLLECTION_SUFFIX, type KnowledgeType } from '../config/types-knowledge.js';
import { TYPE_NAME_MAX } from '@ythril-network/schema/internal';
import { holdsRung, rungRefusal } from '../auth/reachable-spaces.js';
import {
  listUnconvertedItems, dismissUnconvertedItem, dismissOpenUnconvertedItems, type ListedUnconvertedItem,
} from '../brain/schema-convert-items.js';
import {
  UNCONVERTED_REFUSAL_CODES, UNCONVERTED_STATUSES, UnconvertedFilterParams, UnconvertedListParams, UnconvertedDismissShownParams, refusalBody,
  UNCONVERTED_REFUSAL_OPTIONS, listedUnconvertedViolations, type UnconvertedActResult, type UnconvertedCaller, type UnconvertedItem, type UnconvertedRow,
} from './unconverted-terms.js';
import { CHOSEN_VERSION_ROWS } from '../brain/chosen-versions.js';
import { mapToRecallResult } from '../brain/recall-result.js';
import { summariseRecall } from '../brain/recall-shape.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { NAME_QUOTED, peerText, refusalOfParse, type ParseRefusal } from '../util/log.js';
import { unknownSpaceAnswer } from './unknown-space.js';

// The terms the acts and both doors share live in `unconverted-terms.ts` (the bounds the tools declare from); re-exported for the readers that name them here.
export {
  UNCONVERTED_REFUSAL_CODES, UNCONVERTED_STATUSES, UnconvertedFilterParams, UnconvertedListParams, UnconvertedDismissShownParams, refusalBody,
  type UnconvertedActResult, type UnconvertedCaller, type UnconvertedRow,
};

/** The statuses the acts answer: the contract both doors carry. */
const OK = 200;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;

const [BAD_KIND, BAD_STATUS, BAD_TYPE, BAD_PAGING, BAD_ITEM_ID, ITEM_NOT_FOUND, RUNG, BAD_REASON, BAD_EXPECT, CHANGED, TOO_MANY] = UNCONVERTED_REFUSAL_CODES;

/** An item id is a hash, bounded like every name a caller sends in a path or an argument. */
const ITEM_ID_MAX = TYPE_NAME_MAX;

/** The longest `record.summary`: a name or a title is the writer's text and a row must not double in size by it (a fact is cut shorter by `summariseRecall`). */
const SUMMARY_MAX = 160;

const rowOf = (item: ListedUnconvertedItem): UnconvertedRow => {
  const { _id, typeDefinition: _definition, record, violations, ...rest } = item;
  // Read tolerantly (Q-943): an item stored before violations had codes is listed with its field and reason only, never rewritten.
  return { itemId: _id, ...rest, violations: listedUnconvertedViolations(violations), ...(record ? { record } : {}) };
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

/** The 400 of a refused parse of the filters (`refusalOfParse` with the terms' one option set): the code is the failing field's, `fallback` for any other. */
function parseRefusal(refusal: ParseRefusal, fallback: string): UnconvertedActResult {
  const field = String(refusal.issues[0]?.path[0] ?? '');
  return { status: BAD_REQUEST, error: refusal.error, code: FILTER_CODES[field] ?? fallback };
}

/**
 * One page of the space's unconverted items (needs `knowledge: read`), refused in this order: an unknown space (404, or 410 for a retired
 * id), a missing rung (403 `unconverted_rung`), a malformed `kind`, `type`, `reason` (an unknown one anywhere in a list, or a list over the bound,
 *  included) or `status` (400 by its own code), a malformed `skip` or `limit`
 * or byte budget (400 `unconverted_bad_paging`).
 */
export async function listUnconvertedAct(
  spaceId: string, params: Record<string, unknown>, caller: UnconvertedCaller, viewRead?: readonly string[],
): Promise<UnconvertedActResult> {
  // The caller's own view: the members its guard accepted it for, each read in the knowledge area already, so no rung is asked again.
  const before = viewRead ? null : refusedBefore(spaceId, caller, 'read');
  if (before) return before;
  const spaces = viewRead ?? [spaceId];
  const parsed = UnconvertedListParams.safeParse({ kind: params['kind'], type: params['type'], reason: params['reason'], status: params['status'] });
  if (!parsed.success) return parseRefusal(refusalOfParse(parsed.error, UNCONVERTED_REFUSAL_OPTIONS), BAD_KIND);
  const { kind, type, reason, status } = parsed.data;
  // The record part is added before the byte budget is applied, so the bytes the answer reports and the page it cuts count it.
  const withSummaries = async (space: string, rows: ListedUnconvertedItem[]): Promise<ListedUnconvertedItem[]> => {
    const summaries = await summariesOf(space, rows);
    return rows.map(item => {
      const summary = summaries.get(`${item.kind}\u0000${item.recordId}`);
      return summary === undefined ? item : { ...item, record: { summary } };
    });
  };
  const listed = await listUnconvertedItems(spaces, {
    skip: params['skip'], limit: params['limit'], maxChars: params['maxChars'], maxBytes: params['maxBytes'], maxTokens: params['maxTokens'],
    // `all` is no filter on the stored status: the one query, sort and cursor serve both statuses, so the page is one page and not a merge of two reads.
    ...(status === 'all' ? {} : { status: status ?? 'open' }), ...(kind !== undefined ? { kind } : {}), ...(type !== undefined ? { type } : {}), ...(reason !== undefined ? { reason } : {}),
  }, caller.transport, withSummaries);
  if (!listed.ok) return { status: BAD_REQUEST, error: listed.error, code: BAD_PAGING };
  return {
    status: OK,
    body: {
      items: listed.items.map(rowOf),
      ...listed.fields,
      counts: { open: listed.open, dismissed: listed.dismissed, openBy: listed.openBy, ...(listed.openByCut ? { openByCut: true } : {}) },
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
  return { status: OK, body: { item: rowOf({ ...item, space: spaceId }) } };
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
  const parsed = UnconvertedDismissShownParams.safeParse({ kind: params['kind'], type: params['type'], reason: params['reason'], status: params['status'], expect: params['expect'] });
  if (!parsed.success) return parseRefusal(refusalOfParse(parsed.error, UNCONVERTED_REFUSAL_OPTIONS), BAD_EXPECT);
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
