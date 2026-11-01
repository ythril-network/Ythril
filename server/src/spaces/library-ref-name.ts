/**
 * The schema-library entry a type's `$ref` names — the one reading of the reference. **Only `library:<name>` names an entry; a bare
 * name names nothing.** Defined in `@ythril/schema` (`schema/src/library-ref-name.ts`, with what it prevents), because the schema body
 * refuses any other `$ref`; re-exported so every reader of a reference here reads it the same way.
 */
export { LIBRARY_REF_PREFIX, libraryEntryNameOf } from '@ythril/schema';
