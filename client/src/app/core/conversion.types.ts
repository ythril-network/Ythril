import type { TypedKind } from './type-field';
import type { UnconvertedReason } from './unconverted-reason-list';

/**
 * Every server shape the record-conversion pages read (bundle-285, Q-747), typed once.
 *
 * Five page slices (the rename, the dialog, the save wiring, Review, the vote row) are built on these names side by side. The server's
 * shapes are copied here by hand, and a hand copy is silent when the server adds a field: `ServerVoteRound` lost four keys exactly so.
 * `testing/conversion-contract.spec.ts` derives both key sets from the server's source and fails on a key neither read nor named there as
 * not read, on a key invented here, on a reason with no class and on a refusal code with no decision, so a shape is never guessed twice.
 *
 * Where the server's source is the contract, each type names it: the status is `SchemaConvertStatus` (`spaces/schema-convert-run.ts`), the
 * notice is `ConvertRunNotice` (`spaces/meta-update.ts`), the steps are `ConversionStep` (`schema/src/conversion-steps.ts`), a row is
 * `UnconvertedRow` (`spaces/unconverted-terms.ts`). Keys the pages do not read are left out on purpose, and the contract spec says why.
 */

// ── The steps (schema/src/conversion-steps.ts) ──────────────────────────────────────────────────────────────────────────────

/** One declared rewrite. `kind` is a knowledge type; for an `edge` the type is its label. */
export type ConversionStep =
  | { op: 'renameProperty'; kind: TypedKind; type: string; from: string; to: string }
  | { op: 'mapEnum'; kind: TypedKind; type: string; property: string; values: Record<string, string> }
  | { op: 'renameType'; kind: TypedKind; from: string; to: string }
  | { op: 'splitType'; kind: TypedKind; from: string; cases: { when: string; to: string }[]; otherwise?: string };

export type ConversionStepOp = ConversionStep['op'];

// ── The run (GET /api/spaces/:id/schema-convert) ─────────────────────────────────────────────────────────────────────────

/** One type a conversion names: a kind and a type name (an edge's name is its label). */
export interface ConvertTypeRef { kind: TypedKind; type: string }

/** One type a run converts, with whether the run is done with it. */
export interface ConvertRunType { kind: TypedKind; type: string; done: boolean }

/** What started a run: a schema save, a passed vote, or the Convert act. */
export interface ConvertSource { kind: 'write' | 'round' | 'act'; roundId?: string; at: string }

/**
 * What a run did to the records it read, per run (never per type): the records it has CHECKED are `stamped + rewritten + unconverted + moved`,
 * and the records it will check are those plus `left`.
 */
export interface ConvertCounts { stamped: number; rewritten: number; unconverted: number; moved: number; edgesRestamped: number }

/** A step the run does not apply and why: `step` is `null` when none of them is (a round whose steps this instance refused whole); `reason` is a code (`STEP_REFUSAL_CODES`). */
export interface ConvertRefusedStep { step: ConversionStep | null; reason: string }

export type ConvertRunState = 'running' | 'complete' | 'failed';

/** A run as the status door answers it. `left` is `null` when the records still to read were not counted in time ("counting the records left"). */
export interface ConvertStatus {
  state: ConvertRunState;
  types: ConvertRunType[];
  steps: ConversionStep[];
  stepsRefused: ConvertRefusedStep[];
  sources: ConvertSource[];
  startedAt: string;
  finishedAt?: string;
  counts: ConvertCounts;
  /** Items the run did not write because it had written as many as one run may: `counts.unconverted` is then more than the list holds. */
  unconvertedNotListed?: number;
  left: number | null;
  failures: number;
  error?: string;
}

/** A space that never had a run. */
export interface ConvertStatusNone { state: 'none' }

/** A personal view that reads none or several members answers each member's run, never a sum. */
export interface ConvertStatusPerMember { state: 'per_member'; runs: ((ConvertStatus | ConvertStatusNone) & { space: string })[] }

export type ConvertStatusAnswer = ConvertStatus | ConvertStatusNone | ConvertStatusPerMember;

// ── Starting a run ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `POST /api/spaces/:id/schema-convert`, accepted (202): `steps` counts the steps the run holds. */
export interface ConvertStartAnswer { state: 'started'; toFp: string; types: ConvertTypeRef[]; steps: number }

export type ConvertNoticeState = 'started' | 'after_vote' | 'nothing' | 'not_started';

/** What became of the run a save that carried `convertRecords` asked for (`convert` on the save's answer). `error` says why a run was not started. */
export interface ConvertRunNotice { state: ConvertNoticeState; types: ConvertTypeRef[]; toFp?: string; error?: string }

/** The part of a save's answer (200, or 202 `vote_pending`) the conversion reads. */
export interface SaveConvertAnswer { convert?: ConvertRunNotice }

// ── The unconverted records (GET /api/spaces/:id/schema-convert/items) ─────────────────────────────────────────────────

export type UnconvertedStatus = 'open' | 'dismissed';

/**
 * What a list may ask for: an item's two stored statuses, or `all` (both, in one newest-first list with one paging, each row carrying its own
 * status). Only the LIST takes `all`: the bulk dismiss takes open items only and refuses any other status, so `UnconvertedDismissRequest` has none.
 */
export type UnconvertedListStatus = UnconvertedStatus | 'all';

/**
 * A property of a record that does not fit and why: field names and reasons only, never a stored value. `code` and `params` are there on an
 * item stored since Q-943 and absent on one stored before; `core/violation-wording.ts` words the row from them, or says `reason`.
 */
export interface UnconvertedViolation { field: string; reason: string; code?: string; params?: Record<string, unknown> }

/**
 * One record a conversion could not convert, as listed. `reason` is one of the server's `UNCONVERTED_REASONS` (`reasonClassOf` gives its
 * class and answers for one this client does not know). `record` is absent when the record is gone, and is a summary line, never a property.
 */
export interface UnconvertedRow {
  itemId: string;
  space: string;
  kind: TypedKind;
  recordId: string;
  type: string;
  reason: string;
  violations: UnconvertedViolation[];
  status: UnconvertedStatus;
  detectedAt: string;
  record?: { summary: string };
}

/** The open items of one kind, type and reason, as the server counted them (slice S1: `counts.openBy`). */
export interface UnconvertedOpenGroup { kind: TypedKind; type: string; reason: string; n: number }

/**
 * The counts of the whole space, whatever the filters. `openBy` is the open items per kind, type and reason (summed over a view's members, at
 * most 500 groups, `openByCut` when there were more): slice S1 adds both, so a server without them leaves them absent.
 */
export interface UnconvertedCounts { open: number; dismissed: number; openBy?: UnconvertedOpenGroup[]; openByCut?: boolean }

export interface UnconvertedListAnswer {
  items: UnconvertedRow[];
  count: number;
  total: number;
  limit: number;
  skip: number;
  truncated: boolean;
  nextSkip?: number;
  counts: UnconvertedCounts;
}

/** What the list is narrowed by: the reasons are those of a class (`reasonsOfClass`), sent as a list. */
export interface UnconvertedFilter { kind?: TypedKind; type?: string; reasons?: readonly UnconvertedReason[] }

/** A list request: the filter, the status (`open` unless another is asked), and the page. */
export interface UnconvertedQuery extends UnconvertedFilter { status?: UnconvertedListStatus; skip?: number; limit?: number }

export interface DismissOneAnswer { item: UnconvertedRow }

/** The body of "Dismiss all N shown": the shown filter, and `expect`, the number the user was shown (the server refuses a count that moved). */
export interface UnconvertedDismissRequest { kind?: TypedKind; type?: string; reason?: UnconvertedReason[]; expect: number }

export interface DismissShownAnswer { dismissed: number }

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A refused conversion call as a page words it. Never a thrown string: each kind the plan names has its own, with what its sentence needs.
 * `other` is every failure nothing names (the server's own sentence, the status and the code ride along); status 0 is a request that never
 * answered.
 */
export type ConversionRefusal =
  | { kind: 'bad_step'; step: number; error: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'no_right'; code: 'knowledge_rung' | 'space_admin_required' | 'unconverted_rung'; error: string }
  | { kind: 'running' }
  | { kind: 'changed'; current: number }
  | { kind: 'too_many'; max: number }
  | { kind: 'item_gone' }
  | { kind: 'stale' }
  | { kind: 'needs_meta' }
  | { kind: 'other'; status: number; code?: string; error: string };

export type ConversionRefusalKind = ConversionRefusal['kind'];

/**
 * What each code the conversion doors answer is worded as: every code of the server's `SCHEMA_CONVERT_REFUSAL_CODES` and
 * `UNCONVERTED_REFUSAL_CODES`, and the save's `convert_needs_meta`. A code that names `other` has no wording of its own: the page shows the
 * server's sentence. `testing/conversion-contract.spec.ts` fails on a server code with no entry here and on an entry the server lacks.
 */
export const CONVERSION_REFUSAL_KIND: Readonly<Record<string, ConversionRefusalKind>> = {
  bad_convert_types: 'other',
  too_many_convert_types: 'other',
  bad_convert_request: 'other',
  bad_conversion_step: 'bad_step',
  knowledge_rung: 'no_right',
  space_admin_required: 'no_right',
  schema_convert_running: 'running',
  schema_convert_rate_limited: 'rate_limited',
  unconverted_bad_kind: 'other',
  unconverted_bad_status: 'other',
  unconverted_bad_type: 'other',
  unconverted_bad_paging: 'other',
  unconverted_bad_item_id: 'other',
  unconverted_item_not_found: 'item_gone',
  unconverted_rung: 'no_right',
  unconverted_bad_reason: 'other',
  unconverted_bad_expect: 'other',
  unconverted_changed: 'changed',
  unconverted_too_many: 'too_many',
  convert_needs_meta: 'needs_meta',
};

/** What a conversion call answers: the value, or the refusal as a page words it. */
export type ConversionResult<T> = { ok: true; value: T } | { ok: false; refusal: ConversionRefusal };
