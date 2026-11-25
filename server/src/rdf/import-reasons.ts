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

/**
 * The reasons only a change set answers (`subject-changes.ts`, Q-964): the statements a SPARQL Update removes and inserts are read by the rules
 * of an import, and these name what a removal or an insert of a stored record adds to them. Each refuses in every mode: a write that would
 * take away a value nobody named, change an edge's ends, or write a record that is no field of the form has no looser reading. They join
 * {@link IMPORT_REASONS}, so one list names every reason a statement can be refused by, and no file's translation answers them.
 */
export const UPDATE_REASONS = Object.freeze({
  'server-owned-removed': row('server-owned-removed', ALL, 'The statement is the server\'s own or derived from a field (created, modified, author, schema version, superseded, redaction, a time node), or states a value the record form does not carry; a removal cannot take it away.'),
  'edge-ends-change': row('edge-ends-change', ALL, 'The change would give a stored edge other ends or another label; an edge keeps both, and a new edge is a new record.'),
  'not-writable-here': row('not-writable-here', ALL, 'The subject is a record of a kind a change set cannot write (a file), not a fact, a chrono entry, an entity or an edge.'),
  'field-not-removable': row('field-not-removable', ALL, 'The removal names a field the record must keep, a type, or a property whose key is not one plain path segment, so it cannot be removed.'),
  'subject-not-an-address-here': row('subject-not-an-address-here', ALL, 'The subject is stored nowhere and is no address of this space\'s records, and a change set creates a record only under such an address.'),
} satisfies Record<string, ImportReasonRow>);

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
  ...UPDATE_REASONS,
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
  'not-inferred': 'The schema read from the data does not hold this predicate for the subject\'s type (too few subjects, several values on one, mixed objects, or a term the schema cannot take), so the statement is left out; the answer names why.',
} as const);

/** The code of a quad left out on purpose. */
export type NotTakenCode = keyof typeof NOT_TAKEN;
