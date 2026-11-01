/**
 * Does this caller-supplied key name an object's INTERNALS rather than a field? Defined in `@ythril/schema`
 * (`schema/src/object-internal-keys.ts`, with what it prevents) because the schema body refuses a type, a property or a rule named so;
 * re-exported so every path, property name and filter key of the server asks the one module.
 */
export { isObjectInternalKey, isObjectPrototypeName } from '@ythril/schema/internal';
