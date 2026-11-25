/**
 * Whether ONE record may reach the store: the checks every stored record must pass before any store call, one function per kind.
 *
 * ## What it prevents (bundle-270, amendment A5)
 *
 * The bulk import held the fact text's cap inline beside the shape table and the link rule it also asked, and the single-record doors held
 * their own copy of the fact cap. A writer that plans without writing (the RDF import's dry plan) asked none of them: an oversized record
 * passed the dry plan and failed in the store after other records had landed, which an all-or-nothing import must never do. Here the questions
 * are asked together, in one order, for every caller:
 *
 *  - the record's SHAPE (`shapeError`, `write-shape.ts`): the fact text's cap, the tag cap, the entity-only primitive-property rule, the chrono
 *    status rule, and every other value rule the doors share;
 *  - its LINK CAPS ({@link linkCapError}): at most `MAX_LINKS_PER_KIND` ids in each `link*` field;
 *  - its SIZE ({@link recordSizeError}): at most {@link MAX_RECORD_BYTES} as UTF-8 JSON.
 *
 * Requiredness is NOT asked by {@link recordCheckError} (a create and an update differ on it; `write-shape.ts` says why), nor the space's
 * schema, nor which link classes a kind may hold or whether an id names anything (the planners judge those, so a dry plan does too).
 *
 * A record built from a document is judged as a door judges a create ({@link createError}, review F2): the required fields, a recurrence the
 * door's parser takes, and (where the planner holds the plan schema) a chrono type the space allows ({@link chronoTypeError}). The dry plan asks
 * them of every item, before it loads anything: no door would create a record that lacks them, and an import's commit never refuses.
 *
 * The bulk import asks it of each item's planner input ({@link plannedInputError}) after its own reading of the item, and the RDF import's
 * dry plan asks it of the inputs it built from a document: one question, of one shape.
 *
 * ## Why the size bound is the JSON body bound
 *
 * A body is at most `JSON_BODY_MAX_BYTES` raw bytes, and a record is judged as UTF-8 JSON: a body of invalid UTF-8 parses each bad byte to
 * U+FFFD, which a record holds (and JSON writes) as three bytes, so a body of about a third of the bound makes a record over it. Every door can
 * therefore meet this bound, and every door asks it (`refuseOversizeRecord`, `write-plan/plan-and-commit.ts`, for the four single-record doors;
 * `plannedInputError` for the bulk import and the dry plan): it keeps a record, however it was built, well under the store's own document limit
 * with the server's fields beside it.
 *
 * ## Why it imports only leaf modules
 *
 * The bulk import and the planners sit in the server's largest import cycle; a module they import that reaches back into it joins it, and the
 * architecture probe holds that cycle's size to a ceiling.
 */
import { shapeError } from './write-shape.js';
import { JSON_BODY_MAX_BYTES } from '../config/body-limits.js';
import { MAX_FACT_LENGTH, MAX_FACT_LENGTH_TEXT, MAX_LINKS_PER_KIND, countError } from '../util/request-bounds.js';
import { LINK_INPUT_FIELDS, type KnowledgeType } from '../config/types-knowledge.js';
import { parseRecurrence } from './recurrence.js';

/** The most bytes one record may hold as UTF-8 JSON: the JSON body bound, so no record a door takes can exceed it. */
export const MAX_RECORD_BYTES = JSON_BODY_MAX_BYTES;

/** Whether a fact's text is over its cap: the one comparison, for a door that answers the cap in words of its own. */
export function factTextOverCap(fact: string): boolean {
  return fact.length > MAX_FACT_LENGTH;
}

/** The fact text's refusal, in the words the shape table and the doors have always answered, or `null`. */
export function factTextError(fact: string): string | null {
  return factTextOverCap(fact) ? `\`fact\` must not exceed ${MAX_FACT_LENGTH_TEXT} characters` : null;
}

/** The size refusal for a record, or `null`. Functions and `undefined` are not part of a record, as `JSON.stringify` leaves them out. */
export function recordSizeError(record: Readonly<Record<string, unknown>>): string | null {
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  return bytes > MAX_RECORD_BYTES
    ? `the record is ${bytes} bytes as JSON; a record may hold at most ${MAX_RECORD_BYTES} bytes` : null;
}

/**
 * The link-cap refusal for a record, or `null`: every `link*` field it carries holds at most `MAX_LINKS_PER_KIND` ids, in the words
 * `linkInputError` (`write-connections.ts`) answers, through the same `countError`.
 */
export function linkCapError(record: Readonly<Record<string, unknown>>): string | null {
  for (const field of Object.values(LINK_INPUT_FIELDS)) {
    const value = record[field];
    if (Array.isArray(value)) {
      const over = countError(field, value, MAX_LINKS_PER_KIND);
      if (over) return over;
    }
  }
  return null;
}

/** The first refusal one record of `kind` earns before any store call, or `null` when it may be planned. The order is fixed: shape, links, size. */
export function recordCheckError(kind: KnowledgeType, record: Readonly<Record<string, unknown>>): string | null {
  return shapeError(kind, record) ?? linkCapError(record) ?? recordSizeError(record);
}

/** The fields a door requires at create, per kind: a missing, null, empty or blank one is `missing required field: <field>` (the bulk door's words). */
const REQUIRED_AT_CREATE: Readonly<Record<KnowledgeType, readonly string[]>> = {
  fact: ['fact'],
  entity: ['name', 'type'],
  chrono: ['title', 'startsAt'],
  edge: ['from', 'to', 'label'],
};

/** The first required field of `record` that is not a non-blank string, or `null`: the field {@link requiredFieldError} names. */
export function missingRequiredField(kind: KnowledgeType, record: Readonly<Record<string, unknown>>): string | null {
  for (const field of REQUIRED_AT_CREATE[kind]) {
    const value = record[field];
    if (typeof value !== 'string' || !value.trim()) return field;
  }
  return null;
}

/** The refusal for the first required field of `record` that is not a non-blank string, or `null`. */
export function requiredFieldError(kind: KnowledgeType, record: Readonly<Record<string, unknown>>): string | null {
  const field = missingRequiredField(kind, record);
  return field === null ? null : `missing required field: ${field}`;
}

/** The refusal for a chrono `type` outside `allowed` (the space's allowlist, `getAllowedChronoTypes`), in the door's words, or `null`. */
export function chronoTypeError(type: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof type === 'string' && allowed.has(type) ? null : `\`type\` must be one of: ${[...allowed].join(', ')}`;
}

/**
 * The refusal a record built from a document earns at create that no door would let through, or `null`: its required fields, then a
 * recurrence the door's parser refuses. The chrono type allowlist is the space's (the plan schema's), which this leaf module cannot see: the
 * chrono planner asks {@link chronoTypeError} with it.
 */
export function createError(kind: KnowledgeType, record: Readonly<Record<string, unknown>>): string | null {
  const missing = requiredFieldError(kind, record);
  if (missing) return missing;
  if (kind === 'chrono') {
    const recurrence = parseRecurrence(record['recurrence']);
    if (!recurrence.ok) return recurrence.error;
  }
  return null;
}

/**
 * A write as a planner takes it (`brain/write-plan/plan-*.ts`), structurally: a chrono entry's fields sit under `fields`, an edge's end kinds
 * under `opts`. Structural on purpose, so this module imports no planner.
 */
export type PlannedInput =
  | { readonly kind: 'entity' | 'fact'; readonly input: object }
  | { readonly kind: 'chrono'; readonly input: { readonly fields: object } }
  | { readonly kind: 'edge'; readonly input: { readonly opts?: { readonly fromKind?: string; readonly toKind?: string } } };

/** The record as the checks read it: the fields a write states, an edge's end kinds beside them (where the stored record holds them). */
function recordOf(item: PlannedInput): Record<string, unknown> {
  switch (item.kind) {
    case 'chrono': return { ...item.input.fields };
    case 'edge': {
      const { opts, ...rest } = item.input;
      return { ...rest, ...(opts?.fromKind ? { fromKind: opts.fromKind } : {}), ...(opts?.toKind ? { toKind: opts.toKind } : {}) };
    }
    default: return { ...item.input };
  }
}

/**
 * The first refusal a write's PLANNER INPUT earns, or `null`: the record as it will be planned, so a caller that built the input from a request
 * (the bulk import) and one that built it from a document (the RDF import's dry plan) ask the same question of the same shape.
 */
export function plannedInputError(item: PlannedInput): string | null {
  return recordCheckError(item.kind, recordOf(item));
}

/**
 * The required field a write's planner input lacks, when `reason` is the refusal that absence earns, or `null`: what a caller that reports a
 * refusal by its cause names (the RDF import's report, Q-759). The absence earns one of two sentences, by which check meets it first: the
 * shape check of the field's blank value ({@link plannedInputError}), or the create check's ({@link plannedCreateError}). A refusal for
 * anything else, beside a missing field, is not named for the field, and the field is never read back out of the sentence.
 */
export function plannedMissingField(item: PlannedInput, reason: string): string | null {
  const record = recordOf(item);
  const field = missingRequiredField(item.kind, record);
  if (field === null) return null;
  const earned = [record[field] === undefined ? null : shapeError(item.kind, { [field]: record[field] }), requiredFieldError(item.kind, record)];
  return earned.includes(reason) ? field : null;
}

/** {@link recordSizeError} of a write's planner input, read as {@link plannedInputError} reads it: the one question every door asks. */
export function plannedSizeError(item: PlannedInput): string | null {
  return recordSizeError(recordOf(item));
}

/** {@link createError} of a write's planner input, read as {@link plannedInputError} reads it: what the dry plan asks of every item. */
export function plannedCreateError(item: PlannedInput): string | null {
  return createError(item.kind, recordOf(item));
}

/** {@link recordCheckError} per kind, for a caller that holds one kind's records. */
export const factRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('fact', record);
export const entityRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('entity', record);
export const chronoRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('chrono', record);
export const edgeRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('edge', record);
