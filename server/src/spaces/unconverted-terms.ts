/**
 * The terms of the records a schema conversion could not convert that the item store, the acts, the route and the MCP tools share (Q-919,
 * bundle-284 design r5 sections 2.3 and 6): what an item is, its reason classes and bounds, the list's and the bulk dismissal's parameters, the
 * refusal codes, and the shapes of a caller and of an answer.
 *
 * ## What it prevents
 *
 * **Two statements of one bound, or of one item.** The acts parse the filters with {@link UnconvertedFilterParams} and the MCP tools declare the
 * same kinds, reasons, statuses and name length from the same constants, so the bounds gate (`a-tool-and-its-route-agree-on-bounds`) compares real
 * bounds; the item store writes the {@link UnconvertedItem} the acts list. A leaf (it imports no module of the server but the knowledge kinds and the
 * rights' type), so the store, the acts, the routes and the tools may all read it. A term moved here is re-exported by the module it came from, for
 * that module's own readers.
 */
import { z } from 'zod';
import { TYPE_NAME_MAX, NAME_QUOTED, peerText, type ParseIssueLike, type ParseRefusalOptions } from '@ythril-network/schema/internal';
import { listedNames } from '../util/listed-names.js';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '../config/types-knowledge.js';
import type { TokenRights } from '../config/rights-shape.js';

/**
 * Why a record was not converted. `could_not_evaluate` is a split condition the engine could not answer on the record (its own class);
 * `conversion_failed` is a rewrite that failed for a reason no other class names, on as many passes as a run allows one record, its violation
 * naming the error's kind and never its words.
 */
export const UNCONVERTED_REASONS = [
  'not_conforming', 'no_case_matched', 'both_set', 'could_not_evaluate',
  'relationship_exists', 'functional_taken', 'version_ceiling', 'fork', 'step_refused', 'conversion_failed',
] as const;
export type UnconvertedReason = typeof UNCONVERTED_REASONS[number];

/**
 * The most reasons one call names (`reason` as a list): every reason there is, once. A longer list repeats one, so it is refused rather than
 * trimmed: a caller that sent it counted wrongly, and a trimmed list would answer another question than the one asked.
 */
export const UNCONVERTED_REASONS_MAX = UNCONVERTED_REASONS.length;

/**
 * The most (kind, type, reason) groups the list's `counts.openBy` names. It is the Review page's pills and type choices, which a person reads: a
 * space whose open items fall in more groups than this is a space whose conversion went wrong in a way the groups cannot show, and the list says
 * so (`counts.openByCut`) instead of growing with the data.
 */
export const UNCONVERTED_OPEN_BY_MAX = 500;

/**
 * The most open items one bulk dismiss names. The call reads the ids it will dismiss once (one more than this, to know there are too many) and
 * names them in one update, so its cost and the update's size are bounded by this; it is above what the Review page shows for one schema change
 * of a thousand records, and a filter that matches more is narrowed by kind, type or reason, never cut.
 */
export const UNCONVERTED_DISMISS_MAX = 2_000;

/** The statuses an item holds, and the one the list shows unless another is asked. */
export const UNCONVERTED_STATUSES = ['open', 'dismissed'] as const;

/** The statuses a LIST takes: the two an item holds, and `all` for both together (no item holds it). */
export const UNCONVERTED_LIST_STATUSES = [...UNCONVERTED_STATUSES, 'all'] as const;

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
  /** What the record's type was under `toFp`: the hash its staleness is judged by (`typeDefinitionOf`). */
  typeDefinition: string;
  reason: UnconvertedReason;
  violations: { field: string; reason: string }[];
  /** What the steps would have made of it: the new type, and the property names set and removed. */
  proposed: { type?: string; set: string[]; unset: string[] };
  status: typeof UNCONVERTED_STATUSES[number];
  detectedAt: string;
}

/**
 * The row one item is listed as: the stored item under its public names, the space it lives in (the one a dismissal names: a list through a
 * personal view merges several), and the record part when the record is stored.
 */
export type UnconvertedRow = Omit<UnconvertedItem, '_id' | 'typeDefinition'> & { itemId: string; space: string; record?: { summary: string } };

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

/** An empty value is no value: the one rule every list of the Brain reads a blank filter by (`kind=` in a query string). */
const blankIsAbsent = (v: unknown): unknown => (v === '' ? undefined : v);

/** A filter both doors may leave out or send blank: optional outside the blank rule too, so the schema states it as optional, as the tools do. */
const optionalFilter = <T extends z.ZodType>(inner: T) => z.preprocess(blankIsAbsent, inner.optional()).optional();

/** One reason, refused by naming the value (bounded and escaped by `peerText`, as every name a caller sends is) and not by zod's own list of options. */
const ReasonName = z.enum(UNCONVERTED_REASONS, {
  error: issue => `'${peerText(issue.input, { max: NAME_QUOTED })}' is not a reason: it is one of ${UNCONVERTED_REASONS.join(', ')}`,
});

/** One reason, or a list of at most {@link UNCONVERTED_REASONS_MAX}: what the tools declare, and what the parser below accepts after it has split a text. */
const ReasonOrList = z.union([
  ReasonName,
  z.array(ReasonName).max(UNCONVERTED_REASONS_MAX, { error: `a list names at most ${UNCONVERTED_REASONS_MAX} reasons, each once` }),
]);

/**
 * The reasons a caller sent as one list of names, or the value itself when it is not text for the schema to refuse: a text is split at commas
 * (`reason=a,b`), a list is each of its texts split the same way (`reason=a&reason=b` arrives as one, an MCP argument as another), a piece is trimmed,
 * and a blank piece is no piece. Nothing left is no filter at all, as a blank `reason=` always was. A single text with no comma stays a text.
 */
function reasonsOf(value: unknown): unknown {
  const listed = listedNames(value, UNCONVERTED_REASONS_MAX);
  if (listed.kind === 'not_text') return value;
  const { names } = listed;
  if (names.length === 0) return undefined;
  // A list over the bound comes back one name too long, so the schema's own length refusal speaks.
  return names.length === 1 && !Array.isArray(value) ? names[0] : names;
}

/**
 * `reason` as a list of the reasons asked for, each once in the order given (an absent or blank value is absent): the one parser of the list's and
 * the bulk dismissal's `reason`, on both doors and in both acts, so a form one of them takes the other takes and a refusal is worded once.
 */
const ReasonsParam = z.preprocess(reasonsOf, ReasonOrList.transform((r): UnconvertedReason[] => (typeof r === 'string' ? [r] : [...new Set(r)])).optional()).optional();

/**
 * The filters both doors take, parsed by this one schema so the route's query and the tool's arguments cannot state different bounds: the MCP
 * tools declare the same kinds, reasons and name length from the same constants, and the bounds gate compares the two.
 * `reason` is one reason or a list of them (the items of any), parsed to a list. `skip` and `limit` are the list module's (`resolveListPaging`)
 * and are not parsed here.
 */
export const UnconvertedFilterParams = z.object({
  kind: optionalFilter(z.enum(KNOWLEDGE_TYPES)),
  type: optionalFilter(z.string().max(TYPE_NAME_MAX)),
  reason: ReasonsParam,
});

/**
 * How a failed parse of these parameters is worded, the one option set both acts hand to `refusalOfParse` (so both doors send one sentence). A
 * failure inside the reason's union names the branch the caller was closest to (the list's element, its length, or the single value), never zod's
 * `Invalid input`.
 */
export const UNCONVERTED_REFUSAL_OPTIONS: ParseRefusalOptions = {
  unionBranch: (branches: readonly ParseIssueLike[][]) =>
    branches.find(b => b.some(i => i.code === 'too_big' || (Array.isArray(i.path) && i.path.length > 0))) ?? branches[0],
};

/**
 * The `given` of a bulk dismissal as its audit entry records it: the reasons as the parser read them (duplicates and blanks gone), joined into one
 * text, because the audit allowlist keeps scalars and a list would be dropped, leaving an entry that says a filter was given and not which. The
 * other fields are as given; a `reason` the parser refuses stays as it came (the act refused the call, and a refused call records no change).
 */
export function dismissAuditGiven(given: Record<string, unknown>): Record<string, unknown> {
  const parsed = ReasonsParam.safeParse(given['reason']);
  if (!parsed.success) return given;
  const { reason: _given, ...rest } = given;
  return parsed.data === undefined ? rest : { ...rest, reason: parsed.data.join(',') };
}

/**
 * The list's parameters: the filter the bulk dismiss shares, and the `status` only a list chooses: `open` (the default), `dismissed`, or `all` (both,
 * in the one newest-first order). An unknown status is refused naming the value.
 */
export const UnconvertedListParams = UnconvertedFilterParams.extend({
  status: optionalFilter(z.enum(UNCONVERTED_LIST_STATUSES, {
    error: issue => `'${peerText(issue.input, { max: NAME_QUOTED })}' is not a status: it is one of ${UNCONVERTED_LIST_STATUSES.join(', ')}`,
  })),
});

/**
 * The bulk dismiss's parameters: the same filter, and `expect`, the number of open items the caller was shown (required, a whole number). It
 * dismisses OPEN items only, so the one `status` it takes is `open` (or none): `all` and `dismissed` are a list's, and are refused by the bad-status
 * code naming the value, so a page that asks for the items it shows with `status=all` cannot dismiss them by sending the same filter.
 */
export const UnconvertedDismissShownParams = UnconvertedFilterParams.extend({
  status: optionalFilter(z.enum(['open'], {
    error: issue => `'${peerText(issue.input, { max: NAME_QUOTED })}' is not a status the bulk dismissal takes: it dismisses open items only`,
  })),
  expect: z.number().int().min(0),
});
