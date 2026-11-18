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
import { TYPE_NAME_MAX } from '@ythril-network/schema/internal';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '../config/types-knowledge.js';
import type { TokenRights } from '../config/rights-shape.js';

/** Why a record was not converted. `could_not_evaluate` is a split condition the engine could not answer on the record (its own class). */
export const UNCONVERTED_REASONS = [
  'not_conforming', 'no_case_matched', 'both_set', 'could_not_evaluate',
  'relationship_exists', 'functional_taken', 'version_ceiling', 'fork', 'step_refused',
] as const;
export type UnconvertedReason = typeof UNCONVERTED_REASONS[number];

/**
 * The most open items one bulk dismiss names. The call reads the ids it will dismiss once (one more than this, to know there are too many) and
 * names them in one update, so its cost and the update's size are bounded by this; it is above what the Review page shows for one schema change
 * of a thousand records, and a filter that matches more is narrowed by kind, type or reason, never cut.
 */
export const UNCONVERTED_DISMISS_MAX = 2_000;

/** The statuses an item holds, and the one the list shows unless another is asked. */
export const UNCONVERTED_STATUSES = ['open', 'dismissed'] as const;

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

/** The row one item is listed as: the stored item under its public names, and the record part when the record is stored. */
export type UnconvertedRow = Omit<UnconvertedItem, '_id' | 'typeDefinition'> & { itemId: string; record?: { summary: string } };

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

/**
 * The filters both doors take, parsed by this one schema so the route's query and the tool's arguments cannot state different bounds: the MCP
 * tools declare the same kinds, reasons and name length from the same constants, and the bounds gate compares the two.
 * `skip` and `limit` are the list module's (`resolveListPaging`) and are not parsed here.
 */
export const UnconvertedFilterParams = z.object({
  kind: optionalFilter(z.enum(KNOWLEDGE_TYPES)),
  type: optionalFilter(z.string().max(TYPE_NAME_MAX)),
  reason: optionalFilter(z.enum(UNCONVERTED_REASONS)),
});

/** The list's parameters: the filter the bulk dismiss shares, and the `status` only a list chooses. */
export const UnconvertedListParams = UnconvertedFilterParams.extend({
  status: optionalFilter(z.enum(UNCONVERTED_STATUSES)),
});

/** The bulk dismiss's parameters: the same filter, and `expect`, the number of open items the caller was shown (required, a whole number). */
export const UnconvertedDismissShownParams = UnconvertedFilterParams.extend({
  expect: z.number().int().min(0),
});
