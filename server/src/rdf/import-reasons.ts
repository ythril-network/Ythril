/**
 * Why the RDF import cannot take a quad, and why it leaves one out on purpose: two tables, one row per answer (bundle-270, slice S3,
 * Q-752; plan section 3(f)).
 *
 * ## What it prevents
 *
 * - **A quad lost without a word.** Every quad the translator (`quads-to-ops.ts`) does not take is answered by a row of
 *   {@link IMPORT_REASONS} (it cannot be taken) or of {@link NOT_TAKEN} (it is left out on purpose: server-owned, derived, a file, the
 *   export's own description). A row added here without a case fails `every-import-reason-is-named-and-tested.test.js`.
 * - **A mode read two ways.** Each reason names the modes it refuses in; in every other mode it is recorded and the import goes on. Every
 *   reason refuses in strict. A reason that refuses in warn and off is a quad with no Ythril form at all (two kinds on one subject, an
 *   annotation of a triple the file does not assert), which no mode can land.
 * - **A value leaked through a reason.** A message is a fixed sentence: it never repeats a literal or an address of the record. The quads
 *   travel beside it, for the caller to show as it may.
 *
 * A leaf: pure data and one lookup.
 */
import type { ValidationMode } from '@ythril-network/schema';

/** The space's validation mode the import runs in. */
export type ImportMode = ValidationMode;

const ALL: readonly ImportMode[] = Object.freeze(['strict', 'warn', 'off']);
const STRICT: readonly ImportMode[] = Object.freeze(['strict']);

/** One reason a quad cannot be taken: its stable code, a sentence with no value of the record, and the modes it refuses the import in. */
export interface ImportReasonRow {
  readonly code: string;
  readonly message: string;
  readonly refusesIn: readonly ImportMode[];
}

const row = (code: string, refusesIn: readonly ImportMode[], message: string): ImportReasonRow => Object.freeze({ code, message, refusesIn });

/** Every reason the translator answers, by code. */
export const IMPORT_REASONS = Object.freeze({
  'types-of-two-kinds': row('types-of-two-kinds', ALL, 'The subject is typed as records of two different kinds; a record has one kind.'),
  'several-types-of-one-kind': row('several-types-of-one-kind', STRICT, 'The subject has several types of one kind; a record has one type, and this one was not used.'),
  'blank-node-subject': row('blank-node-subject', ALL, 'The subject is a blank node, and the import was not asked to mint records for blank nodes.'),
  'language-tagged-literal': row('language-tagged-literal', STRICT, 'The value carries a language tag, which a Ythril text does not hold.'),
  'datatype-refused': row('datatype-refused', STRICT, 'The value has a datatype, or a lexical form, the field or property cannot hold.'),
  'predicate-without-term': row('predicate-without-term', STRICT, 'The predicate is no term of this space, its source or the record form.'),
  'class-without-term': row('class-without-term', STRICT, 'The type is no class of this space, its source or the record form.'),
  'annotation-on-unasserted-triple': row('annotation-on-unasserted-triple', ALL, 'The edge details annotate a triple the file does not assert.'),
  'not-an-address-the-export-writes': row('not-an-address-the-export-writes', ALL, 'The address lies under the base but is not an address the export writes.'),
  'shared-term-unsettled': row('shared-term-unsettled', STRICT, 'The term belongs to several types, and the subject\'s type does not settle which one is meant.'),
  'several-values': row('several-values', ALL, 'The predicate has several values on the subject; a field or property holds one plain value.'),
  'object-not-a-plain-value': row('object-not-a-plain-value', STRICT, 'The object is not what the predicate holds: a node or a list where a plain value belongs, or a value where a record belongs.'),
  'edge-end-unknown': row('edge-end-unknown', STRICT, 'An end of the edge or link is neither described in the file nor stored in this space.'),
  'contradicting-kind': row('contradicting-kind', ALL, 'The address, the types and the statement of the subject name different kinds or edge labels.'),
  'no-kind': row('no-kind', STRICT, 'The subject states values but no type that says what kind of record it is.'),
  'field-not-of-this-kind': row('field-not-of-this-kind', STRICT, 'The predicate is a field of another kind of record.'),
  'property-of-another-type': row('property-of-another-type', STRICT, 'The predicate is a property of another type than the subject\'s.'),
  'link-has-no-class': row('link-has-no-class', STRICT, 'A record of this kind cannot link to a record of that kind.'),
  'edge-without-statement': row('edge-without-statement', ALL, 'The edge details state no complete triple of the edge they belong to.'),
} satisfies Record<string, ImportReasonRow>);

/** The code of a reason. */
export type ImportReasonCode = keyof typeof IMPORT_REASONS;

/** Whether a reason refuses the import in `mode`, or is recorded and the import goes on. */
export function reasonOutcome(code: ImportReasonCode, mode: ImportMode): 'refused' | 'recorded' {
  return IMPORT_REASONS[code].refusesIn.includes(mode) ? 'refused' : 'recorded';
}

/** Why a quad is left out on purpose, in every mode, and never refuses the import. */
export const NOT_TAKEN = Object.freeze({
  'server-owned': 'The server owns this statement (created, modified, author, schema version, superseded, redaction); the write sets its own.',
  derived: 'The statement is derived from a field the operation states (a time node, the event status, the kind of a time value).',
  file: 'Files are not imported: their bytes are not in RDF, and an edge or link to a file this space does not hold cannot land.',
  'export-description': 'The statement describes the export document, not a record.',
} as const);

/** The code of a quad left out on purpose. */
export type NotTakenCode = keyof typeof NOT_TAKEN;
