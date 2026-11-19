/**
 * What a schema violation IS, as a machine reads it: its stable `code`, the `params` its sentence names, and the one function that
 * words the sentence from them (Q-943).
 *
 * ## What it prevents
 *
 * A violation was `{ field, value, reason }` with the reason English prose, written inline wherever one was raised. A screen that shows
 * a record's problems in another language had only the prose: the Review page's chips and every refusal read in English. Here a row
 * carries its code and params beside the prose, and the prose is BUILT from them by {@link schemaViolationText}, so the two cannot say
 * different things; {@link schemaViolation} is the one way to build a row (`a-schema-violation-is-built-by-one-constructor` refuses a
 * row written by hand anywhere else in `server/src`), so no site can raise a row without a code.
 *
 * ## The names, and the standards they follow
 *
 * Decided once for all: a code is lower_snake. Where a violation is a JSON Schema validation keyword's concept (draft 2020-12:
 * `type`, `enum`, `minimum`, `maximum`, `pattern`, `required`; `additionalProperties` from the applicator vocabulary), the code is that
 * keyword in lower_snake, and its params are named as Ajv names the params of that keyword's error (`allowedValues`, `comparison` and
 * `limit`, `missingProperty`, `additionalProperty`), the names a JSON Schema client already reads. The rest are the product's own
 * rules (a closed set of types, a naming pattern on a record's name, an edge's endpoints and `functional`, a CEL rule, a library
 * reference, a link or an end that names nothing), named for what they say; {@link SCHEMA_VIOLATION_CODES} says per code which.
 *
 * Where it sits on the wire follows the product's refusals (an unknown-field row's `code` on the same row, a refusal's `code` beside
 * its `error`) and RFC 9457's "extension members" (a machine-readable member beside the human-readable `detail`; its own validation
 * example is an `errors` list of `{ detail, pointer }`): `reason` stays the human text and `code` and `params` are members beside it.
 * On MCP the row rides the tool result's `structuredContent` beside the text, with `isError` on a refusal, as the MCP specification
 * says a tool execution error is reported (in the result, not as a protocol error).
 *
 * ## Params
 *
 * A flat object of plain values: a text, a number, a boolean, or a list of texts. Only what the sentence already says: never the value
 * the record holds (that is the row's `value`, which a reader without the right to the data does not get). As raised, a list holds
 * every name its sentence names; {@link boundedViolationParams} cuts it where a row is rendered for a reader, as `declared` is cut.
 *
 * A leaf: it imports nothing of the app but the schema package and two constants, so the validator, the rules engine, the writers and
 * a client's contract spec (which reads this file as source text) may all read it.
 */
import { REDOS_REFUSAL } from '@ythril-network/schema';
import { peerList, peerText, boundedNames } from '@ythril-network/schema/internal';
import { LINK_TARGET_REMOVED } from '../util/errors.js';
import type { RefKind } from '../config/types-knowledge.js';

/**
 * Every code a schema violation can carry: the params it always carries, in order, and the standard it follows (or why none fits).
 * The one list: the validator raises only these, the guide's table is this table, and a client's words are pinned to its keys.
 */
export const SCHEMA_VIOLATION_CODES = {
  type_not_allowed: { params: ['allowlist', 'allowedValues'], standard: 'product: a kind that declares types admits only those (`allowlist` names the list: entityTypes, edgeLabels, memoryTypes, chronoTypes); the closed set of the record\'s own type, not a value\'s JSON Schema `enum`' },
  ref_unresolved: { params: ['entry'], standard: 'product: a type\'s `$ref` names a schema-library entry this instance does not hold; a fault of the schema, not of the record' },
  naming_pattern: { params: ['type', 'pattern'], standard: 'product: the type\'s `namingPattern` on the record\'s name (JSON Schema `pattern` applied to the name, not to a property)' },
  naming_pattern_not_evaluated: { params: ['type', 'pattern'], standard: 'product: the naming pattern was not run (too long, or it could backtrack), so nothing was checked' },
  endpoint_type: { params: ['label', 'end', 'allowedValues'], standard: 'product: an edge label\'s `endpoints` admit only these types at the `end` (from or to); UNTYPED stands for an entity without a type' },
  functional: { params: ['label', 'count'], standard: 'product: a `functional` label allows one edge per subject; `count` other edges with it already start there' },
  required: { params: ['missingProperty'], standard: 'JSON Schema validation `required` (an empty text counts as missing); params as Ajv\'s' },
  additional_properties: { params: ['additionalProperty'], standard: 'JSON Schema `additionalProperties: false` on a type that declares properties; params as Ajv\'s; the row also carries `declared`' },
  type: { params: ['type', 'got'], standard: 'JSON Schema validation `type` (`date` is the product\'s, held as a text); `got` is the JavaScript type of the value' },
  enum: { params: ['allowedValues'], standard: 'JSON Schema validation `enum`; params as Ajv\'s, each value as text' },
  minimum: { params: ['comparison', 'limit'], standard: 'JSON Schema validation `minimum` (inclusive); params as Ajv\'s' },
  maximum: { params: ['comparison', 'limit'], standard: 'JSON Schema validation `maximum` (inclusive); params as Ajv\'s' },
  pattern: { params: ['pattern'], standard: 'JSON Schema validation `pattern`; params as Ajv\'s' },
  pattern_not_evaluated: { params: ['pattern'], standard: 'product: the property\'s pattern was not run (too long, or it could backtrack), so nothing was checked' },
  rule: { params: ['rule', 'message', 'hash'], standard: 'product: a CEL rule of the type or the space, which the record breaks; `message` is the rule\'s own, `hash` names its text' },
  rule_not_evaluated: { params: ['rule', 'message', 'hash', 'cause'], standard: 'product: a CEL rule that could not judge the record (`cause`: engine_unavailable, type_mismatch, evaluation_error, not_boolean); the row\'s `outcome` is could_not_evaluate' },
  rule_too_large: { params: ['rule', 'message', 'hash', 'path', 'bound', 'limit'], standard: 'product: a value the rule reads is over the input caps (`bound`: characters, list, map, depth) at `self.<path>`; the row\'s `outcome` is too_large' },
  link_target_removed: { params: ['entityId'], standard: 'product: a warning, not a refusal: the entity was deleted while the record was written, so the link to it was not kept' },
  reference_not_found: { params: ['refField', 'refKind', 'space', 'ids'], standard: 'product: with `strictLinkage`, an edge end names a record the space does not hold' },
  conversion_error: { params: ['errorKind'], standard: 'product: only on an unconverted item: the rewrite failed for a reason no other class names, by the error\'s kind and never its words' },
} as const;

export type SchemaViolationCode = keyof typeof SCHEMA_VIOLATION_CODES;

/** The cause of a rule that could not judge a record. */
export type RuleNotEvaluatedCause = 'engine_unavailable' | 'type_mismatch' | 'evaluation_error' | 'not_boolean';
/** Which input cap a value a rule reads is over. */
export type RuleInputBound = 'characters' | 'list' | 'map' | 'depth';

/** The params of each code, as its sentence names them. */
export interface SchemaViolationParamsByCode {
  type_not_allowed: { allowlist: 'entityTypes' | 'edgeLabels' | 'memoryTypes' | 'chronoTypes'; allowedValues: string[] };
  ref_unresolved: { entry: string };
  naming_pattern: { type: string; pattern: string };
  naming_pattern_not_evaluated: { type: string; pattern: string };
  endpoint_type: { label: string; end: 'from' | 'to'; allowedValues: string[] };
  functional: { label: string; count: number };
  required: { missingProperty: string };
  additional_properties: { additionalProperty: string };
  type: { type: string; got: string };
  enum: { allowedValues: string[] };
  minimum: { comparison: '>='; limit: number };
  maximum: { comparison: '<='; limit: number };
  pattern: { pattern: string };
  pattern_not_evaluated: { pattern: string };
  rule: { rule: string; message: string; hash: string };
  rule_not_evaluated: { rule: string; message: string; hash: string; cause: RuleNotEvaluatedCause };
  rule_too_large: { rule: string; message: string; hash: string; path: string; bound: RuleInputBound; limit: number };
  link_target_removed: { entityId: string };
  reference_not_found: { refField: string; refKind: RefKind; space: string; ids: string[] };
  conversion_error: { errorKind: string };
}

/** A params object as a row carries it on the wire: flat, plain values. */
export type ViolationParams = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** One violation of a space's schema, as every door answers it. */
export interface SchemaViolation {
  field: string;
  value: unknown;
  /** The sentence, in English: {@link schemaViolationText} of `code` and `params`. Kept for every caller that reads it. */
  reason: string;
  /** What kind of violation it is ({@link SCHEMA_VIOLATION_CODES}): what a client words, in its own language. */
  code: SchemaViolationCode;
  /** The values the sentence names, by the names the table gives them. */
  params: ViolationParams;
  /**
   * Only on a row that says a property KEY is not declared (`Q-93`): the keys the type does declare, sorted, so the caller can see
   * what it should have sent. Bounded in count and in the length of a name — a type can declare hundreds, and a row is repeated per key.
   */
  declared?: string[];
  /**
   * Only on a RULE's row that is not a plain break (F-46): the rule could not be evaluated on this record, or the record is too large for
   * it to read. Both are violations; this says which, so a refusal can be counted (`ythril_schema_refusals_total`) and shown
   * (`core/refusal-text.ts` `outcomeOf`) by what it is without reading the prose of its reason.
   */
  outcome?: 'could_not_evaluate' | 'too_large';
}

// ── The words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a reference field points at, as a refusal names it. */
export const REF_NOUN: Record<RefKind, string> = {
  entity: 'entity ID',
  fact: 'fact ID',
  chrono: 'chrono ID',
  file: 'file path',
};

/** How many references a refusal names before it counts the rest. */
const REFS_NAMED = 5;
/**
 * How much of ONE reference a refusal quotes: a UUID or any honest file path whole, and short enough that one
 * oversized reference cannot take the list's whole budget and leave the others it names unnamed.
 */
const REF_QUOTED = 256;

/**
 * The references a refusal names: the first `REFS_NAMED`, JSON-quoted, each cut at `REF_QUOTED`, then `…(+N more)` —
 * through `peerText`/`peerList`, so a caller's megabyte reference comes back bounded and a line-breaking one escaped
 * (bundle-30 `I5`, `Q-270`).
 */
export const quotedRefs = (values: readonly string[]): string =>
  peerList(values.map(v => JSON.stringify(v)), ', ', { count: REFS_NAMED, each: REF_QUOTED });

/**
 * The one sentence for references that name no record of the space: the reference refusal's (`missingRefsRefusal`) and a missing edge
 * end's row (`reference_not_found`) say it through this, so the two cannot drift.
 */
export function missingReferencesText(refField: string, refKind: RefKind, space: string, ids: readonly string[]): string {
  return `\`${refField}\` references ${ids.length} ${REF_NOUN[refKind]}${ids.length === 1 ? '' : 's'} that ` +
    `do${ids.length === 1 ? 'es' : ''} not exist in space '${space}': ${quotedRefs(ids)}. ` +
    'Create the record first, then link it — the write was refused rather than stored with a dead link.';
}

const CAUSE_WORDS: Record<RuleNotEvaluatedCause, string> = {
  engine_unavailable: 'the rule engine is not available',
  type_mismatch: 'a value of a type the rule does not compare',
  evaluation_error: 'an evaluation error',
  not_boolean: 'it did not answer true or false',
};

const boundWords = (bound: RuleInputBound, limit: number): string => {
  switch (bound) {
    case 'characters': return `longer than ${limit} characters`;
    case 'list': return `a list of more than ${limit}`;
    case 'map': return `a map of more than ${limit}`;
    case 'depth': return 'nested too deeply';
  }
};

type ParamsOf<C extends SchemaViolationCode> = SchemaViolationParamsByCode[C];

/**
 * The English sentence of a violation, from its code and params alone: what `reason` holds. The one place the sentences are written.
 */
export function schemaViolationText<C extends SchemaViolationCode>(code: C, params: ParamsOf<C>): string {
  if (!Object.hasOwn(WORDS, code)) throw new TypeError(`schemaViolationText: '${String(code)}' is not a schema violation code`);
  return (WORDS[code] as (p: ParamsOf<C>) => string)(params);
}

/** The sentence of each code: a function of its params, one per code (the type holds the list whole). */
const WORDS: { readonly [C in SchemaViolationCode]: (p: SchemaViolationParamsByCode[C]) => string } = {
  type_not_allowed: (p) => `not in ${p.allowlist} allowlist: ${p.allowedValues.join(', ')}`,
  ref_unresolved: (p) => `schema library entry '${p.entry}' not found — update or remove this $ref`,
  naming_pattern: (p) => `does not match naming pattern for type '${p.type}': ${p.pattern}`,
  naming_pattern_not_evaluated: (p) => `naming pattern for type '${p.type}' not evaluated, so nothing was checked: ${p.pattern} — ${REDOS_REFUSAL}`,
  endpoint_type: (p) => `'${p.label}' declares its ${p.end} endpoint as one of: ${p.allowedValues.join(', ')}`,
  functional: (p) => `'${p.label}' is declared functional: one subject may have at most one. ${p.count} other edge(s) with this label already start here`,
  required: (p) => `required property '${p.missingProperty}' is missing or empty`,
  additional_properties: (p) => `property '${p.additionalProperty}' is not declared on this type`,
  type: (p) => `expected type '${p.type}', got '${p.got}'`,
  enum: (p) => `must be one of: ${p.allowedValues.join(', ')}`,
  minimum: (p) => `must be ${p.comparison} ${p.limit}`,
  maximum: (p) => `must be ${p.comparison} ${p.limit}`,
  pattern: (p) => `does not match pattern: ${p.pattern}`,
  pattern_not_evaluated: (p) => `pattern not evaluated, so nothing was checked: ${p.pattern} — ${REDOS_REFUSAL}`,
  rule: (p) => `${p.message} (rule ${p.hash})`,
  rule_not_evaluated: (p) => `${p.message} — could not be evaluated on this record (${CAUSE_WORDS[p.cause]}) (rule ${p.hash})`,
  rule_too_large: (p) => `${p.message} — too large to check: self.${p.path} is ${boundWords(p.bound, p.limit)} (rule ${p.hash})`,
  link_target_removed: (p) => `${LINK_TARGET_REMOVED}: the entity '${p.entityId}' was deleted while this record was written, so the link to it was not kept; the record itself is written.`,
  reference_not_found: (p) => missingReferencesText(p.refField, p.refKind, p.space, p.ids),
  conversion_error: (p) => p.errorKind,
};

/** Where a row points (`field`, and the `value` found there) and the marks only some rows carry. */
export interface ViolationAt {
  field: string;
  value: unknown;
  declared?: string[];
  outcome?: SchemaViolation['outcome'];
}

/**
 * A violation row: `{ field, value, reason, code, params }` with the reason worded from the code and params, and the marks a row of
 * that kind carries. THE one way a row is built: a code it does not know throws, so a row cannot leave without one. `at` is written as
 * an object at the call (`{ field: 'type', value }`), so the field a validator refuses is named where it refuses it.
 */
export function schemaViolation<C extends SchemaViolationCode>(code: C, params: ParamsOf<C>, at: ViolationAt): SchemaViolation {
  if (!Object.hasOwn(SCHEMA_VIOLATION_CODES, code)) throw new TypeError(`schemaViolation: '${String(code)}' is not a schema violation code`);
  return {
    field: at.field, value: at.value, reason: schemaViolationText(code, params), code, params: params as unknown as ViolationParams,
    ...(at.declared ? { declared: at.declared } : {}),
    ...(at.outcome ? { outcome: at.outcome } : {}),
  };
}

/**
 * Params as a row says them to a reader: a text through the one bounded renderer, a list of texts cut as `declared` is (fifty names,
 * each bounded, then `…(+N more)`), a number or a boolean as it is. Called where rows are rendered (`boundedRows`) and where an
 * unconverted item stores them, so no reader is handed a schema's thousand enum values in one row.
 */
export function boundedViolationParams(params: unknown): ViolationParams {
  const out: Record<string, string | number | boolean | readonly string[]> = {};
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return out;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = peerText(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = boundedNames(v.map(x => String(x)));
  }
  return out;
}
