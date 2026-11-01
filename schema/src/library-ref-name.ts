/**
 * The schema-library entry a type's `$ref` names — the one reading of the reference.
 *
 * ## What it prevents
 *
 * `ref.startsWith('library:') ? ref.slice('library:'.length) : ref` was written at every reader of a reference, and the copies did not agree: the one
 * that expands a reference for the wire (`library-ref-expansion.ts`) read a bare name as no reference at all, while the broken-reference
 * check, the wrong-kind check and the layer filter read the same bare name as an entry's. So one `$ref` could be "an entry that does not
 * exist" to one door and "not a library reference" to the next.
 *
 * ## The rule, and where it comes from
 *
 * **Only `library:<name>` names an entry; a bare name names nothing.** The body every schema write parses through (`TypeSchemaZ` in
 * `body-schemas.ts`) refuses any other `$ref` ("$ref must be in format \"library:<name>\""), so a bare name can only reach a reader
 * from a store written before that refusal or from a hand edit — and reading it as an entry's name would resolve a reference the API
 * says is malformed. A caller that must name what a bare `$ref` points at (a refusal) says the reference itself.
 */

/** The prefix a library reference carries: `library:<entry name>`. */
export const LIBRARY_REF_PREFIX = 'library:';

/** The entry `ref` names, or `undefined` when it names none (not a string, or not `library:<name>`). */
export function libraryEntryNameOf(ref: unknown): string | undefined {
  return typeof ref === 'string' && ref.startsWith(LIBRARY_REF_PREFIX) ? ref.slice(LIBRARY_REF_PREFIX.length) : undefined;
}
