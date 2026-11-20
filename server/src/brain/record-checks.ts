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
 * Requiredness is NOT asked here (a create and an update differ on it; `write-shape.ts` says why), nor the space's schema, nor which link
 * classes a kind may hold or whether an id names anything (the planners judge those, so a dry plan does too).
 *
 * The bulk import asks it of each item's planner input ({@link plannedInputError}) after its own reading of the item, and the RDF import's
 * dry plan asks it of the inputs it built from a document: one question, of one shape.
 *
 * ## Why the size bound is the JSON body bound
 *
 * A record that came through a door came in one JSON body, so it is at most `JSON_BODY_MAX_BYTES` and no door can meet this bound: it changes
 * nothing for a request. It bounds what did not come through a body (a record built from an RDF document), and keeps it well under the store's
 * own document limit with the server's fields beside it.
 *
 * ## Why it imports only leaf modules
 *
 * The bulk import and the planners sit in the server's largest import cycle; a module they import that reaches back into it joins it, and the
 * architecture probe holds that cycle's size to a ceiling.
 */
import { shapeError } from './write-shape.js';
import { JSON_BODY_MAX_BYTES } from '../config/body-limits.js';
import { MAX_FACT_LENGTH, MAX_LINKS_PER_KIND, countError } from '../util/request-bounds.js';
import { LINK_INPUT_FIELDS, type KnowledgeType } from '../config/types-knowledge.js';

/** The most bytes one record may hold as UTF-8 JSON: the JSON body bound, so no record a door takes can exceed it. */
export const MAX_RECORD_BYTES = JSON_BODY_MAX_BYTES;

/** Whether a fact's text is over its cap: the one comparison, for a door that answers the cap in words of its own. */
export function factTextOverCap(fact: string): boolean {
  return fact.length > MAX_FACT_LENGTH;
}

/** The fact text's refusal, in the words the shape table and the doors have always answered, or `null`. */
export function factTextError(fact: string): string | null {
  return factTextOverCap(fact) ? '`fact` must not exceed 50 000 characters' : null;
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

/** {@link recordCheckError} per kind, for a caller that holds one kind's records. */
export const factRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('fact', record);
export const entityRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('entity', record);
export const chronoRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('chrono', record);
export const edgeRecordError = (record: Readonly<Record<string, unknown>>) => recordCheckError('edge', record);
